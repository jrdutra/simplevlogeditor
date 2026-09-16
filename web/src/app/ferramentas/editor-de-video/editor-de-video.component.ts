import { CommonModule, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Inject,
  NgZone,
  AfterViewChecked,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { DataService } from '../../data.service';
import { clampAutoZoom, describeZoomPlan, planAutoZooms } from '../../shared/media/auto-zoom';
import { LoudnessControlComponent } from '../../shared/media/loudness-control.component';
import { GainEnvelope, LoudnessSettings, clampLoudness, describeLoudness, planGainEnvelope } from '../../shared/media/loudness';
import { MediaProbeService } from '../juntador-de-midias/media-probe.service';
import { MergeError } from '../juntador-de-midias/media-merger.models';
import { AUDIO_FORMATS, RESOLUTIONS, VIDEO_FORMATS, audioFormat, videoFormat } from '../juntador-de-midias/media-merger-formats';
import { AudioAnalysisService } from '../cortador-de-silencio/audio-analysis.service';
import { MediaInspectorService } from '../cortador-de-silencio/media-inspector.service';
import { ProcessingEngineSelectorService } from '../cortador-de-silencio/processing-engine-selector.service';
import { MediaToolError, OperationCanceledError } from '../cortador-de-silencio/silence-cutter.models';
import { detectionSettingsChanged } from '../cortador-de-silencio/silence-cutter.models';
import { detectSilence, totalDuration as totalRangeDuration } from '../cortador-de-silencio/silence-detector';
import { clampSettings as clampSilenceSettings } from '../cortador-de-silencio/silence-cutter-presets';
import { SilenceWaveformComponent } from '../cortador-de-silencio/waveform.component';
import { drawFrame } from '../criador-de-video-texto/text-scene-renderer';
import {
  ANIMATIONS,
  FONTS,
  LEGIBILITY_OPTIONS,
  LIMITS as TEXT_LIMITS,
  WEIGHTS,
  fontStack
} from '../criador-de-video-texto/text-video-presets';
import type { SceneBackground, TextScene } from '../criador-de-video-texto/text-video.models';
import { groupWords } from '../transcricao-de-video/recognition-timing';
import { readSpeechAudio, transcribe } from '../transcricao-de-video/speech-recognizer';
import { TranscriptionCanceled, TranscriptionError } from '../transcricao-de-video/transcription-errors';
import {
  SPEECH_LANGUAGES,
  SPEECH_MODELS,
  TranscriptionProgress,
  WHISPER_SAMPLE_RATE as SPEECH_RATE
} from '../transcricao-de-video/transcription.models';
import {
  Cue,
  DEFAULT_SHAPE,
  SUBTITLE_FORMATS,
  SubtitleFormat,
  readableTime,
  shapeCues,
  wordCount,
  writeSubtitles
} from '../transcricao-de-video/subtitle-formats';
import { SuppressionCanceled, SuppressionError, suppress } from '../supressao-de-ruido/noise-suppression-client';
import { analyseNoise } from '../supressao-de-ruido/noise-analysis-client';
import { DEFAULT_ANALYSIS_SETTINGS, AnalysisSettings, NoiseReport } from '../supressao-de-ruido/noise-analysis';
import { readAudio as readNoiseAudio, writeAudio as writeNoiseAudio } from '../supressao-de-ruido/media-audio';
import {
  AUDIO_FORMATS as NOISE_AUDIO_FORMATS,
  ENGINES as NOISE_ENGINES,
  EngineId,
  STRENGTHS as NOISE_STRENGTHS,
  SuppressionProgress
} from '../supressao-de-ruido/noise-suppression.models';
import { BodyPortalDirective } from '../../shared/ui/body-portal.directive';
import { AgentRuntimeInfo, AgentSystemEvent, DesktopService, MissingRoot } from '../../shared/desktop/desktop.service';
import {
  DesktopFileDescriptor, PathBackedFile, imageBitmapForFile, mediaObjectUrl, pathBackedPath, revokeMediaObjectUrl
} from '../../shared/desktop/path-backed-file';
import { composeFrame } from './frame-compositor';
import { captionBox } from './caption-renderer';
import { editorCapabilities } from './editor-agent-capabilities';
import { measureTag } from './tag-renderer';
import { FrameContext, FrameSource } from './frame-source';
import { SubjectMask, SubjectSegmentationClient } from './subject-segmentation';
import { captionAt } from './video-editor-timeline';
import {
  IMAGE_LIMITS,
  IMAGE_RESTRAINED_ROTATION,
  IMAGE_STYLES,
  forgetImage,
  imageAspect,
  imageBox,
  imageKey,
  imagePlacement,
  imagesAt,
  loadPlanImages,
  isImageStyle,
  loadImage
} from './clip-image';
import { measureLeadingSilence } from './leading-silence';
import { AudioSourceDialogComponent } from './audio-source-dialog.component';
import { TransitionDialogComponent } from './transition-dialog.component';
import { TagDialogComponent } from './tag-dialog.component';
import {
  ClipTag,
  TAG_FINISHES,
  TAG_LIMITS,
  TAG_SHAPES,
  TAG_SPECIALS,
  TAG_POSITIONS,
  TAG_POSITION_LABELS,
  TagPosition,
  clampTag,
  clampTagNumber,
  holdFromText,
  shapeIsQr,
  specialShape,
  tagHold
} from './tag-overlay';
import { qrTagError } from './tag-qrcode';
import { TRANSITIONS, TRANSITION_SECONDS, transitionDefinition } from './video-transitions';
import { ClipEditsPanelComponent } from './clip-edits-panel.component';
import { VideoEffectsGalleryComponent } from './video-effects-gallery.component';
import { VideoEffectPreviewComponent } from './video-effect-preview.component';
import { VideoEffect, VIDEO_EFFECTS, VIDEO_VISION_CAPABILITIES, effectDefinition, normalizeVideoEffect } from './video-effects';
import {
  ClipNoiseSettings,
  DEFAULT_CLIP_NOISE,
  NOISE_STRENGTH_INDEX,
  NoiseStrengthId,
  clampClipNoise,
  sameClipNoise
} from './clip-noise';
import { HelpHintComponent } from './help-hint.component';
import { TimelinePlayer } from './timeline-player';
import { placeWords, spokenEntries, spokenSpan } from './timeline-transcript';
import { VideoEditorRenderService } from './video-editor-render.service';
import {
  TRANSCRIPTION_LANGUAGE_ALIASES,
  TRANSCRIPTION_MODEL_ALIASES,
  resolveTranscriptionLanguage,
  resolveTranscriptionModel
} from './transcription-options';
import {
  RestoredProject,
  StoredProject,
  clearStoredProject,
  looksLikeProject,
  matchesRef,
  readStoredProject,
  restoreProject,
  serializeProject,
  storedProjectBytes,
  writeStoredProject
} from './video-editor-project.store';
import {
  ASPECTS,
  ACCEPTED_IMAGE,
  ACCEPTED_MEDIA,
  CAPTION_ANIMATIONS,
  CAPTION_FONTS,
  CAPTION_LIMITS,
  CAPTION_PRESET_GROUPS,
  CAPTION_PRESETS,
  captionPresetIsBackground,
  captionPresetPatch,
  clampClipImage,
  clampCaption,
  isBackgroundCaption,
  CAPTION_WEIGHTS,
  DEFAULT_CAPTION,
  DEFAULT_EDITS,
  DEFAULT_PROJECT,
  DEFAULT_SOUND_FADE,
  DEFAULT_TEXT_DRAFT,
  DEFAULT_TRANSITION,
  FADE_SECONDS,
  IMAGE_SECONDS,
  MANUAL_ZOOM_LIMITS,
  REFRAME_FITS,
  SILENT_CUT_REPLACEMENT,
  SOUND_FADE_SECONDS,
  SPEEDS,
  TIMELAPSE_TARGET,
  VOLUME_LIMITS,
  clampManualZoom,
  clampSilentCutReplacementThreshold,
  clampSoundFade,
  clampSpeed,
  clampTimelapseTarget,
  clampVolume,
  cloneEdits,
  readingSeconds,
  speedLabel,
  timelapseSpeedFor
} from './video-editor-defaults';
import { HelpPanelComponent } from '../../shared/ui/help-panel.component';
import {
  EDITOR_AGENT_API_VERSION,
  EditorAgentBatch,
  EditorAgentError,
  EditorAgentFrameRequest,
  EditorAgentOperation,
  EditorAgentProjectPatch,
  EditorAgentRequest,
  EditorAgentResponse,
  SUBJECT_VISION_ERROR_CODE,
  SubjectVisionFailure,
  finiteNumber,
  stringValue
} from './editor-agent-api';
import {
  buildProjectPlan,
  clipAt,
  clipBounds,
  clipsNeedingAnalysis,
  cutTimeOf,
  effectiveEdits,
  isOverridden,
  isTrimmed,
  keepRangesFor,
  removedRanges,
  slicePlan,
  sourceDuration,
  sourceTimeAt,
  transitionAt,
  trimmedDuration,
  effectiveClipVideoEffects,
  videoEffectSlotFor,
  videoEffectsOverlap
} from './video-editor-timeline';
import {
  ProjectPreset,
  SettingsDocument,
  looksLikeSettingsDocument,
  presetFrom,
  readPresets,
  settingsDocumentFrom,
  settingsFrom,
  writePresets
} from './video-editor-presets';
import {
  StoredHandle,
  fileFromHandle,
  forgetHandles,
  handlesFromDrop,
  handlesSupported,
  pickFilesWithHandles,
  newHandleId,
  recallHandle,
  recallHandleById,
  onFilesChosenThroughPicker,
  rememberHandle,
  rememberHandleAs
} from './file-handle-store';
import { AllowedFoldersComponent } from './allowed-folders.component';
import {
  ClipAudioMode,
  ClipCaption,
  ClipEdits,
  ClipImage,
  ClipImageSource,
  ClipVideoEffect,
  ClipPlan,
  ClipSoundPlan,
  EditableRange,
  EditorCanceledError,
  EditorClip,
  EditorError,
  FrameAspect,
  ManualZoom,
  MediaClip,
  MediaSummary,
  PlayableClip,
  ProjectPlan,
  RenderLogEntry,
  RenderLogKind,
  RenderProgress,
  RenderResult,
  ProjectSettings,
  ReframeFit,
  ResolutionPreset,
  SoundFade,
  SuppliedSound,
  TextClip,
  TransitionClip,
  TransitionPlan,
  TransitionSettings,
  TimeRange,
  isMediaClip,
  isPlayable,
  isTextClip,
  isTransitionClip,
  technicalDetail
} from './video-editor.models';

/** Above this the browser is likely to run out of room before finishing. */
const LARGE_TOTAL_BYTES = 2_000_000_000;

/** Width the text card preview is drawn at. */
const TEXT_PREVIEW_WIDTH = 560;

/** Pixel size of the still drawn on each row. Small enough to keep in memory. */
/**
 * Seconds at millisecond precision.
 *
 * `bounds.end - start` and friends carry the residue of binary floating point,
 * and that residue reaches the field: a duration clamped to the minimum showed
 * as 0.10000000000000009.
 */
function roundSeconds(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;

/**
 * Where the still is taken from, in seconds.
 *
 * Not zero: seeking to exactly the position a video already reports would not
 * fire a `seeked` event at all in some browsers, and the very first frame of a
 * recording is often the one the sensor had not settled on yet.
 */
const THUMB_TIME = 0.05;

/** A thumbnail is a nicety, so it is never allowed to hold anything up. */
const THUMB_TIMEOUT = 6000;

/**
 * How long a pause has to be before the next change counts as a new step.
 *
 * Dragging a slider produces a change every frame; treating each of them as
 * something to undo would make the undo button useless. Half a second is longer
 * than the gap between two frames of a drag and shorter than the time it takes
 * to move a hand to the next control.
 */
const HISTORY_GESTURE = 500;

/** How many steps back the reader can go. Past this the oldest is forgotten. */
const HISTORY_LIMIT = 60;

/** Shortest a clip may be left after a split or a trim, in seconds. */
const MIN_CLIP_SECONDS = 0.2;

/** How long the reader has to stop moving a control before the pauses are found again. */
const REDETECT_DELAY = 100;

/**
 * What the line above the transcript's progress bar says.
 *
 * One table for two jobs. The noise suppressor and the speech recogniser each
 * report stages of their own, and a reader watching one bar does not care which
 * of the two modules is talking — only what is happening to their recording.
 */
const TRANSCRIPT_STAGE: Record<string, string> = {
  reading: 'Reading the sound',
  loading: 'Fetching the noise model',
  downloading: 'Fetching the speech model',
  listening: 'Listening',
  writing: 'Cleaning the sound',
  levelling: 'Levelling',
  analysing: 'Measuring',
  done: 'Done'
};

/** The shortest recording worth handing to the recogniser, in seconds. */
const TRANSCRIPT_MIN_SECONDS = 0.2;

/** Where the reader last left the divider between the two panes. */
const SPLIT_KEY = 'utily.video-editor.split.v1';

/** Neither pane may be squeezed below this, however far the divider is pushed. */
const SPLIT_PROJECT_MIN = 320;
const SPLIT_PREVIEW_MIN = 480;

/** The most of the workspace the project column may take. */
const SPLIT_MAX_SHARE = 0.55;

/** How far an arrow key moves the divider, and how far with shift held. */
const SPLIT_STEP = 16;
const SPLIT_STEP_FAST = 64;

/** Where the reader last left the bottom edge of the preview. */
const VIDEO_HEIGHT_KEY = 'utily.video-editor.altura-video.v1';

/** Which of the two drawings of the queue the reader last chose. */
const VISTA_KEY = 'utily.video-editor.vista.v1';

/*
 * The board's geometry, in board units.
 *
 * Board units, not pixels: everything below is laid out at zoom 1 and the whole
 * stage is scaled as one, so these numbers stay the same whatever the reader
 * has done to the zoom. A card is deliberately taller than it is wide — it is a
 * still with a label under it, the shape a storyboard frame has always had.
 *
 * The gaps are what the arrows are drawn in, and they have to hold the plus
 * button and, where there is one, a transition chip. The horizontal gap is the
 * binding one: on a wrap the chip has the whole width of the board beside it,
 * but between two cards in a row it has only this, and a chip wider than the
 * gap would be printed over the very cards it joins. `--largura-juncao` in the
 * board's stylesheet is what holds it inside, and the two must move together.
 */
const BOARD_CARD_W = 212;
const BOARD_CARD_H = 306;
const BOARD_GAP_X = 176;
const BOARD_GAP_Y = 132;

/** Breathing room around the whole diagram, so nothing touches the frame. */
const BOARD_MARGEM = 56;

/*
 * How far the plus at each end sits from the card it hangs off.
 *
 * Inside the margin rather than out in a gap that is not there: the first card
 * has nothing to its left and the last may have nothing to its right, so these
 * two are measured against the border of the diagram instead. Half the button
 * plus its stub still lands inside `BOARD_MARGEM`, which is what keeps the fit
 * from cropping either of them.
 */
const BOARD_PONTA = 38;

/*
 * Where the board's own layout is kept.
 *
 * A key of its own, and deliberately not part of the project. Where a reader
 * has dragged a card to, and what shape they bent an arrow into, says nothing
 * about the video that comes out — it is the same file whether the board is
 * tidy or a spider's web. Putting it in the project store would change what a
 * project *is*, and every saved file and every export path with it; putting it
 * here keeps it what it is, which is a view setting.
 */
const BOARD_LAYOUT_KEY = 'utily.video-editor.board.v1';

/** How far a press has to travel before it counts as a drag rather than a click. */
const BOARD_ARRASTE_MINIMO = 4;

/*
 * Where the board's top-left corner sits, once everything on it has been found.
 *
 * Not a limit on the drag — dragging is not limited. Anything may be pulled as
 * far left or as far up as the reader likes; when the gesture ends, the whole
 * board is shifted so that the leftmost, topmost thing on it lands here, and
 * the camera is moved by the same amount so nothing appears to jump. The result
 * is a coordinate space that always starts at its own content, which is what
 * lets the board be measured, fitted and saved without ever holding a negative.
 */
const BOARD_MIN_XY = 8;

/*
 * How wide a note on the board is, in board units. Known here for the same
 * reason the transition card's width is: the board is measured with it.
 */
const BOARD_ROTULO_W = 220;
const BOARD_ROTULO_H = 40;

/** How far the corner of a note may be dragged, either way. */
const BOARD_ROTULO_MIN_W = 140;
const BOARD_ROTULO_MAX_W = 640;
const BOARD_ROTULO_MIN_H = 36;
const BOARD_ROTULO_MAX_H = 600;

/*
 * The transition card's width, in board units.
 *
 * Known here and not only in the stylesheet because the board has to be
 * measured with it: on a join that drops from one row to the next the card sits
 * out to the side of the arrow, past the last thing the cards themselves reach,
 * and a board measured without it would crop the card off at "fit".
 */
const BOARD_JUNCAO_W = 132;

/** The radius the arrows turn their corners on, in board units. */
const BOARD_RAIO_CANTO = 30;

/*
 * The two sizes that must not grow with the zoom, in screen pixels.
 *
 * A handle is a thing to grab, not a thing on the diagram: at 25% a waypoint
 * scaled with everything else would be a dot two pixels across, and at 250% it
 * would be a saucer covering the arrow it belongs to. Both are divided by the
 * zoom when they are drawn, so they stay the same size on the glass.
 */
const BOARD_ALCA_RAIO = 6;
const BOARD_HIT_LARGURA = 16;

/** How long the light takes to run down an arrow when the playhead crosses it. */
const BOARD_FLUXO_MS = 850;

/*
 * The lights that sweep round the card being watched.
 *
 * Driven from a frame loop rather than from keyframes, and the reason is the
 * one thing keyframes cannot do: change speed. A card that is asked to stop
 * has to slow down, and the next one has to wind up from nothing — CSS can
 * start and stop an animation but it cannot decelerate one, and an animation
 * cut off mid-turn reads as a dropped frame rather than as a stop.
 *
 * The speed is in degrees a second; `TAU` is how long it takes to cover about
 * two thirds of the distance to a new speed, which is what makes both the
 * slowing and the winding up feel like weight rather than like a switch.
 */
const BOARD_GIRO_VEL = 100;
const BOARD_GIRO_TAU = 0.55;

/** Below this the light is treated as stopped, and the hand-over may go on. */
const BOARD_GIRO_PARADO = 5;

/** How many breaths a second the glow takes at full speed. */
const BOARD_PULSO_HZ = 0.45;

/*
 * The floating monitor's picture: the width it opens at, and the shape it keeps.
 *
 * The shape is what the resize handle preserves — the reader chooses how big
 * the monitor is, never how distorted. The picture inside is letterboxed into
 * it, so a vertical video in a 16:9 monitor is still the right film.
 */
const BOARD_MONITOR_W = 288;
const BOARD_MONITOR_H = 162;

/** How small and how large the reader may drag the monitor. */
const BOARD_MONITOR_MIN = 200;
const BOARD_MONITOR_MAX = 760;

/** Limits on the board's zoom, and how far one press of the buttons moves it. */
const BOARD_ZOOM_MIN = 0.2;
const BOARD_ZOOM_MAX = 2.5;
const BOARD_ZOOM_PASSO = 1.15;

/** Never fill the frame completely when fitting: a hair of margin reads better. */
const BOARD_AJUSTE_FOLGA = 0.94;

/**
 * How wide a row of the board is allowed to get before it wraps.
 *
 * A single line of cards is unreadable past about half a dozen clips — the
 * reader is panning sideways to answer "how long is this video", which is the
 * one question a board is supposed to answer at a glance. Wrapping keeps the
 * diagram roughly square, which is the shape a screen is closest to.
 */
function boardColunas(total: number): number {
  if (total <= 1) return 1;
  return Math.max(2, Math.min(8, Math.ceil(Math.sqrt(total * 1.7))));
}

/**
 * One card on the board: a clip that actually plays, already placed.
 *
 * Transitions are not cards. They take no time in the finished file and have no
 * picture of their own, exactly as the list decided; on the board they belong on
 * the arrow, which is the join they describe.
 */
export interface NoBoard {
  clip: EditorClip;
  /** Where it sits in `clips` — what `move`, `remove` and `duplicate` are given. */
  indice: number;
  /** Where the card is on the board: the automatic place, or the one the reader dragged it to. */
  x: number;
  y: number;
}

/** One arrow between two cards, with whatever sits on it. */
export interface LigacaoBoard {
  id: string;
  /** The card it leaves and the card it points at. */
  de: NoBoard;
  para: NoBoard;
  /** The arrow itself. */
  d: string;
  /** Where the plus button and the transition chip are centred. */
  meioX: number;
  meioY: number;
  /**
   * The points the reader has bent the arrow through, in board units.
   *
   * The array itself is the one the layout holds for this join, not a copy:
   * dragging a handle writes straight into it, and the path is rebuilt from it.
   */
  pontos: { x: number; y: number }[];
  /** What `openInsertChooser` is given for this join. */
  inserirEm: number;
  /** The transition already at this join, or null. */
  transicao: TransitionClip | null;
  /** Where that transition sits in `clips` — what `remove` is given. */
  indiceTransicao: number;
  /**
   * True while the arrow leaves the card going roughly downwards.
   *
   * The chip that sits on it is wider than a card, and this is what says
   * whether there is a card beside the arrow for it to run into.
   */
  vertical: boolean;
}

/** The picture never goes below this, nor above this share of the window. */
const VIDEO_MIN = 160;
const VIDEO_MAX_SHARE = 0.85;

/** The composition width the preview goes back to when it leaves full screen. */
const PREVIEW_PANE_WIDTH = 960;

/** Inputs whose own undo history is worth more to the reader than ours. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

/** True when this element is somewhere words are being typed. */
function isTextEntry(element: HTMLElement): boolean {
  if (element.isContentEditable) return true;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;

  return TEXT_INPUT_TYPES.has((element as HTMLInputElement).type.toLowerCase());
}

/** One moment in the edit, kept so the reader can return to it. */
/**
 * The board's arrangement, as one undoable thing.
 *
 * Only what the reader arranged: where the cards are and what shape the arrows
 * were bent into. Where the floating monitor sits and how big it is are not in
 * here on purpose — those are a view setting like the zoom, and a reader who
 * nudged the monitor and then pressed Ctrl+Z meant the card they had just
 * dragged, not the panel they had just moved out of its way.
 */
interface LayoutBoard {
  posicoes: Record<string, { x: number; y: number }>;
  curvas: Record<string, { x: number; y: number }[]>;
  rotulos: RotuloBoard[];
}

/**
 * A note the reader has written on the board.
 *
 * It is a label and nothing else: it is not in the queue, it takes no time, it
 * is never rendered, and the export cannot see it. That is why it lives with
 * the arrangement rather than with the clips — writing "redo this bit" beside a
 * shot must not be a change to the video, and a text card, which is a shot, is
 * already how you put words *in* one.
 */
export interface RotuloBoard {
  id: string;
  x: number;
  y: number;
  texto: string;
  /**
   * The size the reader dragged it to, if they did.
   *
   * Absent means "whatever a note is": the width the stylesheet gives it, and
   * whatever height the words need. Once set, the height is a floor rather than
   * a ceiling — a note is a box of words, and words that no longer fit must not
   * be hidden by a corner somebody dragged last week.
   */
  largura?: number;
  altura?: number;
}

interface EditorSnapshot {
  clips: EditorClip[];
  project: ProjectSettings;
  /**
   * The counter every new id is drawn from.
   *
   * Part of the snapshot because a dry run has to assign the same ids as the
   * commit that follows it — otherwise the ids it reports are a lie — and
   * because a batch that rolled back should not leave the numbers it burned
   * behind it.
   */
  nextId: number;
  /**
   * The board's arrangement at this moment.
   *
   * On the same stack as the edit rather than one of its own, and that is the
   * whole point: two stacks would need the reader to know which of them Ctrl+Z
   * was about to reach into. One stack, in the order things actually happened,
   * so "take back the last thing I did" means the last thing they did — whether
   * that was moving a card or deleting one.
   */
  board: LayoutBoard;
}

/**
 * How long the page waits after the last change before writing the project.
 *
 * Dragging a slider is one gesture and a hundred changes; serialising the whole
 * timeline for each of them would make the slider stutter for no benefit,
 * because only the value it stops on is worth keeping.
 */
const SAVE_DELAY = 600;

/**
 * How many lines of the render log are kept.
 *
 * A long export writes a few lines per container, so a project of a hundred
 * clips is well inside this. The cap exists for the pathological case rather
 * than the ordinary one: an unbounded array behind a scrolling console is a
 * page that gets slower the longer the reader watches it.
 */
const LOG_LIMIT = 800;

/** Close enough to the bottom of the console to count as following it. */
const LOG_STICK = 24;

/** One line of the render log, once the page has stamped it. */
interface RenderLogLine {
  /** Stable identity for the template's `track`. */
  seq: number;
  /** Time since the export began, as the console shows it. */
  at: string;
  /**
   * Wall clock, to the millisecond.
   *
   * Elapsed time answers "how long did this step take"; it cannot be lined up
   * against anything else. A render trace read beside the MCP log, or beside
   * what the machine was doing at the time, needs the date.
   */
  clock: string;
  kind: RenderLogKind;
  text: string;
  /** Where the export had got to, as a whole number, or null before it could tell. */
  percent: number | null;
}

type AgentLogKind = 'command' | 'action' | 'done' | 'fail';
type AgentLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** A concise, user-facing account of changes requested through MCP. */
interface AgentLogLine {
  seq: number;
  timestamp: string;
  level: AgentLogLevel;
  module: string;
  kind: AgentLogKind;
  text: string;
  /**
   * How far the operation this line belongs to had got, 0..100.
   *
   * Null for a line that is not about a measurable process — a command
   * arriving, a clip being added — rather than 0, so the column stays empty
   * instead of claiming that nothing has happened yet.
   */
  percent: number | null;
}

/**
 * The same envelope the MCP side produces, for an export that failed.
 *
 * An export error used to end at a message and a stack. That is enough to know
 * something broke and not enough to hand anyone — the render log, the plan it
 * was rendering, the settings and which clip it stopped on are all needed, and
 * all were on screen a moment earlier and then gone.
 */
interface RenderDiagnostic {
  incidentId: string;
  createdAt: string;
  summary: string;
  fullText: string;
}

interface AgentDiagnostic {
  incidentId: string;
  createdAt: string;
  operation: string;
  summary: string;
  fullText: string;
  retryable: boolean;
  request: EditorAgentRequest;
}

const AGENT_LOG_LIMIT = 500;

const STAGE_LABEL: Record<RenderProgress['stage'], string> = {
  preparing: 'Preparing',
  analyzing: 'Listening to the clips',
  encoding: 'Encoding',
  muxing: 'Assembling',
  finishing: 'Finishing'
};

/**
 * A project of defaults, sharing nothing with the constants it came from.
 *
 * `DEFAULT_PROJECT` is a module-level object, so a plain spread hands the page
 * the *same* `edits` and `soundFade` objects every time — and the moment
 * anything wrote through one of them the defaults themselves would have moved.
 */
function freshProject(): ProjectSettings {
  return {
    ...DEFAULT_PROJECT,
    edits: cloneEdits(DEFAULT_EDITS),
    soundFade: { ...DEFAULT_SOUND_FADE },
    defaultAudio: null
  };
}

/**
 * What the transition dialog is open for.
 *
 * `clip` is null when the project's own default is being edited, which is the
 * only case where there is no row on the timeline to point at — and also the
 * only case where the two shots shown in the preview are a guess, since the
 * setting applies to every join at once.
 */
/**
 * What the tag dialog is being opened about.
 *
 * `clip` is null for the project's template, which is the same shape as a
 * clip's tag and is edited through the same dialog — the only differences are
 * the heading and whether "Remove" means anything.
 */
interface TagRequest {
  clip: PlayableClip | null;
  tag: ClipTag;
  heading: string;
  removable: boolean;
}

interface TransitionRequest {
  clip: TransitionClip | null;
  /** True when the row was made to open this dialog, so cancelling undoes it. */
  created: boolean;
  settings: TransitionSettings;
  before: EditorClip | null;
  after: EditorClip | null;
  heading: string;
  removable: boolean;
}

/** What the audio dialog is currently being opened for. */
interface AudioSourceTarget {
  target: EditorClip | 'project';
  heading: string;
  subheading: string;
  /** Stem offered for a recording's file name, so a download is recognisable. */
  name: string;
}

/** `holiday-clip.mp4` becomes `holiday-clip`, for naming a recording after it. */
function stemOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return (dot > 0 ? fileName.slice(0, dot) : fileName).slice(0, 40) || 'clip';
}

/**
 * Video Editor.
 *
 * The page owns the timeline and nothing else. Probing, listening and encoding
 * all live in services, and the one rule it enforces is the one the reader can
 * see: the list is the timeline, and what they drag into position is exactly
 * what plays.
 *
 * Settings work in one direction. The project's panel is the default, every
 * clip follows it, and opening a clip and changing anything gives that clip a
 * copy of its own — which it keeps until the reader hands it back. There is no
 * third state and no per-field inheritance, because "which of these eleven
 * numbers is still following the project?" is a question no one should have to
 * answer while editing.
 *
 * Nothing leaves the browser. Files are read locally and the finished video is
 * written locally, which is also why the work is visible: a long export says
 * which clip it is on rather than spinning silently.
 */
@Component({
  selector: 'app-editor-de-video',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DragDropModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    BodyPortalDirective,
    AllowedFoldersComponent,
    AudioSourceDialogComponent,
    ClipEditsPanelComponent,
    VideoEffectsGalleryComponent,
    VideoEffectPreviewComponent,
    HelpHintComponent,
    TransitionDialogComponent,
    TagDialogComponent,
    LoudnessControlComponent,
    SilenceWaveformComponent
  ,
    HelpPanelComponent],
  templateUrl: './editor-de-video.component.html',
  styleUrls: [
    './editor-de-video.component.css',
    './editor-de-video.previa.css',
    './editor-de-video.lista.css',
    './editor-de-video.board.css'
  ]
})
export class EditorDeVideoComponent implements OnInit, AfterViewChecked, OnDestroy {
  clips: EditorClip[] = [];
  project: ProjectSettings = freshProject();

  /** The clip whose dialog is open, or null. */
  editing: MediaClip | null = null;
  /** Per-clip noise configuration/diagnosis dialog. Never points at project settings. */
  noiseEditor: MediaClip | null = null;
  noiseAnalysisContent: AnalysisSettings['content'] = DEFAULT_ANALYSIS_SETTINGS.content;
  noiseAnalysisSensitivity: AnalysisSettings['sensitivity'] = DEFAULT_ANALYSIS_SETTINGS.sensitivity;
  private readonly noiseControllers = new Map<string, AbortController>();
  private readonly noiseProgress = new Map<string, SuppressionProgress>();
  /** The one caption whose full form is visible. Null means the list is fully collapsed. */
  expandedCaptionId: string | null = null;
  /** The one timed Video Effect whose gallery and timing controls are visible. */
  expandedVideoEffectId: string | null = null;
  /** The one placed picture whose placement controls are visible. */
  expandedImageId: string | null = null;
  /**
   * Who is waiting to be told where a replacement soundtrack comes from.
   *
   * Choosing "replace the sound" states an intention and leaves a question
   * open, and the question has more than one sensible answer — this clip's own
   * file, or the one the project already uses. Asking is better than picking
   * one and being wrong half the time.
   *
   * A text card asks it too: a title is a place music belongs, and the answer
   * there is the same three.
   */
  soundChooser: EditorClip | 'project' | null = null;

  /**
   * Where the sound being chosen right now is headed, or null.
   *
   * Every audio picker in this tool used to be a file input, which quietly
   * assumed the sound already existed on disk. For a soundtrack that is fair;
   * for narration over a photograph it is backwards — the reader is sitting at
   * the machine with the microphone, and the file they would be browsing for is
   * the one they have not recorded yet. So all of them now open one dialog that
   * offers both doors, and this says which lock it is opening.
   */
  audioSource: AudioSourceTarget | null = null;

  /**
   * Whether the reader is being asked what "save" means, or null.
   *
   * Two honest answers, and they are for different days: the whole edit, to
   * carry on with or move to another machine, and the settings alone, which is
   * the way of working rather than the work. Picking one silently would be
   * wrong about half the time.
   */
  saveChooser = false;

  /** The handle for a soundtrack being chosen, held between two emissions. */
  private pendingSoundHandle: StoredHandle | null = null;

  /** The key that reference was filed under, for the sound about to be attached. */
  private pendingSoundHandleId = '';

  /** The join being chosen right now, or null. */
  transitionEditor: TransitionRequest | null = null;

  /**
   * The clip whose tag is being designed, or null.
   *
   * The clip itself rather than a copy of its tag: the dialog holds its own
   * draft and only hands one back on the way out, so nothing here has to be
   * kept in step while it is open.
   */
  tagEditor: TagRequest | null = null;

  /**
   * Where a clip added from the plus between two rows will land, or null.
   *
   * The plus used to mean "text card" because that was the only thing it could
   * insert, which made it a shortcut nobody could guess at. It now asks, and
   * this holds the position while it does — zero is a real answer, so every
   * test against it has to be against `null`.
   */
  insertChooser: number | null = null;
  /**
   * Open when the reader has just switched the silence cuts on.
   *
   * Ticking the box says *what* to do and leaves *when* open: the pauses can be
   * found now, so the timeline and its length answer immediately, or left until
   * the export, which listens to whatever still needs it before encoding. Both
   * were always possible; only the second one was discoverable.
   */
  silenceTiming: 'project' | EditorClip | null = null;
  editingText: TextClip | null = null;
  preview: MediaClip | null = null;

  reading = false;
  dragging = false;
  /**
   * The project panel starts shut.
   *
   * It is a long panel of defaults, and the reader who has just dropped nine
   * files wants to see the nine files. Everything in it still applies; it is
   * one click away when it is wanted, which is far less often than it is on
   * screen.
   */
  projectOpen = false;

  /** Which export is running, or null when idle. */
  exporting: 'video' | 'audio' | null = null;
  progress: RenderProgress | null = null;

  /* ------------------------------------------------------------ the log */

  /**
   * What the encoder has said so far.
   *
   * Kept after the export finishes rather than cleared with the progress bar:
   * the moment a reader most wants to know which container something went wrong
   * on is the moment the bar has just disappeared.
   */
  renderLog: RenderLogLine[] = [];
  /** The log is what the reader watches while a render runs, so it opens with it. */
  logOpen = true;

  @ViewChild('logConsole') private logConsole?: ElementRef<HTMLDivElement>;
  private logSeq = 0;
  private logStartedAt = 0;
  /** True while the reader is at the bottom and the console should follow. */
  private logFollowing = true;
  /** Set when a line arrives, cleared once the console has been scrolled. */
  private logDirty = false;
  result: RenderResult | null = null;

  /** Commands and visible edits arriving from an attached MCP client. */
  agentLog: AgentLogLine[] = [];
  agentLogOpen = true;
  /**
   * Closed outright, not minimized.
   *
   * Minimizing left a badge on screen that could not be got rid of. A session
   * that has ended, or one the reader simply does not want to watch, should
   * leave the editor looking like the editor. What brings the panel back is an
   * AI connecting — see `onAgentConnected` — not activity from the connection
   * that was dismissed.
   */
  agentPanelDismissed = false;
  private agentLogMinimizedByUser = false;
  private stopAgentConnected: (() => void) | null = null;
  agentWorking = false;
  agentDiagnostic: AgentDiagnostic | null = null;
  agentDiagnosticMessage = '';
  renderDiagnostic: RenderDiagnostic | null = null;
  renderDiagnosticMessage = '';
  private readonly relinkFailures = new Set<string>();
  private lastRevisionReason = 'the project was opened';
  private lastRevisionAt = new Date().toISOString();
  agentCompletionOpen = false;
  agentCompletionSummary = '';
  private agentLogSeq = 0;
  private agentLogFollowing = true;
  private agentLogDirty = false;
  private agentTranscriptionQueue: Promise<void> = Promise.resolve();
  private lastAgentTranscriptStage = '';
  private agentTranscriptStageTimeout?: (stage: string) => void;
  @ViewChild('agentLogConsole') private agentLogConsole?: ElementRef<HTMLDivElement>;

  /* ------------------------------------------------------- the transcript */

  /**
   * The transcript dialog, and what it is a transcript of.
   *
   * `project` is the whole timeline; `clip` is one card, opened from that
   * card's own settings. The two differ in exactly two places — which clips are
   * listened to, and whether the first word lands at nought or at the clip's
   * place in the finished video — so they are one dialog with a scope rather
   * than two dialogs that would drift apart.
   */
  transcript: { scope: 'project' | 'clip'; clip: MediaClip | null } | null = null;

  readonly speechModels = SPEECH_MODELS;
  readonly speechLanguages = SPEECH_LANGUAGES;
  readonly subtitleFormats = SUBTITLE_FORMATS;
  readonly noiseEngines = NOISE_ENGINES;
  readonly noiseStrengths = NOISE_STRENGTHS;
  readonly noiseStrengthIds: readonly NoiseStrengthId[] = ['gentle', 'balanced', 'maximum'];

  transcriptModelId: string = SPEECH_MODELS[0].id;
  transcriptLanguage = '';
  transcriptFormatId: SubtitleFormat = 'srt';

  /**
   * Whether the sound is cleaned before it is listened to.
   *
   * Off by default, and deliberately: it is a second model to fetch and a
   * second pass over the audio, and on a recording made in a quiet room it buys
   * nothing. On a noisy one it is the difference between a transcript and a
   * page of guesses, which is why it is offered here at all rather than left as
   * a trip through another tool.
   */
  transcriptDenoise = false;
  transcriptEngine: EngineId = 'gtcrn';
  /** Index into {@link noiseStrengths}. Balanced, as in the noise tool. */
  transcriptStrengthIndex = 1;

  transcriptWorking = false;
  /** 0..1, or null while the stage genuinely cannot be measured. */
  transcriptRatio: number | null = null;
  transcriptStage = '';
  transcriptDetail = '';
  /** "Clip 2 of 7 — arrival.mp4", or empty for a single clip. */
  transcriptStep = '';
  transcriptCues: Cue[] = [];
  transcriptMessage = '';
  transcriptError = '';
  transcriptHint = '';

  private transcriptController: AbortController | null = null;
  private transcriptUrl: string | null = null;
  private transcriptPreviewKey = '';
  private transcriptPreviewText = '';

  /**
   * What the recogniser heard, per clip, on the source clock.
   *
   * Listening is the expensive half of this by a wide margin, and nothing about
   * moving a clip, trimming it or cutting its pauses changes what was said in
   * it — only where those words land. So the words are kept and re-placed, and
   * a reader who exports SubRip and then changes their mind about WebVTT, or
   * transcribes one clip and then the whole project, waits for neither.
   *
   * The key carries every setting that would change what is heard. The audio
   * itself is never kept: it is tens of megabytes a clip and the browser has
   * better uses for them.
   */
  private readonly heardByClip = new Map<string, Cue[]>();

  /**
   * Every clip being listened to right now, against how far it has got.
   *
   * A map rather than the single id this used to be, because the analysis is
   * the one part of this tool that genuinely parallelises: it runs in a worker,
   * off the main thread, and a machine with eight cores listening to one clip
   * at a time is a machine sitting idle while the reader waits. The value is
   * the ratio, or null while the engine cannot say.
   */
  readonly analyzing = new Map<string, number | null>();

  message = '';
  errorMessage = '';
  errorHint = '';
  /** Which clip the export was on when it failed, in words. */
  errorClip = '';
  /** The original failure and its stack, behind the disclosure under the message. */
  errorDetail = '';
  /** Whether that disclosure is open. Shut by default; it is for reporting bugs. */
  errorDetailOpen = false;
  notice = '';

  /** What the browser has kept of this project, once it has been written. */
  saveState: 'idle' | 'saved' | 'saved-without-thumbnails' | 'too-large' | 'unavailable' = 'idle';
  /**
   * Whether the browser is being asked to keep this project at all.
   *
   * Turned off by clearing the cache and choosing to carry on editing, which is
   * the only way that choice can mean anything: clearing the stored copy while
   * still saving would put it straight back a second later.
   */
  remembering = true;
  /** True while the clear-the-cache question is on screen. */
  cacheChooser = false;
  /** When the restored project was last saved, so the reader knows what came back. */
  restoredAt = '';

  /** Playhead inside the open clip's dialog, in source seconds. */
  playhead = 0;

  /** The whole-timeline preview: open, where it is, and what it is showing. */
  previewOpen = false;
  previewPlaying = false;
  previewEffectStatus = '';
  /** True while the preview's segmentation failure is one a retry can clear. */
  previewEffectRetryable = false;
  previewTime = 0;
  previewClipIndex = -1;
  /**
   * Whether the preview plays the edit or the material it was made from.
   *
   * On by default, because the preview exists to show the finished thing. Off
   * plays the pauses back, which is the only way to hear what a cut took out
   * and decide whether it should have — the silence cutter answers the same
   * question with the same checkbox. It changes the preview and nothing else:
   * the export always uses the reader's real settings.
   */
  previewCutsSilence = true;

  /**
   * Whether the preview is filling the screen.
   *
   * Tracked rather than read from the document on demand, because leaving
   * fullscreen can happen without this tool being told to — Escape, the
   * browser's own control, another tab taking over — and the button has to say
   * what will happen next rather than what was last asked for.
   */
  previewFullscreen = false;

  /** True while the preset drawer is on screen. */
  presetChooser = false;
  /** What the reader is calling the preset they are about to save. */
  presetName = '';
  /** The presets this browser is holding. */
  presets: ProjectPreset[] = [];

  /**
   * What is left of an export the reader stopped, or null.
   *
   * Held so the "Export the rest" button knows where to pick up. Cleared by
   * anything that changes the timeline, because a plan that has moved underneath
   * a half-written file cannot be continued into it — the second part would be
   * of a different edit.
   */
  resume: { kind: 'video' | 'audio'; index: number; total: number; part: number } | null = null;

  /** True while the reader is being asked to name a preset. */
  savingPreset = false;

  /**
   * True when this browser could open the waiting files itself, if asked.
   *
   * Firefox and Safari cannot, and a button offering to do something the
   * browser has no way of doing is worse than no button — so the reader is only
   * ever shown it where it will work.
   */
  canReconnect = false;

  /** The text card dialog's own clock, so its animation can be watched. */
  textPlaying = false;
  textTime = 0;

  /**
   * Whether the settings under the preview card are open. Shut to begin with.
   *
   * What the reader opened the preview for is the picture. Eleven fields
   * underneath it are for the times they did not, and on a laptop they pushed
   * the card strip off the bottom of the screen.
   */
  cardOpen = false;

  private controller: AbortController | null = null;
  /** Aborted to stop an export cleanly at the next clip boundary. */
  private stopper: AbortController | null = null;
  /** One per clip being listened to, so a single clip can be called off. */
  private readonly analysisControllers = new Map<string, AbortController>();
  /** Media that arrived with usable audio and must receive its first automatic listening pass. */
  private readonly automaticListeningIds = new Set<string>();
  /** One shared drain keeps repeated MCP imports from starting an unbounded number of decoders. */
  private automaticListeningTask: Promise<void> | null = null;
  private nextId = 0;
  /** The audio mode to go back to if the chooser is dismissed. */
  private soundChooserPrevious: ClipAudioMode = 'original';
  /**
   * Thumbnails are drawn one at a time.
   *
   * Each one decodes a video, and dropping thirty files at once would otherwise
   * start thirty decoders together — which on a laptop means the page stops
   * responding for as long as it takes them all to finish.
   */
  private thumbQueue: Promise<void> = Promise.resolve();
  private player: TimelinePlayer | null = null;
  /** When the preview last asked Angular to look at it. */
  private lastPreviewSync = 0;
  private textBitmap: ImageBitmap | null = null;

  /** True while the timeline is being rebuilt from storage; saving waits. */
  private restoring = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending pass of "find the pauses again from what we already measured". */
  private redetectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Whether the preview was playing when a dialog took over.
   *
   * The player decodes video on every animation frame, and a dialog opens its
   * own `<video>` on top of it — two decoders competing for the same machine is
   * what made opening a card feel like the page had seized up. So the preview
   * stands down while a dialog is open, and picks up where it was afterwards.
   */
  private resumeAfterDialog = false;

  private textRaf = 0;
  private textLastNow = 0;
  private lastTextSync = 0;

  @ViewChild('textPreview') textPreview?: ElementRef<HTMLCanvasElement>;
  @ViewChild('previewCanvas') previewCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('previewVideo') previewVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('previewVideoB') previewVideoB?: ElementRef<HTMLVideoElement>;
  @ViewChild('previewAudio') previewAudio?: ElementRef<HTMLAudioElement>;
  /** The whole preview section, which is what goes on the screen by itself. */
  @ViewChild('previaSecao') previaSecao?: ElementRef<HTMLElement>;
  /** The workspace, which owns the width the divider writes. */
  @ViewChild('bancada') bancada?: ElementRef<HTMLElement>;
  /** The board's frame — what the pan and the fit are measured against. */
  @ViewChild('boardFluxo') boardFluxo?: ElementRef<HTMLElement>;
  /** The rubber band, written onto by hand while it is being dragged. */
  @ViewChild('boardSelecao') boardSelecao?: ElementRef<HTMLElement>;
  /** The one element the pan and the zoom are written onto. */
  @ViewChild('boardPalco') boardPalco?: ElementRef<HTMLElement>;
  /** The floating monitor's picture, and the panel it sits in. */
  @ViewChild('boardMonitorTela') boardMonitorTela?: ElementRef<HTMLCanvasElement>;
  @ViewChild('boardMonitor') boardMonitor?: ElementRef<HTMLElement>;

  readonly videoFormats = VIDEO_FORMATS;
  readonly audioFormats = AUDIO_FORMATS;
  readonly resolutions = RESOLUTIONS.map((option) =>
    option.value === 'auto'
      ? { ...option, label: 'Match most video clips', hint: 'Uses the resolution shared by the largest number of videos.' }
      : option
  );
  readonly imageLimits = IMAGE_SECONDS;
  readonly volumeLimits = VOLUME_LIMITS;
  readonly timelapseLimits = TIMELAPSE_TARGET;
  readonly zoomLimits = MANUAL_ZOOM_LIMITS;
  readonly aspects = ASPECTS;
  readonly reframeFits = REFRAME_FITS;
  readonly soundFadeLimits = SOUND_FADE_SECONDS;
  readonly silentCutReplacementLimits = SILENT_CUT_REPLACEMENT;
  readonly captionLimits = CAPTION_LIMITS;
  readonly captionAnimations = CAPTION_ANIMATIONS;
  readonly captionPresets = CAPTION_PRESETS;
  readonly captionPresetGroups = CAPTION_PRESET_GROUPS.map((group) => ({
    ...group,
    presets: CAPTION_PRESETS.filter((preset) => preset.group === group.id)
  }));
  readonly captionFonts = CAPTION_FONTS;
  readonly behindSubjectPositions = [
    { id: 'upper-left', label: 'Upper left', x: 0.3, y: 0.24 },
    { id: 'upper-center', label: 'Upper center', x: 0.5, y: 0.25 },
    { id: 'upper-right', label: 'Upper right', x: 0.7, y: 0.24 },
    { id: 'center-left', label: 'Center left', x: 0.34, y: 0.5 },
    { id: 'center', label: 'Center', x: 0.5, y: 0.5 },
    { id: 'center-right', label: 'Center right', x: 0.66, y: 0.5 },
  ] as const;
  readonly captionWeights = CAPTION_WEIGHTS;
  readonly tagLimits = TAG_LIMITS;
  readonly tagPositions = TAG_POSITIONS;
  readonly tagPositionLabels = TAG_POSITION_LABELS;
  readonly textLimits = TEXT_LIMITS;
  readonly fonts = FONTS;
  readonly weights = WEIGHTS;
  readonly animations = ANIMATIONS;
  readonly legibilities = LEGIBILITY_OPTIONS;
  readonly accepted = ACCEPTED_MEDIA;
  readonly acceptedImage = ACCEPTED_IMAGE;
  readonly speedLabel = speedLabel;
  readonly isMediaClip = isMediaClip;

  /* ------------------------------------------------- the queue as a board */

  /*
   * Everything below draws the queue a second way and changes nothing about it.
   *
   * The list is still the list: the same clips, the same order, the same
   * methods behind every button. The board is a different picture of the same
   * array — cards in the order the video plays them, joined by the arrows that
   * order already implies — and it is deliberately read-only about position.
   * There is nothing to drag a card to, because there is nowhere a card could
   * go that the order does not already decide; moving one means changing the
   * order, and the arrows are the order. So the layout is computed, never
   * stored, and the two views can never disagree.
   */

  /** Which drawing of the queue is on screen. The list is what opens. */
  vistaFila: 'lista' | 'board' = 'lista';

  /* The card's size, for the template to write onto every card. Bound rather
     than repeated in the stylesheet: the arrows are drawn against these two
     numbers, so a card that disagreed with them would come away from its line. */
  readonly boardCardW = BOARD_CARD_W;
  readonly boardCardH = BOARD_CARD_H;

  /** What one press of the zoom buttons does, so the template says it once. */
  readonly boardZoomPasso = BOARD_ZOOM_PASSO;

  /** The board's camera. Written onto the stage rather than bound — see `aplicarCameraBoard`. */
  boardZoom = 1;
  boardPanX = 0;
  boardPanY = 0;

  /** True while the reader is dragging the board itself. */
  boardArrastando = false;
  /** And true while they are drawing a rectangle over it to pick cards out. */
  boardSelecionandoArea = false;

  /** True while the board fills the browser window. */
  boardMaximizado = false;

  /** The card being dragged, so the click that ends the drag is not a click. */
  boardCardArrastado: string | null = null;

  /**
   * The cards picked out to be moved together, by clip id.
   *
   * A selection and nothing more: it does not change the queue, the order or
   * the export, and it is not remembered between sessions. Dragging any card
   * that is in it drags the whole of it, which is the only thing it is for.
   */
  boardSelecionados = new Set<string>();

  /**
   * Where the reader has put each card, by clip id, and what shape they have
   * bent each arrow into, by join id.
   *
   * Sparse on purpose: a clip with no entry here is wherever the automatic
   * layout puts it, so a board that has never been touched needs nothing
   * stored, and a clip added later lands in the tidy place rather than at the
   * origin.
   */
  private boardPosicoes: Record<string, { x: number; y: number }> = {};
  private boardCurvas: Record<string, { x: number; y: number }[]> = {};

  /** Where the floating monitor was left, measured from the frame's top left. */
  private boardMonitorPos: { x: number; y: number } | null = null;

  /** And how wide the reader has dragged it. The height follows from the shape. */
  private boardMonitorLargura = BOARD_MONITOR_W;

  /** The notes written on the board, and which one is being typed into. */
  boardRotulos: RotuloBoard[] = [];
  boardRotuloEditando: string | null = null;
  /** A note that has just been made and is waiting for the caret. */
  private boardRotuloFoco: string | null = null;

  /** The arrow the playhead has just crossed, lit for as long as the light runs. */
  boardFluxoLink: string | null = null;
  private boardFluxoTimer: ReturnType<typeof setTimeout> | null = null;

  /*
   * The moving light, and the hand-over from one card to the next.
   *
   * `boardCardAceso` is the card wearing it, which is not quite the card the
   * playhead is in: when the video moves on, the light stays on the card it was
   * on until it has slowed to a stop, then goes out, then runs down the arrow,
   * and only then appears on the next card and winds back up to speed. Three
   * steps in a row, so the board shows the move rather than cutting to it.
   */
  boardCardAceso: string | null = null;
  private boardAcesoSeguinte: string | null = null;
  private boardFluxoPendente: string | null = null;
  private boardGiroAngulo = 0;
  private boardGiroFase = 0;
  private boardGiroVel = 0;
  private boardGiroAlvo = 0;
  private boardGiroFrame = 0;
  private boardGiroUltimo = 0;

  /** The frame loop copying the preview's canvas into the monitor. */
  private boardEspelhoFrame = 0;



  /** Set when the camera has to be written on the next view check. */
  private boardPendente = false;
  /** Set when the board should be fitted to the frame on the next view check. */
  private boardAjustePendente = false;

  /** The layout, kept until the queue it was built from changes. */
  private boardCacheArray: EditorClip[] | null = null;
  private boardCacheItens: EditorClip[] = [];
  private boardNosCache: NoBoard[] = [];
  private boardLigacoesCache: LigacaoBoard[] = [];
  private boardLarguraCache = 0;
  private boardAlturaCache = 0;
  /** Unregisters the desktop automation bridge when this route is left. */
  private stopAgentBridge: (() => void) | null = null;
  private stopAgentSystemEvents: (() => void) | null = null;
  private stopAgentCancelBridge: (() => void) | null = null;
  private stopDesktopCloseBridge: (() => void) | null = null;
  private readonly agentOperationControllers = new Map<string, AbortController>();
  private currentAgentOperationId = '';

  constructor(
    private readonly dataService: DataService,
    private readonly probe: MediaProbeService,
    private readonly inspector: MediaInspectorService,
    private readonly analyser: AudioAnalysisService,
    private readonly selector: ProcessingEngineSelectorService,
    private readonly renderer: VideoEditorRenderService,
    readonly desktop: DesktopService,
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnInit(): void {
    this.dataService.setTituloAplicacao('Video Editor');
    if (!isPlatformBrowser(this.platformId)) return;

    this.restoreFromStorage();
    this.restoreSplit();
    this.restoreVideoHeight();
    this.restaurarVista();
    this.carregarLayoutBoard();
    this.presets = readPresets();
    // The first entry in the history is the edit as it arrived, so the very
    // first change made can be taken back like any other.
    this.pending = this.snapshot();
    this.pendingSignature = this.signature(this.pending);
    this.stopAgentBridge = this.desktop.registerAgentHandler((request) =>
      this.zone.run(() => this.handleAgentRequest(request as EditorAgentRequest))
    );
    this.stopAgentSystemEvents = this.desktop.onAgentSystemEvent((entry) => this.onAgentSystemEvent(entry));
    this.stopAgentCancelBridge = this.desktop.registerAgentCancelHandler((operationId) => this.zone.run(() => {
      this.agentOperationControllers.get(operationId)?.abort();
      this.cancelAnalyses();
      this.pushAgentLog('action', `Cancellation requested for operation ${operationId}`, 'MCP control', 'WARN');
    }));
    this.stopDesktopCloseBridge = this.desktop.registerBeforeCloseHandler(() => this.saveNow());
    this.desktop.registerRootConsentAsker((missing, reason) => this.askForFolder(missing, reason));
    // A new connection is the one thing that reopens a dismissed panel, and it
    // opens dressed as whichever client just arrived.
    this.stopAgentConnected = this.desktop.onAgentConnected(() => this.zone.run(() => {
      this.agentPanelDismissed = false;
      this.agentLogMinimizedByUser = false;
      this.agentLogOpen = true;
      this.agentLogFollowing = true;
      this.cdr.markForCheck();
    }));
    // Files chosen through showOpenFilePicker fire no change event, so the one
    // document-level listener in DesktopService cannot see them. Choosing a
    // file there means the same thing, and must allow its folder the same way.
    onFilesChosenThroughPicker((files) => void this.desktop.rememberFolders(files));
  }

  ngOnDestroy(): void {
    onFilesChosenThroughPicker(null);
    this.desktop.registerRootConsentAsker(null);
    this.stopAgentConnected?.();
    this.stopAgentConnected = null;
    this.resolveFolderRequest?.(null);
    this.stopAgentBridge?.();
    this.stopAgentBridge = null;
    this.stopAgentSystemEvents?.();
    this.stopAgentSystemEvents = null;
    this.stopAgentCancelBridge?.();
    this.stopAgentCancelBridge = null;
    this.stopDesktopCloseBridge?.();
    this.stopDesktopCloseBridge = null;
    for (const controller of this.agentOperationControllers.values()) controller.abort();
    this.agentOperationControllers.clear();
    for (const url of this.imagePreviewUrls.values()) revokeMediaObjectUrl(url);
    this.imagePreviewUrls.clear();
    this.agentVision?.dispose();
    this.agentVision = null;
    this.pararEspelhoBoard();
    this.apagarGiroBoard();
    this.controller?.abort();
    this.cancelAnalyses();
    this.cancelNoiseOperations();
    this.transcriptController?.abort();
    this.revokeTranscript();
    if (this.redetectTimer) clearTimeout(this.redetectTimer);
    this.stopTextPlayback();
    this.player?.dispose();
    this.textBitmap?.close();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // Written one last time rather than left to the timer: a reader navigating
    // away mid-edit is exactly the case the storage exists for.
    void this.saveNow();
    for (const clip of this.clips) this.release(clip);
  }

  // ------------------------------------------------------------ persistence

  /**
   * Brings back whatever the browser was holding.
   *
   * The timeline comes back whole — order, cuts, captions, settings — and
   * empty-handed: the browser may not reopen a file on its own, so every clip
   * arrives asking for its media back. That is said once, plainly, rather than
   * by leaving the reader to work out why nothing plays.
   */
  private restoreFromStorage(): void {
    const stored = readStoredProject();
    if (!stored || !stored.clips.length) return;

    this.applyRestored(restoreProject(stored));

    if (this.awaitingCount) {
      this.notice =
        `Your last project came back — ${this.awaitingCount} clip(s) are waiting for their files. Add the same ` +
        'files again and everything you had is reconnected.';
      // A browser that still holds permission for the files can simply open
      // them, and the reader never learns that anything was missing. Inside the
      // desktop application there is a second door, and it always opens.
      void this.reconnectQuietly().then(() => this.reconnectThroughApp());
      return;
    }

    this.notice = 'Your last project came back.';
    // A tick later, not now: opening the preview runs `detectChanges`, and
    // doing that from inside `ngOnInit` would be re-entering a pass Angular is
    // still in the middle of.
    setTimeout(() => void this.openTimelinePreview(), 0);
  }

  private applyRestored(restored: RestoredProject): void {
    this.restoring = true;

    try {
      // A project can be opened through MCP while newly imported media is still
      // being listened to. Stop that old work before ids from the restored
      // document can reuse the same names.
      this.cancelAnalyses();
      for (const clip of this.clips) this.release(clip);
      this.clips = restored.clips;
      this.project = restored.project;
      // Past every id the document uses, so a clip added now can never collide
      // with one that came out of storage.
      this.nextId = Math.max(restored.nextId, this.highestStoredId(restored.clips) + 1);
      this.restoredAt = restored.savedAt;
      this.revision = Math.max(this.revision, restored.projectRevision);
      this.closeAllDialogs();
      this.closeTimelinePreview();
    } finally {
      this.restoring = false;
    }

    this.touch();
  }

  private highestStoredId(clips: readonly EditorClip[]): number {
    let highest = -1;
    for (const clip of clips) {
      const number = Number(clip.id.replace(/^(clip|text|join)-/, ''));
      if (Number.isFinite(number)) highest = Math.max(highest, number);
    }
    return highest;
  }

  /** Clips whose bytes have not been handed back since the reload. */
  get awaitingCount(): number {
    return this.clips.filter((clip) => isMediaClip(clip) && clip.awaitingFile).length;
  }

  get hasAwaitingFiles(): boolean {
    return this.awaitingCount > 0 || this.awaitingSounds.length > 0;
  }

  /**
   * Soundtracks whose bytes have not been handed back either.
   *
   * A `SuppliedSound` has no `awaitingFile` flag — a restored one is a zero-byte
   * placeholder carrying the summary it was measured with, which is exactly what
   * makes it invisible: the plan still knows how long the music is, so nothing
   * else notices it is not there. Exporting against it writes silence where the
   * music was, and says nothing about why.
   */
  get awaitingSounds(): string[] {
    const names = new Set<string>();

    const check = (sound: SuppliedSound | null) => {
      if (sound && sound.file.size === 0) names.add(sound.summary.fileName);
    };

    check(this.project.defaultAudio);
    for (const clip of this.clips) {
      if (!isTransitionClip(clip)) check(clip.replacementAudio);
    }

    return Array.from(names);
  }

  /**
   * Reunites a restored timeline with the files it is waiting for.
   *
   * Matched by name and length rather than by position: a reader re-adding nine
   * files selects them in whatever order the file dialog shows, and asking them
   * to get that order right would be asking them to do the work twice. Anything
   * that matches nothing is added to the end as a new clip, because a file
   * dropped on a timeline has never meant "discard this".
   */
  async relinkFiles(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    await this.relinkWithFiles(files);
  }

  /** The matching pass itself, shared by the picker and the plain input. */
  private async relinkWithFiles(files: readonly File[]): Promise<void> {
    if (!files.length) return;

    this.clearMessages();
    const unmatched: File[] = [];
    let reconnected = 0;

    for (const file of files) {
      if (this.attachRestoredFile(file)) reconnected++;
      else unmatched.push(file);
    }

    if (reconnected) {
      this.message = `${reconnected} clip(s) reconnected.`;
      this.touch();
      this.cdr.markForCheck();
    }

    // Added after the matching pass, so a file that belongs to a waiting clip is
    // never also appended as a duplicate.
    if (unmatched.length) await this.add(unmatched);

    if (!this.hasAwaitingFiles) {
      this.notice = '';
      await this.openTimelinePreview();
    }
  }

  /** Hands one file to whatever is waiting for it. Answers whether anything was. */
  private attachRestoredFile(file: File, listen = true): boolean {
    let used = false;

    for (const clip of this.clips) {
      if (isMediaClip(clip) && clip.awaitingFile && clip.fileRef && matchesRef(file, clip.fileRef)) {
        clip.file = file;
        clip.awaitingFile = false;
        clip.info = null;
        if (!clip.thumbUrl) this.enqueueThumbnail(clip);
        // Listening moves the revision when it finishes, minutes later and
        // with nothing in the log. A reconnect must not start it: the analysis
        // was saved with the project it is restoring.
        if (listen) this.queueAutomaticListening([clip]);
        used = true;
      }

      // A soundtrack is a file too, on a card as much as on a clip, and a
      // project restored with one would otherwise fall silent where the reader
      // had put music.
      if (isTransitionClip(clip)) continue;

      const replacement = clip.replacementAudio;
      if (replacement && replacement.file.size === 0 && replacement.file.name === file.name) {
        // The whole sound, not just the file: `trimStart` and the reader's
        // choice about it were measured once and restored from the document, and
        // dropping them here would make a soundtrack that was skipping its own
        // head silence start playing it again.
        clip.replacementAudio = { ...replacement, file };
        used = true;
      }

      if (!isMediaClip(clip) && clip.backgroundRef && !clip.backgroundFile && matchesRef(file, clip.backgroundRef)) {
        clip.backgroundFile = file;
        clip.backgroundUrl = mediaObjectUrl(file);
        used = true;
      }

      // Placed pictures come back the same way the media does: by the reference
      // the document kept, never by anything stored in it. The placement itself
      // is untouched, so a picture handed back lands exactly where it was.
      if (isMediaClip(clip)) {
        for (const image of clip.images ?? []) {
          if (!image.source.awaitingFile || !image.source.fileRef) continue;
          if (!matchesRef(file, image.source.fileRef)) continue;
          this.releaseImagePreview(image);
          forgetImage(image.source);
          image.source = { ...image.source, file, awaitingFile: false };
          void loadImage(image.source);
          used = true;
        }
      }
    }

    const fallback = this.project.defaultAudio;
    if (fallback && fallback.file.size === 0 && fallback.file.name === file.name) {
      // As above: the measured head silence and the reader's choice about it
      // survive the round-trip through the document and must survive this too.
      this.project = { ...this.project, defaultAudio: { ...fallback, file } };
      used = true;
    }

    return used;
  }

  /** Writes the project after the reader has stopped changing it. */
  private scheduleSave(): void {
    if (this.restoring || !this.remembering || !isPlatformBrowser(this.platformId)) return;

    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.zone.run(() => {
        void this.saveNow();
        this.cdr.markForCheck();
      });
    }, SAVE_DELAY);
  }

  private async saveNow(): Promise<void> {
    if (this.restoring || !this.remembering || !isPlatformBrowser(this.platformId)) return;

    if (!this.clips.length) {
      clearStoredProject();
      this.saveState = 'idle';
      if (this.desktop.isDesktop) {
        await this.desktop.clearProjectCheckpoint(this.revision).catch((error) => {
          this.notice = `The timeline was cleared, but desktop recovery could not be cleared: ${error instanceof Error ? error.message : String(error)}`;
          this.cdr.markForCheck();
        });
      }
      return;
    }

    this.saveState = writeStoredProject(this.clips, this.project, this.nextId, this.revision);
    if (this.desktop.isDesktop) {
      const recoveryDocument = serializeProject(this.clips, this.project, this.nextId, {
        projectRevision: this.revision
      });
      await this.desktop.checkpointProject(recoveryDocument, this.revision).catch((error) => {
        this.notice = `The browser copy was saved, but desktop recovery could not be updated: ${error instanceof Error ? error.message : String(error)}`;
        this.cdr.markForCheck();
      });
    }
  }

  openSaveChooser(): void {
    this.saveChooser = true;
    this.suspendPreview();
    this.cdr.markForCheck();
  }

  closeSaveChooser(): void {
    this.saveChooser = false;
    this.resumePreview();
    this.cdr.markForCheck();
  }

  /** Writes one JSON document to disk under a dated name. */
  private writeDocument(content: unknown, prefix: string): void {
    if (typeof document === 'undefined') return;

    const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    anchor.href = url;
    anchor.download = `${prefix}-${stamp}.json`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** The whole edit: the clips, their cuts, their tags, and every setting. */
  exportProject(): void {
    this.writeDocument(serializeProject(this.clips, this.project, this.nextId, { projectRevision: this.revision }), 'video-editor-project');
    this.saveChooser = false;
    this.resumePreview();
    this.message = 'Project saved. It holds the edit, not the media — open it and add the same files again.';
  }

  /**
   * The same settings, kept in this browser under a name instead of in a file.
   *
   * The third door, and the one most days want: a file is for moving a way of
   * working to another machine or keeping it beside the footage, and a preset
   * is for reaching it again tomorrow without finding anything. They hold
   * exactly the same thing — a preset *is* the settings document, which is why
   * the two were built on one shape.
   */
  saveAsPreset(): void {
    this.saveChooser = false;
    this.openPresets();
    // Straight to the naming field: somebody who came here through Save has
    // already decided to save, and being shown the list of old presets first
    // would be answering a question they did not ask.
    this.savingPreset = true;
    this.cdr.markForCheck();
  }

  /**
   * The settings alone: no clips, no timeline, no work.
   *
   * The same shape a preset has, in an envelope that says what it is, so the
   * one Open button can tell the two files apart without guessing from their
   * contents. The default soundtrack goes in as a reference — its name, its
   * size and what was measured from it — because a settings file that silently
   * dropped the music would not reproduce the project it was made from.
   */
  exportSettings(): void {
    this.writeDocument(settingsDocumentFrom('Saved settings', this.project), 'video-editor-settings');
    this.saveChooser = false;
    this.resumePreview();

    this.message = this.project.defaultAudio
      ? 'Settings saved. The soundtrack is in it by name — opening these settings will ask to reopen the file.'
      : 'Settings saved. No clips, no timeline — just the way this project is set up.';
  }

  /** Opens a project document written by the button above. */
  async importProject(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.clearMessages();

    try {
      const parsed: unknown = JSON.parse(await file.text());

      // One button, two documents. Which one this is has to be *stated* rather
      // than guessed at from the shape: a project with an empty timeline and a
      // settings file look alike from the outside, and a guess would get that
      // one wrong every time.
      if (looksLikeSettingsDocument(parsed)) {
        await this.applySettingsDocument(parsed, file.name);
        return;
      }

      if (!looksLikeProject(parsed)) {
        this.errorMessage = `"${file.name}" is not a video editor project or a settings file.`;
        this.errorHint = 'Choose a file written by the Save button.';
        return;
      }

      this.applyRestored(restoreProject(parsed as StoredProject));
      this.notice = this.awaitingCount
        ? `Project opened — ${this.awaitingCount} clip(s) are waiting for their files. Add the same files again to ` +
          'reconnect them.'
        : 'Project opened.';
    } catch (error) {
      this.errorMessage = `"${file.name}" could not be read.`;
      this.errorHint = 'It may be truncated or from a newer version of this tool.';
      this.errorDetail = technicalDetail(error);
    } finally {
      this.cdr.markForCheck();
    }
  }

  /**
   * Takes on a settings file, leaving the timeline where it is.
   *
   * That is the whole difference between the two documents: a project *is* the
   * work and replaces it, and settings are the way of working and are applied
   * to whatever is already on screen. Somebody opening their house style over
   * nine clips they have just added meant to keep the nine clips.
   */
  private async applySettingsDocument(document_: SettingsDocument, fileName: string): Promise<void> {
    this.project = settingsFrom(document_.preset);

    // The same two things applying a preset does, and for the same reasons: the
    // detector's settings have changed, so every cached analysis was measured
    // against numbers that are no longer the project's; and the timelapse target
    // is a different number from the one these clips were last timed to.
    this.invalidateAnalyses();
    this.applyTimelapseTarget();

    const missing = await this.claimSettingsSound();
    // Whether the banner below can offer the permission door. Set here as well
    // as on a reload, because applying settings is the other way a file starts
    // waiting — and the button is decided by what is waiting *now*.
    this.canReconnect = handlesSupported() && this.hasAwaitingFiles;
    this.touch();

    if (!missing) {
      this.message = `Settings from "${fileName}" applied.`;
      return;
    }

    // No instruction here: the banner below is already on screen with both
    // answers on it, and a sentence telling the reader to go somewhere else
    // would be sending them past the buttons that do the job.
    this.notice = `Settings from "${fileName}" applied. The soundtrack they name — ${missing} — is not open yet.`;
  }

  /**
   * Reopens the file a settings document names, asking the reader for it.
   *
   * A settings file carries the soundtrack by name and never by bytes, so the
   * file has to come from somewhere. If this browser kept a handle for it when
   * it was first chosen, this is the moment to use it — and the moment to *ask*
   * rather than merely query, because the reader just opened a file and a
   * prompt is what they are expecting. It is the one permission question this
   * tool asks, and it is asked once.
   *
   * Answers with the name of the file it could not get, or the empty string.
   */
  private async claimSettingsSound(): Promise<string> {
    const sound = this.project.defaultAudio;
    if (!sound || sound.file.size > 0) return '';

    // The id first: it is what the settings document actually carries, and it
    // still finds the file after a rename. The name and size are the fallback,
    // for a soundtrack chosen before ids existed.
    const handle =
      (await recallHandleById(sound.handleId ?? '')) ??
      (await recallHandle({ name: sound.summary.fileName, size: sound.summary.fileSize }));
    if (handle) {
      const file = await fileFromHandle(handle, true);
      if (file) {
        this.project = { ...this.project, defaultAudio: { ...sound, file } };
        return '';
      }
    }

    return sound.summary.fileName;
  }

  // -------------------------------------------------------- clearing the cache

  /**
   * Asks what "clear the cache" is supposed to mean here, rather than guessing.
   *
   * There are two honest answers and they are very different: throw away what
   * the browser is holding but carry on with the edit that is on screen, or
   * throw away both. Picking one would be wrong about half the time, and the
   * wrong half costs the reader an afternoon's work.
   */
  openCacheChooser(): void {
    this.cacheChooser = true;
  }

  closeCacheChooser(): void {
    this.cacheChooser = false;
    this.resumePreview();
  }

  /** How much of the browser's allowance the stored project is using. */
  get cacheBytes(): number {
    return storedProjectBytes();
  }

  get hasCache(): boolean {
    return this.cacheBytes > 0;
  }

  /**
   * Forgets the stored copy and empties the timeline with it.
   *
   * The two used to be separate buttons, and separating them was the mistake:
   * a project cleared from the screen but left in storage comes back on the
   * next reload, and one cleared from storage while still on screen is written
   * again on the next keystroke.
   */
  clearCacheAndTimeline(): void {
    this.cacheChooser = false;
    this.remembering = true;
    // `clear` already wipes storage and cancels the pending write, so there is
    // nothing left to do here beyond emptying the timeline.
    this.clear();
  }

  /** Starts keeping the project again after it was told to stop. */
  rememberAgain(): void {
    this.remembering = true;
    this.notice = '';
    void this.saveNow();
  }

  /** The names the timeline is still waiting for, for the message that asks. */
  get awaitingNames(): string[] {
    return this.clips
      .filter((clip): clip is MediaClip => isMediaClip(clip) && Boolean(clip.awaitingFile))
      .map((clip) => clip.summary.fileName);
  }

  /**
   * Every waiting file, named and measured.
   *
   * The size and the date are here because the folder cannot be. A page is
   * never told where a file came from — not its drive, not its directory, not
   * even through a handle, which carries only a name — so "show the full path"
   * is a question the browser refuses to answer, deliberately, since the answer
   * would spell out somebody's username and how their disk is arranged. What is
   * knowable is what the file *was*: 412 MB, last written on a Tuesday in
   * March. That is enough to pick it out of a folder of near-identical names,
   * which is the job the path was being asked to do.
   */
  get awaitingDetails(): { name: string; detail: string }[] {
    const seen = new Set<string>();
    const rows: { name: string; detail: string }[] = [];

    const add = (name: string, size: number, modified?: number) => {
      if (seen.has(name)) return;
      seen.add(name);
      const parts = [this.formatSize(size)];
      if (modified) parts.push(new Date(modified).toLocaleDateString());
      rows.push({ name, detail: parts.join(' · ') });
    };

    for (const clip of this.clips) {
      if (isMediaClip(clip) && clip.awaitingFile && clip.fileRef) {
        add(clip.fileRef.name, clip.fileRef.size, clip.fileRef.lastModified);
      }
    }

    const sound = (supplied: SuppliedSound | null) => {
      if (supplied && supplied.file.size === 0) {
        add(supplied.summary.fileName, supplied.summary.fileSize);
      }
    };

    sound(this.project.defaultAudio);
    for (const clip of this.clips) if (!isTransitionClip(clip)) sound(clip.replacementAudio);

    return rows;
  }

  // ---------------------------------------------------------- the timeline

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragging = false;

    const files = Array.from(event.dataTransfer?.files ?? []);
    // Asked for before anything is awaited. A `DataTransfer` is emptied the
    // moment the handler yields, and a handle requested afterwards comes back
    // null with no explanation — which is how "remember where this file came
    // from" quietly stops working for dropped files.
    const handles = handlesFromDrop(event.dataTransfer);

    // A dropped file may be the one a restored clip is waiting for. Matching
    // first is what the file picker already does, and dropping had no reason to
    // behave differently.
    if (this.hasAwaitingFiles) {
      const unmatched: File[] = [];
      let reconnected = 0;

      for (const file of files) {
        if (this.attachRestoredFile(file)) reconnected++;
        else unmatched.push(file);
      }

      if (reconnected) {
        this.message = `${reconnected} clip(s) reconnected.`;
        this.touch();
      }

      if (unmatched.length) await this.add(unmatched);
      await this.rememberHandles(files, await handles);

      if (!this.hasAwaitingFiles) {
        this.notice = '';
        await this.openTimelinePreview();
      }
      return;
    }

    await this.add(files);
    await this.rememberHandles(files, await handles);
  }

  /**
   * Adds media, through the picker that remembers where it came from.
   *
   * Two dialogs do this job. `showOpenFilePicker` hands back a handle with each
   * file — a durable reference that survives a reload and lets the project open
   * itself next time — and `<input type="file">` hands back bytes and nothing
   * else. The first is used wherever it exists, and the input stays as the
   * fallback for the browsers without it. It is the same dialog to look at; the
   * difference is entirely in what the page is allowed to remember afterwards.
   */
  async chooseMedia(input: HTMLInputElement): Promise<void> {
    const picked = await pickFilesWithHandles(true);
    if (!picked) {
      input.click();
      return;
    }
    if (!picked.files.length) return;

    await this.add(picked.files);
    await this.rememberHandles(picked.files, picked.handles);
  }

  /** The same, for the plus between two rows. */
  async chooseInsertMedia(input: HTMLInputElement): Promise<void> {
    const at = this.insertChooser ?? this.clips.length;

    const picked = await pickFilesWithHandles(true);
    if (!picked) {
      input.click();
      return;
    }

    this.insertChooser = null;
    if (!picked.files.length) return;

    await this.add(picked.files, at);
    await this.rememberHandles(picked.files, picked.handles);
  }

  /**
   * The same, for the files a restored project is waiting for.
   *
   * Worth the picker more than anywhere else: these are exactly the files that
   * will be waited for again after the next reload, and handing them back
   * through the plain input would guarantee the same message a second time.
   */
  async chooseRelinkMedia(input: HTMLInputElement): Promise<void> {
    const picked = await pickFilesWithHandles(true);
    if (!picked) {
      input.click();
      return;
    }
    if (!picked.files.length) return;

    await this.relinkWithFiles(picked.files);
    await this.rememberHandles(picked.files, picked.handles);
  }

  async onFileInput(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;

    // Copied out before the input is cleared, not after: a `FileList` is a live
    // view of the element, so resetting `value` empties the very list being
    // read from. Clearing it is what lets the same file be chosen twice.
    const files = Array.from(input.files ?? []);
    input.value = '';

    await this.add(files);
  }

  /**
   * Probes every dropped file and appends the ones that can be used.
   *
   * A file that cannot be read is reported by name and skipped rather than
   * failing the whole batch: dropping a folder of twenty clips and losing all
   * of them because one is a text file would be its own kind of bug.
   *
   * Returns the clips that made it, so a caller who added one deliberate file —
   * a photograph about to be narrated over — can carry on with it rather than
   * searching the timeline for whatever just appeared.
   */
  async add(files: readonly File[], at?: number): Promise<MediaClip[]> {
    if (!files.length || !isPlatformBrowser(this.platformId)) return [];

    this.reading = true;
    this.clearMessages();
    const rejected: string[] = [];
    // Collected first and spliced in once: inserting each file as it is probed
    // would put a batch dropped on the plus between two rows into the timeline
    // backwards, since every one after the first lands before the last.
    const added: MediaClip[] = [];

    try {
      for (const file of files) {
        try {
          const summary = await this.probe.probe(file);
          added.push({
            kind: 'media',
            id: `clip-${this.nextId++}`,
            file,
            summary,
            info: null,
            overrides: null,
            detected: [],
            manualCuts: [],
            analysis: null,
            analyzedWith: null,
            replacementAudio: null,
            caption: null,
            previewUrl: null,
            thumbUrl: null
          });
        } catch (error) {
          rejected.push(error instanceof MergeError ? error.message : `"${file.name}" could not be read.`);
        }
        this.cdr.markForCheck();
      }

      const position = at === undefined ? this.clips.length : Math.max(0, Math.min(at, this.clips.length));
      this.clips.splice(position, 0, ...added);
      for (const clip of added) this.enqueueThumbnail(clip);
      this.queueAutomaticListening(added);
    } finally {
      this.reading = false;
    }

    if (rejected.length) {
      this.errorMessage = rejected[0];
      this.errorHint = rejected.length > 1 ? `${rejected.length - 1} more file(s) were skipped for the same reason.` : '';
    }

    // Anything that arrived already recognised as a timelapse gets its speed
    // from the target straight away, so the reader sees the length they asked
    // for rather than a twenty-minute clip they then have to go and fix.
    this.applyTimelapseTarget();

    this.touch();
    this.notice =
      this.totalBytes > LARGE_TOTAL_BYTES
        ? 'This is a lot of media. Choose a save location when asked so the result is written straight to disk instead of being held in memory.'
        : '';

    // The whole point of the page is on screen the moment there is something to
    // show, rather than behind a button.
    await this.openTimelinePreview();

    // One photograph, arriving with nothing to be heard over it. That question —
    // "and what do we hear?" — is the next step rather than a setting buried in
    // the clip's dialog, and it is the whole reason there used to be a separate
    // "Add image" button. The kind is read from the file's own header by the
    // probe, so the one path can tell the three apart without being told.
    //
    // Only for a single file, and only when nothing already covers it: a batch
    // of twenty photographs ends in a dialog that could only be about one of
    // them, and a project that already has a soundtrack has no hole to fill.
    const only = added.length === 1 && this.clips.length ? added[0] : null;
    if (only && only.summary.kind === 'image' && this.arrivesSilent(only)) {
      this.openAudioSource(only);
    }

    return added;
  }

  /**
   * True for a clip that reaches the finished video with nothing to be heard.
   *
   * Deliberately not `willBeSilent`, which is about the red warning and excludes
   * still pictures — a photograph having no soundtrack of its own is not a fault
   * worth marking. Here it is simply the question of whether there is a hole.
   */
  private arrivesSilent(clip: MediaClip): boolean {
    return !clip.summary.audioUsable && this.soundFor(clip).kind !== 'file';
  }

  /**
   * Adds a full-screen text card and opens it for editing straight away.
   *
   * `index` is where it lands, which is what the plus between two rows passes:
   * a title almost always belongs *between* two shots rather than after all of
   * them, and making the reader add one and then drag it into place would be
   * work the interface can do itself.
   */
  addTextClip(index: number = this.clips.length): void {
    const clip: TextClip = {
      kind: 'text',
      id: `text-${this.nextId++}`,
      draft: { ...DEFAULT_TEXT_DRAFT },
      backgroundFile: null,
      backgroundUrl: null,
      replacementAudio: null,
      overrides: null
    };

    this.clips.splice(Math.max(0, Math.min(index, this.clips.length)), 0, clip);
    this.touch();
    this.openText(clip);
    // Opened but not started: the dialog is in front of it, and `dialogOpen`
    // is what stops the preview talking over the card being written.
    void this.openTimelinePreview();
  }

  /**
   * The clips whose pauses are not known yet, and so would be found at export.
   *
   * The same list the export walks, asked here so the question can name a
   * number and so it is never asked when there is nothing to find.
   */
  get clipsAwaitingListening(): MediaClip[] {
    const pending = clipsNeedingAnalysis(this.clips, this.project).concat(
      this.clips.filter((clip): clip is MediaClip => isMediaClip(clip) && this.isStale(clip))
    );
    return pending.filter((clip, index) => pending.indexOf(clip) === index);
  }

  /** The answer was "later": the export listens to them before it encodes. */
  cutSilenceAtExport(): void {
    this.silenceTiming = null;
    this.message = 'The pauses will be found when you export, so the length here is still the uncut one.';
    this.resumePreview();
  }

  /**
   * The answer was "now": listens to every clip that still needs it.
   *
   * One at a time, because `analyzeClip` decodes a whole file and two decoders
   * competing is what made opening a clip feel slow. It stops at the first
   * failure rather than pressing on, so the reader sees which file went wrong.
   */
  async cutSilenceNow(): Promise<void> {
    this.silenceTiming = null;
    const pending = this.clipsAwaitingListening;

    // Several at a time. The decode runs in a worker, so the only thing one
    // clip at a time ever bought was a simpler progress bar.
    await this.analyzeMany(pending);

    if (pending.length && !this.errorMessage) {
      this.message = `Listened to ${pending.length} clip(s). The timeline now shows the cut length.`;
    }
    this.resumePreview();
  }

  /** Asks what belongs at this position instead of assuming. */
  openInsertChooser(index: number): void {
    this.insertChooser = index;
  }

  closeInsertChooser(): void {
    this.insertChooser = null;
    this.resumePreview();
  }

  /** The answer was "a text card". */
  insertTextClip(): void {
    const at = this.insertChooser ?? this.clips.length;
    this.insertChooser = null;
    this.addTextClip(at);
  }

  // ------------------------------------------------------------ transitions --

  /**
   * True when a transition may go at this position.
   *
   * The rule is that a transition joins two shots, so it needs one on each side
   * and cannot sit next to another transition. Enforced here — where things are
   * added — rather than in the type, because "not first, not last, and never
   * beside another one of me" is not something a type can say.
   */
  /**
   * The clip as a transition, or null.
   *
   * A template cannot narrow a union through a type guard the way the language
   * can, so `@if (asTransition(clip); as join)` is how the markup gets hold of a
   * value it may call the transition methods with. Angular narrows an `as`
   * binding; it does not narrow `clip` itself.
   */
  asTransition(clip: EditorClip): TransitionClip | null {
    return isTransitionClip(clip) ? clip : null;
  }

  canInsertTransition(at: number): boolean {
    const before = this.clips[at - 1];
    const after = this.clips[at];

    return Boolean(before && after && !isTransitionClip(before) && !isTransitionClip(after));
  }

  /** The answer was "a transition". Adds it, then asks which one. */
  insertTransition(): void {
    const at = this.insertChooser ?? this.clips.length;
    this.insertChooser = null;
    if (!this.canInsertTransition(at)) return;

    const clip: TransitionClip = {
      kind: 'transition',
      id: `join-${this.nextId++}`,
      settings: { ...(this.project.defaultTransition ?? DEFAULT_TRANSITION) }
    };

    this.clips.splice(at, 0, clip);
    this.touch();
    this.openTransition(clip, true);
    void this.openTimelinePreview();
  }

  /** Opens a transition that is already on the timeline. */
  openTransition(clip: TransitionClip, created = false): void {
    const at = this.clips.indexOf(clip);

    this.transitionEditor = {
      clip,
      created,
      settings: { ...clip.settings },
      before: this.clips[at - 1] ?? null,
      after: this.clips[at + 1] ?? null,
      heading: 'How does this shot become the next one?',
      removable: true
    };
    this.suspendPreview();
    this.cdr.markForCheck();
  }

  /**
   * Opens the project-wide default.
   *
   * Its preview is shown against the first join in the project, which is a guess
   * — the setting applies everywhere — but a guess made of the reader's own
   * footage beats two coloured rectangles.
   */
  openDefaultTransition(): void {
    const playable = this.clips.filter((clip) => !isTransitionClip(clip));

    this.transitionEditor = {
      clip: null,
      created: false,
      settings: { ...(this.project.defaultTransition ?? DEFAULT_TRANSITION) },
      before: playable[0] ?? null,
      after: playable[1] ?? null,
      heading: 'Transition between every shot',
      removable: this.project.defaultTransition !== null
    };
    this.suspendPreview();
    this.cdr.markForCheck();
  }

  onTransitionSaved(settings: TransitionSettings): void {
    const request = this.transitionEditor;
    this.transitionEditor = null;
    if (!request) return;

    if (request.clip) request.clip.settings = settings;
    else this.project = { ...this.project, defaultTransition: settings };

    this.touch();
    this.resumePreview();
    this.cdr.markForCheck();
  }

  /** Takes the transition away: the row from the timeline, or the project default. */
  onTransitionRemoved(): void {
    const request = this.transitionEditor;
    this.transitionEditor = null;
    if (!request) return;

    if (request.clip) this.removeTransition(request.clip);
    else this.project = { ...this.project, defaultTransition: null };

    this.touch();
    this.resumePreview();
    this.cdr.markForCheck();
  }

  closeTransitionEditor(): void {
    const request = this.transitionEditor;
    this.transitionEditor = null;

    // A transition added a moment ago and then cancelled should not be left on
    // the timeline: the dialog is where it was being chosen, and cancelling it
    // means the reader never chose one. An existing join reopened and cancelled
    // stays exactly as it was, which is why the flag exists rather than a guess
    // about the settings.
    if (request?.created && request.clip) {
      this.removeTransition(request.clip);
      this.touch();
    }

    this.resumePreview();
    this.cdr.markForCheck();
  }

  private removeTransition(clip: TransitionClip): void {
    const at = this.clips.indexOf(clip);
    if (at >= 0) this.clips.splice(at, 1);
  }

  /**
   * Where this clip sits among the ones that actually play.
   *
   * Not its index in the list: a transition is a row and not a shot, so counting
   * rows would number three shots with two joins between them 1, 3, 5 — while the
   * export, which counts only what it writes, calls them 1, 2, 3.
   */
  clipNumber(clip: EditorClip): number {
    let number = 0;
    for (const candidate of this.clips) {
      if (isTransitionClip(candidate)) continue;
      number++;
      if (candidate.id === clip.id) return number;
    }
    return number;
  }

  /**
   * What to call a clip, whichever kind it is.
   *
   * One method rather than a narrowing expression repeated at every place the
   * name is shown.
   */
  clipTitle(clip: EditorClip): string {
    if (isMediaClip(clip)) return clip.summary.fileName;
    if (isTextClip(clip)) return clip.draft.text.split('\n')[0] || 'Text card';

    return this.transitionLabel(clip);
  }

  /** The icon that goes with it. */
  clipIcon(clip: EditorClip): string {
    if (isMediaClip(clip)) {
      return clip.summary.kind === 'video' ? 'movie' : clip.summary.kind === 'image' ? 'image' : 'audiotrack';
    }

    return isTextClip(clip) ? 'title' : 'animation';
  }

  /** The animation's name, for the row on the timeline. */
  transitionLabel(clip: TransitionClip): string {
    return transitionDefinition(clip.settings.kind).label;
  }

  /**
   * Why this transition is doing nothing.
   *
   * A transition dragged to the top of the list, or next to another one, has
   * nothing to join. The planner ignores it, which is the right thing for the
   * planner to do and a silent thing for the reader — so the row says so.
   */
  transitionOrphan(clip: TransitionClip): boolean {
    // The plan is the authority: if it built a join from this row, the row is
    // doing something, whatever its neighbours look like. Reading the neighbours
    // here instead would be a second implementation of a rule that already has
    // one, and the two would eventually disagree.
    return this.joinFor(clip) === null;
  }

  /** True when this join could not be paid for out of silence alone. */
  transitionOverContent(clip: TransitionClip): boolean {
    return this.joinFor(clip)?.overContent ?? false;
  }

  /** How long this join actually got, once the planner had clamped it. */
  transitionSeconds(clip: TransitionClip): number {
    const entry = this.joinFor(clip);
    return entry ? entry.end - entry.start : clip.settings.seconds;
  }

  /**
   * The join the planner built from this row, or null if it built none.
   *
   * By the row's own identity rather than by its neighbours': with two
   * transitions side by side only the later one is used, and matching on
   * neighbours would credit the join to the wrong row — telling the reader the
   * one doing the work is doing nothing.
   */
  private joinFor(clip: TransitionClip): TransitionPlan | null {
    return this.plan.transitions.find((candidate) => candidate.clipId === clip.id) ?? null;
  }

  /** The project-wide default, in words, for the settings panel. */
  get defaultTransitionLabel(): string {
    const settings = this.project.defaultTransition;
    if (!settings) return 'Cuts — no transition between shots';

    return `${transitionDefinition(settings.kind).label} · ${settings.seconds.toFixed(2)}s`;
  }

  /** How many animations there are, for the line in the settings panel. */
  readonly transitionCount = TRANSITIONS.length;

  /** The answer was "a file", and the reader has now chosen which. */
  async onInsertFiles(event: Event): Promise<void> {
    const at = this.insertChooser ?? this.clips.length;
    const input = event.target as HTMLInputElement;

    // Copied out before the input is cleared: a `FileList` is a live view of
    // the element, so resetting `value` empties the very list being read from.
    const files = Array.from(input.files ?? []);
    input.value = '';

    this.insertChooser = null;
    await this.add(files, at);
  }

  /** Where the chooser is about to put things, in words. */
  get insertLabel(): string {
    if (this.insertChooser === null) return '';
    // An empty timeline has no "first clip" to go before, and the top button
    // opens this chooser with nothing on the timeline at all.
    if (!this.clips.length) return 'first';
    if (this.insertChooser === 0) return 'before the first clip';

    // Counted in shots rather than in rows, so it agrees with the numbers on the
    // rows themselves — a transition takes a row and is not a clip.
    const before = this.clips[this.insertChooser - 1];
    return before ? `after clip ${this.clipNumber(before)}` : 'at the end';
  }

  reorder(event: CdkDragDrop<EditorClip[]>): void {
    moveItemInArray(this.clips, event.previousIndex, event.currentIndex);
    this.touch();
  }

  /** Keyboard-reachable reordering, since dragging is not available to everyone. */
  move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.clips.length) return;
    moveItemInArray(this.clips, index, target);
    this.touch();
  }

  remove(index: number): void {
    const [removed] = this.clips.splice(index, 1);
    if (!removed) return;

    if (this.editing === removed) this.closeClip();
    if (this.editingText === removed) this.closeText();
    if (this.preview === removed) this.preview = null;
    // The dialogs that are *about* a clip rather than about the project. Left
    // open, they go on editing an object that is no longer on the timeline — and
    // four minutes of narration would be handed to nothing at all.
    if (this.soundChooser === removed) this.soundChooser = null;
    if (this.audioSource?.target === removed) this.audioSource = null;
    if (this.transitionEditor?.clip === removed) this.transitionEditor = null;
    if (this.tagEditor?.clip === removed) this.tagEditor = null;
    this.release(removed);
    // A preview of nothing is a black rectangle and a player holding decoders
    // for clips that are gone.
    if (!this.clips.length) this.closeTimelinePreview();
    this.touch();
  }

  duplicate(index: number): void {
    const clip = this.clips[index];
    if (!clip) return;

    // Three kinds now, written as three branches rather than a ternary chain:
    // a duplicate has to be a deep enough copy that editing one does not edit
    // the other, and what "deep enough" means is different for each of them.
    // `replacementAudio` is carried by the spread on the two that have one — a
    // duplicate of a card laid over a piece of music is a card laid over the
    // same music.
    let copy: EditorClip;

    if (isMediaClip(clip)) {
      copy = {
        ...clip,
        id: `clip-${this.nextId++}`,
        videoEffect: normalizeVideoEffect(clip.videoEffect),
        images: (clip.images ?? []).map(image => ({ ...image, id: `image-${this.nextId++}` })),
        videoEffects: (clip.videoEffects ?? []).map(effect => ({ ...effect, id: `effect-${this.nextId++}` })),
        overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
        detected: clip.detected.map((range) => ({ ...range })),
        manualCuts: clip.manualCuts.map((range) => ({ ...range })),
        caption: clip.caption ? { ...clip.caption } : null,
        captions: (clip.captions ?? []).map((caption) => ({ ...caption })),
        tag: clip.tag ? { ...clip.tag } : null,
        previewUrl: null
      };
    } else if (isTextClip(clip)) {
      copy = {
        ...clip,
        id: `text-${this.nextId++}`,
        draft: { ...clip.draft },
        overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
        tag: clip.tag ? { ...clip.tag } : null,
        backgroundUrl: null
      };
    } else {
      copy = { kind: 'transition', id: `join-${this.nextId++}`, settings: { ...clip.settings } };
    }

    this.clips.splice(index + 1, 0, copy);
    this.touch();
  }

  /**
   * Empties the timeline, and the browser's copy of it with it.
   *
   * Storage is wiped here rather than left to the debounced save to notice an
   * empty list a moment later. "Clear all" means the project is gone, and a
   * project that is gone must not be sitting in `localStorage` waiting to come
   * back on the next reload — not even for six hundred milliseconds.
   */
  clear(): void {
    this.closeAllDialogs();
    this.closeTimelinePreview();
    this.cancelAnalyses();
    for (const clip of this.clips) this.release(clip);
    this.clips = [];
    // The settings go with the clips. Leaving them behind is what made a
    // cleared project keep playing the soundtrack of the one before it: the
    // timeline was empty, but the project still held the file and still said
    // every clip should be replaced with it, so the next thing dropped in
    // arrived already carrying someone else's music.
    this.project = freshProject();
    this.restoredAt = '';
    this.notice = '';
    this.resume = null;
    // The history goes with the project. Undoing back into a timeline the
    // reader has just cleared, whose files this page no longer holds, would put
    // the tool into a state nothing else on the page agrees with.
    this.history.length = 0;
    this.future.length = 0;
    this.pending = null;
    this.pendingSignature = '';
    this.canReconnect = false;
    void forgetHandles();
    this.clearMessages();
    this.forgetStoredCopy();
    this.touch();
  }

  /** Drops the stored project now, and any write that was about to happen. */
  private forgetStoredCopy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    clearStoredProject();
    this.saveState = 'idle';
  }

  private release(clip: EditorClip): void {
    if (isMediaClip(clip)) {
      if (clip.previewUrl) URL.revokeObjectURL(clip.previewUrl);
      if (clip.noiseCleanedUrl) URL.revokeObjectURL(clip.noiseCleanedUrl);
      clip.previewUrl = null;
      clip.noiseCleanedUrl = null;
      return;
    }
    if (!isTextClip(clip)) return;
    if (clip.backgroundUrl) URL.revokeObjectURL(clip.backgroundUrl);
    clip.backgroundUrl = null;
  }

  private clearMessages(): void {
    this.message = '';
    this.errorMessage = '';
    this.errorHint = '';
    this.errorClip = '';
    this.errorDetail = '';
    this.errorDetailOpen = false;
    this.touch();
  }

  // ----------------------------------------------------------- the settings

  /** What this clip actually uses right now. */
  editsFor(clip: EditorClip): ClipEdits {
    return effectiveEdits(clip, this.project);
  }

  follows(clip: EditorClip): boolean {
    return !isOverridden(clip);
  }

  /** Applies a change to the project, and so to every clip still following it. */
  onProjectEdits(edits: ClipEdits): void {
    const previous = this.project.edits.audioMode;
    const cutWas = this.project.edits.cutSilence;
    this.project = { ...this.project, edits };
    this.invalidateAnalyses();
    this.touch();

    // Asking every clip to be replaced is only an instruction once there is
    // something to replace them with.
    if (edits.audioMode === 'replace' && previous !== 'replace' && !this.project.defaultAudio) {
      this.soundChooserPrevious = previous;
      this.soundChooser = 'project';
      return;
    }

    if (edits.cutSilence && !cutWas && this.clipsAwaitingListening.length) {
      this.silenceTiming = 'project';
    }
  }

  onLoudness(loudness: LoudnessSettings): void {
    this.project = { ...this.project, loudness };
    this.touch();
  }

  /** Sets the mostly-silence fallback as a percentage while storing a 0..1 share. */
  onSilentCutReplacementThreshold(value: string): void {
    const percentage = value.trim() ? Number(value) : Number.NaN;
    const threshold = clampSilentCutReplacementThreshold(percentage / 100);
    this.project = { ...this.project, silentCutReplacementThreshold: threshold };
    this.touch();
  }

  /**
   * Applies a change made inside a clip's dialog.
   *
   * The first such change is what gives the clip settings of its own: until
   * then it was showing the project's, and editing what you are shown has to
   * mean editing this clip rather than everything at once.
   */
  onClipEdits(clip: EditorClip, edits: ClipEdits): void {
    if (isTransitionClip(clip)) return;
    const previous = this.editsFor(clip).audioMode;
    const cutWas = this.editsFor(clip).cutSilence;

    // A speed the reader chose is a speed the timelapse target may not move
    // again. Read before the new settings are stored, because afterwards there
    // is nothing left to compare against.
    if (isMediaClip(clip) && clip.speedFromTimelapse && Math.abs(this.editsFor(clip).speed - edits.speed) > 1e-6) {
      clip.speedFromTimelapse = false;
    }

    clip.overrides = edits;
    if (isMediaClip(clip)) this.invalidateAnalysis(clip);
    this.touch();

    // Text cards ask the same question: "play a file under it" leaves open
    // which file, and the project's is only one of the two answers.
    if (edits.audioMode === 'replace' && previous !== 'replace' && !clip.replacementAudio) {
      this.soundChooserPrevious = previous;
      this.soundChooser = clip;
      return;
    }

    if (edits.cutSilence && !cutWas && this.clipsAwaitingListening.length) {
      this.silenceTiming = clip;
    }
  }

  /** Hands a clip back to the project, or gives it a copy to diverge from. */
  setFollowsProject(clip: EditorClip, follow: boolean): void {
    if (isTransitionClip(clip)) return;
    clip.overrides = follow ? null : cloneEdits(this.editsFor(clip));
    if (isMediaClip(clip)) this.invalidateAnalysis(clip);
    this.touch();
  }

  /** How many clips have stopped following the project. */
  get overriddenCount(): number {
    return this.clips.filter((clip) => isOverridden(clip)).length;
  }

  /**
   * Hands every clip back to the project at once.
   *
   * A clip forks the moment anything inside it is changed, which is the right
   * rule while editing and a trap afterwards: a reader who tried three
   * different speeds on six clips ends up with six copies of settings they no
   * longer want, and undoing that one checkbox at a time is not undoing it.
   * Nothing else about a clip is touched — its cuts, its caption and its own
   * soundtrack are decisions about that footage, not settings.
   */
  followProjectEverywhere(): void {
    for (const clip of this.clips) {
      if (isTransitionClip(clip)) continue;
      clip.overrides = null;
      if (isMediaClip(clip)) this.invalidateAnalysis(clip);
    }
    this.touch();
  }

  onResolution(value: string): void {
    this.project = { ...this.project, resolution: value as ResolutionPreset };
    this.touch();
  }

  onVideoFormat(value: string): void {
    this.project = { ...this.project, videoFormatId: value };
    this.touch();
  }

  onAudioFormat(value: string): void {
    this.project = { ...this.project, audioFormatId: value };
    this.touch();
  }

  /**
   * Changes how long a still image stays on screen.
   *
   * This is the only source duration the reader owns; every other one was
   * measured from a file. It is clamped rather than rejected so that clearing
   * the field mid-edit does not blank the timeline.
   */
  onImageSeconds(clip: MediaClip, value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    clip.summary.durationSeconds = Math.min(IMAGE_SECONDS.max, Math.max(IMAGE_SECONDS.min, parsed));
    this.touch();
  }

  // -------------------------------------------------------------- dialogs

  openClip(clip: EditorClip): void {
    if (isTransitionClip(clip)) {
      this.openTransition(clip);
      return;
    }

    if (isTextClip(clip)) {
      this.openText(clip);
      return;
    }

    // The timeline preview stands down first. Its loop decodes a frame every
    // animation frame, and the dialog is about to put a second `<video>` on the
    // same machine — two decoders competing was what made opening a card feel
    // like the page had stalled.
    if (isMediaClip(clip)) {
      this.ensureTimedCaptions(clip);
      this.ensureTimedVideoEffects(clip);
    }
    this.suspendPreview();
    this.editing = clip;
    this.expandedCaptionId = null;
    this.expandedVideoEffectId = null;
    this.playhead = 0;
    if (isPlatformBrowser(this.platformId) && !clip.awaitingFile) {
      clip.previewUrl ??= mediaObjectUrl(clip.file);
    }
  }

  closeClip(): void {
    this.editing = null;
    this.noiseEditor = null;
    this.expandedCaptionId = null;
    this.expandedVideoEffectId = null;
    this.resumePreview();
  }

  openText(clip: TextClip): void {
    this.suspendPreview();
    this.editingText = clip;
    this.textTime = 0;
    this.textPlaying = false;
    void this.refreshTextPreview();
  }

  closeText(): void {
    this.stopTextPlayback();
    this.editingText = null;
    this.textBitmap?.close();
    this.textBitmap = null;
    this.resumePreview();
  }

  openPreview(clip: EditorClip): void {
    if (!isMediaClip(clip) || !isPlatformBrowser(this.platformId) || clip.awaitingFile) return;
    this.suspendPreview();
    clip.previewUrl ??= mediaObjectUrl(clip.file);
    this.preview = clip;
  }

  closePreview(): void {
    this.preview = null;
    this.resumePreview();
  }

  /** Shuts every dialog at once, for a project being replaced under them. */
  private closeAllDialogs(): void {
    this.stopTextPlayback();
    this.editing = null;
    this.noiseEditor = null;
    this.expandedCaptionId = null;
    this.expandedVideoEffectId = null;
    this.editingText = null;
    this.preview = null;
    this.soundChooser = null;
    this.cacheChooser = false;
    this.insertChooser = null;
    this.audioSource = null;
    this.transitionEditor = null;
    this.tagEditor = null;
    this.saveChooser = false;
    this.presetChooser = false;
    this.savingPreset = false;
  }

  /** True while anything is covering the page, so the strip can stand down. */
  get dialogOpen(): boolean {
    return Boolean(
      this.editing ||
        this.noiseEditor ||
        this.editingText ||
        this.tagEditor ||
        this.saveChooser ||
        this.preview ||
        this.soundChooser ||
        this.cacheChooser ||
        this.insertChooser !== null ||
        this.audioSource ||
        this.transitionEditor ||
        this.presetChooser
    );
  }

  /**
   * Stops the timeline preview for as long as a dialog is over it.
   *
   * The flag is only ever *set*, never cleared, because dialogs stack: opening
   * a clip pauses the preview and remembers that it was playing, and opening
   * the sound dialog on top of that clip would otherwise ask a player that is
   * already paused whether it was playing, be told no, and throw the answer the
   * first dialog had recorded away. The preview would then stay frozen after
   * everything was closed, with nothing on screen to explain why.
   *
   * `resumePreview` is what clears it, once the last dialog has gone.
   */
  private suspendPreview(): void {
    if (!this.player) return;
    this.resumeAfterDialog = this.resumeAfterDialog || this.player.playing;
    if (this.player.playing) {
      this.zone.runOutsideAngular(() => this.player?.pause());
      this.previewPlaying = false;
    }
  }

  private resumePreview(): void {
    if (!this.player || !this.resumeAfterDialog || this.dialogOpen) return;
    this.resumeAfterDialog = false;
    this.zone.runOutsideAngular(() => void this.player?.play());
    this.previewPlaying = true;
  }

  // ---------------------------------------------------------- the preview

  /**
   * Opens or closes the whole-timeline preview.
   *
   * Everything about it is built from the same plan the export uses, so what it
   * shows is what will be written — with one honest exception, said plainly on
   * screen: volume levelling is measured from an analysis and applied sample by
   * sample, which is not something a media element can be asked to do.
   */
  async togglePreview(): Promise<void> {
    if (this.previewOpen) {
      this.closeTimelinePreview();
      return;
    }
    await this.openTimelinePreview();
  }

  /**
   * Opens the preview and starts it, if it is not open already.
   *
   * Called on its own whenever the timeline gains its first clip, because the
   * reader who has just added footage wants to see the footage — asking them to
   * press a button first was one step between them and the only thing the page
   * is for. It stays quiet for a project still waiting for its files: there is
   * nothing to decode yet, and a player pointed at an empty stand-in would sit
   * on a stalled load for several seconds.
   */
  async openTimelinePreview(): Promise<void> {
    if (this.previewOpen || !this.clips.length || this.hasAwaitingFiles) return;
    if (!isPlatformBrowser(this.platformId)) return;

    this.previewOpen = true;
    // The canvas belongs to a section that is only now being drawn, so the view
    // children it holds do not exist until Angular has caught up.
    await Promise.resolve();
    this.cdr.detectChanges();

    const canvas = this.previewCanvas?.nativeElement;
    const video = this.previewVideo?.nativeElement;
    const videoB = this.previewVideoB?.nativeElement;
    const audio = this.previewAudio?.nativeElement;
    if (!canvas || !video || !audio) return;

    // Built and driven outside Angular: the loop runs on every animation frame,
    // and letting each one trigger change detection would spend more time in the
    // framework than in the decoder.
    this.player = this.zone.runOutsideAngular(
      () =>
        new TimelinePlayer(
          { canvas, video, videoB, audio },
          {
            onTick: (time, index) => this.onPreviewTick(time, index),
            onEffectStatus: message => {
              // The offer to retry travels with the message: a technical
              // failure the model can recover from is worth a button, a picture
              // with nobody in it is not.
              const retryable = this.player?.subjectVisionRetryable ?? false;
              if (message === this.previewEffectStatus && retryable === this.previewEffectRetryable) return;
              this.zone.run(() => {
                this.previewEffectStatus = message;
                this.previewEffectRetryable = retryable;
                this.cdr.markForCheck();
              });
            },
            onEnded: () => this.zone.run(() => {
              this.previewPlaying = false;
              this.cdr.markForCheck();
            })
          }
        )
    );

    this.player.setPlan(this.previewPlan);

    // Open, showing its first frame, and waiting. It appears on its own the
    // moment a clip is added, and something that starts playing without being
    // asked — over whatever the reader is listening to — is startling rather
    // than helpful. The transport is right there.
    this.previewPlaying = false;
    this.resumeAfterDialog = false;
  }

  closeTimelinePreview(): void {
    // The close button is *on* the picture, so it can be pressed while the
    // picture is the whole screen. Leaving fullscreen first is tidier than
    // letting the browser drop out of it because the element it was showing
    // has just been removed from the document.
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }

    this.player?.dispose();
    this.player = null;
    this.previewOpen = false;
    this.previewPlaying = false;
    // The player this flag was about no longer exists. Left standing, it would
    // make the next unrelated dialog the reader closes start a preview they
    // never asked to play.
    this.resumeAfterDialog = false;
    this.previewClipIndex = -1;
    this.previewTime = 0;
    // "Collapsed by default" has to mean every time the preview appears, not
    // only the first time in a session — a panel left open an hour ago is not
    // a default the reader chose for the project they are opening now.
    this.cardOpen = false;
  }

  togglePlayback(): void {
    if (!this.player) return;
    this.zone.runOutsideAngular(() => this.player?.toggle());
    this.previewPlaying = this.player.playing;
    // Whatever a dialog remembered about the preview, the reader has just said
    // something newer. Without this, pausing by hand from behind an open dialog
    // is undone the moment that dialog closes.
    this.resumeAfterDialog = this.previewPlaying;
  }

  onScrub(value: string | number): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.zone.runOutsideAngular(() => this.player?.seek(parsed));
    this.previewTime = parsed;
  }

  /**
   * True for the clip the preview playhead is currently inside.
   *
   * Asked by position rather than by clip so both lists answer from the same
   * number the player reports, and only while the preview is open — a row lit
   * up with nothing playing would be pointing at a picture that is not there.
   */
  isPlayingClip(clip: EditorClip): boolean {
    return this.previewOpen && this.plan.clips[this.previewClipIndex]?.clip.id === clip.id;
  }

  /**
   * Jumps the preview to the start of a clip, from a click on its card.
   *
   * By clip rather than by position, and that is not a nicety: a transition is a
   * row in this list and takes no place at all in the finished video, so the two
   * lists have stopped being the same length. Everything that has to line one up
   * with the other now does it through the identifier they share.
   */
  playFrom(clip: EditorClip): void {
    const entry = this.previewPlan.clips.find((candidate) => candidate.clip.id === clip.id);
    if (!entry || !this.player) return;
    this.onScrub(entry.outputStart);
  }

  /**
   * A click on the row, anywhere that is not one of its own controls.
   *
   * The controls are excluded rather than allowed to fall through because a row
   * carries five of them — reorder, duplicate, remove, open, and for a still the
   * number of seconds it holds — and every one of them would otherwise move the
   * playhead as a side effect of doing its own job.
   */
  onClipRow(clip: EditorClip, event: MouseEvent): void {
    if (!this.isRowGesture(event)) return;

    void this.seekToClip(clip, event.currentTarget as HTMLElement | null);
  }

  /**
   * True when a click on a row was meant for the row.
   *
   * Three things it is not. A control inside the row — five of them, and every
   * one would otherwise move the playhead as a side effect of doing its own job.
   * The drag grip, which fires an ordinary click when the pointer moves less
   * than the drag threshold, so grabbing a row to move it and thinking better of
   * it would jump the preview. And the end of a text selection: dragging across
   * a filename to copy it finishes with a click on a plain span.
   */
  private isRowGesture(event: MouseEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, label, .drag-handle, [cdkDragHandle]')) return false;

    if (isPlatformBrowser(this.platformId)) {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return false;
    }

    return true;
  }

  /** A click on a transition row opens it, under the same three conditions. */
  onTransitionRow(clip: TransitionClip, event: MouseEvent): void {
    if (!this.isRowGesture(event)) return;
    this.openTransition(clip);
  }

  /**
   * True while a click on a row would actually do something.
   *
   * The row advertises the click with a pointer and a lit border, so it has to
   * be able to keep the promise: not during an export, and not while a clip is
   * still waiting for its file — the preview refuses to open then, and there is
   * nothing to send anywhere.
   */
  get canSeekToClips(): boolean {
    return this.exporting === null && (this.previewOpen || (this.clips.length > 0 && !this.hasAwaitingFiles));
  }

  /** The number badge does the same thing, and is the keyboard way to it. */
  onClipNumber(clip: EditorClip, event: Event): void {
    const button = event.currentTarget as HTMLElement | null;
    void this.seekToClip(clip, button?.closest('.item-clipe') as HTMLElement | null);
  }

  /**
   * Sends the preview to the start of a clip, without moving the page.
   *
   * Nothing here scrolls anything into view, and that is the point. The reader is
   * looking at the list — that is where they clicked — and pulling the page up to
   * the player would take the very row they chose off the screen. The picture
   * changes where it is; the page stays where it is.
   *
   * The one thing that *can* move the page is opening the player when it was
   * closed, because a panel appearing above the list carries everything below it
   * down. So the row is measured before and after and the difference is scrolled
   * back, which leaves it exactly where the pointer left it.
   */
  async seekToClip(clip: EditorClip, row: HTMLElement | null): Promise<void> {
    if (this.exporting !== null || isTransitionClip(clip)) return;

    const before = row?.getBoundingClientRect().top ?? null;

    if (!this.previewOpen) {
      await this.openTimelinePreview();

      const after = row?.getBoundingClientRect().top ?? null;
      if (before !== null && after !== null && isPlatformBrowser(this.platformId)) {
        window.scrollBy(0, after - before);
      }
    }

    this.playFrom(clip);
    this.cdr.markForCheck();
  }

  /**
   * Follows the playhead without redrawing the page sixty times a second.
   *
   * The scrubber only has to look continuous, and the card underneath only has
   * to change when the clip does — so Angular is woken on a clip change and
   * otherwise a few times a second, which is the difference between a preview
   * that plays smoothly and one that stutters on its own interface.
   */
  /**
   * Clears a recoverable segmentation failure without reopening the editor.
   *
   * The next drawn frame asks for its matte again, so the status either clears
   * on its own or comes back with whatever failed the second time.
   */
  retryPreviewSubjectVision(): void {
    if (!this.player?.retrySubjectVision()) return;
    this.previewEffectStatus = '';
    this.previewEffectRetryable = false;
    this.cdr.markForCheck();
  }

  private onPreviewTick(time: number, index: number): void {
    /*
     * A shot that is still dissolving has not finished.
     *
     * A transition is an overlap: for its whole length both shots are on
     * screen, and which of the two the playhead is "in" is a tie the plan
     * breaks by convention rather than by anything the reader can see. The
     * board must not act on that convention — an arrow lighting while the shot
     * it is leaving is still visible reads as the diagram running ahead of the
     * picture. So through a crossing the card that stays lit is the one being
     * left, and the hand-over waits for the join to end.
     */
    const join = transitionAt(this.previewPlan, time);
    const onScreen = join && time < join.end ? join.fromIndex : index;

    const changed = onScreen !== this.previewClipIndex;
    const anterior = this.previewClipIndex;
    this.previewTime = time;
    this.previewClipIndex = onScreen;

    const now = performance.now();
    if (!changed && now - this.lastPreviewSync < 120) return;
    this.lastPreviewSync = now;

    this.zone.run(() => {
      this.previewPlaying = this.player?.playing ?? false;
      // The board, when it is the one on screen, hands the light from the card
      // that was playing to the one that is, by way of the arrow between them.
      // Nothing else here changes: both return immediately in the list view.
      if (changed) this.trocarCardAcesoBoard(anterior, onScreen);
      this.sincronizarGiroBoard();
      this.cdr.markForCheck();
    });
  }

  /* ------------------------------------------------ the movable divider */

  /**
   * How wide the project column is, in pixels, once the reader has moved the
   * divider; null while it is wherever the stylesheet puts it.
   *
   * A plain field rather than a signal, and written straight onto the element
   * rather than through a binding. A pointer move fires up to a hundred times a
   * second, and a change-detection pass over a timeline of forty clips at that
   * rate is the difference between a divider that follows the pointer and one
   * that trails behind it.
   */
  splitWidth: number | null = null;

  /** A width read back from storage that the view has not been given yet. */
  private splitPending = false;

  /**
   * The width the divider is allowed to settle at.
   *
   * Both panes have a floor, and the project also has a ceiling as a share of
   * the workspace: a reader who drags hard in either direction gets the widest
   * or narrowest arrangement that still leaves two panes, never one pane and a
   * sliver. The stylesheet clamps the same way, so a workspace that has since
   * been made narrower cannot resurrect a width that no longer fits.
   */
  private clampSplit(container: HTMLElement, width: number): number {
    const total = container.clientWidth;
    const widest = Math.max(SPLIT_PROJECT_MIN, Math.min(total * SPLIT_MAX_SHARE, total - SPLIT_PREVIEW_MIN));
    return Math.round(Math.min(Math.max(width, SPLIT_PROJECT_MIN), widest));
  }

  private applySplit(container: HTMLElement, width: number): void {
    const settled = this.clampSplit(container, width);
    this.splitWidth = settled;
    container.style.setProperty('--largura-projeto', `${settled}px`);

    // The separator carries its own value, set here rather than bound, so that
    // assistive technology follows the drag without a binding to fight it.
    container.querySelector(':scope > .divisor')?.setAttribute('aria-valuenow', String(settled));
  }

  /** Follows the pointer until it is let go. */
  startSplit(event: PointerEvent): void {
    if (event.button !== 0) return;

    const handle = event.currentTarget as HTMLElement;
    const container = this.bancada?.nativeElement;
    const projeto = container?.querySelector<HTMLElement>(':scope > .projeto');
    if (!container || !projeto) return;

    // Without this the browser starts a text selection instead, and the whole
    // page highlights blue as the divider moves.
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);

    const from = event.clientX;
    // Measured rather than taken from `splitWidth`, which is null until the
    // divider has been moved once — the first drag has to start from whatever
    // the stylesheet decided.
    const started = projeto.getBoundingClientRect().width;

    const move = (moved: PointerEvent): void => {
      // Dragging left widens the project: the divider is its left-hand edge.
      this.applySplit(container, started + (from - moved.clientX));
    };

    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      this.rememberSplit();
    };

    // Outside Angular, for the reason given on `splitWidth`.
    this.zone.runOutsideAngular(() => {
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    });
  }

  /** The same movement from the keyboard, since a separator can be focused. */
  onSplitKey(event: KeyboardEvent): void {
    const container = this.bancada?.nativeElement;
    const projeto = container?.querySelector<HTMLElement>(':scope > .projeto');
    if (!container || !projeto) return;

    const step = event.shiftKey ? SPLIT_STEP_FAST : SPLIT_STEP;
    const width = projeto.getBoundingClientRect().width;

    if (event.key === 'ArrowLeft') this.applySplit(container, width + step);
    else if (event.key === 'ArrowRight') this.applySplit(container, width - step);
    else if (event.key === 'Home') this.resetSplit();
    else return;

    event.preventDefault();
    this.rememberSplit();
  }

  /** Back to the width the stylesheet chose. */
  resetSplit(): void {
    const container = this.bancada?.nativeElement;
    if (!container) return;

    this.splitWidth = null;
    container.style.removeProperty('--largura-projeto');
    container.querySelector(':scope > .divisor')?.removeAttribute('aria-valuenow');
    this.dropSetting(SPLIT_KEY);
  }

  private restoreSplit(): void {
    const stored = Number(this.readSetting(SPLIT_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return;

    this.splitWidth = stored;
    // The workspace is not in the document yet; the next view check applies it.
    this.splitPending = true;
  }

  private rememberSplit(): void {
    if (this.splitWidth !== null) this.saveSetting(SPLIT_KEY, String(this.splitWidth));
  }

  /*
   * Three small wrappers rather than bare `localStorage` calls: a browser set to
   * refuse site data throws on the *access*, not on the value, and an editor
   * that will not open because it could not remember where a divider was is a
   * worse failure than a divider that starts where it always did.
   *
   * Named for what they store rather than for what they do: `remember` on this
   * component is already taken, by the one that notes a step for the undo
   * stack, and two methods that both mean "keep this" would be a trap.
   */
  private readSetting(key: string): string | null {
    if (!isPlatformBrowser(this.platformId)) return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private saveSetting(key: string, value: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* nothing to do: the setting simply will not survive this session. */
    }
  }

  private dropSetting(key: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* as above. */
    }
  }

  /* ----------------------------------------------- the queue as a board */

  /** True while the board is the one on screen. */
  get modoBoard(): boolean {
    return this.vistaFila === 'board';
  }

  /**
   * Switch between the two drawings of the queue.
   *
   * Nothing about the project changes here — this is which picture is on the
   * screen, and it is remembered the way the divider and the preview height
   * are, so the reader who prefers one does not choose it again every visit.
   */
  usarVista(vista: 'lista' | 'board'): void {
    if (this.vistaFila === vista) return;
    this.vistaFila = vista;
    this.saveSetting(VISTA_KEY, vista);

    // The board has just been created, so it has no size yet: the fit waits for
    // the view check, which is the first moment the frame can be measured.
    if (vista === 'board') this.boardAjustePendente = true;
  }

  private restaurarVista(): void {
    this.vistaFila = this.readSetting(VISTA_KEY) === 'board' ? 'board' : 'lista';
    if (this.modoBoard) this.boardAjustePendente = true;
  }

  /* --- the layout ---------------------------------------------------- */

  /**
   * True while the layout still describes the queue that is actually there.
   *
   * By identity, every clip, rather than by a signature of their ids. A project
   * restored from storage rebuilds the array with the same ids in the same
   * order but with fresh objects, and a cache keyed on ids would keep pointing
   * at the clips that were thrown away — a board of stale names and stills that
   * looks right and is not. Comparing references costs the same walk the
   * signature cost and allocates nothing.
   */
  private boardCacheValido(): boolean {
    if (this.boardCacheArray !== this.clips) return false;
    const itens = this.boardCacheItens;
    if (itens.length !== this.clips.length) return false;
    for (let i = 0; i < itens.length; i++) {
      if (itens[i] !== this.clips[i]) return false;
    }
    return true;
  }

  /**
   * Places every card and works out every arrow, once per change to the queue.
   *
   * Memoised because the getters below are read from the template, which means
   * they are read on every change-detection pass — several times per keystroke
   * while a clip's name is being typed in a dialog over the board.
   */
  private construirBoard(): void {
    if (this.boardCacheValido()) return;
    this.boardCacheArray = this.clips;
    this.boardCacheItens = this.clips.slice();

    const nos: NoBoard[] = [];
    this.clips.forEach((clip, indice) => {
      if (isTransitionClip(clip)) return;
      nos.push({ clip, indice, x: 0, y: 0 });
    });

    const colunas = boardColunas(nos.length);
    const passoX = BOARD_CARD_W + BOARD_GAP_X;
    const passoY = BOARD_CARD_H + BOARD_GAP_Y;

    // Serpentine: the second row runs right to left, the third left to right
    // again. It keeps the wrap arrow a straight drop between two cards in the
    // same column instead of a long hook back across the whole diagram, and it
    // is how a contact sheet has always been read.
    nos.forEach((no, ordem) => {
      const linha = Math.floor(ordem / colunas);
      const dentro = ordem % colunas;
      const coluna = linha % 2 === 0 ? dentro : colunas - 1 - dentro;
      no.x = BOARD_MARGEM + coluna * passoX;
      no.y = BOARD_MARGEM + linha * passoY;

      // Wherever the reader last dropped it wins. A clip they have never moved
      // has no entry and keeps the tidy place, which is what lets a board be
      // half arranged by hand and half by the layout without looking like it.
      const posto = this.boardPosicoes[no.clip.id];
      if (posto) {
        no.x = posto.x;
        no.y = posto.y;
      }
    });

    const ligacoes: LigacaoBoard[] = [];
    for (let i = 0; i < nos.length - 1; i++) {
      const de = nos[i];
      const para = nos[i + 1];

      // The join owns everything between the two cards, transitions included:
      // whatever sits in `clips` between them is this arrow's business.
      let transicao: TransitionClip | null = null;
      let indiceTransicao = -1;
      for (let k = de.indice + 1; k < para.indice; k++) {
        const meio = this.clips[k];
        if (isTransitionClip(meio)) {
          transicao = meio;
          indiceTransicao = k;
        }
      }

      const id = `${de.clip.id}>${para.clip.id}`;
      const pontos = this.boardCurvas[id] ?? [];
      const geo = this.geometriaLink(de, para, pontos);

      ligacoes.push({
        id,
        de,
        para,
        pontos,
        // A new clip goes immediately before the card the arrow points at, so it
        // lands between the two — and after any transition already there, which
        // is where the list's own plus button puts it too.
        inserirEm: para.indice,
        transicao,
        indiceTransicao,
        ...geo
      });
    }

    this.boardNosCache = nos;
    this.boardLigacoesCache = ligacoes;
    this.medirBoard();
  }

  /**
   * Slides the whole board so that nothing is left of, or above, the corner.
   *
   * This is what makes the drag unlimited. A card pulled off the left-hand edge
   * would otherwise need a negative coordinate, and the board has no room for
   * one: its size is measured from zero, the fit works from that size, and the
   * saved layout would come back with cards nobody could reach. So instead of
   * refusing the drag, everything on the board — cards, bends and notes alike —
   * moves right by however far the leftmost thing overshot, and the camera
   * moves left by exactly the same amount. Nothing appears to happen, which is
   * the point: the reader dragged a card to the left and the card went left.
   *
   * Every card gets a position of its own out of this, including the ones still
   * sitting where the automatic layout put them — they have all just moved, and
   * an arrangement half-shifted would be no arrangement at all.
   */
  private normalizarBoard(): void {
    const nos = this.boardNosCache;
    if (!nos.length) return;

    let minX = Infinity;
    let minY = Infinity;
    for (const no of nos) {
      minX = Math.min(minX, no.x);
      minY = Math.min(minY, no.y);
    }
    for (const link of this.boardLigacoesCache) {
      for (const p of link.pontos) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
      }
    }
    for (const rotulo of this.boardRotulos) {
      minX = Math.min(minX, rotulo.x);
      minY = Math.min(minY, rotulo.y);
    }

    const dx = minX < BOARD_MIN_XY ? Math.round(BOARD_MIN_XY - minX) : 0;
    const dy = minY < BOARD_MIN_XY ? Math.round(BOARD_MIN_XY - minY) : 0;
    if (!dx && !dy) return;

    for (const no of nos) {
      no.x += dx;
      no.y += dy;
      this.boardPosicoes[no.clip.id] = { x: no.x, y: no.y };
    }
    for (const link of this.boardLigacoesCache) {
      for (const p of link.pontos) {
        p.x += dx;
        p.y += dy;
      }
      if (link.pontos.length) this.boardCurvas[link.id] = link.pontos;
      this.recalcularLink(link);
    }
    for (const rotulo of this.boardRotulos) {
      rotulo.x += dx;
      rotulo.y += dy;
    }

    // The content moved right; the camera moves left by the same distance, in
    // screen pixels, so the view does not lurch under the hand that let go.
    this.boardPanX -= dx * this.boardZoom;
    this.boardPanY -= dy * this.boardZoom;
    this.aplicarCameraBoard();
  }

  /**
   * The size of the diagram, from the cards that are actually in it.
   *
   * Measured rather than worked out from the number of columns, because a card
   * the reader has dragged is anywhere they left it — including well past where
   * the automatic layout would have put the last one. Recomputed at the end of
   * every drag, so the board grows to hold what is on it.
   */
  private medirBoard(): void {
    const nos = this.boardNosCache;
    if (!nos.length) {
      this.boardLarguraCache = 0;
      this.boardAlturaCache = 0;
      return;
    }

    let direita = 0;
    let base = 0;
    for (const no of nos) {
      direita = Math.max(direita, no.x + BOARD_CARD_W);
      base = Math.max(base, no.y + BOARD_CARD_H);
    }

    // The waypoints count too: an arrow bent out past the last card is part of
    // the picture, and a board measured without it would crop the bend away
    // the moment the reader pressed "fit".
    for (const link of this.boardLigacoesCache) {
      for (const p of link.pontos) {
        direita = Math.max(direita, p.x);
        base = Math.max(base, p.y);
      }
      // And so does the transition card, on the joins where it sits out to the
      // side of the arrow rather than above it.
      if (link.transicao && link.vertical) {
        direita = Math.max(direita, link.meioX + BOARD_JUNCAO_W + 34);
      }
    }

    // And the notes: one written out past the last card is still on the board,
    // and a "fit" that cropped it would be hiding what the reader wrote.
    for (const rotulo of this.boardRotulos) {
      direita = Math.max(direita, rotulo.x + (rotulo.largura ?? BOARD_ROTULO_W));
      base = Math.max(base, rotulo.y + (rotulo.altura ?? BOARD_ROTULO_H) + 20);
    }

    this.boardLarguraCache = Math.round(direita + BOARD_MARGEM);
    this.boardAlturaCache = Math.round(base + BOARD_MARGEM);
  }

  /* --- the arrows ------------------------------------------------------ */

  private centroCard(no: NoBoard): { x: number; y: number } {
    return { x: no.x + BOARD_CARD_W / 2, y: no.y + BOARD_CARD_H / 2 };
  }

  /**
   * Where a line aimed at (px, py) meets the card's edge.
   *
   * The card is a rectangle, so this is the ray from its centre scaled until
   * whichever of the two axes runs out first — the same closed form the
   * flowchart editor uses for its rectangular shapes. Nothing is stored: the
   * arrow has no anchor of its own and never needs one, which is what lets it
   * slide round the border and keep pointing at the right place while a card
   * is being dragged.
   */
  private bordaCard(no: NoBoard, px: number, py: number): { x: number; y: number } {
    const c = this.centroCard(no);
    const dx = px - c.x;
    const dy = py - c.y;
    if (dx === 0 && dy === 0) return c;

    const rx = BOARD_CARD_W / 2;
    const ry = BOARD_CARD_H / 2;
    const escala = 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);

    return { x: c.x + dx * escala, y: c.y + dy * escala };
  }

  /**
   * The whole run of the arrow: [leaves here, ...bends, arrives here].
   *
   * Each end aims at the first thing along the line rather than at the other
   * card, so an arrow bent upwards leaves through the top of the card it starts
   * on instead of setting off sideways and doubling back.
   */
  private ancorasLink(
    de: NoBoard,
    para: NoBoard,
    pontos: { x: number; y: number }[]
  ): { x: number; y: number }[] {
    const primeiro = pontos.length ? pontos[0] : this.centroCard(para);
    const ultimo = pontos.length ? pontos[pontos.length - 1] : this.centroCard(de);

    return [
      this.bordaCard(de, primeiro.x, primeiro.y),
      ...pontos.map((p) => ({ x: p.x, y: p.y })),
      this.bordaCard(para, ultimo.x, ultimo.y)
    ];
  }

  /**
   * The polyline as a path, with its corners rounded off.
   *
   * The radius is clamped to half of whichever segment it is turning out of, so
   * two bends close together round as far as they can rather than overshooting
   * each other and drawing a knot.
   */
  private caminhoBoard(P: { x: number; y: number }[]): string {
    if (P.length < 3) return `M ${P[0].x} ${P[0].y} L ${P[P.length - 1].x} ${P[P.length - 1].y}`;

    let d = `M ${P[0].x} ${P[0].y}`;
    for (let i = 1; i < P.length - 1; i++) {
      const antes = P[i - 1];
      const aqui = P[i];
      const depois = P[i + 1];
      const entra = this.pontoNaDireccaoBoard(aqui, antes, Math.min(BOARD_RAIO_CANTO, this.distanciaBoard(antes, aqui) / 2));
      const sai = this.pontoNaDireccaoBoard(aqui, depois, Math.min(BOARD_RAIO_CANTO, this.distanciaBoard(aqui, depois) / 2));
      d += ` L ${entra.x} ${entra.y} Q ${aqui.x} ${aqui.y} ${sai.x} ${sai.y}`;
    }
    const fim = P[P.length - 1];

    return `${d} L ${fim.x} ${fim.y}`;
  }

  private distanciaBoard(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private pontoNaDireccaoBoard(
    de: { x: number; y: number },
    para: { x: number; y: number },
    dist: number
  ): { x: number; y: number } {
    const l = this.distanciaBoard(de, para) || 1;

    return { x: de.x + ((para.x - de.x) / l) * dist, y: de.y + ((para.y - de.y) / l) * dist };
  }

  /** How far along the whole run the halfway mark is — where the plus goes. */
  private meioCaminhoBoard(P: { x: number; y: number }[]): { x: number; y: number } {
    let total = 0;
    for (let i = 1; i < P.length; i++) total += this.distanciaBoard(P[i - 1], P[i]);

    let andado = 0;
    const alvo = total / 2;
    for (let i = 1; i < P.length; i++) {
      const passo = this.distanciaBoard(P[i - 1], P[i]);
      if (andado + passo >= alvo) {
        const t = passo ? (alvo - andado) / passo : 0;
        return { x: P[i - 1].x + (P[i].x - P[i - 1].x) * t, y: P[i - 1].y + (P[i].y - P[i - 1].y) * t };
      }
      andado += passo;
    }

    return { x: P[0].x, y: P[0].y };
  }

  /** Everything about one arrow that depends on where its two cards are. */
  private geometriaLink(
    de: NoBoard,
    para: NoBoard,
    pontos: { x: number; y: number }[]
  ): { d: string; meioX: number; meioY: number; vertical: boolean } {
    const P = this.ancorasLink(de, para, pontos);
    const meio = this.meioCaminhoBoard(P);
    const primeiro = P[0];
    const segundo = P[1] ?? P[0];

    return {
      d: this.caminhoBoard(P),
      meioX: meio.x,
      meioY: meio.y,
      vertical: Math.abs(segundo.y - primeiro.y) > Math.abs(segundo.x - primeiro.x)
    };
  }

  /** Rebuilds one arrow in place, without touching the rest of the board. */
  private recalcularLink(link: LigacaoBoard): void {
    const geo = this.geometriaLink(link.de, link.para, link.pontos);
    link.d = geo.d;
    link.meioX = geo.meioX;
    link.meioY = geo.meioY;
    link.vertical = geo.vertical;
  }

  /** The cards, in the order the video plays them. */
  get boardNos(): NoBoard[] {
    this.construirBoard();
    return this.boardNosCache;
  }

  /** The arrows between them. */
  get boardLigacoes(): LigacaoBoard[] {
    this.construirBoard();
    return this.boardLigacoesCache;
  }

  get boardLargura(): number {
    this.construirBoard();
    return this.boardLarguraCache;
  }

  get boardAltura(): number {
    this.construirBoard();
    return this.boardAlturaCache;
  }

  /**
   * The two loose ends of the chain, each as a stub and the point at its tip.
   *
   * Worked out from where the cards actually are rather than from the row they
   * were laid out in: once a card can be dragged anywhere, "the first card is
   * at the left of its row" stops being true. The stub leaves along the
   * opposite of whatever direction the chain sets off in, so the queue reads as
   * one run in one direction however the reader has arranged it.
   */
  private pontaBoard(qual: 'entrada' | 'saida'): { toco: string; x: number; y: number } | null {
    const nos = this.boardNos;
    if (!nos.length) return null;

    const no = qual === 'entrada' ? nos[0] : nos[nos.length - 1];
    const vizinho = qual === 'entrada' ? nos[1] : nos[nos.length - 2];
    const centro = this.centroCard(no);

    // Away from the neighbour; and with no neighbour at all — one lone card —
    // the entry goes off to the left and the exit to the right, which is the
    // direction a queue of one is still read in.
    let dx = qual === 'entrada' ? -1 : 1;
    let dy = 0;
    if (vizinho) {
      const outro = this.centroCard(vizinho);
      const vx = centro.x - outro.x;
      const vy = centro.y - outro.y;
      const l = Math.hypot(vx, vy);
      if (l > 0.5) {
        dx = vx / l;
        dy = vy / l;
      }
    }

    const naBorda = this.bordaCard(no, centro.x + dx * 1000, centro.y + dy * 1000);
    const ponta = { x: naBorda.x + dx * BOARD_PONTA, y: naBorda.y + dy * BOARD_PONTA };

    return { toco: `M ${naBorda.x} ${naBorda.y} L ${ponta.x} ${ponta.y}`, ...ponta };
  }

  get boardEntrada(): { toco: string; x: number; y: number } | null {
    return this.pontaBoard('entrada');
  }

  get boardSaida(): { toco: string; x: number; y: number } | null {
    return this.pontaBoard('saida');
  }

  /** What the plus after the last card is given. */
  get boardFimIndice(): number {
    return this.clips.length;
  }

  /** Handles and hit areas divided by this stay the same size on the glass. */
  get boardAlcaRaio(): number {
    return BOARD_ALCA_RAIO / this.boardZoom;
  }

  get boardHitLargura(): number {
    return BOARD_HIT_LARGURA / this.boardZoom;
  }

  /* --- the camera ------------------------------------------------------ */

  /**
   * Writes the pan and the zoom onto the stage.
   *
   * Written rather than bound, for the reason the divider's width is: a pan is
   * a stream of pointer events, and a binding would put the whole of this
   * component — which is a very large template — through change detection on
   * every frame of the drag. One style write per frame instead, outside
   * Angular, and the fields are only there so the buttons and the fit agree
   * with what is on the element.
   */
  private aplicarCameraBoard(): void {
    const palco = this.boardPalco?.nativeElement;
    if (!palco) return;
    palco.style.transform = `translate(${this.boardPanX}px, ${this.boardPanY}px) scale(${this.boardZoom})`;
  }

  /** Zoom held at the centre of the frame — what the buttons do. */
  boardAplicarZoom(fator: number): void {
    const frame = this.boardFluxo?.nativeElement;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    this.boardZoomEm(rect.width / 2, rect.height / 2, fator);
  }

  /** Zoom held at a point in the frame, so what is under it stays put. */
  private boardZoomEm(px: number, py: number, fator: number): void {
    const novo = Math.min(BOARD_ZOOM_MAX, Math.max(BOARD_ZOOM_MIN, this.boardZoom * fator));
    if (novo === this.boardZoom) return;

    const x = (px - this.boardPanX) / this.boardZoom;
    const y = (py - this.boardPanY) / this.boardZoom;
    this.boardZoom = novo;
    this.boardPanX = px - x * novo;
    this.boardPanY = py - y * novo;
    this.aplicarCameraBoard();
  }

  /** The wheel zooms, the way it does on every other board the reader has used. */
  aoRolarBoard(evento: WheelEvent): void {
    const frame = this.boardFluxo?.nativeElement;
    if (!frame) return;
    evento.preventDefault();
    const rect = frame.getBoundingClientRect();
    this.boardZoomEm(
      evento.clientX - rect.left,
      evento.clientY - rect.top,
      evento.deltaY < 0 ? BOARD_ZOOM_PASSO : 1 / BOARD_ZOOM_PASSO
    );
  }

  /**
   * Drag the board itself.
   *
   * Only from the background: a press that started on a card is that card's
   * business — its buttons, its Edit — and stealing it would make every button
   * on the board feel broken.
   */
  aoPressionarBoard(evento: PointerEvent): void {
    if (evento.button !== 0 && evento.button !== 1) return;
    const frame = this.boardFluxo?.nativeElement;
    if (!frame) return;

    // Everything with controls of its own keeps its own presses. Without the
    // last two, pressing "zoom in" or the monitor's play button would also take
    // hold of the board and drag it out from under the hand that did it.
    const alvo = evento.target as HTMLElement | null;
    if (
      evento.button === 0 &&
      alvo?.closest('.board-card, .board-junta, .board-controles, .board-monitor, .board-rotulo')
    ) {
      return;
    }

    // Shift turns the same press into a rubber band. A plain drag stays the
    // pan, because panning is by a wide margin the more common of the two.
    if (evento.button === 0 && evento.shiftKey) {
      this.selecionarPorAreaBoard(evento);
      return;
    }

    evento.preventDefault();
    frame.setPointerCapture(evento.pointerId);
    this.boardArrastando = true;

    // A press on the background that never becomes a drag is the reader saying
    // "none of them" — which is what clicking away from a selection means
    // everywhere else.
    let moveu = false;

    const deX = evento.clientX - this.boardPanX;
    const deY = evento.clientY - this.boardPanY;

    const mover = (movido: PointerEvent): void => {
      if (Math.hypot(movido.clientX - evento.clientX, movido.clientY - evento.clientY) > BOARD_ARRASTE_MINIMO) {
        moveu = true;
      }
      this.boardPanX = movido.clientX - deX;
      this.boardPanY = movido.clientY - deY;
      this.aplicarCameraBoard();
    };

    const parar = (): void => {
      frame.removeEventListener('pointermove', mover);
      frame.removeEventListener('pointerup', parar);
      frame.removeEventListener('pointercancel', parar);
      if (frame.hasPointerCapture(evento.pointerId)) frame.releasePointerCapture(evento.pointerId);
      // Back inside Angular for this one flag: the cursor is bound to it.
      this.zone.run(() => {
        this.boardArrastando = false;
        if (!moveu) this.limparSelecaoBoard();
      });
    };

    // Outside Angular, for the reason given on `aplicarCameraBoard`.
    this.zone.runOutsideAngular(() => {
      frame.addEventListener('pointermove', mover);
      frame.addEventListener('pointerup', parar);
      frame.addEventListener('pointercancel', parar);
    });
  }

  /** The whole diagram, centred and as large as the frame allows. */
  ajustarBoard(): void {
    const frame = this.boardFluxo?.nativeElement;
    if (!frame) return;

    const rect = frame.getBoundingClientRect();
    const largura = this.boardLargura;
    const altura = this.boardAltura;
    if (!rect.width || !rect.height || !largura || !altura) return;

    const escala = Math.min(
      BOARD_ZOOM_MAX,
      Math.max(BOARD_ZOOM_MIN, Math.min(rect.width / largura, rect.height / altura) * BOARD_AJUSTE_FOLGA)
    );

    this.boardZoom = escala;
    this.boardPanX = (rect.width - largura * escala) / 2;
    this.boardPanY = (rect.height - altura * escala) / 2;
    this.aplicarCameraBoard();
  }

  /** Back to life size, at the top left of the diagram. */
  resetarBoard(): void {
    this.boardZoom = 1;
    this.boardPanX = 0;
    this.boardPanY = 0;
    this.aplicarCameraBoard();
  }

  /** The zoom as a percentage, for the read-out between the buttons. */
  get boardZoomTexto(): string {
    return `${Math.round(this.boardZoom * 100)}%`;
  }

  /**
   * The card's clip as a media clip, or null.
   *
   * The same trick `asTransition` plays, and for the same reason it gives: a
   * template cannot narrow a union through a type guard, and what it can narrow
   * is an `as` binding. The list gets away with `isMediaClip(clip) && ...`
   * because `clip` is the loop variable itself; here the clip is a property of
   * one, and leaning on the compiler to follow that path through every branch
   * of a card is a bet this file already decided not to take.
   */
  boardMidia(no: NoBoard): MediaClip | null {
    return isMediaClip(no.clip) ? no.clip : null;
  }

  /**
   * The settings this clip has of its own, one mark each.
   *
   * Only its own. A clip that follows the project's settings is drawn plain,
   * and that is the point of the row: it says at a glance which shots somebody
   * has been into and what they changed, without the reader opening seven
   * dialogs to find out. Inherited settings are the *absence* of a mark, so a
   * board of eight clips with two marked is a board with two exceptions on it.
   *
   * Two kinds go in here. Some settings have no project-wide equivalent at all
   * — a tag, a caption, a hand-made cut, a trim, a soundtrack chosen for this
   * one shot — and those are shown whenever they are set. The rest exist in
   * both places, and those are shown only when this clip's answer differs from
   * the project's.
   */
  marcasCard(no: NoBoard): { chave: string; icone: string; rotulo: string }[] {
    const clip = no.clip;
    const marcas: { chave: string; icone: string; rotulo: string }[] = [];
    const midia = this.boardMidia(no);

    if (isPlayable(clip) && clip.tag?.text.trim()) {
      marcas.push({ chave: 'tag', icone: 'sell', rotulo: `Tag: ${clip.tag.text.trim()}` });
    }
    const captions = midia?.captions?.filter((caption) => caption.text.trim()) ?? (midia?.caption?.text.trim() ? [midia.caption] : []);
    if (captions.length) marcas.push({
      chave: 'caption', icone: 'closed_caption',
      rotulo: captions.length === 1 ? `Caption: ${captions[0].text.trim()}` : `${captions.length} captions`
    });
    if (midia?.manualCuts.length) {
      const n = midia.manualCuts.length;
      marcas.push({ chave: 'cortes', icone: 'content_cut', rotulo: `${n} cut${n === 1 ? '' : 's'} made by hand` });
    }
    if (midia && (midia.inPoint != null || midia.outPoint != null)) {
      marcas.push({ chave: 'corte', icone: 'straighten', rotulo: 'Trimmed at one or both ends' });
    }
    if (isPlayable(clip) && clip.replacementAudio) {
      marcas.push({
        chave: 'som',
        icone: 'music_note',
        rotulo: `Sound of its own: ${clip.replacementAudio.summary.fileName}`
      });
    }

    // Everything below exists project-wide as well, so it is only worth a mark
    // where this clip disagrees with the project.
    if (this.follows(clip)) return marcas;

    const seus = this.editsFor(clip);
    const projeto = this.project.edits;

    if (seus.cutSilence !== projeto.cutSilence) {
      marcas.push({
        chave: 'silencio',
        icone: 'graphic_eq',
        rotulo: seus.cutSilence ? 'Silence cut on this clip only' : 'Silence kept on this clip only'
      });
    }
    if (seus.speed !== projeto.speed) {
      marcas.push({ chave: 'velocidade', icone: 'speed', rotulo: `Speed: ${this.speedLabel(seus.speed)}` });
    }
    if (seus.silence.autoZoom.enabled !== projeto.silence.autoZoom.enabled) {
      marcas.push({
        chave: 'zoom',
        icone: 'zoom_in',
        rotulo: seus.silence.autoZoom.enabled ? 'Auto zoom on this clip only' : 'Auto zoom off on this clip only'
      });
    }
    if (seus.fadeIn !== projeto.fadeIn || seus.fadeOut !== projeto.fadeOut) {
      marcas.push({ chave: 'fade', icone: 'gradient', rotulo: 'Fades of its own' });
    }
    if (seus.audioMode !== projeto.audioMode) {
      marcas.push({
        chave: 'audio',
        icone: seus.audioMode === 'mute' ? 'volume_off' : 'volume_up',
        rotulo: seus.audioMode === 'mute' ? 'Muted' : `Sound: ${seus.audioMode}`
      });
    }
    if (seus.volumePercent !== projeto.volumePercent) {
      marcas.push({ chave: 'volume', icone: 'equalizer', rotulo: `Volume: ${Math.round(seus.volumePercent)}%` });
    }

    return marcas;
  }

  /**
   * Opens the place the setting behind a mark is changed.
   *
   * Most of them live in the clip's own dialog, which is where the mark takes
   * the reader. Two do not: the soundtrack has a chooser of its own, and the
   * tag has an editor that reads the clip out of whichever dialog is open — so
   * that one opens the clip first and the tag editor on top of it, which is the
   * same two steps the row in the list takes.
   */
  abrirMarcaCard(no: NoBoard, chave: string): void {
    if (chave === 'som' && isPlayable(no.clip)) {
      this.openAudioSource(no.clip);
      return;
    }

    this.openClip(no.clip);
    if (chave === 'tag') this.openTagEditor();
  }

  /** True when the card has any pill to show, so the row is not drawn empty. */
  boardTemSelos(no: NoBoard): boolean {
    return (
      this.badges(no.clip).length > 0 ||
      this.boardMidia(no)?.summary.isTimelapse === true ||
      (!this.willBeSilent(no.clip) && this.isSilentSource(no.clip))
    );
  }

  /* --- moving things about --------------------------------------------- */

  /*
   * Both gestures below run outside Angular and write to the DOM by hand.
   *
   * The reason is the one the divider gives: a drag is a stream of pointer
   * events, and this component's template is very large. Putting the whole of
   * it through change detection sixty times a second to move one card would
   * make the card lag behind the cursor. Instead the cached geometry — which is
   * what the bindings read anyway — is updated in place, and only the handful
   * of elements that actually moved are written; one pass through Angular at
   * the end puts the bindings back in step with what is on the screen.
   */

  /** The element for a card, in whichever of the two frames the board is in. */
  private elementoCard(id: string): HTMLElement | null {
    return this.boardPalco?.nativeElement.querySelector<HTMLElement>(`[data-board-card="${CSS.escape(id)}"]`) ?? null;
  }

  private elementoLink(id: string): { seta: SVGPathElement | null; hit: SVGPathElement | null; junta: HTMLElement | null } {
    const palco = this.boardPalco?.nativeElement;
    const escapado = CSS.escape(id);

    return {
      seta: palco?.querySelector<SVGPathElement>(`[data-board-seta="${escapado}"]`) ?? null,
      hit: palco?.querySelector<SVGPathElement>(`[data-board-hit="${escapado}"]`) ?? null,
      junta: palco?.querySelector<HTMLElement>(`[data-board-junta="${escapado}"]`) ?? null
    };
  }

  /** Redraws the arrows touching a card, straight onto the elements. */
  private redesenharLinksDe(clipId: string): void {
    for (const link of this.boardLigacoesCache) {
      if (link.de.clip.id !== clipId && link.para.clip.id !== clipId) continue;
      this.recalcularLink(link);
      const el = this.elementoLink(link.id);
      el.seta?.setAttribute('d', link.d);
      el.hit?.setAttribute('d', link.d);
      if (el.junta) {
        el.junta.style.left = `${link.meioX}px`;
        el.junta.style.top = `${link.meioY}px`;
      }
    }
  }

  /**
   * Drag a card.
   *
   * The press is not a drag until it has travelled: a card is also the way to
   * send the playhead to that clip, and a hand that shakes by a pixel on the
   * way to a click should still be a click. `boardCardArrastado` is what tells
   * the click handler which of the two just happened.
   */
  aoPressionarCard(evento: PointerEvent, no: NoBoard): void {
    if (evento.button !== 0) return;
    // A press that started on a button belongs to that button.
    if ((evento.target as HTMLElement | null)?.closest('button')) return;

    // Held down, the press is about the selection rather than about moving
    // anything: it adds this card to the set, or takes it back out.
    if (evento.ctrlKey || evento.metaKey || evento.shiftKey) {
      evento.preventDefault();
      evento.stopPropagation();
      this.alternarSelecaoBoard(no.clip.id);
      return;
    }

    const card = this.elementoCard(no.clip.id);
    if (!card) return;

    // A card outside the selection replaces it. Dragging one card while five
    // others stay lit up somewhere off screen is how a reader moves things they
    // did not mean to.
    if (!this.boardSelecionados.has(no.clip.id) && this.boardSelecionados.size) {
      this.limparSelecaoBoard();
    }

    // Everything that travels with this press: the selection when the card is
    // in it, and otherwise the card alone.
    const juntos = this.boardSelecionados.has(no.clip.id)
      ? this.boardNos.filter((outro) => this.boardSelecionados.has(outro.clip.id))
      : [no];

    const alvos: { no: NoBoard; el: HTMLElement; eraX: number; eraY: number }[] = [];
    for (const outro of juntos) {
      const el = this.elementoCard(outro.clip.id);
      if (el) alvos.push({ no: outro, el, eraX: outro.x, eraY: outro.y });
    }
    if (!alvos.length) return;

    evento.preventDefault();
    evento.stopPropagation();
    card.setPointerCapture(evento.pointerId);

    const partiuX = evento.clientX;
    const partiuY = evento.clientY;
    let arrastou = false;

    const mover = (movido: PointerEvent): void => {
      const dx = movido.clientX - partiuX;
      const dy = movido.clientY - partiuY;
      if (!arrastou && Math.hypot(dx, dy) < BOARD_ARRASTE_MINIMO) return;
      if (!arrastou) {
        arrastou = true;
        this.zone.run(() => {
          this.boardCardArrastado = no.clip.id;
        });
      }

      // Divided by the zoom: the pointer moves in screen pixels and the cards
      // live in board units, and at 50% a card that followed the raw delta
      // would travel twice as far as the hand did.
      // No clamp: a card may be dragged past the left or the top edge, and the
      // board is shifted back under it when the drag ends.
      const passoX = dx / this.boardZoom;
      const passoY = dy / this.boardZoom;
      for (const alvo of alvos) {
        alvo.no.x = Math.round(alvo.eraX + passoX);
        alvo.no.y = Math.round(alvo.eraY + passoY);
        alvo.el.style.left = `${alvo.no.x}px`;
        alvo.el.style.top = `${alvo.no.y}px`;
      }
      // After every card has moved, not during it: an arrow between two cards
      // that are both travelling has to be redrawn from both ends at once, or
      // it whips about while the group moves.
      for (const alvo of alvos) this.redesenharLinksDe(alvo.no.clip.id);
    };

    const parar = (): void => {
      card.removeEventListener('pointermove', mover);
      card.removeEventListener('pointerup', parar);
      card.removeEventListener('pointercancel', parar);
      if (card.hasPointerCapture(evento.pointerId)) card.releasePointerCapture(evento.pointerId);
      if (!arrastou) return;

      this.zone.run(() => {
        for (const alvo of alvos) this.boardPosicoes[alvo.no.clip.id] = { x: alvo.no.x, y: alvo.no.y };
        this.normalizarBoard();
        this.medirBoard();
        // One entry on the undo stack for the whole move, however many cards
        // travelled in it.
        this.lembrarBoard();
        // Cleared after the click that ends this drag has been and gone, so the
        // card does not also send the playhead somewhere the reader never asked.
        setTimeout(() => {
          this.boardCardArrastado = null;
        }, 0);
      });
    };

    this.zone.runOutsideAngular(() => {
      card.addEventListener('pointermove', mover);
      card.addEventListener('pointerup', parar);
      card.addEventListener('pointercancel', parar);
    });
  }

  /* --- picking cards out ------------------------------------------------ */

  /** True while this card is in the set that moves together. */
  selecionadoBoard(no: NoBoard): boolean {
    return this.boardSelecionados.has(no.clip.id);
  }

  private alternarSelecaoBoard(id: string): void {
    // A new Set rather than one changed in place: the template reads this on
    // every pass, and a Set mutated in place looks identical to one that was
    // never touched.
    const proximo = new Set(this.boardSelecionados);
    if (proximo.has(id)) proximo.delete(id);
    else proximo.add(id);
    this.boardSelecionados = proximo;
  }

  limparSelecaoBoard(): void {
    if (!this.boardSelecionados.size) return;
    this.boardSelecionados = new Set();
  }

  /**
   * Drag a rectangle over the board to pick out everything under it.
   *
   * On shift, because a plain drag on the background is how the board is
   * panned, and panning is by a wide margin the more common of the two. Holding
   * ctrl as well adds to the selection instead of replacing it.
   *
   * The rectangle is written onto its element by hand for the same reason the
   * pan is: a rubber band is a stream of pointer events, and this component's
   * template is far too large to put through change detection sixty times a
   * second for a box four numbers wide.
   */
  private selecionarPorAreaBoard(evento: PointerEvent): void {
    const frame = this.boardFluxo?.nativeElement;
    const caixa = this.boardSelecao?.nativeElement;
    if (!frame || !caixa) return;

    evento.preventDefault();
    frame.setPointerCapture(evento.pointerId);
    this.boardSelecionandoArea = true;

    const inicio = this.pontoNoBoard(evento);
    const somar = evento.ctrlKey || evento.metaKey;
    const antes = new Set(this.boardSelecionados);

    caixa.style.display = 'block';

    const mover = (movido: PointerEvent): void => {
      const agora = this.pontoNoBoard(movido);
      const x = Math.min(inicio.x, agora.x);
      const y = Math.min(inicio.y, agora.y);
      const largura = Math.abs(agora.x - inicio.x);
      const altura = Math.abs(agora.y - inicio.y);

      caixa.style.left = `${x}px`;
      caixa.style.top = `${y}px`;
      caixa.style.width = `${largura}px`;
      caixa.style.height = `${altura}px`;

      const dentro = new Set(somar ? antes : []);
      for (const outro of this.boardNosCache) {
        // Touched, not swallowed whole: a rectangle that only takes what it
        // contains entirely makes the reader draw round the outside of
        // everything, and on a board of card-sized things that is most of it.
        const cruza =
          outro.x < x + largura && outro.x + BOARD_CARD_W > x && outro.y < y + altura && outro.y + BOARD_CARD_H > y;
        if (cruza) dentro.add(outro.clip.id);
      }

      // Only when it really changed: this runs on every frame of the drag, and
      // waking Angular for a set that came out the same would undo the whole
      // reason the rectangle is written by hand.
      const mudou =
        dentro.size !== this.boardSelecionados.size || [...dentro].some((id) => !this.boardSelecionados.has(id));
      if (mudou) {
        this.zone.run(() => {
          this.boardSelecionados = dentro;
        });
      }
    };

    const parar = (): void => {
      frame.removeEventListener('pointermove', mover);
      frame.removeEventListener('pointerup', parar);
      frame.removeEventListener('pointercancel', parar);
      if (frame.hasPointerCapture(evento.pointerId)) frame.releasePointerCapture(evento.pointerId);
      caixa.style.display = 'none';
      this.zone.run(() => {
        this.boardSelecionandoArea = false;
      });
    };

    this.zone.runOutsideAngular(() => {
      frame.addEventListener('pointermove', mover);
      frame.addEventListener('pointerup', parar);
      frame.addEventListener('pointercancel', parar);
    });
  }

  /* --- notes on the board ---------------------------------------------- */

  /*
   * Words the reader writes on the board, and nothing more.
   *
   * There is already a way to put words *in* a video — a text card, which is a
   * shot and takes time and gets rendered. This is the other thing: "check the
   * audio here", "cut this down", an arrow's worth of explanation for whoever
   * opens the project next. It is part of the arrangement, so it is undone with
   * Ctrl+Z like a card move and it never reaches the export.
   */

  /** A new note, in the middle of whatever the reader is looking at. */
  adicionarRotuloBoard(): void {
    const frame = this.boardFluxo?.nativeElement;
    const rect = frame?.getBoundingClientRect();

    const x = rect ? (rect.width / 2 - this.boardPanX) / this.boardZoom - BOARD_ROTULO_W / 2 : BOARD_MARGEM;
    const y = rect ? (rect.height / 2 - this.boardPanY) / this.boardZoom - 20 : BOARD_MARGEM;

    const rotulo: RotuloBoard = {
      id: `nota-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      x: Math.round(x),
      y: Math.round(y),
      texto: ''
    };

    this.boardRotulos = [...this.boardRotulos, rotulo];
    this.normalizarBoard();
    // Straight into typing: a note added and left blank is a box the reader has
    // to work out how to fill, and every one of them starts out empty.
    //
    // The caret is asked for separately, on the next view check, because the box
    // does not exist yet — and it is not optional. Marking a note as "being
    // typed into" without putting the caret in it leaves a note nothing can end
    // the edit of: the blur that closes it can never fire on an element that was
    // never focused, so it stays flagged for ever, and flagged is exactly the
    // state that used to refuse to be dragged.
    this.boardRotuloEditando = rotulo.id;
    this.boardRotuloFoco = rotulo.id;
    this.medirBoard();
    this.lembrarBoard();
  }

  /** Double-click a note to change it. */
  editarRotuloBoard(rotulo: RotuloBoard): void {
    this.boardRotuloEditando = rotulo.id;
    this.boardRotuloFoco = rotulo.id;
  }

  /**
   * Puts the caret in the note that has just been opened.
   *
   * Called from the view check, which is the first moment the box exists. The
   * caret goes to the end rather than the start, because a note being reopened
   * is nearly always one somebody is adding to.
   */
  private focarRotuloBoard(): void {
    const id = this.boardRotuloFoco;
    if (!id || !isPlatformBrowser(this.platformId)) return;

    const campo = this.boardPalco?.nativeElement.querySelector<HTMLElement>(
      `[data-board-rotulo="${CSS.escape(id)}"] .rotulo-texto`
    );
    if (!campo) return;

    this.boardRotuloFoco = null;
    campo.focus();

    const selecao = window.getSelection();
    if (!selecao) return;
    const alcance = document.createRange();
    alcance.selectNodeContents(campo);
    alcance.collapse(false);
    selecao.removeAllRanges();
    selecao.addRange(alcance);
  }

  /**
   * Takes what was typed and puts the note back to being read.
   *
   * Read off the element rather than bound, because a binding would fight the
   * caret: Angular rewriting the text of the box somebody is typing into puts
   * the cursor back at the start on every keystroke.
   */
  confirmarRotuloBoard(rotulo: RotuloBoard, campo: HTMLElement): void {
    const texto = (campo.innerText ?? '').replace(/\u00a0/g, ' ').trim();
    this.boardRotuloEditando = null;

    // An empty note is not a note. Rather than leaving an invisible box on the
    // board for the reader to find later, it takes itself off again.
    if (!texto) {
      this.removerRotuloBoard(rotulo);
      return;
    }

    if (texto === rotulo.texto) return;
    rotulo.texto = texto;
    this.lembrarBoard();
  }

  /** Escape gives up on the edit; Ctrl+Enter and the blur both keep it. */
  aoTeclarRotuloBoard(evento: KeyboardEvent, rotulo: RotuloBoard, campo: HTMLElement): void {
    if (evento.key === 'Escape') {
      evento.preventDefault();
      evento.stopPropagation();
      campo.innerText = rotulo.texto;
      this.boardRotuloEditando = null;
      // An escape out of a note that was never written is the same as deleting
      // it, which is what adding one and changing your mind should do.
      if (!rotulo.texto) this.removerRotuloBoard(rotulo);
      return;
    }
    if (evento.key === 'Enter' && (evento.ctrlKey || evento.metaKey)) {
      evento.preventDefault();
      campo.blur();
      return;
    }

    if (evento.key === 'Enter') {
      // Written by hand rather than left to the browser. Chrome answers Enter
      // in a `contenteditable` with a new `<div>` and Firefox with a `<br>`,
      // and under `white-space: pre-wrap` those two produce different amounts
      // of gap for the same keystroke. One newline, inserted the same way in
      // both, is what makes a note look the same wherever it is written.
      evento.preventDefault();
      document.execCommand('insertLineBreak');
    }
  }

  /**
   * Pasting into a note keeps the words and drops everything else.
   *
   * A `contenteditable` will happily take a paragraph of styled HTML off the
   * clipboard, colours and all, and the note is meant to be one voice on the
   * board rather than a scrapbook.
   *
   * This is why the element is a plain `contenteditable` rather than
   * `plaintext-only`: Firefox does not know that value, and an attribute it
   * cannot parse leaves the note not editable at all — a note nobody can type
   * into is worse than one that has to be told what to do with a paste.
   */
  aoColarRotuloBoard(evento: ClipboardEvent): void {
    const texto = evento.clipboardData?.getData('text/plain');
    if (texto === undefined) return;
    evento.preventDefault();
    document.execCommand('insertText', false, texto);
  }

  /**
   * Drag a note's corner to resize it.
   *
   * Both axes, unlike the monitor: a monitor has a shape to keep and a note has
   * only words, so the reader decides how wide and how tall the box for them
   * is. The height is written as a floor — the note still grows past it when
   * there are more words than fit.
   */
  aoPressionarResizeRotulo(evento: PointerEvent, rotulo: RotuloBoard): void {
    if (evento.button !== 0) return;

    const palco = this.boardPalco?.nativeElement;
    const el = palco?.querySelector<HTMLElement>(`[data-board-rotulo="${CSS.escape(rotulo.id)}"]`);
    const alvo = evento.currentTarget as HTMLElement;
    if (!el) return;

    evento.preventDefault();
    evento.stopPropagation();
    alvo.setPointerCapture(evento.pointerId);

    const caixa = el.getBoundingClientRect();
    const eraW = rotulo.largura ?? caixa.width / this.boardZoom;
    const eraH = rotulo.altura ?? caixa.height / this.boardZoom;
    const partiuX = evento.clientX;
    const partiuY = evento.clientY;

    const mover = (movido: PointerEvent): void => {
      // Divided by the zoom, like every other drag here: the hand moves in
      // screen pixels and the note is measured in board units.
      rotulo.largura = Math.round(
        Math.min(BOARD_ROTULO_MAX_W, Math.max(BOARD_ROTULO_MIN_W, eraW + (movido.clientX - partiuX) / this.boardZoom))
      );
      rotulo.altura = Math.round(
        Math.min(BOARD_ROTULO_MAX_H, Math.max(BOARD_ROTULO_MIN_H, eraH + (movido.clientY - partiuY) / this.boardZoom))
      );
      el.style.width = `${rotulo.largura}px`;
      el.style.minHeight = `${rotulo.altura}px`;
    };

    const parar = (): void => {
      alvo.removeEventListener('pointermove', mover);
      alvo.removeEventListener('pointerup', parar);
      alvo.removeEventListener('pointercancel', parar);
      if (alvo.hasPointerCapture(evento.pointerId)) alvo.releasePointerCapture(evento.pointerId);
      this.zone.run(() => {
        this.medirBoard();
        this.lembrarBoard();
      });
    };

    this.zone.runOutsideAngular(() => {
      alvo.addEventListener('pointermove', mover);
      alvo.addEventListener('pointerup', parar);
      alvo.addEventListener('pointercancel', parar);
    });
  }

  removerRotuloBoard(rotulo: RotuloBoard): void {
    this.boardRotulos = this.boardRotulos.filter((r) => r.id !== rotulo.id);
    if (this.boardRotuloEditando === rotulo.id) this.boardRotuloEditando = null;
    this.medirBoard();
    this.lembrarBoard();
  }

  /** Drag a note where it is wanted. */
  aoPressionarRotuloBoard(evento: PointerEvent, rotulo: RotuloBoard): void {
    if (evento.button !== 0) return;

    const alvo = evento.target as HTMLElement | null;
    if (alvo?.closest('button, .rotulo-resize')) return;
    // While a note is being typed into, the words in it belong to the caret —
    // a press there is somebody placing the cursor, not picking the note up.
    // Everything else about it still moves it: the grip, and the panel around
    // the text. Refusing the whole note while it was open was what made a note
    // just written impossible to move.
    if (this.boardRotuloEditando === rotulo.id && alvo?.closest('.rotulo-texto')) return;

    const palco = this.boardPalco?.nativeElement;
    const el = palco?.querySelector<HTMLElement>(`[data-board-rotulo="${CSS.escape(rotulo.id)}"]`);
    if (!el) return;

    // Deliberately no `preventDefault` here.
    //
    // Preventing the default action of a pointerdown cancels the click and the
    // double-click the browser would have built from it, and takes the focus
    // with it — which is how a note ended up impossible to type in: the press
    // that was meant to open it was being swallowed before it became a click.
    // Selection is held off by `user-select: none` in the stylesheet instead,
    // and the default is only prevented once the press has become a drag.
    evento.stopPropagation();
    el.setPointerCapture(evento.pointerId);

    const partiuX = evento.clientX;
    const partiuY = evento.clientY;
    const eraX = rotulo.x;
    const eraY = rotulo.y;
    let arrastou = false;

    const mover = (movido: PointerEvent): void => {
      const dx = movido.clientX - partiuX;
      const dy = movido.clientY - partiuY;
      if (!arrastou && Math.hypot(dx, dy) < BOARD_ARRASTE_MINIMO) return;
      if (!arrastou) {
        movido.preventDefault();
        if (this.boardRotuloEditando === rotulo.id) {
          // Moving it ends the edit. A note travelling across the board with a
          // caret blinking in it is claiming to be two things at once, and the
          // blur this triggers is what writes the text down.
          this.zone.run(() => el.querySelector<HTMLElement>('.rotulo-texto')?.blur());
        }
      }
      arrastou = true;
      rotulo.x = Math.round(eraX + dx / this.boardZoom);
      rotulo.y = Math.round(eraY + dy / this.boardZoom);
      el.style.left = `${rotulo.x}px`;
      el.style.top = `${rotulo.y}px`;
    };

    const parar = (): void => {
      el.removeEventListener('pointermove', mover);
      el.removeEventListener('pointerup', parar);
      el.removeEventListener('pointercancel', parar);
      if (el.hasPointerCapture(evento.pointerId)) el.releasePointerCapture(evento.pointerId);

      if (!arrastou) {
        // A press that never moved is a press to type in it. One click rather
        // than two: a note is a box of words and the only thing anybody wants
        // to do to one is change the words.
        if (this.boardRotuloEditando !== rotulo.id) {
          this.zone.run(() => this.editarRotuloBoard(rotulo));
        }
        return;
      }

      this.zone.run(() => {
        this.normalizarBoard();
        this.medirBoard();
        this.lembrarBoard();
      });
    };

    this.zone.runOutsideAngular(() => {
      el.addEventListener('pointermove', mover);
      el.addEventListener('pointerup', parar);
      el.addEventListener('pointercancel', parar);
    });
  }

  /* --- bending an arrow ------------------------------------------------ */

  /**
   * Press on an arrow and pull: the point is made where the press was, and the
   * drag carries on as if it had always been there.
   *
   * Made on the move rather than on the press, and at the point the press
   * landed on rather than where the pointer is now — so a click on a line does
   * nothing, and a pull starts the bend exactly where the reader aimed.
   */
  aoPressionarSeta(evento: PointerEvent, link: LigacaoBoard): void {
    if (evento.button !== 0) return;
    const alvo = evento.currentTarget as SVGPathElement;
    evento.preventDefault();
    evento.stopPropagation();

    // Captured on the press, not on the first move that counts as a drag: the
    // hit area is sixteen pixels wide, and a hand that leaves it before it has
    // travelled four would otherwise stop sending moves to the path — the bend
    // would be born and immediately abandoned.
    alvo.setPointerCapture(evento.pointerId);

    const inicio = this.pontoNoBoard(evento);
    let indice = -1;

    const mover = (movido: PointerEvent): void => {
      const p = this.pontoNoBoard(movido);
      if (indice < 0) {
        if (Math.hypot(p.x - inicio.x, p.y - inicio.y) * this.boardZoom < BOARD_ARRASTE_MINIMO) return;
        indice = this.inserirPontoBoard(link, inicio);
      }
      this.moverPontoBoard(link, indice, p);
    };

    const parar = (): void => {
      alvo.removeEventListener('pointermove', mover);
      alvo.removeEventListener('pointerup', parar);
      alvo.removeEventListener('pointercancel', parar);
      if (alvo.hasPointerCapture(evento.pointerId)) alvo.releasePointerCapture(evento.pointerId);
      if (indice < 0) return;
      this.zone.run(() => this.terminarBendBoard(link));
    };

    this.zone.runOutsideAngular(() => {
      alvo.addEventListener('pointermove', mover);
      alvo.addEventListener('pointerup', parar);
      alvo.addEventListener('pointercancel', parar);
    });
  }

  /** Drag a point that is already there. */
  aoPressionarAlca(evento: PointerEvent, link: LigacaoBoard, indice: number): void {
    if (evento.button !== 0) return;
    const alvo = evento.currentTarget as SVGCircleElement;
    evento.preventDefault();
    evento.stopPropagation();
    alvo.setPointerCapture(evento.pointerId);

    const mover = (movido: PointerEvent): void => this.moverPontoBoard(link, indice, this.pontoNoBoard(movido));

    const parar = (): void => {
      alvo.removeEventListener('pointermove', mover);
      alvo.removeEventListener('pointerup', parar);
      alvo.removeEventListener('pointercancel', parar);
      if (alvo.hasPointerCapture(evento.pointerId)) alvo.releasePointerCapture(evento.pointerId);
      this.zone.run(() => this.terminarBendBoard(link));
    };

    this.zone.runOutsideAngular(() => {
      alvo.addEventListener('pointermove', mover);
      alvo.addEventListener('pointerup', parar);
      alvo.addEventListener('pointercancel', parar);
    });
  }

  /**
   * Takes a bend out. Right-click, or double-click.
   *
   * Right-click because that is what a handle on a diagram has always answered
   * to, and `preventDefault` below is what stops the browser's own menu opening
   * over the board instead. Double-click stays: it was the way before, and a
   * gesture that has been taught should not be taken away to make room for one
   * that is merely better.
   *
   * Take them all out and the arrow is straight again.
   */
  removerAlca(evento: MouseEvent, link: LigacaoBoard, indice: number): void {
    evento.preventDefault();
    evento.stopPropagation();
    link.pontos.splice(indice, 1);
    if (!link.pontos.length) delete this.boardCurvas[link.id];
    this.recalcularLink(link);
    this.medirBoard();
    this.lembrarBoard();
  }

  /** Where a pointer event is, in board units. */
  private pontoNoBoard(evento: PointerEvent): { x: number; y: number } {
    const frame = this.boardFluxo?.nativeElement;
    if (!frame) return { x: 0, y: 0 };
    const rect = frame.getBoundingClientRect();

    return {
      x: (evento.clientX - rect.left - this.boardPanX) / this.boardZoom,
      y: (evento.clientY - rect.top - this.boardPanY) / this.boardZoom
    };
  }

  /**
   * Puts a new point into the run at the bend it belongs to.
   *
   * By which segment of the arrow it landed nearest, not by where it is on the
   * screen: on an arrow already bent twice, a point dropped on the last leg has
   * to go after both of them or the line ties itself in a knot.
   */
  private inserirPontoBoard(link: LigacaoBoard, p: { x: number; y: number }): number {
    const P = this.ancorasLink(link.de, link.para, link.pontos);
    let indice = 0;
    let melhor = Infinity;
    for (let k = 0; k < P.length - 1; k++) {
      const d = this.distanciaPontoSegmentoBoard(p, P[k], P[k + 1]);
      if (d < melhor) {
        melhor = d;
        indice = k;
      }
    }

    if (!this.boardCurvas[link.id]) this.boardCurvas[link.id] = link.pontos;
    link.pontos.splice(indice, 0, { x: Math.round(p.x), y: Math.round(p.y) });

    return indice;
  }

  private distanciaPontoSegmentoBoard(
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number }
  ): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return this.distanciaBoard(p, a);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));

    return this.distanciaBoard(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  /** Moves a point and redraws its arrow, without going through Angular. */
  private moverPontoBoard(link: LigacaoBoard, indice: number, p: { x: number; y: number }): void {
    const ponto = link.pontos[indice];
    if (!ponto) return;
    ponto.x = Math.round(p.x);
    ponto.y = Math.round(p.y);
    this.recalcularLink(link);

    const el = this.elementoLink(link.id);
    el.seta?.setAttribute('d', link.d);
    el.hit?.setAttribute('d', link.d);
    if (el.junta) {
      el.junta.style.left = `${link.meioX}px`;
      el.junta.style.top = `${link.meioY}px`;
    }
    const alca = this.boardPalco?.nativeElement.querySelector<SVGCircleElement>(
      `[data-board-alca="${CSS.escape(link.id)}:${indice}"]`
    );
    alca?.setAttribute('cx', String(ponto.x));
    alca?.setAttribute('cy', String(ponto.y));
  }

  /** One pass through Angular to put the bindings back in step, and a save. */
  private terminarBendBoard(link: LigacaoBoard): void {
    this.boardCurvas[link.id] = link.pontos;
    this.normalizarBoard();
    this.medirBoard();
    this.lembrarBoard();
  }

  /* --- the layout the reader made, kept --------------------------------- */

  private carregarLayoutBoard(): void {
    const bruto = this.readSetting(BOARD_LAYOUT_KEY);
    if (!bruto) return;

    try {
      const lido = JSON.parse(bruto) as {
        posicoes?: unknown;
        curvas?: unknown;
        rotulos?: unknown;
        monitor?: unknown;
        monitorLargura?: unknown;
      };
      const posicoes: Record<string, { x: number; y: number }> = {};
      const curvas: Record<string, { x: number; y: number }[]> = {};

      // Read defensively: this is a file on the reader's disk that anything
      // could have written, and a board that refuses to open because one number
      // in it is a string would be a worse bug than a card in the wrong place.
      for (const [id, valor] of Object.entries((lido.posicoes ?? {}) as Record<string, unknown>)) {
        const p = valor as { x?: unknown; y?: unknown };
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) {
          posicoes[id] = { x: Math.max(BOARD_MIN_XY, Number(p.x)), y: Math.max(BOARD_MIN_XY, Number(p.y)) };
        }
      }
      for (const [id, valor] of Object.entries((lido.curvas ?? {}) as Record<string, unknown>)) {
        if (!Array.isArray(valor)) continue;
        const pontos = valor
          .filter((p: { x?: unknown; y?: unknown }) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
          .map((p: { x: number; y: number }) => ({
            x: Math.max(BOARD_MIN_XY, Number(p.x)),
            y: Math.max(BOARD_MIN_XY, Number(p.y))
          }));
        if (pontos.length) curvas[id] = pontos;
      }

      const monitor = lido.monitor as { x?: unknown; y?: unknown } | null | undefined;
      this.boardMonitorPos =
        monitor && Number.isFinite(monitor.x) && Number.isFinite(monitor.y)
          ? { x: Math.max(0, Number(monitor.x)), y: Math.max(0, Number(monitor.y)) }
          : null;

      this.boardMonitorLargura = Number.isFinite(lido.monitorLargura)
        ? Math.min(BOARD_MONITOR_MAX, Math.max(BOARD_MONITOR_MIN, Number(lido.monitorLargura)))
        : BOARD_MONITOR_W;

      this.boardRotulos = Array.isArray(lido.rotulos)
        ? (lido.rotulos as RotuloBoard[])
            .filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.x) && Number.isFinite(r.y))
            .map((r) => ({
              id: r.id,
              x: Number(r.x),
              y: Number(r.y),
              texto: typeof r.texto === 'string' ? r.texto : '',
              largura: Number.isFinite(r.largura)
                ? Math.min(BOARD_ROTULO_MAX_W, Math.max(BOARD_ROTULO_MIN_W, Number(r.largura)))
                : undefined,
              altura: Number.isFinite(r.altura)
                ? Math.min(BOARD_ROTULO_MAX_H, Math.max(BOARD_ROTULO_MIN_H, Number(r.altura)))
                : undefined
            }))
        : [];

      this.boardPosicoes = posicoes;
      this.boardCurvas = curvas;
    } catch {
      /* Unreadable is the same as absent: the automatic layout takes over. */
    }
  }

  /**
   * A copy deep enough to be a history entry.
   *
   * The arrays behind `curvas` are the very ones the arrows drag their points
   * through — aliased on purpose, so bending an arrow needs no copying at all.
   * That makes a shallow snapshot worse than none: every entry on the stack
   * would go on changing as the reader kept dragging, and undo would put back
   * the state it was already in.
   */
  private snapshotBoard(): LayoutBoard {
    const posicoes: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(this.boardPosicoes)) posicoes[id] = { x: p.x, y: p.y };

    const curvas: Record<string, { x: number; y: number }[]> = {};
    for (const [id, pontos] of Object.entries(this.boardCurvas)) {
      curvas[id] = pontos.map((p) => ({ x: p.x, y: p.y }));
    }

    return { posicoes, curvas, rotulos: this.boardRotulos.map((r) => ({ ...r })) };
  }

  /** Puts a remembered arrangement back, and writes it to disk with the rest. */
  private aplicarLayoutBoard(layout: LayoutBoard | undefined): void {
    // Undefined on an entry recorded before the board existed, which a reader
    // upgrading mid-session can still have on their stack.
    if (!layout) return;

    const restaurado = { posicoes: layout.posicoes, curvas: layout.curvas };
    this.boardPosicoes = {};
    for (const [id, p] of Object.entries(restaurado.posicoes)) this.boardPosicoes[id] = { x: p.x, y: p.y };

    this.boardCurvas = {};
    for (const [id, pontos] of Object.entries(restaurado.curvas)) {
      this.boardCurvas[id] = pontos.map((p) => ({ x: p.x, y: p.y }));
    }

    this.boardRotulos = (layout.rotulos ?? []).map((r) => ({ ...r }));
    this.boardRotuloEditando = null;

    // The cache is keyed on the clips, and an undo of a move changes none of
    // them — so it has to be told, or the board would keep drawing the
    // arrangement that was just taken back.
    this.boardCacheArray = null;
    this.salvarLayoutBoard();
  }

  /**
   * A move on the board, recorded.
   *
   * `remember` rather than `touch`: the arrangement is not the edit. `touch`
   * would also withdraw a half-finished export, throw away the planner's cache
   * and hand the player a new plan — three things that have no business
   * happening because a card was dragged four pixels to the left, and the last
   * of them would interrupt the very playback the monitor is showing.
   */
  private lembrarBoard(): void {
    this.salvarLayoutBoard();
    this.remember();
  }

  private salvarLayoutBoard(): void {
    this.saveSetting(
      BOARD_LAYOUT_KEY,
      JSON.stringify({
        posicoes: this.boardPosicoes,
        curvas: this.boardCurvas,
        rotulos: this.boardRotulos,
        monitor: this.boardMonitorPos,
        monitorLargura: this.boardMonitorLargura
      })
    );
  }

  /** True once anything on the board has been moved by hand. */
  get boardArrumado(): boolean {
    // The notes are not part of it. "Tidy" puts the cards back where the board
    // would place them; throwing away what the reader wrote on it as well would
    // be a destructive thing hiding behind a harmless-sounding button.
    return Object.keys(this.boardPosicoes).length === 0 && Object.keys(this.boardCurvas).length === 0;
  }

  /**
   * Back to the layout the board works out for itself.
   *
   * Only the arrangement: nothing about the queue, the clips or their order is
   * touched, which is why this is a button on the board's own control bar and
   * not on the undo stack with the edits.
   */
  arrumarBoard(): void {
    this.limparSelecaoBoard();
    this.boardPosicoes = {};
    this.boardCurvas = {};
    this.lembrarBoard();
    // The cache is keyed on the clips, which have not changed — so it has to be
    // told, or the board would keep drawing the arrangement just thrown away.
    this.boardCacheArray = null;
    this.boardAjustePendente = true;
  }

  /* --- the floating monitor -------------------------------------------- */

  /*
   * A picture of the preview, over the board, while the board is the window.
   *
   * Maximised, the board covers the preview: the reader is looking at the shape
   * of their video with no way to watch it. This puts the picture back without
   * building a second player — there is one player, one decoder and one
   * soundtrack, and this is its canvas copied frame by frame into a smaller
   * one. Nothing here drives playback; the transport calls the very same
   * methods the preview's own buttons do.
   */

  /** True once there is something for the monitor to show. */
  get boardMonitorAtivo(): boolean {
    return this.boardMaximizado && this.previewOpen;
  }

  /** Play, from the board — opening the preview first if it is not up yet. */
  async tocarNoBoard(): Promise<void> {
    if (!this.previewOpen) {
      await this.openTimelinePreview();
      if (!this.player) return;
    }
    this.togglePlayback();
  }

  /**
   * Copies the preview's canvas into the monitor, once per frame.
   *
   * Outside Angular and started only while the board is the window: it is a
   * `drawImage` per frame and nothing else, and it must not be one change
   * detection pass per frame on top of the one the player is already avoiding.
   */
  private iniciarEspelhoBoard(): void {
    if (this.boardEspelhoFrame || !isPlatformBrowser(this.platformId)) return;

    const desenhar = (): void => {
      this.boardEspelhoFrame = requestAnimationFrame(desenhar);

      const destino = this.boardMonitorTela?.nativeElement;
      const origem = this.previewCanvas?.nativeElement;
      if (!destino || !origem || !origem.width || !origem.height) return;

      const ctx = destino.getContext('2d');
      if (!ctx) return;

      // Letterboxed rather than stretched: a vertical video squashed into a
      // 16:9 monitor would be a picture of the wrong film.
      const escala = Math.min(destino.width / origem.width, destino.height / origem.height);
      const w = origem.width * escala;
      const h = origem.height * escala;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, destino.width, destino.height);
      ctx.drawImage(origem, (destino.width - w) / 2, (destino.height - h) / 2, w, h);
    };

    this.zone.runOutsideAngular(() => {
      this.boardEspelhoFrame = requestAnimationFrame(desenhar);
    });
  }

  private pararEspelhoBoard(): void {
    if (!this.boardEspelhoFrame) return;
    cancelAnimationFrame(this.boardEspelhoFrame);
    this.boardEspelhoFrame = 0;
  }

  /** Drag the monitor to whichever corner is in the way least. */
  aoPressionarMonitor(evento: PointerEvent): void {
    if (evento.button !== 0) return;
    // The controls on it are its own: the play button, the scrubber, and the
    // corner that resizes it. A press on any of those is not a press on the
    // panel, and taking it would make all three impossible to use.
    if ((evento.target as HTMLElement | null)?.closest('button, input, .monitor-resize')) return;

    const painel = this.boardMonitor?.nativeElement;
    const frame = this.boardFluxo?.nativeElement;
    if (!painel || !frame) return;

    evento.preventDefault();
    evento.stopPropagation();
    painel.setPointerCapture(evento.pointerId);

    const caixa = painel.getBoundingClientRect();
    const moldura = frame.getBoundingClientRect();
    const eraX = caixa.left - moldura.left;
    const eraY = caixa.top - moldura.top;
    const partiuX = evento.clientX;
    const partiuY = evento.clientY;

    const mover = (movido: PointerEvent): void => {
      const limiteX = Math.max(0, moldura.width - caixa.width);
      const limiteY = Math.max(0, moldura.height - caixa.height);
      const x = Math.min(limiteX, Math.max(0, eraX + movido.clientX - partiuX));
      const y = Math.min(limiteY, Math.max(0, eraY + movido.clientY - partiuY));
      this.boardMonitorPos = { x, y };
      this.aplicarMonitor();
    };

    const parar = (): void => {
      painel.removeEventListener('pointermove', mover);
      painel.removeEventListener('pointerup', parar);
      painel.removeEventListener('pointercancel', parar);
      if (painel.hasPointerCapture(evento.pointerId)) painel.releasePointerCapture(evento.pointerId);
      this.zone.run(() => this.salvarLayoutBoard());
    };

    this.zone.runOutsideAngular(() => {
      painel.addEventListener('pointermove', mover);
      painel.addEventListener('pointerup', parar);
      painel.addEventListener('pointercancel', parar);
    });
  }

  /**
   * Drag the corner to resize it.
   *
   * The width is what the reader sets; the height of the picture follows from
   * the monitor's shape, and the panel's from that plus its own two bars. Only
   * the corner is a handle — an edge-by-edge resize would let the picture be
   * squashed, and there is nothing here worth squashing it for.
   */
  aoPressionarResizeMonitor(evento: PointerEvent): void {
    if (evento.button !== 0) return;

    const painel = this.boardMonitor?.nativeElement;
    const frame = this.boardFluxo?.nativeElement;
    const alvo = evento.currentTarget as HTMLElement;
    if (!painel || !frame) return;

    evento.preventDefault();
    evento.stopPropagation();
    alvo.setPointerCapture(evento.pointerId);

    const caixa = painel.getBoundingClientRect();
    const moldura = frame.getBoundingClientRect();
    // Pinned before it grows: until it has been dragged the panel hangs off the
    // bottom of the frame, and growing downwards from there would push its top
    // up the screen instead of its corner down.
    this.fixarPosicaoMonitor(caixa, moldura);

    const eraLargura = caixa.width;
    const partiuX = evento.clientX;

    const mover = (movido: PointerEvent): void => {
      const maximo = Math.min(BOARD_MONITOR_MAX, moldura.width - (this.boardMonitorPos?.x ?? 0) - 8);
      this.boardMonitorLargura = Math.round(
        Math.min(maximo, Math.max(BOARD_MONITOR_MIN, eraLargura + movido.clientX - partiuX))
      );
      this.aplicarMonitor();
    };

    const parar = (): void => {
      alvo.removeEventListener('pointermove', mover);
      alvo.removeEventListener('pointerup', parar);
      alvo.removeEventListener('pointercancel', parar);
      if (alvo.hasPointerCapture(evento.pointerId)) alvo.releasePointerCapture(evento.pointerId);
      this.zone.run(() => this.salvarLayoutBoard());
    };

    this.zone.runOutsideAngular(() => {
      alvo.addEventListener('pointermove', mover);
      alvo.addEventListener('pointerup', parar);
      alvo.addEventListener('pointercancel', parar);
    });
  }

  /** Turns "wherever the stylesheet put it" into a position of its own. */
  private fixarPosicaoMonitor(caixa: DOMRect, moldura: DOMRect): void {
    if (this.boardMonitorPos) return;
    this.boardMonitorPos = {
      x: Math.max(0, Math.round(caixa.left - moldura.left)),
      y: Math.max(0, Math.round(caixa.top - moldura.top))
    };
  }

  /**
   * Written onto the element, like every other drag here.
   *
   * With no saved position it is left to the stylesheet, which puts it in the
   * bottom left — the one corner of the board that has nothing else in it.
   */
  private aplicarMonitor(): void {
    const painel = this.boardMonitor?.nativeElement;
    if (!painel) return;

    painel.style.width = `${this.boardMonitorLargura}px`;

    const pos = this.boardMonitorPos;
    if (pos) {
      painel.style.left = `${pos.x}px`;
      painel.style.top = `${pos.y}px`;
      // The stylesheet parks it against the bottom of the frame; once it has a
      // position of its own, `top` is the truth and the two would stretch it.
      painel.style.bottom = 'auto';
    } else {
      painel.style.removeProperty('left');
      painel.style.removeProperty('top');
      painel.style.removeProperty('bottom');
    }

    this.ajustarTelaMonitor();
  }

  /**
   * Keeps the picture's own pixels in step with the size it is drawn at.
   *
   * A canvas has two sizes — the box on the page and the buffer behind it — and
   * scaling only the first is how a monitor dragged out to twice its width ends
   * up a soft copy of a small picture.
   */
  private ajustarTelaMonitor(): void {
    const tela = this.boardMonitorTela?.nativeElement;
    if (!tela) return;

    const largura = Math.round(this.boardMonitorLargura);
    const altura = Math.round((largura * BOARD_MONITOR_H) / BOARD_MONITOR_W);
    // Assigned only when it changes: writing either one clears the canvas, and
    // doing that every view check would flicker the picture away.
    if (tela.width !== largura) tela.width = largura;
    if (tela.height !== altura) tela.height = altura;
  }

  /* --- the light that runs down an arrow ------------------------------- */

  /**
   * The playhead has moved from one clip to another: begin the hand-over.
   *
   * Nothing is lit or unlit here. All this does is tell the light on the card
   * it is on to slow down, and note where it is going; the frame loop picks the
   * rest up when the slowing has finished. Doing it any other way — snapping
   * the light across, or starting the arrow at once — is what the three steps
   * were asked for instead of.
   */
  private trocarCardAcesoBoard(anterior: number, atual: number): void {
    if (!this.modoBoard) return;

    const de = anterior >= 0 ? (this.plan.clips[anterior]?.clip.id ?? null) : null;
    const para = atual >= 0 ? (this.plan.clips[atual]?.clip.id ?? null) : null;
    if (this.boardCardAceso === para) return;

    // Nothing is lit yet — the first clip of a run. It winds up on the spot.
    if (!this.boardCardAceso) {
      this.boardCardAceso = para;
      this.boardGiroAngulo = 0;
      this.sincronizarGiroBoard();
      return;
    }

    this.boardAcesoSeguinte = para;
    // The arrow is only lit where there really is one. A seek from the first
    // shot to the last crosses no join, and drawing a light travelling down an
    // arrow nobody followed would be telling the reader something untrue.
    const id = de && para ? `${de}>${para}` : null;
    this.boardFluxoPendente = id && this.boardLigacoes.some((link) => link.id === id) ? id : null;
    // Slow to a stop; the loop takes it from there.
    this.boardGiroAlvo = 0;
    this.iniciarGiroBoard();
  }

  /**
   * The light goes out, the arrow runs, and the next card takes it up.
   *
   * Called once, by the frame loop, at the moment the old card's light has
   * actually stopped rather than after a timer that guessed when it would.
   */
  private entregarCardAcesoBoard(): void {
    const seguinte = this.boardAcesoSeguinte;
    const arrow = this.boardFluxoPendente;
    this.boardAcesoSeguinte = null;
    this.boardFluxoPendente = null;

    this.boardCardAceso = null;
    this.boardGiroVel = 0;
    this.boardGiroAngulo = 0;

    const acender = (): void => {
      this.boardCardAceso = seguinte;
      this.boardGiroAngulo = 0;
      this.boardGiroFase = 0;
      // From nothing: the target is set here and the loop winds up to it, which
      // is the third of the three steps.
      this.sincronizarGiroBoard();
    };

    if (!arrow) {
      acender();
      return;
    }

    if (this.boardFluxoTimer) clearTimeout(this.boardFluxoTimer);
    // Cleared first: the element carrying the arrow's animation is created by
    // the template when this matches, so a light already running has to come
    // off the board before the next one can be put on it.
    this.boardFluxoLink = null;
    this.boardFluxoTimer = setTimeout(() => {
      this.boardFluxoLink = arrow;
      this.boardFluxoTimer = setTimeout(() => {
        this.boardFluxoLink = null;
        this.boardFluxoTimer = null;
        acender();
      }, BOARD_FLUXO_MS);
    }, 0);
  }

  /* --- the frame loop behind the light --------------------------------- */

  /**
   * Points the light at the right speed for what the preview is doing.
   *
   * Playing is full speed; paused is a stop — and a stop reached by slowing
   * down, which is the whole reason this is a loop and not a keyframe. Cheap
   * enough to call from the view check, so nothing has to remember to.
   */
  private sincronizarGiroBoard(): void {
    if (!this.modoBoard || !this.previewOpen) {
      this.apagarGiroBoard();
      return;
    }

    if (!this.boardCardAceso && !this.boardAcesoSeguinte) {
      const atual = this.previewClip?.id ?? null;
      if (!atual) return;
      this.boardCardAceso = atual;
      this.boardGiroAngulo = 0;
    }

    // Mid-hand-over the target is already zero and must stay there: the light
    // is on its way down, and this is not the place that decides otherwise.
    if (!this.boardAcesoSeguinte) {
      this.boardGiroAlvo = this.previewPlaying ? BOARD_GIRO_VEL : 0;
    }
    this.iniciarGiroBoard();
  }

  /** True when the reader has asked for less movement. */
  private get movimentoReduzido(): boolean {
    return (
      isPlatformBrowser(this.platformId) &&
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  private iniciarGiroBoard(): void {
    if (this.boardGiroFrame || !isPlatformBrowser(this.platformId)) return;

    // Asked for stillness: the card is lit and stays lit, and the hand-over is
    // done at once rather than choreographed. The fact — this is the shot you
    // are watching — is worth keeping; the movement was the reader's to refuse.
    if (this.movimentoReduzido) {
      if (this.boardAcesoSeguinte) this.entregarCardAcesoBoard();
      this.escreverGiroBoard(0.55);
      return;
    }

    this.boardGiroUltimo = performance.now();
    const passo = (agora: number): void => {
      this.boardGiroFrame = requestAnimationFrame(passo);
      this.passoGiroBoard(agora);
    };
    this.zone.runOutsideAngular(() => {
      this.boardGiroFrame = requestAnimationFrame(passo);
    });
  }

  private passoGiroBoard(agora: number): void {
    // Capped, so a tab left in the background does not come back and spin the
    // light through half a turn in one frame.
    const dt = Math.min(0.05, Math.max(0, (agora - this.boardGiroUltimo) / 1000));
    this.boardGiroUltimo = agora;

    // Exponential approach: the further the speed is from where it is going,
    // the harder it is pulled — which is what weight feels like.
    this.boardGiroVel += (this.boardGiroAlvo - this.boardGiroVel) * (1 - Math.exp(-dt / BOARD_GIRO_TAU));

    const parte = this.boardGiroVel / BOARD_GIRO_VEL;
    this.boardGiroAngulo = (this.boardGiroAngulo + this.boardGiroVel * dt) % 360;
    // The breathing keeps pace with the sweep, so everything slows together
    // rather than the card carrying on breathing over a light that has stopped.
    this.boardGiroFase = (this.boardGiroFase + parte * BOARD_PULSO_HZ * dt * Math.PI * 2) % (Math.PI * 2);

    this.escreverGiroBoard(0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.boardGiroFase)) * parte);

    const parado = Math.abs(this.boardGiroVel) < BOARD_GIRO_PARADO;

    if (parado && this.boardAcesoSeguinte) {
      this.boardGiroVel = 0;
      this.zone.run(() => this.entregarCardAcesoBoard());
      return;
    }

    // Nothing left to move: stop the loop rather than burn a frame a sixtieth
    // of a second for ever behind a paused video.
    if (parado && this.boardGiroAlvo === 0) {
      this.boardGiroVel = 0;
      this.escreverGiroBoard(0.35);
      this.pararGiroBoard();
    }
  }

  /** Writes the angle and the brightness onto the card wearing the light. */
  private escreverGiroBoard(brilho: number): void {
    const id = this.boardCardAceso;
    if (!id) return;

    const card = this.boardPalco?.nativeElement.querySelector<HTMLElement>(
      `[data-board-card="${CSS.escape(id)}"]`
    );
    if (!card) return;

    card.style.setProperty('--glow-angle', `${this.boardGiroAngulo.toFixed(1)}deg`);
    card.style.setProperty('--board-brilho', brilho.toFixed(3));
  }

  private pararGiroBoard(): void {
    if (!this.boardGiroFrame) return;
    cancelAnimationFrame(this.boardGiroFrame);
    this.boardGiroFrame = 0;
  }

  /** The board is not on screen, or there is nothing playing: put it all out. */
  private apagarGiroBoard(): void {
    this.pararGiroBoard();
    if (this.boardFluxoTimer) {
      clearTimeout(this.boardFluxoTimer);
      this.boardFluxoTimer = null;
    }
    this.boardCardAceso = null;
    this.boardAcesoSeguinte = null;
    this.boardFluxoPendente = null;
    this.boardFluxoLink = null;
    this.boardGiroVel = 0;
    this.boardGiroAlvo = 0;
  }

  /* --- the whole window ------------------------------------------------- */

  /**
   * Fills the browser window with the board, and puts it back.
   *
   * The camera is left exactly as it was: growing the frame reveals more of the
   * diagram around what the reader was already looking at, which is what
   * resizing a window does and what they will expect. "Fit" is one button away
   * for the other reading.
   */
  alternarBoardMaximizado(): void {
    this.boardMaximizado = !this.boardMaximizado;
    // The frame is rebuilt in the other place, so the camera — which lives on
    // the element rather than in a binding — has to be written onto the new one.
    this.boardPendente = true;
    if (!this.boardMaximizado) this.pararEspelhoBoard();
  }

  /**
   * Escape puts the board back into the page.
   *
   * Unless a dialog is over it: the reader who opened a clip's settings from a
   * maximised board and pressed Escape meant that dialog, and closing the board
   * out from under it would answer a question they did not ask. Every dialog in
   * this file is drawn on the same backdrop, so one look for it settles it.
   */
  @HostListener('document:keydown.escape')
  aoEscapeBoard(): void {
    // A selection first. Escape means "never mind" about the smallest thing
    // outstanding, and letting go of a set of cards is smaller than putting the
    // whole board back into the page.
    if (this.modoBoard && this.boardSelecionados.size) {
      this.limparSelecaoBoard();
      return;
    }

    if (!this.boardMaximizado) return;
    if (typeof document !== 'undefined' && document.querySelector('.dialogo-fundo')) return;
    this.boardMaximizado = false;
    this.boardPendente = true;
    this.pararEspelhoBoard();
  }

  /**
   * Sends the playhead to a card, exactly as clicking the row does.
   *
   * The board has no editing of its own: every control on a card calls the same
   * method the list's row calls, which is what keeps the two views honest.
   */
  aoClicarCardBoard(no: NoBoard, evento: MouseEvent): void {
    // A press that turned into a drag — of the card, or of the board under it —
    // is not a click on the card, and must not move the playhead.
    if (this.boardArrastando || this.boardCardArrastado) return;
    this.onClipRow(no.clip, evento);
  }

  /* ------------------------------------------- the height of the picture */

  /**
   * The ceiling on the picture's height, in pixels, once the reader has moved
   * the handle under the stage; null while it is the 46vh the stylesheet
   * chooses. Written onto the element and kept off the change-detection path,
   * for the reason given on `splitWidth`.
   */
  videoHeight: number | null = null;

  /**
   * The tallest the picture is allowed to be, which is not simply a number.
   *
   * Past the height at which the picture already fills the width of the pane,
   * raising the ceiling changes nothing on screen — the shape of the video is
   * what limits it from there on. Stopping the handle at that point is the
   * honest behaviour: a handle that keeps travelling while the thing it moves
   * stands still reads as broken.
   *
   * `toPicture` is off for the height that comes back from storage, and that
   * distinction matters. The cap is measured from the canvas, and at the moment
   * a restored height is applied the canvas is still the 300×150 surface every
   * canvas starts life as — no project has been drawn onto it yet. Measured
   * against that, a remembered 520px would be clamped to something near half
   * the pane, written back over `videoHeight`, and the reader's setting would
   * be quietly lost on every reload. Coming back from storage, only the floor
   * and the window's own share apply; the shape of the picture starts limiting
   * things again the next time the handle is actually moved.
   */
  private clampVideoHeight(previa: HTMLElement, height: number, toPicture = true): number {
    const canvas = this.previewCanvas?.nativeElement;
    const stage = previa.querySelector<HTMLElement>('.previa-palco');

    let widest = Infinity;
    if (toPicture && canvas?.width && canvas.height && stage) {
      const padding = getComputedStyle(stage);
      const available =
        stage.clientWidth - parseFloat(padding.paddingLeft || '0') - parseFloat(padding.paddingRight || '0');
      if (available > 0) widest = (available * canvas.height) / canvas.width;
    }

    const tallest = Math.max(VIDEO_MIN, Math.min(widest, window.innerHeight * VIDEO_MAX_SHARE));
    return Math.round(Math.min(Math.max(height, VIDEO_MIN), tallest));
  }

  private applyVideoHeight(previa: HTMLElement, height: number, toPicture = true): void {
    const settled = this.clampVideoHeight(previa, height, toPicture);
    this.videoHeight = settled;
    previa.style.setProperty('--altura-video', `${settled}px`);
    previa.querySelector(':scope > .divisor-altura')?.setAttribute('aria-valuenow', String(settled));
  }

  /** Follows the pointer down the page until it is let go. */
  startVideoResize(event: PointerEvent): void {
    if (event.button !== 0) return;

    const handle = event.currentTarget as HTMLElement;
    const previa = this.previaSecao?.nativeElement;
    const canvas = this.previewCanvas?.nativeElement;
    if (!previa || !canvas) return;

    event.preventDefault();
    handle.setPointerCapture(event.pointerId);

    const from = event.clientY;
    // Measured, not taken from `videoHeight`, which is null until the handle
    // has been moved once.
    const started = canvas.getBoundingClientRect().height;

    const move = (moved: PointerEvent): void => {
      // Dragging down makes the picture taller: the handle is its bottom edge.
      this.applyVideoHeight(previa, started + (moved.clientY - from));
    };

    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      this.rememberVideoHeight();
    };

    this.zone.runOutsideAngular(() => {
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    });
  }

  onVideoResizeKey(event: KeyboardEvent): void {
    const previa = this.previaSecao?.nativeElement;
    const canvas = this.previewCanvas?.nativeElement;
    if (!previa || !canvas) return;

    const step = event.shiftKey ? SPLIT_STEP_FAST : SPLIT_STEP;
    const height = canvas.getBoundingClientRect().height;

    if (event.key === 'ArrowDown') this.applyVideoHeight(previa, height + step);
    else if (event.key === 'ArrowUp') this.applyVideoHeight(previa, height - step);
    else if (event.key === 'Home') this.resetVideoHeight();
    else return;

    event.preventDefault();
    this.rememberVideoHeight();
  }

  /** Back to the height the stylesheet chose. */
  resetVideoHeight(): void {
    const previa = this.previaSecao?.nativeElement;
    if (!previa) return;

    this.videoHeight = null;
    previa.style.removeProperty('--altura-video');
    previa.querySelector(':scope > .divisor-altura')?.removeAttribute('aria-valuenow');
    this.dropSetting(VIDEO_HEIGHT_KEY);
  }

  private restoreVideoHeight(): void {
    const stored = Number(this.readSetting(VIDEO_HEIGHT_KEY));
    if (Number.isFinite(stored) && stored > 0) this.videoHeight = stored;
  }

  private rememberVideoHeight(): void {
    if (this.videoHeight !== null) this.saveSetting(VIDEO_HEIGHT_KEY, String(this.videoHeight));
  }

  /** The clip the preview is showing, or null. */
  get previewClip(): EditorClip | null {
    return this.plan.clips[this.previewClipIndex]?.clip ?? null;
  }

  get previewDuration(): number {
    return this.previewPlan.totalDuration;
  }

  /** Sets a clip's caption text from the panel under the preview. */
  setCaptionText(clip: EditorClip, text: string): void {
    if (!isMediaClip(clip)) return;
    this.ensureTimedCaptions(clip);
    const first = clip.captions?.[0];
    if (first) {
      this.updateCaption(clip, first, { text });
      return;
    }
    if (text.trim()) this.addCaption(clip, clipBounds(clip).start, text);
    this.touch();
  }

  captionTextOf(clip: EditorClip): string {
    return isMediaClip(clip) ? clip.captions?.[0]?.text ?? clip.caption?.text ?? '' : '';
  }

  // ------------------------------------------------------ noise suppression

  noiseSettingsFor(clip: MediaClip): ClipNoiseSettings {
    return clampClipNoise(clip.noiseSuppression ?? DEFAULT_CLIP_NOISE);
  }

  noiseProgressOf(clip: MediaClip): SuppressionProgress | null {
    return this.noiseProgress.get(clip.id) ?? null;
  }

  noiseWorking(clip: MediaClip): boolean {
    return this.noiseControllers.has(clip.id);
  }

  noiseReady(clip: MediaClip): boolean {
    return Boolean(clip.noiseCleanedAudio && sameClipNoise(clip.noiseCleanedWith, this.noiseSettingsFor(clip)));
  }

  setNoiseEnabled(clip: MediaClip, enabled: boolean): void {
    clip.noiseSuppression = { ...this.noiseSettingsFor(clip), enabled };
    this.touch();
  }

  setNoiseEnabledFor(clip: EditorClip, enabled: boolean): void {
    if (isMediaClip(clip)) this.setNoiseEnabled(clip, enabled);
  }

  openNoiseSettingsFor(clip: EditorClip): void {
    if (isMediaClip(clip)) this.openNoiseSettings(clip);
  }

  processNoiseNowFor(clip: EditorClip): void {
    if (isMediaClip(clip)) void this.processNoiseNow(clip);
  }

  openNoiseSettings(clip: MediaClip): void {
    if (clip.awaitingFile || !clip.summary.audioUsable) return;
    this.noiseEditor = clip;
    const analysed = clip.noiseAnalyzedWith ?? DEFAULT_ANALYSIS_SETTINGS;
    this.noiseAnalysisContent = analysed.content;
    this.noiseAnalysisSensitivity = analysed.sensitivity;
  }

  closeNoiseSettings(): void {
    if (this.noiseEditor && this.noiseWorking(this.noiseEditor)) return;
    this.noiseEditor = null;
  }

  updateNoiseSettings(clip: MediaClip, patch: Partial<ClipNoiseSettings>): void {
    const next = clampClipNoise({ ...this.noiseSettingsFor(clip), ...patch });
    if (sameClipNoise(clip.noiseSuppression, next)) return;
    clip.noiseSuppression = next;
    this.dropNoiseResult(clip);
    this.touch();
  }

  onNoiseStrength(clip: MediaClip, value: string): void {
    const strength: NoiseStrengthId = value === 'gentle' || value === 'maximum' ? value : 'balanced';
    this.updateNoiseSettings(clip, { strength });
  }

  private dropNoiseResult(clip: MediaClip): void {
    if (clip.noiseCleanedUrl) URL.revokeObjectURL(clip.noiseCleanedUrl);
    clip.noiseCleanedUrl = null;
    clip.noiseCleanedAudio = null;
    clip.noiseCleanedWith = null;
    clip.noiseReductionDb = null;
    this.player?.invalidateSound();
  }

  async analyzeNoiseClip(clip: MediaClip): Promise<void> {
    if (this.noiseWorking(clip) || clip.awaitingFile || !clip.summary.audioUsable) return;
    const controller = new AbortController();
    this.noiseControllers.set(clip.id, controller);
    this.clearMessages();
    try {
      await this.runNoiseAnalysis(
        clip,
        {
          content: this.noiseAnalysisContent,
          sensitivity: this.noiseAnalysisSensitivity,
          background: null,
          cleanVoice: null
        },
        controller.signal
      );
      this.message = `Noise analysis completed for "${clip.summary.fileName}". The audio was not changed.`;
    } catch (error) {
      if (error instanceof SuppressionCanceled) this.message = 'Noise analysis stopped.';
      else {
        this.errorMessage = 'The background noise could not be analyzed.';
        this.errorHint = error instanceof SuppressionError ? error.hint : error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.noiseControllers.delete(clip.id);
      this.noiseProgress.delete(clip.id);
      this.cdr.markForCheck();
    }
  }

  private async runNoiseAnalysis(
    clip: MediaClip,
    settings: AnalysisSettings,
    signal: AbortSignal,
    operationId = ''
  ): Promise<NoiseReport> {
    const reportProgress = (progress: SuppressionProgress) => this.zone.run(() => {
      this.noiseProgress.set(clip.id, progress);
      if (operationId) this.desktop.reportAgentProgress({
        operationId,
        state: 'processing',
        stage: `noise-${progress.stage}`,
        percent: progress.ratio === null ? null : Math.round(progress.ratio * 100),
        clipId: clip.id,
        clipName: clip.summary.fileName
      });
      this.cdr.markForCheck();
    });
    const decoded = await readNoiseAudio(clip.file, reportProgress, signal);
    const result = await analyseNoise(
      decoded.channels.map((channel) => Float32Array.from(channel)),
      decoded.rate,
      settings,
      (ratio, detail) => reportProgress({ stage: 'analysing', ratio, detail }),
      signal
    );
    clip.noiseReport = result;
    clip.noiseAnalyzedWith = { ...settings };
    this.touch();
    return result;
  }

  async processNoiseNow(clip: MediaClip): Promise<void> {
    if (this.noiseWorking(clip) || clip.awaitingFile || !clip.summary.audioUsable) return;
    this.openNoiseSettings(clip);
    const controller = new AbortController();
    this.noiseControllers.set(clip.id, controller);
    this.clearMessages();
    try {
      await this.runNoiseSuppression(clip, this.noiseSettingsFor(clip), controller.signal);
      this.message = `Noise-suppressed preview ready for "${clip.summary.fileName}".`;
    } catch (error) {
      if (error instanceof SuppressionCanceled) this.message = 'Noise suppression stopped.';
      else {
        this.errorMessage = error instanceof SuppressionError ? error.message : 'The noise could not be removed.';
        this.errorHint = error instanceof SuppressionError ? error.hint : error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.noiseControllers.delete(clip.id);
      this.noiseProgress.delete(clip.id);
      this.cdr.markForCheck();
    }
  }

  private async runNoiseSuppression(
    clip: MediaClip,
    requested: ClipNoiseSettings,
    signal: AbortSignal,
    operationId = ''
  ): Promise<void> {
    const settings = clampClipNoise(requested);
    if (clip.noiseCleanedAudio && sameClipNoise(clip.noiseCleanedWith, settings)) return;
    const reportProgress = (progress: SuppressionProgress) => this.zone.run(() => {
      this.noiseProgress.set(clip.id, progress);
      if (operationId) this.desktop.reportAgentProgress({
        operationId,
        state: 'processing',
        stage: `noise-${progress.stage}`,
        percent: progress.ratio === null ? null : Math.round(progress.ratio * 100),
        clipId: clip.id,
        clipName: clip.summary.fileName
      });
      this.cdr.markForCheck();
    });

    const decoded = await readNoiseAudio(clip.file, reportProgress, signal);
    const result = await suppress({
      channels: decoded.channels.map((channel) => Float32Array.from(channel)),
      rate: decoded.rate,
      engine: settings.engine,
      attenuationDb: NOISE_STRENGTHS[NOISE_STRENGTH_INDEX[settings.strength]].attenuationDb,
      preserveHighs: settings.preserveHighs
    }, reportProgress, signal);
    const written = await writeNoiseAudio({
      file: clip.file,
      channels: result.channels,
      rate: decoded.rate,
      format: NOISE_AUDIO_FORMATS[0]
    }, reportProgress, signal);
    if (signal.aborted) throw new SuppressionCanceled();

    this.dropNoiseResult(clip);
    const name = `${stemOf(clip.summary.fileName)}-noise-suppressed.${written.extension}`;
    clip.noiseCleanedAudio = new File([written.blob], name, { type: written.blob.type, lastModified: Date.now() });
    clip.noiseCleanedWith = { ...settings };
    clip.noiseCleanedUrl = URL.createObjectURL(clip.noiseCleanedAudio);
    clip.noiseReductionDb = result.reduction;
    this.player?.invalidateSound();
    this.cdr.markForCheck();
  }

  cancelNoiseOperations(): void {
    for (const controller of this.noiseControllers.values()) controller.abort();
  }

  // -------------------------------------------------------------- listening

  /**
   * True when the clip's analysis no longer matches the settings on screen.
   *
   * The rule is the silence cutter's, and it is the reason a slider never
   * starts a new pass on its own: moving one would decode the whole file per
   * pixel of travel. What it does instead is mark the result stale.
   */
  isStale(clip: EditorClip): boolean {
    if (!isMediaClip(clip) || !clip.analysis || !clip.analyzedWith) return false;
    return detectionSettingsChanged(clip.analyzedWith, this.editsFor(clip).silence);
  }

  needsAnalysis(clip: EditorClip): boolean {
    if (!isMediaClip(clip) || !clip.summary.audioUsable || clip.awaitingFile) return false;

    const edits = this.editsFor(clip);
    const wanted = edits.cutSilence || edits.silence.autoZoom.enabled || this.project.loudness.enabled;
    return wanted && (!clip.analysis || this.isStale(clip));
  }

  /**
   * Listens to one clip: decodes its sound, draws the waveform and finds the
   * pauses.
   *
   * The hand-drawn cuts survive it. They are the reader's own decisions about
   * this footage, and re-running a detector is not a reason to throw them away.
   */
  async analyzeClip(clip: MediaClip, quiet = false): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId) || this.analyzing.has(clip.id)) return false;
    if (clip.awaitingFile) {
      this.errorMessage = `"${clip.summary.fileName}" is waiting for its file, so there is nothing to listen to yet.`;
      this.errorHint = 'Add the same file again to reconnect it.';
      return false;
    }
    if (!clip.summary.audioUsable) {
      this.errorMessage = `"${clip.summary.fileName}" has no sound this browser can decode, so there is nothing to listen to.`;
      return false;
    }

    this.analyzing.set(clip.id, 0);
    if (!quiet) this.clearMessages();
    const controller = new AbortController();
    this.analysisControllers.set(clip.id, controller);

    try {
      clip.info ??= await this.inspector.inspect(clip.file);
      const strategy = await this.selector.select(clip.info, 'automatic', { hasCuts: true });
      const settings = this.editsFor(clip).silence;

      const analysis = await this.zone.runOutsideAngular(() =>
        this.analyser.analyze(clip.file, clip.info as NonNullable<MediaClip['info']>, {
          settings,
          strategy,
          signal: controller.signal,
          onProgress: (report) =>
            this.zone.run(() => {
              this.analyzing.set(clip.id, report.ratio);
              this.cdr.markForCheck();
            })
        })
      );

      clip.analysis = analysis;
      clip.detected = analysis.silenceRanges.map((range) => ({ ...range }));
      clip.analyzedWith = { ...settings, autoZoom: { ...settings.autoZoom } };
      // Named for the conflict message: this finishes long after whatever
      // started it, and moving the revision here is what surprises an agent
      // that read the project a moment ago.
      this.touch(`automatic listening finishing on ${clip.fileRef?.name ?? clip.file.name}`);
      return true;
    } catch (error) {
      if (error instanceof OperationCanceledError) {
        this.message = 'Listening was canceled.';
      } else if (error instanceof MediaToolError) {
        this.errorMessage = error.message;
        this.errorHint = error.hint ?? '';
      } else {
        console.error(error);
        this.errorMessage = `"${clip.summary.fileName}" could not be analyzed.`;
        this.errorHint = 'Check that the file is valid, or try another browser.';
      }
      return false;
    } finally {
      this.analyzing.delete(clip.id);
      this.analysisControllers.delete(clip.id);
      this.cdr.markForCheck();
    }
  }

  /** True while this clip is being listened to. */
  isAnalyzing(clip: EditorClip): boolean {
    return this.analyzing.has(clip.id);
  }

  /** How far the listening has got, or null while the engine cannot say. */
  analysisRatioOf(clip: EditorClip): number | null {
    return this.analyzing.get(clip.id) ?? null;
  }

  /** True while anything at all is being listened to. */
  get analysisBusy(): boolean {
    return this.analyzing.size > 0;
  }

  get analyzingCount(): number {
    return this.analyzing.size;
  }

  /**
   * How many clips are listened to at once.
   *
   * The decode is the expensive part and it happens off the main thread, so a
   * machine with cores to spare can do several at once and finish a queue of
   * nine files in a third of the time. Half the reported cores, never more than
   * four: the browser also needs a thread to stay responsive on, and past four
   * concurrent decodes the memory each one holds starts to matter more than the
   * parallelism saves.
   */
  private get analysisLanes(): number {
    const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
    return Math.max(1, Math.min(4, Math.floor(cores / 2)));
  }

  /**
   * Listens to a whole queue of clips, several at a time.
   *
   * A pool rather than `Promise.all`: thirty files started together would open
   * thirty decoders and thirty megabytes of window statistics at once, which is
   * how a laptop runs out of memory in the middle of something it was told to
   * do. Each lane takes the next clip as it finishes with the last.
   */
  async analyzeMany(clips: readonly MediaClip[], quiet = false, continueAfterFailure = false): Promise<void> {
    const queue = clips.filter((clip) => !clip.awaitingFile && clip.summary.audioUsable && !this.analyzing.has(clip.id));
    if (!queue.length) return;

    if (!quiet) this.clearMessages();
    let next = 0;

    const lane = async (): Promise<void> => {
      while (next < queue.length) {
        const clip = queue[next++];
        const listened = await this.analyzeClip(clip, true);
        if (!listened && !continueAfterFailure) return;
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.analysisLanes, queue.length) }, lane));
    this.cdr.markForCheck();
  }

  /**
   * Starts the first listening pass automatically when media bytes become
   * available. The queue is shared by picker, drag/drop, recovery and MCP
   * imports, so each path has the same behaviour and the global decoder limit
   * remains effective even when files arrive one at a time.
   */
  private queueAutomaticListening(clips: readonly MediaClip[]): void {
    for (const clip of clips) {
      if (!clip.awaitingFile && clip.summary.audioUsable && !clip.analysis) {
        this.automaticListeningIds.add(clip.id);
      }
    }
    if (!this.automaticListeningIds.size || this.automaticListeningTask) return;

    this.automaticListeningTask = this.drainAutomaticListening().finally(() => {
      this.automaticListeningTask = null;
      // A file can arrive between the drain's final size check and this
      // callback. Start a fresh drain rather than leaving that id stranded.
      if (this.automaticListeningIds.size) this.queueAutomaticListening([]);
    });
  }

  private async drainAutomaticListening(): Promise<void> {
    while (this.automaticListeningIds.size) {
      const ids = new Set(this.automaticListeningIds);
      this.automaticListeningIds.clear();
      const clips = this.clips.filter((clip): clip is MediaClip =>
        isMediaClip(clip) && ids.has(clip.id) && !clip.awaitingFile && clip.summary.audioUsable && !clip.analysis
      );
      // One corrupt recording must not prevent the remaining imported clips
      // from receiving their own automatic first pass.
      await this.analyzeMany(clips, true, true);
    }
  }

  /** Waits through a batch added while the preceding automatic batch is settling. */
  private async waitForAutomaticListening(): Promise<void> {
    while (this.automaticListeningTask) await this.automaticListeningTask;
  }

  /** Listens to everything still waiting for it, in parallel. */
  async analyzeEverything(): Promise<void> {
    const pending = this.clipsAwaitingListening;
    if (!pending.length) {
      this.message = 'Every clip has already been listened to.';
      return;
    }

    await this.analyzeMany(pending);
    if (!this.errorMessage) {
      this.message = `Listened to ${pending.length} clip(s). The timeline now shows the cut length.`;
    }
  }

  /** Calls off every analysis that is running. */
  cancelAnalyses(): void {
    this.automaticListeningIds.clear();
    for (const controller of this.analysisControllers.values()) controller.abort();
  }

  /**
   * Drops the analysis of every clip a settings change invalidated.
   *
   * Only the detected ranges go: the reader's own cuts, the caption and the
   * replacement sound have nothing to do with what a detector measured.
   */
  private invalidateAnalyses(): void {
    for (const clip of this.clips) {
      if (isMediaClip(clip) && this.follows(clip)) this.invalidateAnalysis(clip);
    }
  }

  private invalidateAnalysis(clip: MediaClip): void {
    if (!clip.analysis || !this.isStale(clip)) return;
    // The cheap answer first. Nine times out of ten what changed was the
    // threshold or one of the margins, and none of those need the file again.
    if (this.canRedetect(clip)) {
      this.scheduleRedetect();
      return;
    }

    clip.analysis = null;
    clip.analyzedWith = null;
    clip.detected = [];
    this.touch();
  }

  /** True when this clip's pauses can be found again without the file. */
  private canRedetect(clip: MediaClip): boolean {
    const settings = this.editsFor(clip).silence;
    return Boolean(
      clip.analysis?.stats &&
        clip.analyzedWith &&
        settings.detectionWindowMs === clip.analyzedWith.detectionWindowMs
    );
  }

  /**
   * Re-runs the detection shortly after the reader stops moving the control.
   *
   * Cheap is not free. Deciding which of two hundred thousand windows count as
   * silence takes a few milliseconds per clip, and a slider fires on every
   * frame it moves — so a project of a dozen clips would spend a fifth of a
   * second on every one of sixty events a second, which is a slider that does
   * not move. A tenth of a second of stillness is under what anybody notices
   * and far more than a drag ever leaves between two events.
   */
  private scheduleRedetect(): void {
    if (this.redetectTimer) clearTimeout(this.redetectTimer);

    this.redetectTimer = setTimeout(() => {
      this.redetectTimer = null;
      let changed = false;

      for (const clip of this.clips) {
        if (isMediaClip(clip) && this.isStale(clip) && this.redetect(clip)) changed = true;
      }

      if (changed) {
        this.touch();
        this.cdr.markForCheck();
      }
    }, REDETECT_DELAY);
  }

  /**
   * Finds the pauses again from what the last decode measured.
   *
   * This is the difference between moving the threshold slider and *waiting* to
   * see what moving the threshold slider did. Decoding a clip is minutes of
   * work; deciding which of its windows count as silence is arithmetic over an
   * array that is already in memory, and `detectSilence` was always a pure
   * function of exactly that array plus the settings — the array was simply
   * being thrown away the moment it had been used once.
   *
   * The one setting that cannot be answered this way is the window length,
   * because it decides the shape of the array rather than what is read out of
   * it. That case falls through and the clip is listened to again, as it always
   * was.
   *
   * Answers false when it could not be done, so the caller can fall back.
   */
  private redetect(clip: MediaClip): boolean {
    const analysis = clip.analysis;
    const stats = analysis?.stats;
    if (!analysis || !stats || !clip.analyzedWith) return false;

    const settings = this.editsFor(clip).silence;
    if (settings.detectionWindowMs !== clip.analyzedWith.detectionWindowMs) return false;

    const { silenceRanges, keepRanges, peakDb } = detectSilence(stats, settings);
    // A pause the reader switched off stays switched off. They looked at that
    // stretch and decided about it, and a detector run at a different threshold
    // has not learned anything that overrules them.
    const dismissed = clip.detected.filter((range) => !range.enabled);
    const ranges = silenceRanges.map((range) => ({
      ...range,
      enabled: !dismissed.some((old) => old.start < range.end && old.end > range.start)
    }));

    const removed = totalRangeDuration(ranges.filter((range) => range.enabled));

    clip.analysis = {
      ...analysis,
      silenceRanges: ranges.map((range) => ({ ...range })),
      keepRanges,
      peakDb,
      removedDuration: removed,
      outputDuration: Math.max(0, analysis.originalDuration - removed)
    };
    clip.detected = ranges;
    clip.analyzedWith = { ...settings, autoZoom: { ...settings.autoZoom } };
    return true;
  }

  // -------------------------------------------------------------- the cuts

  /** Everything the open clip removes, as the waveform wants to draw it. */
  get editingRanges(): EditableRange[] {
    const clip = this.editing;
    if (!clip) return [];

    const edits = this.editsFor(clip);
    const detected = edits.cutSilence ? clip.detected : [];
    return [...detected, ...clip.manualCuts];
  }

  /** A stretch the reader dragged out on the waveform. */
  onRangeAdd(range: TimeRange): void {
    const clip = this.editing;
    if (!clip) return;

    clip.manualCuts = [...clip.manualCuts, { ...range, source: 'manual', enabled: true }];
    this.touch();
  }

  /**
   * A stretch the reader clicked to take back.
   *
   * A hand-drawn one disappears, since undrawing it is exactly what was meant.
   * A detected one is only switched off, because the detector will find it
   * again on the next pass and "I already decided about this one" has to
   * survive that.
   */
  onRangeRemove(range: EditableRange): void {
    const clip = this.editing;
    if (!clip) return;

    if (range.source === 'manual') {
      clip.manualCuts = clip.manualCuts.filter((candidate) => candidate !== range);
    } else {
      const match = clip.detected.find(
        (candidate) => Math.abs(candidate.start - range.start) < 1e-6 && Math.abs(candidate.end - range.end) < 1e-6
      );
      if (match) match.enabled = false;
    }

    this.touch();
  }

  restoreCuts(): void {
    const clip = this.editing;
    if (!clip) return;

    clip.manualCuts = [];
    for (const range of clip.detected) range.enabled = true;
    this.touch();
  }

  onSeek(time: number): void {
    this.playhead = time;
  }

  // ------------------------------------------------------------- the sound

  /**
   * Attaches the file that stands in for a clip's own sound.
   *
   * Any clip, text cards included: a title has no soundtrack to replace, but it
   * is still a place a piece of music belongs, and the reader who wants one
   * there should not have to put it on the shot after it instead.
   */
  async attachAudio(clip: EditorClip, file: File): Promise<void> {
    if (isTransitionClip(clip)) return;
    this.clearMessages();

    try {
      const summary = await this.probe.probeAudioOnly(file);
      clip.replacementAudio = { file, summary, trimStart: await measureLeadingSilence(file), skipLeadingSilence: true };

      // Choosing a file plainly means using it, so the mode follows — and the
      // clip takes settings of its own, since one clip's replacement sound is
      // never something the whole project should switch to.
      const edits = cloneEdits(this.editsFor(clip));
      clip.overrides = { ...edits, audioMode: 'replace' };
      this.touch();
    } catch (error) {
      this.errorMessage = error instanceof MergeError ? error.message : `"${file.name}" could not be read.`;
      this.errorHint = error instanceof MergeError ? error.hint ?? '' : '';

      // The clip was put into "replace the sound" by the question that led here,
      // and it now has no file to play. Left that way it is silent in the export
      // and marked as such, on the strength of a file that never loaded — so the
      // setting goes back to what it was, exactly as Cancel would have left it.
      if (this.editsFor(clip).audioMode === 'replace' && !clip.replacementAudio) {
        clip.overrides = { ...cloneEdits(this.editsFor(clip)), audioMode: this.soundChooserPrevious };
      }
    } finally {
      // Letting the preview go belongs here rather than in the try: a file that
      // would not read otherwise leaves the preview frozen, with the explanation
      // printed on the page behind a modal that has just closed over it.
      this.soundChooser = null;
      this.resumePreview();
      this.cdr.markForCheck();
    }
  }

  /**
   * The clip the chooser is asking about, narrowed for the template.
   *
   * Two getters rather than a comparison in the markup: `soundChooser` holds
   * either a clip or the word `project`, and narrowing a union inside a
   * template is exactly the kind of thing that type-checks today and stops
   * doing so after a refactor.
   */
  get soundChooserClip(): EditorClip | null {
    return this.soundChooser && this.soundChooser !== 'project' ? this.soundChooser : null;
  }

  /** What the chooser is asking about, in words: a clip or a card. */
  get soundChooserNoun(): string {
    const clip = this.soundChooserClip;
    return clip && !isMediaClip(clip) ? 'card' : 'clip';
  }

  get soundChooserIsProject(): boolean {
    return this.soundChooser === 'project';
  }

  /**
   * Opens the one dialog every sound in this tool comes through.
   *
   * The preview is suspended for the same reason it is suspended for the clip
   * dialog: a player decoding video in the background while the microphone is
   * open competes for exactly the resources the recording needs, and a
   * recording is the one thing here that cannot be done again from the file.
   */
  openAudioSource(target: EditorClip | 'project'): void {
    const clip = target === 'project' ? null : target;

    this.audioSource = {
      target,
      heading: clip ? (isMediaClip(clip) ? 'Sound for this clip' : 'Sound for this card') : 'Default sound for the project',
      subheading: clip
        ? isMediaClip(clip)
          ? clip.summary.fileName
          : isTextClip(clip)
          ? clip.draft.text.split('\n')[0] || 'Text card'
          : 'Transition'
        : 'Every clip set to have its sound replaced falls back to this one.',
      name: clip && isMediaClip(clip) ? `narration-${stemOf(clip.summary.fileName)}` : 'narration'
    };

    this.suspendPreview();
    this.cdr.markForCheck();
  }

  /** Takes the finished sound and puts it where the dialog was opened for. */
  /**
   * Keeps the reference to a soundtrack the reader just picked.
   *
   * Arrives just before the file itself, and only for a sound used untouched.
   * It is what lets a settings file name this music and reopen it later with
   * one permission question instead of a second trip through the file dialog.
   */
  async onAudioHandle(handle: StoredHandle): Promise<void> {
    this.pendingSoundHandle = handle;
  }

  async onAudioChosen(file: File): Promise<void> {
    const target = this.audioSource?.target ?? null;
    const handle = this.pendingSoundHandle;
    this.pendingSoundHandle = null;
    this.audioSource = null;
    if (!target) return;

    // Two keys for one reference. `name:size` is what a restored *project*
    // looks a file up by; the id is what a settings *document* carries, and it
    // survives the file being renamed or re-encoded, which the other does not.
    this.pendingSoundHandleId = '';
    if (handle) {
      this.pendingSoundHandleId = newHandleId();
      await rememberHandle(file, handle);
      await rememberHandleAs(this.pendingSoundHandleId, handle);
    }

    // Closed now rather than in the handler's `finally`: reading and measuring
    // the file takes a moment, and the sound chooser left standing underneath
    // is a live dialog asking a question that has just been answered. A reader
    // who pressed Cancel in that gap had their answer reverted and then written
    // over again by the attachment finishing.
    this.soundChooser = null;

    if (target === 'project') await this.setDefaultAudio(file);
    else await this.attachAudio(target, file);
  }

  closeAudioSource(): void {
    this.audioSource = null;
    this.resumePreview();
    this.cdr.markForCheck();
  }

  /** Keeps the project's default and closes the question. */
  useDefaultSound(): void {
    // Nothing to store on the clip: the timeline falls back to the project's
    // default whenever a clip set to be replaced has no file of its own, so
    // "use the default" is exactly the state the clip is already in.
    this.soundChooser = null;
    this.touch();
    this.resumePreview();
  }

  /** Restores the sound setting the reader had before the question was asked. */
  cancelSoundChoice(): void {
    const target = this.soundChooser;
    this.soundChooser = null;
    if (!target) return;

    if (target === 'project') {
      this.project = {
        ...this.project,
        edits: { ...cloneEdits(this.project.edits), audioMode: this.soundChooserPrevious }
      };
    } else if (!isTransitionClip(target)) {
      target.overrides = { ...cloneEdits(this.editsFor(target)), audioMode: this.soundChooserPrevious };
    }
    this.touch();
    this.resumePreview();
  }

  /** Stores the soundtrack every clip set to be replaced falls back to. */
  async setDefaultAudio(file: File): Promise<void> {
    this.clearMessages();

    try {
      const summary = await this.probe.probeAudioOnly(file);
      const trimStart = await measureLeadingSilence(file);
      // The id travels with the sound, so a settings document written later
      // carries it and can find this exact file again.
      const handleId = this.pendingSoundHandleId;
      this.pendingSoundHandleId = '';
      this.project = {
        ...this.project,
        defaultAudio: {
          file,
          summary,
          trimStart,
          skipLeadingSilence: true,
          ...(handleId ? { handleId } : {})
        }
      };
      this.touch();
    } catch (error) {
      this.errorMessage = error instanceof MergeError ? error.message : `"${file.name}" could not be read.`;
      this.errorHint = error instanceof MergeError ? error.hint ?? '' : '';

      // As in `attachAudio`: a project told to replace every clip's sound, with
      // no soundtrack to replace it with, is a project that exports silent.
      if (this.project.edits.audioMode === 'replace' && !this.project.defaultAudio) {
        this.project = {
          ...this.project,
          edits: { ...cloneEdits(this.project.edits), audioMode: this.soundChooserPrevious }
        };
      }
    } finally {
      this.soundChooser = null;
      this.resumePreview();
      this.cdr.markForCheck();
    }
  }

  /**
   * Whether the project's soundtrack starts at its first sound or at its first
   * sample.
   *
   * Measured once when the file was chosen; this only decides whether the
   * measurement is used. Nothing is ever written back to the file.
   */
  onSkipLeadingSilence(skip: boolean): void {
    const sound = this.project.defaultAudio;
    if (!sound) return;

    this.project = { ...this.project, defaultAudio: { ...sound, skipLeadingSilence: skip } };
    this.touch();
  }

  /** What was found at the head of the project's soundtrack, in words. */
  get leadingSilenceNote(): string {
    const sound = this.project.defaultAudio;
    if (!sound) return '';

    const trim = sound.trimStart ?? 0;
    if (trim <= 0.02) return 'This file starts on its first sound, so there is nothing to skip.';

    return sound.skipLeadingSilence === false
      ? `Playing from the very beginning, including ${trim.toFixed(1)}s of silence.`
      : `Skipping ${trim.toFixed(1)}s of silence at the start of this file.`;
  }

  /** Whether one clip's own soundtrack starts at its first sound. */
  onClipSkipLeadingSilence(clip: EditorClip, skip: boolean): void {
    if (isTransitionClip(clip)) return;
    const sound = clip.replacementAudio;
    if (!sound) return;

    clip.replacementAudio = { ...sound, skipLeadingSilence: skip };
    this.touch();
  }

  /** The measured silence at the head of a clip's own soundtrack, in words. */
  clipSilenceNote(sound: SuppliedSound): string {
    const trim = sound.trimStart ?? 0;
    if (trim <= 0.02) return '';
    return sound.skipLeadingSilence === false
      ? `${trim.toFixed(1)}s of silence at the start is being played.`
      : `Skipping ${trim.toFixed(1)}s of silence at the start.`;
  }

  clearDefaultAudio(): void {
    this.project = { ...this.project, defaultAudio: null };
    this.touch();
  }

  /**
   * Changes how a supplied soundtrack enters and leaves.
   *
   * One setting for every such track rather than one per clip: a run of clips
   * playing one file is one piece of music, and the planner already knows where
   * each run begins and ends. A clip's own fade is a different thing and stays
   * where it is — it takes the picture down with the sound.
   */
  onSoundFade(change: Partial<SoundFade>): void {
    this.project = { ...this.project, soundFade: clampSoundFade({ ...this.project.soundFade, ...change }) };
    this.touch();
  }

  onSoundFadeSeconds(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.onSoundFade({ seconds: parsed });
  }

  /** What the soundtrack's ramps are doing to this timeline, in one line. */
  get soundFadeNote(): string {
    const { fadeIn, fadeOut, seconds } = this.project.soundFade;
    const runs = this.plan.soundFades.length;

    if (!fadeIn && !fadeOut) return 'Any supplied soundtrack starts and stops at full volume.';
    if (!runs) return 'Applies wherever a clip plays a file instead of its own sound. Nothing on this timeline does yet.';

    const ends = fadeIn && fadeOut ? 'in and out' : fadeIn ? 'in' : 'out';
    return `${runs} ramp(s) on this timeline: every stretch of supplied sound fades ${ends} over ${seconds}s. ` +
      'A stretch too short for both splits itself in half.';
  }

  detachAudio(clip: EditorClip): void {
    if (isTransitionClip(clip)) return;
    clip.replacementAudio = null;
    const edits = this.editsFor(clip);
    if (edits.audioMode === 'replace') clip.overrides = { ...cloneEdits(edits), audioMode: 'original' };
    this.touch();
  }

  // --------------------------------------------------------------- the tag

  /**
   * The clip a tag would be put on right now.
   *
   * Both dialogs are places a tag can be chosen — a badge over a shot and a
   * badge over a title card are the same thing — and only one of them is ever
   * open, so one getter serves both templates.
   */
  get tagTarget(): PlayableClip | null {
    return this.editing ?? this.editingText;
  }

  get hasTag(): boolean {
    return this.tagTarget?.tag != null;
  }

  /** The tag being shown in the panel, or the defaults when there is none. */
  get tagDraft(): ClipTag {
    // The project's template when this clip has no tag, not the bare defaults:
    // the panel is showing what ticking the box would produce, and the template
    // is exactly that.
    return this.tagTarget?.tag ?? this.project.defaultTag;
  }

  /**
   * Turns the tag on or off for this clip.
   *
   * Switching it on writes a whole tag rather than an empty shell, because a
   * checkbox that appears to do nothing is worse than one that puts something
   * placeholder on screen: the reader sees a badge in the corner straight away
   * and types over the word.
   */
  toggleTag(on: boolean): void {
    const clip = this.tagTarget;
    if (!clip) return;

    // A *copy* of the project's template, never a reference to it. Everything
    // the reader does to this badge from here on belongs to this clip, and the
    // template is left exactly as it was — which is the whole difference
    // between "start from" and "follow".
    clip.tag = on ? clampTag({ ...this.project.defaultTag }) : null;
    this.touch();
  }

  onTagText(value: string): void {
    const clip = this.tagTarget;
    if (!clip?.tag) return;

    const text = value.slice(0, 120);
    // The hold follows the text while it is still automatic, so a tag that grew
    // from one word to six does not leave before it can be read.
    clip.tag = {
      ...clip.tag,
      text,
      holdSeconds: clip.tag.holdAuto ? holdFromText(text) : clip.tag.holdSeconds
    };
    this.touch();
  }

  /**
   * Moves the tag to one of the nine places, from the grid on the clip's panel.
   *
   * The same choice the dialog offers on the picture itself. It is repeated
   * here because it is the one setting somebody changes without wanting to
   * redesign anything — the badge is right, it is just covering a face.
   */
  setTagPosition(position: TagPosition): void {
    const clip = this.tagTarget;
    if (!clip?.tag) return;

    clip.tag = { ...clip.tag, position };
    this.touch();
  }

  onTagStart(value: string): void {
    const clip = this.tagTarget;
    if (!clip?.tag) return;

    clip.tag = { ...clip.tag, startSeconds: clampTagNumber('startSeconds', Number(value)) };
    this.touch();
  }

  /** The template's text, changed in the project panel without opening anything. */
  onDefaultTagText(value: string): void {
    const text = value.slice(0, 120);
    const tag = this.project.defaultTag;
    this.project = {
      ...this.project,
      defaultTag: { ...tag, text, holdSeconds: tag.holdAuto ? holdFromText(text) : tag.holdSeconds }
    };
    this.touch();
  }

  /** What the project's template looks like, in one line. */
  get defaultTagLabel(): string {
    const tag = this.project.defaultTag;
    const where = TAG_POSITION_LABELS[tag.position].toLowerCase();

    // A finished design has no finish to name and no silhouette worth naming:
    // its own title is the only description of it anyone would recognise.
    const design = specialShape(tag.shape);
    if (design) return `${design.label} · ${tag.scale}% · ${where}`;

    const shape = TAG_SHAPES.find((item) => item.id === tag.shape)?.label ?? tag.shape;
    const finish = TAG_FINISHES.find((item) => item.id === tag.finish)?.label ?? tag.finish;
    return `${shape} · ${finish} · ${where}`;
  }

  /** A one-line reminder of the tag, for the row under the button. */
  get tagSummary(): string {
    const tag = this.tagDraft;
    const where = TAG_POSITION_LABELS[tag.position].toLowerCase();
    const stays = tag.exit !== 'none' || specialShape(tag.shape) !== null;
    const leaves = stays ? `leaves after ${tagHold(tag).toFixed(1)}s` : 'stays to the end';
    return `${where}, from ${tag.startSeconds.toFixed(1)}s, ${leaves}`;
  }

  openTagEditor(): void {
    const clip = this.tagTarget;
    if (!clip) return;

    if (!clip.tag) clip.tag = clampTag({ ...this.project.defaultTag });
    this.tagEditor = {
      clip,
      tag: clip.tag,
      heading: 'What does this tag look like?',
      removable: true
    };
    this.suspendPreview();
    this.cdr.markForCheck();
  }

  /**
   * The project's template, edited in the same dialog.
   *
   * "Remove" is not offered here: there is always a template, because it is
   * what a new tag is made from, and a project without one would leave the
   * first badge with nothing to start from. Putting it back to the defaults is
   * a different question and belongs on a different button.
   */
  openDefaultTag(): void {
    this.tagEditor = {
      clip: null,
      tag: { ...this.project.defaultTag },
      heading: 'What a tag starts out as, in this project',
      removable: false
    };
    this.suspendPreview();
    this.cdr.markForCheck();
  }

  onTagSaved(tag: ClipTag): void {
    const request = this.tagEditor;
    this.tagEditor = null;
    if (!request) return;

    const settled = clampTag(tag);
    // The template and a clip's badge are the same shape and never the same
    // object: editing one has to leave the other exactly where it was.
    if (request.clip) request.clip.tag = settled;
    else this.project = { ...this.project, defaultTag: settled };

    this.touch();
    this.resumePreview();
    this.cdr.markForCheck();
  }

  onTagRemoved(): void {
    const request = this.tagEditor;
    this.tagEditor = null;
    if (request?.clip) request.clip.tag = null;
    this.touch();
    this.resumePreview();
    this.cdr.markForCheck();
  }

  closeTagEditor(): void {
    this.tagEditor = null;
    this.resumePreview();
    this.cdr.markForCheck();
  }

  // ----------------------------------------------------------- the caption

  captionsOf(clip: MediaClip): ClipCaption[] { return clip.captions ?? []; }

  /** About 15 characters per second, with 50% extra reading time. */
  estimatedCaptionDuration(text: string): number {
    const characters = text.trim().replace(/\s+/g, ' ').length;
    return Math.round(Math.max(1.5, (characters / 15) * 1.5) * 10) / 10;
  }

  addCaption(clip: MediaClip, at: number = this.playhead, text = ''): void {
    this.ensureTimedCaptions(clip);
    const bounds = clipBounds(clip);
    const existing = clip.captions ?? [];
    const previousEnd = existing.reduce(
      (end, item) => Math.max(end, (item.startSeconds ?? bounds.start) + (item.durationSeconds ?? 0)), bounds.start
    );
    // Captions are laid end to end, so a clip whose last one already runs to
    // the end has nowhere to put another. Returning quietly here was the worst
    // possible answer: the caller was told the caption had been added, and only
    // found out otherwise when it tried to style the caption that did not
    // exist. It is a refusal, and it says so.
    if (previousEnd >= bounds.end - 0.1) {
      throw new EditorAgentError(
        `There is no room for another caption on "${clip.fileRef?.name ?? clip.file.name}": `
        + `the captions already on it run to ${this.formatTime(previousEnd)} of ${this.formatTime(bounds.end)}. `
        + 'Shorten or remove one, or update the caption that is already there.',
        'no_room',
        { clipId: clip.id, usedUntil: previousEnd, clipEnd: bounds.end, captionCount: existing.length }
      );
    }
    const start = Math.max(bounds.start, Math.min(Math.max(at, previousEnd), bounds.end));
    const caption: ClipCaption = {
      ...DEFAULT_CAPTION,
      id: `caption-${this.nextId++}`,
      text,
      startSeconds: start,
      durationSeconds: this.estimatedCaptionDuration(text),
      durationAutomatic: true
    };
    clip.captions = [...existing, caption].sort((a, b) => (a.startSeconds ?? 0) - (b.startSeconds ?? 0));
    clip.caption = null;
    this.expandedCaptionId = caption.id ?? null;
    this.touch();
  }

  openCaption(caption: ClipCaption): void {
    this.expandedCaptionId = caption.id ?? null;
  }

  confirmCaption(caption: ClipCaption): void {
    if (!caption.text.trim()) return;
    if (this.expandedCaptionId === caption.id) this.expandedCaptionId = null;
  }

  updateCaption(clip: MediaClip, caption: ClipCaption, change: Partial<ClipCaption>): void {
    const items = clip.captions ?? [];
    const index = items.findIndex((item) => item.id === caption.id);
    if (index < 0) return;
    const bounds = clipBounds(clip);
    const previous = items[index - 1];
    const next = items[index + 1];
    const previousEnd = previous
      ? (previous.startSeconds ?? bounds.start) + Math.max(0.1, previous.durationSeconds ?? 0.1)
      : bounds.start;
    let updated = clampCaption({ ...caption, ...change });
    if (change.text !== undefined && caption.durationAutomatic !== false && change.durationSeconds === undefined) {
      updated.durationSeconds = this.estimatedCaptionDuration(change.text);
    }
    const duration = Math.max(0.1, Number(updated.durationSeconds) || this.estimatedCaptionDuration(updated.text));
    const nextStart = next?.startSeconds ?? Number.POSITIVE_INFINITY;
    const latestStart = Math.min(bounds.end, Math.max(previousEnd, nextStart - duration));
    updated.startSeconds = Math.max(previousEnd, Math.min(Number(updated.startSeconds) || bounds.start, latestStart));
    updated.durationSeconds = Math.max(0.1, Math.min(duration, nextStart - updated.startSeconds));
    clip.captions = items.map((item, itemIndex) => (itemIndex === index ? updated : item));
    clip.caption = null;
    this.touch();
  }

  setVideoEffect(clip: MediaClip, effect: VideoEffect): void {
    if (this.exporting || clip.summary.kind === 'audio') return;
    const next = normalizeVideoEffect(effect), previous = normalizeVideoEffect(clip.videoEffect);
    if (next.id === previous.id && next.intensity === previous.intensity && !(clip.videoEffects?.length)) return;
    clip.videoEffect = next;
    // This is the backwards-compatible whole-container command. It deliberately
    // replaces timed sections, rather than leaving an invisible list with
    // precedence over the setting the caller just chose.
    clip.videoEffects = [];
    this.touch();
  }

  videoEffectsOf(clip: MediaClip): ClipVideoEffect[] { return clip.videoEffects ?? []; }

  videoEffectName(effect: ClipVideoEffect): string {
    return effectDefinition(effect.effectId)?.name ?? 'Original';
  }

  videoEffectForPreview(clip: MediaClip): VideoEffect {
    const time = this.playhead;
    const active = (clip.videoEffects ?? []).find(item => {
      const start = item.startSeconds ?? clipBounds(clip).start;
      return time >= start && time < start + (item.durationSeconds ?? 0);
    });
    return active
      ? normalizeVideoEffect({ id: active.effectId, intensity: active.intensity })
      : normalizeVideoEffect(clip.videoEffect);
  }

  addVideoEffect(clip: MediaClip, at: number = this.playhead): void {
    if (this.exporting || clip.summary.kind === 'audio') return;
    this.ensureTimedVideoEffects(clip);
    const bounds = clipBounds(clip);
    const start = Math.max(bounds.start, Math.min(bounds.end, at));
    const available = videoEffectSlotFor(clip, start);
    if (available < 0.1) return;
    const definition = effectDefinition('cinematic')!;
    const effect: ClipVideoEffect = {
      id: `effect-${this.nextId++}`,
      effectId: definition.id,
      intensity: definition.defaultIntensity,
      startSeconds: start,
      durationSeconds: Math.min(5, available)
    };
    clip.videoEffects = [...(clip.videoEffects ?? []), effect]
      .sort((a, b) => (a.startSeconds ?? bounds.start) - (b.startSeconds ?? bounds.start));
    clip.videoEffect = { id: 'none', intensity: 0 };
    this.expandedVideoEffectId = effect.id ?? null;
    this.touch();
  }

  openVideoEffect(effect: ClipVideoEffect): void { this.expandedVideoEffectId = effect.id ?? null; }

  confirmVideoEffect(effect: ClipVideoEffect): void {
    if (this.expandedVideoEffectId === effect.id) this.expandedVideoEffectId = null;
  }

  updateVideoEffect(clip: MediaClip, effect: ClipVideoEffect, change: Partial<ClipVideoEffect>): void {
    const items = clip.videoEffects ?? [];
    const index = items.findIndex(item => item.id === effect.id);
    if (index < 0) return;
    const bounds = clipBounds(clip);
    // Only the clip's own edges and the 0.1s minimum bound what the reader
    // typed. Snapping it to the neighbouring section as well is what made a
    // field answer with a number nobody asked for — and, when the room left
    // was the minimum, with the floating-point residue of that subtraction.
    // Overlap is now reported rather than prevented: the fields turn red and
    // say why, and the value stays what was typed so it can be corrected.
    const start = roundSeconds(Math.max(bounds.start, Math.min(
      Number(change.startSeconds ?? effect.startSeconds ?? bounds.start),
      Math.max(bounds.start, bounds.end - 0.1)
    )));
    const duration = roundSeconds(Math.max(0.1, Math.min(
      Number(change.durationSeconds ?? effect.durationSeconds ?? 5),
      bounds.end - start
    )));
    // Half the section at most, so the two ramps cannot meet.
    const fadeSeconds = roundSeconds(Math.max(0, Math.min(Number(change.fadeSeconds ?? effect.fadeSeconds ?? 0), duration / 2)));
    const updated: ClipVideoEffect = {
      ...effect,
      ...change,
      effectId: effectDefinition(change.effectId ?? effect.effectId)?.id ?? effect.effectId,
      intensity: normalizeVideoEffect({
        id: change.effectId ?? effect.effectId,
        intensity: change.intensity ?? effect.intensity
      }).intensity,
      startSeconds: start,
      durationSeconds: duration,
      fadeSeconds
    };
    const changed = items.map((item, itemIndex) => itemIndex === index ? updated : item)
      .sort((a, b) => (a.startSeconds ?? bounds.start) - (b.startSeconds ?? bounds.start));
    this.videoEffectNotice = videoEffectsOverlap(clip, changed)
      ? 'Two effects cover the same part of this clip. Fix the times in red: while they overlap, the earlier section is the one that plays.'
      : '';
    clip.videoEffects = changed;
    clip.videoEffect = { id: 'none', intensity: 0 };
    this.touch();
  }

  chooseVideoEffect(clip: MediaClip, effect: ClipVideoEffect, value: VideoEffect): void {
    const next = normalizeVideoEffect(value);
    if (next.id === 'none') {
      this.removeVideoEffect(clip, effect);
      return;
    }
    this.updateVideoEffect(clip, effect, { effectId: next.id, intensity: next.intensity });
  }

  /** What the editor did with the last placement the reader asked for. */
  videoEffectNotice = '';

  /**
   * Whether this section shares any of its time with another on the same clip.
   *
   * Used by the template to mark the start and duration fields, so an
   * impossible placement is visible where it was typed instead of being
   * silently moved somewhere else.
   */
  videoEffectConflicts(clip: MediaClip, effect: ClipVideoEffect): boolean {
    const bounds = clipBounds(clip);
    const span = (item: ClipVideoEffect) => {
      const from = Math.max(bounds.start, item.startSeconds ?? bounds.start);
      return { from, to: Math.min(bounds.end, from + Math.max(0, item.durationSeconds ?? bounds.end - from)) };
    };
    const mine = span(effect);
    return (clip.videoEffects ?? []).some(item => {
      if (item.id === effect.id) return false;
      const other = span(item);
      return other.from < mine.to - 0.0005 && mine.from < other.to - 0.0005;
    });
  }

  /**
   * Reads a number out of the field and writes the accepted one back into it.
   *
   * The accepted value is often not the typed one: it is clamped to the room
   * between the neighbouring sections. Without writing it back, the input keeps
   * the typed text while the section sits elsewhere, because the bound
   * expression has not changed and Angular therefore leaves the element alone.
   */
  onVideoEffectNumber(
    clip: MediaClip,
    effect: ClipVideoEffect,
    key: 'startSeconds' | 'durationSeconds' | 'fadeSeconds',
    target: HTMLInputElement
  ): void {
    const parsed = Number(target.value);
    if (Number.isFinite(parsed)) {
      // Start and duration are read on whichever clock the fields are showing;
      // the fade is a length of ramp and belongs to neither.
      const seconds = key === 'startSeconds' ? this.sourceSeconds(clip, parsed)
        : key === 'durationSeconds' ? this.sourceDurationOf(clip, effect.startSeconds, parsed)
        : parsed;
      this.updateVideoEffect(clip, effect, { [key]: seconds });
    }
    const saved = (clip.videoEffects ?? []).find(item => item.id === effect.id);
    target.value = String(
      key === 'startSeconds' ? this.displaySeconds(clip, saved?.startSeconds)
        : key === 'durationSeconds' ? this.displayDuration(clip, saved?.startSeconds, saved?.durationSeconds)
        : roundSeconds(Number(saved?.[key] ?? parsed))
    );
  }

  removeVideoEffect(clip: MediaClip, effect: ClipVideoEffect): void {
    clip.videoEffects = (clip.videoEffects ?? []).filter(item => item.id !== effect.id);
    if (this.expandedVideoEffectId === effect.id) this.expandedVideoEffectId = null;
    clip.videoEffect = { id: 'none', intensity: 0 };
    this.touch();
  }

  videoEffectMinimumStart(clip: MediaClip, effect: ClipVideoEffect): number {
    const items = clip.videoEffects ?? [];
    const index = items.findIndex(item => item.id === effect.id);
    const previous = items[index - 1];
    return previous
      ? (previous.startSeconds ?? clipBounds(clip).start) + (previous.durationSeconds ?? 0)
      : clipBounds(clip).start;
  }

  /**
   * The longest ramp this section can carry.
   *
   * Half its length: past that the two ends would meet and the effect would
   * never reach the strength the reader asked for.
   */
  videoEffectMaximumFade(effect: ClipVideoEffect): number {
    return Math.max(0, (effect.durationSeconds ?? 0) / 2);
  }

  /** "Cut" reads better than "0 s" on a control whose other values are ramps. */
  videoEffectEdgeLabel(effect: ClipVideoEffect): string {
    const fade = effect.fadeSeconds ?? 0;
    return fade <= 0 ? 'Cut' : `${fade.toFixed(1)}s ease in and out`;
  }

  /** The middle of the section, in source seconds, for the gallery's frame. */
  videoEffectPreviewTime(clip: MediaClip, effect: ClipVideoEffect): number {
    const bounds = clipBounds(clip);
    const start = Math.max(bounds.start, effect.startSeconds ?? bounds.start);
    const span = Math.max(0, Math.min(effect.durationSeconds ?? 0, bounds.end - start));
    return roundSeconds(start + span / 2);
  }

  /**
   * Where this section lands in the finished clip, in seconds.
   *
   * The time fields are read on the **source** clock, the same one captions and
   * the MCP use, because that is the only clock that survives a change to the
   * cuts. What the reader watches is the edited clip, where removed material
   * has pulled everything earlier — and the further into the clip, the more of
   * it has been removed. Showing both stops that gap from being invisible.
   */
  videoEffectEditedStart(clip: MediaClip, effect: ClipVideoEffect): number {
    const edits = this.editsFor(clip);
    const speed = clampSpeed(edits.speed);
    const bounds = clipBounds(clip);
    const source = Math.max(bounds.start, effect.startSeconds ?? bounds.start);
    return roundSeconds(cutTimeOf(keepRangesFor(clip, edits), source) / speed);
  }

  /** True when the cuts or the speed move this section away from its source time. */
  videoEffectClocksDiffer(clip: MediaClip, effect: ClipVideoEffect): boolean {
    const bounds = clipBounds(clip);
    const source = Math.max(bounds.start, effect.startSeconds ?? bounds.start);
    return Math.abs(this.videoEffectEditedStart(clip, effect) - (source - bounds.start)) > 0.05;
  }

  videoEffectMaximumDuration(clip: MediaClip, effect: ClipVideoEffect): number {
    const bounds = clipBounds(clip);
    return roundSeconds(Math.max(0.1, bounds.end - (effect.startSeconds ?? bounds.start)));
  }

  videoEffectOverflows(clip: MediaClip, effect: ClipVideoEffect): boolean {
    return (effect.startSeconds ?? 0) + (effect.durationSeconds ?? 0) > clipBounds(clip).end + 1e-4;
  }

  canAddVideoEffect(clip: MediaClip): boolean {
    return videoEffectSlotFor(clip, this.playhead) >= 0.1;
  }


  // ---------------------------------------------------------------------------
  // Placed pictures
  //
  // The same shape as the captions above, and deliberately so: a container may
  // carry any number of them, each with its own interval on the container's own
  // source clock, and nothing is ever inherited from the project or from another
  // container. The one real difference is that two placements may overlap — a
  // logo in a corner and a screenshot in the middle is a normal thing to ask
  // for — so there is no conflict to report here, unlike an effect section.
  // ---------------------------------------------------------------------------


  // ---------------------------------------------------------------------------
  // The two clocks
  //
  // Everything timed inside a container — a caption, an effect section, a placed
  // picture — is written on the container's **source** clock, the one the
  // original file runs on. That is the only clock that survives a change to the
  // cuts: move a deleted range and a caption pinned to source second 12 is still
  // on the same word.
  //
  // What the reader watches is the **edited** clip, where the removed material
  // has pulled everything earlier, and the further into the clip the more has
  // gone. Asking someone to type a source time while they are looking at an
  // edited preview is asking them to do that subtraction in their head, and it
  // is exactly how a section ends up a second away from where it was wanted.
  //
  // So the fields accept either, and say which. Only the field changes: what is
  // stored is always the source time, so a project written in either mode opens
  // the same and the MCP contract is untouched.
  // ---------------------------------------------------------------------------

  /** Which clock the timing fields read and write. Not persisted; a habit, not a setting. */
  timeClock: 'source' | 'edited' = 'source';

  toggleTimeClock(): void {
    this.timeClock = this.timeClock === 'source' ? 'edited' : 'source';
  }

  get timeClockLabel(): string {
    return this.timeClock === 'source' ? 'Original file time' : 'Edited clip time';
  }

  /** True when the cuts or the speed make the two clocks disagree on this clip. */
  clocksDiffer(clip: MediaClip): boolean {
    const bounds = clipBounds(clip);
    const edits = this.editsFor(clip);
    if (clampSpeed(edits.speed) !== 1) return true;
    const span = Math.max(0, bounds.end - bounds.start);
    return Math.abs(cutTimeOf(keepRangesFor(clip, edits), bounds.end) - span) > 0.05;
  }

  /** A source second as the field should show it, in whichever clock is chosen. */
  displaySeconds(clip: MediaClip, sourceSeconds: number | undefined): number {
    const bounds = clipBounds(clip);
    const source = Math.max(bounds.start, Math.min(bounds.end, sourceSeconds ?? bounds.start));
    if (this.timeClock === 'source') return roundSeconds(source);
    const edits = this.editsFor(clip);
    return roundSeconds(cutTimeOf(keepRangesFor(clip, edits), source) / clampSpeed(edits.speed));
  }

  /**
   * What the reader typed, as a source second.
   *
   * The edited clock is not invertible everywhere: a time inside a removed
   * stretch has no edited counterpart, and several source instants can map to
   * the same edited one at a cut. `sourceTimeAt` resolves that the way the
   * planner does, which is the same answer the preview gives — so a value
   * written here and read back lands where the reader saw it.
   */
  sourceSeconds(clip: MediaClip, typed: number): number {
    const bounds = clipBounds(clip);
    if (this.timeClock === 'source') return roundSeconds(Math.max(bounds.start, Math.min(bounds.end, typed)));
    const entry = this.plan.clips.find(candidate => candidate.clip.id === clip.id);
    if (!entry) return roundSeconds(Math.max(bounds.start, Math.min(bounds.end, typed)));
    const { sourceTime } = sourceTimeAt(entry, entry.outputStart + Math.max(0, typed));
    return roundSeconds(Math.max(bounds.start, Math.min(bounds.end, sourceTime)));
  }

  /**
   * A duration in the chosen clock.
   *
   * A duration is not a point, so it cannot be converted by mapping one instant:
   * it is the distance between the placement's two ends, measured on whichever
   * clock is showing. On the edited clock a section spanning a removed stretch
   * therefore reads shorter than it does on the source clock, which is correct —
   * that is how long it is on screen.
   */
  displayDuration(clip: MediaClip, sourceStart: number | undefined, sourceDuration: number | undefined): number {
    const bounds = clipBounds(clip);
    const duration = Math.max(0, sourceDuration ?? 0);
    if (this.timeClock === 'source') return roundSeconds(duration);
    const start = Math.max(bounds.start, Math.min(bounds.end, sourceStart ?? bounds.start));
    const end = Math.min(bounds.end, start + duration);
    const edits = this.editsFor(clip);
    const speed = clampSpeed(edits.speed);
    const keep = keepRangesFor(clip, edits);
    return roundSeconds(Math.max(0, (cutTimeOf(keep, end) - cutTimeOf(keep, start)) / speed));
  }

  /** The typed duration as a source duration, measured from the placement's start. */
  sourceDurationOf(clip: MediaClip, sourceStart: number | undefined, typed: number): number {
    const bounds = clipBounds(clip);
    if (this.timeClock === 'source') return roundSeconds(Math.max(0, typed));
    const start = Math.max(bounds.start, Math.min(bounds.end, sourceStart ?? bounds.start));
    const entry = this.plan.clips.find(candidate => candidate.clip.id === clip.id);
    if (!entry) return roundSeconds(Math.max(0, typed));
    const edits = this.editsFor(clip);
    const editedStart = cutTimeOf(keepRangesFor(clip, edits), start) / clampSpeed(edits.speed);
    const { sourceTime } = sourceTimeAt(entry, entry.outputStart + editedStart + Math.max(0, typed));
    return roundSeconds(Math.max(0, Math.min(bounds.end, sourceTime) - start));
  }


  // ---------------------------------------------------------------------------
  // Placing a picture by hand
  //
  // Position and size are shares of the frame, and typing 0.72 into a box is a
  // poor way to decide where a picture goes. Everything below exists so the
  // reader can do it the way anyone would: look at the preview and drag.
  //
  // The numbers stay. They are what the project stores, what an agent sends and
  // what a reader reaches for when they want two pictures in exactly the same
  // place — the drag writes through the same `updateClipImage` the fields do, so
  // the two are never out of step.
  // ---------------------------------------------------------------------------

  /** The gesture in progress, or null. Only one picture is ever being moved. */
  private imageDrag: {
    clip: MediaClip;
    image: ClipImage;
    mode: 'move' | 'scale' | 'rotate';
    /** Where the frame is on screen, so pixels can be read as shares of it. */
    rect: DOMRect;
    pointerX: number;
    pointerY: number;
    origin: { positionX: number; positionY: number; scale: number; rotationDegrees: number };
    /** Centre-to-pointer at the start, for the two gestures measured from it. */
    radius: number;
    angle: number;
  } | null = null;

  /** True while this picture is the one being dragged. */
  draggingImage(image: ClipImage): boolean {
    return this.imageDrag?.image.id === image.id;
  }

  /**
   * True when the handles should be on the preview for this placement.
   *
   * Only the row the reader has open: handles for every picture on the clip at
   * once would cover the picture they are trying to look at.
   */
  imageHandlesVisible(clip: MediaClip, image: ClipImage): boolean {
    return this.previewOpen && this.expandedImageId === image.id &&
      !this.exporting && this.previewClipIsCurrent(clip);
  }

  private previewClipIsCurrent(clip: MediaClip): boolean {
    return this.plan.clips[this.previewClipIndex]?.clip.id === clip.id;
  }

  /**
   * Where to put the handle box over the preview, as CSS percentages.
   *
   * Percentages rather than pixels because the preview is resizable and the
   * canvas is scaled by CSS: a box in percentages of the same element needs no
   * recalculation when the reader drags the height handle under the stage.
   */
  imageHandleStyle(image: ClipImage): Record<string, string> {
    const placement = imagePlacement(image);
    const aspect = imageAspect(image.source);
    const plan = this.plan;
    const widthShare = placement.scale;
    // The frame is not square, so a width share becomes a different height
    // share once the picture's own proportions are taken into account.
    const heightShare = widthShare * (plan.width / Math.max(1, plan.height)) / Math.max(0.0001, aspect);
    return {
      left: `${(placement.positionX - widthShare / 2) * 100}%`,
      top: `${(placement.positionY - heightShare / 2) * 100}%`,
      width: `${widthShare * 100}%`,
      height: `${heightShare * 100}%`,
      transform: `rotate(${placement.rotationDegrees}deg)`
    };
  }

  beginImageDrag(clip: MediaClip, image: ClipImage, mode: 'move' | 'scale' | 'rotate', event: PointerEvent): void {
    const canvas = this.previewCanvas?.nativeElement;
    if (!canvas || this.exporting) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const placement = imagePlacement(image);
    const centreX = rect.left + placement.positionX * rect.width;
    const centreY = rect.top + placement.positionY * rect.height;
    this.imageDrag = {
      clip, image, mode, rect,
      pointerX: event.clientX,
      pointerY: event.clientY,
      origin: placement,
      radius: Math.max(1, Math.hypot(event.clientX - centreX, event.clientY - centreY)),
      angle: Math.atan2(event.clientY - centreY, event.clientX - centreX)
    };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  moveImageDrag(event: PointerEvent): void {
    const drag = this.imageDrag;
    if (!drag) return;
    event.preventDefault();
    const { rect, origin } = drag;

    if (drag.mode === 'move') {
      this.updateClipImage(drag.clip, drag.image, {
        positionX: origin.positionX + (event.clientX - drag.pointerX) / rect.width,
        positionY: origin.positionY + (event.clientY - drag.pointerY) / rect.height
      });
      return;
    }

    const centreX = rect.left + origin.positionX * rect.width;
    const centreY = rect.top + origin.positionY * rect.height;

    if (drag.mode === 'scale') {
      const radius = Math.hypot(event.clientX - centreX, event.clientY - centreY);
      this.updateClipImage(drag.clip, drag.image, { scale: origin.scale * (radius / drag.radius) });
      return;
    }

    const angle = Math.atan2(event.clientY - centreY, event.clientX - centreX);
    let degrees = origin.rotationDegrees + (angle - drag.angle) * 180 / Math.PI;
    // Upright is the value people want far more often than any other, and it is
    // the one a free rotation never quite lands on. Shift skips the snap.
    if (!event.shiftKey && Math.abs(degrees % 90) < 3) degrees = Math.round(degrees / 90) * 90;
    this.updateClipImage(drag.clip, drag.image, { rotationDegrees: degrees });
  }

  endImageDrag(event: PointerEvent): void {
    if (!this.imageDrag) return;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    this.imageDrag = null;
  }

  /** Nudges the picture a step at a time, for a reader working from the keyboard. */
  nudgeImage(clip: MediaClip, image: ClipImage, event: KeyboardEvent): void {
    const step = event.shiftKey ? 0.05 : 0.005;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const placement = imagePlacement(image);
    this.updateClipImage(clip, image, {
      positionX: placement.positionX + move[0],
      positionY: placement.positionY + move[1]
    });
  }

  readonly imageStyles = IMAGE_STYLES;
  /**
   * Limits for a picture *placed over* a clip.
   *
   * Not to be confused with `imageLimits` above, which is how long a still
   * image clip may stay on screen. Two different things that both wanted the
   * same name; this one is about placement.
   */
  readonly imagePlacementLimits = IMAGE_LIMITS;
  readonly restrainedRotation = IMAGE_RESTRAINED_ROTATION;
  /** What the editor did with the last picture the reader asked for. */
  imageNotice = '';
  private readonly imagePreviewUrls = new Map<string, string>();

  canAddClipImage(clip: MediaClip): boolean {
    return !this.exporting && clip.summary.kind !== 'audio';
  }

  /** Opens the file dialog for a new placement on this container. */
  requestClipImage(clip: MediaClip, input: HTMLInputElement): void {
    if (!this.canAddClipImage(clip)) return;
    this.imageTarget = { clip, replacing: null };
    input.value = '';
    input.click();
  }

  /** Opens the file dialog to swap the file of an existing placement. */
  replaceClipImage(clip: MediaClip, image: ClipImage, input: HTMLInputElement): void {
    if (this.exporting) return;
    this.imageTarget = { clip, replacing: image.id ?? null };
    input.value = '';
    input.click();
  }

  private imageTarget: { clip: MediaClip; replacing: string | null } | null = null;

  async onClipImagePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const target = this.imageTarget;
    this.imageTarget = null;
    if (!file || !target) return;
    await this.attachClipImage(target.clip, file, target.replacing);
  }

  /**
   * Measures the file and either places it or swaps it into an existing row.
   *
   * The natural size is read once, here, because everything downstream needs it
   * and none of it can afford to decode a picture: the panel shapes a preview
   * from it, the placement keeps the aspect ratio from it, and the report an
   * agent reads back says whether the picture fits the frame from it.
   */
  private async attachClipImage(clip: MediaClip, file: File, replacing: string | null): Promise<void> {
    let width = 0;
    let height = 0;
    try {
      const bitmap = await imageBitmapForFile(file);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      this.imageNotice = `${file.name} could not be read as a picture.`;
      this.cdr.markForCheck();
      return;
    }

    const source: ClipImageSource = {
      file,
      name: file.name,
      width,
      height,
      ...(pathBackedPath(file) ? { sourcePath: pathBackedPath(file) } : {}),
      fileRef: { name: file.name, size: file.size, lastModified: file.lastModified, ...(pathBackedPath(file) ? { path: pathBackedPath(file)! } : {}) }
    };

    if (replacing) {
      const existing = (clip.images ?? []).find(item => item.id === replacing);
      if (!existing) return;
      forgetImage(existing.source);
      this.releaseImagePreview(existing);
      existing.source = source;
      this.imageNotice = '';
      await loadImage(source);
      this.touch();
      this.cdr.markForCheck();
      return;
    }

    this.addClipImage(clip, source);
    await loadImage(source);
    this.cdr.markForCheck();
  }

  /**
   * Places a measured picture on the container, starting at the playhead.
   *
   * `placement` is what an MCP call already knows and the panel does not: it is
   * applied here rather than through a second `updateClipImage`, so one request
   * is one revision and one undo step.
   */
  addClipImage(
    clip: MediaClip, source: ClipImageSource, at: number = this.playhead, placement: Partial<ClipImage> = {}
  ): ClipImage {
    const bounds = clipBounds(clip);
    const start = roundSeconds(Math.max(bounds.start, Math.min(at, Math.max(bounds.start, bounds.end - 0.2))));
    const image: ClipImage = clampClipImage({
      id: `image-${this.nextId++}`,
      source,
      startSeconds: start,
      durationSeconds: roundSeconds(Math.min(4, Math.max(0.2, bounds.end - start))),
      style: 'overlay',
      positionX: 0.5,
      positionY: 0.5,
      scale: IMAGE_LIMITS.scale.default,
      rotationDegrees: 0,
      opacity: 1,
      fadeSeconds: IMAGE_LIMITS.fadeSeconds.default,
      ...placement,
      // Clamped after the placement is merged, and to this container's edges:
      // an agent may legitimately ask for a picture longer than what is left.
      ...(placement.startSeconds === undefined ? {} : {
        startSeconds: roundSeconds(Math.max(bounds.start, Math.min(placement.startSeconds, Math.max(bounds.start, bounds.end - 0.2))))
      })
    });
    image.durationSeconds = roundSeconds(Math.max(0.2, Math.min(
      image.durationSeconds ?? 4, bounds.end - (image.startSeconds ?? bounds.start)
    )));
    image.fadeSeconds = roundSeconds(Math.max(0, Math.min(image.fadeSeconds ?? 0, (image.durationSeconds ?? 0) / 2)));
    clip.images = [...(clip.images ?? []), image]
      .sort((a, b) => (a.startSeconds ?? bounds.start) - (b.startSeconds ?? bounds.start));
    this.expandedImageId = image.id ?? null;
    this.imageNotice = '';
    this.touch();
    return image;
  }

  openClipImage(image: ClipImage): void { this.expandedImageId = image.id ?? null; }

  confirmClipImage(image: ClipImage): void {
    if (this.expandedImageId === image.id) this.expandedImageId = null;
  }

  updateClipImage(clip: MediaClip, image: ClipImage, change: Partial<ClipImage>): void {
    const items = clip.images ?? [];
    const index = items.findIndex(item => item.id === image.id);
    if (index < 0) return;
    const bounds = clipBounds(clip);
    // Bounded by the container's own edges and by nothing else. Two placements
    // are allowed to share an instant, so there is no neighbour to snap to and
    // no residue of a subtraction to write back into the field.
    const start = roundSeconds(Math.max(bounds.start, Math.min(
      Number(change.startSeconds ?? image.startSeconds ?? bounds.start),
      Math.max(bounds.start, bounds.end - 0.2)
    )));
    const duration = roundSeconds(Math.max(0.2, Math.min(
      Number(change.durationSeconds ?? image.durationSeconds ?? 4),
      bounds.end - start
    )));
    const fadeSeconds = roundSeconds(Math.max(0, Math.min(
      Number(change.fadeSeconds ?? image.fadeSeconds ?? 0), duration / 2
    )));
    const updated = clampClipImage({
      ...image,
      ...change,
      source: change.source ?? image.source,
      startSeconds: start,
      durationSeconds: duration,
      fadeSeconds
    });
    clip.images = items.map((item, itemIndex) => itemIndex === index ? updated : item)
      .sort((a, b) => (a.startSeconds ?? bounds.start) - (b.startSeconds ?? bounds.start));
    this.touch();
  }

  removeClipImage(clip: MediaClip, image: ClipImage): void {
    this.releaseImagePreview(image);
    clip.images = (clip.images ?? []).filter(item => item.id !== image.id);
    if (this.expandedImageId === image.id) this.expandedImageId = null;
    this.touch();
  }

  /**
   * Reads a number out of the field and writes the accepted one back into it.
   *
   * The same reason the effect sections do it: without writing it back, a value
   * the editor clamped leaves the typed text on screen while the placement sits
   * somewhere else, because the bound expression never changed.
   */
  onClipImageNumber(
    clip: MediaClip,
    image: ClipImage,
    key: 'startSeconds' | 'durationSeconds' | 'fadeSeconds' | 'positionX' | 'positionY' | 'scale' | 'rotationDegrees' | 'opacity',
    target: HTMLInputElement
  ): void {
    const parsed = Number(target.value);
    if (Number.isFinite(parsed)) {
      const seconds = key === 'startSeconds' ? this.sourceSeconds(clip, parsed)
        : key === 'durationSeconds' ? this.sourceDurationOf(clip, image.startSeconds, parsed)
        : parsed;
      this.updateClipImage(clip, image, { [key]: seconds });
    }
    const saved = (clip.images ?? []).find(item => item.id === image.id);
    target.value = String(
      key === 'startSeconds' ? this.displaySeconds(clip, saved?.startSeconds)
        : key === 'durationSeconds' ? this.displayDuration(clip, saved?.startSeconds, saved?.durationSeconds)
        : roundSeconds(Number(saved?.[key] ?? parsed))
    );
  }

  onClipImageStyle(clip: MediaClip, image: ClipImage, value: string): void {
    if (isImageStyle(value)) this.updateClipImage(clip, image, { style: value });
  }

  /**
   * A browser URL for the panel's thumbnail, made once per distinct file.
   *
   * Keyed by the file rather than by the placement on purpose. Keyed by the
   * placement's id, swapping a picture and then undoing would leave the id
   * pointing at the URL of the file that was swapped in — the panel would show
   * one picture while the frame drew another. Two placements of the same file
   * also share one URL this way, which is what anyone would expect.
   */
  clipImagePreview(image: ClipImage): string {
    const key = imageKey(image.source);
    const held = this.imagePreviewUrls.get(key);
    if (held) return held;
    if (image.source.awaitingFile || !image.source.file || image.source.file.size === 0) return '';
    const url = mediaObjectUrl(image.source.file);
    this.imagePreviewUrls.set(key, url);
    return url;
  }

  /**
   * Releases a thumbnail, but only once nothing is using it.
   *
   * The URL belongs to the file, and the same file may be placed twice, or be
   * sitting in an undo snapshot waiting to come back. Revoking it while any of
   * those still point at it turns a working thumbnail into a broken one.
   */
  private releaseImagePreview(image: ClipImage): void {
    const key = imageKey(image.source);
    const held = this.imagePreviewUrls.get(key);
    if (!held) return;
    const stillUsed = this.clips.some(candidate =>
      isMediaClip(candidate) && (candidate.images ?? []).some(other =>
        other !== image && imageKey(other.source) === key
      )
    );
    if (stillUsed) return;
    // Not `URL.revokeObjectURL` directly: a picture opened from a local path
    // carries the desktop's own URL rather than a blob, and revoking that is
    // meaningless at best.
    revokeMediaObjectUrl(held);
    this.imagePreviewUrls.delete(key);
  }

  /** True when this placement is still waiting for its file after a reload. */
  clipImageMissing(image: ClipImage): boolean {
    return !!image.source.awaitingFile || !image.source.file || image.source.file.size === 0;
  }

  /**
   * True when the whole picture lands inside the finished frame.
   *
   * Measured against the plan's own frame, not against the resolution preset:
   * a reframed project crops, and a placement that fits a 16:9 master can be
   * half off the side of the 9:16 export it is actually being written into.
   */
  clipImageFits(image: ClipImage): boolean {
    const plan = this.plan;
    return imageBox(image, Math.max(1, plan.width), Math.max(1, plan.height)).contained;
  }

  /**
   * What else this picture lands on, at the instants it is on screen.
   *
   * The editor already knows exactly where the caption and the tag are drawn,
   * so a picture covering either is something it can say rather than something
   * the reader has to discover in the export. Only the overlap that actually
   * hides something is reported: a picture sitting *behind* the person is still
   * in front of the scenery, and a caption underneath it is still covered.
   *
   * Measured against the placement's own interval, not the whole clip. A logo
   * that leaves before the caption arrives is not covering anything.
   */
  clipImageCovers(clip: MediaClip, image: ClipImage): string[] {
    const plan = this.plan;
    const width = Math.max(1, plan.width);
    const height = Math.max(1, plan.height);
    const box = imageBox(image, width, height);
    const context = this.measuringContext();
    if (!context) return [];

    const bounds = clipBounds(clip);
    const start = Math.max(bounds.start, image.startSeconds ?? bounds.start);
    const end = Math.min(bounds.end, start + Math.max(0, image.durationSeconds ?? 0));
    const overlaps = (other: { left: number; top: number; right: number; bottom: number }) =>
      other.left < box.right && box.left < other.right && other.top < box.bottom && box.top < other.bottom;

    const covered: string[] = [];
    for (const caption of clip.captions ?? []) {
      const captionStart = Math.max(bounds.start, caption.startSeconds ?? bounds.start);
      const captionEnd = Math.min(bounds.end, captionStart + Math.max(0, caption.durationSeconds ?? bounds.end - captionStart));
      if (captionEnd <= start + 1e-4 || end <= captionStart + 1e-4) continue;
      const area = captionBox(context, caption, width, height);
      if (area && overlaps(area)) {
        const text = caption.text.trim().replace(/\s+/g, ' ');
        covered.push(`the caption "${text.length > 24 ? `${text.slice(0, 23)}…` : text}"`);
      }
    }

    // A tag belongs to the whole container rather than to an interval, so any
    // placement on this container can reach it.
    if (clip.tag) {
      const tag = measureTag(context, clip.tag, width, height);
      if (overlaps({ left: tag.x, top: tag.y, right: tag.x + tag.width, bottom: tag.y + tag.height })) {
        covered.push('the tag');
      }
    }
    return covered;
  }

  /** How the panel says it. Empty when the picture covers nothing. */
  clipImageCoversLabel(clip: MediaClip, image: ClipImage): string {
    const covered = this.clipImageCovers(clip, image);
    if (!covered.length) return '';
    return covered.length === 1
      ? `This image covers ${covered[0]}.`
      : `This image covers ${covered.slice(0, -1).join(', ')} and ${covered[covered.length - 1]}.`;
  }

  /**
   * A throwaway 2D context, kept for measuring text.
   *
   * Nothing is ever drawn on it. Both `captionBox` and `measureTag` have to set
   * a font and ask the browser how wide the glyphs are, and that needs a real
   * canvas even when the answer is only a number.
   */
  private measuring: CanvasRenderingContext2D | null = null;

  private measuringContext(): CanvasRenderingContext2D | null {
    if (!this.measuring) {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      this.measuring = canvas.getContext('2d');
    }
    return this.measuring;
  }

  /** True when the rotation is past the restraint the AI clients are held to. */
  clipImageStronglyRotated(image: ClipImage): boolean {
    return Math.abs(image.rotationDegrees ?? 0) > IMAGE_RESTRAINED_ROTATION;
  }

  clipImageMaximumFade(image: ClipImage): number {
    return Math.max(0, (image.durationSeconds ?? 0) / 2);
  }

  clipImageEdgeLabel(image: ClipImage): string {
    const fade = image.fadeSeconds ?? 0;
    return fade <= 0 ? 'Cut' : `${fade.toFixed(1)}s fade in and out`;
  }

  clipImageMaximumDuration(clip: MediaClip, image: ClipImage): number {
    const bounds = clipBounds(clip);
    return roundSeconds(Math.max(0.2, bounds.end - (image.startSeconds ?? bounds.start)));
  }

  clipImageOverflows(clip: MediaClip, image: ClipImage): boolean {
    return (image.startSeconds ?? 0) + (image.durationSeconds ?? 0) > clipBounds(clip).end + 1e-4;
  }

  /** Where this placement lands in the finished clip, in seconds. */
  clipImageEditedStart(clip: MediaClip, image: ClipImage): number {
    const edits = this.editsFor(clip);
    const speed = clampSpeed(edits.speed);
    const bounds = clipBounds(clip);
    const source = Math.max(bounds.start, image.startSeconds ?? bounds.start);
    return roundSeconds(cutTimeOf(keepRangesFor(clip, edits), source) / speed);
  }

  /** True when the cuts or the speed move this placement away from its source time. */
  clipImageClocksDiffer(clip: MediaClip, image: ClipImage): boolean {
    const bounds = clipBounds(clip);
    const source = Math.max(bounds.start, image.startSeconds ?? bounds.start);
    return Math.abs(this.clipImageEditedStart(clip, image) - (source - bounds.start)) > 0.05;
  }

  /**
   * Puts the playhead in the middle of this placement, so the preview shows it.
   *
   * The placement is timed on the container's source clock and the playhead
   * runs on the output clock, so the conversion is the same one the panel
   * already shows beside the field: the cuts pull it earlier, the speed divides
   * it, and the container's own start on the timeline puts it back.
   */
  previewClipImage(clip: MediaClip, image: ClipImage): void {
    const entry = this.plan.clips.find(candidate => candidate.clip.id === clip.id);
    if (!entry) return;
    const bounds = clipBounds(clip);
    const start = Math.max(bounds.start, image.startSeconds ?? bounds.start);
    const span = Math.max(0, Math.min(image.durationSeconds ?? 0, bounds.end - start));
    const edits = this.editsFor(clip);
    const middle = cutTimeOf(keepRangesFor(clip, edits), start + span / 2) / clampSpeed(edits.speed);
    this.playhead = Math.max(0, Math.min(this.plan.totalDuration, entry.outputStart + middle));
  }

  private ensureTimedVideoEffects(clip: MediaClip): void {
    if (clip.videoEffects) return;
    const legacy = normalizeVideoEffect(clip.videoEffect);
    const bounds = clipBounds(clip);
    clip.videoEffects = legacy.id === 'none' || legacy.intensity <= 0 ? [] : [{
      id: `effect-${this.nextId++}`,
      effectId: legacy.id,
      intensity: legacy.intensity,
      startSeconds: bounds.start,
      durationSeconds: bounds.end - bounds.start
    }];
    clip.videoEffect = { id: 'none', intensity: 0 };
  }

  applyCaptionPreset(clip: MediaClip, caption: ClipCaption, presetId: string): void {
    const patch = captionPresetPatch(caption, presetId);
    if (patch) this.updateCaption(clip, caption, patch);
  }

  updateCaptionStyle(clip: MediaClip, caption: ClipCaption, change: Partial<ClipCaption>): void {
    const behindSubject = this.isBehindSubjectCaption(caption);
    this.updateCaption(clip, caption, {
      ...change,
      ...(behindSubject ? { style: 'behind-subject', stylePreset: 'custom-background' } : { stylePreset: 'custom' })
    });
  }

  captionPresetOf(caption: ClipCaption): string {
    if (this.isBehindSubjectCaption(caption)) {
      return caption.stylePreset && captionPresetIsBackground(caption.stylePreset)
        ? caption.stylePreset : 'custom-background';
    }
    return caption.stylePreset && CAPTION_PRESETS.some((preset) => preset.id === caption.stylePreset && preset.group === 'classic')
      ? caption.stylePreset : caption.stylePreset === 'custom' ? 'custom' : 'classic';
  }

  isBehindSubjectCaption(caption: ClipCaption): boolean {
    return isBackgroundCaption(caption);
  }

  behindSubjectPositionOf(caption: ClipCaption): string {
    const x = caption.positionX ?? 0.5;
    const y = caption.positionY ?? 0.25;
    return this.behindSubjectPositions.find((item) => Math.abs(item.x - x) < 0.005 && Math.abs(item.y - y) < 0.005)?.id ?? 'custom';
  }

  applyBehindSubjectPosition(clip: MediaClip, caption: ClipCaption, id: string): void {
    const position = this.behindSubjectPositions.find((item) => item.id === id);
    if (position) this.updateCaptionStyle(clip, caption, { positionX: position.x, positionY: position.y });
  }

  onCaptionNumber(
    clip: MediaClip,
    caption: ClipCaption,
    key: 'startSeconds' | 'durationSeconds' | 'fontScale' | 'bottomMargin' | 'outlinePercent' | 'fadeSeconds' |
      'positionX' | 'positionY' | 'rotationDegrees' | 'shadowBlurPercent' | 'shadowOpacity',
    value: string
  ): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    if (key === 'fontScale' || key === 'bottomMargin' || key === 'outlinePercent' || key === 'fadeSeconds' ||
        key === 'positionX' || key === 'positionY' || key === 'rotationDegrees' || key === 'shadowBlurPercent' || key === 'shadowOpacity') {
      const limits = CAPTION_LIMITS[key];
      const change = { [key]: Math.min(limits.max, Math.max(limits.min, parsed)) } as Partial<ClipCaption>;
      if (key === 'fontScale' || key === 'outlinePercent' || key === 'positionX' || key === 'positionY' ||
          key === 'rotationDegrees' || key === 'shadowBlurPercent' || key === 'shadowOpacity') this.updateCaptionStyle(clip, caption, change);
      else this.updateCaption(clip, caption, change);
      return;
    }
    // Read on whichever clock the fields are showing, stored on the source one.
    const seconds = key === 'startSeconds'
      ? this.sourceSeconds(clip, parsed)
      : this.sourceDurationOf(clip, caption.startSeconds, parsed);
    this.updateCaption(clip, caption, { [key]: seconds, ...(key === 'durationSeconds' ? { durationAutomatic: false } : {}) });
  }

  removeCaption(clip: MediaClip, caption: ClipCaption): void {
    clip.captions = (clip.captions ?? []).filter((item) => item.id !== caption.id);
    if (this.expandedCaptionId === caption.id) this.expandedCaptionId = null;
    clip.caption = null;
    this.touch();
  }

  captionOverflows(clip: MediaClip, caption: ClipCaption): boolean {
    return (caption.startSeconds ?? 0) + (caption.durationSeconds ?? 0) > clipBounds(clip).end + 1e-4;
  }

  captionMinimumStart(clip: MediaClip, caption: ClipCaption): number {
    const items = clip.captions ?? [];
    const index = items.findIndex((item) => item.id === caption.id);
    const previous = items[index - 1];
    return previous ? (previous.startSeconds ?? clipBounds(clip).start) + (previous.durationSeconds ?? 0) : clipBounds(clip).start;
  }

  captionMaximumDuration(clip: MediaClip, caption: ClipCaption): number {
    const items = clip.captions ?? [];
    const index = items.findIndex((item) => item.id === caption.id);
    const next = items[index + 1];
    return next ? Math.max(0.1, (next.startSeconds ?? 0) - (caption.startSeconds ?? 0)) : 600;
  }

  canAddCaption(clip: MediaClip): boolean {
    const bounds = clipBounds(clip);
    return (clip.captions ?? []).every(
      (caption) => (caption.startSeconds ?? bounds.start) + (caption.durationSeconds ?? 0) < bounds.end - 0.1
    );
  }

  private ensureTimedCaptions(clip: MediaClip): void {
    if (clip.captions) return;
    const bounds = clipBounds(clip);
    clip.captions = clip.caption?.text.trim() ? [{
      ...DEFAULT_CAPTION,
      ...clip.caption,
      id: `caption-${this.nextId++}`,
      startSeconds: bounds.start,
      durationSeconds: bounds.end - bounds.start,
      durationAutomatic: false
    }] : [];
    clip.caption = null;
  }

  // --------------------------------------------------------- the text card

  onTextDraft(change: Partial<TextClip['draft']>): void {
    const clip = this.editingText;
    if (!clip) return;

    const draft = { ...clip.draft, ...change };

    // A card is on screen to be read, and how long that takes depends on how
    // much there is: two words and a paragraph are not the same shot. So while
    // the reader has not set the hold themselves, it keeps up with the text.
    if (change.text !== undefined && draft.holdAuto !== false) {
      draft.holdSeconds = Math.round(readingSeconds(draft.text) * 10) / 10;
    }

    clip.draft = draft;
    this.touch();
    void this.refreshTextPreview();
  }

  /** True while the card's hold is still following the length of its text. */
  get textHoldIsAutomatic(): boolean {
    return this.editingText?.draft.holdAuto !== false;
  }

  /** Hands the timing back to the text after it was set by hand. */
  restoreAutomaticHold(): void {
    const clip = this.editingText;
    if (!clip) return;

    clip.draft = {
      ...clip.draft,
      holdAuto: true,
      holdSeconds: Math.round(readingSeconds(clip.draft.text) * 10) / 10
    };
    this.touch();
    void this.refreshTextPreview();
  }

  onTextNumber(key: 'fontScale' | 'margin' | 'lineHeight' | 'letterSpacing' | 'revealSeconds' | 'holdSeconds', value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;

    const limits =
      key === 'revealSeconds' ? TEXT_LIMITS.reveal : key === 'holdSeconds' ? TEXT_LIMITS.hold : TEXT_LIMITS[key];
    const change = { [key]: Math.min(limits.max, Math.max(limits.min, parsed)) } as Partial<TextClip['draft']>;

    // Setting the hold by hand is what turns the automatic timing off — and it
    // stays off, because a number that quietly rewrote itself on the next
    // keystroke would be worse than one that has to be adjusted.
    if (key === 'holdSeconds') change.holdAuto = false;

    this.onTextDraft(change);
  }

  async onTextBackground(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    const clip = this.editingText;
    if (!file || !clip) return;

    if (clip.backgroundUrl) URL.revokeObjectURL(clip.backgroundUrl);
    clip.backgroundFile = file;
    clip.backgroundUrl = mediaObjectUrl(file);
    this.touch();
    await this.refreshTextPreview();
  }

  clearTextBackground(): void {
    const clip = this.editingText;
    if (!clip) return;

    if (clip.backgroundUrl) URL.revokeObjectURL(clip.backgroundUrl);
    clip.backgroundFile = null;
    clip.backgroundUrl = null;
    this.touch();
    void this.refreshTextPreview();
  }

  /**
   * How long the card lasts, which is also the length of its animation.
   *
   * The same sum {@link sourceDuration} makes for a text clip, so the scrubber
   * in the dialog and the block on the timeline can never disagree about how
   * long the card is.
   */
  get textDuration(): number {
    const draft = this.editingText?.draft;
    if (!draft) return 0;
    return Math.max(0.1, draft.revealSeconds + draft.holdSeconds);
  }

  /**
   * Plays the card's animation in the dialog.
   *
   * A still frame cannot tell you whether a typewriter reveal is too slow or a
   * rise too abrupt, which are the only two questions anybody has about an
   * animation. So the preview has a clock of its own: it runs outside Angular,
   * draws through the same {@link drawFrame} the encoder uses, and loops, so
   * the card can be watched while its settings are being changed.
   */
  toggleTextPlay(): void {
    if (this.textPlaying) {
      this.stopTextPlayback();
      return;
    }
    if (!this.editingText || !isPlatformBrowser(this.platformId)) return;

    if (this.textTime >= this.textDuration - 1e-3) this.textTime = 0;
    this.textPlaying = true;
    this.textLastNow = performance.now();
    this.zone.runOutsideAngular(() => {
      this.textRaf = requestAnimationFrame(this.textLoop);
    });
  }

  restartTextPreview(): void {
    this.textTime = 0;
    this.drawTextFrame();
  }

  onTextScrub(value: string | number): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;

    this.stopTextPlayback();
    this.textTime = Math.max(0, Math.min(this.textDuration, parsed));
    this.drawTextFrame();
  }

  private stopTextPlayback(): void {
    this.textPlaying = false;
    if (this.textRaf) cancelAnimationFrame(this.textRaf);
    this.textRaf = 0;
  }

  private readonly textLoop = (): void => {
    if (!this.textPlaying || !this.editingText) return;

    const now = performance.now();
    this.textTime += (now - this.textLastNow) / 1000;
    this.textLastNow = now;

    // It loops rather than stopping at the end: the interesting part of a
    // two-second reveal is the two seconds, and having to press play again for
    // every look at it would be its own small annoyance.
    if (this.textTime > this.textDuration) this.textTime = 0;

    this.drawTextFrame();

    // The readout under the scrubber only has to look continuous, so Angular is
    // woken a few times a second rather than sixty.
    if (now - this.lastTextSync > 120) {
      this.lastTextSync = now;
      this.zone.run(() => this.cdr.markForCheck());
    }

    this.textRaf = requestAnimationFrame(this.textLoop);
  };

  /**
   * Redraws the card, small, through the same function the encoder uses.
   *
   * Same function, same scene, different size — which is the whole reason the
   * type size and the margins are stored as shares of the height rather than in
   * pixels. What the reader sees here is what comes out, at a twentieth of the
   * area.
   */
  private async refreshTextPreview(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;

    const clip = this.editingText;
    // Waits a tick because the canvas belongs to a dialog that may only be
    // opening now; the view child does not exist until Angular has drawn it.
    await Promise.resolve();
    const canvas = this.textPreview?.nativeElement;
    if (!clip || !canvas) return;

    if (clip.backgroundFile && !this.textBitmap) {
      try {
        this.textBitmap = await createImageBitmap(clip.backgroundFile);
      } catch {
        this.textBitmap = null;
      }
    }
    if (!clip.backgroundFile && this.textBitmap) {
      this.textBitmap.close();
      this.textBitmap = null;
    }

    const ratio = this.projectHeight / this.projectWidth;
    canvas.width = TEXT_PREVIEW_WIDTH;
    canvas.height = Math.round(TEXT_PREVIEW_WIDTH * ratio);

    this.drawTextFrame();
  }

  /**
   * Paints the card at whatever instant the dialog's clock is showing.
   *
   * Paused, that instant is the one the reader scrubbed to, and it starts at
   * zero rather than at the end of the reveal: a card whose animation can be
   * played should open on its first frame, not on its last.
   */
  private drawTextFrame(): void {
    const clip = this.editingText;
    const canvas = this.textPreview?.nativeElement;
    if (!clip || !canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const background: SceneBackground = this.textBitmap
      ? { kind: 'image', image: this.textBitmap, width: this.textBitmap.width, height: this.textBitmap.height }
      : { kind: 'color', color: clip.draft.backgroundColor };

    const scene: TextScene = {
      width: canvas.width,
      height: canvas.height,
      background,
      text: clip.draft.text || 'Your text here',
      fontFamily: fontStack(clip.draft.fontId),
      fontScale: clip.draft.fontScale,
      fontWeight: clip.draft.fontWeight,
      color: clip.draft.color,
      letterSpacing: clip.draft.letterSpacing,
      lineHeight: clip.draft.lineHeight,
      align: clip.draft.align,
      vertical: clip.draft.vertical,
      margin: clip.draft.margin,
      legibility: clip.draft.legibility,
      animation: clip.draft.animation,
      revealSeconds: clip.draft.revealSeconds,
      holdSeconds: clip.draft.holdSeconds,
      fadeIn: false,
      fadeOut: false,
      fadeSeconds: 0
    };

    drawFrame(context, scene, this.textTime);
  }

  // ------------------------------------------------------------ the export

  /**
   * Exports the timeline and hands the file over.
   *
   * The save dialog is opened first, before anything is awaited: it needs the
   * user activation from this very click, and asking for it after the encode
   * would leave a reader who wanted the file on disk with a download instead.
   * Everything slow — listening to the clips that still need it, then the
   * encode — happens after it, which is also why the picker appears instantly
   * however large the project is.
   */
  async export(kind: 'video' | 'audio', fromClip = 0, part = 1): Promise<void> {
    if (this.exporting || !this.clips.length || !isPlatformBrowser(this.platformId)) return;

    // Claimed before the save dialog is awaited: while that dialog is open the
    // buttons are still on screen, and a second click would start a second
    // export writing into the same file.
    this.exporting = kind;

    const format = kind === 'video' ? this.videoFormat : this.audioFormat;
    // A continued export writes a file of its own rather than reopening the one
    // before it: a finalised container has had its index written and there is no
    // honest way to append to it. Naming it by its part is what keeps the two
    // recognisable as halves of one thing.
    const destination = await this.renderer.pickDestination(kind, format, part > 1 ? 'part-' + part : '');

    // A paused media element still owns its decoder. Keeping the timeline
    // preview mounted while an export opens one decoder per clip — and two at a
    // transition — is enough to exhaust a browser's codec slots, especially on
    // a second export after the plan changed. Release it completely and restore
    // the reader's place when the encoder is done.
    const previewState = {
      open: this.previewOpen,
      playing: this.player?.playing ?? false,
      time: this.player?.currentTime ?? this.previewTime
    };
    if (previewState.open) this.closeTimelinePreview();

    this.clearMessages();
    const controller = new AbortController();
    this.controller = controller;
    const stopper = new AbortController();
    this.stopper = stopper;
    this.progress = { stage: 'preparing', ratio: 0, clipIndex: 0, clipCount: this.clips.length, clipName: '' };
    this.startLog();
    this.pushLog({ kind: 'step', text: 'Reading the timeline' });

    try {
      await this.runPendingAnalyses(controller.signal);
      await this.runPendingNoiseSuppressions(controller.signal);

      const whole = buildProjectPlan(this.clips, this.project, kind);
      // The whole edit, or what is left of one that was stopped. Sliced here
      // rather than inside the renderer, so the renderer's one rule survives:
      // everything it is handed starts at nought and never goes backwards.
      const plan = fromClip > 0 ? slicePlan(whole, fromClip) : whole;
      const envelopes = this.buildEnvelopes();

      const result = await this.zone.runOutsideAngular(() =>
        this.renderer.render({
          plan,
          project: this.project,
          kind,
          format,
          envelopes,
          destination,
          signal: controller.signal,
          stopSignal: stopper.signal,
          onProgress: (report) =>
            this.zone.run(() => {
              this.progress = report;
              this.cdr.markForCheck();
            }),
          onLog: (entry) =>
            this.zone.run(() => {
              this.pushLog(entry);
              this.cdr.markForCheck();
            })
        })
      );

      this.result = result;

      if (result.partial) {
        // Where the next part begins, counted on the whole timeline rather than
        // on the slice this run was given — otherwise a third part would start
        // again from the beginning of the second one.
        this.resume = {
          kind,
          index: fromClip + result.nextClipIndex,
          total: whole.clips.length,
          part: part + 1
        };
        this.message = `Stopped. ${result.fileName} holds the edit up to that point.`;
      } else {
        this.resume = null;
        // The whole path when one is known. "Saved as edited.mp4" says nothing
        // on a machine with four folders called Exports.
        this.message = result.savedToDisk
          ? `Saved as ${result.filePath || result.fileName}.`
          : `${result.fileName} is ready.`;
      }

      if (!result.savedToDisk) this.download(result);
    } catch (error) {
      // The save stream is opened before analysis so the browser still accepts
      // the click as user activation. If analysis or encoder setup fails before
      // Mediabunny takes ownership of it, leaving it open can lock the chosen
      // file and make the next export fail. Aborting an already-closed stream is
      // harmless and deliberately ignored.
      await destination.handle?.abort().catch(() => undefined);

      if (error instanceof EditorCanceledError || error instanceof OperationCanceledError) {
        this.message = 'The export was canceled.';
        this.pushLog({ kind: 'warn', text: 'Cancelled — nothing was kept' });
      } else if (error instanceof EditorError) {
        this.errorMessage = error.message;
        this.errorHint = error.hint ?? '';
        // Which clip, and what actually went wrong. Neither used to be shown,
        // which left "check that every clip is valid" as the only instruction
        // for a timeline of thirty of them.
        this.errorClip = error.clipLabel ?? '';
        this.errorDetail = error.detail ?? technicalDetail(error);
      } else if (error instanceof MediaToolError) {
        this.errorMessage = error.message;
        this.errorHint = error.hint ?? '';
        this.errorDetail = technicalDetail(error);
      } else {
        console.error(error);
        this.errorMessage = 'The edited file could not be generated.';
        this.errorHint = 'Check that every clip on the timeline is valid and try again.';
        this.errorDetail = technicalDetail(error);
      }

      if (this.errorMessage) {
        this.pushLog({
          kind: 'fail',
          text: this.errorClip ? `Failed on ${this.errorClip} — ${this.errorMessage}` : `Failed — ${this.errorMessage}`
        });
        // Built after the failing line is in the log, so the log it captures
        // ends with the failure rather than with the step before it.
        this.renderDiagnostic = await this.captureRenderDiagnostic(error);
        this.renderDiagnosticMessage = '';
      }
    } finally {
      this.exporting = null;
      this.progress = null;
      this.controller = null;
      this.stopper = null;

      if (previewState.open && this.clips.length && !this.hasAwaitingFiles) {
        try {
          await this.openTimelinePreview();
          const restoredTime = Math.min(previewState.time, this.plan.totalDuration);
          this.player?.seek(restoredTime);
          this.previewTime = restoredTime;

          if (previewState.playing && this.player) {
            const player = this.player;
            await this.zone.runOutsideAngular(() => player.play());
            this.previewPlaying = player.playing;
          }
        } catch {
          // The export result is already settled. A preview that cannot be
          // remounted must not turn a successful file into a reported failure.
        }
      }

      this.cdr.markForCheck();
    }
  }

  /**
   * Listens to whatever still needs it before the encode begins.
   *
   * A reader who ticks "remove the silent stretches" for the whole project and
   * presses export has said what they want; making them press a second button
   * per clip first would be pedantry. Nothing is analyzed twice, because a
   * finished analysis is kept on the clip until a setting invalidates it.
   */
  private async runPendingAnalyses(signal: AbortSignal): Promise<void> {
    const cancelAutomatic = () => this.cancelAnalyses();
    signal.addEventListener('abort', cancelAutomatic, { once: true });
    try {
      await this.waitForAutomaticListening();
    } finally {
      signal.removeEventListener('abort', cancelAutomatic);
    }
    if (signal.aborted) throw new EditorCanceledError();

    const pending = clipsNeedingAnalysis(this.clips, this.project).concat(
      this.clips.filter((clip): clip is MediaClip => isMediaClip(clip) && this.isStale(clip))
    );
    const unique = pending.filter((clip, index) => pending.indexOf(clip) === index);
    if (!unique.length) return;

    // Several at a time, in lanes, exactly as the button on the page does it.
    // This is the queue that used to make a long export feel like two exports:
    // the decoding runs in a worker, so doing them one after another left most
    // of the machine idle while the reader watched a progress bar.
    let next = 0;
    let done = 0;

    const report = (clip: MediaClip) =>
      this.zone.run(() => {
        this.progress = {
          stage: 'analyzing',
          ratio: done / unique.length,
          clipIndex: Math.min(unique.length, done + 1),
          clipCount: unique.length,
          clipName: clip.summary.fileName
        };
        this.cdr.markForCheck();
      });

    const lane = async (): Promise<void> => {
      while (next < unique.length) {
        if (signal.aborted) throw new EditorCanceledError();

        const clip = unique[next++];
        report(clip);

        clip.info ??= await this.inspector.inspect(clip.file);
        const strategy = await this.selector.select(clip.info, 'automatic', { hasCuts: true });
        const settings = this.editsFor(clip).silence;

        const analysis = await this.analyser.analyze(clip.file, clip.info, {
          settings,
          strategy,
          signal,
          onProgress: () => undefined
        });

        clip.analysis = analysis;
        clip.detected = analysis.silenceRanges.map((range) => ({ ...range }));
        clip.analyzedWith = { ...settings, autoZoom: { ...settings.autoZoom } };
        done++;
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.analysisLanes, unique.length) }, lane));
  }

  /** Builds only the enabled per-clip caches that export actually needs. */
  private async runPendingNoiseSuppressions(signal: AbortSignal): Promise<void> {
    const pending = this.clips.filter((clip): clip is MediaClip =>
      isMediaClip(clip) &&
      !clip.awaitingFile &&
      clip.summary.audioUsable &&
      this.noiseSettingsFor(clip).enabled &&
      !this.noiseReady(clip)
    );
    for (const [index, clip] of pending.entries()) {
      if (signal.aborted) throw new EditorCanceledError();
      const text = `Removing noise from ${clip.summary.fileName}`;
      this.pushLog({ kind: 'clip', text });
      this.progress = {
        stage: 'analyzing',
        ratio: pending.length ? index / pending.length : 0,
        clipIndex: index + 1,
        clipCount: pending.length,
        clipName: clip.summary.fileName
      };
      await this.runNoiseSuppression(clip, this.noiseSettingsFor(clip), signal);
      this.noiseProgress.delete(clip.id);
    }
  }

  /**
   * The gain curve for every clip that has one.
   *
   * Levelling reads the per-bucket loudness the waveform already carries, so a
   * clip that was listened to for its silences costs nothing extra to level.
   * A clip with nothing above the noise floor gets no entry at all rather than
   * a neutral one, which is what keeps the renderer from touching its samples.
   */
  private buildEnvelopes(): Map<string, GainEnvelope> {
    const envelopes = new Map<string, GainEnvelope>();
    if (!this.project.loudness.enabled) return envelopes;

    for (const clip of this.clips) {
      if (!isMediaClip(clip) || !clip.analysis) continue;

      const { waveform } = clip.analysis;
      const envelope = planGainEnvelope(
        waveform.rms,
        waveform.secondsPerBucket,
        waveform.duration,
        this.project.loudness
      );
      if (envelope) envelopes.set(clip.id, envelope);
    }

    return envelopes;
  }

  cancel(): void {
    this.controller?.abort();
    // Listening runs on controllers of its own now that several clips can be
    // heard at once, so one Cancel has to reach all of them.
    this.cancelAnalyses();
  }

  /** Downloads the finished file when it was not streamed straight to disk. */
  download(result: RenderResult | null = this.result): void {
    if (!result?.blob || typeof document === 'undefined') return;

    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }


  // ------------------------------------------------------- the transcript

  /**
   * The transcript, and why it is built from the plan rather than from a file.
   *
   * The recogniser hears a clip's source: it knows nothing of in points, cuts,
   * removed pauses, speed or the order the cards ended up in. So every word
   * comes back on the source clock and is moved onto the finished video's clock
   * by the same functions the encoder uses — which is what lets a subtitle file
   * written here be dropped straight onto the file "Export video" produces.
   *
   * The alternative was to render the whole timeline to audio and listen to
   * that. It would have been fewer lines and much slower: an encode of the
   * entire project before a single word is heard, repeated every time anything
   * on the timeline moves.
   */
  get canTranscribe(): boolean {
    return (
      this.clips.length > 0 &&
      !this.hasAwaitingFiles &&
      !this.exporting &&
      !this.reading &&
      !this.analysisBusy &&
      spokenEntries(this.plan).length > 0
    );
  }

  /** Whether this one card has a voice of its own that can be listened to. */
  canTranscribeClip(clip: EditorClip | null): boolean {
    return (
      !!clip &&
      isMediaClip(clip) &&
      !clip.awaitingFile &&
      clip.summary.audioUsable &&
      !this.exporting
    );
  }

  openTranscript(): void {
    if (!this.canTranscribe) return;
    this.transcript = { scope: 'project', clip: null };
    this.resetTranscript();
  }

  /** The same dialog, asked about one card. Opened from that card's settings. */
  openClipTranscript(clip: MediaClip): void {
    if (!this.canTranscribeClip(clip)) return;
    this.transcript = { scope: 'clip', clip };
    this.resetTranscript();
  }

  /**
   * Closes it — unless it is working.
   *
   * A stray click on the backdrop must not throw away a recogniser that has
   * been listening for four minutes. Stopping is a button that says so.
   */
  closeTranscript(): void {
    if (this.transcriptWorking) return;
    this.transcript = null;
    this.revokeTranscript();
  }

  stopTranscript(): void {
    this.transcriptController?.abort();
  }

  private resetTranscript(): void {
    this.transcriptCues = [];
    this.transcriptPreviewKey = '';
    this.transcriptMessage = '';
    this.transcriptError = '';
    this.transcriptHint = '';
    this.transcriptStep = '';
    this.transcriptStage = '';
    this.transcriptDetail = '';
    this.transcriptRatio = null;
    this.revokeTranscript();
    this.cdr.markForCheck();
  }

  /**
   * The clips this run will listen to, in the order they play.
   *
   * For the whole project that is every clip whose own voice reaches the
   * finished file. For one card it is that card, whatever the edit does with
   * its sound afterwards — a reader who asks a clip for its transcript is
   * asking about what was said in it.
   */
  private transcriptEntries(): ClipPlan[] {
    const plan = this.plan;
    const wanted = this.transcript?.scope === 'clip' ? this.transcript.clip : null;

    const entries =
      wanted === null
        ? spokenEntries(plan)
        : plan.clips.filter(
            (entry) =>
              entry.clip === wanted &&
              isMediaClip(entry.clip) &&
              !entry.clip.awaitingFile &&
              entry.clip.summary.audioUsable
          );

    return entries.filter((entry) => entry.keptDuration >= TRANSCRIPT_MIN_SECONDS);
  }

  get transcriptClipCount(): number {
    return this.transcriptEntries().length;
  }

  /** Clips of the project left out, because their voice is not in the file. */
  get transcriptSkipped(): number {
    if (this.transcript?.scope !== 'project') return 0;
    return Math.max(0, this.clips.filter(isMediaClip).length - this.transcriptClipCount);
  }

  /** True when the card being transcribed is muted or plays a supplied track. */
  get transcriptClipSilenced(): boolean {
    if (this.transcript?.scope !== 'clip') return false;
    const entry = this.transcriptEntries()[0];
    return !!entry && entry.sound.kind !== 'original';
  }

  get canRunTranscript(): boolean {
    return !!this.transcript && !this.transcriptWorking && !this.exporting && this.transcriptClipCount > 0;
  }

  get transcriptModel() {
    return this.speechModels.find((model) => model.id === this.transcriptModelId) ?? this.speechModels[0];
  }

  get transcriptStrength() {
    return this.noiseStrengths[this.transcriptStrengthIndex] ?? this.noiseStrengths[1];
  }

  get transcriptEngineNote(): string {
    return this.noiseEngines.find((engine) => engine.id === this.transcriptEngine)?.note ?? '';
  }

  /**
   * Listens to everything in scope and writes the cues.
   *
   * Clip by clip rather than all at once: each run holds a speech model in
   * memory, and four of them side by side is how a browser tab runs out of room
   * on the machine of the person least able to afford it.
   */
  async runTranscript(): Promise<void> {
    if (!this.transcript || this.transcriptWorking || !isPlatformBrowser(this.platformId)) return;

    const entries = this.transcriptEntries();
    if (!entries.length) return;

    const scope = this.transcript.scope;
    this.transcriptWorking = true;
    this.transcriptCues = [];
    this.transcriptPreviewKey = '';
    this.transcriptMessage = '';
    this.transcriptError = '';
    this.transcriptHint = '';
    this.revokeTranscript();

    const controller = new AbortController();
    this.transcriptController = controller;

    const cues: Cue[] = [];

    try {
      for (const [index, entry] of entries.entries()) {
        if (controller.signal.aborted) throw new TranscriptionCanceled();

        const clip = entry.clip as MediaClip;
        this.transcriptStep =
          entries.length > 1
            ? `Clip ${index + 1} of ${entries.length} — ${clip.summary.fileName}`
            : clip.summary.fileName;
        this.reportTranscript({ stage: 'reading', ratio: 0, detail: clip.summary.fileName });

        const words = await this.wordsFor(clip, entry, controller.signal);

        // Grouped after placing, never before: a pause the edit removed is not
        // a pause in the finished video, and two words either side of a cut
        // belong in the same caption there.
        const placed = placeWords(words, entry, scope === 'clip' ? entry.outputStart : 0);
        cues.push(
          ...groupWords(placed, DEFAULT_SHAPE.lineLength, DEFAULT_SHAPE.maxLines, DEFAULT_SHAPE.maxSeconds)
        );

        // What has been heard so far, shaped and on screen, so a long project
        // shows a growing transcript instead of a bar and a promise.
        this.transcriptCues = shapeCues(cues, DEFAULT_SHAPE, this.transcriptDuration(scope, entries));
        this.transcriptPreviewKey = '';
        this.cdr.markForCheck();
      }

      this.transcriptMessage = this.transcriptCues.length
        ? `Transcribed ${this.transcriptCues.length} caption${this.transcriptCues.length === 1 ? '' : 's'}.`
        : 'No speech was heard in this material.';
    } catch (error) {
      if (error instanceof TranscriptionCanceled || error instanceof SuppressionCanceled) {
        this.transcriptMessage = this.transcriptCues.length
          ? 'Stopped. What was heard up to that point can still be downloaded.'
          : 'Stopped.';
      } else if (error instanceof TranscriptionError || error instanceof SuppressionError) {
        this.transcriptError = error.message;
        this.transcriptHint = error.hint;
      } else {
        console.error(error);
        this.transcriptError = 'The transcript could not be produced.';
        this.transcriptHint = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.transcriptWorking = false;
      this.transcriptController = null;
      this.transcriptStep = '';
      this.transcriptStage = '';
      this.transcriptDetail = '';
      this.transcriptRatio = null;
      this.cdr.markForCheck();
    }
  }

  /** How long the finished thing is, which is where a cue may not run past. */
  private transcriptDuration(scope: 'project' | 'clip', entries: readonly ClipPlan[]): number {
    return scope === 'clip' ? entries[0]?.outputDuration ?? Infinity : this.plan.totalDuration;
  }

  /**
   * What was said in one clip, on the source clock.
   *
   * Only the stretch the timeline actually reads is listened to, with a second
   * of margin either side so a word at the edge is still recognisable. On a
   * forty-minute take trimmed to two, that is the difference between a
   * transcript and an afternoon.
   */
  private async wordsFor(clip: MediaClip, entry: ClipPlan, signal: AbortSignal): Promise<Cue[]> {
    const key = [
      clip.id,
      this.transcriptModelId,
      this.transcriptLanguage || 'auto',
      this.transcriptDenoise ? `${this.transcriptEngine}:${this.transcriptStrength.attenuationDb}` : 'raw'
    ].join('|');

    const remembered = this.heardByClip.get(key);
    if (remembered) return remembered;

    const report = (progress: TranscriptionProgress | SuppressionProgress) =>
      this.zone.run(() => this.reportTranscript(progress));

    const decoded = await readSpeechAudio(clip.file, report, signal);
    if (signal.aborted) throw new TranscriptionCanceled();

    const span = spokenSpan(entry, SPEECH_RATE, decoded.length);
    // A copy, not a view: both the suppressor and the recogniser take ownership
    // of the buffer they are handed, and a view would hand them the whole file.
    let listened = decoded.slice(span.from, span.to);

    if (this.transcriptDenoise) {
      const cleaned = await suppress(
        {
          channels: [listened],
          rate: SPEECH_RATE,
          engine: this.transcriptEngine,
          attenuationDb: this.transcriptStrength.attenuationDb,
          preserveHighs: false
        },
        report,
        signal
      );
      listened = cleaned.channels[0];
    }

    const offset = span.from / SPEECH_RATE;
    const heard = await transcribe(
      listened,
      { model: this.transcriptModelId, language: this.transcriptLanguage },
      report,
      signal
    );

    const words = offset
      ? heard.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset }))
      : heard;

    this.heardByClip.set(key, words);
    return words;
  }

  /**
   * The line and the bar above the transcript.
   *
   * The bar measures the stage in front of it rather than the whole job, and
   * the line beside it says which clip that stage belongs to. A single bar
   * covering both would have to run backwards every time a model was fetched.
   */
  private reportTranscript(progress: { stage: string; ratio: number | null; detail: string }): void {
    this.transcriptStage = TRANSCRIPT_STAGE[progress.stage] ?? '';
    this.transcriptDetail = progress.detail ?? '';
    this.transcriptRatio = progress.ratio === null ? null : Math.min(1, Math.max(0, progress.ratio));
    if (this.agentWorking) {
      if (progress.stage !== this.lastAgentTranscriptStage) {
        this.lastAgentTranscriptStage = progress.stage;
        this.agentTranscriptStageTimeout?.(progress.stage);
        // A new stage is worth a line whatever the throttle thinks: it is the
        // difference between "still fetching the model" and "actually
        // listening", which is the question a reader is asking.
        this.agentProgressReset('transcribe');
      }
      this.agentProgress(
        'transcribe',
        `${this.transcriptStage || progress.stage}${progress.detail ? ` — ${progress.detail}` : ''}`,
        this.transcriptRatio === null ? null : this.transcriptRatio * 100
      );
    }
    this.cdr.markForCheck();
  }

  /* ------------------------------------------------------ the files it writes */

  get transcriptFormat() {
    return this.subtitleFormats.find((entry) => entry.id === this.transcriptFormatId) ?? this.subtitleFormats[0];
  }

  get transcriptPreview(): string {
    if (this.transcriptPreviewKey !== this.transcriptFormatId) {
      this.transcriptPreviewText = this.transcriptCues.length
        ? writeSubtitles(this.transcriptCues, this.transcriptFormatId)
        : '';
      this.transcriptPreviewKey = this.transcriptFormatId;
    }
    return this.transcriptPreviewText;
  }

  /** The recording's own name with a new extension, as the transcriber does it. */
  get transcriptFileName(): string {
    const source =
      this.transcript?.scope === 'clip'
        ? this.transcript.clip?.summary.fileName ?? 'clip'
        : this.clips.filter(isMediaClip)[0]?.summary.fileName ?? 'timeline';
    const stem = source.replace(/\.[^.]+$/, '') || 'transcript';
    const suffix =
      this.transcriptFormatId === 'txt-plain' ? '-text' : this.transcriptFormatId === 'txt-timed' ? '-transcript' : '';
    return `${stem}${suffix}.${this.transcriptFormat.extension}`;
  }

  get transcriptWords(): number {
    return wordCount(this.transcriptCues);
  }

  get transcriptCovered(): string {
    return this.transcriptCues.length ? readableTime(this.transcriptCues[this.transcriptCues.length - 1].end) : '0:00';
  }

  get transcriptPercent(): string {
    return this.transcriptRatio === null ? '' : `${Math.round(this.transcriptRatio * 100)}%`;
  }

  downloadTranscript(format: SubtitleFormat = this.transcriptFormatId): void {
    if (!this.transcriptCues.length || typeof document === 'undefined') return;

    this.transcriptFormatId = format;

    // A BOM in front of the text. Without it Notepad and a few caption
    // uploaders read a UTF-8 file as the local codepage, and every accented
    // word in the transcript arrives broken.
    const blob = new Blob(['﻿', this.transcriptPreview], {
      type: `${this.transcriptFormat.mimeType};charset=utf-8`
    });

    this.revokeTranscript();
    this.transcriptUrl = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = this.transcriptUrl;
    anchor.download = this.transcriptFileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async copyTranscript(): Promise<void> {
    if (!this.transcriptCues.length || !isPlatformBrowser(this.platformId)) return;

    try {
      await navigator.clipboard.writeText(this.transcriptPreview);
      this.transcriptMessage = 'Copied to the clipboard.';
    } catch {
      this.transcriptMessage = 'The browser refused clipboard access — select the text and copy it by hand.';
    }
    this.cdr.markForCheck();
  }

  private revokeTranscript(): void {
    if (!this.transcriptUrl) return;
    URL.revokeObjectURL(this.transcriptUrl);
    this.transcriptUrl = null;
  }

  // ----------------------------------------------------------- thumbnails

  /**
   * Draws a still from the clip for its row.
   *
   * A row of file names all looks the same; a row of pictures does not, and
   * picking the wrong take out of six files called `DJI_05xx.MP4` is exactly
   * the mistake this prevents. It is best-effort throughout: a codec the
   * browser will not decode, a seek that never completes, a canvas that refuses
   * — any of them simply leaves the icon in place.
   */
  private enqueueThumbnail(clip: MediaClip): void {
    this.thumbQueue = this.thumbQueue.then(() => this.captureThumbnail(clip)).catch(() => undefined);
  }

  private async captureThumbnail(clip: MediaClip): Promise<void> {
    if (!isPlatformBrowser(this.platformId) || clip.summary.kind === 'audio') return;

    const url = mediaObjectUrl(clip.file);

    try {
      const source =
        clip.summary.kind === 'image'
          ? await imageBitmapForFile(clip.file).catch(() => null)
          : await this.grabFirstFrame(url, clip.summary.durationSeconds);
      if (!source) return;

      const canvas = document.createElement('canvas');
      canvas.width = THUMB_WIDTH;
      canvas.height = THUMB_HEIGHT;
      const context = canvas.getContext('2d');
      if (!context) return;

      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (!width || !height) return;

      // Filled rather than fitted: a thumbnail this small is a reminder of what
      // the shot looks like, and letterbox bars would spend half of it on black.
      const scale = Math.max(THUMB_WIDTH / width, THUMB_HEIGHT / height);
      context.fillStyle = '#000000';
      context.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
      context.drawImage(
        source,
        (THUMB_WIDTH - width * scale) / 2,
        (THUMB_HEIGHT - height * scale) / 2,
        width * scale,
        height * scale
      );

      clip.thumbUrl = canvas.toDataURL('image/jpeg', 0.72);
      if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
    } catch {
      /* A missing thumbnail costs nothing; a failed export would. */
    } finally {
      URL.revokeObjectURL(url);
      this.cdr.markForCheck();
    }
  }

  /** Seeks a detached video element just past its start and hands it back. */
  private grabFirstFrame(url: string, duration: number): Promise<HTMLVideoElement | null> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      let settled = false;
      const finish = (value: HTMLVideoElement | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => finish(null), THUMB_TIMEOUT);

      video.onloadeddata = () => {
        video.currentTime = Math.min(THUMB_TIME, Math.max(0, duration - 0.01));
      };
      video.onseeked = () => finish(video);
      video.onerror = () => finish(null);

      video.src = url;
    });
  }

  // ---------------------------------------------------------- presentation

  get videoFormat() {
    return videoFormat(this.project.videoFormatId);
  }

  get audioFormat() {
    return audioFormat(this.project.audioFormatId);
  }

  /** The finished timeline as it stands, recomputed only when something moved. */
  get plan(): ProjectPlan {
    if (!this.planCache || this.planRevision !== this.revision) {
      this.planCache = buildProjectPlan(this.clips, this.project, 'video');
      this.planRevision = this.revision;
    }
    return this.planCache;
  }

  /**
   * The plan the preview is playing, which is the finished one unless the
   * reader has asked to hear the pauses.
   *
   * Built separately rather than by editing the project, so that turning the
   * checkbox off cannot leave a setting behind: the stored project, the export
   * and every reading on the page still come from `plan`.
   */
  get previewPlan(): ProjectPlan {
    if (this.previewCutsSilence) return this.plan;

    if (!this.uncutCache || this.uncutRevision !== this.revision) {
      this.uncutCache = buildProjectPlan(this.clips, this.project, 'video', { ignoreSilenceCuts: true });
      this.uncutRevision = this.revision;
    }
    return this.uncutCache;
  }

  /**
   * The project's length, and what it was before the cuts, for the header.
   *
   * Same shape as a clip card's note — "was 12:04" — because it answers the
   * same question about the whole edit, and reading it should not mean learning
   * a second convention.
   */
  get projectDurationNote(): string {
    const source = this.plan.sourceDuration;
    if (!this.clips.length || Math.abs(this.plan.totalDuration - source) <= 0.05) return '';
    return `was ${this.formatTime(source)}`;
  }

  /** Swaps the preview between the finished edit and the material behind it. */
  togglePreviewCutsSilence(): void {
    this.previewCutsSilence = !this.previewCutsSilence;
    if (!this.player) return;

    // The playhead is a position in a timeline that has just changed length.
    // Kept where it is and clamped, rather than reset: the reader ticked the
    // box to hear the passage they were already on.
    const plan = this.previewPlan;
    const time = Math.max(0, Math.min(this.previewTime, plan.totalDuration));
    this.zone.runOutsideAngular(() => {
      this.player?.setPlan(plan);
      this.player?.seek(time);
    });
    this.previewTime = time;
  }

  get projectWidth(): number {
    return this.plan.width;
  }

  get projectHeight(): number {
    return this.plan.height;
  }

  get totalBytes(): number {
    return this.clips.reduce((total, clip) => total + (isMediaClip(clip) ? clip.file.size : 0), 0);
  }

  get canExportVideo(): boolean {
    return (
      this.clips.length > 0 &&
      this.plan.hasPicture &&
      !this.hasAwaitingFiles &&
      !this.exporting &&
      !this.reading &&
      !this.analysisBusy
    );
  }

  get canExportAudio(): boolean {
    return (
      this.clips.length > 0 && !this.hasAwaitingFiles && !this.exporting && !this.reading && !this.analysisBusy
    );
  }

  get stageLabel(): string {
    return this.progress ? STAGE_LABEL[this.progress.stage] : '';
  }

  /**
   * How much of the whole export is done, as a percentage, or an empty string.
   *
   * A bar that fills without a number beside it answers "is it moving?" and not
   * "how long is this going to take?", which is the question anyone watching a
   * ten-minute encode is actually asking.
   */
  get progressPercent(): string {
    const ratio = this.progress?.ratio;
    if (ratio === null || ratio === undefined) return '';
    return `${Math.min(100, Math.max(0, Math.round(ratio * 100)))}%`;
  }

  /** The one thing the reader most needs told before they press a button. */
  get planWarning(): string {
    if (!this.clips.length) return '';
    if (!this.plan.hasPicture) return 'No clip has a picture, so only the audio export is available.';

    const audioOnly = this.plan.audioOnlyCount;
    if (audioOnly > 0) {
      return `${audioOnly} clip(s) carry no picture and will play over a black screen in the video export.`;
    }
    return '';
  }

  /** What the automatic zoom would do to this clip, as it stands. */
  zoomNoteFor(clip: EditorClip | null): string {
    if (!clip || !isMediaClip(clip)) return '';

    const edits = this.editsFor(clip);
    if (!edits.silence.autoZoom.enabled) {
      return 'Hides the jump where a pause was removed by pushing in slightly on what follows it.';
    }
    if (!clip.analysis) return 'Listen to the clip to see how many zooms it would get.';
    if (!clip.summary.videoUsable) return 'This clip has no picture, so nothing would be zoomed.';

    return describeZoomPlan(
      planAutoZooms(removedRanges(clip, edits), keepRangesFor(clip, edits), edits.silence.autoZoom, clip.id)
    );
  }

  get loudnessNote(): string {
    const analyzed = this.clips.filter((clip): clip is MediaClip => isMediaClip(clip) && Boolean(clip.analysis));
    if (!this.project.loudness.enabled || !analyzed.length) {
      return describeLoudness(null, this.project.loudness);
    }

    const first = analyzed[0].analysis;
    if (!first) return describeLoudness(null, this.project.loudness);

    return describeLoudness(
      planGainEnvelope(first.waveform.rms, first.waveform.secondsPerBucket, first.waveform.duration, this.project.loudness),
      this.project.loudness
    );
  }

  /** `1920 × 1080 · 30 fps`, with whatever parts are actually known. */
  describeClip(clip: EditorClip): string {
    if (!isMediaClip(clip)) {
      return `Text card · ${this.speedLabel(this.editsFor(clip).speed)}`;
    }

    const parts: string[] = [];
    const { summary } = clip;

    if (summary.width && summary.height) parts.push(`${summary.width} × ${summary.height}`);
    if (summary.frameRate) parts.push(`${summary.frameRate} fps`);
    if (summary.videoCodec) parts.push(summary.videoCodec.toUpperCase());
    if (summary.audioCodec) parts.push(summary.audioCodec.toUpperCase());
    if (summary.channelCount) parts.push(summary.channelCount === 1 ? 'mono' : `${summary.channelCount} ch`);

    return parts.join(' · ');
  }

  /** The badges on a row: what has been done to this clip. */
  badges(clip: EditorClip): string[] {
    const edits = this.editsFor(clip);
    const labels: string[] = [];

    if (!this.follows(clip)) labels.push('own settings');
    if (edits.speed !== 1) labels.push(this.speedLabel(edits.speed));
    if (isMediaClip(clip) && edits.cutSilence) {
      const cuts = clip.detected.filter((range) => range.enabled).length;
      labels.push(cuts ? `${cuts} cut${cuts === 1 ? '' : 's'}` : 'silence cut');
    }
    if (isMediaClip(clip) && clip.manualCuts.length) labels.push(`${clip.manualCuts.length} manual`);
    if (edits.silence.autoZoom.enabled) labels.push('auto zoom');
    if (edits.fadeIn && edits.fadeOut) labels.push('fades');
    else if (edits.fadeIn) labels.push('fade in');
    else if (edits.fadeOut) labels.push('fade out');
    if (edits.audioMode === 'mute') labels.push('muted');

    const sound = this.soundFor(clip);
    if (sound.kind === 'file') {
      // Three ways a clip ends up playing a file, and they are worth telling
      // apart on the row: one was asked for, one was inherited from the clip
      // before, and one filled a gap the footage left.
      labels.push(
        edits.audioMode === 'continue'
          ? 'sound continues'
          : edits.audioMode === 'replace'
            ? 'new sound'
            : 'project sound'
      );
    }
    if (isMediaClip(clip) && (clip.captions?.some((caption) => caption.text.trim()) || clip.caption?.text.trim())) labels.push('caption');
    if (isPlayable(clip) && clip.tag?.text.trim()) labels.push('tag');

    return labels;
  }

  /**
   * Where this clip's sound comes from, once the whole timeline is taken into
   * account — which is the only place "continue the previous clip" can be
   * answered.
   */
  soundFor(clip: EditorClip): ClipSoundPlan {
    return this.plan.clips.find((entry) => entry.clip === clip)?.sound ?? { kind: 'original' };
  }

  /** True when this clip is playing a file rather than its own soundtrack. */
  hasExternalSound(clip: EditorClip): boolean {
    return this.soundFor(clip).kind === 'file';
  }

  /**
   * True when the supplied track runs out before this clip does.
   *
   * A soundtrack laid across a sequence is finite, and the clip it fails to
   * reach plays part of itself in silence. Nothing on the timeline shows that —
   * the row looks exactly like the ones around it — so it is said in red.
   */
  soundShortFor(clip: EditorClip): boolean {
    return this.plan.clips.find((entry) => entry.clip.id === clip.id)?.soundShort ?? false;
  }

  /** True for footage that arrived with no sound the browser can decode. */
  isSilentSource(clip: EditorClip): boolean {
    return isMediaClip(clip) && clip.summary.kind !== 'image' && !clip.summary.audioUsable;
  }

  /**
   * True when this clip reaches the finished file with no sound at all.
   *
   * `isSilentSource` only says the file arrived without a soundtrack, which on
   * its own is not a problem: a track running through from an earlier card
   * covers it, and so does a file chosen for the clip or for the project. The
   * alarming case is the one left over — nothing of its own, nothing handed to
   * it, nothing carried in — because that is a hole in the middle of the edit
   * that looks like every other row until the export is watched.
   *
   * A clip silenced on purpose is deliberately not counted. The planner marks
   * that one `mute`, and a warning that fires on a decision the reader made is
   * a warning they learn to scroll past.
   */
  willBeSilent(clip: EditorClip): boolean {
    return this.isSilentSource(clip) && this.soundFor(clip).kind === 'original';
  }

  /** Clips whose supplied sound stops short, for the warning above the buttons. */
  get shortSoundNames(): string[] {
    return this.plan.clips
      .filter((entry) => entry.soundShort)
      .map((entry) => (isMediaClip(entry.clip) ? entry.clip.summary.fileName : 'Text card'));
  }

  /** How long this clip lasts in the finished file. */
  outputDuration(clip: EditorClip): number {
    // By id rather than by object identity: identity is true today, but a
    // lookup that silently falls back to the source length would report the
    // file's duration as though it were the edit's, which is precisely the
    // number this row exists to correct.
    return this.plan.clips.find((entry) => entry.clip.id === clip.id)?.outputDuration ?? sourceDuration(clip);
  }

  /**
   * Why the length on the row is not the length of the file.
   *
   * Two things move it and they move it in opposite directions: cuts shorten a
   * clip, and a rate below 1 lengthens it. The old line only mentioned the
   * source when the clip had got *shorter*, so slowing one down changed the
   * number with nothing to say what had happened to it — and a bare time is
   * indistinguishable from the file's own.
   */
  /**
   * How long this clip actually runs, and what the speed did to it.
   *
   * Placed under the speed control because that is where the decision is being
   * made and "2×" on its own answers nothing the reader asked: what they want
   * to know is whether the clip now fits, and the only form of that answer is a
   * time. Everything is already accounted for — the pauses that were cut, the
   * in and out points, the speed — because the number comes from the plan
   * rather than from the file.
   */
  speedNoteFor(clip: EditorClip): string {
    if (isTransitionClip(clip)) return '';

    const speed = this.editsFor(clip).speed;
    const output = this.outputDuration(clip);
    if (speed === 1) return `${this.formatTime(output)} in the finished video.`;

    return (
      `${this.formatTime(output)} in the finished video at ${this.speedLabel(speed)} — ` +
      `${this.formatTime(output * speed)} at normal speed.`
    );
  }

  durationNote(clip: EditorClip): string {
    const parts: string[] = [];
    const speed = this.editsFor(clip).speed;
    if (speed !== 1) parts.push(this.speedLabel(speed));

    const source = sourceDuration(clip);
    if (Math.abs(this.outputDuration(clip) - source) > 0.05) parts.push(`was ${this.formatTime(source)}`);

    return parts.join(' · ');
  }

  trackById(_index: number, clip: EditorClip): string {
    return clip.id;
  }

  formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    const padded = `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    return hours ? `${hours}:${padded}` : padded;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
  }

  // -------------------------------------------- trimming and splitting --

  /** Where this clip starts and stops reading its file, in source seconds. */
  boundsOf(clip: EditorClip): { start: number; end: number } {
    return clipBounds(clip);
  }

  /** True when the reader has moved either end off the ends of the file. */
  isTrimmed(clip: EditorClip): boolean {
    return isTrimmed(clip);
  }

  /**
   * How much of the file this clip actually uses, in words.
   *
   * Two halves of a split clip both say "of 12:30", which is the point: they
   * are two windows onto one recording, and a reader looking at the second one
   * should be able to see where in the take they are.
   */
  trimNote(clip: EditorClip): string {
    if (!isMediaClip(clip) || !isTrimmed(clip)) return '';

    const bounds = clipBounds(clip);
    return `${this.formatTime(bounds.start)} → ${this.formatTime(bounds.end)} of ${this.formatTime(
      sourceDuration(clip)
    )}`;
  }

  /**
   * Starts the clip where the playhead is.
   *
   * Nothing is thrown away. The footage before the point is still in the file
   * and the point can be moved back at any time — which is the whole difference
   * between trimming and cutting, and the reason a trim does not need to ask
   * before it happens.
   */
  setInPoint(clip: MediaClip, time: number): void {
    const duration = sourceDuration(clip);
    const outPoint = clip.outPoint ?? duration;
    const at = Math.max(0, Math.min(time, outPoint - MIN_CLIP_SECONDS));
    if (!Number.isFinite(at) || at >= outPoint) return;

    clip.inPoint = at > 1e-4 ? at : undefined;
    // The clip is a different length now, and the target has not moved.
    this.applyTimelapseTarget();
    this.touch();
  }

  /** Stops the clip where the playhead is. */
  setOutPoint(clip: MediaClip, time: number): void {
    const duration = sourceDuration(clip);
    const inPoint = clip.inPoint ?? 0;
    const at = Math.min(duration, Math.max(time, inPoint + MIN_CLIP_SECONDS));
    if (!Number.isFinite(at) || at <= inPoint) return;

    clip.outPoint = at < duration - 1e-4 ? at : undefined;
    this.applyTimelapseTarget();
    this.touch();
  }

  /** Gives the clip the whole file back. */
  clearTrim(clip: MediaClip): void {
    if (clip.inPoint === undefined && clip.outPoint === undefined) return;
    clip.inPoint = undefined;
    clip.outPoint = undefined;
    this.applyTimelapseTarget();
    this.touch();
  }

  /** True when this clip can be cut in two at the position given. */
  canSplitAt(clip: EditorClip, time: number): boolean {
    if (!isMediaClip(clip) || clip.summary.kind === 'image') return false;

    const bounds = clipBounds(clip);
    return time > bounds.start + MIN_CLIP_SECONDS && time < bounds.end - MIN_CLIP_SECONDS;
  }

  /**
   * Cuts one clip into two at a position in its source.
   *
   * The two halves are two rows on the timeline reading one file: the same
   * `File`, the same measured summary, the same waveform, and an in and out
   * point that between them cover exactly what the original covered. Nothing is
   * decoded, nothing is copied, and the analysis is not thrown away — which is
   * what makes splitting a nine-minute recording into chapters instant rather
   * than a decision to think twice about.
   *
   * Everything that was the reader's own is copied rather than shared, so that
   * switching a pause back on in the first half does not switch it on in the
   * second. The one thing deliberately left pointing at the same object is the
   * analysis, because it describes the file and neither half owns it.
   */
  splitClip(clip: MediaClip, sourceTime: number): void {
    if (!this.canSplitAt(clip, sourceTime)) {
      this.message = 'The playhead is too close to one end of this clip to split it there.';
      return;
    }

    const index = this.clips.indexOf(clip);
    if (index < 0) return;

    const bounds = clipBounds(clip);
    const second: MediaClip = {
      ...clip,
      videoEffect: normalizeVideoEffect(clip.videoEffect),
      images: (clip.images ?? []).map(image => ({ ...image, id: `image-${this.nextId++}` })),
      videoEffects: (clip.videoEffects ?? []).map(effect => ({ ...effect, id: `effect-${this.nextId++}` })),
      id: `clip-${this.nextId++}`,
      summary: { ...clip.summary },
      inPoint: sourceTime,
      outPoint: bounds.end < sourceDuration(clip) - 1e-4 ? bounds.end : undefined,
      overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
      detected: clip.detected.map((range) => ({ ...range })),
      manualCuts: clip.manualCuts.map((range) => ({ ...range })),
      manualZooms: (clip.manualZooms ?? []).map((zoom) => ({ ...zoom, id: `zoom-${this.nextId++}` })),
      caption: clip.caption ? { ...clip.caption } : null,
      captions: (clip.captions ?? []).map((caption) => ({ ...caption, id: `caption-${this.nextId++}` })),
      // Both halves keep the badge. A tag placed at three seconds of a take that
      // is now two clips lands wherever three seconds is in each of them, which
      // is the same answer the reader would get by splitting and looking.
      tag: clip.tag ? { ...clip.tag } : null,
      replacementAudio: clip.replacementAudio ? { ...clip.replacementAudio } : null,
      previewUrl: null
    };

    clip.outPoint = sourceTime;
    this.clips.splice(index + 1, 0, second);
    // Two clips now, each of them a timelapse, and the target is per clip — so
    // both halves are re-timed to it rather than keeping the speed that made
    // the whole take fit.
    this.applyTimelapseTarget();
    this.touch();
    this.message = `Split into two clips at ${this.formatTime(sourceTime)}. Both read the same file.`;
  }

  /** Splits the clip whose dialog is open, at the waveform's playhead. */
  splitEditingClip(): void {
    const clip = this.editing;
    if (!clip) return;
    this.splitClip(clip, this.playhead);
  }

  /** True when the preview's playhead is somewhere a clip can be cut. */
  get canSplitAtPlayhead(): boolean {
    const entry = clipAt(this.previewPlan, this.previewTime);
    if (!entry) return false;

    const { sourceTime } = sourceTimeAt(entry, this.previewTime);
    return this.canSplitAt(entry.clip, sourceTime);
  }

  /**
   * Splits whatever is on screen in the preview, where it is on screen.
   *
   * The preview's clock is the finished video's, and a clip's in and out points
   * are positions in a file — so the instant is translated through the same
   * function the player uses to keep the decoder in step, which is what makes
   * the cut land on the frame the reader is actually looking at rather than on
   * the frame they would be looking at if nothing had been cut.
   */
  splitAtPlayhead(): void {
    const entry = clipAt(this.previewPlan, this.previewTime);
    if (!entry || !isMediaClip(entry.clip)) {
      this.message = 'Move the playhead onto a video or audio clip to split it.';
      return;
    }

    const { sourceTime } = sourceTimeAt(entry, this.previewTime);
    this.splitClip(entry.clip, sourceTime);
  }

  // ------------------------------------------------------- manual zooms --

  manualZoomsOf(clip: EditorClip): ManualZoom[] {
    return isMediaClip(clip) ? clip.manualZooms ?? [] : [];
  }

  /**
   * Puts a push-in at the playhead, three seconds long.
   *
   * A length rather than a question, because the first thing anybody does with
   * a zoom is watch it and change it — and a dialog asking for a number before
   * showing anything would put a form between the reader and the only thing
   * that can answer their question.
   */
  addManualZoom(clip: MediaClip, at: number): void {
    const duration = sourceDuration(clip);
    const bounds = clipBounds(clip);
    const start = Math.max(bounds.start, Math.min(at, Math.max(bounds.start, bounds.end - MIN_CLIP_SECONDS)));

    const zoom = clampManualZoom(
      {
        id: `zoom-${this.nextId++}`,
        start,
        end: Math.min(bounds.end, start + MANUAL_ZOOM_LIMITS.seconds.default),
        scalePercent: MANUAL_ZOOM_LIMITS.scalePercent.default,
        rampSeconds: MANUAL_ZOOM_LIMITS.rampSeconds.default,
        easeOut: true
      },
      duration
    );

    clip.manualZooms = [...(clip.manualZooms ?? []), zoom].sort((a, b) => a.start - b.start);
    this.touch();
  }

  updateManualZoom(clip: MediaClip, zoom: ManualZoom, change: Partial<ManualZoom>): void {
    const duration = sourceDuration(clip);
    clip.manualZooms = (clip.manualZooms ?? [])
      .map((candidate) => (candidate.id === zoom.id ? clampManualZoom({ ...candidate, ...change }, duration) : candidate))
      .sort((a, b) => a.start - b.start);
    this.touch();
  }

  onManualZoomNumber(clip: MediaClip, zoom: ManualZoom, key: 'start' | 'end' | 'scalePercent' | 'rampSeconds', value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.updateManualZoom(clip, zoom, { [key]: parsed } as Partial<ManualZoom>);
  }

  removeManualZoom(clip: MediaClip, zoom: ManualZoom): void {
    clip.manualZooms = (clip.manualZooms ?? []).filter((candidate) => candidate.id !== zoom.id);
    this.touch();
  }

  /** Puts the playhead at the start of a zoom, so it can be watched. */
  seekToZoom(zoom: ManualZoom): void {
    this.playhead = zoom.start;
  }

  // ---------------------------------------------------------- the timelapse --

  /** Clips on the timeline the probe recognised as timelapses. */
  get timelapseClips(): MediaClip[] {
    return this.clips.filter((clip): clip is MediaClip => isMediaClip(clip) && clip.summary.isTimelapse);
  }

  get timelapseClipCount(): number {
    return this.timelapseClips.length;
  }

  /** True when this clip's speed is currently being decided by the target. */
  isTimelapseTimed(clip: EditorClip): boolean {
    return isMediaClip(clip) && clip.speedFromTimelapse === true && this.project.timelapseTargetSeconds > 0;
  }

  onTimelapseTarget(value: string | number): void {
    const target = clampTimelapseTarget(Number(value));
    if (target === this.project.timelapseTargetSeconds) return;

    this.project = { ...this.project, timelapseTargetSeconds: target };
    this.applyTimelapseTarget();
    // `applyTimelapseTarget` only touches when it changed a clip, and the
    // setting itself changed either way — a project with no timelapse on it
    // still has to remember the number that was typed.
    this.touch();
  }

  /**
   * Gives every timelapse the speed that makes it last the target.
   *
   * The speed is written onto the clip rather than worked out at plan time,
   * which is the whole difference between this and the preview's "play the
   * pauses" flag. A clip playing at eighty times while its panel reads "1×"
   * would be an interface lying about what it is doing, and the reader has to
   * be able to see the number, disagree with it, and change it.
   *
   * Disagreeing is what `speedFromTimelapse` is for. It marks a speed this
   * function put there; the moment the reader picks one themselves the mark is
   * gone and this never touches that clip again. A clip that already had
   * settings of its own before any of this existed is likewise left alone.
   */
  private applyTimelapseTarget(): void {
    const target = this.project.timelapseTargetSeconds;
    let changed = false;

    for (const clip of this.clips) {
      if (!isMediaClip(clip) || !clip.summary.isTimelapse) continue;

      // Its own speed, chosen by hand. Not ours to move.
      if (clip.overrides !== null && clip.speedFromTimelapse !== true) continue;

      if (target <= 0) {
        // Switching the target off undoes what the target did, and nothing
        // else: the clip keeps every other setting it was given along the way.
        if (clip.speedFromTimelapse !== true) continue;

        if (clip.overrides) clip.overrides = { ...cloneEdits(clip.overrides), speed: 1 };
        clip.speedFromTimelapse = false;
        changed = true;
        continue;
      }

      // The clip's own extent, so a trimmed timelapse still lands on the
      // target rather than on what the whole file would have needed.
      const speed = timelapseSpeedFor(trimmedDuration(clip), target);
      const current = this.editsFor(clip).speed;
      if (clip.overrides !== null && Math.abs(current - speed) < 1e-6) continue;

      clip.overrides = { ...cloneEdits(clip.overrides ?? this.project.edits), speed };
      clip.speedFromTimelapse = true;
      changed = true;
    }

    if (changed) this.touch();
  }

  /**
   * What the speed control says instead of a menu, while the target owns it.
   *
   * The menu offers half-steps up to ten and the target routinely asks for
   * forty; there is no option to select. So the number is shown as a reading —
   * and when the target asked for more than the tool can do, the reading says
   * so rather than quietly presenting a clip that did not reach it.
   */
  timelapseSpeedNote(clip: EditorClip): string {
    if (!isMediaClip(clip)) return '';

    const target = this.project.timelapseTargetSeconds;
    const applied = this.editsFor(clip).speed;
    const wanted = target > 0 ? trimmedDuration(clip) / target : applied;

    if (wanted > applied + 0.05) {
      return `${this.speedLabel(applied)} · the target asks for ${this.speedLabel(clampSpeed(wanted))}, which is past the limit`;
    }

    return `${this.speedLabel(applied)} · set to reach the ${target}s timelapse target`;
  }

  /**
   * The reader taking the speed back. The target stops deciding for this clip.
   *
   * The speed is snapped onto the menu on the way out. The target routinely
   * lands on numbers the menu does not offer — thirty-seven and a half — and
   * handing back a `<select>` with nothing selected is handing back a broken
   * control. The nearest offered speed is a small lie about the length and an
   * honest one about what the reader can now do, and the note underneath says
   * what the length actually became.
   */
  releaseTimelapseSpeed(clip: EditorClip): void {
    if (!isMediaClip(clip) || clip.speedFromTimelapse !== true) return;

    const current = this.editsFor(clip).speed;
    const nearest = SPEEDS.reduce((best, option) =>
      Math.abs(option - current) < Math.abs(best - current) ? option : best
    );

    clip.overrides = { ...cloneEdits(clip.overrides ?? this.project.edits), speed: nearest };
    clip.speedFromTimelapse = false;
    this.touch();
  }

  // ------------------------------------------------------- the frame shape --

  onAspect(value: string): void {
    const aspect = value as FrameAspect;
    if (aspect === this.project.aspect) return;

    this.project = { ...this.project, aspect };
    this.touch();
  }

  onReframe(value: string): void {
    const reframe = value as ReframeFit;
    if (reframe === this.project.reframe) return;

    this.project = { ...this.project, reframe };
    this.touch();
  }

  /** What the frame will be, and what it is being made from, in one line. */
  get aspectNote(): string {
    const plan = this.plan;
    if (this.project.aspect === 'source') return `${plan.width} × ${plan.height}, the shape of the footage.`;

    const shape = this.project.aspect === '1:1' ? 'square' : 'vertical';
    return this.project.reframe === 'fill'
      ? `${plan.width} × ${plan.height} — ${shape}. Wider pictures are enlarged until they cover the frame, so their sides are cropped.`
      : `${plan.width} × ${plan.height} — ${shape}. The whole picture is kept, with black above and below it or at its sides.`;
  }

  // ------------------------------------------------------------- presets --

  openPresets(): void {
    this.suspendPreview();
    this.presets = readPresets();
    this.presetName = '';
    this.presetChooser = true;
  }

  closePresets(): void {
    this.presetChooser = false;
    this.savingPreset = false;
    this.resumePreview();
  }

  /** Writes the whole project — every setting, no clips — under a name. */
  saveCurrentAsPreset(): void {
    const name = this.presetName.trim();
    if (!name) {
      this.savingPreset = true;
      return;
    }

    const presets = [presetFrom(name, this.project), ...readPresets().filter((preset) => preset.name !== name)];
    if (writePresets(presets)) {
      this.presets = presets;
      this.presetName = '';
      this.savingPreset = false;
      this.message = `Saved "${name}" as a preset.`;
    } else {
      this.errorMessage = 'This browser would not keep the preset.';
      this.errorHint = 'Its storage is full or unavailable. Use Save project to write the settings to a file instead.';
    }
  }

  /**
   * Applies a saved preset to the project.
   *
   * Only the project's own settings change. Every clip that was following the
   * project follows the new values immediately; a clip with settings of its own
   * keeps them, because "this one take is different" is a decision about that
   * take and not about the way the reader works.
   */
  async applyPreset(preset: ProjectPreset): Promise<void> {
    this.project = settingsFrom(preset);
    this.invalidateAnalyses();
    // The preset carries a timelapse target of its own, which is a different
    // number from the one the project had a moment ago.
    this.applyTimelapseTarget();
    this.presetChooser = false;

    // A preset names its soundtrack exactly as a settings file does, so it gets
    // the same offer: if this browser kept a reference to that music, ask for
    // it now rather than sending the reader back to the file dialog.
    // `claimSettingsSound` already answers with the name it could not get and
    // with nothing when it got the file, so it is the whole answer. Falling back
    // to `presetNeedsSound` here would name the soundtrack even after it had
    // just been reopened, and say it was waiting when it was playing.
    const missing = await this.claimSettingsSound();
    this.canReconnect = handlesSupported() && this.hasAwaitingFiles;
    this.touch();

    this.message = missing
      ? `Applied "${preset.name}". Its soundtrack "${missing}" is waiting for its file — add it again to hear it.`
      : `Applied "${preset.name}".`;
    this.resumePreview();
    this.cdr.markForCheck();
  }

  deletePreset(preset: ProjectPreset): void {
    const presets = readPresets().filter((candidate) => candidate.id !== preset.id);
    writePresets(presets);
    this.presets = presets;
  }

  presetSummary(preset: ProjectPreset): string {
    const settings = preset.settings;
    const parts = [
      settings.edits.cutSilence ? 'cuts the pauses' : 'keeps the pauses',
      settings.loudness.enabled ? 'levelled' : 'not levelled',
      settings.aspect === 'source' ? settings.resolution : settings.aspect,
      settings.defaultTransition ? 'joined' : 'straight cuts'
    ];
    return parts.join(' · ');
  }

  // -------------------------------------------------------- full screen --

  /**
   * Puts the preview on the whole screen, and takes it off again.
   *
   * The canvas composes at a fraction of the export's size, which is exactly
   * right in a pane and visibly soft blown up to a laptop screen — so going
   * fullscreen asks the player for a larger canvas and going back asks for the
   * small one again, rather than stretching the same pixels either way.
   */
  async togglePreviewFullscreen(): Promise<void> {
    if (typeof document === 'undefined') return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      const stage = this.previaSecao?.nativeElement;
      if (!stage?.requestFullscreen) {
        this.message = 'This browser will not put the preview on the whole screen.';
        return;
      }

      await stage.requestFullscreen();
    } catch {
      // A refused request is the browser's decision to explain, not ours; the
      // preview carries on exactly as it was.
      this.message = 'The browser would not switch to full screen.';
    }
  }

  // ------------------------------------- reconnecting a restored project --

  /**
   * Opens the files a restored project is waiting for, without asking.
   *
   * Only ever *queries* the permission. A browser that still holds the grant
   * from last time hands the files back and the project simply works; one that
   * would have to ask says nothing, and the button below is what asks. A
   * permission prompt that appears because a page loaded is a prompt people
   * dismiss without reading, and dismissing it is the answer we would then be
   * stuck with.
   */
  private async reconnectQuietly(): Promise<void> {
    // `hasAwaitingFiles`, not `awaitingCount`: a soundtrack is a file waiting
    // for its bytes as much as a clip is, and counting only clips is what made
    // "open them again" disappear in exactly the case a settings file produces
    // — no clips missing, one soundtrack missing.
    if (!isPlatformBrowser(this.platformId) || !this.hasAwaitingFiles) return;

    const recovered = await this.filesFromHandles(false);
    if (!recovered.length) {
      this.canReconnect = handlesSupported();
      return;
    }

    let reconnected = 0;
    for (const file of recovered) if (this.attachRestoredFile(file)) reconnected++;

    if (reconnected) {
      this.notice = '';
      this.message = `${reconnected} clip(s) opened again from where you first added them.`;
      this.touch();
      if (!this.hasAwaitingFiles) await this.openTimelinePreview();
    }
    this.canReconnect = handlesSupported() && this.hasAwaitingFiles;
    this.cdr.markForCheck();
  }

  /**
   * The desktop application's answer to a project that came back empty-handed.
   *
   * Reopening a remembered file may need permission, and permission may only be
   * *asked for* while somebody is pressing something. In a browser tab that is
   * the reader pressing the button below, and there is no way around it. In the
   * application there is: it can call this page back with a real activation
   * behind the call, and it answers the permission itself — so the window opens
   * and the project is simply there, with every clip attached to its file and
   * nothing asked of anybody.
   *
   * The function is put on `window` for the length of the attempt and taken off
   * again, because it is a door and a door is left open for as long as it is
   * being walked through and no longer.
   */
  private async reconnectThroughApp(): Promise<void> {
    if (!this.desktop.isDesktop || !this.hasAwaitingFiles || typeof window === 'undefined') return;

    const carrier = window as unknown as { __sveReconnectFiles?: () => Promise<void> };
    carrier.__sveReconnectFiles = () => this.zone.run(() => this.reconnectFiles());

    try {
      await this.desktop.reconnectFiles();
    } finally {
      delete carrier.__sveReconnectFiles;
      this.cdr.markForCheck();
    }
  }

  /**
   * The same thing, with the reader's press behind it so permission may be asked.
   *
   * One button, one prompt, every waiting file — rather than a file dialog the
   * reader has to find nine files in.
   */
  async reconnectFiles(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;

    this.clearMessages();
    const recovered = await this.filesFromHandles(true);

    let reconnected = 0;
    for (const file of recovered) if (this.attachRestoredFile(file)) reconnected++;

    if (!reconnected) {
      this.message =
        'None of them could be opened from here — the file may have moved, or this browser never kept a ' +
        'reference to it. Choose it below and the edit carries on.';
      this.canReconnect = false;
      this.cdr.markForCheck();
      return;
    }

    this.message = `${reconnected} file(s) opened again from where you first added them.`;
    this.touch();
    if (!this.hasAwaitingFiles) {
      this.notice = '';
      await this.openTimelinePreview();
    }
    this.canReconnect = this.hasAwaitingFiles;
    this.cdr.markForCheck();
  }

  /** Every waiting file this browser can still open on its own. */
  private async filesFromHandles(ask: boolean): Promise<File[]> {
    const refs: { name: string; size: number }[] = [];

    for (const clip of this.clips) {
      if (isMediaClip(clip) && clip.awaitingFile && clip.fileRef) refs.push(clip.fileRef);
    }

    // A soundtrack is a file the project is waiting for as much as a clip is,
    // and it goes missing more quietly — the plan still knows how long the
    // music is, so an export writes silence and says nothing. Its key is the
    // name and size it was *measured* at, because the placeholder standing in
    // for it has a size of zero.
    const supplied = (sound: SuppliedSound | null) => {
      if (sound && sound.file.size === 0) {
        refs.push({ name: sound.summary.fileName, size: sound.summary.fileSize });
      }
    };

    supplied(this.project.defaultAudio);
    for (const clip of this.clips) if (!isTransitionClip(clip)) supplied(clip.replacementAudio);

    const found: File[] = [];
    for (const ref of refs) {
      const handle = await recallHandle(ref);
      if (!handle) continue;

      const file = await fileFromHandle(handle, ask);
      if (file) found.push(file);
    }

    return found;
  }

  /** Remembers where a batch of files came from, when the browser said. */
  private async rememberHandles(files: readonly File[], handles: Map<string, StoredHandle>): Promise<void> {
    if (!handles.size) return;

    for (const file of files) {
      const handle = handles.get(`${file.name}:${file.size}`);
      if (handle) await rememberHandle(file, handle);
    }
  }

  // ------------------------------------------- stopping an export cleanly --

  /**
   * Stops the export at the end of the clip it is on, keeping what it wrote.
   *
   * Different from Cancel on purpose. Cancel means "throw this away" and the
   * chosen file is left empty; this means "that is enough for now" — the clip
   * in progress is finished, the container's index is written, and what comes
   * out is a file that plays. What is left of the edit is then offered as a
   * second part, so an hour of encoding is never lost to a change of mind.
   */
  /* ------------------------------------------------------- the render log */

  /** Clears the log and starts its clock. Called once per export. */
  private startLog(): void {
    this.renderLog = [];
    this.logSeq = 0;
    this.logStartedAt = performance.now();
    this.logFollowing = true;
    this.logDirty = true;
    // Every export starts expanded, including one that follows an export the
    // reader had collapsed: the panel is there to be read while it fills.
    this.logOpen = true;
  }

  /**
   * Adds one line, stamped with how long the export has been running.
   *
   * The stamp is worked out here rather than in the renderer because it is a
   * fact about the reader's wait, not about the encode: the renderer is called
   * outside Angular and has no clock of its own.
   */
  private pushLog(entry: RenderLogEntry): void {
    const seconds = (performance.now() - this.logStartedAt) / 1000;
    const minutes = Math.floor(seconds / 60);
    const at = `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
    const clock = this.formatAgentTimestamp(new Date().toISOString());

    this.renderLog.push({ seq: this.logSeq++, at, clock, kind: entry.kind, text: entry.text, percent: entry.percent ?? null });
    if (this.renderLog.length > LOG_LIMIT) this.renderLog.splice(0, this.renderLog.length - LOG_LIMIT);
    this.logDirty = true;
  }

  toggleLog(): void {
    this.logOpen = !this.logOpen;
    // Opening it should show the newest line, whatever the reader was looking
    // at when they closed it.
    if (this.logOpen) {
      this.logFollowing = true;
      this.logDirty = true;
    }
  }

  clearLog(): void {
    this.renderLog = [];
    this.logSeq = 0;
  }

  /**
   * Keeps the console at the bottom while it is being followed.
   *
   * A console that scrolls to the bottom unconditionally is one a reader cannot
   * read: every new line drags them away from the line they were on. So it
   * follows only while they are already at the bottom, exactly like a terminal.
   */
  ngAfterViewChecked(): void {
    // Written onto the element rather than bound: the drag writes it the same
    // way, and a binding would fight the drag on the next change-detection pass.
    if (this.splitPending && this.bancada) {
      this.splitPending = false;
      if (this.splitWidth !== null) this.applySplit(this.bancada.nativeElement, this.splitWidth);
    }

    // The preview comes and goes with `previewOpen`, and a section built afresh
    // carries none of the height the reader chose. Checked rather than flagged,
    // so every new preview gets it back — the read is a property lookup, and it
    // stops as soon as the height is on the element.
    if (this.videoHeight !== null) {
      const previa = this.previaSecao?.nativeElement;
      if (previa && !previa.style.getPropertyValue('--altura-video')) {
        this.applyVideoHeight(previa, this.videoHeight, false);
      }
    }

    // The board comes and goes with the view toggle, and a stage built afresh
    // carries no camera. Fitting needs the frame to have a size, which is true
    // for the first time here and not a moment earlier.
    if (this.boardAjustePendente && this.boardPalco && this.boardFluxo) {
      const rect = this.boardFluxo.nativeElement.getBoundingClientRect();
      if (rect.width && rect.height) {
        this.boardAjustePendente = false;
        this.boardPendente = false;
        this.ajustarBoard();
      }
    } else if (this.boardPendente && this.boardPalco) {
      this.boardPendente = false;
      this.aplicarCameraBoard();
    } else if (this.modoBoard) {
      // Rebuilt without the flags — a dialog closing, say. The camera lives on
      // the element, so a new element starts blank and has to be told again.
      const palco = this.boardPalco?.nativeElement;
      if (palco && !palco.style.transform) this.aplicarCameraBoard();
    }

    // The monitor comes and goes with the maximised board and with the preview,
    // so both are checked rather than flagged: the reads are property lookups,
    // and each stops as soon as it has what it wants.
    if (this.boardMaximizado) {
      // The panel is built fresh every time the board is maximised, and its size
      // and position live on the element rather than in bindings — so a panel
      // without a width on it is a new one, and has to be told.
      const painel = this.boardMonitor?.nativeElement;
      if (painel && !painel.style.width) this.aplicarMonitor();
      else this.ajustarTelaMonitor();
    }

    if (this.boardMonitorAtivo) this.iniciarEspelhoBoard();
    else this.pararEspelhoBoard();

    // Cheap enough to ask every time, and asking here is what saves every place
    // that starts, stops or seeks the preview from having to remember to.
    this.sincronizarGiroBoard();

    // The note a moment ago asked for the caret; this is the first view check in
    // which the box it goes into is on the page.
    if (this.boardRotuloFoco) this.focarRotuloBoard();

    if (this.agentLogDirty) {
      this.agentLogDirty = false;
      const agentConsole = this.agentLogConsole?.nativeElement;
      if (agentConsole && this.agentLogFollowing) agentConsole.scrollTop = agentConsole.scrollHeight;
    }

    if (!this.logDirty) return;
    this.logDirty = false;

    const console = this.logConsole?.nativeElement;
    if (!console || !this.logFollowing) return;
    console.scrollTop = console.scrollHeight;
  }

  onLogScroll(): void {
    const console = this.logConsole?.nativeElement;
    if (!console) return;
    this.logFollowing = console.scrollHeight - console.scrollTop - console.clientHeight <= LOG_STICK;
  }

  toggleAgentLog(): void {
    this.agentLogOpen = !this.agentLogOpen;
    if (this.agentLogOpen) {
      this.agentLogFollowing = true;
      this.agentLogDirty = true;
    }
  }

  /**
   * How the activity window dresses itself for whoever is driving.
   *
   * The identity already travels: the client sets `SVE_CONTROLLER`, Electron
   * normalises it and publishes it with the control state. All that was missing
   * was for the window to look like it — and at a glance, while an agent is
   * editing, the colour is the fastest way to know which one has the wheel.
   *
   * The marks are the project's own drawings, not either company's logo.
   */
  private static readonly CONTROLLERS: Readonly<Record<string, { label: string; icon: string; theme: string }>> = {
    codex: { label: 'Codex', icon: 'assets/icons/codex-mark.svg', theme: 'agente-codex' },
    chatgpt: { label: 'ChatGPT', icon: 'assets/icons/codex-mark.svg', theme: 'agente-codex' },
    'claude-code': { label: 'Claude Code', icon: 'assets/icons/claude-mark.svg', theme: 'agente-claude' }
  };

  /* ----------------------------------------------------- allowed folders */

  /** The folder being asked for right now, or null when nothing is pending. */
  folderRequest: (MissingRoot & { reason?: string }) | null = null;
  private resolveFolderRequest: ((folder: string | null) => void) | null = null;

  /**
   * Put the request on screen and wait for the user.
   *
   * One at a time: media from three folders asks three times rather than
   * stacking three dialogs, and each answer narrows what is still missing.
   */
  private askForFolder(missing: MissingRoot, reason: string): Promise<string | null> {
    this.resolveFolderRequest?.(null);
    this.folderRequest = { ...missing, reason };
    this.pushAgentLog('action', `Waiting for permission to use ${missing.folder}`, 'Allowed folders', 'WARN');
    this.cdr.markForCheck();
    return new Promise<string | null>((resolve) => {
      this.resolveFolderRequest = (folder) => {
        this.resolveFolderRequest = null;
        this.folderRequest = null;
        this.cdr.markForCheck();
        resolve(folder);
      };
    });
  }

  onFolderRequestResolved(folder: string | null): void {
    this.pushAgentLog('action',
      folder ? `Permission granted for ${folder}` : 'Permission was not granted',
      'Allowed folders', folder ? 'INFO' : 'WARN');
    this.resolveFolderRequest?.(folder);
  }

  private get agentController(): { label: string; icon: string; theme: string } {
    return EditorDeVideoComponent.CONTROLLERS[this.desktop.agentControl().controller] ??
      { label: 'AI client', icon: 'assets/icons/codex-mark.svg', theme: 'agente-generico' };
  }

  get agentControllerLabel(): string {
    return this.agentController.label;
  }

  /** The mark shown in the header, the badge and the minimized pill. */
  get agentControllerIcon(): string {
    return this.agentController.icon;
  }

  /** The class that colours the whole window for this controller. */
  get agentControllerTheme(): string {
    return this.agentController.theme;
  }

  openAgentLog(): void {
    this.agentLogOpen = true;
    this.agentLogMinimizedByUser = false;
    this.agentLogFollowing = true;
    this.agentLogDirty = true;
  }

  closeAgentLog(): void {
    this.agentLogOpen = false;
    this.agentLogMinimizedByUser = true;
  }

  /** Puts the whole panel away, badge included, until an AI connects again. */
  dismissAgentPanel(): void {
    this.agentLogOpen = false;
    this.agentLogMinimizedByUser = true;
    this.agentPanelDismissed = true;
    this.cdr.markForCheck();
  }

  clearAgentLog(): void {
    if (this.agentWorking) return;
    this.agentLog = [];
    this.agentLogSeq = 0;
  }

  onAgentLogScroll(): void {
    const console = this.agentLogConsole?.nativeElement;
    if (!console) return;
    this.agentLogFollowing = console.scrollHeight - console.scrollTop - console.clientHeight <= LOG_STICK;
  }

  agentLogMark(kind: AgentLogKind): string {
    switch (kind) {
      case 'command': return '$';
      case 'action': return '>';
      case 'done': return '*';
      case 'fail': return 'x';
    }
  }

  private onAgentSystemEvent(entry: AgentSystemEvent): void {
    const kind: AgentLogKind = entry.level === 'ERROR' ? 'fail' : entry.level === 'WARN' ? 'action' : 'done';
    this.pushAgentLog(kind, entry.message, entry.module || 'MCP bridge', entry.level, entry.timestamp);
    if (!this.agentLogMinimizedByUser && !this.agentPanelDismissed) this.agentLogOpen = true;
  }

  async copyAgentDiagnostic(): Promise<void> {
    if (!this.agentDiagnostic) return;
    try {
      await navigator.clipboard.writeText(this.agentDiagnostic.fullText);
      this.agentDiagnosticMessage = 'Diagnóstico copiado.';
    } catch {
      this.agentDiagnosticMessage = 'Não foi possível copiar automaticamente; use Salvar diagnóstico.';
    }
  }

  /**
   * Everything an export failure was: what was being written, from what, with
   * which settings, and the whole render log up to the line that failed.
   *
   * Deliberately the same shape as the MCP diagnostic, so one habit covers
   * both and either can be pasted into the same conversation.
   */
  private async captureRenderDiagnostic(error: unknown | null): Promise<RenderDiagnostic> {
    const incidentId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const runtime: AgentRuntimeInfo = await this.desktop.getAgentRuntimeInfo().catch(() => ({}));
    const typed = error as Error & { code?: string; stage?: string; clipLabel?: string };

    const diagnostic = {
      incidentId,
      timestamp: createdAt,
      editor: runtime,
      operation: 'export',
      failedOn: this.errorClip || null,
      message: this.errorMessage || null,
      hint: this.errorHint || null,
      output: {
        videoFormat: this.project.videoFormatId,
        audioFormat: this.project.audioFormatId,
        resolution: this.project.resolution,
        aspect: this.project.aspect,
        reframe: this.project.reframe,
        timelapseTargetSeconds: this.project.timelapseTargetSeconds
      },
      project: {
        revision: this.revision,
        clipCount: this.clips.length,
        duration: this.plan.totalDuration,
        removedDuration: this.plan.removedDuration,
        cutCount: this.plan.cutCount,
        hasSoundtrack: Boolean(this.project.defaultAudio),
        awaitingClips: this.awaitingCount,
        // Named, because a silent placeholder is the one input that looks
        // present in the plan and is not present in the file.
        silentSounds: this.awaitingSounds
      },
      // Enough of each clip to reproduce the timeline, and nothing of its
      // contents: names and settings, never a frame and never a transcript.
      clips: this.clips.map((clip, index) => ({
        index,
        id: clip.id,
        kind: clip.kind,
        ...(isMediaClip(clip)
          ? {
              name: clip.fileRef?.name ?? clip.file.name,
              bytes: clip.file.size,
              awaitingFile: Boolean(clip.awaitingFile),
              durationSeconds: clip.summary.durationSeconds,
              speed: clip.overrides?.speed ?? this.project.edits.speed,
              videoEffect: clip.videoEffect?.id ?? null,
              videoEffectSections: clip.videoEffects?.length ?? 0,
              captions: clip.captions?.length ?? (clip.caption ? 1 : 0),
              images: clip.images?.length ?? 0,
              tag: clip.tag ? { shape: clip.tag.shape, startSeconds: clip.tag.startSeconds } : null,
              manualZooms: clip.manualZooms?.length ?? 0,
              manualCuts: clip.manualCuts.length,
              detectedCuts: clip.detected.length,
              replacementAudio: clip.replacementAudio
                ? { name: clip.replacementAudio.summary.fileName, bytes: clip.replacementAudio.file.size }
                : null
            }
          : {}),
        ...(isTransitionClip(clip) ? { transition: clip.settings?.kind ?? null } : {})
      })),
      connection: this.desktop.agentControl(),
      error: error ? this.serializeAgentError(error) : null,
      // A stall throws nothing, so the trace has to describe where it is
      // rather than what went wrong.
      inProgress: this.exporting !== null,
      progress: this.progress
        ? { stage: this.progress.stage, ratio: this.progress.ratio, clipIndex: this.progress.clipIndex,
            clipCount: this.progress.clipCount, clipName: this.progress.clipName }
        : null,
      stage: typed?.stage ?? null,
      nextSteps: error ? [
        'Read the failing line at the end of renderLog below.',
        'Check silentSounds and awaitingClips: a placeholder input is present in the plan and absent from the file.',
        'Reproduce with the same output settings before changing anything.'
      ] : [
        'This export had not failed when the trace was taken — read `progress` for where it had reached.',
        'Look for a "No progress for Ns" line at the end of renderLog: that is the watchdog saying it is stuck rather than slow.',
        'Compare the container it is on against the clips array: an in/out point, a caption or a tag on that container is where to look first.'
      ],
      renderLog: this.renderLog.map((line) =>
        `[${line.clock}] [+${line.at}] [${line.kind}] ${line.percent === null ? '' : `${line.percent}% `}${line.text}`)
    };

    return {
      incidentId,
      createdAt,
      summary: error
        ? `${typed?.name || 'Error'}${this.errorClip ? ` on ${this.errorClip}` : ''}: ${this.errorMessage || String(error)}`
        : `Still running — ${this.progress?.stage ?? 'starting'}, container ${this.progress?.clipIndex ?? 0}/${this.progress?.clipCount ?? this.clips.length}`,
      fullText: `Simple Vlog Editor render diagnostic\n${JSON.stringify(diagnostic, null, 2)}`
    };
  }

  /**
   * The trace for an export that has not finished.
   *
   * A stall throws nothing, so the ordinary path — build the trace when it
   * fails — never runs, and the one moment the reader most needs to hand
   * somebody the state of the render is the moment nothing is on offer.
   */
  async captureRunningRenderTrace(): Promise<void> {
    this.renderDiagnostic = await this.captureRenderDiagnostic(null);
    this.renderDiagnosticMessage = '';
    await this.copyRenderDiagnostic();
  }

  async copyRenderDiagnostic(): Promise<void> {
    if (!this.renderDiagnostic) return;
    try {
      await navigator.clipboard.writeText(this.renderDiagnostic.fullText);
      this.renderDiagnosticMessage = 'Render trace copied.';
    } catch {
      this.renderDiagnosticMessage = 'Could not copy automatically — use Save trace.';
    }
    this.cdr.markForCheck();
  }

  saveRenderDiagnostic(): void {
    const diagnostic = this.renderDiagnostic;
    if (!diagnostic) return;
    const blob = new Blob([diagnostic.fullText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `simplevlogeditor-render-${diagnostic.incidentId}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.renderDiagnosticMessage = 'Render trace saved.';
    this.cdr.markForCheck();
  }

  saveAgentDiagnostic(): void {
    const diagnostic = this.agentDiagnostic;
    if (!diagnostic) return;
    const blob = new Blob([diagnostic.fullText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `simplevlogeditor-diagnostic-${diagnostic.incidentId}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.agentDiagnosticMessage = 'Diagnóstico salvo.';
  }

  async retryAgentDiagnostic(): Promise<void> {
    const diagnostic = this.agentDiagnostic;
    if (!diagnostic?.retryable || this.agentWorking) return;
    this.agentDiagnosticMessage = '';
    await this.handleAgentRequest({
      ...diagnostic.request,
      id: crypto.randomUUID(),
      arguments: { ...diagnostic.request.arguments, requestId: crypto.randomUUID() }
    }).catch(() => undefined);
  }

  get agentLogTail(): string {
    return this.agentLog.length ? this.agentLog[this.agentLog.length - 1].text : '';
  }

  /**
   * The character that opens a line.
   *
   * Plain text rather than an icon, because a console reads as a console when
   * every line starts in the same column and nothing in it is a widget.
   */
  logMark(kind: RenderLogKind): string {
    switch (kind) {
      case 'step': return '>';
      case 'clip': return '#';
      case 'done': return '*';
      case 'warn': return '!';
      case 'fail': return 'x';
      // One glyph per kind of timed thing, so the console reads as a list of
      // what happened even where colour is not available.
      case 'effect': return '~';
      case 'caption': return 'T';
      case 'image': return 'P';
      case 'zoom': return '+';
      case 'tag': return '@';
      default: return ' ';
    }
  }

  /** The newest line, for the header while the console is folded away. */
  get logTail(): string {
    return this.renderLog.length ? this.renderLog[this.renderLog.length - 1].text : '';
  }

  stopExport(): void {
    if (!this.exporting) return;
    this.stopper?.abort();
    this.message = 'Finishing the clip that is being written, then stopping.';
  }

  /** Encodes what the stopped export did not reach, into a second file. */
  async exportRest(): Promise<void> {
    const resume = this.resume;
    if (!resume) return;
    await this.export(resume.kind, resume.index, resume.part);
  }

  get resumeNote(): string {
    const resume = this.resume;
    if (!resume) return '';

    const left = resume.total - resume.index;
    return `${resume.index} of ${resume.total} clip(s) are in that file. ${left} still to go.`;
  }

  // ------------------------------------------------------- undo and redo --

  /**
   * A moment in the edit, kept so it can be returned to.
   *
   * Deliberately not a deep copy. The expensive things a clip holds — its
   * `File`, its decoded analysis, its thumbnail — are immutable in practice and
   * are shared with the snapshot rather than duplicated, which is what makes an
   * undo instant instead of a second decode. Everything the reader can actually
   * change is copied, because that is precisely what must not be shared.
   */
  // ---------------------------------------------------------- agent API

  /**
   * The transport-neutral automation entry point used by the Electron MCP
   * host. It intentionally speaks in stable ids and source/output seconds; no
   * command below clicks controls or depends on which panel happens to be open.
   */
  async handleAgentRequest(request: EditorAgentRequest): Promise<EditorAgentResponse> {
    if (!request || typeof request.name !== 'string') {
      throw new EditorAgentError('The editor command must have a name.');
    }

    const args = request.arguments ?? {};
    const operationId = String(request.id || args['requestId'] || crypto.randomUUID());
    const operationController = new AbortController();
    this.agentOperationControllers.set(operationId, operationController);
    this.currentAgentOperationId = operationId;
    this.desktop.reportAgentProgress({ operationId, state: 'processing', stage: 'started', percent: 0 });
    this.agentWorking = true;
    if (!this.agentLogMinimizedByUser && !this.agentPanelDismissed) this.agentLogOpen = true;
    const startedAt = Date.now();
    this.agentProgressReset(request.name);
    // Before the command, not after it fails: a resumed project is intact on
    // disk and the agent should never have to be told to reconnect it by hand.
    if (this.hasAwaitingFiles) await this.agentRelinkFromDisk();
    if (request.name !== 'apply_edit_batch' && request.name !== '__has_media_path') this.pushAgentLog('command', this.agentCommandLabel(request.name, args), request.name, 'INFO');
    else this.pushAgentLog('command', `Applying edit batch: ${this.agentBatchLabel(args)}`, request.name, 'INFO');
    await this.paintAgentProgress();

    try {
      let result: unknown;

      switch (request.name) {
        case 'get_editor_capabilities': result = this.agentCapabilities(); break;
        case 'get_project': result = this.agentProject(); break;
        case 'list_assets': result = this.agentAssets(); break;
        case 'get_timeline': result = this.agentTimeline(); break;
        case 'add_media': result = await this.agentAddMedia(args); break;
        case '__has_media_path': result = this.agentHasMediaPath(args); break;
        case '__import_media_path': result = await this.agentImportMediaPath(args); break;
        case 'open_project': result = await this.agentOpenProject(args); break;
        case 'save_project': result = await this.agentSaveProject(args); break;
        case 'set_project_soundtrack': result = await this.agentSetProjectSoundtrack(args, operationController.signal, operationId); break;
        case 'finish_editing': result = this.agentFinishEditing(args); break;
        case 'preview': result = await this.agentPreview(args); break;
        case 'apply_edit_batch': result = await this.agentApplyBatch(args as unknown as EditorAgentBatch, operationController.signal, operationId); break;
        case 'undo': {
          const possible = this.canUndo;
          this.undo();
          result = { undone: possible };
          break;
        }
        case 'redo': {
          const possible = this.canRedo;
          this.redo();
          result = { redone: possible };
          break;
        }
        case 'analyze_silence': result = await this.agentAnalyzeSilence(args, operationController.signal, operationId); break;
        case 'analyze_noise': result = await this.agentAnalyzeNoise(args, operationController.signal, operationId); break;
        case 'suppress_noise': result = await this.agentSuppressNoise(args, operationController.signal, operationId); break;
        case 'get_waveform_page': result = this.agentWaveformPage(args); break;
        case 'transcribe': result = await this.agentTranscribe(args, operationController.signal); break;
        case 'get_frames': result = await this.agentFrames(args as unknown as EditorAgentFrameRequest, operationController.signal, operationId); break;
        case 'get_contact_sheet': result = await this.agentContactSheet(args, operationController.signal, operationId); break;
        case 'export': result = await this.agentExport(args, operationController.signal, operationId); break;
        default: throw new EditorAgentError(`Unknown editor command "${request.name}".`, 'unknown_command');
      }

      if (request.name !== '__has_media_path') {
        this.pushAgentLog(
          'done', `${this.agentCommandNoun(request.name)} completed in ${this.agentElapsed(startedAt)}`,
          request.name, 'INFO', new Date().toISOString(), 100
        );
      }
      this.desktop.reportAgentProgress({ operationId, state: 'applied', stage: 'completed', percent: 100 });
      return { apiVersion: EDITOR_AGENT_API_VERSION, projectRevision: this.revision, result };
    } catch (error) {
      const friendly = error instanceof Error ? error.message : String(error);
      this.pushAgentLog('fail', `${friendly} (after ${this.agentElapsed(startedAt)})`, request.name, 'ERROR');
      this.agentDiagnostic = await this.captureAgentDiagnostic(error, request);
      this.agentDiagnosticMessage = '';
      this.desktop.reportAgentProgress({
        operationId,
        state: operationController.signal.aborted ? 'cancelled' : 'failed',
        stage: error && typeof error === 'object' && 'stage' in error ? error.stage : 'failed'
      });
      throw error;
    } finally {
      this.agentOperationControllers.delete(operationId);
      if (this.currentAgentOperationId === operationId) this.currentAgentOperationId = '';
      this.agentWorking = false;
      await this.paintAgentProgress();
    }
  }

  /**
   * What a batch is about to do, counted by kind.
   *
   * The label an agent sends is its own summary and can be anything; the counts
   * are what the editor is actually being asked to do, which is the thing a
   * reader watching the console wants to check against what they asked for.
   */
  private agentBatchLabel(args: Record<string, unknown>): string {
    const label = String(args['label'] || 'Agent edit');
    const operations = Array.isArray(args['operations']) ? args['operations'] as { type?: unknown }[] : [];
    if (!operations.length) return label;
    const counts = new Map<string, number>();
    for (const operation of operations) {
      const type = typeof operation?.type === 'string' ? operation.type : 'unknown';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    const summary = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([type, count]) => count > 1 ? `${count}x ${type}` : type)
      .join(', ');
    const rest = counts.size > 4 ? ` and ${counts.size - 4} more kind${counts.size - 4 === 1 ? '' : 's'}` : '';
    const dry = args['dryRun'] === true ? ' (simulation)' : '';
    return `${label}${dry} — ${operations.length} operation${operations.length === 1 ? '' : 's'}: ${summary}${rest}`;
  }

  private agentCommandLabel(name: string, args: Record<string, unknown>): string {
    const mediaName = () => {
      const id = args['clipId'];
      const clip = typeof id === 'string' ? this.clips.find((candidate) => candidate.id === id) : null;
      return clip && isMediaClip(clip) ? clip.summary.fileName : clip && isTextClip(clip) ? clip.draft.text.slice(0, 36) || 'text card' : 'project';
    };
    switch (name) {
      case 'get_editor_capabilities': return 'Reading editor capabilities';
      case 'get_project': return 'Reading project';
      case 'list_assets': return 'Listing project media';
      case 'get_timeline': return 'Reading timeline';
      case 'add_media': return `Importing ${Array.isArray(args['paths']) ? args['paths'].length : 0} media file(s)`;
      case '__import_media_path': return `Importing ${String((args['descriptor'] as { name?: unknown } | undefined)?.name ?? 'local media')}`;
      case '__has_media_path': return 'Checking for duplicate local media';
      case 'open_project': return `Opening project ${String(args['path'] ?? '')}`;
      case 'save_project': return `Saving project to ${String(args['path'] ?? '')}`;
      case 'set_project_soundtrack': return `Setting project soundtrack to ${String(args['path'] ?? '')}`;
      case 'finish_editing': return 'Finishing the AI editing session';
      case 'preview': return `${String(args['action'] ?? 'open')} timeline preview`;
      case 'apply_edit_batch': return `Applying ${Array.isArray(args['operations']) ? args['operations'].length : 0} timeline edit(s)`;
      case 'undo': return 'Undoing the last edit';
      case 'redo': return 'Redoing the last edit';
      case 'analyze_silence': return args['clipId'] ? `Finding pauses in ${mediaName()}` : 'Finding pauses in all videos';
      case 'analyze_noise': return args['clipId'] ? `Analyzing noise in ${mediaName()}` : 'Analyzing noise in all videos';
      case 'suppress_noise': return `Removing noise from ${mediaName()}`;
      // The settings are half of what a reader wants to know here: a transcript
      // that came back poor is usually the model or the language, and the log
      // is where they will look for which ones were used.
      case 'transcribe': {
        const model = String(args['model'] ?? 'default model');
        const language = String(args['language'] ?? 'auto');
        const denoise = args['denoise'] ? `, denoise ${String(args['noiseEngine'] ?? 'gtcrn')}/${String(args['noiseStrength'] ?? 'balanced')}` : '';
        return `Understanding video ${mediaName()} (${model}, language ${language}${denoise})`;
      }
      case 'get_frames': {
        const times = Array.isArray(args['timestamps']) ? args['timestamps'] as number[] : [];
        const where = times.length === 1
          ? `at ${this.formatTime(times[0])}`
          : times.length ? `at ${times.length} times, ${this.formatTime(Math.min(...times))}–${this.formatTime(Math.max(...times))}` : '';
        return `${args['composited'] ? 'Checking the composed frame' : 'Inspecting frames'} from ${mediaName()} ${where}`.trim();
      }
      case 'get_contact_sheet': return `Understanding the pictures in ${mediaName()}`;
      case 'export': return `Exporting project to ${String(args['path'] ?? '')}`;
      default: return `Running MCP command ${name}`;
    }
  }

  private agentCommandNoun(name: string): string {
    const labels: Record<string, string> = {
      get_editor_capabilities: 'Capability discovery',
      get_project: 'Project read', list_assets: 'Media inventory', get_timeline: 'Timeline read',
      add_media: 'Media import', open_project: 'Project open', save_project: 'Project save', set_project_soundtrack: 'Project soundtrack', finish_editing: 'AI edit', preview: 'Preview command',
      __import_media_path: 'Media file import', __has_media_path: 'Duplicate check',
      apply_edit_batch: 'Edit batch', undo: 'Undo', redo: 'Redo',
      analyze_silence: 'Silence analysis', get_waveform_page: 'Waveform page', transcribe: 'Video understanding', get_frames: 'Frame inspection',
      analyze_noise: 'Noise analysis', suppress_noise: 'Noise suppression',
      get_contact_sheet: 'Visual inspection', export: 'Export'
    };
    return labels[name] ?? name;
  }


  /**
   * A progress line for the activity console, without flooding it.
   *
   * Every long operation reports far more often than a reader can follow — the
   * encoder ticks per frame, a transcription per chunk — so a line is written
   * only when the number has actually moved five points, or when a second and a
   * half has passed with it creeping, or when it reaches the end. The console
   * holds five hundred lines; spending them on "41%, 42%, 43%" would push the
   * decisions an agent made off the top of it.
   */
  private readonly agentProgressState = new Map<string, { percent: number; at: number }>();

  private agentProgress(module: string, text: string, percent: number | null, level: AgentLogLevel = 'DEBUG'): void {
    const value = percent === null || !Number.isFinite(percent)
      ? null
      : Math.max(0, Math.min(100, Math.round(percent)));
    const now = Date.now();
    const last = this.agentProgressState.get(module);
    const finished = value !== null && value >= 100;
    const moved = value === null || !last || Math.abs(value - last.percent) >= 5;
    const waited = !last || now - last.at >= 1500;
    if (!finished && !moved && !waited) return;
    this.agentProgressState.set(module, { percent: value ?? last?.percent ?? 0, at: now });
    this.pushAgentLog('action', text, module, level, new Date().toISOString(), value);
  }

  /** Forgets a module's throttle, so the next operation starts reporting at once. */
  private agentProgressReset(module: string): void {
    this.agentProgressState.delete(module);
  }

  /** "1.4s", "2m 05s" — how long something took, said the way a reader reads it. */
  private agentElapsed(since: number): string {
    const seconds = Math.max(0, (Date.now() - since) / 1000);
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`;
  }

  private pushAgentLog(
    kind: AgentLogKind,
    text: string,
    module = 'Editor',
    level: AgentLogLevel = kind === 'fail' ? 'ERROR' : 'INFO',
    timestamp = new Date().toISOString(),
    percent: number | null = null
  ): void {
    this.agentLog.push({
      seq: this.agentLogSeq++,
      timestamp: this.formatAgentTimestamp(timestamp),
      level,
      module,
      kind,
      text,
      percent: percent === null || !Number.isFinite(percent)
        ? null
        : Math.max(0, Math.min(100, Math.round(percent)))
    });
    if (this.agentLog.length > AGENT_LOG_LIMIT) this.agentLog.splice(0, this.agentLog.length - AGENT_LOG_LIMIT);
    this.agentLogDirty = true;
    this.cdr.markForCheck();
  }

  private formatAgentTimestamp(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    const part = (number: number, width = 2) => String(number).padStart(width, '0');
    return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}.${part(date.getMilliseconds(), 3)}`;
  }

  private async captureAgentDiagnostic(error: unknown, request: EditorAgentRequest): Promise<AgentDiagnostic> {
    const incidentId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const runtime: AgentRuntimeInfo = await this.desktop.getAgentRuntimeInfo().catch(() => ({}));
    const typed = error as Error & {
      code?: string; stage?: string; details?: unknown; cause?: unknown;
      exitCode?: number; signal?: string; stdout?: string; stderr?: string;
    };
    const retryable = ['transcribe', 'analyze_silence', 'analyze_noise', 'get_frames', 'get_contact_sheet', 'get_project', 'list_assets', 'get_timeline']
      .includes(request.name) || (request.name === 'apply_edit_batch' && request.arguments?.['dryRun'] === true);
    const recentLogs = this.agentLog.slice(-40).map((line) =>
      `[${line.timestamp}] [${line.level}] [${line.module}] ${line.text}`);
    const diagnostic = {
      incidentId,
      timestamp: createdAt,
      editor: runtime,
      operation: request.name,
      parameters: this.maskAgentParameters(request.arguments ?? {}),
      identifiers: {
        requestId: request.arguments?.['requestId'] ?? request.id ?? null,
        clipId: request.arguments?.['clipId'] ?? null,
        assetId: request.arguments?.['assetId'] ?? null,
        projectRevision: this.revision,
        sessionId: this.desktop.agentControl().sessionId ?? runtime.sessionId ?? null
      },
      connection: this.desktop.agentControl(),
      queue: { state: this.agentWorking ? 'failed' : 'idle', currentOperation: request.name },
      error: this.serializeAgentError(error),
      checkpoint: { path: this.desktop.agentControl().recoveryPath ?? null },
      project: { revision: this.revision, clipCount: this.clips.length, duration: this.plan.totalDuration },
      retryable,
      nextSteps: retryable
        ? ['Review the stage and original cause below.', 'Correct invalid media/model settings if shown.', 'Use Tentar novamente after the cause is addressed.']
        : ['Review whether the project was rolled back.', 'Inspect the recovery checkpoint before repeating a mutating command.', 'Send this complete diagnostic to support.'],
      recentLogs
    };
    const fullText = `Simple Vlog Editor diagnostic\n${JSON.stringify(diagnostic, null, 2)}`;
    return {
      incidentId, createdAt, operation: request.name,
      summary: `${typed?.name || 'Error'}${typed?.stage ? ` at ${typed.stage}` : ''}: ${typed?.message || String(error)}`,
      fullText, retryable, request
    };
  }

  private serializeAgentError(error: unknown, seen = new Set<unknown>()): unknown {
    if (!(error instanceof Error)) return { type: typeof error, message: String(error) };
    if (seen.has(error)) return { name: 'CircularError', message: 'Circular cause omitted.' };
    seen.add(error);
    const extended = error as Error & Record<string, unknown>;
    return {
      type: error.constructor?.name || 'Error', name: error.name, message: error.message,
      code: extended['code'] ?? null, stage: extended['stage'] ?? null,
      stack: error.stack ?? null, details: extended['details'] ?? null,
      exitCode: extended['exitCode'] ?? null, signal: extended['signal'] ?? null,
      stdout: extended['stdout'] ?? null, stderr: extended['stderr'] ?? null,
      cause: extended['cause'] ? this.serializeAgentError(extended['cause'], seen) : null
    };
  }

  private maskAgentParameters(value: unknown, key = ''): unknown {
    if (/token|secret|password|authorization|api[-_]?key/i.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((entry) => this.maskAgentParameters(entry));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entry]) => [entryKey, this.maskAgentParameters(entry, entryKey)]));
    }
    return value;
  }

  /** Gives Angular and the canvas preview one browser frame to show each MCP edit. */
  private async paintAgentProgress(): Promise<void> {
    this.cdr.detectChanges();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 50);
      requestAnimationFrame(finish);
    });
  }

  private agentProject(): unknown {
    return {
      apiVersion: EDITOR_AGENT_API_VERSION,
      revision: this.revision,
      duration: this.plan.totalDuration,
      clipCount: this.clips.length,
      project: serializeProject(this.clips, this.project, this.nextId, { projectRevision: this.revision })
    };
  }

  /**
   * What an agent is told this editor can do.
   *
   * The answer itself lives in `editor-agent-capabilities`: it is seven
   * kilobytes of near-pure data, and it was the largest thing in this file that
   * had no reason to be in it. What stays here is the part only the running
   * editor knows.
   */
  private agentCapabilities(): unknown {
    return editorCapabilities({
      behindSubjectPositions: this.behindSubjectPositions,
      captionPresetGroups: this.captionPresetGroups,
      noiseStrengthIds: this.noiseStrengthIds
    });
  }

  private agentAssetId(clip: MediaClip): string {
    const ref = clip.fileRef ?? { name: clip.file.name, size: clip.file.size, lastModified: clip.file.lastModified };
    let hash = 2166136261;
    const source = `${ref.name}\u0000${ref.size}\u0000${ref.lastModified}`;
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `asset-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  private agentAssets(): unknown[] {
    const assets = new Map<string, { id: string; clips: string[]; file: unknown; available: boolean }>();
    for (const clip of this.clips.filter(isMediaClip)) {
      const id = this.agentAssetId(clip);
      const current = assets.get(id);
      if (current) {
        current.clips.push(clip.id);
        continue;
      }
      assets.set(id, {
        id,
        clips: [clip.id],
        available: !clip.awaitingFile,
        file: {
          name: clip.summary.fileName,
          ...(clip.sourcePath ? { path: clip.sourcePath } : {}),
          size: clip.summary.fileSize,
          lastModified: clip.fileRef?.lastModified ?? clip.file.lastModified,
          ...clip.summary
        }
      });
    }
    return [...assets.values()];
  }

  private agentTimeline(): unknown {
    const planById = new Map(this.plan.clips.map((entry) => [entry.clip.id, entry]));
    return {
      revision: this.revision,
      duration: this.plan.totalDuration,
      clips: this.clips.map((clip, index) => {
        const entry = planById.get(clip.id);
        const base = {
          id: clip.id,
          kind: clip.kind,
          index,
          outputStart: entry?.outputStart ?? null,
          outputDuration: entry?.outputDuration ?? 0
        };
        if (isTransitionClip(clip)) return { ...base, settings: clip.settings };
        if (isTextClip(clip)) return {
          ...base,
          draft: clip.draft,
          tag: clip.tag ?? null,
          edits: this.editsFor(clip),
          replacementAudio: clip.replacementAudio?.summary.fileName ?? null,
          background: clip.backgroundFile?.name ?? clip.backgroundRef?.name ?? null
        };
        return {
          ...base,
          assetId: this.agentAssetId(clip),
          source: clip.summary.fileName,
          sourceDuration: clip.summary.durationSeconds,
          inPoint: clip.inPoint ?? 0,
          outPoint: clip.outPoint ?? clip.summary.durationSeconds,
          keepRanges: entry?.keepRanges ?? [],
          removedRanges: removedRanges(clip, this.editsFor(clip)),
          manualCuts: clip.manualCuts,
          detectedSilences: clip.detected,
          speed: this.editsFor(clip).speed,
          audioMode: this.editsFor(clip).audioMode,
          edits: this.editsFor(clip),
          captions: clip.captions ?? [],
          tag: clip.tag ?? null,
          manualZooms: clip.manualZooms ?? [],
          pushIns: clip.manualZooms ?? [],
          noiseSuppression: this.noiseSettingsFor(clip),
          videoEffect: normalizeVideoEffect(clip.videoEffect),
          videoEffects: (clip.videoEffects ?? []).map(effect => ({ ...effect })),
          images: (clip.images ?? []).map(image => this.agentImagePayload(clip, image)),
          noiseAnalysis: clip.noiseReport ?? null,
          noisePreviewReady: this.noiseReady(clip),
          replacementAudio: clip.replacementAudio?.summary.fileName ?? null
        };
      })
    };
  }

  private async agentAddMedia(args: Record<string, unknown>): Promise<unknown> {
    const paths = args['paths'];
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) {
      throw new EditorAgentError('paths must be an array of file paths.', 'invalid_arguments');
    }
    const at = args['atIndex'] === undefined ? undefined : finiteNumber(args['atIndex'], 'atIndex');
    const files = await this.desktop.readAgentFiles(paths as string[]);
    const clips = await this.add(files, at);
    for (const clip of clips) this.pushAgentLog('action', `Added ${clip.file.name} to the timeline`);
    await this.paintAgentProgress();
    return { added: clips.map((clip) => ({ clipId: clip.id, assetId: this.agentAssetId(clip), name: clip.file.name })) };
  }

  private agentHasMediaPath(args: Record<string, unknown>): { present: boolean; clipId?: string; assetId?: string } {
    const sourcePath = stringValue(args['path'], 'path');
    const key = this.agentPathKey(sourcePath);
    const clip = this.clips.find((candidate): candidate is MediaClip =>
      isMediaClip(candidate) && !!candidate.sourcePath && this.agentPathKey(candidate.sourcePath) === key
    );
    return clip && !clip.awaitingFile ? { present: true, clipId: clip.id, assetId: this.agentAssetId(clip) } : { present: false };
  }

  /** Commits one already-probed descriptor. No video bytes cross this call. */
  private async agentImportMediaPath(args: Record<string, unknown>): Promise<unknown> {
    const descriptor = args['descriptor'] as DesktopFileDescriptor | undefined;
    const summary = args['summary'] as MediaSummary | undefined;
    if (!descriptor || typeof descriptor.url !== 'string' || typeof descriptor.filePath !== 'string' || !summary) {
      throw new EditorAgentError('A path-backed descriptor and probed summary are required.', 'invalid_arguments');
    }
    if (args['expectedRevision'] !== undefined && finiteNumber(args['expectedRevision'], 'expectedRevision') !== this.revision) {
      throw new EditorAgentError('The project changed before this media file could be committed.', 'revision_conflict', {
        expectedRevision: args['expectedRevision'], actualRevision: this.revision
      });
    }
    const duplicate = this.agentHasMediaPath({ path: descriptor.filePath });
    if (duplicate.present && args['skipDuplicates'] !== false) return { status: 'already_present', ...duplicate };

    const file = new PathBackedFile(descriptor);
    const waiting = this.clips.find((candidate): candidate is MediaClip =>
      isMediaClip(candidate) && !!candidate.awaitingFile && !!candidate.sourcePath &&
      this.agentPathKey(candidate.sourcePath) === this.agentPathKey(descriptor.filePath!)
    );
    if (waiting) {
      waiting.file = file;
      waiting.summary = summary;
      waiting.awaitingFile = false;
      waiting.fileRef = { name: file.name, size: file.size, lastModified: file.lastModified, path: descriptor.filePath };
      waiting.previewUrl = null;
      this.enqueueThumbnail(waiting);
      this.queueAutomaticListening([waiting]);
      this.touch();
      this.pushAgentLog('action', `Reconnected ${file.name} from its local path`);
      await this.paintAgentProgress();
      return { status: 'imported', relinked: true, clipId: waiting.id, assetId: this.agentAssetId(waiting), name: file.name };
    }
    const clip: MediaClip = {
      kind: 'media', id: `clip-${this.nextId++}`, file, sourcePath: descriptor.filePath,
      summary, info: null, overrides: null, detected: [], manualCuts: [], analysis: null,
      analyzedWith: null, replacementAudio: null, caption: null, previewUrl: null, thumbUrl: null
    };
    const requested = args['atIndex'] === undefined ? this.clips.length : Math.trunc(finiteNumber(args['atIndex'], 'atIndex'));
    const position = Math.max(0, Math.min(requested, this.clips.length));
    this.clips.splice(position, 0, clip);
    this.enqueueThumbnail(clip);
    this.queueAutomaticListening([clip]);
    this.applyTimelapseTarget();
    this.touch();
    this.pushAgentLog('action', `Added ${clip.file.name} to the timeline`);
    await this.paintAgentProgress();
    await this.openTimelinePreview();
    return { status: 'imported', clipId: clip.id, assetId: this.agentAssetId(clip), name: clip.file.name };
  }

  /**
   * Reopen from disk whatever is still waiting for its file.
   *
   * A recovery checkpoint stores a reference, never bytes — which is right, and
   * which is also why a restored project comes back with every clip waiting.
   * Nothing used to reconnect them, so the first command an agent sent after a
   * resume failed with `media_unavailable` on a project that was, on disk,
   * entirely intact.
   *
   * The absolute path is already in the document for anything that arrived by
   * path, so the file can simply be opened again. The path is the authority
   * here, not the size and date: a clip whose source was re-encoded still
   * points at that file, and refusing it because the bytes changed would be a
   * worse answer than reconnecting it.
   *
   * @returns how many files were reconnected
   */
  private async agentRelinkFromDisk(): Promise<number> {
    if (!this.desktop.isDesktop) return 0;

    const wanted = new Set<string>();
    for (const clip of this.clips) {
      if (isMediaClip(clip) && clip.awaitingFile) {
        const at = clip.sourcePath ?? clip.fileRef?.path;
        if (at) wanted.add(at);
      }
      if (isMediaClip(clip)) {
        for (const image of clip.images ?? []) {
          if (image.source.awaitingFile && image.source.fileRef?.path) wanted.add(image.source.fileRef.path);
        }
      }
      // Music is the quiet one. A restored sound carries no `awaitingFile`
      // flag — it is a zero-byte placeholder that still knows how long it is,
      // so the plan is complete and nothing notices until the export hands an
      // empty blob to the demuxer and reports an unrecognizable format.
      if (!isTransitionClip(clip)) {
        const replacement = clip.replacementAudio;
        if (replacement && replacement.file.size === 0 && replacement.fileRef?.path) wanted.add(replacement.fileRef.path);
      }
    }
    const soundtrack = this.project.defaultAudio;
    if (soundtrack && soundtrack.file.size === 0 && soundtrack.fileRef?.path) wanted.add(soundtrack.fileRef.path);
    if (!wanted.size) return 0;

    let attached = 0;
    for (const at of wanted) {
      // Once per session per path. This runs before every agent command, and a
      // file that is genuinely gone would otherwise be asked for again on each
      // one — including, once, a permission dialog each time.
      if (this.relinkFailures.has(this.agentPathKey(at))) continue;
      let file: File | undefined;
      try {
        // One at a time on purpose: a single file that has been moved away must
        // not stop the other three from coming back.
        [file] = await this.desktop.readAgentFiles([at]);
      } catch {
        this.relinkFailures.add(this.agentPathKey(at));
        continue;
      }
      if (!file) { this.relinkFailures.add(this.agentPathKey(at)); continue; }

      let used = false;
      for (const clip of this.clips) {
        if (!isMediaClip(clip) || !clip.awaitingFile) continue;
        const its = clip.sourcePath ?? clip.fileRef?.path;
        if (!its || this.agentPathKey(its) !== this.agentPathKey(at)) continue;
        clip.file = file;
        clip.awaitingFile = false;
        clip.info = null;
        clip.fileRef = { name: file.name, size: file.size, lastModified: file.lastModified, path: at };
        clip.previewUrl = null;
        if (!clip.thumbUrl) this.enqueueThumbnail(clip);
        used = true;
      }
      // Music, matched by the path it was written down with. The reference
      // match below cannot do it: a placeholder is zero bytes, so its recorded
      // length never equals the real file's.
      const key = this.agentPathKey(at);
      const soundtrack = this.project.defaultAudio;
      if (soundtrack && soundtrack.file.size === 0 && soundtrack.fileRef?.path
        && this.agentPathKey(soundtrack.fileRef.path) === key) {
        this.project.defaultAudio = { ...soundtrack, file };
        used = true;
      }
      for (const clip of this.clips) {
        if (isTransitionClip(clip)) continue;
        const replacement = clip.replacementAudio;
        if (!replacement || replacement.file.size !== 0 || !replacement.fileRef?.path) continue;
        if (this.agentPathKey(replacement.fileRef.path) !== key) continue;
        clip.replacementAudio = { ...replacement, file };
        used = true;
      }

      // Pictures and anything else still waiting are matched by reference,
      // which is what the manual reconnect has always done.
      if (this.attachRestoredFile(file, false)) used = true;
      if (used) {
        attached++;
        this.pushAgentLog('action', `Reconnected ${file.name} from ${at}`, 'Recovery', 'INFO');
      }
    }

    if (attached) {
      // The banner is a string, written once when the project came back. It
      // said four clips were waiting long after they had been reconnected,
      // which is worse than saying nothing.
      if (!this.hasAwaitingFiles && /waiting for their files/.test(this.notice)) {
        this.notice = 'Your last project came back, and its files were reconnected from disk.';
      }
      this.canReconnect = handlesSupported() && this.hasAwaitingFiles;
      this.refreshWithoutEditing();
      this.cdr.markForCheck();
    }
    if (this.awaitingCount) {
      this.pushAgentLog('action',
        `${this.awaitingCount} clip(s) are still waiting for files that are no longer where the project left them.`,
        'Recovery', 'WARN');
    }
    if (this.awaitingSounds.length) {
      this.pushAgentLog('action',
        `Still silent: ${this.awaitingSounds.join(', ')}. Exporting now would write silence where the music was.`,
        'Recovery', 'WARN');
    }
    return attached;
  }

  private agentPathKey(sourcePath: string): string {
    return sourcePath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
  }

  private async agentOpenProject(args: Record<string, unknown>): Promise<unknown> {
    const path = stringValue(args['path'], 'path');
    if (args['expectedRevision'] !== undefined && finiteNumber(args['expectedRevision'], 'expectedRevision') !== this.revision) {
      throw new EditorAgentError('The project changed before open_project could run.', 'revision_conflict', {
        expectedRevision: args['expectedRevision'], actualRevision: this.revision,
        nextStep: 'Call get_project and retry with its current projectRevision.'
      });
    }
    const [file] = await this.desktop.readAgentFiles([path]);
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); }
    catch { throw new EditorAgentError('The project file is not valid JSON.', 'invalid_project'); }

    if (looksLikeSettingsDocument(parsed)) {
      await this.applySettingsDocument(parsed, file.name);
      return { kind: 'settings', path, revision: this.revision };
    }
    if (!looksLikeProject(parsed)) throw new EditorAgentError('The file is not a supported editor project.', 'invalid_project');
    const stored = parsed as StoredProject;
    this.applyRestored(restoreProject(stored));
    const relink = await this.agentRelinkStoredPaths(stored);
    this.cdr.markForCheck();
    return {
      kind: 'project', path, revision: this.revision,
      restoredFromRevision: (parsed as StoredProject).projectRevision ?? null,
      awaitingFiles: this.awaitingCount, awaitingSounds: this.awaitingSounds,
      recoveryReport: relink
    };
  }

  private async agentRelinkStoredPaths(stored: StoredProject): Promise<unknown> {
    const paths = new Set<string>();
    const addSound = (sound: { ref?: { path?: string } } | null | undefined) => {
      if (sound?.ref?.path) paths.add(sound.ref.path);
    };
    addSound(stored.settings.defaultAudio);
    for (const clip of stored.clips) {
      if (clip.kind === 'media' && clip.file.path) paths.add(clip.file.path);
      if (clip.kind !== 'transition') addSound(clip.replacementAudio);
      if (clip.kind === 'text' && clip.background?.path) paths.add(clip.background.path);
    }
    let relinked = 0;
    const unavailable: { path: string; error: string }[] = [];
    for (const sourcePath of paths) {
      try {
        const [file] = await this.desktop.readAgentFiles([sourcePath]);
        if (file && this.attachRestoredFile(file)) relinked++;
      } catch (error) {
        unavailable.push({ path: sourcePath, error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.pushAgentLog(
      unavailable.length ? 'action' : 'done',
      `Recovery relinked ${relinked} stored media path(s); ${unavailable.length} remain unavailable.`,
      'open_project', unavailable.length ? 'WARN' : 'INFO'
    );
    return {
      requestedPaths: paths.size, relinked, unavailable,
      awaitingFiles: this.awaitingCount, awaitingSounds: this.awaitingSounds,
      recoverable: unavailable.length > 0
    };
  }

  private async agentSaveProject(args: Record<string, unknown>): Promise<unknown> {
    const path = stringValue(args['path'], 'path');
    const kind = args['kind'] === 'settings' ? 'settings' : 'project';
    const content = kind === 'settings'
      ? settingsDocumentFrom(String(args['name'] || 'MCP settings'), this.project)
      : serializeProject(this.clips, this.project, this.nextId, { projectRevision: this.revision });
    const bytes = new TextEncoder().encode(JSON.stringify(content, null, 2));
    const handle = await this.desktop.openAgentOutput(path);
    try {
      await handle.write(bytes);
      await handle.close();
    } catch (error) {
      await handle.abort().catch(() => undefined);
      throw error;
    }
    return { path, kind, bytes: bytes.byteLength, savedProjectRevision: this.revision };
  }

  private async agentSetProjectSoundtrack(
    args: Record<string, unknown>, signal?: AbortSignal, operationId = ''
  ): Promise<unknown> {
    const path = stringValue(args['path'], 'path');
    const response = await this.agentApplyBatch({
      expectedRevision: args['expectedRevision'] === undefined
        ? undefined
        : finiteNumber(args['expectedRevision'], 'expectedRevision'),
      label: 'Set project soundtrack',
      operations: [{
        type: 'attach_audio', path,
        skipLeadingSilence: args['skipLeadingSilence'] === undefined ? true : Boolean(args['skipLeadingSilence'])
      }]
    }, signal, operationId);
    return {
      ...(response as Record<string, unknown>),
      target: 'project', path,
      appliesTo: 'silent and timelapse clips according to project audio settings',
      soundtrack: this.project.defaultAudio?.summary.fileName ?? null
    };
  }

  private async agentPreview(args: Record<string, unknown>): Promise<unknown> {
    const action = String(args['action'] ?? 'open');
    if (!['open', 'play', 'pause', 'seek', 'close'].includes(action)) {
      throw new EditorAgentError('preview action must be open, play, pause, seek or close.', 'invalid_arguments');
    }
    if (action === 'close') this.closeTimelinePreview();
    else {
      await this.openTimelinePreview();
      if (action === 'seek') this.onScrub(finiteNumber(args['time'], 'time'));
      if (action === 'play' && this.player && !this.player.playing) {
        await this.zone.runOutsideAngular(() => this.player!.play());
        this.previewPlaying = true;
      }
      if (action === 'pause' && this.player?.playing) {
        this.zone.runOutsideAngular(() => this.player?.pause());
        this.previewPlaying = false;
      }
    }
    this.cdr.markForCheck();
    return { open: this.previewOpen, playing: this.previewPlaying, time: this.previewTime, duration: this.plan.totalDuration };
  }

  private agentFinishEditing(args: Record<string, unknown>): unknown {
    this.agentCompletionSummary = typeof args['summary'] === 'string' && args['summary'].trim()
      ? args['summary'].trim().slice(0, 1000)
      : 'The AI edit is complete and the recovery checkpoint is ready.';
    // The completion choice replaces the activity console. Keeping the console
    // open would cover the preview as soon as the user chooses to watch it.
    this.agentLogOpen = false;
    this.agentCompletionOpen = true;
    this.cdr.markForCheck();
    return { shown: true, choices: ['preview', 'render'], projectRevision: this.revision };
  }

  closeAgentCompletion(): void {
    this.agentCompletionOpen = false;
  }

  async previewAgentCompletion(): Promise<void> {
    this.agentCompletionOpen = false;
    await this.openTimelinePreview();
  }

  async renderAgentCompletion(): Promise<void> {
    this.agentCompletionOpen = false;
    await this.export('video');
  }

  /** A container with a picture. Audio has nothing for an effect to act on. */
  private agentVisualClip(id: unknown): MediaClip {
    const clip = this.agentMediaClip(id);
    if (clip.summary.kind === 'audio') {
      throw new EditorAgentError('Video Effects require a visual media container.', 'invalid_target');
    }
    return clip;
  }

  /** Rejects `none`, which would leave a section that does nothing. */
  private agentEffectId(value: unknown): string {
    const id = stringValue(value, 'effectId');
    if (id === 'none') {
      throw new EditorAgentError(
        'Use remove_video_effect to take a section away. "none" would leave an empty section behind.',
        'invalid_arguments'
      );
    }
    if (!effectDefinition(id)) {
      throw new EditorAgentError(
        `Unknown Video Effect "${id}". Read get_editor_capabilities.videoEffects.presets.`,
        'invalid_arguments'
      );
    }
    return id;
  }

  private agentEffectIntensity(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const intensity = finiteNumber(value, 'intensity');
    if (intensity < 0 || intensity > 1) {
      throw new EditorAgentError('Effect intensity must be between 0 and 1.', 'invalid_arguments');
    }
    return intensity;
  }

  private agentEffectFade(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const fade = finiteNumber(value, 'fadeSeconds');
    if (fade < 0 || fade > 10) {
      throw new EditorAgentError('fadeSeconds must be between 0 and 10. Use 0 for a hard cut.', 'invalid_arguments');
    }
    return fade;
  }


  private agentVision: SubjectSegmentationClient | null = null;

  /**
   * The segmentation client used to compose frames for an agent.
   *
   * One per session rather than one per call. An agent is told to verify every
   * placement it makes with a composed frame, so this is the most-called path
   * there is — and a fresh client each time reloads the model, starts a worker
   * and throws away a mask cache that the next call over the same clip would
   * almost certainly have hit.
   *
   * A client that failed earlier is asked to try again rather than left broken
   * for the rest of the session; `retry` refuses on its own when the failure
   * was not the retryable kind.
   */
  private agentSubjectVision(): SubjectSegmentationClient {
    this.agentVision ??= new SubjectSegmentationClient();
    if (this.agentVision.state === 'unavailable') this.agentVision.retry();
    return this.agentVision;
  }

  /**
   * Opens one picture from an absolute path and measures it.
   *
   * The path is read through the desktop bridge, which is the only thing that
   * checks it against the roots the session was started with — the editor never
   * reaches a path on its own. No picture bytes are sent anywhere: the file is
   * decoded here, in the page, exactly as one chosen by hand would be.
   */
  private async agentImageSource(path: string): Promise<ClipImageSource> {
    const [file] = await this.desktop.readAgentFiles([path]);
    if (!file) throw new EditorAgentError(`No picture could be read at ${path}.`, 'media_unavailable');
    let width = 0;
    let height = 0;
    try {
      const bitmap = await imageBitmapForFile(file);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      throw new EditorAgentError(`${file.name} is not a picture this browser can decode.`, 'media_unavailable');
    }
    return {
      file,
      name: file.name,
      width,
      height,
      sourcePath: path,
      fileRef: { name: file.name, size: file.size, lastModified: file.lastModified, path }
    };
  }

  /** Every placement value an agent may send, checked against its limit. */
  private agentImagePlacement(patch: Record<string, unknown>): Partial<ClipImage> {
    const change: Partial<ClipImage> = {};
    const bounded = (key: string, limits: { min: number; max: number }): number | undefined => {
      if (patch[key] === undefined) return undefined;
      const value = finiteNumber(patch[key], key);
      if (value < limits.min || value > limits.max) {
        throw new EditorAgentError(`${key} must be between ${limits.min} and ${limits.max}.`, 'invalid_arguments');
      }
      return value;
    };
    const positionX = bounded('positionX', IMAGE_LIMITS.position);
    const positionY = bounded('positionY', IMAGE_LIMITS.position);
    const scale = bounded('scale', IMAGE_LIMITS.scale);
    const rotation = bounded('rotationDegrees', IMAGE_LIMITS.rotationDegrees);
    const opacity = bounded('opacity', IMAGE_LIMITS.opacity);
    const fade = bounded('fadeSeconds', IMAGE_LIMITS.fadeSeconds);
    if (positionX !== undefined) change.positionX = positionX;
    if (positionY !== undefined) change.positionY = positionY;
    if (scale !== undefined) change.scale = scale;
    if (rotation !== undefined) change.rotationDegrees = rotation;
    if (opacity !== undefined) change.opacity = opacity;
    if (fade !== undefined) change.fadeSeconds = fade;
    const style = patch['style'];
    if (style !== undefined) {
      if (!isImageStyle(style)) {
        throw new EditorAgentError("style must be 'overlay' or 'behind-subject'.", 'invalid_arguments');
      }
      change.style = style;
    }
    return change;
  }

  /**
   * What an agent reads back about one placement.
   *
   * The measured box is included rather than left to be worked out from the
   * scale, because that sum needs the frame size and the picture's own aspect
   * ratio, and an agent guessing at either is how a picture ends up reported as
   * fitting while half of it is off the side. `fitsInFrame` is the same answer
   * the panel shows, from the same function.
   */
  private agentImagePayload(clip: MediaClip, image: ClipImage): unknown {
    const plan = this.plan;
    const box = imageBox(image, Math.max(1, plan.width), Math.max(1, plan.height));
    return {
      imageId: image.id ?? null,
      name: image.source.name,
      path: image.source.sourcePath ?? null,
      naturalWidth: image.source.width,
      naturalHeight: image.source.height,
      startSeconds: image.startSeconds ?? null,
      durationSeconds: image.durationSeconds ?? null,
      fadeSeconds: image.fadeSeconds ?? 0,
      style: image.style ?? 'overlay',
      positionX: image.positionX ?? 0.5,
      positionY: image.positionY ?? 0.5,
      scale: image.scale ?? IMAGE_LIMITS.scale.default,
      rotationDegrees: image.rotationDegrees ?? 0,
      opacity: image.opacity ?? 1,
      frame: { width: plan.width, height: plan.height },
      box: {
        left: Math.round(box.left), top: Math.round(box.top),
        right: Math.round(box.right), bottom: Math.round(box.bottom),
        width: Math.round(box.width), height: Math.round(box.height)
      },
      fitsInFrame: box.contained,
      // The same answer the panel shows the reader. An agent is told to look at
      // a composed frame, and it should — but a picture sitting on top of the
      // caption is a fact the editor already knows, and making the agent
      // rediscover it by eye is how it gets missed.
      covers: this.clipImageCovers(clip, image),
      awaitingFile: !!image.source.awaitingFile
    };
  }

  /**
   * Refuses a section that would land on another one, and says where they are.
   *
   * The editor's own `updateVideoEffect` silently declines an overlapping edit,
   * which is the right answer to a dragged field and the wrong answer to an
   * agent: it would read as success and the edit would quietly not exist. The
   * agent gets the occupied ranges and the room actually available instead.
   */
  private agentAssertEffectSlot(clip: MediaClip, start: number, duration: number, excludeId?: string): void {
    const available = videoEffectSlotFor(clip, start, excludeId);
    if (available >= duration - 0.0005) return;
    const bounds = clipBounds(clip);
    const occupied = effectiveClipVideoEffects(clip)
      .filter(item => item.id !== excludeId)
      .map(item => {
        const from = Math.max(bounds.start, item.startSeconds ?? bounds.start);
        const to = Math.min(bounds.end, from + Math.max(0, item.durationSeconds ?? bounds.end - from));
        return { videoEffectId: item.id ?? null, effectId: item.effectId, start: +from.toFixed(3), end: +to.toFixed(3) };
      })
      .sort((a, b) => a.start - b.start);
    throw new EditorAgentError(
      available <= 0
        ? `A Video Effect section already covers ${start.toFixed(2)}s on clip "${clip.id}".`
        : `A Video Effect section starting at ${start.toFixed(2)}s may last at most ${available.toFixed(2)}s on clip "${clip.id}".`,
      'video_effect_overlap',
      {
        clipId: clip.id,
        start: +start.toFixed(3),
        requestedDuration: +duration.toFixed(3),
        maximumDuration: +Math.max(0, available).toFixed(3),
        clipBounds: { start: +bounds.start.toFixed(3), end: +bounds.end.toFixed(3) },
        occupied
      }
    );
  }

  private agentMediaClip(id: unknown): MediaClip {
    const clipId = stringValue(id, 'clipId');
    const clip = this.clips.find((candidate): candidate is MediaClip => candidate.id === clipId && isMediaClip(candidate));
    if (!clip) throw new EditorAgentError(`Media clip "${clipId}" was not found.`, 'not_found');
    if (clip.awaitingFile) {
      // Reconnecting from disk was already attempted for this request, so this
      // means the file is genuinely not where the project left it. Say where it
      // was looked for; "waiting for its source file" alone is unactionable.
      const at = clip.sourcePath ?? clip.fileRef?.path;
      throw new EditorAgentError(
        at
          ? `Media clip "${clipId}" is waiting for its source file, which is no longer at ${at}.`
          : `Media clip "${clipId}" is waiting for its source file, and the project does not record where it was.`,
        'media_unavailable',
        { clipId, expectedPath: at ?? null, fileName: clip.fileRef?.name ?? clip.file.name, recoverable: Boolean(at) }
      );
    }
    return clip;
  }

  private agentClip(id: unknown): EditorClip {
    const clipId = stringValue(id, 'clipId');
    const clip = this.clips.find((candidate) => candidate.id === clipId);
    if (!clip) throw new EditorAgentError(`Clip "${clipId}" was not found.`, 'not_found');
    return clip;
  }

  private async agentApplyBatch(batch: EditorAgentBatch, signal?: AbortSignal, operationId = ''): Promise<unknown> {
    if (!batch || !Array.isArray(batch.operations) || !batch.operations.length) {
      throw new EditorAgentError('operations must be a non-empty array.', 'invalid_arguments');
    }
    if (batch.operations.length > 500) throw new EditorAgentError('A batch may contain at most 500 operations.', 'limit_exceeded');
    if (batch.expectedRevision !== undefined && batch.expectedRevision !== this.revision) {
      throw new EditorAgentError(
        `Project revision ${batch.expectedRevision} is stale; the current revision is ${this.revision}.`,
        'revision_conflict', {
          expectedRevision: batch.expectedRevision, actualRevision: this.revision,
          changedBy: this.lastRevisionReason, changedAt: this.lastRevisionAt,
          nextStep: 'Call get_project after every open/restart/recovery and retry with its current projectRevision.'
        }
      );
    }

    const before = this.snapshot();
    const beforeDuration = this.plan.totalDuration;
    const startRevision = this.revision;
    const madeByOperation: Record<string, unknown>[] = [];
    this.applyingHistory = true;

    try {
      for (let operationIndex = 0; operationIndex < batch.operations.length; operationIndex++) {
        if (signal?.aborted) throw new EditorAgentError('Edit batch cancellation was acknowledged before commit.', 'cancelled', {
          terminalState: 'cancelled', rolledBack: true, appliedOperationsBeforeRollback: operationIndex
        });
        const operation = batch.operations[operationIndex];
        const percent = Math.round(operationIndex * 100 / batch.operations.length);
        if (operationId) this.desktop.reportAgentProgress({
          operationId, state: 'processing', stage: batch.dryRun ? 'validating-batch' : 'applying-batch', percent,
          operationIndex, operationCount: batch.operations.length,
          clipId: 'clipId' in operation ? operation.clipId : null
        });
        this.pushAgentLog(
          'action',
          `${batch.dryRun ? 'Simulating' : 'Operation'} ${operationIndex + 1}/${batch.operations.length}: ${this.agentOperationLabel(operation)}`,
          'apply_edit_batch', 'INFO', new Date().toISOString(), percent
        );
        await this.paintAgentProgress();
        const created = await this.agentApplyOperation(operation);
        // What each operation made, in the order they ran. A caption added and
        // then styled in the same batch is the ordinary case, and it only works
        // if the second operation can be told what the first one called it.
        madeByOperation.push({ index: operationIndex, type: operation.type, ...(created ?? {}) });
        if (!batch.dryRun) await this.paintAgentProgress();
      }
      // Planning is the strongest inexpensive invariant check: malformed cuts,
      // joins and durations fail here before the transaction is committed.
      this.planCache = null;
      this.planRevision = -1;
      const afterDuration = this.plan.totalDuration;

      if (batch.dryRun) {
        this.applySnapshot(before);
        this.revision = startRevision;
        return {
          dryRun: true,
          terminalState: 'validated',
          operationCount: batch.operations.length,
          // Valid for the commit too, because the id counter is part of the
          // snapshot a dry run rolls back: the run that commits assigns the
          // same ids this one reported.
          created: madeByOperation,
          durationBefore: beforeDuration,
          durationAfter: afterDuration,
          removedSeconds: Math.max(0, beforeDuration - afterDuration)
        };
      }

      this.history.push(before);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      this.future.length = 0;
      this.revision = startRevision + 1;
      this.pending = this.snapshot();
      this.pendingSignature = this.signature(this.pending);
      this.lastChangeAt = 0;
      this.scheduleSave();
      this.cdr.markForCheck();
      return {
        committed: true,
        terminalState: 'applied',
        label: batch.label ?? 'Agent edit',
        operationCount: batch.operations.length,
        created: madeByOperation,
        durationBefore: beforeDuration,
        durationAfter: afterDuration,
        removedSeconds: Math.max(0, beforeDuration - afterDuration)
      };
    } catch (error) {
      this.applySnapshot(before);
      this.revision = startRevision;
      if (error instanceof EditorAgentError && error.code === 'cancelled') throw error;
      throw new EditorAgentError(
        `Edit batch failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        'batch_rolled_back',
        {
          terminalState: 'failed', rolledBack: true, restoredRevision: startRevision,
          originalError: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
        }
      );
    } finally {
      this.applyingHistory = false;
    }
  }

  private agentClipLabel(clipId: string): string {
    const clip = this.clips.find((candidate) => candidate.id === clipId);
    if (!clip) return clipId;
    if (isMediaClip(clip)) return clip.summary.fileName;
    if (isTextClip(clip)) return clip.draft.text.trim().slice(0, 42) || 'text card';
    return `transition ${clip.id}`;
  }

  private agentOperationLabel(operation: EditorAgentOperation): string {
    const label = 'clipId' in operation && typeof operation.clipId === 'string'
      ? this.agentClipLabel(operation.clipId)
      : '';
    switch (operation.type) {
      case 'remove_clip': return `Removing ${label}`;
      case 'set_video_effect': return `Applying ${effectDefinition(operation.effectId)?.name ?? operation.effectId} to ${label}`;
      case 'add_video_effect': return `Adding ${effectDefinition(operation.effectId)?.name ?? operation.effectId} to a section of ${label}`;
      case 'update_video_effect': return `Updating a Video Effect section on ${label}`;
      case 'remove_video_effect': return `Removing a Video Effect section from ${label}`;
      case 'add_image': return `Placing ${operation.path.split(/[\\/]/).pop()} on ${label} at ${operation.start.toFixed(2)}s`;
      case 'update_image': return operation.image?.path
        ? `Swapping the picture on ${label}`
        : `Adjusting a placed picture on ${label}`;
      case 'remove_image': return `Removing a placed picture from ${label}`;
      case 'move_clip': return `Moving ${label} to timeline position ${operation.toIndex}`;
      case 'duplicate_clip': return `Duplicating ${label}`;
      case 'add_text_clip': return `Adding text card: ${operation.text.slice(0, 60)}`;
      case 'update_text_clip': return `Updating text card: ${label}`;
      case 'set_text_background': return operation.path ? `Adding a background to ${label}` : `Removing the background from ${label}`;
      case 'add_transition': return `Adding a transition at timeline position ${operation.atIndex}`;
      case 'update_transition': return `Updating ${label}`;
      case 'split_clip': return `Cutting ${label} at ${operation.sourceTime.toFixed(2)}s`;
      case 'trim_clip': return `Trimming ${label}`;
      case 'clear_trim': return `Restoring the trim on ${label}`;
      case 'set_image_duration': return `Changing the duration of ${label} to ${operation.durationSeconds}s`;
      case 'delete_source_range': return `Cutting ${operation.start.toFixed(2)}s–${operation.end.toFixed(2)}s from ${label}`;
      case 'restore_source_ranges': return `Restoring removed ranges in ${label}`;
      case 'set_detected_range': return `${operation.enabled ? 'Removing' : 'Keeping'} detected pause ${operation.rangeIndex + 1} in ${label}`;
      case 'set_speed': return `Changing the speed of ${label} to ${operation.speed}x`;
      case 'set_volume': return `Changing the volume of ${label} to ${operation.volumePercent}%`;
      case 'set_audio_mode': return `Changing the audio mode of ${label} to ${operation.mode}`;
      case 'set_noise_suppression': return `${operation.enabled ? 'Scheduling' : 'Disabling'} noise suppression on ${label}`;
      case 'set_clip_edits': return `Updating effects on ${label}`;
      case 'clear_clip_overrides': return `Returning ${label} to project defaults`;
      case 'attach_audio': return operation.clipId ? `Adding audio to ${label}` : 'Adding the project soundtrack';
      case 'detach_audio': return operation.clipId ? `Removing replacement audio from ${label}` : 'Removing the project soundtrack';
      case 'add_caption': return captionPresetIsBackground(String(operation.caption?.['stylePreset'] ?? '')) || operation.caption?.['style'] === 'behind-subject'
        ? `Adding a Behind Subject caption to ${label}: ${operation.text.slice(0, 60)}`
        : `Adding a caption to ${label}: ${operation.text.slice(0, 60)}`;
      case 'update_caption': return captionPresetIsBackground(String(operation.caption?.['stylePreset'] ?? '')) || operation.caption?.['style'] === 'behind-subject'
        ? `Applying Behind Subject to a caption on ${label}`
        : `Updating a caption on ${label}`;
      case 'remove_caption': return `Removing a caption from ${label}`;
      case 'set_tag': {
        const tag = operation.tag;
        return typeof tag['qrText'] === 'string' || String(tag['shape'] ?? '').startsWith('qr-')
          ? `Adding a QR Code tag to ${label}`
          : `Adding tag to ${label}: ${String(tag['text'] ?? '').slice(0, 60)}`;
      }
      case 'remove_tag': return `Removing the tag from ${label}`;
      case 'add_zoom': return `Adding a zoom to ${label}`;
      case 'add_push_in': return `Adding a dynamic push-in to ${label}`;
      case 'update_zoom': return `Updating a zoom on ${label}`;
      case 'update_push_in': return `Updating a dynamic push-in on ${label}`;
      case 'remove_zoom': return `Removing a zoom from ${label}`;
      case 'remove_push_in': return `Removing a dynamic push-in from ${label}`;
      case 'set_project_settings': return 'Updating project settings';
    }
  }

  /**
   * @returns the ids of anything it created, or nothing when it created
   *   nothing. An operation that makes a thing and does not name it forces the
   *   caller to guess — which is exactly how a batch came to update
   *   "caption-16", a caption that was never created.
   */
  private async agentApplyOperation(operation: EditorAgentOperation): Promise<Record<string, string | null> | void> {
    switch (operation.type) {
      case 'remove_clip': {
        const clip = this.agentClip(operation.clipId);
        this.remove(this.clips.indexOf(clip));
        return;
      }
      case 'move_clip': {
        const clip = this.agentClip(operation.clipId);
        const from = this.clips.indexOf(clip);
        const to = Math.max(0, Math.min(this.clips.length - 1, Math.round(finiteNumber(operation.toIndex, 'toIndex'))));
        this.clips.splice(to, 0, this.clips.splice(from, 1)[0]);
        this.touch();
        return;
      }
      case 'duplicate_clip': this.duplicate(this.clips.indexOf(this.agentClip(operation.clipId))); return;
      case 'add_text_clip': {
        const at = operation.atIndex === undefined
          ? this.clips.length
          : Math.max(0, Math.min(this.clips.length, Math.round(finiteNumber(operation.atIndex, 'atIndex'))));
        const clip: TextClip = {
          kind: 'text',
          id: `text-${this.nextId++}`,
          draft: this.agentTextDraft(DEFAULT_TEXT_DRAFT, operation.text, operation.draft, operation.durationSeconds),
          backgroundFile: null,
          backgroundUrl: null,
          replacementAudio: null,
          overrides: null,
          tag: null
        };
        this.clips.splice(at, 0, clip);
        this.touch();
        return { clipId: clip.id };
      }
      case 'update_text_clip': {
        const clip = this.agentClip(operation.clipId);
        if (!isTextClip(clip)) throw new EditorAgentError('update_text_clip requires a text card.', 'invalid_target');
        clip.draft = this.agentTextDraft(clip.draft, operation.text, operation.draft, operation.durationSeconds);
        this.touch();
        return;
      }
      case 'set_text_background': {
        const clip = this.agentClip(operation.clipId);
        if (!isTextClip(clip)) throw new EditorAgentError('set_text_background requires a text card.', 'invalid_target');
        if (operation.path === null) {
          if (clip.backgroundUrl) URL.revokeObjectURL(clip.backgroundUrl);
          clip.backgroundFile = null;
          clip.backgroundUrl = null;
          clip.backgroundRef = undefined;
        } else {
          const [file] = await this.desktop.readAgentFiles([stringValue(operation.path, 'path')]);
          if (!file.type.startsWith('image/')) throw new EditorAgentError('A text-card background must be an image.', 'invalid_media');
          // Do not revoke the current background until the replacement has
          // been read and validated. A bad path must leave the visible card
          // untouched, even before the surrounding transaction rolls back.
          if (clip.backgroundUrl) URL.revokeObjectURL(clip.backgroundUrl);
          clip.backgroundFile = file;
          clip.backgroundUrl = mediaObjectUrl(file);
          clip.backgroundRef = undefined;
        }
        this.touch();
        return;
      }
      case 'add_transition': {
        const at = Math.round(finiteNumber(operation.atIndex, 'atIndex'));
        if (!this.canInsertTransition(at)) {
          throw new EditorAgentError('A transition must be placed between two playable clips.', 'invalid_range');
        }
        const clip: TransitionClip = {
          kind: 'transition', id: `join-${this.nextId++}`,
          settings: this.agentTransitionSettings(DEFAULT_TRANSITION, operation.settings)
        };
        this.clips.splice(at, 0, clip);
        this.touch();
        return;
      }
      case 'update_transition': {
        const clip = this.agentClip(operation.clipId);
        if (!isTransitionClip(clip)) throw new EditorAgentError('update_transition requires a transition.', 'invalid_target');
        clip.settings = this.agentTransitionSettings(clip.settings, operation.settings);
        this.touch();
        return;
      }
      case 'split_clip': {
        const clip = this.agentMediaClip(operation.clipId);
        const sourceTime = finiteNumber(operation.sourceTime, 'sourceTime');
        if (!this.canSplitAt(clip, sourceTime)) {
          throw new EditorAgentError('The split must leave at least 0.2 seconds on both sides.', 'invalid_range');
        }
        this.splitClip(clip, sourceTime);
        return;
      }
      case 'trim_clip': {
        const clip = this.agentMediaClip(operation.clipId);
        const from = operation.inPoint ?? clip.inPoint ?? 0;
        const to = operation.outPoint ?? clip.outPoint ?? clip.summary.durationSeconds;
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > clip.summary.durationSeconds || to - from < MIN_CLIP_SECONDS) {
          throw new EditorAgentError('trim_clip must leave at least 0.2 seconds inside the source.', 'invalid_range');
        }
        clip.inPoint = from > 0 ? from : undefined;
        clip.outPoint = to < clip.summary.durationSeconds ? to : undefined;
        this.touch();
        return;
      }
      case 'clear_trim': this.clearTrim(this.agentMediaClip(operation.clipId)); return;
      case 'set_image_duration': {
        const clip = this.agentMediaClip(operation.clipId);
        if (clip.summary.kind !== 'image') throw new EditorAgentError('set_image_duration requires an image clip.', 'invalid_target');
        const duration = finiteNumber(operation.durationSeconds, 'durationSeconds');
        clip.summary.durationSeconds = Math.max(IMAGE_SECONDS.min, Math.min(IMAGE_SECONDS.max, duration));
        this.touch();
        return;
      }
      case 'delete_source_range': {
        const clip = this.agentMediaClip(operation.clipId);
        const start = finiteNumber(operation.start, 'start');
        const end = finiteNumber(operation.end, 'end');
        const bounds = clipBounds(clip);
        if (start < bounds.start || end > bounds.end || end - start < 0.01) {
          throw new EditorAgentError(`Cut must be inside ${bounds.start.toFixed(3)}..${bounds.end.toFixed(3)}.`, 'invalid_range');
        }
        clip.manualCuts = [...clip.manualCuts, { start, end, source: 'manual', enabled: true }];
        this.touch();
        return;
      }
      case 'restore_source_ranges': {
        const clip = this.agentMediaClip(operation.clipId);
        clip.manualCuts = [];
        for (const range of clip.detected) range.enabled = false;
        this.touch();
        return;
      }
      case 'set_detected_range': {
        const clip = this.agentMediaClip(operation.clipId);
        const at = Math.round(finiteNumber(operation.rangeIndex, 'rangeIndex'));
        const range = clip.detected[at];
        if (!range) throw new EditorAgentError(`Detected range ${at} was not found.`, 'not_found');
        range.enabled = operation.enabled;
        this.touch();
        return;
      }
      case 'set_speed': {
        const clip = this.agentClip(operation.clipId);
        if (isTransitionClip(clip)) throw new EditorAgentError('A transition has no playback speed.', 'invalid_target');
        clip.overrides ??= cloneEdits(this.project.edits);
        clip.overrides.speed = clampSpeed(finiteNumber(operation.speed, 'speed'));
        this.touch();
        return;
      }
      case 'set_volume': {
        const clip = this.agentClip(operation.clipId);
        if (isTransitionClip(clip)) throw new EditorAgentError('A transition has no volume.', 'invalid_target');
        clip.overrides ??= cloneEdits(this.project.edits);
        clip.overrides.volumePercent = Math.max(VOLUME_LIMITS.min, Math.min(VOLUME_LIMITS.max, finiteNumber(operation.volumePercent, 'volumePercent')));
        this.touch();
        return;
      }
      case 'set_audio_mode': {
        const clip = this.agentClip(operation.clipId);
        if (isTransitionClip(clip)) throw new EditorAgentError('A transition has no audio mode.', 'invalid_target');
        if (!['original', 'replace', 'continue', 'mute'].includes(operation.mode)) {
          throw new EditorAgentError('Unknown audio mode.', 'invalid_arguments');
        }
        clip.overrides ??= cloneEdits(this.project.edits);
        clip.overrides.audioMode = operation.mode;
        this.touch();
        return;
      }
      case 'set_video_effect': {
        const clip = this.agentMediaClip(operation.clipId);
        if (clip.summary.kind === 'audio') throw new EditorAgentError('Video Effects require a visual media container.', 'invalid_target');
        if (!effectDefinition(operation.effectId)) throw new EditorAgentError('Unknown Video Effect. Read get_capabilities.videoEffects.presets.', 'invalid_arguments');
        const intensity = operation.intensity === undefined ? undefined : finiteNumber(operation.intensity, 'intensity');
        if (intensity !== undefined && (intensity < 0 || intensity > 1)) throw new EditorAgentError('Effect intensity must be between 0 and 1.', 'invalid_arguments');
        this.setVideoEffect(clip, normalizeVideoEffect({ id: operation.effectId, intensity }));
        return;
      }
      case 'add_video_effect': {
        const clip = this.agentVisualClip(operation.clipId);
        const effectId = this.agentEffectId(operation.effectId);
        const intensity = this.agentEffectIntensity(operation.intensity);
        const fadeSeconds = this.agentEffectFade(operation.fadeSeconds);
        // Migrate a legacy whole-clip effect first, so the room left on the
        // clip is measured against a list that already contains it.
        this.ensureTimedVideoEffects(clip);
        const bounds = clipBounds(clip);
        const start = Math.max(bounds.start, Math.min(bounds.end, finiteNumber(operation.start, 'start')));
        const room = videoEffectSlotFor(clip, start);
        const duration = operation.duration === undefined
          ? Math.min(5, room)
          : finiteNumber(operation.duration, 'duration');
        if (duration < 0.1) {
          throw new EditorAgentError('A Video Effect section must last at least 0.1s.', 'invalid_arguments');
        }
        this.agentAssertEffectSlot(clip, start, duration);
        const section: ClipVideoEffect = {
          id: `effect-${this.nextId++}`,
          effectId,
          intensity: normalizeVideoEffect({ id: effectId, intensity }).intensity,
          startSeconds: start,
          durationSeconds: Math.min(duration, bounds.end - start),
          fadeSeconds: Math.max(0, Math.min(fadeSeconds ?? 0, duration / 2))
        };
        clip.videoEffects = [...(clip.videoEffects ?? []), section]
          .sort((a, b) => (a.startSeconds ?? bounds.start) - (b.startSeconds ?? bounds.start));
        clip.videoEffect = { id: 'none', intensity: 0 };
        this.touch();
        return { videoEffectId: section.id ?? null, clipId: clip.id };
      }
      case 'update_video_effect': {
        const clip = this.agentVisualClip(operation.clipId);
        this.ensureTimedVideoEffects(clip);
        const sectionId = stringValue(operation.videoEffectId, 'videoEffectId');
        const section = clip.videoEffects?.find(candidate => candidate.id === sectionId);
        if (!section) {
          throw new EditorAgentError(`Video Effect section "${sectionId}" was not found.`, 'not_found');
        }
        const patch = operation.videoEffect ?? {};
        const change: Partial<ClipVideoEffect> = {};
        if (patch.effectId !== undefined) change.effectId = this.agentEffectId(patch.effectId);
        const intensity = this.agentEffectIntensity(patch.intensity);
        if (intensity !== undefined) change.intensity = intensity;
        const fadeSeconds = this.agentEffectFade(patch.fadeSeconds);
        if (fadeSeconds !== undefined) change.fadeSeconds = fadeSeconds;
        if (patch.startSeconds !== undefined) change.startSeconds = finiteNumber(patch.startSeconds, 'startSeconds');
        if (patch.durationSeconds !== undefined) {
          const wanted = finiteNumber(patch.durationSeconds, 'durationSeconds');
          if (wanted < 0.1) {
            throw new EditorAgentError('A Video Effect section must last at least 0.1s.', 'invalid_arguments');
          }
          change.durationSeconds = wanted;
        }
        const bounds = clipBounds(clip);
        const start = change.startSeconds ?? section.startSeconds ?? bounds.start;
        const duration = change.durationSeconds ?? section.durationSeconds ?? Math.max(0.1, bounds.end - start);
        this.agentAssertEffectSlot(clip, start, duration, section.id);
        this.updateVideoEffect(clip, section, change);
        return;
      }
      case 'remove_video_effect': {
        const clip = this.agentVisualClip(operation.clipId);
        this.ensureTimedVideoEffects(clip);
        const sectionId = stringValue(operation.videoEffectId, 'videoEffectId');
        const section = clip.videoEffects?.find(candidate => candidate.id === sectionId);
        if (!section) {
          throw new EditorAgentError(`Video Effect section "${sectionId}" was not found.`, 'not_found');
        }
        this.removeVideoEffect(clip, section);
        return;
      }
      case 'add_image': {
        const clip = this.agentVisualClip(operation.clipId);
        const path = stringValue(operation.path, 'path');
        const bounds = clipBounds(clip);
        const start = Math.max(bounds.start, Math.min(bounds.end, finiteNumber(operation.start, 'start')));
        const room = Math.max(0, bounds.end - start);
        if (room < 0.2) {
          throw new EditorAgentError('There is less than 0.2s left on this container at that time.', 'invalid_arguments', {
            clipBounds: { start: bounds.start, end: bounds.end }
          });
        }
        const duration = operation.duration === undefined
          ? Math.min(4, room)
          : finiteNumber(operation.duration, 'duration');
        if (duration < 0.2) throw new EditorAgentError('A placed picture must last at least 0.2s.', 'invalid_arguments');
        const placement = this.agentImagePlacement(operation as unknown as Record<string, unknown>);
        const source = await this.agentImageSource(path);
        // Placed complete rather than added and then corrected: two mutations
        // for one operation would bump the revision twice and put a placement
        // nobody asked for into the undo history between them.
        this.addClipImage(clip, source, start, {
          ...placement,
          startSeconds: start,
          durationSeconds: Math.min(duration, room)
        });
        await loadImage(source);
        this.pushAgentLog('action', `Placed ${source.name} on ${clip.file.name}`);
        const placed = (clip.images ?? []).at(-1);
        return placed ? { imageId: placed.id ?? null, clipId: clip.id } : undefined;
      }
      case 'update_image': {
        const clip = this.agentVisualClip(operation.clipId);
        const imageId = stringValue(operation.imageId, 'imageId');
        const placed = (clip.images ?? []).find(candidate => candidate.id === imageId);
        if (!placed) throw new EditorAgentError(`Placed picture "${imageId}" was not found.`, 'not_found');
        const patch = (operation.image ?? {}) as Record<string, unknown>;
        const change: Partial<ClipImage> = this.agentImagePlacement(patch);
        if (patch['startSeconds'] !== undefined) change.startSeconds = finiteNumber(patch['startSeconds'], 'startSeconds');
        if (patch['durationSeconds'] !== undefined) {
          const duration = finiteNumber(patch['durationSeconds'], 'durationSeconds');
          if (duration < 0.2) throw new EditorAgentError('A placed picture must last at least 0.2s.', 'invalid_arguments');
          change.durationSeconds = duration;
        }
        // A new file is a separate step from a new placement, so an agent can
        // swap the picture without restating where it sits.
        if (patch['path'] !== undefined) {
          const replacement = await this.agentImageSource(stringValue(patch['path'], 'path'));
          forgetImage(placed.source);
          this.releaseImagePreview(placed);
          change.source = replacement;
          await loadImage(replacement);
        }
        this.updateClipImage(clip, placed, change);
        return;
      }
      case 'remove_image': {
        const clip = this.agentVisualClip(operation.clipId);
        const imageId = stringValue(operation.imageId, 'imageId');
        const placed = (clip.images ?? []).find(candidate => candidate.id === imageId);
        if (!placed) throw new EditorAgentError(`Placed picture "${imageId}" was not found.`, 'not_found');
        this.removeClipImage(clip, placed);
        return;
      }
      case 'set_noise_suppression': {
        const clip = this.agentMediaClip(operation.clipId);
        clip.noiseSuppression = clampClipNoise({
          ...this.noiseSettingsFor(clip),
          enabled: operation.enabled,
          ...(operation.engine === undefined ? {} : { engine: operation.engine }),
          ...(operation.strength === undefined ? {} : { strength: operation.strength }),
          ...(operation.preserveHighs === undefined ? {} : { preserveHighs: operation.preserveHighs })
        });
        this.touch();
        return;
      }
      case 'set_clip_edits': {
        const clip = this.agentClip(operation.clipId);
        if (isTransitionClip(clip)) throw new EditorAgentError('A transition has no clip effects.', 'invalid_target');
        const before = this.editsFor(clip);
        clip.overrides = this.agentClipEdits(before, operation.edits);
        if (isMediaClip(clip) && detectionSettingsChanged(before.silence, clip.overrides.silence)) this.invalidateAnalysis(clip);
        this.touch();
        return;
      }
      case 'clear_clip_overrides': {
        const clip = this.agentClip(operation.clipId);
        if (isTransitionClip(clip)) throw new EditorAgentError('A transition has no clip effects.', 'invalid_target');
        clip.overrides = null;
        this.touch();
        return;
      }
      case 'attach_audio': {
        const [file] = await this.desktop.readAgentFiles([stringValue(operation.path, 'path')]);
        if (operation.clipId) {
          const clip = this.agentClip(operation.clipId);
          if (isTransitionClip(clip)) throw new EditorAgentError('A transition cannot carry audio.', 'invalid_target');
          await this.attachAudio(clip, file);
          // An unsuccessful replacement deliberately preserves the prior
          // soundtrack. Check that this exact file was committed rather than
          // mistaking an older soundtrack for a successful operation.
          if (clip.replacementAudio?.file !== file) {
            throw new EditorAgentError(this.errorMessage || 'The audio could not be attached.', 'invalid_media');
          }
          if (operation.skipLeadingSilence !== undefined) {
            clip.replacementAudio = { ...clip.replacementAudio, skipLeadingSilence: operation.skipLeadingSilence };
          }
        } else {
          await this.setDefaultAudio(file);
          if (this.project.defaultAudio?.file !== file) {
            throw new EditorAgentError(this.errorMessage || 'The project audio could not be attached.', 'invalid_media');
          }
          if (operation.skipLeadingSilence !== undefined) {
            this.project = {
              ...this.project,
              defaultAudio: { ...this.project.defaultAudio, skipLeadingSilence: operation.skipLeadingSilence }
            };
          }
        }
        return;
      }
      case 'detach_audio': {
        if (operation.clipId) this.detachAudio(this.agentClip(operation.clipId));
        else this.clearDefaultAudio();
        return;
      }
      case 'add_caption': {
        const clip = this.agentMediaClip(operation.clipId);
        const previous = new Set((clip.captions ?? []).map((caption) => caption.id));
        this.addCaption(clip, finiteNumber(operation.start, 'start'), stringValue(operation.text, 'text'));
        const caption = clip.captions?.find((candidate) => !previous.has(candidate.id));
        // addCaption throws rather than declining quietly, so this is a real
        // invariant now and not a tolerated absence.
        if (!caption) throw new EditorAgentError('The caption was not created.', 'editor_error', { clipId: clip.id });
        if (operation.caption) {
          this.updateCaption(clip, caption, this.agentCaptionPatch(operation.caption, caption));
        }
        if (operation.duration !== undefined) {
          this.updateCaption(clip, caption, { durationSeconds: finiteNumber(operation.duration, 'duration'), durationAutomatic: false });
        }
        return { captionId: caption.id ?? null, clipId: clip.id };
      }
      case 'update_caption': {
        const clip = this.agentMediaClip(operation.clipId);
        const caption = clip.captions?.find((candidate) => candidate.id === operation.captionId);
        if (!caption) throw new EditorAgentError(`Caption "${operation.captionId}" was not found.`, 'not_found');
        this.updateCaption(clip, caption, this.agentCaptionPatch(operation.caption, caption));
        return;
      }
      case 'remove_caption': {
        const clip = this.agentMediaClip(operation.clipId);
        const caption = clip.captions?.find((candidate) => candidate.id === operation.captionId);
        if (!caption) throw new EditorAgentError(`Caption "${operation.captionId}" was not found.`, 'not_found');
        this.removeCaption(clip, caption);
        return;
      }
      case 'set_tag': {
        const clip = this.agentClip(operation.clipId);
        if (!isPlayable(clip)) throw new EditorAgentError('A transition cannot carry a tag.', 'invalid_target');
        const patch = operation.tag ?? {};
        const tag = clampTag({ ...(clip.tag ?? this.project.defaultTag), ...patch } as ClipTag);
        if (!tag.text.trim()) throw new EditorAgentError('A tag must have visible text.', 'invalid_arguments');
        if (shapeIsQr(tag.shape)) {
          const error = qrTagError(tag.qrText ?? '');
          if (error) throw new EditorAgentError(error, 'invalid_qr');
        }
        tag.holdSeconds = patch['holdSeconds'] === undefined && tag.holdAuto ? holdFromText(tag.text) : tag.holdSeconds;
        clip.tag = tag;
        this.touch();
        return;
      }
      case 'remove_tag': {
        const clip = this.agentClip(operation.clipId);
        if (!isPlayable(clip)) throw new EditorAgentError('A transition cannot carry a tag.', 'invalid_target');
        clip.tag = null;
        this.touch();
        return;
      }
      case 'add_zoom': {
        const clip = this.agentMediaClip(operation.clipId);
        const bounds = clipBounds(clip);
        if (operation.start < bounds.start || operation.end > bounds.end) {
          throw new EditorAgentError(`Zoom must be inside ${bounds.start.toFixed(3)}..${bounds.end.toFixed(3)}.`, 'invalid_range');
        }
        const zoom = clampManualZoom({
          id: `zoom-${this.nextId++}`,
          start: finiteNumber(operation.start, 'start'),
          end: finiteNumber(operation.end, 'end'),
          scalePercent: operation.scalePercent ?? MANUAL_ZOOM_LIMITS.scalePercent.default,
          rampSeconds: operation.rampSeconds ?? MANUAL_ZOOM_LIMITS.rampSeconds.default,
          easeOut: operation.easeOut ?? true
        }, sourceDuration(clip));
        if (zoom.end - zoom.start < 0.05) throw new EditorAgentError('A zoom must have a visible duration.', 'invalid_range');
        clip.manualZooms = [...(clip.manualZooms ?? []), zoom].sort((a, b) => a.start - b.start);
        this.touch();
        // add_push_in delegates here, so a push-in is named by the same line.
        return { zoomId: zoom.id, pushInId: zoom.id, clipId: clip.id };
      }
      case 'add_push_in': {
        return this.agentApplyOperation({
          type: 'add_zoom',
          clipId: operation.clipId,
          start: operation.start,
          end: operation.end,
          scalePercent: operation.scalePercent,
          rampSeconds: operation.rampSeconds,
          easeOut: operation.easeOut
        });
      }
      case 'update_zoom': {
        const clip = this.agentMediaClip(operation.clipId);
        const index = (clip.manualZooms ?? []).findIndex((zoom) => zoom.id === operation.zoomId);
        if (index < 0) throw new EditorAgentError(`Zoom "${operation.zoomId}" was not found.`, 'not_found');
        const current = clip.manualZooms![index];
        const next = clampManualZoom({ ...current, ...operation.zoom, id: current.id } as ManualZoom, sourceDuration(clip));
        clip.manualZooms = clip.manualZooms!.map((zoom, at) => at === index ? next : zoom).sort((a, b) => a.start - b.start);
        this.touch();
        return;
      }
      case 'update_push_in': {
        return this.agentApplyOperation({
          type: 'update_zoom', clipId: operation.clipId, zoomId: operation.pushInId, zoom: operation.pushIn
        });
      }
      case 'remove_zoom': {
        const clip = this.agentMediaClip(operation.clipId);
        const before = clip.manualZooms?.length ?? 0;
        clip.manualZooms = (clip.manualZooms ?? []).filter((zoom) => zoom.id !== operation.zoomId);
        if (clip.manualZooms.length === before) throw new EditorAgentError(`Zoom "${operation.zoomId}" was not found.`, 'not_found');
        this.touch();
        return;
      }
      case 'remove_push_in': {
        return this.agentApplyOperation({
          type: 'remove_zoom', clipId: operation.clipId, zoomId: operation.pushInId
        });
      }
      case 'set_project_settings': {
        this.agentSetProjectSettings(operation.settings);
        return;
      }
      default:
        throw new EditorAgentError(
          `Unknown edit operation "${String((operation as { type?: unknown }).type)}".`,
          'unknown_operation'
        );
    }
  }

  private agentTextDraft(
    current: TextClip['draft'],
    text: string | undefined,
    patch: Record<string, unknown> | undefined,
    durationSeconds: number | undefined
  ): TextClip['draft'] {
    const source = patch ?? {};
    const next = { ...current };
    if (text !== undefined) {
      if (typeof text !== 'string' || !text.trim()) throw new EditorAgentError('A text card must contain text.', 'invalid_arguments');
      next.text = text.slice(0, 4000);
    }

    const stringChoice = <T extends string>(key: string, allowed: readonly T[], value: T) => {
      if (source[key] === undefined) return value;
      if (typeof source[key] !== 'string' || !allowed.includes(source[key] as T)) {
        throw new EditorAgentError(`Invalid text-card ${key}.`, 'invalid_arguments');
      }
      return source[key] as T;
    };
    const colour = (key: string, value: string) => {
      if (source[key] === undefined) return value;
      if (typeof source[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(source[key] as string)) {
        throw new EditorAgentError(`${key} must be a six-digit hex colour.`, 'invalid_arguments');
      }
      return source[key] as string;
    };
    const number = (key: string, value: number, limits?: { min: number; max: number }) => {
      if (source[key] === undefined) return value;
      const parsed = finiteNumber(source[key], key);
      return limits ? Math.max(limits.min, Math.min(limits.max, parsed)) : parsed;
    };

    if (source['text'] !== undefined) {
      if (typeof source['text'] !== 'string' || !(source['text'] as string).trim()) {
        throw new EditorAgentError('A text card must contain text.', 'invalid_arguments');
      }
      next.text = (source['text'] as string).slice(0, 4000);
    }
    next.fontId = stringChoice('fontId', FONTS.map((item) => item.id), next.fontId);
    next.align = stringChoice('align', ['left', 'center', 'right'] as const, next.align);
    next.vertical = stringChoice('vertical', ['top', 'middle', 'bottom'] as const, next.vertical);
    next.legibility = stringChoice('legibility', LEGIBILITY_OPTIONS.map((item) => item.id), next.legibility);
    next.animation = stringChoice('animation', ANIMATIONS.map((item) => item.id), next.animation);
    next.color = colour('color', next.color);
    next.backgroundColor = colour('backgroundColor', next.backgroundColor);
    next.fontScale = number('fontScale', next.fontScale, TEXT_LIMITS.fontScale);
    next.margin = number('margin', next.margin, TEXT_LIMITS.margin);
    next.lineHeight = number('lineHeight', next.lineHeight, TEXT_LIMITS.lineHeight);
    next.letterSpacing = number('letterSpacing', next.letterSpacing, TEXT_LIMITS.letterSpacing);
    next.revealSeconds = number('revealSeconds', next.revealSeconds, TEXT_LIMITS.reveal);
    next.holdSeconds = number('holdSeconds', next.holdSeconds, TEXT_LIMITS.hold);
    if (source['fontWeight'] !== undefined) {
      const weight = finiteNumber(source['fontWeight'], 'fontWeight');
      if (!WEIGHTS.some((item) => item.value === weight)) throw new EditorAgentError('Unsupported text-card fontWeight.', 'invalid_arguments');
      next.fontWeight = weight;
    }
    if (source['holdAuto'] !== undefined) next.holdAuto = Boolean(source['holdAuto']);

    const textChanged = text !== undefined || source['text'] !== undefined;
    if (textChanged && next.holdAuto !== false && source['holdSeconds'] === undefined && durationSeconds === undefined) {
      next.holdSeconds = Math.round(readingSeconds(next.text) * 10) / 10;
    }
    if (durationSeconds !== undefined) {
      const duration = finiteNumber(durationSeconds, 'durationSeconds');
      if (duration < 0.2 || duration > 120) throw new EditorAgentError('durationSeconds must be between 0.2 and 120.', 'invalid_arguments');
      next.revealSeconds = Math.min(next.revealSeconds, duration);
      next.holdSeconds = Math.max(0, duration - next.revealSeconds);
      next.holdAuto = false;
    }
    if (!next.text.trim()) throw new EditorAgentError('A text card must contain text.', 'invalid_arguments');
    return next;
  }

  private agentTransitionSettings(current: TransitionSettings, patch: Record<string, unknown> | undefined): TransitionSettings {
    const source = patch ?? {};
    const kind = source['kind'] ?? current.kind;
    if (typeof kind !== 'string' || !TRANSITIONS.some((item) => item.id === kind)) {
      throw new EditorAgentError('Unknown transition kind.', 'invalid_arguments');
    }
    const seconds = source['seconds'] === undefined ? current.seconds : finiteNumber(source['seconds'], 'seconds');
    const colour = source['colour'] ?? current.colour;
    if (typeof colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(colour)) {
      throw new EditorAgentError('Transition colour must be a six-digit hex colour.', 'invalid_arguments');
    }
    return {
      kind: kind as TransitionSettings['kind'],
      seconds: Math.max(TRANSITION_SECONDS.min, Math.min(TRANSITION_SECONDS.max, seconds)),
      colour
    };
  }

  private agentClipEdits(current: ClipEdits, patch: Record<string, unknown>): ClipEdits {
    if (!patch || typeof patch !== 'object') throw new EditorAgentError('edits must be an object.', 'invalid_arguments');
    const next = cloneEdits(current);
    if (patch['cutSilence'] !== undefined) next.cutSilence = Boolean(patch['cutSilence']);
    if (patch['fadeIn'] !== undefined) next.fadeIn = Boolean(patch['fadeIn']);
    if (patch['fadeOut'] !== undefined) next.fadeOut = Boolean(patch['fadeOut']);
    if (patch['fadeSeconds'] !== undefined) {
      const value = finiteNumber(patch['fadeSeconds'], 'fadeSeconds');
      next.fadeSeconds = Math.max(FADE_SECONDS.min, Math.min(FADE_SECONDS.max, value));
    }
    if (patch['speed'] !== undefined) next.speed = clampSpeed(finiteNumber(patch['speed'], 'speed'));
    if (patch['volumePercent'] !== undefined) next.volumePercent = clampVolume(finiteNumber(patch['volumePercent'], 'volumePercent'));
    if (patch['audioMode'] !== undefined) {
      if (!['original', 'replace', 'continue', 'mute'].includes(String(patch['audioMode']))) {
        throw new EditorAgentError('Unknown audio mode.', 'invalid_arguments');
      }
      next.audioMode = patch['audioMode'] as ClipAudioMode;
    }
    if (patch['silence'] !== undefined) {
      if (!patch['silence'] || typeof patch['silence'] !== 'object') throw new EditorAgentError('silence must be an object.', 'invalid_arguments');
      const silence = patch['silence'] as Record<string, unknown>;
      if (silence['channelMode'] !== undefined && !['combined', 'any', 'all'].includes(String(silence['channelMode']))) {
        throw new EditorAgentError('Unknown silence channelMode.', 'invalid_arguments');
      }
      const merged = {
        ...next.silence,
        ...silence,
        autoZoom: silence['autoZoom'] && typeof silence['autoZoom'] === 'object'
          ? clampAutoZoom({ ...next.silence.autoZoom, ...(silence['autoZoom'] as object) })
          : next.silence.autoZoom
      };
      next.silence = clampSilenceSettings(merged as ClipEdits['silence']);
    }
    return next;
  }

  private agentCaptionPatch(patch: Record<string, unknown>, current?: ClipCaption): Partial<ClipCaption> {
    if (!patch || typeof patch !== 'object') throw new EditorAgentError('caption must be an object.', 'invalid_arguments');
    const result: Partial<ClipCaption> = {};
    if (patch['style'] !== undefined && !['classic', 'behind-subject'].includes(String(patch['style']))) {
      throw new EditorAgentError('Unknown caption style.', 'invalid_arguments');
    }
    const requestedPreset = patch['stylePreset'] !== undefined
      ? String(patch['stylePreset'])
      : patch['style'] !== undefined && patch['style'] !== current?.style ? String(patch['style']) : null;
    const requestedBackground = requestedPreset ? captionPresetIsBackground(requestedPreset) : false;
    if (requestedPreset && patch['style'] !== undefined &&
        requestedBackground !== (patch['style'] === 'behind-subject')) {
      throw new EditorAgentError('Caption style and stylePreset conflict.', 'invalid_arguments');
    }
    const behindSubject = requestedBackground ||
      (!requestedPreset &&
        Boolean(current && isBackgroundCaption(current)));
    if (requestedPreset) {
      const preset = captionPresetPatch(current ?? DEFAULT_CAPTION, requestedPreset);
      if (!preset) throw new EditorAgentError('Unknown caption stylePreset.', 'invalid_arguments');
      Object.assign(result, preset);
    }
    if (patch['text'] !== undefined) result.text = stringValue(patch['text'], 'text').slice(0, 1000);
    if (patch['startSeconds'] !== undefined) result.startSeconds = finiteNumber(patch['startSeconds'], 'startSeconds');
    if (patch['durationSeconds'] !== undefined) {
      result.durationSeconds = finiteNumber(patch['durationSeconds'], 'durationSeconds');
      result.durationAutomatic = false;
    }
    if (patch['fontFamily'] !== undefined) {
      const font = String(patch['fontFamily']);
      if (!CAPTION_FONTS.some((item) => item.value === font)) throw new EditorAgentError('Unknown caption fontFamily.', 'invalid_arguments');
      result.fontFamily = font as NonNullable<ClipCaption['fontFamily']>;
    }
    if (patch['fontWeight'] !== undefined) result.fontWeight = Math.max(100, Math.min(900, finiteNumber(patch['fontWeight'], 'fontWeight')));
    if (patch['italic'] !== undefined) result.italic = Boolean(patch['italic']);
    if (patch['fadeIn'] !== undefined) result.fadeIn = Boolean(patch['fadeIn']);
    if (patch['fadeOut'] !== undefined) result.fadeOut = Boolean(patch['fadeOut']);
    if (patch['shadowEnabled'] !== undefined) result.shadowEnabled = Boolean(patch['shadowEnabled']);
    if (patch['uppercase'] !== undefined) result.uppercase = Boolean(patch['uppercase']);
    if (patch['animation'] !== undefined) {
      const animation = String(patch['animation']);
      if (!CAPTION_ANIMATIONS.some((item) => item.value === animation)) {
        throw new EditorAgentError('Unknown caption animation.', 'invalid_arguments');
      }
      result.animation = animation as NonNullable<ClipCaption['animation']>;
    }
    for (const key of ['textColor', 'outlineColor', 'shadowColor'] as const) {
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(patch[key] as string)) {
          throw new EditorAgentError(`${key} must be a six-digit hex colour.`, 'invalid_arguments');
        }
        result[key] = patch[key] as string;
      }
    }
    for (const key of ['fontScale', 'bottomMargin', 'outlinePercent', 'fadeSeconds', 'positionX', 'positionY',
      'rotationDegrees', 'shadowBlurPercent', 'shadowOpacity'] as const) {
      if (patch[key] !== undefined) {
        const limits = key === 'fontScale'
          ? behindSubject ? { min: 0.2, max: 0.4 } : { min: 0.02, max: 0.12 }
          : CAPTION_LIMITS[key];
        result[key] = Math.max(limits.min, Math.min(limits.max, finiteNumber(patch[key], key)));
      }
    }
    if (!requestedPreset) {
      const visualChange = Object.keys(result).some((key) => !['text', 'startSeconds', 'durationSeconds', 'durationAutomatic', 'fadeIn', 'fadeOut', 'fadeSeconds'].includes(key));
      if (visualChange) result.stylePreset = behindSubject ? 'custom-background' : 'custom';
    }
    return result;
  }

  private agentSetProjectSettings(patch: EditorAgentProjectPatch): void {
    if (!patch || typeof patch !== 'object') throw new EditorAgentError('settings must be an object.', 'invalid_arguments');
    const previousEdits = this.project.edits;
    const next = { ...this.project };
    if (patch.aspect !== undefined) {
      if (!ASPECTS.some((item) => item.value === patch.aspect)) throw new EditorAgentError('Unknown project aspect.', 'invalid_arguments');
      next.aspect = patch.aspect;
    }
    if (patch.reframe !== undefined) {
      if (!REFRAME_FITS.some((item) => item.value === patch.reframe)) throw new EditorAgentError('Unknown reframe mode.', 'invalid_arguments');
      next.reframe = patch.reframe;
    }
    if (patch.resolution !== undefined) {
      if (patch.resolution !== 'auto' && !RESOLUTIONS.some((item) => item.value === patch.resolution)) {
        throw new EditorAgentError('Unknown output resolution.', 'invalid_arguments');
      }
      next.resolution = patch.resolution as ResolutionPreset;
    }
    if (patch.videoFormatId !== undefined) {
      if (!VIDEO_FORMATS.some((item) => item.id === patch.videoFormatId)) throw new EditorAgentError('Unknown video format.', 'invalid_arguments');
      next.videoFormatId = patch.videoFormatId;
    }
    if (patch.audioFormatId !== undefined) {
      if (!AUDIO_FORMATS.some((item) => item.id === patch.audioFormatId)) throw new EditorAgentError('Unknown audio format.', 'invalid_arguments');
      next.audioFormatId = patch.audioFormatId;
    }
    if (patch.timelapseTargetSeconds !== undefined) next.timelapseTargetSeconds = clampTimelapseTarget(patch.timelapseTargetSeconds);
    if (patch.silentCutReplacementThreshold !== undefined) {
      next.silentCutReplacementThreshold = clampSilentCutReplacementThreshold(patch.silentCutReplacementThreshold);
    }
    if (patch.soundFade !== undefined) next.soundFade = clampSoundFade({ ...next.soundFade, ...patch.soundFade });
    if (patch.loudness !== undefined) next.loudness = clampLoudness({ ...next.loudness, ...patch.loudness } as LoudnessSettings);
    if (patch.edits !== undefined) next.edits = this.agentClipEdits(next.edits, patch.edits);
    if (patch.defaultTransition !== undefined) {
      next.defaultTransition = patch.defaultTransition === null
        ? null
        : this.agentTransitionSettings(next.defaultTransition ?? DEFAULT_TRANSITION, patch.defaultTransition);
    }
    if (patch.defaultTag !== undefined) {
      next.defaultTag = clampTag({ ...next.defaultTag, ...patch.defaultTag } as ClipTag);
      if (shapeIsQr(next.defaultTag.shape)) {
        const error = qrTagError(next.defaultTag.qrText ?? '');
        if (error) throw new EditorAgentError(error, 'invalid_qr');
      }
    }
    this.project = next;
    if (detectionSettingsChanged(previousEdits.silence, next.edits.silence)) this.invalidateAnalyses();
    this.applyTimelapseTarget();
    this.touch();
  }

  private agentNoiseSettings(args: Record<string, unknown>, current: ClipNoiseSettings, enabled: boolean): ClipNoiseSettings {
    const engine = args['engine'] ?? current.engine;
    const strength = args['strength'] ?? current.strength;
    if (engine !== 'gtcrn' && engine !== 'rnnoise') {
      throw new EditorAgentError('Noise engine must be gtcrn or rnnoise.', 'invalid_arguments');
    }
    if (strength !== 'gentle' && strength !== 'balanced' && strength !== 'maximum') {
      throw new EditorAgentError('Noise strength must be gentle, balanced or maximum.', 'invalid_arguments');
    }
    return clampClipNoise({
      enabled,
      engine,
      strength,
      preserveHighs: args['preserveHighs'] === undefined ? current.preserveHighs : Boolean(args['preserveHighs'])
    });
  }

  private agentAssertRevision(args: Record<string, unknown>): void {
    if (args['expectedRevision'] === undefined) return;
    const expected = finiteNumber(args['expectedRevision'], 'expectedRevision');
    if (expected !== this.revision) {
      throw new EditorAgentError(
        `Project revision ${expected} is stale; the current revision is ${this.revision}.`,
        'revision_conflict',
        {
          expectedRevision: expected, actualRevision: this.revision,
          changedBy: this.lastRevisionReason, changedAt: this.lastRevisionAt,
          nextStep: 'Call get_project and retry with its current projectRevision.'
        }
      );
    }
  }

  private async agentAnalyzeNoise(args: Record<string, unknown>, signal: AbortSignal, operationId = ''): Promise<unknown> {
    const content = args['content'] === 'speech-music' ? 'speech-music' : 'speech';
    const sensitivity = args['sensitivity'] === 'low' || args['sensitivity'] === 'high'
      ? args['sensitivity']
      : 'balanced';
    const settings: AnalysisSettings = { content, sensitivity, background: null, cleanVoice: null };
    const targets = args['clipId']
      ? [this.agentMediaClip(args['clipId'])]
      : this.clips.filter((clip): clip is MediaClip =>
          isMediaClip(clip) && !clip.awaitingFile && clip.summary.audioUsable && clip.summary.kind !== 'image');
    const results: unknown[] = [];
    for (const [index, clip] of targets.entries()) {
      if (signal.aborted) throw new EditorAgentError('Noise analysis was cancelled.', 'cancelled', { stage: 'noise-analysis' });
      this.pushAgentLog('action', `Understanding noise in ${clip.summary.fileName}`, 'analyze_noise', 'DEBUG');
      const report = await this.runNoiseAnalysis(clip, settings, signal, operationId);
      this.noiseProgress.delete(clip.id);
      results.push({
        clipId: clip.id,
        source: clip.summary.fileName,
        ...report,
        suppressionRecommended: report.status === 'Probable noise' || report.status === 'Relevant noise',
        suppressionEnabled: this.noiseSettingsFor(clip).enabled
      });
      this.desktop.reportAgentProgress({
        operationId, state: 'processing', stage: 'noise-analysis',
        percent: Math.round((index + 1) * 100 / Math.max(1, targets.length)),
        clipIndex: index + 1, clipCount: targets.length, clipId: clip.id, clipName: clip.summary.fileName
      });
    }
    return {
      clips: results,
      analyzed: results.length,
      note: 'Analysis did not enable or apply noise suppression. Removal requires an explicit suppress_noise or set_noise_suppression command.'
    };
  }

  private async agentSuppressNoise(args: Record<string, unknown>, signal: AbortSignal, operationId = ''): Promise<unknown> {
    this.agentAssertRevision(args);
    const clip = this.agentMediaClip(args['clipId']);
    if (!clip.summary.audioUsable || clip.summary.kind === 'image') {
      throw new EditorAgentError('This media container has no decodable audio to suppress.', 'media_unavailable');
    }
    const settings = this.agentNoiseSettings(args, this.noiseSettingsFor(clip), true);
    await this.runNoiseSuppression(clip, settings, signal, operationId);
    if (signal.aborted) throw new EditorAgentError('Noise suppression was cancelled.', 'cancelled', { stage: 'noise-suppression' });
    clip.noiseSuppression = settings;
    this.noiseProgress.delete(clip.id);
    this.touch();
    return {
      clipId: clip.id,
      source: clip.summary.fileName,
      settings,
      previewReady: this.noiseReady(clip),
      quietRegionChangeDb: clip.noiseReductionDb ?? null,
      scheduledForExport: true
    };
  }

  private async agentAnalyzeSilence(args: Record<string, unknown>, signal?: AbortSignal, operationId = ''): Promise<unknown> {
    const targets = args['clipId'] ? [this.agentMediaClip(args['clipId'])] : this.clips.filter(isMediaClip);
    const revisionBefore = this.revision;
    this.pushAgentLog('action', `Analyzing ${targets.length} clip(s) with ${this.analysisLanes} bounded worker lane(s)`, 'analyze_silence', 'DEBUG');
    this.clearMessages();
    const cancel = () => this.cancelAnalyses();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (operationId) this.desktop.reportAgentProgress({ operationId, state: 'processing', stage: 'decoding-and-detecting-silence', percent: null });
      await this.waitForAutomaticListening();
      if (signal?.aborted) throw new EditorAgentError('Silence analysis was cancelled.', 'cancelled', { stage: 'audio-analysis' });
      const pending = targets.filter((clip) => !clip.analysis || this.isStale(clip));
      await this.analyzeMany(pending);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    if (signal?.aborted) throw new EditorAgentError('Silence analysis was cancelled.', 'cancelled', { stage: 'audio-analysis' });
    if (this.errorMessage) {
      throw new EditorAgentError(`Silence analysis failed: ${this.errorMessage}`, 'analysis_failed', {
        stage: 'audio-analysis', hint: this.errorHint, clipIds: targets.map((clip) => clip.id)
      });
    }
    const includeWaveform = args['includeWaveform'] === true;
    const offset = Math.max(0, Math.trunc(Number(args['waveformOffset']) || 0));
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(args['waveformLimit']) || 250)));
    return targets.map((clip) => ({
      clipId: clip.id,
      sourceDuration: clip.summary.durationSeconds,
      silenceRanges: clip.detected,
      waveform: clip.analysis ? {
        duration: clip.analysis.waveform.duration,
        secondsPerBucket: clip.analysis.waveform.secondsPerBucket,
        bucketCount: clip.analysis.waveform.rms.length,
        paginated: true,
        ...(includeWaveform ? this.agentWaveformValues(clip, offset, limit) : {})
      } : null
    })).map((result) => ({ ...result, revisionBefore, projectRevision: this.revision, mutatesProject: this.revision !== revisionBefore }));
  }

  private agentWaveformPage(args: Record<string, unknown>): unknown {
    const clip = this.agentMediaClip(args['clipId']);
    if (!clip.analysis) throw new EditorAgentError('Analyze silence before requesting waveform pages.', 'analysis_required');
    const offset = Math.max(0, Math.trunc(Number(args['offset']) || 0));
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(args['limit']) || 250)));
    return {
      clipId: clip.id,
      duration: clip.analysis.waveform.duration,
      secondsPerBucket: clip.analysis.waveform.secondsPerBucket,
      ...this.agentWaveformValues(clip, offset, limit)
    };
  }

  private agentWaveformValues(clip: MediaClip, offset: number, limit: number): Record<string, unknown> {
    const waveform = clip.analysis!.waveform;
    const end = Math.min(waveform.rms.length, offset + limit);
    return {
      offset,
      limit,
      returned: Math.max(0, end - offset),
      total: waveform.rms.length,
      nextOffset: end < waveform.rms.length ? end : null,
      min: Array.from(waveform.min.slice(offset, end)),
      max: Array.from(waveform.max.slice(offset, end)),
      rms: Array.from(waveform.rms.slice(offset, end))
    };
  }

  private async agentTranscribe(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const task = this.agentTranscriptionQueue.catch(() => undefined).then(() => {
      if (signal?.aborted) throw new TranscriptionCanceled();
      return this.agentTranscribeNow(args, signal);
    });
    this.agentTranscriptionQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async agentTranscribeNow(args: Record<string, unknown>, outerSignal?: AbortSignal): Promise<unknown> {
    const clip = this.agentMediaClip(args['clipId']);
    if (!clip.summary.audioUsable) throw new EditorAgentError('This clip has no decodable audio.', 'media_unavailable');
    if (typeof args['model'] === 'string') {
      const modelId = resolveTranscriptionModel(args['model']);
      if (!SPEECH_MODELS.some((model) => model.id === modelId)) {
        throw new EditorAgentError(`Unknown transcription model "${args['model']}".`, 'invalid_model', {
          acceptedAliases: Object.keys(TRANSCRIPTION_MODEL_ALIASES), validModels: SPEECH_MODELS.map((model) => model.id)
        });
      }
      this.transcriptModelId = modelId;
    }
    if (typeof args['language'] === 'string') {
      const languageCode = resolveTranscriptionLanguage(args['language']);
      if (!SPEECH_LANGUAGES.some((language) => language.code === languageCode)) {
        throw new EditorAgentError(`Unknown transcription language "${args['language']}".`, 'invalid_language', {
          acceptedAliases: Object.keys(TRANSCRIPTION_LANGUAGE_ALIASES), validLanguages: SPEECH_LANGUAGES.map((language) => language.code || 'auto')
        });
      }
      this.transcriptLanguage = languageCode;
    }
    if (args['denoise'] !== undefined) this.transcriptDenoise = Boolean(args['denoise']);
    if (args['noiseEngine'] !== undefined) {
      if (!NOISE_ENGINES.some((engine) => engine.id === args['noiseEngine'])) {
        throw new EditorAgentError('Unknown transcription noise engine.', 'invalid_arguments');
      }
      this.transcriptEngine = args['noiseEngine'] as EngineId;
    }
    if (args['noiseStrength'] !== undefined) {
      const strength = String(args['noiseStrength']).toLowerCase();
      const index = NOISE_STRENGTHS.findIndex((item) => item.label.toLowerCase() === strength);
      if (index < 0) throw new EditorAgentError('noiseStrength must be gentle, balanced or maximum.', 'invalid_arguments');
      this.transcriptStrengthIndex = index;
    }
    if (this.transcriptDenoise) {
      this.pushAgentLog('action', `Removing noise from ${clip.summary.fileName} for speech analysis`, 'transcribe', 'INFO');
      await this.paintAgentProgress();
    }
    const entry = this.plan.clips.find((candidate) => candidate.clip.id === clip.id);
    if (!entry) throw new EditorAgentError('The clip is not present in the playable timeline.', 'not_found');
    const fullEntry = { ...entry, keepRanges: [{ start: 0, end: clip.summary.durationSeconds }] };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    outerSignal?.addEventListener('abort', cancel, { once: true });
    const timeoutMs = Math.max(1000, Math.min(3_600_000, Number(args['timeoutMs']) || 15 * 60_000));
    const stageTimeoutMs = Math.max(1000, Math.min(3_600_000, Number(args['stageTimeoutMs']) || 5 * 60_000));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let stageTimedOut = false;
    let timedOutStage = 'starting';
    let stageTimer: ReturnType<typeof setTimeout> | undefined;
    const armStageTimeout = (stage: string): void => {
      if (stageTimer) clearTimeout(stageTimer);
      timedOutStage = stage;
      stageTimer = setTimeout(() => { stageTimedOut = true; controller.abort(); }, stageTimeoutMs);
    };
    this.agentTranscriptStageTimeout = armStageTimeout;
    armStageTimeout('starting');
    this.lastAgentTranscriptStage = '';
    let words: Cue[];
    try {
      words = await this.wordsFor(clip, fullEntry, controller.signal);
    } catch (error) {
      if (stageTimedOut) {
        throw new TranscriptionError(
          `Transcription stage "${timedOutStage}" timed out after ${stageTimeoutMs} ms.`,
          'Increase stageTimeoutMs, use a smaller model, or check decoder/model availability.',
          { code: 'transcription_stage_timeout', stage: timedOutStage, details: { stageTimeoutMs }, cause: error }
        );
      }
      if (timedOut) {
        throw new TranscriptionError(
          `Transcription timed out after ${timeoutMs} ms during ${this.transcriptStage || 'audio preparation'}.`,
          'Increase timeoutMs or use a smaller model/shorter clip.',
          { code: 'transcription_timeout', stage: this.transcriptStage || 'audio-preparation', cause: error }
        );
      }
      if (outerSignal?.aborted || controller.signal.aborted) throw new TranscriptionCanceled();
      throw error;
    } finally {
      clearTimeout(timer);
      if (stageTimer) clearTimeout(stageTimer);
      if (this.agentTranscriptStageTimeout === armStageTimeout) this.agentTranscriptStageTimeout = undefined;
      outerSignal?.removeEventListener('abort', cancel);
    }
    return {
      clipId: clip.id,
      assetId: this.agentAssetId(clip),
      timeSpace: 'source',
      language: this.transcriptLanguage || 'auto',
      model: this.transcriptModelId,
      words,
      quality: {
        wordCount: words.length,
        wordsPerMinute: clip.summary.durationSeconds > 0 ? Math.round(words.length * 60 / clip.summary.durationSeconds) : 0,
        reviewRecommended: words.length === 0 || (clip.summary.durationSeconds > 20 && words.length < 4),
        fallbackModel: 'onnx-community/whisper-large-v3-turbo_timestamped'
      },
      segments: groupWords(words, DEFAULT_SHAPE.lineLength, DEFAULT_SHAPE.maxLines, DEFAULT_SHAPE.maxSeconds),
      outputWords: placeWords(words, entry)
    };
  }

  private async agentContactSheet(
    args: Record<string, unknown>, signal?: AbortSignal, operationId = ''
  ): Promise<unknown> {
    const clip = this.agentMediaClip(args['clipId']);
    const start = args['start'] === undefined ? clip.inPoint ?? 0 : finiteNumber(args['start'], 'start');
    const end = args['end'] === undefined ? clip.outPoint ?? clip.summary.durationSeconds : finiteNumber(args['end'], 'end');
    const interval = Math.max(0.25, args['interval'] === undefined ? 5 : finiteNumber(args['interval'], 'interval'));
    if (end <= start) throw new EditorAgentError('end must be greater than start.', 'invalid_range');
    const timestamps: number[] = [];
    for (let at = start; at <= end && timestamps.length < 48; at += interval) timestamps.push(at);
    if (!timestamps.length || timestamps[timestamps.length - 1] < end - 0.05) timestamps.push(end);
    return this.agentFrames({
      clipId: clip.id,
      timestamps,
      width: args['width'] === undefined ? 480 : finiteNumber(args['width'], 'width'),
      quality: args['quality'] === undefined ? 0.72 : finiteNumber(args['quality'], 'quality')
    }, signal, operationId);
  }

  private async agentFrames(
    request: EditorAgentFrameRequest, signal?: AbortSignal, operationId = ''
  ): Promise<unknown> {
    const clip = this.agentMediaClip(request.clipId);
    if (!clip.summary.videoUsable && clip.summary.kind !== 'image') {
      throw new EditorAgentError('This clip has no decodable picture.', 'media_unavailable');
    }
    if (!Array.isArray(request.timestamps) || !request.timestamps.length || request.timestamps.length > 64) {
      throw new EditorAgentError('timestamps must contain between 1 and 64 source times.', 'invalid_arguments');
    }
    const width = Math.round(Math.max(96, Math.min(1280, request.width ?? 640)));
    const quality = Math.max(0.25, Math.min(0.95, request.quality ?? 0.78));
    if (request.composited) {
      return await this.captureComposedFrames(clip, request.timestamps, width, quality, signal, operationId);
    }
    const frames = await this.captureAgentFrames(clip, request.timestamps, width, quality, signal, operationId);
    return { clipId: clip.id, assetId: this.agentAssetId(clip), timeSpace: 'source', frames, composited: false };
  }


  /**
   * The same frames, but as the export will actually write them.
   *
   * `captureAgentFrames` answers with the *source* picture: no zoom, no caption,
   * no effect, no placed picture. That is the right answer for understanding
   * what was filmed and the wrong one for checking what was made — a picture
   * placed half off the side of the frame looks perfect in a source frame,
   * because the source frame is not the frame it was placed on.
   *
   * So this goes through `composeFrame`, the one function the preview and the
   * encoder both draw with, at the plan's own aspect ratio and on the plan's own
   * clock. What comes back is the finished picture, and an agent that reads it
   * is looking at the export rather than at an approximation of it.
   */
  private async captureComposedFrames(
    clip: MediaClip,
    timestamps: readonly number[],
    width: number,
    quality: number,
    signal?: AbortSignal,
    operationId = ''
  ): Promise<unknown> {
    const cancelled = (stage: string) => new EditorAgentError(
      'Visual inspection was cancelled.', 'cancelled', { stage, terminalState: 'cancelled' }
    );
    const plan = this.plan;
    const entry = plan.clips.find(candidate => candidate.clip.id === clip.id);
    if (!entry) {
      throw new EditorAgentError(
        'This container contributes nothing to the finished timeline, so it has no composed frame.',
        'invalid_target'
      );
    }
    await loadPlanImages(plan);

    const height = Math.max(2, Math.round(width * plan.height / Math.max(1, plan.width)) & ~1);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d') as FrameContext | null;
    if (!context) throw new EditorAgentError('Canvas is unavailable.', 'unsupported');

    const edits = this.editsFor(clip);
    const speed = clampSpeed(edits.speed);
    const keep = keepRangesFor(clip, edits);
    const bounds = clipBounds(clip);
    const outputTimeOf = (sourceTime: number) =>
      entry.outputStart + cutTimeOf(keep, Math.max(bounds.start, Math.min(bounds.end, sourceTime))) / speed;

    // Only built when something actually sits in the middle layer at one of the
    // requested instants. Loading a segmentation model to check a logo in a
    // corner would be a slow answer to a question nobody asked.
    const needsSubject = timestamps.some(raw => {
      const time = outputTimeOf(finiteNumber(raw, 'timestamp'));
      const caption = captionAt(plan.captions, time);
      return (caption !== null && isBackgroundCaption(caption.caption)) ||
        imagesAt(plan.images ?? [], time).some(item => item.image.style === 'behind-subject');
    });
    const vision = needsSubject ? this.agentSubjectVision() : null;
    let subjectLayerDrawn = !needsSubject;
    let subjectNote = '';

    const drawSource = async (video: HTMLVideoElement | null, bitmap: ImageBitmap | null): Promise<FrameSource> => {
      if (bitmap) {
        return { width: bitmap.width, height: bitmap.height, draw: (target, x, y, w, h) => target.drawImage(bitmap, x, y, w, h) };
      }
      const element = video!;
      return {
        width: element.videoWidth || clip.summary.width || width,
        height: element.videoHeight || clip.summary.height || height,
        draw: (target, x, y, w, h) => target.drawImage(element, x, y, w, h)
      };
    };

    const video = clip.summary.kind === 'image' ? null : document.createElement('video');
    const bitmap = clip.summary.kind === 'image' ? await imageBitmapForFile(clip.file) : null;
    const url = video ? mediaObjectUrl(clip.file) : '';
    if (video) {
      video.muted = true;
      // Metadata, not the whole file. Frame grabbing needs the header and then
      // seeks; 'auto' asks the browser to buffer the entire clip, which on a 4K
      // source served over the local media server is gigabytes of reading
      // before the first frame can be drawn.
      video.preload = 'metadata';
      video.src = url;
    }

    try {
      // Metadata can sit at the end of the file — most camera MP4s are not
      // written for streaming — so a large source is read almost end to end
      // before the first frame exists. Sixty seconds is generous for a local
      // file and still finite.
      if (video) await this.waitAgentMedia(video, 'loadedmetadata', signal, 60000);
      const frames: unknown[] = [];

      for (let frameIndex = 0; frameIndex < timestamps.length; frameIndex++) {
        if (signal?.aborted) throw cancelled('composing-frames');
        const raw = finiteNumber(timestamps[frameIndex], 'timestamp');
        const duration = video ? (video.duration || clip.summary.durationSeconds) : clip.summary.durationSeconds;
        const timestamp = Math.max(0, Math.min(Math.max(0, duration - 0.001), raw));
        if (video && Math.abs(video.currentTime - timestamp) > 0.001) {
          video.currentTime = timestamp;
          await this.waitAgentMedia(video, 'seeked', signal);
        }
        const time = outputTimeOf(timestamp);
        const source = await drawSource(video, bitmap);

        let mask: SubjectMask | null = null;
        if (vision) {
          try {
            mask = await vision.maskFor(source, width, height, 1, plan.fillFrame, `${clip.id}:composed`, time);
            subjectLayerDrawn = subjectLayerDrawn || mask !== null;
          } catch (error) {
            // Said plainly rather than swallowed: a frame composed without the
            // matte is still worth looking at, but an agent must not read it as
            // proof that the person covers the middle layer.
            subjectNote = error instanceof Error ? error.message : String(error);
          }
          if (!mask && !subjectNote && vision.state === 'unavailable') {
            subjectNote = vision.lastError || 'Subject segmentation is unavailable on this machine.';
          }
        }

        composeFrame(context, plan, time, width, height, source, null, mask, null);
        frames.push({
          timestamp,
          outputTime: roundSeconds(time),
          width,
          height,
          mimeType: 'image/jpeg',
          dataUrl: canvas.toDataURL('image/jpeg', quality)
        });
        const done = Math.round((frameIndex + 1) * 100 / timestamps.length);
        if (operationId) this.desktop.reportAgentProgress({
          operationId, state: 'processing', stage: 'extracting-frames',
          percent: done, frameIndex: frameIndex + 1, frameCount: timestamps.length, clipId: clip.id
        });
        this.agentProgress(
          'get_frames',
          `Composed frame ${frameIndex + 1}/${timestamps.length} at ${this.formatTime(timestamp)}${mask ? ' with the subject matte' : ''}`,
          done
        );
      }

      return {
        clipId: clip.id,
        assetId: this.agentAssetId(clip),
        timeSpace: 'source',
        composited: true,
        frame: { width: plan.width, height: plan.height },
        subjectLayerRendered: subjectLayerDrawn,
        ...(subjectNote ? { subjectNote } : {}),
        images: (clip.images ?? []).map(image => this.agentImagePayload(clip, image)),
        frames
      };
    } finally {
      // Deliberately not disposed: it is the session's client, kept warm on
      // purpose. See `agentSubjectVision`.
      bitmap?.close();
      if (video) {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      }
    }
  }

  private async captureAgentFrames(
    clip: MediaClip,
    timestamps: readonly number[],
    width: number,
    quality: number,
    signal?: AbortSignal,
    operationId = ''
  ): Promise<unknown[]> {
    const cancelled = (stage: string) => new EditorAgentError(
      'Visual inspection was cancelled.', 'cancelled', { stage, terminalState: 'cancelled' }
    );
    if (signal?.aborted) throw cancelled('preparing-frames');
    const sourceWidth = Math.max(1, clip.summary.width ?? width);
    const sourceHeight = Math.max(1, clip.summary.height ?? Math.round(width * 9 / 16));
    const height = Math.max(1, Math.round(width * sourceHeight / sourceWidth));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new EditorAgentError('Canvas is unavailable.', 'unsupported');

    if (clip.summary.kind === 'image') {
      const bitmap = await imageBitmapForFile(clip.file);
      try {
        if (signal?.aborted) throw cancelled('decoding-image');
        context.drawImage(bitmap, 0, 0, width, height);
        if (operationId) this.desktop.reportAgentProgress({
          operationId, state: 'processing', stage: 'extracting-frames', percent: 100,
          frameIndex: 1, frameCount: 1, clipId: clip.id
        });
        return [{ timestamp: 0, width, height, mimeType: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', quality) }];
      } finally { bitmap.close(); }
    }

    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    const url = mediaObjectUrl(clip.file);
    video.src = url;
    try {
      await this.waitAgentMedia(video, 'loadedmetadata', signal, 60000);
      const result: unknown[] = [];
      for (let frameIndex = 0; frameIndex < timestamps.length; frameIndex++) {
        if (signal?.aborted) throw cancelled('extracting-frames');
        const raw = timestamps[frameIndex];
        const duration = video.duration || clip.summary.durationSeconds;
        const timestamp = Math.max(0, Math.min(Math.max(0, duration - 0.001), finiteNumber(raw, 'timestamp')));
        if (Math.abs(video.currentTime - timestamp) > 0.001) {
          video.currentTime = timestamp;
          await this.waitAgentMedia(video, 'seeked', signal);
        }
        context.drawImage(video, 0, 0, width, height);
        result.push({ timestamp, width, height, mimeType: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', quality) });
        const done = Math.round((frameIndex + 1) * 100 / timestamps.length);
        if (operationId) this.desktop.reportAgentProgress({
          operationId, state: 'processing', stage: 'extracting-frames',
          percent: done, frameIndex: frameIndex + 1, frameCount: timestamps.length, clipId: clip.id
        });
        this.agentProgress('get_frames', `Frame ${frameIndex + 1}/${timestamps.length} at ${this.formatTime(timestamp)}`, done);
      }
      return result;
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Waiting for a media element, and saying something useful when it never
   * arrives.
   *
   * "Timed out waiting for media loadedmetadata" named the symptom and nothing
   * else — not whether the browser was still fetching, not whether it had
   * decided the file was undecodable, not how much it had managed to read. All
   * of that is on the element, and all of it is what tells a stalled transfer
   * apart from a rejected codec.
   */
  private waitAgentMedia(media: HTMLMediaElement, event: string, signal?: AbortSignal, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new EditorAgentError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for media ${event}.`,
        'media_timeout',
        {
          event,
          waitedMs: timeoutMs,
          // 0 HAVE_NOTHING, 1 HAVE_METADATA, 2 HAVE_CURRENT_DATA, 3 HAVE_FUTURE_DATA, 4 HAVE_ENOUGH_DATA
          readyState: media.readyState,
          // 0 EMPTY, 1 IDLE, 2 LOADING, 3 NO_SOURCE. LOADING here means the
          // transfer stalled rather than the file being unreadable.
          networkState: media.networkState,
          mediaError: media.error ? { code: media.error.code, message: media.error.message } : null,
          bufferedSeconds: media.buffered.length ? media.buffered.end(media.buffered.length - 1) : 0,
          durationSeconds: Number.isFinite(media.duration) ? media.duration : null,
          source: (() => { try { return new URL(media.currentSrc || '').protocol; } catch { return null; } })()
        }
      )), timeoutMs);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        media.removeEventListener(event, ready);
        media.removeEventListener('error', failed);
        signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const failed = () => finish(new EditorAgentError('The video frame could not be decoded.', 'decode_failed'));
      const aborted = () => finish(new EditorAgentError(
        'Visual inspection was cancelled.', 'cancelled', { stage: `waiting-for-${event}`, terminalState: 'cancelled' }
      ));
      if (signal?.aborted) return aborted();
      media.addEventListener(event, ready, { once: true });
      media.addEventListener('error', failed, { once: true });
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  private async agentExport(
    args: Record<string, unknown>, signal?: AbortSignal, operationId = ''
  ): Promise<unknown> {
    const kind = args['kind'] === 'audio' ? 'audio' : 'video';
    const path = stringValue(args['path'], 'path');
    if (this.exporting) throw new EditorAgentError('An export is already running.', 'busy');
    this.exporting = kind;
    const renderSignal = signal ?? new AbortController().signal;
    let handle: Awaited<ReturnType<DesktopService['openAgentOutput']>> | null = null;
    try {
      // Keep opening the output inside the protected region. A denied or
      // invalid destination must release the editor's exporting state too.
      handle = await this.desktop.openAgentOutput(path);
      if (renderSignal.aborted) throw new EditorAgentError('Export was cancelled.', 'cancelled', { stage: 'preparing-export' });
      await this.runPendingAnalyses(renderSignal);
      await this.runPendingNoiseSuppressions(renderSignal);
      const plan = buildProjectPlan(this.clips, this.project, kind);
      const format = kind === 'video' ? this.videoFormat : this.audioFormat;
      let lastStage = '';
      const result = await this.renderer.render({
        plan,
        project: this.project,
        kind,
        format,
        envelopes: this.buildEnvelopes(),
        destination: {
          handle: handle as never,
          fileName: path.split(/[\\/]/).pop() ?? `edited.${format.extension}`,
          filePath: path
        },
        signal: renderSignal,
        onProgress: (progress) => {
          this.progress = progress;
          const percent = progress.ratio === null
            ? null
            : Math.max(0, Math.min(100, Math.round(progress.ratio * 100)));
          if (operationId) this.desktop.reportAgentProgress({
            operationId, state: 'processing', stage: `render-${progress.stage}`, percent,
            clipIndex: progress.clipIndex, clipCount: progress.clipCount, clipName: progress.clipName
          });
          if (progress.stage !== lastStage) {
            lastStage = progress.stage;
            this.agentProgressReset('export');
          }
          {
            const where = progress.clipCount
              ? ` — container ${progress.clipIndex}/${progress.clipCount}${progress.clipName ? ` (${progress.clipName})` : ''}`
              : '';
            this.agentProgress('export', `Rendering ${kind}: ${progress.stage}${where}`, percent);
          }
          this.cdr.markForCheck();
        }
      });
      return { path, kind, duration: result.plan.totalDuration, partial: result.partial };
    } catch (error) {
      await handle?.abort().catch(() => undefined);
      if (renderSignal.aborted) {
        throw new EditorAgentError('Export was cancelled and its partial output was removed.', 'cancelled', {
          stage: this.progress?.stage ? `render-${this.progress.stage}` : 'render', terminalState: 'cancelled', path
        });
      }
      // A look that could not be produced is reported as such, with its kind,
      // so an agent cannot record a finished edit for a file that is missing
      // what was asked for. The partial output was already discarded above, so
      // any earlier export at this path survives and the recovery checkpoint is
      // untouched.
      const failure = (error as { subjectFailure?: SubjectVisionFailure } | null)?.subjectFailure;
      if (failure) {
        throw new EditorAgentError(
          error instanceof Error ? error.message : String(error),
          SUBJECT_VISION_ERROR_CODE,
          { ...failure, recoverable: failure.retryable, terminalState: 'failed', path }
        );
      }
      throw error;
    } finally {
      this.exporting = null;
      this.progress = null;
      this.cdr.markForCheck();
    }
  }

  private snapshot(): EditorSnapshot {
    return {
      board: this.snapshotBoard(),
      nextId: this.nextId,
      clips: this.clips.map((clip) => this.snapshotClip(clip)),
      project: {
        ...this.project,
        edits: cloneEdits(this.project.edits),
        loudness: { ...this.project.loudness },
        soundFade: { ...this.project.soundFade },
        defaultTransition: this.project.defaultTransition ? { ...this.project.defaultTransition } : null,
        defaultAudio: this.project.defaultAudio ? { ...this.project.defaultAudio } : null
      }
    };
  }

  private snapshotClip(clip: EditorClip): EditorClip {
    if (isTransitionClip(clip)) return { ...clip, settings: { ...clip.settings } };

    if (isMediaClip(clip)) {
      return {
        ...clip,
        summary: { ...clip.summary },
        overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
        detected: clip.detected.map((range) => ({ ...range })),
        manualCuts: clip.manualCuts.map((range) => ({ ...range })),
        manualZooms: (clip.manualZooms ?? []).map((zoom) => ({ ...zoom })),
        caption: clip.caption ? { ...clip.caption } : null,
        captions: (clip.captions ?? []).map((caption) => ({ ...caption })),
        // Copied, not shared. Replacing a placement's file assigns to
        // `image.source` in place, and a snapshot holding the same object would
        // have its own past rewritten by that assignment.
        images: (clip.images ?? []).map((image) => ({ ...image, source: { ...image.source } })),
        tag: clip.tag ? { ...clip.tag } : null,
        replacementAudio: clip.replacementAudio ? { ...clip.replacementAudio } : null,
        noiseSuppression: clip.noiseSuppression ? { ...clip.noiseSuppression } : undefined,
        videoEffect: normalizeVideoEffect(clip.videoEffect),
        videoEffects: (clip.videoEffects ?? []).map(effect => ({ ...effect })),
        noiseReport: clip.noiseReport ? structuredClone(clip.noiseReport) : null,
        noiseAnalyzedWith: clip.noiseAnalyzedWith ? structuredClone(clip.noiseAnalyzedWith) : null,
        noiseCleanedWith: clip.noiseCleanedWith ? { ...clip.noiseCleanedWith } : null,
        // Not carried across. A removed clip has its preview URL revoked, and a
        // snapshot holding the revoked string would come back as a broken
        // picture; the dialog makes a new one the moment it is opened.
        previewUrl: null
      };
    }

    return {
      ...clip,
      draft: { ...clip.draft },
      tag: clip.tag ? { ...clip.tag } : null,
      overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
      replacementAudio: clip.replacementAudio ? { ...clip.replacementAudio } : null
    };
  }

  /**
   * Notes where the edit had got to, so the last step can be taken back.
   *
   * Changes are grouped by time rather than recorded one for one. Dragging a
   * slider is one gesture and a hundred `touch` calls, and an undo stack with a
   * hundred entries in it is not an undo stack — the reader would press it
   * twenty times to get back to where they started. Half a second of quiet ends
   * a gesture, which is well under how long it takes to reach for the next
   * control and well over the gap between two frames of a drag.
   */
  private remember(): void {
    if (this.applyingHistory || this.restoring) return;

    const now = Date.now();
    const continuing = now - this.lastChangeAt < HISTORY_GESTURE;
    this.lastChangeAt = now;
    const next = this.snapshot();

    // Only at a gesture boundary, because it is the only moment the answer is
    // used — and building it sixty times a second while a slider is moving
    // would cost more than everything else the drag does.
    if (!continuing) {
      const signature = this.signature(next);

      // Not everything that asks the page to look at itself again has changed
      // the edit: clearing a message does, and an undo that puts back a state
      // identical to the current one reads as a button that does not work.
      if (this.pending && signature !== this.pendingSignature) {
        this.history.push(this.pending);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        // Anything done after an undo abandons what was undone. Keeping it
        // would mean a redo that jumps to an edit nobody was making any more.
        this.future.length = 0;
      }

      this.pendingSignature = signature;
    }

    this.pending = next;
  }

  /**
   * Everything about the edit that a reader could want back, as one string.
   *
   * Deliberately narrow. A `File`, a decoded analysis and an object URL are all
   * either immutable or derived, so none of them can distinguish two moments in
   * the edit — and including them would make this both enormous and, in the
   * case of the analysis, impossible to serialise at all.
   */
  private signature(snapshot: EditorSnapshot): string {
    return JSON.stringify({
      board: snapshot.board,
      project: snapshot.project,
      clips: snapshot.clips.map((clip) => {
        if (isTransitionClip(clip)) return [clip.id, clip.settings];
        if (isMediaClip(clip)) {
          return [
            clip.id,
            clip.summary.fileName,
            clip.summary.durationSeconds,
            clip.awaitingFile === true,
            clip.overrides,
            clip.detected.map((range) => [range.start, range.end, range.enabled]),
            clip.manualCuts,
            clip.manualZooms ?? [],
            clip.inPoint ?? null,
            clip.outPoint ?? null,
            clip.caption,
            clip.captions ?? [],
            clip.tag ?? null,
            clip.noiseSuppression ?? null,
            normalizeVideoEffect(clip.videoEffect),
            clip.videoEffects ?? [],
            // Projected rather than stringified whole: a `File` serializes to
            // `{}`, so two different pictures in the same place would compare
            // equal and the edit would be dropped as a no-op.
            (clip.images ?? []).map((image) => [
              image.id, image.source.name, image.source.sourcePath ?? null, image.source.awaitingFile === true,
              image.startSeconds ?? null, image.durationSeconds ?? null, image.style ?? 'overlay',
              image.positionX ?? null, image.positionY ?? null, image.scale ?? null,
              image.rotationDegrees ?? null, image.opacity ?? null, image.fadeSeconds ?? null
            ]),
            clip.noiseReport ?? null,
            clip.replacementAudio?.summary.fileName ?? null
          ];
        }
        return [clip.id, clip.draft, clip.overrides, clip.tag ?? null, clip.replacementAudio?.summary.fileName ?? null];
      })
    });
  }

  get canUndo(): boolean {
    return this.history.length > 0 && !this.exporting;
  }

  get canRedo(): boolean {
    return this.future.length > 0 && !this.exporting;
  }

  undo(): void {
    if (!this.canUndo) return;

    const previous = this.history.pop();
    if (!previous) return;

    this.future.push(this.snapshot());
    this.applySnapshot(previous);
    this.message = 'Undone.';
  }

  redo(): void {
    if (!this.canRedo) return;

    const next = this.future.pop();
    if (!next) return;

    this.history.push(this.snapshot());
    this.applySnapshot(next);
    this.message = 'Redone.';
  }

  /**
   * Puts a remembered moment back on screen.
   *
   * Every dialog is shut first, because each of them holds a reference to a
   * clip object that is about to be replaced — a settings panel left open would
   * go on editing a clip that is no longer on the timeline, and the change
   * would land nowhere.
   */
  private applySnapshot(snapshot: EditorSnapshot): void {
    this.applyingHistory = true;

    try {
      this.closeAllDialogs();
      this.aplicarLayoutBoard(snapshot.board);
      // Restored before the clips, so anything created while re-applying draws
      // from the counter this snapshot was taken with.
      if (Number.isFinite(snapshot.nextId)) this.nextId = snapshot.nextId;
      this.clips = snapshot.clips.map((clip) => this.snapshotClip(clip));
      this.project = { ...snapshot.project, edits: cloneEdits(snapshot.project.edits) };

      // A text card's background is drawn from a URL the removal revoked. The
      // file itself is still here, so a new one costs nothing and is the only
      // thing standing between the reader and a blank card.
      for (const clip of this.clips) {
        if (isTextClip(clip) && clip.backgroundFile) clip.backgroundUrl = URL.createObjectURL(clip.backgroundFile);
      }
    } finally {
      this.applyingHistory = false;
    }

    this.pending = this.snapshot();
    this.pendingSignature = this.signature(this.pending);
    this.lastChangeAt = 0;
    this.touchAfterHistory();
    this.cdr.markForCheck();
  }

  /** The bookkeeping `touch` does, without recording another history entry. */
  private touchAfterHistory(): void {
    this.applyingHistory = true;
    try {
      this.touch();
    } finally {
      this.applyingHistory = false;
    }
  }

  /**
   * The keyboard the rest of the tool was missing.
   *
   * Bound on the document rather than on the page element so it works wherever
   * the focus happens to be — including inside a dialog, which is exactly where
   * a reader is when they realise they have just undone the wrong thing. A
   * field being typed into is left alone: the browser's own undo belongs to the
   * text, and stealing it would be worse than not having ours.
   */
  @HostListener('document:keydown', ['$event'])
  onShortcut(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    // Only text entry is left alone. The browser's own undo belongs to the
    // words somebody is typing and stealing it would be worse than not having
    // ours — but a slider, a checkbox or a select has no undo of its own, and
    // the reader who has just dragged a slider is precisely the one reaching
    // for Ctrl+Z. Bailing out for those meant the shortcut did nothing exactly
    // where it was most wanted.
    const target = event.target as HTMLElement | null;
    if (target && isTextEntry(target)) return;

    const key = (event.key || '').toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      this.redo();
    }
  }

  /** Leaving fullscreen can happen without us being asked, so we watch instead. */
  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.previewFullscreen = typeof document !== 'undefined' && document.fullscreenElement !== null;

    // The canvas composes at a fraction of the export's size, which is right in
    // a pane and visibly soft blown up to a laptop screen. The plan's own width
    // still caps it, so this never invents detail the footage does not have.
    const screenWidth = typeof window === 'undefined' ? 0 : window.innerWidth * (window.devicePixelRatio || 1);
    const wanted = this.previewFullscreen && screenWidth > 0 ? Math.round(screenWidth) : PREVIEW_PANE_WIDTH;
    this.zone.runOutsideAngular(() => this.player?.setMaxWidth(wanted));
    this.cdr.markForCheck();
  }

  private readonly history: EditorSnapshot[] = [];
  private readonly future: EditorSnapshot[] = [];
  /** The edit as it stood at the end of the last gesture. */
  private pending: EditorSnapshot | null = null;
  /** What that state amounts to, so a change that changed nothing is not recorded. */
  private pendingSignature = '';
  private lastChangeAt = 0;
  /** True while a snapshot is being put back, so it is not recorded as a change. */
  private applyingHistory = false;

  // The plan is derived from the whole timeline, so it is rebuilt only when the
  // timeline changes rather than on every pass of change detection: a project
  // of thirty clips would otherwise re-plan every zoom several times a second.
  private revision = 0;
  private planRevision = -1;
  private planCache: ProjectPlan | null = null;
  /** The same edit planned with the silence left in, cached the same way. */
  private uncutRevision = -1;
  private uncutCache: ProjectPlan | null = null;

  /**
   * Everything `touch` does, except moving the revision.
   *
   * Reconnecting a file from disk restores what the document already said was
   * there. Nothing about the edit changed, so nothing about the revision should
   * — and bumping it here was doing real harm: the reconnect runs at the top of
   * every agent command, so an agent that had just read revision 22 was told,
   * by its very next call, that the project was at 23. Two of those in one
   * session, with nothing in the log to explain either.
   */
  private refreshWithoutEditing(): void {
    this.remember();
    if (this.player) this.zone.runOutsideAngular(() => this.player?.setPlan(this.previewPlan));
    this.scheduleSave();
  }

  /**
   * @param reason what moved the project, in one phrase.
   *
   * Recorded because a revision conflict is otherwise unanswerable: the agent
   * read revision 22, asked to change it, and was told the project is at 23
   * with nothing in the log to say why. Background work — a listening pass
   * finishing, a thumbnail settling — is invisible and moves it just the same.
   */
  private touch(reason = 'an edit in the editor'): void {
    this.lastRevisionReason = reason;
    this.lastRevisionAt = new Date().toISOString();
    this.revision++;
    this.result = null;
    // A half-written file can only be continued into while the plan behind it
    // still holds. The moment the timeline moves, the second part would be of a
    // different edit, so the offer is withdrawn rather than left to mislead.
    this.resume = null;
    this.remember();
    // The preview is watching the same plan, and the whole reason the panel
    // sits under it is so a change can be seen immediately.
    if (this.player) this.zone.runOutsideAngular(() => this.player?.setPlan(this.previewPlan));
    this.scheduleSave();
  }
}
