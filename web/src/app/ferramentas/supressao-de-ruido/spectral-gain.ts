/**
 * Applying a suppression decision to audio without touching the voice.
 *
 * Every engine in this tool answers the same question, frame by frame and band
 * by band: how much of what is here is worth keeping? The answer is a number
 * between nought and one. What this file does is take that answer — computed at
 * whatever rate the engine happens to work at — and apply it to the recording at
 * its own sample rate, in its own bandwidth, with its own phase.
 *
 * ## Why a gain and not the engine's own output
 *
 * A speech model returns audio, and it is tempting to use it. Two things are
 * lost if you do. The first is bandwidth: the models worth using are trained at
 * 16 kHz, and a voice band-limited to 8 kHz is a voice on the telephone. The
 * second is phase: the model's reconstruction has its own, and splicing it onto
 * the untouched high band leaves an audible seam at the crossover.
 *
 * Taking only the *ratio* between what the engine was given and what it gave
 * back avoids both. The original samples keep their phase and their full
 * bandwidth; the only thing that changes is how loud each band is at each
 * moment. The band the engine cannot see follows the top of the band it can,
 * which is where breath and sibilance live, and they rise and fall together.
 */

import { Fft } from '../../shared/media/fft';

/** One engine's decision: `frames[t][k]` is the gain for bin `k` at frame `t`. */
export interface GainField {
  frames: Float32Array[];
  /** Seconds between frames. */
  step: number;
  /** Hertz between bins. */
  bandwidth: number;
}

export interface ApplyOptions {
  /**
   * The most a band may be turned down, in decibels.
   *
   * This is the strength control, and the reason it is a limit rather than a
   * multiplier: a gate that closes completely sounds like a gate. Leaving a
   * defined floor of the original underneath keeps the room the voice was
   * recorded in, which is what makes the result sound like a clean recording
   * rather than a processed one.
   */
  attenuationDb: number;
  /**
   * How quickly a band may open, in milliseconds.
   *
   * Short, because the start of a word arrives with no warning and clipping it
   * is the one artefact listeners always notice.
   */
  attackMs?: number;
  /** How quickly a band may close. Longer, so the floor does not pump. */
  releaseMs?: number;
  /** Where the band the engine cannot see begins to take its cue. */
  followFrom?: number;
  /**
   * Leave everything above the engine's reach exactly as it was.
   *
   * The engines hear up to 8 kHz, and by default the band above that follows
   * the top of the band they can hear — which is right for a voice, where
   * sibilance rises and falls with the speech under it. It is wrong for a
   * recording whose interest is up there: music, a room with air in it, a
   * cymbal. This switches that band off the leash instead of guessing for it.
   */
  preserveHighs?: boolean;
}

export const APPLY_DEFAULTS = { attackMs: 8, releaseMs: 60, followFrom: 7000 } as const;

/** The strength presets offered on screen, in decibels of maximum attenuation. */
export const STRENGTH_LIMITS = { min: 6, max: 40, step: 1, default: 24 } as const;

/**
 * A square-root Hann window.
 *
 * Applied on both analysis and synthesis it multiplies out to a plain Hann,
 * which sums to a constant at 50 % overlap — so a frame that is left alone
 * comes back bit for bit, and only the frames that were changed change.
 */
export function sqrtHann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    window[index] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size));
  }
  return window;
}

/** The transform size for a rate: about 32 ms, rounded to a power of two. */
export function frameSize(rate: number): number {
  const wanted = Math.log2(0.032 * Math.max(8000, rate));
  return 1 << Math.min(12, Math.max(8, Math.round(wanted)));
}

/**
 * Smooths a field over time, quickly upwards and slowly downwards.
 *
 * Returns a new field; the engine's own numbers are left alone so the same
 * decision can be re-applied at a different strength without re-running it.
 */
export function smoothField(field: GainField, attackMs: number, releaseMs: number): GainField {
  const frames = field.frames.map((frame) => Float32Array.from(frame));
  const rise = Math.exp((-field.step * 1000) / Math.max(1, attackMs));
  const fall = Math.exp((-field.step * 1000) / Math.max(1, releaseMs));

  for (let at = 1; at < frames.length; at++) {
    const previous = frames[at - 1];
    const current = frames[at];
    for (let bin = 0; bin < current.length; bin++) {
      const keep = current[bin] > previous[bin] ? rise : fall;
      current[bin] = current[bin] + (previous[bin] - current[bin]) * keep;
    }
  }

  return { ...field, frames };
}

/** The gain for one point in time and frequency, interpolated in both. */
function gainAt(field: GainField, high: Float32Array, seconds: number, hertz: number): number {
  const position = seconds / field.step;
  const first = Math.max(0, Math.min(field.frames.length - 1, Math.floor(position)));
  const second = Math.min(field.frames.length - 1, first + 1);
  const across = Math.max(0, Math.min(1, position - first));

  const bins = field.frames[0].length;
  const top = (bins - 1) * field.bandwidth;

  if (hertz >= top) return high[first] + (high[second] - high[first]) * across;

  const place = hertz / field.bandwidth;
  const low = Math.floor(place);
  const next = Math.min(bins - 1, low + 1);
  const between = place - low;

  const a = field.frames[first][low] + (field.frames[first][next] - field.frames[first][low]) * between;
  const b = field.frames[second][low] + (field.frames[second][next] - field.frames[second][low]) * between;
  return a + (b - a) * across;
}

