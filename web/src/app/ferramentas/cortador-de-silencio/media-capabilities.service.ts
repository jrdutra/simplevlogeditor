import { Injectable } from '@angular/core';

import { describeError, silenceLog } from './silence-cutter-log';

/**
 * What this browser can actually do, measured rather than assumed.
 *
 * Every flag here is the result of calling the API, not of checking that a
 * global exists: `'gpu' in navigator` is true in browsers that then refuse to
 * hand out an adapter, and `VideoEncoder` exists long before any particular
 * codec configuration is supported. Guessing would send a reader down a
 * pipeline that fails halfway through a two-hour file.
 */
export interface BrowserCapabilities {
  secureContext: boolean;
  webWorkers: boolean;

  webCodecs: boolean;
  videoDecoder: boolean;
  videoEncoder: boolean;
  audioDecoder: boolean;
  audioEncoder: boolean;

  webGpu: boolean;
  webGpuAdapterAvailable: boolean;

  fileSystemAccess: boolean;
  opfs: boolean;

  wasm: boolean;
  wasmSimd: boolean;
  sharedArrayBuffer: boolean;
}

/** One codec configuration to probe, as passed to `VideoEncoder.isConfigSupported`. */
export interface VideoCodecProbe {
  codec: string;
  width: number;
  height: number;
  framerate?: number;
  bitrate?: number;
}

export interface CodecSupport {
  supported: boolean;
  /** True when the configuration that was accepted asked for hardware. */
  hardwarePreferred: boolean;
}

/**
 * Minimal shape of the pieces of WebGPU this tool touches.
 *
 * `@webgpu/types` is not a dependency of the project and pulling in a whole
 * type package for four calls would be a poor trade; these declarations cover
 * exactly what the analyser uses and nothing else.
 */
export interface MinimalGpuDevice {
  destroy(): void;
  readonly limits: Record<string, number>;
  createShaderModule(descriptor: { code: string }): unknown;
  createBuffer(descriptor: { size: number; usage: number; mappedAtCreation?: boolean }): MinimalGpuBuffer;
  createBindGroup(descriptor: unknown): unknown;
  createBindGroupLayout(descriptor: unknown): unknown;
  createPipelineLayout(descriptor: unknown): unknown;
  createComputePipeline(descriptor: unknown): MinimalGpuComputePipeline;
  createCommandEncoder(): MinimalGpuCommandEncoder;
  readonly queue: {
    writeBuffer(buffer: MinimalGpuBuffer, offset: number, data: BufferSource): void;
    submit(buffers: unknown[]): void;
  };
  addEventListener?(type: 'uncapturederror', listener: () => void): void;
}

export interface MinimalGpuBuffer {
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}

export interface MinimalGpuComputePipeline {
  getBindGroupLayout(index: number): unknown;
}

export interface MinimalGpuCommandEncoder {
  beginComputePass(): {
    setPipeline(pipeline: MinimalGpuComputePipeline): void;
    setBindGroup(index: number, group: unknown): void;
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
  };
  copyBufferToBuffer(
    source: MinimalGpuBuffer,
    sourceOffset: number,
    destination: MinimalGpuBuffer,
    destinationOffset: number,
    size: number
  ): void;
  finish(): unknown;
}

interface MinimalGpuAdapter {
  requestDevice(descriptor?: unknown): Promise<MinimalGpuDevice>;
}

interface MinimalGpu {
  requestAdapter(): Promise<MinimalGpuAdapter | null>;
}

/** Narrow view of the globals we probe, so nothing needs `any`. */
interface MediaGlobals {
  navigator?: { gpu?: MinimalGpu; storage?: { getDirectory?: unknown } };
  showSaveFilePicker?: unknown;
  VideoEncoder?: { isConfigSupported?: (config: unknown) => Promise<{ supported?: boolean }> };
  VideoDecoder?: { isConfigSupported?: (config: unknown) => Promise<{ supported?: boolean }> };
  AudioEncoder?: unknown;
  AudioDecoder?: unknown;
  WebAssembly?: { validate?: (bytes: BufferSource) => boolean };
  SharedArrayBuffer?: unknown;
  Worker?: unknown;
  isSecureContext?: boolean;
}

/**
 * The four bytes that turn a bare WebAssembly module into one that uses a SIMD
 * instruction. `WebAssembly.validate` rejects it where SIMD is unavailable,
 * which is the only reliable way to detect the feature.
 */
const WASM_SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x26, 0x0b
]);

@Injectable({ providedIn: 'root' })
export class MediaCapabilitiesService {
  private capabilities?: Promise<BrowserCapabilities>;

  /**
   * Codec probes are cached by their full configuration.
   *
   * `isConfigSupported` is not free — it can spin up a real encoder — and the
   * answer for one codec at one resolution never changes during a session.
   */
  private readonly codecCache = new Map<string, Promise<CodecSupport>>();

  /** Detects everything once and reuses the answer for the rest of the session. */
  detect(): Promise<BrowserCapabilities> {
    this.capabilities ??= this.probe();
    return this.capabilities;
  }

