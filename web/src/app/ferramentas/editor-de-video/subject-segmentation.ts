import { drawZoomed } from '../../shared/media/auto-zoom';
import { canvasOfSize, FrameContext, FrameSource } from './frame-source';
import { SubjectSegmentationRequest, SubjectSegmentationResponse } from './subject-segmentation-protocol';

const ANALYSIS_MAX_EDGE = 1024;
/** Coarse enough to stay useful, cheap enough for a slow machine to keep up. */
const ANALYSIS_MIN_EDGE = 320;
/** Alpha at or above which a pixel counts as inside the subject. */
const SUBJECT_FLOOR = 40;
/** Side of the grid cell the component search runs on. */
const COMPONENT_CELL = 4;
/** Smallest share of the frame a region may be and still be kept. */
const MIN_REGION_SHARE = 0.004;
/** Smallest share of the biggest region a second region may be and be kept. */
const MIN_RELATIVE_REGION = 0.12;
/**
 * How long a silhouette survives the detector losing it.
 *
 * Everything that is not a person is background, so a frame with nobody in it
 * is a frame that is entirely background. That is the intent — but a matting
 * model blinks, and a blink must not throw the whole picture out of focus for
 * two frames. A lost subject is held this long before the frame is conceded.
 */
const SUBJECT_HOLD_SECONDS = 0.25;
/**
 * What one preview inference may cost before the analysis is made cheaper.
 *
 * Holding the last picture until the next matte arrives hides the wait; it does
 * not shorten it. The wait is shortened by analysing fewer pixels, and how many
 * fewer is something only the machine running it can answer — so it is measured
 * here rather than guessed. The export never takes this path.
 */
const PREVIEW_BUDGET_MS = 55;
/** Readings in one direction before the analysis size moves. */
const EDGE_CONFIRMATIONS = 3;
/** Readings after a move before another one is considered. */
const EDGE_COOLDOWN = 12;
const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());
const MAX_CACHE_ENTRIES = 240;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/**
 * The ceiling for every surface together.
 *
 * Each client used to hold its own 64 MB, so two timeline lanes, the gallery,
 * the container player and an export could reserve five separate ceilings that
 * only ever add up. One budget, charged by whoever is holding the most.
 */
const SHARED_CACHE_BYTES = 96 * 1024 * 1024;
let sharedCacheBytes = 0;
const liveClients = new Set<SubjectSegmentationClient>();
const REQUEST_TIMEOUT_MS = 120_000;
// All editor surfaces lease one lazily loaded model. Each keeps a bounded mask
// cache, while inference and GPU tensors belong to the shared worker.
let sharedWorker: Worker | null = null;
let sharedRequestId = 1;
const workerClients = new Set<SubjectSegmentationClient>();

export interface SubjectSegmentationOptions {
  /** False for the encoder: an export is never traded down to keep a clock. */
  adaptive?: boolean;
}

export interface SubjectMask {
  width: number;
  height: number;
  alpha: Uint8ClampedArray;
  coverage: number;
  canvas?: OffscreenCanvas | HTMLCanvasElement;
}

export type SubjectSegmentationState = 'idle' | 'loading' | 'ready' | 'no-subject' | 'unavailable';

/**
 * Why segmentation is not producing a matte.
 *
 * `no-subject` is not in this list on purpose: a model that ran and found
 * nobody is a result, not a failure, and it has a designed visual fallback.
 * Everything here is a technical failure, which must never be presented — on
 * screen, in a log or over MCP — as if the picture simply had no person in it.
 */
export type SubjectFailureKind = 'model-unavailable' | 'inference-failed' | 'timeout' | 'cancelled';

export interface SubjectSegmentationFailure {
  kind: SubjectFailureKind;
  message: string;
  /** Whether asking again, without reloading the editor, can reasonably work. */
  retryable: boolean;
}

/** Errors carry their own classification from the point where they are raised. */
interface ClassifiedError extends Error { kind?: SubjectFailureKind }

const RETRYABLE: Record<SubjectFailureKind, boolean> = {
  'model-unavailable': false,
  'inference-failed': true,
  timeout: true,
  cancelled: true
};

function classify(error: unknown): SubjectFailureKind {
  return (error as ClassifiedError | null)?.kind ?? 'inference-failed';
}

function classified(message: string, kind: SubjectFailureKind): ClassifiedError {
  return Object.assign(new Error(message), { kind });
}

