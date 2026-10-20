import { canvasOfSize, FrameContext, FrameSource, sizeCanvas } from './frame-source';
import { paddedPlateBox, PlateBox, PlateBoxHistory, plateLetterbox, PLATE_MODEL } from './license-plate-detection';
import { EditorError, ProjectPlan } from './video-editor.models';

export class PlateBlurError extends EditorError {
  readonly code = 'plate_detection_failed';
  constructor(detail: string, clipLabel?: string) {
    super(`License plate blur could not be applied: ${detail} No unprotected video will be exported.`,
      'Retry after reloading the editor. Keep plate protection enabled when exporting.', clipLabel, detail);
    this.name = 'PlateBlurError';
  }
  override withClip(label: string): PlateBlurError { return this.clipLabel ? this : new PlateBlurError(this.detail ?? '', label); }
}

/** Detect before darkening: fades must not conceal a plate from the model. */
export function plateDetectionPlan(plan: ProjectPlan, enabled: boolean): ProjectPlan {
  return enabled && plan.fades.length ? { ...plan, fades: [] } : plan;
}

export interface FrozenPlateSource extends FrameSource { context: FrameContext }

/** Freeze each transition side independently so a neighbour's opt-out survives a join. */
export function freezePlateSource(source: FrameSource | null, maxEdge: number): FrozenPlateSource | null {
  if (!source) return null;
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
  const canvas = canvasOfSize(width, height), context = canvas.getContext('2d') as FrameContext;
  source.draw(context, 0, 0, width, height);
  return { width, height, context, draw: (target, x, y, w, h) => target.drawImage(canvas, x, y, w, h) };
}

export function applyPlateFrameFade(context: FrameContext, gain: number): void {
  if (gain >= 1) return;
  context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-over'; context.filter = 'none';
  context.globalAlpha = 1 - Math.max(0, gain); context.fillStyle = '#000';
  context.fillRect(0, 0, context.canvas.width, context.canvas.height); context.restore();
}

const blurBuffers = new WeakMap<FrameContext, { snapshot: OffscreenCanvas | HTMLCanvasElement; small: OffscreenCanvas | HTMLCanvasElement }>();
/** Pixel reduction followed by blur also protects plates where canvas.filter is unsupported. */
export function paintPlateBlur(context: FrameContext, boxes: readonly PlateBox[]): void {
  if (!boxes.length) return;
  const width = context.canvas.width, height = context.canvas.height;
  let buffers = blurBuffers.get(context);
  if (!buffers) { buffers = { snapshot: canvasOfSize(width, height), small: canvasOfSize(8, 4) }; blurBuffers.set(context, buffers); }
  const { snapshot, small } = buffers;
  sizeCanvas(snapshot, width, height);
  (snapshot.getContext('2d') as FrameContext).drawImage(context.canvas, 0, 0);
  const tiny = small.getContext('2d') as FrameContext;
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    for (const original of boxes) {
      const box = paddedPlateBox(original, width, height);
      const x = Math.floor(box.x * width), y = Math.floor(box.y * height);
      const w = Math.min(width - x, Math.ceil(box.width * width)), h = Math.min(height - y, Math.ceil(box.height * height));
      if (w <= 0 || h <= 0) continue;
      sizeCanvas(small, Math.max(1, Math.min(8, Math.round(w / 12))), Math.max(1, Math.min(4, Math.round(h / 12))));
      tiny.imageSmoothingEnabled = true;
      tiny.drawImage(snapshot, x, y, w, h, 0, 0, small.width, small.height);
      context.save();
      context.beginPath(); context.rect(x, y, w, h); context.clip();
      // An opaque coarse base prevents original lettering showing through the
      // transparent edge of a Gaussian filter.
      context.filter = 'none'; context.imageSmoothingEnabled = false;
      context.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
      context.filter = `blur(${Math.max(3, w * 0.08)}px)`;
      context.imageSmoothingEnabled = true;
      context.drawImage(small, 0, 0, small.width, small.height, x - w * .1, y - h * .1, w * 1.2, h * 1.2);
      context.restore();
    }
  } finally { context.restore(); }
}

