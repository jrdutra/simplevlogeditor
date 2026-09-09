/**
 * Changing sample rate, in a worker, without the Web Audio API.
 *
 * The browser has a good resampler inside `OfflineAudioContext`, and every
 * other tool here uses it. This one cannot: the suppression runs in a worker,
 * where there is no audio context, and moving the audio back to the main thread
 * twice per file to borrow one would cost more than the transform.
 *
 * What is needed is also narrower than a general resampler. The result is never
 * heard — it exists only for the engine to make a decision from, and the
 * decision is applied to the untouched original. So this is a windowed sinc with
 * a fixed half-width, which is short enough to be quick and long enough that
 * nothing an engine listens for is lost.
 */

/**
 * Zero crossings of the sinc either side of the centre.
 *
 * Counted in periods of the *filter*, not in input samples. Downsampling from
 * 192 kHz to 16 kHz needs a filter that cuts at 8 kHz, and a kernel measured in
 * input samples would then be a twelfth of a period wide — no filter at all, and
 * everything above the new Nyquist folds back into the band. Measuring the
 * width in periods keeps the stopband the same however far the rate falls; the
 * kernel simply reaches over more input samples to do it.
 */
const LOBES = 24;

export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !samples.length) return samples;

  const ratio = to / from;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(length);

  // Downwards, the filter has to cut at the new Nyquist or the noise above it
  // folds back into the band the engine is judging. Upwards there is nothing to
  // cut, so the cutoff stays at the original Nyquist.
  const cutoff = Math.min(1, ratio) * 0.95;
  const reach = LOBES / cutoff;

  for (let index = 0; index < length; index++) {
    const centre = index / ratio;
    const first = Math.max(0, Math.ceil(centre - reach));
    const last = Math.min(samples.length - 1, Math.floor(centre + reach));

    let total = 0;
    let weight = 0;
    for (let at = first; at <= last; at++) {
      const distance = (at - centre) * cutoff;
      const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);

      // Blackman rather than Hann: the extra term buys about thirty decibels of
      // stopband, which is the difference between hearing an aliased whistle and
      // not, and costs one cosine per tap.
      const position = (at - centre + reach) / (2 * reach);
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * position) + 0.08 * Math.cos(4 * Math.PI * position);

      total += samples[at] * sinc * window;
      weight += sinc * window;
    }

    // Normalised by the weight actually used, so a constant comes back as the
    // same constant even where the kernel runs off the end of the recording.
    out[index] = weight > 1e-9 ? total / weight : 0;
  }

  return out;
}

/**
 * One channel for the engine to listen to.
 *
 * Averaging is right almost always and catastrophic occasionally: a stereo pair
 * recorded with one side out of phase — a miswired cable, a plug-in left on —
 * averages to silence, and an engine handed silence decides the whole recording
 * is noise. So the average is checked against the channels it came from, and if
 * it has collapsed the loudest channel is used on its own. The threshold is far
 * below anything ordinary stereo produces; real material never trips it.
 */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];

  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let index = 0; index < length; index++) mono[index] += channel[index] / channels.length;
  }

  let mixed = 0;
  for (let index = 0; index < length; index++) mixed += mono[index] * mono[index];

  let strongest = channels[0];
  let most = 0;
  for (const channel of channels) {
    let energy = 0;
    for (let index = 0; index < length; index++) energy += channel[index] * channel[index];
    if (energy > most) {
      most = energy;
      strongest = channel;
    }
  }

  return mixed < most * 0.01 ? Float32Array.from(strongest) : mono;
}
