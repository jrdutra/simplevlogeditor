/**
 * The Jitsi RNNoise build ships no types.
 *
 * Only the shape this tool uses is described, and deliberately no more: the
 * Emscripten module exposes a hundred internal symbols, and naming the four
 * that matter here documents the contract instead of copying a header.
 */
declare module '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' {
  interface RnnoiseWasmModule {
    _rnnoise_create(model?: number): number;
    _rnnoise_destroy(state: number): void;
    /** Returns the speech probability for the frame it just filtered. */
    _rnnoise_process_frame(state: number, output: number, input: number): number;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
    HEAPF32: Float32Array;
  }

  const createRnnoiseModule: () => Promise<RnnoiseWasmModule>;
  export default createRnnoiseModule;
}

/**
 * The wasm-only entry point of the ONNX runtime.
 *
 * Importing `onnxruntime-web/wasm` rather than the package root leaves the
 * WebGL and WebGPU backends out of the bundle, which are useless to a network
 * this small. TypeScript is configured for Node 10 module resolution and so
 * does not read the package's `exports` map; the types are the same either way,
 * so they are borrowed from the root here.
 */
declare module 'onnxruntime-web/wasm' {
  export * from 'onnxruntime-web';
}

declare module 'onnxruntime-web/webgpu' {
  export * from 'onnxruntime-web';
}
