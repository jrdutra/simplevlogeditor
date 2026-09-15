/**
 * Keeping an edit across a reload, and putting it in a file.
 *
 * An edit is worth more than the minutes it took to make: a reader who cut the
 * silence out of nine clips, drew a dozen corrections by hand, wrote captions
 * and arranged the order has produced something no button can reproduce, and
 * losing it to a refresh is the kind of thing that stops a tool being used at
 * all.
 *
 * What is saved is every decision and nothing else. **The media itself never
 * leaves the reader's disk and is never copied into the browser's storage** —
 * a timeline is routinely gigabytes, and a quota is five megabytes. So a
 * restored project comes back complete but *waiting*: every clip is in place,
 * in order, with its cuts and its settings, and each one is asking for its file
 * back. Dropping the same files in again reunites them, matched by name and
 * size, and the edit carries on exactly where it was.
 *
 * The same document is what the Export project button writes out, which is why
 * there is one shape here and not two: a project saved to a file and a project
 * saved to the browser are the same thing kept in two places.
 */

import type { LoudnessSettings } from '../../shared/media/loudness';
import type { MediaSummary, ResolutionPreset } from '../juntador-de-midias/media-merger.models';
import type { EditableRange } from '../cortador-de-silencio/silence-cutter.models';
import type { AnalysisSettings, NoiseReport } from '../supressao-de-ruido/noise-analysis';
import { clampClipNoise } from './clip-noise';
import { effectDefinition, normalizeVideoEffect } from './video-effects';
import type { ClipNoiseSettings } from './clip-noise';
import {
  DEFAULT_SOUND_FADE,
  SILENT_CUT_REPLACEMENT,
  clampCaption,
  clampSilentCutReplacementThreshold,
  clampSoundFade,
  clampTimelapseTarget,
  cloneEdits
} from './video-editor-defaults';
import type {
  ClipCaption,
  ClipEdits,
  ClipImage,
  ClipVideoEffect,
  EditorClip,
  FrameAspect,
  ManualZoom,
  MediaClip,
  ProjectSettings,
  ReframeFit,
  SoundFade,
  SuppliedSound,
  TextClip,
  TextClipDraft,
  TransitionClip,
  TransitionSettings
} from './video-editor.models';
import { pathBackedPath } from '../../shared/desktop/path-backed-file';
import { isMediaClip, isTransitionClip } from './video-editor.models';
import { DEFAULT_TRANSITION } from './video-editor-defaults';
import { clampTransition } from './video-editor-timeline';
import { clampClipImage } from './video-editor-defaults';
import { ClipTag, DEFAULT_TAG, clampTag } from './tag-overlay';

/** Where the browser keeps the current edit. */
export const STORAGE_KEY = 'utily.video-editor.project.v1';

/**
 * The only version this code writes.
 *
 * A document from a future version is refused rather than half-read: a
 * timeline restored with the pieces this build happens to recognise is worse
 * than one that says plainly it cannot be opened.
 */
export const PROJECT_VERSION = 1;

/** A soundtrack reference: how to find the file again, and what was measured. */
export interface StoredSound {
  ref: StoredFileRef;
  summary: MediaSummary;
  trimStart?: number;
  skipLeadingSilence?: boolean;
  /**
   * The key this browser filed a durable reference to the file under.
   *
   * Carried here as well as in a settings document so that a *project* saved
   * and reopened finds its soundtrack by the sturdier key too — the one that
   * still points at the right file after it has been renamed. Absent in
   * documents written before this existed.
   */
  handleId?: string;
}

/** How a file is recognised again after a reload. Nothing of it is stored. */
export interface StoredFileRef {
  name: string;
  size: number;
  lastModified: number;
  /** Electron-only local path. No file contents are stored. */
  path?: string;
}

/**
 * A placed picture as it is written down.
 *
 * The bytes are never stored, exactly as they are never stored for media or for
 * a soundtrack: what survives is enough to recognise the file again. A project
 * moved to another machine reports the picture as missing in its recovery
 * report instead of silently exporting a frame without it.
 */
export interface StoredClipImage {
  id?: string;
  source: {
    ref: StoredFileRef;
    name: string;
    width: number;
    height: number;
    handleId?: string;
  };
  startSeconds?: number;
  durationSeconds?: number;
  style?: 'overlay' | 'behind-subject';
  positionX?: number;
  positionY?: number;
  scale?: number;
  rotationDegrees?: number;
  opacity?: number;
  fadeSeconds?: number;
}

