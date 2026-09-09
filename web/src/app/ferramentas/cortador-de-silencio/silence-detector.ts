import { ChannelMode, EditableRange, SilenceSettings, TimeRange } from './silence-cutter.models';

/**
 * Turns per-window loudness measurements into the ranges that will be removed.
 *
 * Everything here is pure and synchronous: the same window statistics always
 * produce the same ranges, which is what lets the tool re-detect instantly when
 * only the thresholds change, and what makes the whole step unit-testable
 * without decoding a single byte of media.
 */

/**
 * Amplitude floor used before converting to decibels.
 *
 * Digital silence is exactly 0, and `log10(0)` is `-Infinity`, which would
 * poison every comparison downstream. 1e-6 puts the floor at -120 dBFS, far
 * below any threshold the tool offers.
 */
const AMPLITUDE_FLOOR = 1e-6;

/** Lowest level the tool reports, in dBFS. */
export const MIN_DB = -120;

/** Converts a linear RMS amplitude in [0, 1] to dBFS. */
export function amplitudeToDb(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= AMPLITUDE_FLOOR) return MIN_DB;
  return 20 * Math.log10(amplitude);
}

/** Converts a dBFS level back to a linear amplitude in [0, 1]. */
export function dbToAmplitude(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Per-window loudness of every channel, laid out window-major.
 *
 * One flat `Float32Array` rather than an array of arrays: the analysis engines
 * (worker and WebGPU) both write straight into it, and it transfers between
 * threads without a copy.
 */
export interface WindowStatistics {
  /** RMS per channel, indexed as `window * channelCount + channel`. */
  rms: Float32Array;
  channelCount: number;
  windowCount: number;
  /** Duration covered by one window, in seconds. */
  windowSeconds: number;
  /** Total duration measured, in seconds. */
  duration: number;
}

/**
 * Collapses the channels of one window into the single level the threshold is
 * compared against.
 *
 * - `combined` measures the energy of all channels together, which is the safe
 *   default: a voice panned hard to one side still registers.
 * - `any` treats a window as silent as soon as one channel falls quiet, so it
 *   compares the quietest channel.
 * - `all` requires every channel to fall quiet, so it compares the loudest.
 */
export function reduceChannels(
  rms: Float32Array,
  offset: number,
  channelCount: number,
  mode: ChannelMode
): number {
  if (channelCount <= 1) return rms[offset] ?? 0;

  if (mode === 'combined') {
    let sumOfSquares = 0;
    for (let c = 0; c < channelCount; c++) {
      const value = rms[offset + c];
      sumOfSquares += value * value;
    }
    return Math.sqrt(sumOfSquares / channelCount);
  }

  let quietest = Infinity;
  let loudest = 0;
  for (let c = 0; c < channelCount; c++) {
    const value = rms[offset + c];
    if (value < quietest) quietest = value;
    if (value > loudest) loudest = value;
  }
  return mode === 'any' ? quietest : loudest;
}

/** The level of every window, in dBFS, after the channel reduction. */
export function windowLevelsDb(stats: WindowStatistics, mode: ChannelMode): Float32Array {
  const levels = new Float32Array(stats.windowCount);
  for (let w = 0; w < stats.windowCount; w++) {
    levels[w] = amplitudeToDb(reduceChannels(stats.rms, w * stats.channelCount, stats.channelCount, mode));
  }
  return levels;
}

/** Sorts, clamps to [0, duration] and merges overlapping or touching ranges. */
export function normalizeRanges(ranges: readonly TimeRange[], duration: number): TimeRange[] {
  const clamped: TimeRange[] = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, duration));
    const end = Math.max(0, Math.min(range.end, duration));
    if (end > start) clamped.push({ start, end });
  }

  clamped.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: TimeRange[] = [];
  for (const range of clamped) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }

  return merged;
}

/** The parts of [0, duration] that the given ranges do not cover. */
export function complementRanges(ranges: readonly TimeRange[], duration: number): TimeRange[] {
  const keep: TimeRange[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) keep.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }

  if (cursor < duration) keep.push({ start: cursor, end: duration });
  return keep;
}

/** Total length of a list of ranges, in seconds. */
export function totalDuration(ranges: readonly TimeRange[]): number {
  return ranges.reduce((total, range) => total + (range.end - range.start), 0);
}

