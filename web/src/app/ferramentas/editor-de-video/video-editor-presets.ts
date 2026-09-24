/**
 * Whole-project settings, saved under a name and used again.
 *
 * A reader who has settled how their videos should look — the detector's
 * eagerness, the levelling, the fades, the transition between every shot, the
 * resolution and the format — has made twenty decisions that belong together.
 * Making them again for the next video is the tool asking someone to re-derive
 * a house style from memory once a week.
 *
 * What is saved is {@link ProjectSettings} and nothing else. Deliberately: a
 * preset is a way of working, not a piece of work, so no clip, no file and no
 * timeline is in it. The one field that would carry a file — the project's
 * default soundtrack — is kept as a reference and comes back waiting for its
 * bytes exactly as a restored project does, because a preset that silently
 * dropped the music would be a preset that does not reproduce what it was made
 * from.
 */

import type { LoudnessSettings } from '../../shared/media/loudness';
import type { ResolutionPreset } from '../juntador-de-midias/media-merger.models';
import {
  DEFAULT_SOUND_FADE,
  SILENT_CUT_REPLACEMENT,
  clampSilentCutReplacementThreshold,
  clampSoundFade,
  clampTimelapseTarget,
  cloneEdits
} from './video-editor-defaults';
import { clampTransition } from './video-editor-timeline';
import { ClipTag, DEFAULT_TAG, clampTag } from './tag-overlay';
import type {
  ClipEdits,
  FrameAspect,
  ProjectSettings,
  ReframeFit,
  SoundFade,
  SuppliedSound,
  TransitionSettings
} from './video-editor.models';

/** Where the browser keeps the saved presets. */
export const PRESETS_KEY = 'utily.video-editor.presets.v1';

/** How many are kept. Past this the oldest is dropped rather than the quota being hit. */
export const MAX_PRESETS = 24;

/** A soundtrack inside a preset: how to find it again, and what was measured. */
interface StoredPresetSound {
  ref: { name: string; size: number; lastModified: number };
  summary: SuppliedSound['summary'];
  trimStart?: number;
  skipLeadingSilence?: boolean;
  /**
   * The key this browser filed a reference to the file under.
   *
   * The document's half of the arrangement that stands in for a path: a page is
   * never told where a file came from, so what it keeps is a key, and the
   * browser keeps the reference the key points at. Absent in documents written
   * before this existed, and absent for a sound the browser was never given a
   * reference to — both mean the same thing to the reader of this file.
   */
  handleId?: string;
}

export interface ProjectPreset {
  id: string;
  name: string;
  savedAt: string;
  settings: {
    edits: ClipEdits;
    loudness: LoudnessSettings;
    defaultAudio: StoredPresetSound | null;
    silentCutReplacementThreshold: number;
    soundFade: SoundFade;
    defaultTransition: TransitionSettings | null;
    /** Absent in presets saved before a project could carry a tag template. */
    defaultTag?: ClipTag;
    resolution: ResolutionPreset;
    aspect: FrameAspect;
    reframe: ReframeFit;
    timelapseTargetSeconds: number;
    videoFormatId: string;
    audioFormatId: string;
    /** Absent in presets saved before it could be switched off. Absent is on. */
    autoVideoPackaging?: boolean;
  };
}

function soundOf(sound: SuppliedSound): StoredPresetSound {
  return {
    ref: { name: sound.file.name, size: sound.file.size, lastModified: sound.file.lastModified },
    summary: sound.summary,
    trimStart: sound.trimStart,
    skipLeadingSilence: sound.skipLeadingSilence,
    ...(sound.handleId ? { handleId: sound.handleId } : {})
  };
}

function soundFrom(stored: StoredPresetSound): SuppliedSound {
  return {
    // The same zero-length stand-in a restored project uses, for the same
    // reason: everything downstream wants a `File`, and `size === 0` is what
    // the page already reads as "this one is still waiting".
    file: new File([], stored.ref.name, { lastModified: stored.ref.lastModified }),
    summary: stored.summary,
    trimStart: stored.trimStart,
    skipLeadingSilence: stored.skipLeadingSilence,
    ...(stored.handleId ? { handleId: stored.handleId } : {})
  };
}