export interface StoredMediaClip {
  kind: 'media';
  id: string;
  file: StoredFileRef;
  summary: MediaSummary;
  overrides: ClipEdits | null;
  detected: EditableRange[];
  manualCuts: EditableRange[];
  caption: ClipCaption | null;
  /** Absent in documents written before captions could be timed independently. */
  captions?: ClipCaption[];
  /** Absent in documents written before pictures could be placed on a clip. */
  images?: StoredClipImage[];
  replacementAudio: StoredSound | null;
  /** Per-clip noise removal settings. Absent in projects written before the feature. */
  noiseSuppression?: ClipNoiseSettings;
  videoEffect?: import('./video-effects').VideoEffect;
  /** Timed effects. Absent for old projects and for one whole-clip effect. */
  videoEffects?: ClipVideoEffect[];
  /** Diagnostic evidence is small and saves another model pass after reopening a project. */
  noiseReport?: NoiseReport | null;
  noiseAnalyzedWith?: AnalysisSettings | null;
  /** Absent in documents written before a clip could be trimmed. Absent means the whole file. */
  inPoint?: number;
  outPoint?: number;
  /**
   * Absent in documents written before the timelapse target existed, and absent
   * whenever the speed was chosen by hand — the same thing to whoever reads it
   * back, since only a speed this flag claims may be recalculated later.
   */
  speedFromTimelapse?: boolean;
  /** Absent in documents written before push-ins could be placed by hand. */
  manualZooms?: ManualZoom[];
  /** Absent in documents written before a clip could wear an animated tag. */
  tag?: ClipTag | null;
  /** A few kilobytes of JPEG, dropped first when the quota is tight. */
  thumbUrl: string | null;
}

export interface StoredTextClip {
  kind: 'text';
  id: string;
  draft: TextClipDraft;
  overrides: ClipEdits | null;
  background: StoredFileRef | null;
  /** Absent in documents written before a card could be given its own sound. */
  replacementAudio?: StoredSound | null;
  /** Absent in documents written before a clip could wear an animated tag. */
  tag?: ClipTag | null;
}

/**
 * A join between two shots.
 *
 * Everything about it fits in the document, because a transition is entirely a
 * decision — there is no file behind it to go missing and nothing to re-measure
 * when the project is opened again somewhere else.
 */
export interface StoredTransitionClip {
  kind: 'transition';
  id: string;
  settings: TransitionSettings;
}

export type StoredClip = StoredMediaClip | StoredTextClip | StoredTransitionClip;

export interface StoredProject {
  version: number;
  savedAt: string;
  /** Revision at save time. Older documents omit it and start a fresh scope. */
  projectRevision?: number;
  nextId: number;
  settings: {
    edits: ClipEdits;
    loudness: LoudnessSettings;
    defaultAudio: StoredSound | null;
    /** Absent in projects written before mostly-silent clips could use the project sound. */
    silentCutReplacementThreshold?: number;
    /** Absent in documents written before the soundtrack had ramps of its own. */
    soundFade?: SoundFade;
    /** Absent in documents written before shots could be joined rather than cut. */
    defaultTransition?: TransitionSettings | null;
  /** Absent in documents written before a project could carry a tag template. */
  defaultTag?: ClipTag;
    resolution: ResolutionPreset;
    /** Absent in documents written before the frame could be reshaped. */
    aspect?: FrameAspect;
    reframe?: ReframeFit;
    /** Absent in documents written before timelapses could be timed. Absent is off. */
    timelapseTargetSeconds?: number;
    videoFormatId: string;
    audioFormatId: string;
  };
  clips: StoredClip[];
}

function refOf(file: File): StoredFileRef {
  const sourcePath = pathBackedPath(file);
  return { name: file.name, size: file.size, lastModified: file.lastModified, ...(sourcePath ? { path: sourcePath } : {}) };
}

/** A soundtrack as it is written down, measurement and all. */
function soundOf(sound: SuppliedSound): StoredSound {
  return {
    ref: refOf(sound.file),
    summary: sound.summary,
    trimStart: sound.trimStart,
    skipLeadingSilence: sound.skipLeadingSilence,
    ...(sound.handleId ? { handleId: sound.handleId } : {})
  };
}

