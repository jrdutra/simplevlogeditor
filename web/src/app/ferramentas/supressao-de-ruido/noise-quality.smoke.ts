/** Optional network fixture: public speech from the Transformers.js docs. */
import { readAudio } from './media-audio';
import { suppress } from './noise-suppression-client';
import { toMono } from './resample';
import { EngineId } from './noise-suppression.models';

function energy(samples: Float32Array): number { return samples.reduce((sum, sample) => sum + sample ** 2, 0); }
function siSdr(reference: Float32Array, estimate: Float32Array): number {
  const mean = (samples: Float32Array) => samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const a = mean(reference), b = mean(estimate);
  let cross = 0, power = 0;
  for (let i = 0; i < reference.length; i++) { cross += (reference[i] - a) * (estimate[i] - b); power += (reference[i] - a) ** 2; }
  const scale = cross / Math.max(1e-20, power);
  let error = 0;
  for (let i = 0; i < reference.length; i++) error += (estimate[i] - b - scale * (reference[i] - a)) ** 2;
  return 10 * Math.log10((scale ** 2 * power + 1e-20) / (error + 1e-20));
}

describe('speech with a reproducible 0 dB white-noise mixture', () => {
  for (const engine of ['gtcrn', 'rnnoise'] as EngineId[]) it(`${engine} improves SI-SDR on the public fixture`, async () => {
    const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
    if (!response.ok) throw new Error('Public fixture could not be downloaded.');
    const decoded = await readAudio(new File([await response.blob()], 'jfk.wav'), () => {}, new AbortController().signal);
    const reference = toMono(decoded.channels);
    let seed = 2026;
    const noise = Float32Array.from(reference, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff - 0.5;
    });
    const noiseScale = Math.sqrt(energy(reference) / energy(noise));
    const noisy = Float32Array.from(reference, (sample, i) => sample + noise[i] * noiseScale);
    const baseline = siSdr(reference, noisy);
    const started = performance.now();
    const result = await suppress({ channels: [noisy.slice()], rate: decoded.rate, engine, attenuationDb: 24 }, () => {}, new AbortController().signal);
    const score = siSdr(reference, result.channels[0]);
    console.info('Speech benchmark', JSON.stringify({ engine, duration: decoded.seconds, seconds: (performance.now() - started) / 1000,
      beforeSiSdr: baseline, afterSiSdr: score, improvement: score - baseline }));
    expect(score - baseline).toBeGreaterThan(2);
    expect(result.channels[0].length).toBe(reference.length);
  }, 90000);
});