/**
 * What to tell a person, in the words of the thing they were trying to do.
 *
 * A Background Caption that loses its model does not lose an effect: it loses
 * the occlusion, and the text would land in front of the speaker. The two
 * surfaces therefore need different sentences even for the same failure.
 */
/**
 * Which feature was relying on the matte.
 *
 * Three now rather than two: a picture placed in the middle layer needs the
 * person cut out exactly as a Background Caption does, and telling that reader
 * to "select Original instead" would be advice about a control they never
 * touched.
 */
export type SubjectSurface = 'effect' | 'caption' | 'image';

export function subjectFailureMessage(
  failure: SubjectSegmentationFailure | null,
  surface: SubjectSurface
): string {
  if (!failure) return '';
  const subject = surface === 'caption'
    ? 'Background Caption'
    : surface === 'image' ? 'Image behind the person' : 'AI Video Effect';
  const alternative = surface === 'caption'
    ? 'choose a Classic caption preset.'
    : surface === 'image' ? 'set the image to sit over everything.' : 'select Original.';
  switch (failure.kind) {
    case 'model-unavailable':
      return `${subject} needs the local subject model, which this browser cannot run. ` +
        `Instead, ${alternative}`;
    case 'timeout':
      return `${subject} timed out while analysing the picture. Retry, or ${alternative}`;
    case 'cancelled':
      return `${subject} was cancelled before it finished.`;
    default:
      return `${subject} could not analyse the picture (${failure.message}). Retry, or ${alternative}`;
  }
}

interface Pending {
  resolve: (mask: SubjectMask | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Erases everything but the principal regions of the matte, in place.
 *
 * The model is a portrait matte, but it still returns speckle and the odd
 * fragment of something held or passing, and those fragments are what stay in
 * focus while the rest of the picture is blurred — and what flicker, because a
 * fragment appears and disappears between frames. Regions are found on a coarse
 * grid, the small ones are dropped, and several people are kept: a region is
 * only discarded if it is small both in absolute terms and beside the largest.
 *
 * This removes fragments from a portrait matte. It does not detect people: a
 * chair the model has confidently included in one blob with the person sitting
 * on it stays, because from here it is the person.
 */
export function keepPrincipalRegions(alpha: Uint8ClampedArray, width: number, height: number): number {
  const columns = Math.ceil(width / COMPONENT_CELL), rows = Math.ceil(height / COMPONENT_CELL);
  const occupied = new Uint8Array(columns * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / COMPONENT_CELL) * columns;
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] >= SUBJECT_FLOOR) occupied[row + Math.floor(x / COMPONENT_CELL)] = 1;
    }
  }

  const label = new Int32Array(columns * rows).fill(-1);
  const areas: number[] = [];
  const stack: number[] = [];
  for (let cell = 0; cell < occupied.length; cell++) {
    if (!occupied[cell] || label[cell] >= 0) continue;
    const id = areas.length;
    let area = 0;
    label[cell] = id;
    stack.push(cell);
    while (stack.length) {
      const current = stack.pop()!;
      area++;
      const cx = current % columns, cy = (current - cx) / columns;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
          const next = ny * columns + nx;
          if (!occupied[next] || label[next] >= 0) continue;
          label[next] = id;
          stack.push(next);
        }
      }
    }
    areas.push(area);
  }
  if (areas.length <= 1) return areas.length;

  const largest = areas.reduce((most, area) => Math.max(most, area), 0);
  const floor = Math.max(columns * rows * MIN_REGION_SHARE, largest * MIN_RELATIVE_REGION);
  const kept = areas.map(area => area >= floor);
  if (!kept.some(Boolean)) return areas.length;

  // Grown by one cell so the coarse grid can never clip a region it is keeping.
  const keepCell = new Uint8Array(columns * rows);
  for (let cell = 0; cell < label.length; cell++) {
    if (label[cell] < 0 || !kept[label[cell]]) continue;
    const cx = cell % columns, cy = (cell - cx) / columns;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        keepCell[ny * columns + nx] = 1;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / COMPONENT_CELL) * columns;
    for (let x = 0; x < width; x++) {
      if (!keepCell[row + Math.floor(x / COMPONENT_CELL)]) alpha[y * width + x] = 0;
    }
  }
  return kept.filter(Boolean).length;
}

/** Worker-backed, temporally smoothed mask cache shared by one preview/export. */
export class SubjectSegmentationClient {
  state: SubjectSegmentationState = 'idle';
  lastError = '';
  /** Null whenever the model is idle, loading, working or simply found nobody. */
  failure: SubjectSegmentationFailure | null = null;