/**
 * A stored soundtrack, waiting for its bytes.
 *
 * The measured silence at its head comes back with it: it is a property of the
 * file, and re-measuring on every reload would decode the first seconds of
 * every track in the project for an answer already known.
 */
function soundFrom(stored: StoredSound): SuppliedSound {
  return {
    file: placeholder(stored.ref),
    // Kept so the placeholder can be replaced by the real file later. Without
    // it a restored soundtrack is silent, and the export says only that the
    // input has an unrecognizable format.
    fileRef: stored.ref,
    summary: stored.summary,
    trimStart: stored.trimStart,
    skipLeadingSilence: stored.skipLeadingSilence,
    ...(stored.handleId ? { handleId: stored.handleId } : {})
  };
}

/** True when this file is, to every test the browser allows, the stored one. */
export function matchesRef(file: File, ref: StoredFileRef): boolean {
  // The modification time is deliberately not compared. A file copied between
  // machines, restored from a backup or synced by a cloud client keeps its name
  // and its length and loses its timestamp, and refusing it then would be
  // pedantry dressed as safety.
  return file.name === ref.name && file.size === ref.size;
}

/** The whole edit as a plain document. */
export function serializeProject(
  clips: readonly EditorClip[],
  project: ProjectSettings,
  nextId: number,
  options: { thumbnails?: boolean; projectRevision?: number } = {}
): StoredProject {
  const keepThumbs = options.thumbnails !== false;

  return {
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    ...(Number.isFinite(options.projectRevision) ? { projectRevision: options.projectRevision } : {}),
    nextId,
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
      audioFormatId: project.audioFormatId
    },
    clips: clips.map((clip) =>
      isTransitionClip(clip)
        ? ({
            kind: 'transition',
            id: clip.id,
            settings: { ...clip.settings }
          } satisfies StoredTransitionClip)
        : isMediaClip(clip)
        ? ({
            kind: 'media',
            id: clip.id,
            // A clip still waiting for its media holds an empty stand-in, and
            // writing *that* out would store a length of zero — so the next
            // reload would never recognise the real file again. The reference
            // it was restored with is the one that has to survive.
            file: clip.awaitingFile && clip.fileRef ? clip.fileRef : refOf(clip.file),
            summary: { ...clip.summary },
            overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
            detected: clip.detected.map((range) => ({ ...range })),
            manualCuts: clip.manualCuts.map((range) => ({ ...range })),
            caption: clip.caption ? { ...clip.caption } : null,
            ...(clip.captions?.length ? { captions: clip.captions.map((caption) => ({ ...caption })) } : {}),
            ...(clip.images?.length ? { images: clip.images.map(storedClipImage) } : {}),
            replacementAudio: clip.replacementAudio ? soundOf(clip.replacementAudio) : null,
            ...(clip.noiseSuppression ? { noiseSuppression: clampClipNoise(clip.noiseSuppression) } : {}),
            ...storedVideoEffects(clip),
            ...(clip.noiseReport ? { noiseReport: structuredClone(clip.noiseReport) } : {}),
            ...(clip.noiseAnalyzedWith ? { noiseAnalyzedWith: structuredClone(clip.noiseAnalyzedWith) } : {}),
            // Written only when they are not the whole file, so an untouched
            // project's document is byte for byte what it always was.
            ...(clip.inPoint ? { inPoint: clip.inPoint } : {}),
            ...(clip.outPoint === undefined ? {} : { outPoint: clip.outPoint }),
            ...(clip.manualZooms?.length ? { manualZooms: clip.manualZooms.map((zoom) => ({ ...zoom })) } : {}),
            ...(clip.speedFromTimelapse ? { speedFromTimelapse: true } : {}),
            ...(clip.tag ? { tag: { ...clip.tag } } : {}),
            thumbUrl: keepThumbs ? clip.thumbUrl : null
          } satisfies StoredMediaClip)
        : ({
            kind: 'text',
            id: clip.id,
            draft: { ...clip.draft },
            overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
            background: clip.backgroundFile ? refOf(clip.backgroundFile) : clip.backgroundRef ?? null,
            replacementAudio: clip.replacementAudio ? soundOf(clip.replacementAudio) : null,
            ...(clip.tag ? { tag: { ...clip.tag } } : {})
          } satisfies StoredTextClip)
    )
  };
}

