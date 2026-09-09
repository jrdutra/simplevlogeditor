import * as ort from 'onnxruntime-web/wasm';
import { fetchAsset, MODEL_MAGIC, RUNTIME_MAGIC } from './runtime-assets';
import { AnalysisSettings, ANALYSIS_RATE, VAD_FRAME, QUALITY_SAMPLES, QualityWindow, NoiseReport,
  calibrateQuality, qualityStarts, summarizeNoise, validateAnalysis } from './noise-analysis';

/** Independent CPU worker: diagnostic models never modify the original audio. */
export async function analyseSamples(samples: Float32Array, settings: AnalysisSettings,
  progress: (ratio: number, detail: string) => void): Promise<NoiseReport> {
  validateAnalysis(settings, samples.length / ANALYSIS_RATE);
  if (!samples.length || samples.some(value => !Number.isFinite(value))) throw new Error('Audio contains invalid samples.');
  progress(0, 'Loading speech and quality models');
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  const version = encodeURIComponent(ort.env.versions.web ?? '');
  const runtime = await fetchAsset(`/assets/onnxruntime/ort-wasm-simd-threaded.wasm?v=${version}`, 'Analysis runtime', RUNTIME_MAGIC, { whole: true });
  ort.env.wasm.wasmBinary = runtime.buffer as ArrayBuffer;
  let vad: ort.InferenceSession | undefined;
  let quality: ort.InferenceSession | undefined;
  try {
    const vadBytes = await fetchAsset('/assets/models/noise-analysis/silero-vad.onnx', 'Speech detection model', MODEL_MAGIC);
    vad = await ort.InferenceSession.create(vadBytes, { executionProviders: ['wasm'] });
    const probabilities = new Float32Array(Math.ceil(samples.length / VAD_FRAME));
    const input = new Float32Array(VAD_FRAME + 64);
    let state: ort.Tensor = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
    const rate = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
    try {
      for (let frame = 0; frame < probabilities.length; frame++) {
        input.fill(0, 64);
        input.set(samples.subarray(frame * VAD_FRAME, (frame + 1) * VAD_FRAME), 64);
        const tensor = new ort.Tensor('float32', input, [1, input.length]);
        try {
          const output = await vad.run({ input: tensor, state, sr: rate });
          state.dispose();
          state = output['stateN'];
          probabilities[frame] = Number(output['output'].data[0]);
          output['output'].dispose();
        } finally { tensor.dispose(); }
        input.copyWithin(0, VAD_FRAME); // Last 64 samples become next context.
        if (frame % 32 === 0) progress(0.1 + 0.45 * frame / probabilities.length, 'Finding speech and pauses');
      }
    } finally { state.dispose(); rate.dispose(); }
    await vad.release(); vad = undefined;
    const qualityBytes = await fetchAsset('/assets/models/noise-analysis/dnsmos-p835.onnx', 'Perceptual quality model', MODEL_MAGIC);
    quality = await ort.InferenceSession.create(qualityBytes, { executionProviders: ['wasm'] });
    const starts = qualityStarts(samples.length);
    const windows: QualityWindow[] = [];
    const buffer = new Float32Array(QUALITY_SAMPLES);
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index];
      // Reference DNSMOS repeats clips shorter than its fixed 9.01 s window.
      for (let i = 0; i < buffer.length; i++) buffer[i] = samples[(start + i) % samples.length];
      const tensor = new ort.Tensor('float32', buffer, [1, QUALITY_SAMPLES]);
      let outputs: ort.InferenceSession.ReturnType | undefined;
      try {
        outputs = await quality.run({ input_1: tensor });
        const values = outputs[quality.outputNames[0]].data as Float32Array;
        windows.push({ start: start / ANALYSIS_RATE, end: Math.min(samples.length, start + QUALITY_SAMPLES) / ANALYSIS_RATE,
          ...calibrateQuality(values) });
      } finally { tensor.dispose(); if (outputs) Object.values(outputs).forEach(value => value.dispose()); }
      progress(0.55 + 0.44 * (index + 1) / starts.length, 'Measuring background and speech quality');
    }
    return summarizeNoise(samples, probabilities, windows, settings);
  } finally { await vad?.release(); await quality?.release(); }
}