  private worker: Worker | null = null;
  private active = false;
  private disposed = false;
  private cacheBytes = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, SubjectMask | null>();
  private readonly inFlight = new Map<string, Promise<SubjectMask | null>>();
  private previous: { clipId: string; geometry: string; time: number; mask: SubjectMask } | null = null;

  private readonly adaptive: boolean;
  private edge = ANALYSIS_MAX_EDGE;
  private averageMs = 0;
  private overBudget = 0;
  private underBudget = 0;
  private sinceEdgeChange = EDGE_COOLDOWN;

  constructor(options: SubjectSegmentationOptions = {}) {
    this.adaptive = options.adaptive !== false;
    liveClients.add(this);
  }

  key(clipId: string, time: number, width = 0, height = 0, scale = 1, fill = false): string {
    // A moving silhouette must not use a mask from another frame (the old
    // six-masks-per-second buckets left trails on heads and shoulders).
    return `${clipId}:${Math.max(0, time).toFixed(6)}:${width}x${height}:${scale}:${fill ? 1 : 0}`;
  }

  cached(key: string, clipId: string, time: number): SubjectMask | null {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const previous = this.previous;
    return previous && previous.clipId === clipId && previous.geometry === this.geometry(key) &&
      time >= previous.time && time - previous.time < 1 / 60 ? previous.mask : null;
  }

  /** Preview path: never waits and never allows more than one inference at once. */
  requestForPreview(
    source: FrameSource,
    outputWidth: number,
    outputHeight: number,
    scale: number,
    fill: boolean,
    clipId: string,
    time: number,
    onReady: () => void
  ): SubjectMask | null {
    if (this.disposed || this.state === 'unavailable') return null;
    const key = this.key(clipId, time, outputWidth, outputHeight, scale, fill);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    if (!this.active) {
      this.active = true;
      void this.maskFor(source, outputWidth, outputHeight, scale, fill, clipId, time)
        .then(() => {
          this.active = false;
          if (!this.disposed) onReady();
        });
    }
    return this.cached(key, clipId, time);
  }