/**
 * A zero-length stand-in for a file that has not been handed back yet.
 *
 * Every clip keeps a real `File`, so nothing downstream has to cope with a
 * missing one; `awaitingFile` is what says the bytes are not there. Exporting
 * is refused while any clip is in this state, which is the whole reason the
 * placeholder is safe to exist.
 */
function placeholder(ref: StoredFileRef): File {
  return new File([], ref.name, { lastModified: ref.lastModified });
}

export interface RestoredProject {
  clips: EditorClip[];
  project: ProjectSettings;
  nextId: number;
  savedAt: string;
  projectRevision: number;
}

/** Turns a stored document back into a timeline waiting for its files. */
export function restoreProject(stored: StoredProject): RestoredProject {
  const settings = stored.settings;

  const project: ProjectSettings = {
    edits: cloneEdits(settings.edits),
    loudness: { ...settings.loudness },
    defaultAudio: settings.defaultAudio ? soundFrom(settings.defaultAudio) : null,
    silentCutReplacementThreshold: clampSilentCutReplacementThreshold(
      settings.silentCutReplacementThreshold ?? SILENT_CUT_REPLACEMENT.default
    ),
    // A document from before the soundtrack had ramps gets today's default
    // rather than silence: the setting is what a reader would now expect to
    // find, and an old project reopened with music that cuts in at full volume
    // would look like the feature was broken rather than absent.
    soundFade: clampSoundFade(settings.soundFade ?? DEFAULT_SOUND_FADE),
    // Absent in every document written before joins existed, and absent means
    // cuts — which is exactly what those projects had.
    defaultTransition: clampTransition(settings.defaultTransition ?? null),
    defaultTag: clampTag(settings.defaultTag ?? DEFAULT_TAG),
    resolution: settings.resolution,
    // Absent means the shape the footage already had, which is what every
    // project written before the frame could be reshaped actually was.
    aspect: settings.aspect ?? 'source',
    reframe: settings.reframe ?? 'fill',
    // Absent means nothing was being timed, which is what every project written
    // before this existed was doing.
    timelapseTargetSeconds: clampTimelapseTarget(settings.timelapseTargetSeconds ?? 0),
    videoFormatId: settings.videoFormatId,
    audioFormatId: settings.audioFormatId
  };

  const clips: EditorClip[] = stored.clips.map((clip) =>
    clip.kind === 'transition'
      ? ({
          kind: 'transition',
          id: clip.id,
          settings: clampTransition(clip.settings) ?? { ...DEFAULT_TRANSITION }
        } satisfies TransitionClip)
      : clip.kind === 'media'
      ? ({
          kind: 'media',
          id: clip.id,
          file: placeholder(clip.file),
          fileRef: clip.file,
          ...(clip.file.path ? { sourcePath: clip.file.path } : {}),
          awaitingFile: true,
          summary: { ...clip.summary },
          info: null,
          overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
          detected: clip.detected.map((range) => ({ ...range })),
          manualCuts: clip.manualCuts.map((range) => ({ ...range })),
          ...(clip.inPoint ? { inPoint: clip.inPoint } : {}),
          ...(clip.outPoint === undefined ? {} : { outPoint: clip.outPoint }),
          manualZooms: (clip.manualZooms ?? []).map((zoom) => ({ ...zoom })),
          ...(clip.speedFromTimelapse ? { speedFromTimelapse: true } : {}),
          analysis: null,
          analyzedWith: null,
          replacementAudio: clip.replacementAudio ? soundFrom(clip.replacementAudio) : null,
          ...(clip.noiseSuppression ? { noiseSuppression: clampClipNoise(clip.noiseSuppression) } : {}),
          videoEffect: normalizeVideoEffect(clip.videoEffect),
          videoEffects: restoredVideoEffects(clip),
          noiseReport: clip.noiseReport ? structuredClone(clip.noiseReport) : null,
          noiseAnalyzedWith: clip.noiseAnalyzedWith ? structuredClone(clip.noiseAnalyzedWith) : null,
          noiseCleanedAudio: null,
          noiseCleanedWith: null,
          noiseCleanedUrl: null,
          noiseReductionDb: null,
          caption: clip.caption ? clampCaption({ ...clip.caption }) : null,
          captions: (clip.captions ?? []).map((caption) => clampCaption({ ...caption })),
          images: (clip.images ?? []).map(restoredClipImage),
          // Clamped on the way in rather than trusted: a document written by an
          // older build can name an animation this one no longer has, and the
          // painter would draw nothing at all rather than fall back.
          ...(clip.tag ? { tag: clampTag(clip.tag) } : {}),
          previewUrl: null,
          thumbUrl: clip.thumbUrl ?? null
        } satisfies MediaClip)
      : ({
          kind: 'text',
          id: clip.id,
          draft: { ...clip.draft },
          backgroundFile: null,
          backgroundUrl: null,
          ...(clip.background ? { backgroundRef: clip.background } : {}),
          replacementAudio: clip.replacementAudio ? soundFrom(clip.replacementAudio) : null,
          overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
          ...(clip.tag ? { tag: clampTag(clip.tag) } : {})
        } satisfies TextClip)
  );

  return {
    clips, project, nextId: stored.nextId, savedAt: stored.savedAt,
    projectRevision: Number.isFinite(stored.projectRevision) ? Math.max(0, Number(stored.projectRevision)) : 0
  };
}

