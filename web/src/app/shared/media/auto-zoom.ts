/**
 * Automatic zoom after an unusually long pause.
 *
 * The idea is borrowed from how people cut talking-head video by hand: when a
 * long pause is removed, the two halves it joined were filmed with the same
 * framing, so the join is visible as a jump. Pushing in slightly on the second
 * half hides the jump and, as a side effect, gives the edit a rhythm — the
 * picture changes exactly where the pace of the speech did.
 *
 * Only pauses that stand out are used. A recording is full of ordinary gaps
 * between sentences, and zooming on every one of them would be seasickness
 * rather than editing, so the average removed pause sets the bar and only the
 * ones far above it qualify.
 *
 * Everything here is pure and deterministic: the same analysis and the same
 * settings always produce the same zooms, because a preview that disagreed with
 * the exported file would be worse than no preview at all. That is why the
 * random variation runs off a seeded generator rather than `Math.random`.
 */

/** A half-open interval of a media timeline, in seconds. */
export interface ZoomTimeRange {
  start: number;
  end: number;
}

/** How the amount of zoom is chosen inside the allowed range. */
export type ZoomScaleMode = 'random' | 'proportional';

/**
 * What earns a zoom.
 *
 * The two rules answer different needs. `above-average` follows the content:
 * it zooms where the speaker actually stopped, so the move lands on a real
 * beat. `every-cuts` follows the clock: it zooms every so many cuts whether or
 * not anything special happened, which is what keeps a densely edited stretch —
 * where every pause is much the same length, so none of them stands out — from
 * running for minutes on one framing.
 */
export type ZoomTriggerMode = 'above-average' | 'every-cuts' | 'both';

/** Everything the reader can tune behind the "Automatic zoom" checkbox. */
export interface AutoZoomSettings {
  enabled: boolean;
  /**
   * How far above the average removed pause a pause must be to earn a zoom,
   * as a percentage. 30 means "at least 30% longer than the average one".
   */
  triggerPercent: number;
  /** Which rule, or rules, may earn a zoom. */
  triggerMode: ZoomTriggerMode;
  /** With the interval rule, one zoom after every this many removed pauses. */
  everyCuts: number;
  /** The fixed push-in the interval rule uses, as a percentage of the frame. */
  intervalZoomPercent: number;
  /** Smallest push-in, as a percentage of the frame. */
  minZoomPercent: number;
  /** Largest push-in, as a percentage of the frame. */
  maxZoomPercent: number;
  scaleMode: ZoomScaleMode;
  /** How long the push-in takes, in seconds. Zero cuts straight to it. */
  rampSeconds: number;
  /** How long the zoomed framing is held. Zero holds it to the end of the take. */
  holdSeconds: number;
  /**
   * Keep the push-in instead of pulling back out of it.
   *
   * Off by default, and deliberately: pulling back returns every take to the
   * same framing, which is what makes the *next* push-in read as a move. But a
   * held zoom is how a lot of talking-head editing actually works — each cut
   * lands a little closer than the last and stays there — and that is not
   * something the reader can build out of a setting that always eases out.
   *
   * When it is on the zoom also runs to the end of the take rather than for
   * `holdSeconds`: a push-in that is kept and then vanishes at a fixed moment
   * would be the worst of both.
   */
  holdToEnd: boolean;
}

export const DEFAULT_AUTO_ZOOM: AutoZoomSettings = {
  enabled: false,
  triggerPercent: 30,
  triggerMode: 'above-average',
  everyCuts: 5,
  intervalZoomPercent: 10,
  minZoomPercent: 10,
  maxZoomPercent: 20,
  scaleMode: 'random',
  rampSeconds: 0.4,
  holdSeconds: 4,
  holdToEnd: false
};

/** Bounds enforced by both the fields and anything restored from storage. */
export const AUTO_ZOOM_LIMITS = {
  triggerPercent: { min: 0, max: 300, step: 5 },
  everyCuts: { min: 1, max: 50, step: 1 },
  intervalZoomPercent: { min: 1, max: 60, step: 1 },
  minZoomPercent: { min: 1, max: 60, step: 1 },
  maxZoomPercent: { min: 1, max: 60, step: 1 },
  rampSeconds: { min: 0, max: 3, step: 0.05 },
  holdSeconds: { min: 0, max: 30, step: 0.5 }
} as const;

/**
 * Clamps every field, and makes sure the smaller bound really is the smaller
 * one — a reader who types 25 into "minimum" while "maximum" still says 20 has
 * described a range, just backwards, and refusing it would be pedantry.
 */