/** One worker, one frame in flight, no remote model URLs and no frame uploads. */
export class LicensePlateBlurClient {
  private worker: Worker | null = null;
  private disposed = false;
  private nextId = 0;
  private active: { id: number; resolve: (boxes: PlateBox[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly input = canvasOfSize(PLATE_MODEL.size, PLATE_MODEL.size);
  private readonly history = new PlateBoxHistory();

  async redact(context: FrameContext, identity: string, time: number, signal?: AbortSignal): Promise<number> {
    if (this.disposed || signal?.aborted) throw new PlateBlurError('Detection was cancelled.');
    const cancel = () => this.dispose();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const { width, height } = context.canvas;
      const g = plateLetterbox(width, height);
      const input = this.input.getContext('2d') as FrameContext;
      input.fillStyle = '#727272'; input.fillRect(0, 0, PLATE_MODEL.size, PLATE_MODEL.size);
      input.drawImage(context.canvas, 0, 0, width, height, g.left, g.top, g.width, g.height);
      const pixels = input.getImageData(0, 0, PLATE_MODEL.size, PLATE_MODEL.size).data;
      const boxes = await this.detect(pixels, width, height);
      if (signal?.aborted || this.disposed) throw new PlateBlurError('Detection was cancelled.');
      paintPlateBlur(context, this.history.update(`${identity}:${width}x${height}`, time, boxes));
      return boxes.length;
    } catch (error) {
      throw error instanceof PlateBlurError ? error : new PlateBlurError(error instanceof Error ? error.message : String(error));
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  private detect(pixels: Uint8ClampedArray, width: number, height: number): Promise<PlateBox[]> {
    if (this.disposed) return Promise.reject(new PlateBlurError('The detector was disposed.'));
    if (this.active) return Promise.reject(new PlateBlurError('An analysis is already in progress.'));
    if (!this.worker) {
      this.worker = new Worker(new URL('./license-plate.worker', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<{ id: number; boxes?: PlateBox[]; error?: string }>) => {
        const request = this.active;
        if (!request || data.id !== request.id) return;
        clearTimeout(request.timer); this.active = null;
        if (data.error) request.reject(new PlateBlurError(data.error));
        else if (!Array.isArray(data.boxes)) request.reject(new PlateBlurError('Invalid detector response.'));
        else request.resolve(data.boxes);
      };
      this.worker.onerror = event => this.fail(event.message || 'The detector worker failed.');
      this.worker.onmessageerror = () => this.fail('The detector returned an unreadable frame.');
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.fail('Plate detection stopped responding.'), 120000);
      this.active = { id, resolve, reject, timer };
      try { worker.postMessage({ id, pixels, width, height }, [pixels.buffer]); }
      catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
    });
  }

  private fail(message: string): void {
    const request = this.active; this.active = null;
    if (request) { clearTimeout(request.timer); request.reject(new PlateBlurError(message)); }
    this.worker?.terminate(); this.worker = null;
  }

  dispose(): void { this.disposed = true; this.fail('Detection was cancelled.'); }
}

/** Only completed, redacted frames reach the visible canvas, even during seeks. */
export class LicensePlateBlurPreview {
  private generation = 0;
  private identity = '';
  private requested = '';
  private lastTime = -1;
  private pending = false;
  private task = 0;
  private client: LicensePlateBlurClient | null = null;
  private complete: OffscreenCanvas | HTMLCanvasElement | null = null;
  private readonly scratch = canvasOfSize(1, 1);
  error = '';
  completedTime = -1;

  context(width: number, height: number): FrameContext {
    sizeCanvas(this.scratch, width, height);
    return this.scratch.getContext('2d') as FrameContext;
  }

  present(target: FrameContext, identity: string, time: number, onReady: () => void, gain = 1, contentKey = '',
    prepare?: () => (client: LicensePlateBlurClient, target: FrameContext) => Promise<void>): string {
    identity = `${identity}:${this.scratch.width}x${this.scratch.height}`;
    if (identity !== this.identity || time < this.lastTime - .02 || time - this.lastTime > .2) {
      this.generation++; this.identity = identity; this.complete = null; this.requested = '';
      this.completedTime = -1;
    }
    this.lastTime = time;
    const key = `${identity}:${time.toFixed(6)}:${contentKey}`;
    if (!this.pending && !this.error && key !== this.requested) {
      this.pending = true; this.requested = key;
      const generation = this.generation;
      const task = ++this.task;
      const frozen = canvasOfSize(this.scratch.width, this.scratch.height);
      const context = frozen.getContext('2d') as FrameContext;
      context.drawImage(this.scratch, 0, 0);
      this.client ??= new LicensePlateBlurClient();
      let work: Promise<unknown>;
      try {
        const process = prepare?.();
        work = process ? process(this.client, context) : this.client.redact(context, identity, time);
      } catch (error) { work = Promise.reject(error); }
      void work.then(() => {
        if (generation !== this.generation) return;
        applyPlateFrameFade(context, gain);
        this.complete = frozen; this.completedTime = time;
      }).catch(error => {
        if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        if (task === this.task) { this.pending = false; onReady(); }
      });
    }
    target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1; target.filter = 'none';
    target.fillStyle = '#000'; target.fillRect(0, 0, target.canvas.width, target.canvas.height);
    if (this.complete && !this.error) target.drawImage(this.complete, 0, 0, target.canvas.width, target.canvas.height);
    target.restore();
    return this.error || (!this.complete ? 'Preparing local license plate blur…'
      : Math.abs(time - this.completedTime) > .15 ? 'License plate detection: preview is catching up…' : '');
  }

  invalidate(): void {
    this.generation++; this.identity = ''; this.requested = ''; this.complete = null;
    this.completedTime = -1;
    this.lastTime = -1;
  }
  reset(): void {
    this.task++; this.pending = false; this.invalidate();
    this.error = ''; this.client?.dispose(); this.client = null;
  }
  dispose(): void { this.reset(); }
}
