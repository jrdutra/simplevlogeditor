import { activeNoiseAudio, clampClipNoise, sameClipNoise } from './clip-noise';

describe('per-clip noise suppression', () => {
  it('clamps untrusted settings to stable MCP and project values', () => {
    expect(clampClipNoise({ enabled: true, engine: 'rnnoise', strength: 'maximum', preserveHighs: true })).toEqual({
      enabled: true, engine: 'rnnoise', strength: 'maximum', preserveHighs: true
    });
    expect(clampClipNoise({ engine: 'invalid', strength: 'invalid' } as never)).toEqual({
      enabled: false, engine: 'gtcrn', strength: 'balanced', preserveHighs: false
    });
  });

  it('uses preview audio only while enabled and produced by the current settings', () => {
    const cleaned = new File(['cleaned'], 'cleaned.wav');
    const settings = { enabled: true, engine: 'gtcrn' as const, strength: 'balanced' as const, preserveHighs: false };

    expect(activeNoiseAudio({ noiseSuppression: settings, noiseCleanedWith: settings, noiseCleanedAudio: cleaned })).toBe(cleaned);
    expect(activeNoiseAudio({
      noiseSuppression: { ...settings, enabled: false }, noiseCleanedWith: settings, noiseCleanedAudio: cleaned
    })).toBeNull();
    expect(activeNoiseAudio({
      noiseSuppression: { ...settings, strength: 'maximum' }, noiseCleanedWith: settings, noiseCleanedAudio: cleaned
    })).toBeNull();
    expect(sameClipNoise(settings, { ...settings })).toBeTrue();
  });
});