export function clampAutoZoom(settings: AutoZoomSettings): AutoZoomSettings {
  const clamp = (value: number, limits: { min: number; max: number }) =>
    Number.isFinite(value) ? Math.min(limits.max, Math.max(limits.min, value)) : limits.min;

  const first = clamp(settings.minZoomPercent, AUTO_ZOOM_LIMITS.minZoomPercent);
  const second = clamp(settings.maxZoomPercent, AUTO_ZOOM_LIMITS.maxZoomPercent);

  return {
    enabled: Boolean(settings.enabled),
    triggerPercent: clamp(settings.triggerPercent, AUTO_ZOOM_LIMITS.triggerPercent),
    triggerMode:
      settings.triggerMode === 'every-cuts' || settings.triggerMode === 'both'
        ? settings.triggerMode
        : 'above-average',
    everyCuts: Math.round(clamp(settings.everyCuts, AUTO_ZOOM_LIMITS.everyCuts)),
    intervalZoomPercent: clamp(settings.intervalZoomPercent, AUTO_ZOOM_LIMITS.intervalZoomPercent),
    minZoomPercent: Math.min(first, second),
    maxZoomPercent: Math.max(first, second),
    scaleMode: settings.scaleMode === 'proportional' ? 'proportional' : 'random',
    rampSeconds: clamp(settings.rampSeconds, AUTO_ZOOM_LIMITS.rampSeconds),
    holdSeconds: clamp(settings.holdSeconds, AUTO_ZOOM_LIMITS.holdSeconds),
    holdToEnd: Boolean(settings.holdToEnd)
  };
}

/** One push-in, expressed on the **output** timeline. */
export interface ZoomSegment {
  start: number;
  end: number;
  /** 1.15 means the picture is drawn 15% larger and cropped to the frame. */
  scale: number;
  /** Seconds spent easing in at the start, and out again at the end. */
  rampSeconds: number;
  /** Length of the pause that earned this zoom, kept so the UI can explain it. */
  pauseSeconds: number;
  /** Which rule put it here. */
  reason: 'above-average' | 'every-cuts';
  /**
   * Whether the picture pulls back out of the zoom at the end of the segment.
   *
   * False keeps the framing to the last frame of the take, which is what "hold
   * the zoom" means: the cut itself returns to the wide shot, so there is
   * nothing left to ease back to.
   */
  easeOut: boolean;
}

/** Below this a range is noise rather than a pause. */
const MINIMUM_PAUSE = 1e-3;

/** A pause this many times past the trigger reaches the largest zoom. */
const PROPORTIONAL_SPAN = 1;

/**
 * Plans every zoom for one piece of media.
 *
 * `removedSilences` and `keepRanges` are both in *source* time; the segments
 * that come back are in *output* time, because that is the only clock the
 * encoder ever sees. Translating once, here, is what keeps the renderer from
 * having to know anything about what was cut.
 */
export function planAutoZooms(
  removedSilences: readonly ZoomTimeRange[],
  keepRanges: readonly ZoomTimeRange[],
  settings: AutoZoomSettings,
  seed: string | number = 0
): ZoomSegment[] {
  if (!settings.enabled) return [];

  const pauses = removedSilences
    .map((range) => ({ range, length: range.end - range.start }))
    .filter((entry) => entry.length > MINIMUM_PAUSE);

  // An average needs something to average over. The interval rule does not, so
  // only the rule that reads the average is switched off when there is none.
  if (!pauses.length || keepRanges.length < 2) return [];
  if (pauses.length < 2 && settings.triggerMode === 'above-average') return [];

  const average = pauses.reduce((total, entry) => total + entry.length, 0) / pauses.length;
  const trigger = average * (1 + settings.triggerPercent / 100);

  // Where each kept range lands once everything before it has been removed.
  const offsets: number[] = [];
  let cursor = 0;
  for (const range of keepRanges) {
    offsets.push(cursor);
    cursor += Math.max(0, range.end - range.start);
  }

  const random = mulberry32(toSeed(seed));
  const segments: ZoomSegment[] = [];

  const wantsAverage = settings.triggerMode !== 'every-cuts';
  const wantsInterval = settings.triggerMode !== 'above-average';
  const every = Math.max(1, Math.round(settings.everyCuts));

  for (const [index, { range, length }] of pauses.entries()) {
    const standsOut = wantsAverage && length >= trigger;
    // Counted from one, so "every 5 cuts" fires on the fifth pause rather than
    // on the first — the first cut is not yet a stretch that needs breaking up.
    const onInterval = wantsInterval && (index + 1) % every === 0;
    if (!standsOut && !onInterval) continue;

    // The zoom belongs to whatever survives *after* the pause, so a pause that
    // trails off the end of the media earns nothing.
    const keepIndex = keepRanges.findIndex((keep) => keep.start >= range.end - MINIMUM_PAUSE);
    if (keepIndex <= 0) continue;

    const keep = keepRanges[keepIndex];
    const available = Math.max(0, keep.end - keep.start);
    if (available <= MINIMUM_PAUSE) continue;

    // A pause that only made it here by counting gets the fixed interval
    // amount: there is nothing about it to be proportional *to*, and varying it
    // at random would make a regular device look like an accident.
    let percent = settings.intervalZoomPercent;
    if (standsOut) {
      const amount =
        settings.scaleMode === 'proportional'
          ? clamp01(trigger > 0 ? (length / trigger - 1) / PROPORTIONAL_SPAN : 1)
          : random();
      percent = settings.minZoomPercent + amount * (settings.maxZoomPercent - settings.minZoomPercent);
    }
    const start = offsets[keepIndex];
    // A held zoom runs to the end of the take: a push-in that is kept and then
    // disappears at a fixed second would be neither one thing nor the other.
    const hold =
      settings.holdToEnd || settings.holdSeconds <= 0
        ? available
        : Math.min(settings.holdSeconds, available);
    const end = start + hold;

    // Two zooms that overlap would fight over the same frames, so the earlier
    // one gives way: it is already on screen, and cutting it short reads as the
    // push-in simply continuing into the next one.
    const previous = segments[segments.length - 1];
    if (previous && previous.end > start) previous.end = start;
    if (previous && previous.end - previous.start <= MINIMUM_PAUSE) segments.pop();

    segments.push({
      start,
      end,
      scale: 1 + percent / 100,
      // A ramp longer than half the segment would start easing out before it
      // finished easing in, which looks like a wobble rather than a move — but
      // a zoom that never eases out only has to fit the way in.
      rampSeconds: Math.min(settings.rampSeconds, settings.holdToEnd ? hold : hold / 2),
      pauseSeconds: length,
      reason: standsOut ? 'above-average' : 'every-cuts',
      easeOut: !settings.holdToEnd
    });
  }

  return segments;
}

