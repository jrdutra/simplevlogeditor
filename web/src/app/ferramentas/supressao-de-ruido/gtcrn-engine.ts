/**
 * GTCRN: the speech model that decides what to keep.
 *
 * The network is from the ICASSP 2024 paper *A Speech Enhancement Model
 * Requiring Ultralow Computational Resources* and is used under its MIT licence.
 * It is 48 thousand parameters — half a megabyte on disk — which is why it can
 * be served with the page instead of downloaded, and why it runs faster than
 * real time on a laptop despite scoring alongside models thirty times its size.
 *
 * ## The contract with the model
 *
 * It is the streaming export, so it sees one frame at a time and carries its
 * memory in three cache tensors that come back out with every frame and go
 * straight back in with the next. Its analysis is fixed and not ours to choose:
 * a 512-point transform, 256 samples of hop, a square-root Hann window, at
 * 16 kHz. That comes from the reference implementation and this file reproduces
 * it exactly — including the half-window of padding at the start, which is what
 * `torch.stft(center=True)` does and what the model was trained against.
 *
 * What leaves this file is not the model's audio but the ratio between the
 * magnitude it was given and the magnitude it returned: the gain field that
 * `spectral-gain` applies to the untouched recording.
 */

import type * as Ort from 'onnxruntime-web';

import { Fft } from '../../shared/media/fft';
import { AssetError, MODEL_MAGIC, RUNTIME_MAGIC, binaryVersion, explain, fetchAsset } from './runtime-assets';
import { GainField, sqrtHann } from './spectral-gain';
import { MODEL_RATE, ProcessingDevice } from './noise-suppression.models';
import { browserGpu } from './gpu-support';

let ort: typeof Ort;

const FFT_SIZE = 512;
const HOP = 256;
const BINS = FFT_SIZE / 2 + 1;

/**
 * Where the runtime's binary and the weights are served from, both from this
 * site. Nothing here is fetched from anywhere else and no server does any of
 * the work: `wasm` below is a WebAssembly file the browser runs itself.
 */
const MODEL_PATH = '/assets/models/gtcrn.onnx';

/** The `major.minor.patch` of the runtime bundled into this page. */
export function driverVersion(): string | undefined {
  return /^\d+\.\d+\.\d+/.exec(ort?.env.versions.web ?? '')?.[0];
}

/**
 * The binary's address, carrying the version that asked for it.
 *
 * Thirteen megabytes are worth keeping, so the fetch is `force-cache`: the
 * browser is told to use whatever it has stored rather than ask again. That is
 * right for a file that never changes and wrong for this one, because a new
 * release of the runtime is a different file at the same address — and a
 * browser that stored the old one during a failed attempt will keep handing it
 * back, past a corrected deployment, past a reload, until its cache is cleared
 * by hand. Putting the version in the query makes each release its own address,
 * so an upgrade is a miss rather than a stale hit.
 */
function runtimeUrl(device: ProcessingDevice): string {
  // This pinned ORT build uses the native WebGPU asyncify loader, not JSEP.
  const binary = `/assets/onnxruntime/ort-wasm-simd-threaded${device === 'webgpu' ? '.asyncify' : ''}.wasm`;
  const version = ort.env.versions.web;
  return version ? `${binary}?v=${encodeURIComponent(version)}` : binary;
}

let session: Promise<Ort.InferenceSession> | undefined;

export function loadGtcrn(device: ProcessingDevice = 'cpu'): Promise<Ort.InferenceSession> {
  // A failed load must not be remembered as a loaded model, or every retry
  // afterwards returns the same rejection without trying again.
  const started = session ?? start(device).catch((error: unknown) => {
    session = undefined;
    throw error;
  });
  session = started;
  return started;
}

