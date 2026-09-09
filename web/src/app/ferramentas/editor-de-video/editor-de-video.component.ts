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
import { describeZoomPlan, planAutoZooms } from '../../shared/media/auto-zoom';
import { LoudnessControlComponent } from '../../shared/media/loudness-control.component';
import { GainEnvelope, LoudnessSettings, describeLoudness, planGainEnvelope } from '../../shared/media/loudness';
import { MediaProbeService } from '../juntador-de-midias/media-probe.service';
import { MergeError } from '../juntador-de-midias/media-merger.models';
import { AUDIO_FORMATS, RESOLUTIONS, VIDEO_FORMATS, audioFormat, videoFormat } from '../juntador-de-midias/media-merger-formats';
import { AudioAnalysisService } from '../cortador-de-silencio/audio-analysis.service';
import { MediaInspectorService } from '../cortador-de-silencio/media-inspector.service';
import { ProcessingEngineSelectorService } from '../cortador-de-silencio/processing-engine-selector.service';
import { MediaToolError, OperationCanceledError } from '../cortador-de-silencio/silence-cutter.models';
import { detectionSettingsChanged } from '../cortador-de-silencio/silence-cutter.models';
import { detectSilence, totalDuration as totalRangeDuration } from '../cortador-de-silencio/silence-detector';
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
import { BodyPortalDirective } from '../../shared/ui/body-portal.directive';
import { measureLeadingSilence } from './leading-silence';
import { AudioSourceDialogComponent } from './audio-source-dialog.component';
import { TransitionDialogComponent } from './transition-dialog.component';
import { TagDialogComponent } from './tag-dialog.component';
import {
  ClipTag,
  TAG_FINISHES,
  TAG_LIMITS,
  TAG_SHAPES,
  TAG_POSITIONS,
  TAG_POSITION_LABELS,
  TagPosition,
  clampTag,
  clampTagNumber,
  holdFromText,
  specialShape,
  tagHold
} from './tag-overlay';
import { TRANSITIONS, transitionDefinition } from './video-transitions';
import { ClipEditsPanelComponent } from './clip-edits-panel.component';
import { HelpHintComponent } from './help-hint.component';
import { TimelinePlayer } from './timeline-player';
import { VideoEditorRenderService } from './video-editor-render.service';
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
  CAPTION_LIMITS,
  DEFAULT_CAPTION,
  DEFAULT_EDITS,
  DEFAULT_PROJECT,
  DEFAULT_SOUND_FADE,
  DEFAULT_TEXT_DRAFT,
  DEFAULT_TRANSITION,
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
  cloneEdits,
  readingSeconds,
  speedLabel,
  timelapseSpeedFor
} from './video-editor-defaults';
import { HelpPanelComponent } from '../../shared/ui/help-panel.component';
import {
  buildProjectPlan,
  clipAt,
  clipBounds,
  clipsNeedingAnalysis,
  effectiveEdits,
  isOverridden,
  isTrimmed,
  keepRangesFor,
  removedRanges,
  slicePlan,
  sourceDuration,
  sourceTimeAt,
  trimmedDuration
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
  rememberHandle,
  rememberHandleAs
} from './file-handle-store';
import {
  ClipAudioMode,
  ClipCaption,
  ClipEdits,
  ClipSoundPlan,
  EditableRange,
  EditorCanceledError,
  EditorClip,
  EditorError,
  FrameAspect,
  ManualZoom,
  MediaClip,
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
interface EditorSnapshot {
  clips: EditorClip[];
  project: ProjectSettings;
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
  kind: RenderLogKind;
  text: string;
}

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
    AudioSourceDialogComponent,
    ClipEditsPanelComponent,
    HelpHintComponent,
    TransitionDialogComponent,
    TagDialogComponent,
    LoudnessControlComponent,
    SilenceWaveformComponent
  ,
    HelpPanelComponent],
  templateUrl: './editor-de-video.component.html',
  styleUrls: ['./editor-de-video.component.css', './editor-de-video.previa.css', './editor-de-video.lista.css']
})
export class EditorDeVideoComponent implements OnInit, AfterViewChecked, OnDestroy {
  clips: EditorClip[] = [];
  project: ProjectSettings = freshProject();

