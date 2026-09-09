/**
 * RNNoise: the small, old, dependable one.
 *
 * Xiph's recurrent denoiser from 2018, compiled to WebAssembly by the Jitsi
 * project and used here under the Apache 2.0 licence of that build. It is a
 * hundred kilobytes with the binary inlined into the JavaScript, so it is
 * already inside the page and there is nothing to fetch — which is the whole
 * reason it is offered beside a better model.
 *
 * It is fixed at 48 kHz and at frames of 480 samples, and it expects its input
 * scaled the way a 16-bit file is, not the way the Web Audio API is: the C code
 * works in units of a sixteen-bit sample, so everything is multiplied by 32768
 * on the way in and divided on the way out.
 *
 * The library returns audio rather than a decision, and one frame of latency
 * with it. Both are handled here: the delay is taken out by dropping the first
 * frame of output, and the decision is recovered by comparing the input and
 * output spectra, so that this engine reaches the applier in exactly the same
 * shape as the model does.
 */

import { GainField, fieldFromPair } from './spectral-gain';
import { RNNOISE_FRAME, RNNOISE_RATE } from './noise-suppression.models';

/** The subset of the Emscripten module this file uses. */
interface RnnoiseModule {
  _rnnoise_create(model?: number): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, output: number, input: number): number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  HEAPF32: Float32Array;
}

let pending: Promise<RnnoiseModule> | undefined;

export function loadRnnoise(): Promise<RnnoiseModule> {
  pending ??= import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js')
    .then((module) => (module.default as () => Promise<RnnoiseModule>)())
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

/**
 * Runs RNNoise over 48 kHz audio and returns the decision it made.
 *
 * The caller is responsible for handing over 48 kHz samples: this engine has no
 * opinion about resampling, and the tool already has to resample for the model.
 */
export async function rnnoiseField(
  samples: Float32Array,
  onProgress: (ratio: number) => void,
  isCanceled: () => boolean
): Promise<GainField> {
  const rnnoise = await loadRnnoise();
  const state = rnnoise._rnnoise_create();
  const buffer = rnnoise._malloc(RNNOISE_FRAME * 4);

  try {
    if (!state || !buffer) throw new Error('RNNoise could not allocate its working memory.');
    // Flush the delayed final frame before discarding the leading 10 ms.
    const frames = Math.ceil(samples.length / RNNOISE_FRAME) + 1;
    const cleaned = new Float32Array(frames * RNNOISE_FRAME);
    const frame = new Float32Array(RNNOISE_FRAME);

    for (let index = 0; index < frames; index++) {
      if (isCanceled()) throw new DOMException('Canceled', 'AbortError');

      const at = index * RNNOISE_FRAME;
      for (let position = 0; position < RNNOISE_FRAME; position++) {
        const source = at + position;
        frame[position] = (source < samples.length ? samples[source] : 0) * 32768;
      }

      // The heap can be replaced by a growing allocation, so it is read fresh
      // every frame rather than held in a local.
      rnnoise.HEAPF32.set(frame, buffer >> 2);
      rnnoise._rnnoise_process_frame(state, buffer, buffer);
      const out = rnnoise.HEAPF32.subarray(buffer >> 2, (buffer >> 2) + RNNOISE_FRAME);
      for (let position = 0; position < RNNOISE_FRAME; position++) {
        cleaned[at + position] = out[position] / 32768;
      }

      if ((index & 63) === 0) onProgress(frames > 0 ? index / frames : 0);
    }

    onProgress(1);

    // One frame of algorithmic delay: without removing it the gain field would
    // be ten milliseconds late and every word would start clipped.
    const aligned = new Float32Array(samples.length);
    aligned.set(cleaned.subarray(RNNOISE_FRAME, RNNOISE_FRAME + samples.length));

    return fieldFromPair(samples, aligned, RNNOISE_RATE);
  } finally {
    rnnoise._free(buffer);
    rnnoise._rnnoise_destroy(state);
  }
}