function sourceBounds(clip: Pick<MediaClip, 'inPoint' | 'outPoint' | 'summary'>): { start: number; end: number } {
  const duration = Math.max(0, clip.summary.durationSeconds ?? 0);
  const start = Math.max(0, Math.min(duration, clip.inPoint ?? 0));
  const end = Math.max(start, Math.min(duration, clip.outPoint ?? duration));
  return { start, end };
}

function normalizedStoredEffect(item: ClipVideoEffect): ClipVideoEffect | null {
  if (!item || typeof item.effectId !== 'string' || !effectDefinition(item.effectId)) return null;
  if (!Number.isFinite(item.intensity)) return null;
  if (item.startSeconds !== undefined && !Number.isFinite(item.startSeconds)) return null;
  if (item.durationSeconds !== undefined && (!Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0)) return null;
  const effect = normalizeVideoEffect({ id: item.effectId, intensity: item.intensity });
  if (effect.id === 'none' || effect.intensity <= 0) return null;
  return {
    ...(item.id ? { id: String(item.id) } : {}),
    effectId: effect.id,
    intensity: effect.intensity,
    ...(item.startSeconds === undefined ? {} : { startSeconds: Math.max(0, item.startSeconds) }),
    ...(item.durationSeconds === undefined ? {} : { durationSeconds: item.durationSeconds })
  };
}

/** Migration on read: the old whole-clip field becomes one editable segment. */
function restoredVideoEffects(clip: StoredMediaClip): ClipVideoEffect[] {
  const timed = (clip.videoEffects ?? []).map(normalizedStoredEffect).filter((item): item is ClipVideoEffect => !!item);
  if (timed.length) return timed;
  const legacy = normalizeVideoEffect(clip.videoEffect);
  return legacy.id === 'none' || legacy.intensity <= 0
    ? []
    : [{ id: `effect-legacy-${clip.id}`, effectId: legacy.id, intensity: legacy.intensity }];
}

/**
 * Compatibility on write: one full-clip segment keeps the legacy document
 * shape. Partial/multiple segments write the new list and leave old builds on
 * Original rather than misleadingly applying one look to the entire clip.
 */
function storedVideoEffects(clip: MediaClip): Pick<StoredMediaClip, 'videoEffect' | 'videoEffects'> {
  const items = (clip.videoEffects ?? []).map(normalizedStoredEffect).filter((item): item is ClipVideoEffect => !!item);
  if (!items.length) return { videoEffect: normalizeVideoEffect(clip.videoEffect) };
  const bounds = sourceBounds(clip);
  const only = items[0];
  const start = only.startSeconds ?? bounds.start;
  const end = start + (only.durationSeconds ?? bounds.end - start);
  if (items.length === 1 && start <= bounds.start + 1e-6 && end >= bounds.end - 1e-6) {
    return { videoEffect: normalizeVideoEffect({ id: only.effectId, intensity: only.intensity }) };
  }
  return { videoEffect: { id: 'none', intensity: 0 }, videoEffects: items.map(item => ({ ...item })) };
}