  /** The clip whose dialog is open, or null. */
  editing: MediaClip | null = null;
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
  logOpen = false;

  @ViewChild('logConsole') private logConsole?: ElementRef<HTMLDivElement>;
  private logSeq = 0;
  private logStartedAt = 0;
  /** True while the reader is at the bottom and the console should follow. */
  private logFollowing = true;
  /** Set when a line arrives, cleared once the console has been scrolled. */
  private logDirty = false;
  result: RenderResult | null = null;

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

  constructor(
    private readonly dataService: DataService,
    private readonly probe: MediaProbeService,
    private readonly inspector: MediaInspectorService,
    private readonly analyser: AudioAnalysisService,
    private readonly selector: ProcessingEngineSelectorService,
    private readonly renderer: VideoEditorRenderService,
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
    this.presets = readPresets();
    // The first entry in the history is the edit as it arrived, so the very
    // first change made can be taken back like any other.
    this.pending = this.snapshot();
    this.pendingSignature = this.signature(this.pending);
  }

  ngOnDestroy(): void {
    this.controller?.abort();
    this.cancelAnalyses();
    if (this.redetectTimer) clearTimeout(this.redetectTimer);
    this.stopTextPlayback();
    this.player?.dispose();
    this.textBitmap?.close();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // Written one last time rather than left to the timer: a reader navigating
    // away mid-edit is exactly the case the storage exists for.
    this.saveNow();
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
      // them, and the reader never learns that anything was missing.
      void this.reconnectQuietly();
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
      for (const clip of this.clips) this.release(clip);
      this.clips = restored.clips;
      this.project = restored.project;
      // Past every id the document uses, so a clip added now can never collide
      // with one that came out of storage.
      this.nextId = Math.max(restored.nextId, this.highestStoredId(restored.clips) + 1);
      this.restoredAt = restored.savedAt;
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
  private attachRestoredFile(file: File): boolean {
    let used = false;

    for (const clip of this.clips) {
      if (isMediaClip(clip) && clip.awaitingFile && clip.fileRef && matchesRef(file, clip.fileRef)) {
        clip.file = file;
        clip.awaitingFile = false;
        clip.info = null;
        if (!clip.thumbUrl) this.enqueueThumbnail(clip);
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
        clip.backgroundUrl = URL.createObjectURL(file);
        used = true;
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
        this.saveNow();
        this.cdr.markForCheck();
      });
    }, SAVE_DELAY);
  }

  private saveNow(): void {
    if (this.restoring || !this.remembering || !isPlatformBrowser(this.platformId)) return;

    if (!this.clips.length) {
      clearStoredProject();
      this.saveState = 'idle';
      return;
    }

    this.saveState = writeStoredProject(this.clips, this.project, this.nextId);
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
    this.writeDocument(serializeProject(this.clips, this.project, this.nextId), 'video-editor-project');
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
    this.saveNow();
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
        overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
        detected: clip.detected.map((range) => ({ ...range })),
        manualCuts: clip.manualCuts.map((range) => ({ ...range })),
        caption: clip.caption ? { ...clip.caption } : null,
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
      clip.previewUrl = null;
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
    this.suspendPreview();
    this.editing = clip;
    this.playhead = 0;
    if (isPlatformBrowser(this.platformId) && !clip.awaitingFile) {
      clip.previewUrl ??= URL.createObjectURL(clip.file);
    }
  }

  closeClip(): void {
    this.editing = null;
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
    clip.previewUrl ??= URL.createObjectURL(clip.file);
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
  private onPreviewTick(time: number, index: number): void {
    const changed = index !== this.previewClipIndex;
    this.previewTime = time;
    this.previewClipIndex = index;

    const now = performance.now();
    if (!changed && now - this.lastPreviewSync < 120) return;
    this.lastPreviewSync = now;

    this.zone.run(() => {
      this.previewPlaying = this.player?.playing ?? false;
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
    clip.caption = { ...(clip.caption ?? DEFAULT_CAPTION), text };
    this.touch();
  }

  captionTextOf(clip: EditorClip): string {
    return isMediaClip(clip) ? clip.caption?.text ?? '' : '';
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
  async analyzeClip(clip: MediaClip, quiet = false): Promise<void> {
    if (!isPlatformBrowser(this.platformId) || this.analyzing.has(clip.id)) return;
    if (clip.awaitingFile) {
      this.errorMessage = `"${clip.summary.fileName}" is waiting for its file, so there is nothing to listen to yet.`;
      this.errorHint = 'Add the same file again to reconnect it.';
      return;
    }
    if (!clip.summary.audioUsable) {
      this.errorMessage = `"${clip.summary.fileName}" has no sound this browser can decode, so there is nothing to listen to.`;
      return;
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
      this.touch();
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
  async analyzeMany(clips: readonly MediaClip[]): Promise<void> {
    const queue = clips.filter((clip) => !clip.awaitingFile && clip.summary.audioUsable && !this.analyzing.has(clip.id));
    if (!queue.length) return;

    this.clearMessages();
    let next = 0;

    const lane = async (): Promise<void> => {
      while (next < queue.length) {
        const clip = queue[next++];
        await this.analyzeClip(clip, true);
        if (this.errorMessage) return;
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.analysisLanes, queue.length) }, lane));
    this.cdr.markForCheck();
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

  get caption(): ClipCaption {
    return this.editing?.caption ?? DEFAULT_CAPTION;
  }

  onCaption(change: Partial<ClipCaption>): void {
    const clip = this.editing;
    if (!clip) return;

    clip.caption = { ...(clip.caption ?? DEFAULT_CAPTION), ...change };
    this.touch();
  }

  onCaptionNumber(key: 'fontScale' | 'bottomMargin' | 'fadeSeconds', value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;

    const limits = CAPTION_LIMITS[key];
    this.onCaption({ [key]: Math.min(limits.max, Math.max(limits.min, parsed)) } as Partial<ClipCaption>);
  }

  clearCaption(): void {
    if (this.editing) this.editing.caption = null;
    this.touch();
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
    clip.backgroundUrl = URL.createObjectURL(file);
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
        this.message = result.savedToDisk ? `Saved as ${result.fileName}.` : `${result.fileName} is ready.`;
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

    const url = URL.createObjectURL(clip.file);

    try {
      const source =
        clip.summary.kind === 'image'
          ? await createImageBitmap(clip.file).catch(() => null)
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
    if (isMediaClip(clip) && clip.caption?.text.trim()) labels.push('caption');
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
      id: `clip-${this.nextId++}`,
      summary: { ...clip.summary },
      inPoint: sourceTime,
      outPoint: bounds.end < sourceDuration(clip) - 1e-4 ? bounds.end : undefined,
      overrides: clip.overrides ? cloneEdits(clip.overrides) : null,
      detected: clip.detected.map((range) => ({ ...range })),
      manualCuts: clip.manualCuts.map((range) => ({ ...range })),
      manualZooms: (clip.manualZooms ?? []).map((zoom) => ({ ...zoom, id: `zoom-${this.nextId++}` })),
      caption: clip.caption ? { ...clip.caption } : null,
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

    this.renderLog.push({ seq: this.logSeq++, at, kind: entry.kind, text: entry.text });
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
  private snapshot(): EditorSnapshot {
    return {
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
        tag: clip.tag ? { ...clip.tag } : null,
        replacementAudio: clip.replacementAudio ? { ...clip.replacementAudio } : null,
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
            clip.tag ?? null,
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

  private touch(): void {
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
