import { suppress, SuppressionCanceled } from './noise-suppression-client';
import { EngineId } from './noise-suppression.models';
import { browserGpu } from './gpu-support';

describe('real local denoising workers', () => {
  it('runs GTCRN with WebGPU and returns finite, aligned audio', async () => {
    const adapter = await browserGpu()?.requestAdapter();
    if (!adapter) {
      const required = (window as unknown as { __karma__?: { config: { args: string[] } } }).__karma__?.config.args.includes('require-webgpu');
      if (required) fail('The WebGPU verification launcher did not provide an adapter.');
      else pending('This browser has no WebGPU adapter.');
      return;
    }
    const input = Float32Array.from({ length: 8000 }, (_, i) => 0.1 * Math.sin(i * 0.2));
    const original = input.slice();
    const result = await suppress({ channels: [input], rate: 16000, engine: 'gtcrn', device: 'webgpu', attenuationDb: 24 },
      () => {}, new AbortController().signal);
    expect(result.channels[0].length).toBe(8000);
    expect(result.channels[0].every(Number.isFinite)).toBeTrue();
    expect(result.field?.frames.length).toBeGreaterThan(0);
    const cpu = await suppress({ channels: [original], rate: 16000, engine: 'gtcrn', device: 'cpu', attenuationDb: 24 },
      () => {}, new AbortController().signal);
    const error = Math.sqrt(result.channels[0].reduce((sum, sample, i) => sum + (sample - cpu.channels[0][i]) ** 2, 0) / 8000);
    expect(error).toBeLessThan(0.001);
  }, 90000);

  for (const engine of ['gtcrn', 'rnnoise'] as EngineId[]) {
    it(`${engine} runs locally, returns finite gains, and reuses its analysis`, async () => {
      let seed = 42;
      const input = Float32Array.from({ length: 48000 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (seed / 0xffffffff - 0.5) * 0.1;
      });
      const result = await suppress({ channels: [input.slice()], rate: 48000, engine, attenuationDb: 24 }, () => {}, new AbortController().signal);
      expect(result.channels[0].length).toBe(input.length);
      expect(result.channels[0].every(Number.isFinite)).toBeTrue();
      expect(result.reduction).toBeLessThan(-3);
      expect(result.field!.frames.length).toBeGreaterThan(0);
      const again = await suppress({ channels: [input.slice()], rate: 48000, engine, attenuationDb: 24,
        cachedField: result.field }, () => {}, new AbortController().signal);
      expect(result.field!.frames[0].byteLength).toBe(0);
      expect(again.channels[0]).toEqual(result.channels[0]);
    }, 60000);
  }
  it('terminates an in-flight job immediately', async () => {
    const controller = new AbortController();
    const job = suppress({ channels: [new Float32Array(48000)], rate: 48000, engine: 'gtcrn', attenuationDb: 24 }, () => {}, controller.signal);
    controller.abort();
    await expectAsync(job).toBeRejectedWith(jasmine.any(SuppressionCanceled));
  });
});
