import { MinimalGpuBuffer, MinimalGpuDevice } from './media-capabilities.service';
import { WindowReduction } from './window-reducer';

/**
 * Computes per-window loudness on the GPU, one batch at a time.
 *
 * Squaring a few hundred million samples and reducing them into windows is
 * exactly the shape of work a compute shader is good at: every window is
 * independent, and the result that has to come back is tiny — three numbers per
 * window instead of the samples themselves. That asymmetry is the whole reason
 * this path can pay off, and also the reason it must never be used for short
 * media, where the upload alone costs more than the arithmetic saves.
 *
 * Nothing here is load-bearing: the reducer verifies its own first batch
 * against the same arithmetic done on the CPU, and the caller falls back to the
 * worker the moment anything is off or a GPU call throws.
 */

/**
 * Bit flags from the WebGPU specification.
 *
 * `@webgpu/types` is not a dependency, and adding a type-only package for a
 * dozen constants would cost more than it explains.
 */
const BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080
} as const;

const MAP_MODE_READ = 0x0001;
const SHADER_STAGE_COMPUTE = 0x0004;

/** Threads per workgroup. 64 is the safe, widely optimal default. */
const WORKGROUP_SIZE = 64;

/** Roughly how many bytes of samples to move per dispatch. */
const TARGET_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * One invocation reduces one window.
 *
 * Samples arrive planar — channel `c` starts at `c * frameCount` — because that
 * lets each channel's inner loop walk contiguous memory, which is as friendly
 * to the GPU's coalescing as it is to the CPU's cache.
 */
const SHADER = `
struct Params {
  samplesPerWindow: u32,
  channelCount: u32,
  windowCount: u32,
  frameCount: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> samples: array<f32>;
@group(0) @binding(2) var<storage, read_write> outRms: array<f32>;
@group(0) @binding(3) var<storage, read_write> outPeaks: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = gid.x;
  if (w >= params.windowCount) {
    return;
  }

  let start = w * params.samplesPerWindow;
  if (start >= params.frameCount) {
    return;
  }

  var end = start + params.samplesPerWindow;
  if (end > params.frameCount) {
    end = params.frameCount;
  }

  let count = f32(end - start);
  var lowest = 0.0;
  var highest = 0.0;

  for (var c: u32 = 0u; c < params.channelCount; c = c + 1u) {
    let base = c * params.frameCount;
    var sum = 0.0;
    for (var i = start; i < end; i = i + 1u) {
      let value = samples[base + i];
      sum = sum + value * value;
      if (value < lowest) { lowest = value; }
      if (value > highest) { highest = value; }
    }
    outRms[w * params.channelCount + c] = sqrt(sum / count);
  }

  outPeaks[w * 2u] = lowest;
  outPeaks[w * 2u + 1u] = highest;
}
`;

interface GpuResources {
  pipeline: ReturnType<MinimalGpuDevice['createComputePipeline']>;
  params: MinimalGpuBuffer;
  samples: MinimalGpuBuffer;
  rms: MinimalGpuBuffer;
  peaks: MinimalGpuBuffer;
  rmsRead: MinimalGpuBuffer;
  peaksRead: MinimalGpuBuffer;
  bindGroup: unknown;
  batchWindows: number;
  batchFrames: number;
}

export class GpuWindowReducer {
  private resources: GpuResources | null = null;

  /** Samples staged for the next dispatch, planar, one array per channel. */
  private staging: Float32Array[] = [];
  private stagedFrames = 0;
  private nextWindow = 0;
  private verified = false;

  private readonly rms: Float32Array;
  private readonly min: Float32Array;
  private readonly max: Float32Array;

  constructor(
    private readonly device: MinimalGpuDevice,
    private readonly channelCount: number,
    private readonly samplesPerWindow: number,
    private readonly windowCount: number
  ) {
    this.rms = new Float32Array(windowCount * channelCount);
    this.min = new Float32Array(windowCount);
    this.max = new Float32Array(windowCount);
  }

