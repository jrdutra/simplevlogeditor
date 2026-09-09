import type { env } from 'onnxruntime-web';

/** Older DOM libraries omit WebGPU; use the adapter contract supplied by ORT. */
export function browserGpu(): {
  requestAdapter(): Promise<NonNullable<typeof env.webgpu.adapter> | null>;
} | undefined {
  return typeof navigator === 'undefined' ? undefined
    : (navigator as unknown as { gpu?: ReturnType<typeof browserGpu> }).gpu;
}