  private async probe(): Promise<BrowserCapabilities> {
    const empty: BrowserCapabilities = {
      secureContext: false,
      webWorkers: false,
      webCodecs: false,
      videoDecoder: false,
      videoEncoder: false,
      audioDecoder: false,
      audioEncoder: false,
      webGpu: false,
      webGpuAdapterAvailable: false,
      fileSystemAccess: false,
      opfs: false,
      wasm: false,
      wasmSimd: false,
      sharedArrayBuffer: false
    };

    if (typeof window === 'undefined') return empty;

    const globals = globalThis as unknown as MediaGlobals;
    const videoDecoder = typeof globals.VideoDecoder !== 'undefined';
    const videoEncoder = typeof globals.VideoEncoder !== 'undefined';
    const audioDecoder = typeof globals.AudioDecoder !== 'undefined';
    const audioEncoder = typeof globals.AudioEncoder !== 'undefined';

    const capabilities: BrowserCapabilities = {
      secureContext: globals.isSecureContext === true,
      webWorkers: typeof globals.Worker !== 'undefined',
      webCodecs: videoDecoder || audioDecoder,
      videoDecoder,
      videoEncoder,
      audioDecoder,
      audioEncoder,
      webGpu: typeof globals.navigator?.gpu !== 'undefined',
      webGpuAdapterAvailable: await this.probeWebGpu(),
      fileSystemAccess: typeof globals.showSaveFilePicker === 'function',
      opfs: typeof globals.navigator?.storage?.getDirectory === 'function',
      wasm: typeof globals.WebAssembly?.validate === 'function',
      wasmSimd: this.probeWasmSimd(globals),
      sharedArrayBuffer: typeof globals.SharedArrayBuffer !== 'undefined'
    };

    silenceLog.info('capabilities', 'detected', capabilities);
    return capabilities;
  }

  /**
   * A usable adapter, not merely the presence of `navigator.gpu`.
   *
   * The device is created and immediately destroyed: creation is where a driver
   * that cannot serve this page actually fails, and holding it open would keep
   * the GPU awake for a capability check.
   */
  private async probeWebGpu(): Promise<boolean> {
    const gpu = (globalThis as unknown as MediaGlobals).navigator?.gpu;
    if (!gpu) return false;

    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        silenceLog.warn('capabilities', 'navigator.gpu exists but returned no adapter');
        return false;
      }
      const device = await adapter.requestDevice();
      device.destroy();
      return true;
    } catch (error) {
      silenceLog.warn('capabilities', 'requesting a GPU device failed', describeError(error));
      return false;
    }
  }

  private probeWasmSimd(globals: MediaGlobals): boolean {
    try {
      return globals.WebAssembly?.validate?.(WASM_SIMD_PROBE) === true;
    } catch {
      return false;
    }
  }

  /** Opens a WebGPU device for real work. The caller owns it and must destroy it. */
  async requestGpuDevice(): Promise<MinimalGpuDevice | null> {
    const gpu = (globalThis as unknown as MediaGlobals).navigator?.gpu;
    if (!gpu) return null;

    try {
      // No `powerPreference`: several platforms ignore it and log a warning for
      // every call, and the adapter they hand back is the right one anyway.
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      return await adapter.requestDevice();
    } catch (error) {
      silenceLog.warn('capabilities', 'could not open a GPU device', describeError(error));
      return null;
    }
  }

  /**
   * Runs an accelerated-first support check once per key.
   *
   * The check is handed the acceleration hint to try; it is called with
   * `prefer-hardware` first, and only with `no-preference` if that is refused.
   * Callers that know how to build a valid configuration — Mediabunny does,
   * for encoding — pass their own probe instead of a raw codec string.
   */
  probeAccelerated(
    key: string,
    check: (acceleration: 'prefer-hardware' | 'no-preference') => Promise<boolean>
  ): Promise<CodecSupport> {
    const cached = this.codecCache.get(key);
    if (cached) return cached;

    const pending = (async () => {
      for (const acceleration of ['prefer-hardware', 'no-preference'] as const) {
        try {
          if (await check(acceleration)) {
            silenceLog.info('capabilities', 'probe accepted', { key, acceleration });
            return { supported: true, hardwarePreferred: acceleration === 'prefer-hardware' };
          }
          silenceLog.info('capabilities', 'probe refused', { key, acceleration });
        } catch (error) {
          silenceLog.warn('capabilities', 'probe threw', { key, acceleration, ...describeError(error) });
        }
      }
      return { supported: false, hardwarePreferred: false };
    })();

    this.codecCache.set(key, pending);
    return pending;
  }

  /**
   * Asks the decoder whether it can handle a track, hardware first.
   *
   * `probe.codec` must be a full WebCodecs codec string such as `avc1.640028`,
   * taken from the track itself — a family name like `avc` is rejected by
   * `isConfigSupported`, which would report every machine as unable to decode
   * its own file.
   *
   * A positive hardware answer is a *preference the browser accepted*, never
   * proof that a particular GPU or media block will run it, which is why the
   * flag is named for the preference and the interface wording follows suit.
   */
  probeVideoDecode(probe: VideoCodecProbe): Promise<CodecSupport> {
    return this.probeAccelerated(
      `decode|${probe.codec}|${probe.width}x${probe.height}`,
      async (acceleration) => {
        const api = (globalThis as unknown as MediaGlobals).VideoDecoder;
        if (typeof api?.isConfigSupported !== 'function') return false;

        const result = await api.isConfigSupported({
          codec: probe.codec,
          codedWidth: probe.width,
          codedHeight: probe.height,
          hardwareAcceleration: acceleration
        });
        return result?.supported === true;
      }
    );
  }
}