  /**
   * Allocates the pipeline and the buffers.
   *
   * Batches are sized in whole windows, so a dispatch never has to deal with a
   * window that straddles two uploads — the staging buffer below holds the
   * remainder until the next batch fills it.
   */
  async initialise(): Promise<void> {
    const framesPerBatchTarget = Math.max(
      this.samplesPerWindow,
      Math.floor(TARGET_BATCH_BYTES / (4 * Math.max(1, this.channelCount)))
    );
    const batchWindows = Math.max(1, Math.floor(framesPerBatchTarget / this.samplesPerWindow));
    const batchFrames = batchWindows * this.samplesPerWindow;

    const module = this.device.createShaderModule({ code: SHADER });

    const layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SHADER_STAGE_COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } }
      ]
    });

    const pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' }
    });

    const samplesBytes = batchFrames * this.channelCount * 4;
    const rmsBytes = batchWindows * this.channelCount * 4;
    const peakBytes = batchWindows * 2 * 4;

    const params = this.device.createBuffer({
      size: 16,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST
    });
    const samples = this.device.createBuffer({
      size: samplesBytes,
      usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST
    });
    const rms = this.device.createBuffer({
      size: rmsBytes,
      usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC
    });
    const peaks = this.device.createBuffer({
      size: peakBytes,
      usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC
    });
    const rmsRead = this.device.createBuffer({
      size: rmsBytes,
      usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST
    });
    const peaksRead = this.device.createBuffer({
      size: peakBytes,
      usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST
    });

    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: samples } },
        { binding: 2, resource: { buffer: rms } },
        { binding: 3, resource: { buffer: peaks } }
      ]
    });

    this.resources = { pipeline, params, samples, rms, peaks, rmsRead, peaksRead, bindGroup, batchWindows, batchFrames };
    this.staging = Array.from({ length: this.channelCount }, () => new Float32Array(batchFrames));
  }

  /** Stages a decoded chunk, dispatching whenever a whole batch is ready. */
  async push(channels: Float32Array[]): Promise<void> {
    const resources = this.resources;
    if (!resources) throw new Error('The GPU reducer was not initialised.');

    const frames = channels[0]?.length ?? 0;
    let offset = 0;

    while (offset < frames) {
      const room = resources.batchFrames - this.stagedFrames;
      const take = Math.min(room, frames - offset);

      for (let c = 0; c < this.channelCount; c++) {
        const source = channels[c] ?? channels[0];
        this.staging[c].set(source.subarray(offset, offset + take), this.stagedFrames);
      }

      this.stagedFrames += take;
      offset += take;

      if (this.stagedFrames === resources.batchFrames) await this.dispatch(resources, resources.batchFrames);
    }
  }

  /** Flushes whatever is still staged and returns the per-window statistics. */
  async finish(): Promise<WindowReduction> {
    const resources = this.resources;
    if (resources && this.stagedFrames > 0) await this.dispatch(resources, this.stagedFrames);
    return { rms: this.rms, min: this.min, max: this.max };
  }

  /** Releases every GPU object. Safe to call more than once. */
  destroy(): void {
    const resources = this.resources;
    if (!resources) return;
    for (const buffer of [resources.params, resources.samples, resources.rms, resources.peaks, resources.rmsRead, resources.peaksRead]) {
      try {
        buffer.destroy();
      } catch {
        /* A device lost mid-run has already released everything. */
      }
    }
    this.resources = null;
    this.staging = [];
  }

  private async dispatch(resources: GpuResources, frames: number): Promise<void> {
    const windows = Math.ceil(frames / this.samplesPerWindow);

    const params = new Uint32Array([this.samplesPerWindow, this.channelCount, windows, frames]);
    this.device.queue.writeBuffer(resources.params, 0, params);

    for (let c = 0; c < this.channelCount; c++) {
      this.device.queue.writeBuffer(resources.samples, c * frames * 4, this.staging[c].subarray(0, frames));
    }

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(resources.pipeline);
    pass.setBindGroup(0, resources.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(windows / WORKGROUP_SIZE));
    pass.end();

    const rmsBytes = windows * this.channelCount * 4;
    const peakBytes = windows * 2 * 4;
    encoder.copyBufferToBuffer(resources.rms, 0, resources.rmsRead, 0, rmsBytes);
    encoder.copyBufferToBuffer(resources.peaks, 0, resources.peaksRead, 0, peakBytes);
    this.device.queue.submit([encoder.finish()]);

    await resources.rmsRead.mapAsync(MAP_MODE_READ);
    await resources.peaksRead.mapAsync(MAP_MODE_READ);

    const rmsBatch = new Float32Array(resources.rmsRead.getMappedRange().slice(0, rmsBytes));
    const peakBatch = new Float32Array(resources.peaksRead.getMappedRange().slice(0, peakBytes));
    resources.rmsRead.unmap();
    resources.peaksRead.unmap();

    if (!this.verified) {
      this.verify(rmsBatch, frames, windows);
      this.verified = true;
    }

    for (let w = 0; w < windows && this.nextWindow + w < this.windowCount; w++) {
      const target = this.nextWindow + w;
      for (let c = 0; c < this.channelCount; c++) {
        this.rms[target * this.channelCount + c] = rmsBatch[w * this.channelCount + c];
      }
      this.min[target] = peakBatch[w * 2];
      this.max[target] = peakBatch[w * 2 + 1];
    }

    this.nextWindow += windows;
    this.stagedFrames = 0;
  }

  /**
   * Recomputes a few windows of the first batch on the CPU and compares.
   *
   * A compute shader that silently produces wrong numbers would turn into wrong
   * cuts in someone's recording, which is far worse than being slower. Checking
   * one batch costs microseconds and makes the GPU path safe to prefer.
   */
  private verify(rmsBatch: Float32Array, frames: number, windows: number): void {
    const toCheck = Math.min(4, windows);

    for (let w = 0; w < toCheck; w++) {
      const start = w * this.samplesPerWindow;
      const end = Math.min(start + this.samplesPerWindow, frames);
      if (end <= start) continue;

      for (let c = 0; c < this.channelCount; c++) {
        let sum = 0;
        for (let i = start; i < end; i++) {
          const value = this.staging[c][i];
          sum += value * value;
        }
        const expected = Math.sqrt(sum / (end - start));
        const actual = rmsBatch[w * this.channelCount + c];
        if (Math.abs(expected - actual) > 1e-3 + expected * 1e-2) {
          throw new Error('The GPU reduction did not match the reference result.');
        }
      }
    }
  }
}