/**
 * Applies a gain field to one channel of audio.
 *
 * The audio keeps its sample rate: the field is read at the time and frequency
 * each output bin actually sits at, so an engine working at 16 kHz can drive a
 * 48 kHz recording without either being resampled to meet the other.
 */
export function applyGains(
  samples: Float32Array,
  rate: number,
  field: GainField,
  options: ApplyOptions,
  prepared?: GainField
): Float32Array {
  if (!field.frames.length || !samples.length) return Float32Array.from(samples);

  const size = frameSize(rate);
  const hop = size / 4;
  const bins = size / 2 + 1;
  const window = sqrtHann(size);
  const fft = new Fft(size);

  const smoothed = prepared ?? smoothField(
    field,
    options.attackMs ?? APPLY_DEFAULTS.attackMs,
    options.releaseMs ?? APPLY_DEFAULTS.releaseMs
  );
  const floor = Math.pow(10, -Math.abs(options.attenuationDb) / 20);

  // What the band above the engine's reach follows: the mean gain of the top of
  // the band it can see.
  const modelBins = smoothed.frames[0].length;
  const from = Math.min(modelBins - 1, Math.round((options.followFrom ?? APPLY_DEFAULTS.followFrom) / smoothed.bandwidth));
  // The frequency the engine's own band stops at.
  const top = (modelBins - 1) * smoothed.bandwidth;
  const high = new Float32Array(smoothed.frames.length);
  for (let at = 0; at < smoothed.frames.length; at++) {
    let total = 0;
    for (let bin = from; bin < modelBins; bin++) total += smoothed.frames[at][bin];
    high[at] = total / (modelBins - from);
  }

  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  const out = new Float32Array(samples.length);

  // Starts before the first sample so that the very first word is covered by a
  // full set of overlapping frames, exactly like every other word.
  for (let at = hop - size; at < samples.length; at += hop) {
    for (let index = 0; index < size; index++) {
      const source = at + index;
      real[index] = (source >= 0 && source < samples.length ? samples[source] : 0) * window[index];
      imag[index] = 0;
    }
    fft.forward(real, imag);

    const centre = (at + size / 2) / rate;
    for (let bin = 0; bin < bins; bin++) {
      const hertz = (bin * rate) / size;
      const gain = options.preserveHighs && hertz >= top
        ? 1
        : Math.max(floor, Math.min(1, gainAt(smoothed, high, centre, hertz)));
      real[bin] *= gain;
      imag[bin] *= gain;
      if (bin > 0 && bin < size / 2) {
        real[size - bin] = real[bin];
        imag[size - bin] = -imag[bin];
      }
    }
    imag[0] = 0;
    imag[size / 2] = 0;

    fft.inverse(real, imag);
    for (let index = 0; index < size; index++) {
      const target = at + index;
      if (target < 0 || target >= out.length) continue;
      out[target] += real[index] * window[index];
    }
  }

  // Four overlapping periodic Hann windows sum to two, including padded edges.
  for (let index = 0; index < samples.length; index++) {
    out[index] /= 2;
  }
  return out;
}

/**
 * The gain field implied by a denoiser that returns audio rather than gains.
 *
 * RNNoise is such a denoiser. Comparing the magnitude of what went in with the
 * magnitude of what came out, band by band, recovers the decision it made — and
 * once it is a field it goes through the same applier as every other engine, so
 * the strength control and the untouched high band work identically.
 */
export function fieldFromPair(
  before: Float32Array,
  after: Float32Array,
  rate: number,
  size = 1024
): GainField {
  const hop = size / 2;
  const bins = size / 2 + 1;
  const window = sqrtHann(size);
  const fft = new Fft(size);

  const beforeReal = new Float32Array(size);
  const beforeImag = new Float32Array(size);
  const afterReal = new Float32Array(size);
  const afterImag = new Float32Array(size);
  const frames: Float32Array[] = [];

  // The first frame is centred on sample zero, like the model's own field, so
  // both kinds of field are read against the same clock. Starting at zero
  // instead would put the first answer half a window late, and a recording
  // shorter than one window would produce no answer at all.
  const length = Math.max(before.length, after.length);
  for (let at = -size / 2; at < length; at += hop) {
    for (let index = 0; index < size; index++) {
      const source = at + index;
      const inside = source >= 0;
      beforeReal[index] = (inside && source < before.length ? before[source] : 0) * window[index];
      afterReal[index] = (inside && source < after.length ? after[source] : 0) * window[index];
      beforeImag[index] = 0;
      afterImag[index] = 0;
    }
    fft.forward(beforeReal, beforeImag);
    fft.forward(afterReal, afterImag);

    const gains = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin++) {
      const was = Math.hypot(beforeReal[bin], beforeImag[bin]);
      const is = Math.hypot(afterReal[bin], afterImag[bin]);
      gains[bin] = was > 1e-7 ? Math.min(1, is / was) : 1;
    }
    frames.push(gains);
  }

  return { frames, step: hop / rate, bandwidth: rate / size };
}

/** Peak of a channel, for the clipping guard after processing. */
export function peak(samples: Float32Array): number {
  let top = 0;
  for (const value of samples) {
    const size = Math.abs(value);
    if (size > top) top = size;
  }
  return top;
}
