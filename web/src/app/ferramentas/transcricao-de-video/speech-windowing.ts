/** Where one window of audio starts and stops, in samples. */
interface Window {
  from: number;
  to: number;
}

/** The longest stretch handed to the model at once. Whisper's own is 30 s. */
const WINDOW_SECONDS = 30;

/**
 * How far back from a window's end a seam is allowed to move.
 *
 * Six seconds is long enough to reach the previous sentence break in ordinary
 * speech and short enough that a window never shrinks to half its size, which
 * would quietly double the number of model runs.
 */
const SEAM_SECONDS = 6;

/** The width of the stretch whose loudness is measured, in seconds. */
const HUSH_SECONDS = 0.2;

/**
 * Cuts the recording into windows that end in the quiet.
 *
 * The naive cut is every thirty seconds, and it lands mid-word about as often
 * as not: the model then hears half a word at the end of one window and half at
 * the start of the next, and writes down two wrong ones. So the end of each
 * window is walked back over the last few seconds to the quietest short stretch
 * it can find — a breath, a full stop, the gap between two clauses — and the
 * cut is made there instead.
 *
 * Compare squared RMS energy with a sliding sum.
 */
export function splitOnQuiet(samples: Float32Array, rate: number): Window[] {
  const span = Math.round(WINDOW_SECONDS * rate);
  const reach = Math.round(SEAM_SECONDS * rate);
  const hush = Math.max(1, Math.round(HUSH_SECONDS * rate));
  const windows: Window[] = [];

  let from = 0;
  while (from < samples.length) {
    let to = from + span;

    // The last window keeps whatever is left, however short.
    if (to >= samples.length) {
      windows.push({ from, to: samples.length });
      break;
    }

    // Never walk back past the start of the window, and never so far that the
    // window stops being worth a run of its own.
    const earliest = Math.max(from + hush, to - reach);
    let quietest = Number.POSITIVE_INFINITY;
    let seam = to;

    // One running sum, slid backwards from the nominal end to the earliest seam.
    let sum = 0;
    for (let at = to - hush; at < to; at++) sum += samples[at] ** 2;

    for (let start = to - hush; start >= earliest; start--) {
      if (start < to - hush) sum += samples[start] ** 2 - samples[start + hush] ** 2;

      if (sum < quietest) {
        quietest = sum;
        // Cut in the middle of the hush, so neither side clips a word.
        seam = start + (hush >> 1);
      }
    }

    to = seam;
    windows.push({ from, to });
    from = to;
  }

  return windows;
}

