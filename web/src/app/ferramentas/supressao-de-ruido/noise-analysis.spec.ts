import { DEFAULT_ANALYSIS_SETTINGS, NoiseReport, QualityWindow, calibrateQuality, qualityStarts,
  summarizeNoise, validateAnalysis } from './noise-analysis';
import { analyseNoise } from './noise-analysis-client';
import { SuppressionCanceled } from './noise-suppression-client';

describe('background diagnosis', () => {
  const signal = () => Float32Array.from({ length: 160000 }, (_, i) => (i < 80000 ? 0.1 : 0.0001) * Math.sin(i));
  const probabilities = () => Float32Array.from({ length: 313 }, (_, i) => i < 145 ? 0.99 : 0.01);
  const window = (background: number): QualityWindow => ({ start: 0, end: 10, speech: 4, background, overall: 4 });
  it('ships speech and balanced sensitivity defaults without requiring references', () => {
    expect(DEFAULT_ANALYSIS_SETTINGS).toEqual({ content: 'speech', sensitivity: 'balanced', background: null, cleanVoice: null });
  });
  it('uses model scores to distinguish low, probable and relevant background', () => {
    const expected: [number, NoiseReport['status']][] = [[4.5, 'Low background'], [3, 'Probable noise'], [2, 'Relevant noise']];
    for (const [score, status] of expected) {
      const result = summarizeNoise(signal(), probabilities(), [window(score)], DEFAULT_ANALYSIS_SETTINGS);
      expect(result.status).toBe(status);
    }
  });
  it('does not call a recording clean when no voice was detected', () => {
    const report = summarizeNoise(new Float32Array(160000), new Float32Array(313), [window(4.5)], DEFAULT_ANALYSIS_SETTINGS);
    expect(report.status).toBe('Inconclusive');
    expect(report.quality).toBeNull();
  });
  it('treats music and contaminated background references as inconclusive', () => {
    for (const settings of [{ ...DEFAULT_ANALYSIS_SETTINGS, content: 'speech-music' as const },
      { ...DEFAULT_ANALYSIS_SETTINGS, background: { start: 1, end: 2 } }]) {
      expect(summarizeNoise(signal(), probabilities(), [window(2)], settings).status).toBe('Inconclusive');
    }
  });
  it('uses the selected noise reference instead of inventing pauses', () => {
    const settings = { ...DEFAULT_ANALYSIS_SETTINGS, background: { start: 7, end: 9 } };
    const report = summarizeNoise(signal(), probabilities(), [window(4.5)], settings);
    expect(report.backgroundDb!).toBeCloseTo(-83.01, 1);
  });
  it('rejects out-of-bounds, empty and overlapping references', () => {
    for (const range of [{ start: -1, end: 2 }, { start: 9, end: 11 }, { start: 0, end: 0 }, { start: NaN, end: 2 }]) {
      expect(() => validateAnalysis({ ...DEFAULT_ANALYSIS_SETTINGS, background: range }, 10)).toThrow();
    }
    expect(() => validateAnalysis({ ...DEFAULT_ANALYSIS_SETTINGS, background: { start: 1, end: 3 }, cleanVoice: { start: 2, end: 4 } }, 10)).toThrow();
  });
  it('changes sensitivity without interpreting quality scores as probabilities', () => {
    expect(summarizeNoise(signal(), probabilities(), [window(3.6)], DEFAULT_ANALYSIS_SETTINGS).status).toBe('Low background');
    expect(summarizeNoise(signal(), probabilities(), [window(3.6)], { ...DEFAULT_ANALYSIS_SETTINGS, sensitivity: 'high' }).status).toBe('Probable noise');
  });
  it('covers the final audio and calibrates quality in the expected direction', () => {
    const starts = qualityStarts(160000);
    expect(starts).toEqual([0, 15840]);
    expect(qualityStarts(1000)).toEqual([0]);
    expect(calibrateQuality([4, 4, 4]).background).toBeGreaterThan(calibrateQuality([2, 2, 2]).background);
    expect(() => calibrateQuality([NaN, 3, 3])).toThrow();
  });
});

describe('local analysis worker', () => {
  it('loads both real models and handles a recording without speech', async () => {
    const report = await analyseNoise([new Float32Array(48000)], 16000, DEFAULT_ANALYSIS_SETTINGS, () => {}, new AbortController().signal);
    expect(report.status).toBe('Inconclusive');
    expect(report.seconds).toBe(3);
    expect(report.speechSeconds).toBeLessThan(0.5);
  }, 90000);
  it('terminates an in-flight analysis', async () => {
    const controller = new AbortController();
    const job = analyseNoise([new Float32Array(48000)], 16000, DEFAULT_ANALYSIS_SETTINGS, () => {}, controller.signal);
    controller.abort();
    await expectAsync(job).toBeRejectedWith(jasmine.any(SuppressionCanceled));
  });
});
