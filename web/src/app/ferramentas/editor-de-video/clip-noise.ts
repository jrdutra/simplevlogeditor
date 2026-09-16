import type { AnalysisSettings } from '../supressao-de-ruido/noise-analysis';
import type { EngineId } from '../supressao-de-ruido/noise-suppression.models';

/** Stable ids used in projects and by MCP; the suppressor itself consumes dB. */
export type NoiseStrengthId = 'gentle' | 'balanced' | 'maximum';

/** Noise removal is deliberately a per-media-clip decision, never a project default. */
export interface ClipNoiseSettings {
  enabled: boolean;
  engine: EngineId;
  strength: NoiseStrengthId;
  /** Keep frequencies above the speech model's reach exactly as recorded. */
  preserveHighs: boolean;
}

export const DEFAULT_CLIP_NOISE: Readonly<ClipNoiseSettings> = {
  enabled: false,
  engine: 'gtcrn',
  strength: 'balanced',
  preserveHighs: false
};

export const NOISE_STRENGTH_INDEX: Record<NoiseStrengthId, number> = {
  gentle: 0,
  balanced: 1,
  maximum: 2
};

export const DEFAULT_CLIP_NOISE_ANALYSIS: Readonly<AnalysisSettings> = {
  content: 'speech',
  sensitivity: 'balanced',
  background: null,
  cleanVoice: null
};

export function clampClipNoise(value: Partial<ClipNoiseSettings> | null | undefined): ClipNoiseSettings {
  return {
    enabled: value?.enabled === true,
    engine: value?.engine === 'rnnoise' ? 'rnnoise' : 'gtcrn',
    strength: value?.strength === 'gentle' || value?.strength === 'maximum' ? value.strength : 'balanced',
    preserveHighs: value?.preserveHighs === true
  };
}

export function sameClipNoise(a: ClipNoiseSettings | null | undefined, b: ClipNoiseSettings | null | undefined): boolean {
  const left = clampClipNoise(a);
  const right = clampClipNoise(b);
  return left.enabled === right.enabled && left.engine === right.engine && left.strength === right.strength &&
    left.preserveHighs === right.preserveHighs;
}

/** Returns the derived audio only while it still matches an enabled setting. */
export function activeNoiseAudio(clip: {
  noiseSuppression?: ClipNoiseSettings;
  noiseCleanedWith?: ClipNoiseSettings | null;
  noiseCleanedAudio?: File | null;
}): File | null {
  return clip.noiseSuppression?.enabled && clip.noiseCleanedAudio &&
    sameClipNoise(clip.noiseSuppression, clip.noiseCleanedWith)
    ? clip.noiseCleanedAudio
    : null;
}
