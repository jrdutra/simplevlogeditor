/**
 * Evening out the volume, after the noise has gone.
 *
 * The maths is not written here. Levelling already exists in the video editor
 * and lives in `shared/media/loudness`: measure the speech, decide the gain that
 * brings it to a target, follow the drift slowly enough not to pump, and round
 * off anything that would clip. This file is the two pieces that module needs
 * from a caller — buckets to measure, and a signal to apply the answer to — so
 * that a recording cleaned here and a clip levelled in the editor come out at
 * the same level, from the same code, with the same defaults.
 *
 * ## Why it runs after the suppression and not before
 *
 * Levelling asks "how loud is the speech?", and the honest answer depends on
 * whether the noise is still in the room. Measured first, a noisy recording
 * reads louder than it is, gets held back, and ends up quiet once the noise is
 * removed. Measured afterwards, the number is the voice.
 */

import {
  GainEnvelope,
  LoudnessSettings,
  gainAt,
  isUnity,
  planGainEnvelope,
  softLimit
} from '../../shared/media/loudness';

/**
 * How long one measurement bucket is.
 *
 * Twenty milliseconds is short enough that a bucket falls inside a syllable
 * rather than straddling a pause, and long enough that the number in it is a
 * level rather than a waveform. The editor's buckets are a division of the
 * clip's length instead; a fixed size is better here because this tool sees one
 * recording at a time and the smoothing is stated in seconds.
 */
export const BUCKET_SECONDS = 0.02;

/** The per-bucket RMS the loudness module measures from. */
export function bucketRms(samples: Float32Array, rate: number, seconds = BUCKET_SECONDS): Float32Array {
  const size = Math.max(1, Math.round(seconds * rate));
  const count = Math.max(1, Math.ceil(samples.length / size));
  const rms = new Float32Array(count);

  for (let bucket = 0; bucket < count; bucket++) {
    const from = bucket * size;
    const to = Math.min(samples.length, from + size);

    let energy = 0;
    for (let index = from; index < to; index++) energy += samples[index] * samples[index];
    rms[bucket] = Math.sqrt(energy / Math.max(1, to - from));
  }

  return rms;
}

export interface Levelling {
  envelope: GainEnvelope;
  /** True when the envelope would leave the signal exactly as it is. */
  unity: boolean;
}

/**
 * Works out the correction for a recording, or nothing if there is none to make.
 *
 * `null` comes back when levelling is switched off, or when the recording holds
 * nothing above the noise floor — which after suppression is a real possibility,
 * and inventing a level for it would mean amplifying what is left of the hiss.
 */
export function planLevelling(
  mono: Float32Array,
  rate: number,
  settings: LoudnessSettings
): Levelling | null {
  if (!settings.enabled || !mono.length) return null;

  const envelope = planGainEnvelope(
    bucketRms(mono, rate),
    BUCKET_SECONDS,
    mono.length / rate,
    settings
  );
  if (!envelope) return null;

  return { envelope, unity: isUnity(envelope) };
}

/**
 * Applies the correction to one channel, in place.
 *
 * In place because the caller is holding the whole soundtrack twice already and
 * a third copy per channel is what turns a long recording into a tab that runs
 * out of memory. The same envelope goes on every channel: one measured from a
 * single channel and applied to the others would move the stereo image every
 * time the speaker leaned in.
 */
export function applyLevelling(
  channel: Float32Array,
  rate: number,
  levelling: Levelling,
  limiter: boolean
): void {
  if (levelling.unity && !limiter) return;

  for (let index = 0; index < channel.length; index++) {
    const value = channel[index] * gainAt(levelling.envelope, index / rate);
    channel[index] = limiter ? softLimit(value) : value;
  }
}
