/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import { fetchAsset, MODEL_MAGIC, RUNTIME_MAGIC } from '../supressao-de-ruido/runtime-assets';
import { decodePlateBoxes, PLATE_MODEL } from './license-plate-detection';

let session: Promise<ort.InferenceSession> | null = null;
async function detector(): Promise<ort.InferenceSession> {
  return session ??= (async () => {
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    const wasm = await fetchAsset('/assets/onnxruntime/ort-wasm-simd-threaded.wasm', 'Plate detection runtime', RUNTIME_MAGIC, { whole: true });
    ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
    const model = await fetchAsset(PLATE_MODEL.url, 'License plate detector', MODEL_MAGIC);
    const digest = await crypto.subtle.digest('SHA-256', model.buffer as ArrayBuffer);
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== PLATE_MODEL.sha256) throw new Error('The bundled license plate model is corrupt or has changed.');
    return ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })();
}

addEventListener('message', async ({ data }: MessageEvent<{
  id: number; pixels: Uint8ClampedArray; width: number; height: number
}>) => {
  let input: ort.Tensor | null = null;
  let result: ort.InferenceSession.ReturnType | null = null;
  try {
    const size = PLATE_MODEL.size, area = size * size;
    if (data.pixels.length !== area * 4) throw new Error('Invalid license plate input.');
    const values = new Float32Array(area * 3);
    for (let i = 0; i < area; i++) {
      values[i] = data.pixels[i * 4];
      values[area + i] = data.pixels[i * 4 + 1];
      values[area * 2 + i] = data.pixels[i * 4 + 2];
    }
    const model = await detector();
    input = new ort.Tensor('float32', values, [1, 3, size, size]);
    result = await model.run({ [model.inputNames[0]]: input });
    const output = result[model.outputNames[0]];
    const boxes = decodePlateBoxes(output.data as Float32Array, output.dims, data.width, data.height);
    postMessage({ id: data.id, boxes });
  } catch (error) {
    postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    input?.dispose();
    if (result) Object.values(result).forEach(tensor => tensor.dispose());
  }
});
