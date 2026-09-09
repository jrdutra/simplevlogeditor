import { AutoZoomSettings, DEFAULT_AUTO_ZOOM, clampAutoZoom } from '../../shared/media/auto-zoom';
import { SilenceSettings, detectionSettingsChanged } from './silence-cutter.models';

/** Identifier of a preset, or `custom` once any value has been hand-tuned. */
export type PresetId = 'balanced' | 'aggressive' | 'natural' | 'long-pauses' | 'custom';

export interface SilencePreset {
  id: Exclude<PresetId, 'custom'>;
  label: string;
  description: string;
  settings: SilenceSettings;
}

/** Starting point for a first analysis; also the `Balanced` preset. */
export const DEFAULT_SETTINGS: SilenceSettings = {
  thresholdDb: -40,
  minimumSilenceMs: 600,
  keepBeforeMs: 120,
  keepAfterMs: 180,
  minimumKeptSegmentMs: 250,
  detectionWindowMs: 20,
  channelMode: 'combined',
  crossfadeMs: 5,
  autoZoom: { ...DEFAULT_AUTO_ZOOM }
};

/**
 * The four starting points offered above the sliders.
 *
 * They differ only in how eagerly they treat a pause as removable: the
 * threshold decides what counts as quiet, and the minimum duration decides how
 * long quiet has to last before it is worth cutting.
 */
export const SILENCE_PRESETS: readonly SilencePreset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'General purpose. Removes clear pauses and leaves the rhythm of the speech intact.',
    settings: { ...DEFAULT_SETTINGS }
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    description: 'Tightens the edit hard. Cuts shorter pauses and leaves smaller margins around speech.',
    settings: {
      ...DEFAULT_SETTINGS,
      thresholdDb: -35,
      minimumSilenceMs: 250,
      keepBeforeMs: 60,
      keepAfterMs: 80,
      minimumKeptSegmentMs: 150
    }
  },
  {
    id: 'natural',
    label: 'Natural speech',
    description: 'Keeps breaths and thinking pauses. The result still sounds like someone talking.',
    settings: {
      ...DEFAULT_SETTINGS,
      thresholdDb: -45,
      minimumSilenceMs: 900,
      keepBeforeMs: 200,
      keepAfterMs: 260,
      minimumKeptSegmentMs: 400
    }
  },
  {
    id: 'long-pauses',
    label: 'Long pauses only',
    description: 'Touches nothing but the dead air — setup gaps, restarts and forgotten recordings.',
    settings: {
      ...DEFAULT_SETTINGS,
      thresholdDb: -50,
      minimumSilenceMs: 2500,
      keepBeforeMs: 250,
      keepAfterMs: 300,
      minimumKeptSegmentMs: 500
    }
  }
];

/**
 * The settings of one preset, as a copy nothing else shares.
 *
 * Exists so a tool that wants to *start* somewhere other than Balanced can say
 * which preset it means rather than copying its five numbers — the Video Editor
 * starts every project on Aggressive, and the numbers behind that word should
 * only ever be written down once.
 */
export function settingsForPreset(id: Exclude<PresetId, 'custom'>): SilenceSettings {
  const preset = SILENCE_PRESETS.find((candidate) => candidate.id === id);
  const settings = preset?.settings ?? DEFAULT_SETTINGS;
  return { ...settings, autoZoom: { ...settings.autoZoom } };
}

/**
 * The preset the current settings correspond to, or `custom`.
 *
 * Only the detection fields are compared, so changing the crossfade — which is
 * applied while rendering and never re-runs detection — does not make a preset
 * look hand-tuned.
 */
export function presetFor(settings: SilenceSettings): PresetId {
  const match = SILENCE_PRESETS.find((preset) => !detectionSettingsChanged(preset.settings, settings));
  return match?.id ?? 'custom';
}

/** Bounds enforced by both the sliders and the numeric fields. */
export const SETTING_LIMITS = {
  thresholdDb: { min: -70, max: -20, step: 1 },
  minimumSilenceMs: { min: 100, max: 10000, step: 50 },
  keepBeforeMs: { min: 0, max: 1000, step: 10 },
  keepAfterMs: { min: 0, max: 1000, step: 10 },
  minimumKeptSegmentMs: { min: 0, max: 2000, step: 50 },
  detectionWindowMs: { min: 5, max: 200, step: 5 },
  crossfadeMs: { min: 0, max: 50, step: 1 }
} as const;

/** Detection window sizes offered in the advanced panel. */
export const DETECTION_WINDOWS = [10, 20, 50, 100] as const;

/** Crossfade lengths offered in the advanced panel. */
export const CROSSFADE_OPTIONS = [0, 5, 10, 20] as const;

/** Clamps every field into its allowed range, so a typed value can never break detection. */
export function clampSettings(settings: SilenceSettings): SilenceSettings {
  const clamp = (value: number, limits: { min: number; max: number }) =>
    Number.isFinite(value) ? Math.min(limits.max, Math.max(limits.min, value)) : limits.min;

  return {
    ...settings,
    thresholdDb: clamp(settings.thresholdDb, SETTING_LIMITS.thresholdDb),
    minimumSilenceMs: clamp(settings.minimumSilenceMs, SETTING_LIMITS.minimumSilenceMs),
    keepBeforeMs: clamp(settings.keepBeforeMs, SETTING_LIMITS.keepBeforeMs),
    keepAfterMs: clamp(settings.keepAfterMs, SETTING_LIMITS.keepAfterMs),
    minimumKeptSegmentMs: clamp(settings.minimumKeptSegmentMs, SETTING_LIMITS.minimumKeptSegmentMs),
    detectionWindowMs: clamp(settings.detectionWindowMs, SETTING_LIMITS.detectionWindowMs),
    crossfadeMs: clamp(settings.crossfadeMs, SETTING_LIMITS.crossfadeMs),
    autoZoom: clampAutoZoom(settings.autoZoom ?? DEFAULT_AUTO_ZOOM)
  };
}

const STORAGE_KEY = 'freeSilenceCutter.settings';

/** Reads the last settings the reader used. Preferences only — never media. */
export function loadStoredSettings(): SilenceSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<SilenceSettings>;
    // The spread is shallow, and `autoZoom` is the one field that is an object:
    // a value stored before it existed, or before a field was added to it, has
    // to be filled in from the defaults rather than used as it stands.
    const autoZoom: AutoZoomSettings = { ...DEFAULT_AUTO_ZOOM, ...(parsed.autoZoom ?? {}) };
    return clampSettings({ ...DEFAULT_SETTINGS, ...parsed, autoZoom });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Stores the settings for the next visit. Failures are not worth reporting. */
export function storeSettings(settings: SilenceSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Private mode and full quotas are not errors the reader needs to see. */
  }
}
