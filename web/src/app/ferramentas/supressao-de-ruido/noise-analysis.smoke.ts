/** Optional public speech fixture; excluded from the offline unit suite. */
import { analyseNoise } from './noise-analysis-client';
import { DEFAULT_ANALYSIS_SETTINGS } from './noise-analysis';
import { readAudio } from './media-audio';

describe('noise diagnosis on public speech', () => {
  it('detects voice and gives a worse background score after adding reproducible noise', async () => {
    const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
    if (!response.ok) throw new Error('Could not load the public speech fixture.');
    const decoded = await readAudio(new File([await response.blob()], 'speech.wav'), () => {}, new AbortController().signal);
    const original = decoded.channels[0];
    let seed = 2026;
    const random = Float32Array.from(original, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff - 0.5;
    });
    const energy = (input: Float32Array) => input.reduce((sum, value) => sum + value * value, 0);
    const gain = Math.sqrt(energy(original) / energy(random));
    const noisy = Float32Array.from(original, (sample, i) => sample + gain * random[i]);
    const before = await analyseNoise([original.slice()], decoded.rate, DEFAULT_ANALYSIS_SETTINGS, () => {}, new AbortController().signal);
    const after = await analyseNoise([noisy], decoded.rate, DEFAULT_ANALYSIS_SETTINGS, () => {}, new AbortController().signal);
    console.info('Noise diagnosis fixture', JSON.stringify({ original: before, noisy: after }));
    expect(before.speechSeconds).toBeGreaterThan(1);
    expect(after.speechSeconds).toBeGreaterThan(1);
    expect(before.quality).not.toBeNull();
    expect(after.quality).not.toBeNull();
    expect(after.quality!.background).toBeLessThan(before.quality!.background - 0.3);
    expect(after.intervals.length).toBeGreaterThan(0);
    expect(['Probable noise', 'Relevant noise']).toContain(after.status);
  }, 120000);
});