/** A placed picture on the way out. */
function storedClipImage(image: ClipImage): StoredClipImage {
  const source = image.source;
  const ref = source.awaitingFile && source.fileRef ? source.fileRef : refOf(source.file);
  return {
    ...(image.id ? { id: image.id } : {}),
    source: {
      ref: source.sourcePath ? { ...ref, path: source.sourcePath } : ref,
      name: source.name,
      width: source.width,
      height: source.height,
      ...(source.handleId ? { handleId: source.handleId } : {})
    },
    ...(image.startSeconds === undefined ? {} : { startSeconds: image.startSeconds }),
    ...(image.durationSeconds === undefined ? {} : { durationSeconds: image.durationSeconds }),
    ...(image.style ? { style: image.style } : {}),
    ...(image.positionX === undefined ? {} : { positionX: image.positionX }),
    ...(image.positionY === undefined ? {} : { positionY: image.positionY }),
    ...(image.scale === undefined ? {} : { scale: image.scale }),
    ...(image.rotationDegrees === undefined ? {} : { rotationDegrees: image.rotationDegrees }),
    ...(image.opacity === undefined ? {} : { opacity: image.opacity }),
    ...(image.fadeSeconds === undefined ? {} : { fadeSeconds: image.fadeSeconds })
  };
}

/** A placed picture on the way in, still waiting for its bytes. */
function restoredClipImage(stored: StoredClipImage): ClipImage {
  return clampClipImage({
    ...(stored.id ? { id: stored.id } : {}),
    source: {
      file: placeholder(stored.source.ref),
      fileRef: stored.source.ref,
      ...(stored.source.ref.path ? { sourcePath: stored.source.ref.path } : {}),
      ...(stored.source.handleId ? { handleId: stored.source.handleId } : {}),
      name: stored.source.name || stored.source.ref.name,
      width: stored.source.width,
      height: stored.source.height,
      awaitingFile: true
    },
    startSeconds: stored.startSeconds,
    durationSeconds: stored.durationSeconds,
    style: stored.style,
    positionX: stored.positionX,
    positionY: stored.positionY,
    scale: stored.scale,
    rotationDegrees: stored.rotationDegrees,
    opacity: stored.opacity,
    fadeSeconds: stored.fadeSeconds
  });
}

/**
 * Refuses anything that is not recognisably one of our documents.
 *
 * The check is deliberately shallow — a name, a version and a list — because
 * the alternative is a schema validator that has to be kept in step with every
 * field, and the failure it would catch (a hand-edited project file) is one the
 * reader can see for themselves.
 */
export function looksLikeProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredProject>;
  return (
    typeof candidate.version === 'number' &&
    candidate.version <= PROJECT_VERSION &&
    Array.isArray(candidate.clips) &&
    Boolean(candidate.settings)
  );
}

/**
 * Writes the document to the browser, giving up gracefully when it will not fit.
 *
 * The thumbnails are the only large thing in it and the only thing nobody would
 * miss, so a quota failure drops them and tries once more. Failing twice is not
 * reported as an error: a project that could not be *saved* is still a project
 * that can be *edited*, and interrupting the reader to say otherwise would be
 * worse than the silence.
 */
export function writeStoredProject(
  clips: readonly EditorClip[],
  project: ProjectSettings,
  nextId: number,
  projectRevision?: number
): 'saved' | 'saved-without-thumbnails' | 'too-large' | 'unavailable' {
  if (typeof localStorage === 'undefined') return 'unavailable';

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeProject(clips, project, nextId, { projectRevision })));
    return 'saved';
  } catch {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(serializeProject(clips, project, nextId, { thumbnails: false, projectRevision }))
      );
      return 'saved-without-thumbnails';
    } catch {
      return 'too-large';
    }
  }
}

export function readStoredProject(): StoredProject | null {
  if (typeof localStorage === 'undefined') return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    return looksLikeProject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How much of the browser's allowance this project is using, in bytes.
 *
 * Two bytes per character, because that is how a browser measures a
 * `localStorage` value against the quota — it stores UTF-16, so a string of
 * a hundred thousand characters is two hundred kilobytes of the five megabytes
 * available, not one hundred.
 */
export function storedProjectBytes(): number {
  if (typeof localStorage === 'undefined') return 0;

  try {
    return (localStorage.getItem(STORAGE_KEY)?.length ?? 0) * 2;
  } catch {
    return 0;
  }
}

export function clearStoredProject(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* A project that cannot be forgotten is not worth an error message. */
  }
}