/**
 * Runs the whole detection: windows below the threshold become candidate
 * silences, too-short candidates are preserved, the speech margins shrink what
 * is left, and finally isolated fragments of kept audio are absorbed.
 */
export function detectSilence(
  stats: WindowStatistics,
  settings: SilenceSettings
): { silenceRanges: EditableRange[]; keepRanges: TimeRange[]; peakDb: number } {
  const duration = stats.duration;
  const levels = windowLevelsDb(stats, settings.channelMode);

  let peakDb = MIN_DB;
  for (let w = 0; w < levels.length; w++) {
    if (levels[w] > peakDb) peakDb = levels[w];
  }

  // 1. Group the consecutive windows that sit below the threshold.
  const candidates: TimeRange[] = [];
  let runStart = -1;

  for (let w = 0; w < stats.windowCount; w++) {
    const silent = levels[w] < settings.thresholdDb;
    if (silent && runStart < 0) runStart = w;
    if (!silent && runStart >= 0) {
      candidates.push({ start: runStart * stats.windowSeconds, end: w * stats.windowSeconds });
      runStart = -1;
    }
  }
  if (runStart >= 0) candidates.push({ start: runStart * stats.windowSeconds, end: duration });

  // 2. A pause only counts once it has lasted long enough. This is what keeps
  //    the gaps between words, and the breaths inside a sentence, intact.
  const minimumSilence = settings.minimumSilenceMs / 1000;
  const longEnough = candidates.filter((range) => range.end - range.start >= minimumSilence);

  // 3. Give the speech room to breathe on both sides. The margins shrink the
  //    silence rather than growing the speech, so they can never overlap it.
  const keepAfter = settings.keepAfterMs / 1000;
  const keepBefore = settings.keepBeforeMs / 1000;
  const padded: TimeRange[] = [];

  for (const range of longEnough) {
    // A silence that opens the file has no speech before it to protect, and one
    // that closes the file has none after it.
    const start = range.start <= 0 ? range.start : range.start + keepAfter;
    const end = range.end >= duration ? range.end : range.end - keepBefore;
    if (end > start) padded.push({ start, end });
  }

  let silences = normalizeRanges(padded, duration);

  // 4. Absorb kept fragments too short to be worth keeping, but never the
  //    opening or closing segment: those are the start and the end of the file,
  //    not something trapped between two pauses.
  const minimumKept = settings.minimumKeptSegmentMs / 1000;
  if (minimumKept > 0 && silences.length > 1) {
    const absorbed: TimeRange[] = [];
    let current = { ...silences[0] };

    for (let i = 1; i < silences.length; i++) {
      const next = silences[i];
      if (next.start - current.end < minimumKept) {
        current.end = next.end;
        continue;
      }
      absorbed.push(current);
      current = { ...next };
    }

    absorbed.push(current);
    silences = normalizeRanges(absorbed, duration);
  }

  const silenceRanges: EditableRange[] = silences.map((range) => ({
    ...range,
    source: 'automatic',
    enabled: true
  }));

  return {
    silenceRanges,
    keepRanges: complementRanges(silences, duration),
    peakDb
  };
}

/**
 * Recomputes the kept ranges from the silences the reader left enabled.
 *
 * Manual toggling is not exposed yet, but the renderer already reads the kept
 * ranges through this function, so turning a range back on later changes
 * nothing else in the pipeline.
 */
export function keepRangesFor(silences: readonly EditableRange[], duration: number): TimeRange[] {
  const active = normalizeRanges(silences.filter((range) => range.enabled), duration);
  return complementRanges(active, duration);
}

/**
 * Sorts, clamps and merges editable ranges while remembering who made them.
 *
 * {@link normalizeRanges} throws the origin away, which is fine for detection
 * but wrong the moment the reader edits: a hand-drawn region that swallows a
 * detected one has to survive as `manual`, otherwise a later pass over the
 * list could not tell the two apart.
 */
export function mergeEditableRanges(
  ranges: readonly EditableRange[],
  duration: number
): EditableRange[] {
  const clamped: EditableRange[] = [];

  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, duration));
    const end = Math.max(0, Math.min(range.end, duration));
    if (end > start) clamped.push({ start, end, source: range.source, enabled: range.enabled });
  }

  clamped.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: EditableRange[] = [];
  for (const range of clamped) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      if (range.source === 'manual') previous.source = 'manual';
      previous.enabled = previous.enabled || range.enabled;
      continue;
    }
    merged.push({ ...range });
  }

  return merged;
}
