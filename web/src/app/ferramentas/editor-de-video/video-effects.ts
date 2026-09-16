/** Serializable, container-only settings. Inference results never belong here. */
export interface VideoEffect { id: string; intensity: number }
export type VisionCapability = 'subject' | 'face' | 'pose' | 'depth';
export interface VideoEffectDefinition {
  id: string;
  name: string;
  category: 'Classic' | 'Creator' | 'Creative';
  defaultIntensity: number;
  capabilities: readonly VisionCapability[];
  /** Shared shader parameters, not UI controls. */
  grade?: readonly [number, number, number, number]; // contrast, saturation, warmth, faded blacks
  bloom?: number;
  grain?: number;
  vignette?: number;
  split?: number;
  mode?: number; // 1 tape, 2 glitch, 3 neon, 4 light leak
  subject?: 'blur' | 'darken' | 'pop' | 'glow' | 'selective' | 'outline';
}
const preset = (id: string, name: string, category: VideoEffectDefinition['category'],
  parameters: Partial<VideoEffectDefinition> = {}): VideoEffectDefinition => ({
  id, name, category, defaultIntensity: 0.75, capabilities: [], ...parameters
});

export const VIDEO_EFFECTS: readonly VideoEffectDefinition[] = [
  preset('none', 'Original', 'Classic', { defaultIntensity: 0 }),
  preset('cinematic', 'Cinematic', 'Classic', { grade: [1.10, 0.91, 0.015, 0.015], vignette: 0.18 }),
  preset('dreamy', 'Dreamy', 'Classic', { grade: [0.94, 0.94, 0.035, 0.025], bloom: 0.22 }),
  preset('portrait-pop', 'Portrait Pop', 'Creator', { capabilities: ['subject'], subject: 'pop' }),
  preset('background-blur', 'Background Blur', 'Creator', { capabilities: ['subject'], subject: 'blur' }),
  preset('golden-hour', 'Golden Hour', 'Classic', { grade: [1.03, 1.06, 0.09, 0.01], bloom: 0.08 }),
  preset('film', 'Film', 'Classic', { grade: [1.05, 0.87, 0.028, 0.035], grain: 0.025, vignette: 0.12 }),
  preset('vintage', 'Vintage', 'Classic', { grade: [0.94, 0.72, 0.075, 0.055], grain: 0.035, vignette: 0.22 }),
  preset('subject-glow', 'Subject Glow', 'Creator', { capabilities: ['subject'], subject: 'glow' }),
  preset('neon', 'Neon', 'Creative', { grade: [1.13, 1.13, -0.02, 0], mode: 3, bloom: 0.16, split: 0.0012 }),
  preset('cyberpunk', 'Cyberpunk', 'Creative', { grade: [1.18, 1.16, -0.04, 0], mode: 3, bloom: 0.22, split: 0.002, vignette: 0.2 }),
  preset('vhs', 'VHS', 'Creative', { grade: [0.94, 0.82, 0.015, 0.035], mode: 1, grain: 0.05, split: 0.0028, bloom: 0.06 }),
  preset('glitch', 'Glitch', 'Creative', { mode: 2, split: 0.003, grain: 0.018 }),
  preset('selective-color', 'Selective Color', 'Creator', { capabilities: ['subject'], subject: 'selective' }),
  preset('black-white', 'Black & White', 'Classic', { grade: [1.05, 0, 0, 0] }),
  preset('cinematic-warm', 'Cinematic Warm', 'Classic', { grade: [1.10, 0.92, 0.06, 0.012], vignette: 0.17 }),
  preset('cinematic-cold', 'Cinematic Cold', 'Classic', { grade: [1.08, 0.92, -0.06, 0.012], vignette: 0.17 }),
  preset('noir', 'Noir', 'Classic', { grade: [1.30, 0, 0, 0], vignette: 0.32, grain: 0.016 }),
  preset('vibrant', 'Vibrant', 'Classic', { grade: [1.07, 1.22, 0, 0], bloom: 0.025 }),
  preset('background-darken', 'Background Darken', 'Creator', { capabilities: ['subject'], subject: 'darken' }),
  preset('rgb-split', 'RGB Split', 'Creative', { split: 0.005 }),
  preset('light-leak', 'Light Leak', 'Creative', { mode: 4, grade: [1, 0.98, 0.025, 0], bloom: 0.08 }),
  preset('neon-outline', 'Neon Outline', 'Creator', { capabilities: ['subject'], subject: 'outline' })
];

/** Extension contract: unavailable models are never advertised as working presets. */
export const VIDEO_VISION_CAPABILITIES = {
  subject: { available: true, provider: 'shared-local-modnet-worker' },
  face: { available: false }, pose: { available: false }, depth: { available: false }
} as const;

export function effectDefinition(id: string): VideoEffectDefinition | undefined {
  return VIDEO_EFFECTS.find(effect => effect.id === id);
}
export function normalizeVideoEffect(value?: Partial<VideoEffect> | null): VideoEffect {
  const definition = effectDefinition(value?.id ?? 'none');
  if (!definition || definition.id === 'none') return { id: 'none', intensity: 0 };
  return { id: definition.id, intensity: Number.isFinite(value?.intensity)
    ? Math.max(0, Math.min(1, value!.intensity!)) : definition.defaultIntensity };
}
/**
 * True when the preset moves pixels sideways rather than only regrading them.
 *
 * Tape wobble, glitch block offsets and the RGB channel split all change where
 * the person lands in the finished picture. A silhouette measured on the
 * undisplaced frame therefore no longer describes the person that is on screen,
 * which is why the occlusion mask for a Background Caption has to travel
 * through the same displacement before it is used to cut the subject out.
 */
export function effectDisplacesPixels(definition?: VideoEffectDefinition | null): boolean {
  if (!definition) return false;
  return definition.mode === 1 || definition.mode === 2 || (definition.split ?? 0) > 0;
}

/**
 * True when the preset's picture changes with time on its own.
 *
 * Tape wobble, glitch bursts, the light-leak drift and the grain all read the
 * clock, so a container whose player has no clock of its own — a still image —
 * shows them frozen unless something drives one.
 */
export function effectAnimates(definition?: VideoEffectDefinition | null): boolean {
  if (!definition) return false;
  return definition.mode === 1 || definition.mode === 2 || definition.mode === 4 || (definition.grain ?? 0) > 0;
}

export function effectNeedsSubject(value?: VideoEffect | null): boolean {
  return !!value && value.intensity > 0 && !!effectDefinition(value.id)?.capabilities.includes('subject');
}
