/// <reference lib="webworker" />

import { pipeline } from '@huggingface/transformers';
import { SubjectSegmentationRequest, SubjectSegmentationResponse } from './subject-segmentation-protocol';

type BackgroundRemover = (canvas: OffscreenCanvas) => Promise<{
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
}>;

let removerTask: Promise<BackgroundRemover> | null = null;
let queue = Promise.resolve();

function send(message: SubjectSegmentationResponse, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}

async function remover(): Promise<BackgroundRemover> {
  if (!removerTask) {
    removerTask = (async () => {
      const hasWebGpu = Boolean((navigator as unknown as { gpu?: unknown }).gpu);
      try {
        return await pipeline('background-removal', 'Xenova/modnet', {
          device: hasWebGpu ? 'webgpu' : 'wasm',
          dtype: hasWebGpu ? 'fp16' : 'q8'
        }) as unknown as BackgroundRemover;
      } catch (error) {
        if (!hasWebGpu) throw error;
        return await pipeline('background-removal', 'Xenova/modnet', {
          device: 'wasm', dtype: 'q8'
        }) as unknown as BackgroundRemover;
      }
    })();
  }
  return removerTask;
}

async function segment(request: SubjectSegmentationRequest): Promise<void> {
  try {
    const canvas = new OffscreenCanvas(request.width, request.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OffscreenCanvas 2D is unavailable.');
    context.putImageData(new ImageData(request.pixels, request.width, request.height), 0, 0);
    const result = await (await remover())(canvas);
    const alpha = new Uint8ClampedArray(result.width * result.height);
    let visible = 0;
    for (let index = 0; index < alpha.length; index++) {
      const value = result.channels === 4
        ? result.data[index * 4 + 3]
        : result.channels === 1
          ? result.data[index]
          : Math.max(result.data[index * result.channels], result.data[index * result.channels + 1] ?? 0, result.data[index * result.channels + 2] ?? 0);
      alpha[index] = value;
      if (value > 48) visible++;
    }
    const coverage = visible / Math.max(1, alpha.length);
    // A nearly empty matte means no subject; a nearly full matte usually means
    // the model treated the scene itself as foreground. Both use the safe text-
    // over-video fallback instead of hiding the whole caption.
    if (coverage < 0.005 || coverage > 0.97) {
      send({ type: 'empty', id: request.id });
      return;
    }
    send({ type: 'done', id: request.id, width: result.width, height: result.height, alpha, coverage }, [alpha.buffer]);
  } catch (error) {
    send({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

addEventListener('message', ({ data }: MessageEvent<SubjectSegmentationRequest>) => {
  // Transformers pipelines are not re-entrant. A short queue also keeps a fast
  // preview from filling memory with inference tensors.
  queue = queue.then(() => segment(data), () => segment(data));
});