/** The current project, written down under a name. */
export function presetFrom(name: string, project: ProjectSettings): ProjectPreset {
  return {
    id: `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim().slice(0, 60) || 'Untitled preset',
    savedAt: new Date().toISOString(),
    settings: {
      edits: cloneEdits(project.edits),
      loudness: { ...project.loudness },
      defaultAudio: project.defaultAudio ? soundOf(project.defaultAudio) : null,
      silentCutReplacementThreshold: project.silentCutReplacementThreshold,
      soundFade: { ...project.soundFade },
      defaultTransition: project.defaultTransition ? { ...project.defaultTransition } : null,
      defaultTag: { ...project.defaultTag },
      resolution: project.resolution,
      aspect: project.aspect,
      reframe: project.reframe,
      timelapseTargetSeconds: project.timelapseTargetSeconds,
      videoFormatId: project.videoFormatId,
      audioFormatId: project.audioFormatId,
      autoVideoPackaging: project.autoVideoPackaging
    }
  };
}

/**
 * A preset turned back into project settings.
 *
 * Everything is clamped on the way out rather than trusted, because a preset
 * saved by an older build is exactly the kind of document that can hold a value
 * this one no longer offers.
 */
export function settingsFrom(preset: ProjectPreset): ProjectSettings {
  const stored = preset.settings;

  return {
    edits: cloneEdits(stored.edits),
    loudness: { ...stored.loudness },
    defaultAudio: stored.defaultAudio ? soundFrom(stored.defaultAudio) : null,
    silentCutReplacementThreshold: clampSilentCutReplacementThreshold(
      stored.silentCutReplacementThreshold ?? SILENT_CUT_REPLACEMENT.default
    ),
    soundFade: clampSoundFade(stored.soundFade ?? DEFAULT_SOUND_FADE),
    defaultTransition: clampTransition(stored.defaultTransition ?? null),
    defaultTag: clampTag(stored.defaultTag ?? DEFAULT_TAG),
    resolution: stored.resolution,
    aspect: stored.aspect ?? 'source',
    reframe: stored.reframe ?? 'fill',
    timelapseTargetSeconds: clampTimelapseTarget(stored.timelapseTargetSeconds ?? 0),
    videoFormatId: stored.videoFormatId,
    audioFormatId: stored.audioFormatId,
    autoVideoPackaging: stored.autoVideoPackaging !== false
  };
}

/** True when the soundtrack in this preset will come back waiting for its file. */
export function presetNeedsSound(preset: ProjectPreset): string {
  return preset.settings.defaultAudio?.ref.name ?? '';
}

export function readPresets(): ProjectPreset[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry): entry is ProjectPreset =>
        Boolean(entry) && typeof entry === 'object' && typeof (entry as ProjectPreset).id === 'string' &&
        Boolean((entry as ProjectPreset).settings)
    );
  } catch {
    return [];
  }
}

/** Writes the list back. Answers false when the browser would not keep it. */
export function writePresets(presets: readonly ProjectPreset[]): boolean {
  if (typeof localStorage === 'undefined') return false;

  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets.slice(0, MAX_PRESETS)));
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------- settings, as a file --- */

/**
 * The marker that tells a settings file apart from a project file.
 *
 * One button opens both, so the document has to say what it is rather than be
 * guessed at by shape. A project holds `clips`; a settings file does not — and
 * a guess built on that would break the first time somebody saved a project
 * with an empty timeline.
 */
export const SETTINGS_FILE_KIND = 'utily.video-editor.settings';

/**
 * A set of project settings, written to a file the reader keeps.
 *
 * It is a {@link ProjectPreset} in an envelope, on purpose: a preset already is
 * exactly this — the way of working without the work — and it already knows how
 * to hold the default soundtrack as a reference rather than as bytes. Writing a
 * second serialiser for the same thing would have been two shapes to keep in
 * step, and they would not have stayed in step.
 */
export interface SettingsDocument {
  kind: typeof SETTINGS_FILE_KIND;
  version: 1;
  savedAt: string;
  preset: ProjectPreset;
}

export function settingsDocumentFrom(name: string, project: ProjectSettings): SettingsDocument {
  return {
    kind: SETTINGS_FILE_KIND,
    version: 1,
    savedAt: new Date().toISOString(),
    preset: presetFrom(name, project)
  };
}

export function looksLikeSettingsDocument(value: unknown): value is SettingsDocument {
  if (!value || typeof value !== 'object') return false;

  const document_ = value as SettingsDocument;
  return document_.kind === SETTINGS_FILE_KIND && Boolean(document_.preset?.settings);
}