  /** Export path: waits so every encoded frame has the correct cached matte. */
  async maskFor(
    source: FrameSource,
    outputWidth: number,
    outputHeight: number,
    scale: number,
    fill: boolean,
    clipId: string,
    time: number
  ): Promise<SubjectMask | null> {
    if (this.disposed || this.state === 'unavailable') return null;
    const key = this.key(clipId, time, outputWidth, outputHeight, scale, fill);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const task = this.calculateMask(source, outputWidth, outputHeight, scale, fill, clipId, time, key)
      .catch((error) => {
        if (!this.disposed) {
          this.reportFailure(classify(error), error instanceof Error ? error.message : String(error));
          this.previous = null;
        }
        return null;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async calculateMask(
    source: FrameSource,
    outputWidth: number,
    outputHeight: number,
    scale: number,
    fill: boolean,
    clipId: string,
    time: number,
    key: string
  ): Promise<SubjectMask | null> {

    const ratio = Math.min(1, (this.adaptive ? this.edge : ANALYSIS_MAX_EDGE) / Math.max(1, outputWidth, outputHeight));
    const width = Math.max(1, Math.round(outputWidth * ratio));
    const height = Math.max(1, Math.round(outputHeight * ratio));
    const canvas = canvasOfSize(width, height);
    const context = canvas.getContext('2d') as FrameContext | null;
    if (!context) throw new Error('Subject segmentation could not read the frame.');
    context.clearRect(0, 0, width, height);
    drawZoomed(
      (x, y, width, boxHeight) => source.draw(context, x, y, width, boxHeight),
      source.width, source.height, width, height, scale, fill
    );
    const pixels = context.getImageData(0, 0, width, height).data;
    this.state = 'loading';
    const started = now();
    const mask = await this.run({ width, height, pixels });
    this.measure(now() - started);
    if (this.disposed) return null;
    if (mask) keepPrincipalRegions(mask.alpha, mask.width, mask.height);
    const geometry = this.geometry(key);
    // A blink is not an empty frame. The previous silhouette carries a couple
    // of frames so a momentary loss does not throw the whole picture out of
    // focus and back again.
    const smoothed = mask ? this.smooth(clipId, geometry, time, mask) : this.holdPrevious(clipId, geometry, time);
    this.remember(key, smoothed);
    this.state = smoothed ? 'ready' : 'no-subject';
    this.failure = null;
    return smoothed;
  }

  dispose(): void {
    this.disposed = true;
    liveClients.delete(this);
    sharedCacheBytes -= this.cacheBytes;
    workerClients.delete(this);
    if (!workerClients.size) { sharedWorker?.terminate(); sharedWorker = null; }
    this.worker = null;
    this.rejectPending(classified('Subject segmentation was disposed.', 'cancelled'));
    this.cache.clear();
    this.cacheBytes = 0;
    this.inFlight.clear();
    this.previous = null;
  }

  private run(input: Omit<SubjectSegmentationRequest, 'id'>): Promise<SubjectMask | null> {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      return Promise.reject(classified('Background segmentation is not supported by this browser.', 'model-unavailable'));
    }
    if (!this.worker) {
      if (!sharedWorker) {
        sharedWorker = new Worker(new URL('./subject-segmentation.worker', import.meta.url), { type: 'module' });
        sharedWorker.onmessage = ({ data }: MessageEvent<SubjectSegmentationResponse>) => {
          for (const client of workerClients) {
            const pending = client.pending.get(data.id);
            if (!pending) continue;
            client.pending.delete(data.id); clearTimeout(pending.timer);
            if (data.type === 'error') pending.reject(new Error(data.message));
            else if (data.type === 'empty') pending.resolve(null);
            else pending.resolve({ width:data.width,height:data.height,alpha:data.alpha,coverage:data.coverage });
            break;
          }
        };
        sharedWorker.onerror = event => this.failWorker(event.message || 'Subject segmentation worker failed.', 'inference-failed');
      }
      this.worker = sharedWorker;
      workerClients.add(this);
    }
    const id = sharedRequestId++;
    return new Promise((resolve, reject) => {
      // One slow request is not evidence that the model is gone. Only the
      // client that asked is failed, so every other surface keeps working; if
      // the worker really is wedged each will find that out for itself instead
      // of being told by somebody else's timer.
      const timer = setTimeout(() => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        this.pending.delete(id);
        this.reportFailure('timeout', 'Subject segmentation timed out.');
        waiting.reject(classified('Subject segmentation timed out.', 'timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const request: SubjectSegmentationRequest = { id, ...input };
      try {
        this.worker!.postMessage(request, [input.pixels.buffer]);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failWorker(message: string, kind: SubjectFailureKind): void {
    sharedWorker?.terminate(); sharedWorker = null;
    for (const client of workerClients) {
      client.worker = null;
      client.reportFailure(kind, message);
      client.rejectPending(classified(message, kind));
    }
    workerClients.clear();
  }

  /**
   * Records a technical failure. Callers that capture their own frames use it
   * so a decoder that could not be read is not reported as an empty picture.
   */
  reportFailure(kind: SubjectFailureKind, message: string): void {
    this.state = 'unavailable';
    this.lastError = message;
    this.failure = { kind, message, retryable: RETRYABLE[kind] };
  }

  /**
   * Clears a recoverable failure so the next request rebuilds the worker.
   *
   * Cached mattes survive: they were measured before the failure and are still
   * correct. Only the smoothing anchor is dropped, because the frame it refers
   * to is no longer the frame that will be analysed next.
   */
  retry(): boolean {
    if (this.disposed) return false;
    if (this.failure && !this.failure.retryable) return false;
    this.failure = null;
    this.lastError = '';
    this.state = 'idle';
    this.previous = null;
    return true;
  }

  /**
   * Records what the last inference cost and, for a preview, adjusts how much
   * picture the next one is given.
   *
   * One step at a time in either direction, so a single slow frame does not
   * collapse the preview's quality and a single fast one does not undo a
   * reduction that was earned. Mattes already cached at another resolution stay
   * valid — they are resampled to the output size when drawn — and temporal
   * smoothing simply skips the frame where the resolution changes.
   */
  private measure(duration: number): void {
    if (!Number.isFinite(duration) || duration < 0) return;
    this.averageMs = this.averageMs ? this.averageMs * 0.7 + duration * 0.3 : duration;
    if (!this.adaptive) return;
    if (this.sinceEdgeChange++ < EDGE_COOLDOWN) return;
    // Several readings in the same direction before moving, and a cooldown
    // after moving. A size that changes every few frames is itself a flicker:
    // the silhouette gains and loses detail in step with it.
    const over = this.averageMs > PREVIEW_BUDGET_MS;
    const under = this.averageMs < PREVIEW_BUDGET_MS * 0.45;
    this.overBudget = over ? this.overBudget + 1 : 0;
    this.underBudget = under ? this.underBudget + 1 : 0;
    if (this.overBudget >= EDGE_CONFIRMATIONS && this.edge > ANALYSIS_MIN_EDGE) {
      this.edge = Math.max(ANALYSIS_MIN_EDGE, Math.round(this.edge * 0.75));
    } else if (this.underBudget >= EDGE_CONFIRMATIONS && this.edge < ANALYSIS_MAX_EDGE) {
      this.edge = Math.min(ANALYSIS_MAX_EDGE, Math.round(this.edge * 1.25));
    } else {
      return;
    }
    this.overBudget = this.underBudget = 0;
    this.sinceEdgeChange = 0;
  }

  /** The structured reading the UI, the logs and MCP all report from. */
  status(): {
    state: SubjectSegmentationState;
    failure: SubjectSegmentationFailure | null;
    /** True while the preview is analysing less picture than it would like. */
    reduced: boolean;
    analysisEdge: number;
    averageMs: number;
  } {
    return {
      state: this.state,
      failure: this.failure,
      reduced: this.adaptive && this.edge < ANALYSIS_MAX_EDGE,
      analysisEdge: this.adaptive ? this.edge : ANALYSIS_MAX_EDGE,
      averageMs: Math.round(this.averageMs)
    };
  }

  private geometry(key: string): string {
    return key.split(':').slice(-3).join(':');
  }

  /** The last silhouette, while it is still recent enough to stand in. */
  private holdPrevious(clipId: string, geometry: string, time: number): SubjectMask | null {
    const prior = this.previous;
    if (prior && prior.clipId === clipId && prior.geometry === geometry &&
        time >= prior.time && time - prior.time <= SUBJECT_HOLD_SECONDS) {
      return prior.mask;
    }
    this.previous = null;
    return null;
  }

  private smooth(clipId: string, geometry: string, time: number, mask: SubjectMask): SubjectMask {
    const prior = this.previous;
    if (prior && prior.clipId === clipId && prior.geometry === geometry && time >= prior.time && time - prior.time < 0.5 &&
        prior.mask.width === mask.width && prior.mask.height === mask.height) {
      for (let index = 0; index < mask.alpha.length; index++) {
        // Stabilize only small confidence fluctuations. Mixing a moving edge
        // with the previous silhouette produces a translucent double contour.
        if (Math.abs(mask.alpha[index] - prior.mask.alpha[index]) <= 8) {
          mask.alpha[index] = Math.round(mask.alpha[index] * 0.85 + prior.mask.alpha[index] * 0.15);
        }
      }
    }
    this.previous = { clipId, geometry, time, mask };
    return mask;
  }

  private remember(key: string, value: SubjectMask | null): void {
    // Budget both alpha bytes and the lazily allocated RGBA mask canvas.
    if (this.cache.has(key)) this.account(-this.weigh(this.cache.get(key)));
    this.cache.set(key, value);
    this.account(this.weigh(value));
    while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
      if (!this.evictOldest()) break;
    }
    SubjectSegmentationClient.enforceSharedBudget();
  }

  private weigh(mask: SubjectMask | null | undefined): number {
    return (mask?.alpha.byteLength ?? 0) * 5;
  }

  private account(delta: number): void {
    this.cacheBytes += delta;
    sharedCacheBytes += delta;
  }

  /** Drops this client's least recently stored matte. False when it holds none. */
  private evictOldest(): boolean {
    const oldest = this.cache.keys().next().value as string | undefined;
    if (oldest === undefined) return false;
    this.account(-this.weigh(this.cache.get(oldest)));
    this.cache.delete(oldest);
    return true;
  }

  /** Trims whoever is holding the most until the shared ceiling is met. */
  private static enforceSharedBudget(): void {
    let guard = (liveClients.size + 1) * MAX_CACHE_ENTRIES;
    while (sharedCacheBytes > SHARED_CACHE_BYTES && guard-- > 0) {
      let largest: SubjectSegmentationClient | null = null;
      for (const client of liveClients) {
        if (!largest || client.cacheBytes > largest.cacheBytes) largest = client;
      }
      if (!largest || !largest.evictOldest()) break;
    }
  }
}