async function start(device: ProcessingDevice): Promise<Ort.InferenceSession> {
  // Each worker uses one backend. Import only that backend's driver, so CPU
  // sessions neither register WebGPU nor download its larger runtime.
  ort = device === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
  if (device === 'webgpu') {
    const gpu = browserGpu();
    if (!gpu) throw new Error('WebGPU is unavailable. Use HTTPS and a compatible browser, or select CPU.');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available. Select CPU to process this recording.');
    ort.env.webgpu.adapter = adapter;
  }
  // One thread on purpose. The threaded runtime needs the page to be
  // cross-origin isolated, which this site is not, and a network this small
  // gains nothing from a second core anyway.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';

  // Both files are fetched here rather than by the runtime, for one reason:
  // when a fetch goes wrong the runtime reports it in its own terms — "no
  // available backend found", or a bad magic word — and those terms describe
  // the symptom rather than the fault. Reading them here means the page can
  // say which file did not arrive and what came instead.
  //
  // Handing over the bytes also settles the path question for good: nothing is
  // left for the runtime to resolve, so there is no prefix to get wrong and no
  // module for a dev server to rewrite on its way past.
  try {
    const runtime = await fetchAsset(
      runtimeUrl(device),
      "The speech engine's runtime",
      RUNTIME_MAGIC,
      { whole: true }
    );

    // The binary and the JavaScript driving it must come from the same release
    // of the runtime. A stale binary passes every check above — it is a whole,
    // valid WebAssembly module, and its exports match — and then fails inside
    // session creation with a message that names nothing. Saying so here is the
    // difference between a fixable fault and a mystery.
    const served = binaryVersion(runtime);
    const expected = driverVersion();
    if (served && expected && served !== expected) {
      throw new Error(
        `The speech engine's runtime is version ${served}, but the code driving it in this page is ` +
          `version ${expected}. The two are halves of one build and cannot be mixed. The binary is ` +
          `copied out of node_modules by the assets section of angular.json, and it is asked for by ` +
          `version — so what is published at ${runtimeUrl(device)} is not the file that build produced. ` +
          `A second copy under src/assets/onnxruntime overwrites it in the build output; failing that, ` +
          `what is deployed is an older build than the one this page came from.`
      );
    }

    ort.env.wasm.wasmBinary = runtime.buffer as ArrayBuffer;

    const weights = await fetchAsset(MODEL_PATH, "The speech model", MODEL_MAGIC);
    return await ort.InferenceSession.create(weights, { executionProviders: [device === 'webgpu' ? 'webgpu' : 'wasm'] });
  } catch (error) {
    if (error instanceof AssetError) {
      throw new Error(`${error.message}\n${explain(error.problem)}`);
    }

    // Our own version check has already said everything there is to say.
    if (error instanceof Error && error.message.startsWith("The speech engine's runtime is version")) {
      throw error;
    }

    // Everything else is the runtime failing on files that did arrive intact:
    // a browser without WebAssembly, or memory it could not get.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The speech engine could not start, although both of its files arrived intact. ` +
        `It runs in your browser and nothing is sent anywhere. The runtime said: ${detail}`
    );
  }
}

/** `torch.stft(center=True)` pads half a window at each end, reflected. */
function padded(samples: Float32Array): Float32Array {
  const edge = FFT_SIZE / 2;
  const out = new Float32Array(samples.length + edge * 2);
  out.set(samples, edge);
  for (let index = 0; index < edge; index++) {
    out[edge - 1 - index] = samples[Math.min(samples.length - 1, index + 1)] ?? 0;
    out[edge + samples.length + index] = samples[Math.max(0, samples.length - 2 - index)] ?? 0;
  }
  return out;
}

function zeros(shape: number[]): Ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(shape.reduce((a, b) => a * b, 1)), shape);
}

/**
 * Runs the model over a whole recording and returns what it decided.
 *
 * `onFrame` is called with a fraction so the page can move a bar; it is also
 * where cancellation is noticed, because a long recording is thousands of
 * separate inferences and stopping between two of them is instant.
 */
export async function gtcrnField(
  samples: Float32Array,
  onProgress: (ratio: number) => void,
  isCanceled: () => boolean,
  device: ProcessingDevice = 'cpu'
): Promise<GainField> {
  const model = await loadGtcrn(device);
  const window = sqrtHann(FFT_SIZE);
  const fft = new Fft(FFT_SIZE);
  const audio = padded(samples);
  const count = Math.max(0, Math.floor((audio.length - FFT_SIZE) / HOP) + 1);

  let conv = zeros([2, 1, 16, 16, 33]);
  let tra = zeros([2, 3, 1, 1, 16]);
  let inter = zeros([2, 1, 33, 16]);

  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const frames: Float32Array[] = [];

  try {
    for (let index = 0; index < count; index++) {
      if (isCanceled()) throw new DOMException('Canceled', 'AbortError');

      const at = index * HOP;
      for (let position = 0; position < FFT_SIZE; position++) {
        real[position] = audio[at + position] * window[position];
        imag[position] = 0;
      }
      fft.forward(real, imag);

      const mix = new Float32Array(BINS * 2);
      for (let bin = 0; bin < BINS; bin++) {
        mix[bin * 2] = real[bin];
        mix[bin * 2 + 1] = imag[bin];
      }

      const input = new ort.Tensor('float32', mix, [1, BINS, 1, 2]);
      let result: Ort.InferenceSession.ReturnType;
      try {
        result = await model.run({
          mix: input,
          conv_cache: conv,
          tra_cache: tra,
          inter_cache: inter
        });
      } finally {
        input.dispose();
      }

      conv.dispose();
      tra.dispose();
      inter.dispose();
      conv = result['conv_cache_out'];
      tra = result['tra_cache_out'];
      inter = result['inter_cache_out'];

      const enhanced = result['enh'].data as Float32Array;
      const gains = new Float32Array(BINS);
      for (let bin = 0; bin < BINS; bin++) {
        const before = Math.hypot(mix[bin * 2], mix[bin * 2 + 1]);
        gains[bin] = before > 1e-9
          ? Math.min(1, Math.hypot(enhanced[bin * 2], enhanced[bin * 2 + 1]) / before)
          : 1;
      }
      frames.push(gains);
      result['enh'].dispose();

      if ((index & 31) === 0) onProgress(count > 0 ? index / count : 0);
    }

    onProgress(1);

    // The first frame is centred on sample zero because of the padding, so the
    // field starts at time zero and advances one hop at a time.
    return { frames, step: HOP / MODEL_RATE, bandwidth: MODEL_RATE / FFT_SIZE };
  } finally {
    conv.dispose();
    tra.dispose();
    inter.dispose();
  }
}