/**
 * How much the picture is enlarged at one instant. 1 outside every segment.
 *
 * The segments never overlap and are in order, so the first one that starts
 * after the instant ends the search.
 */
export function zoomScaleAt(segments: readonly ZoomSegment[], time: number): number {
  for (const segment of segments) {
    if (time < segment.start) break;
    if (time >= segment.end) continue;

    const ramp = segment.rampSeconds;
    let progress = 1;
    if (ramp > 0) {
      const easingIn = (time - segment.start) / ramp;
      // A held zoom has no way out: the framing stays until the take ends and
      // the cut does the returning.
      const easingOut = segment.easeOut === false ? Infinity : (segment.end - time) / ramp;
      progress = clamp01(Math.min(easingIn, easingOut));
    }

    return 1 + (segment.scale - 1) * smoothstep(progress);
  }
  return 1;
}

/**
 * Draws one frame letterboxed into the output, enlarged by `scale`.
 *
 * The fit is computed here rather than left to the encoder's own transform
 * because the two cannot both own it: once a frame has been through a canvas
 * the encoder sees a picture that already has the output's shape, and a second
 * fit would do nothing. Taking the drawing itself as a callback keeps this
 * usable for a decoded video sample and for a plain canvas alike.
 */
export function drawZoomed(
  draw: (x: number, y: number, width: number, height: number) => void,
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
  scale: number,
  /**
   * True to cover the frame and let the overflow fall outside it.
   *
   * The default is the letterbox this has always done, which is the only safe
   * answer when the reader has not asked for anything: cropping a picture
   * nobody asked to crop loses content silently. It becomes the right answer
   * the moment the reader reframes the project — a 16:9 shot fitted into a 9:16
   * frame is a stamp in the middle of a black screen, and what they meant was
   * the shot filling the phone.
   */
  fill = false
): void {
  const source = sourceWidth > 0 && sourceHeight > 0;
  const cover = fill
    ? Math.max(frameWidth / sourceWidth, frameHeight / sourceHeight)
    : Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight);
  const fit = source ? cover : 1;

  const width = (source ? sourceWidth * fit : frameWidth) * scale;
  const height = (source ? sourceHeight * fit : frameHeight) * scale;

  draw((frameWidth - width) / 2, (frameHeight - height) / 2, width, height);
}

/** Plain-language summary of a plan, for the line under the checkbox. */
export function describeZoomPlan(segments: readonly ZoomSegment[]): string {
  if (!segments.length) return 'No pause stood out enough to zoom on.';

  const percents = segments.map((segment) => Math.round((segment.scale - 1) * 100));
  const smallest = Math.min(...percents);
  const largest = Math.max(...percents);
  const range = smallest === largest ? `${smallest}%` : `${smallest}–${largest}%`;

  const standouts = segments.filter((segment) => segment.reason === 'above-average').length;
  const interval = segments.length - standouts;
  const because =
    standouts && interval
      ? `${standouts} after a long pause, ${interval} on the cut count`
      : standouts
        ? 'after the longest pauses'
        : 'on the cut count';

  return `${segments.length} zoom${segments.length === 1 ? '' : 's'} of ${range}, ${because}.`;
}

// ---------------------------------------------------------------- internals

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Eases both ends of the ramp so the move starts and stops without a jerk. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function toSeed(seed: string | number): number {
  if (typeof seed === 'number') return Math.floor(Math.abs(seed)) || 1;

  // FNV-1a: short, stable across runs, and good enough to turn a clip id into
  // a starting point that differs from its neighbour's.
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

/** Mulberry32: thirty lines of state, uniform enough for choosing a percentage. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
