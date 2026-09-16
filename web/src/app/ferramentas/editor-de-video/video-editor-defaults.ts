import { DEFAULT_TRANSITION_COLOUR, DEFAULT_TRANSITION_KIND, TRANSITION_SECONDS } from './video-transitions';
import { DEFAULT_TAG } from './tag-overlay';
import { DEFAULT_AUTO_ZOOM } from '../../shared/media/auto-zoom';
import { DEFAULT_LOUDNESS } from '../../shared/media/loudness';
import { AUDIO_FORMATS, VIDEO_FORMATS } from '../juntador-de-midias/media-merger-formats';
import { settingsForPreset } from '../cortador-de-silencio/silence-cutter-presets';
import { IMAGE_LIMITS, isImageStyle } from './clip-image';
import {
  ClipCaption,
  ClipEdits,
  ClipImage,
  FrameAspect,
  ManualZoom,
  ProjectSettings,
  ReframeFit,
  SoundFade,
  TextClipDraft,
  TransitionSettings
} from './video-editor.models';

/** Extensions offered in the file dialog. The real check is the parsed header. */
export const ACCEPTED_MEDIA =
  '.mp4,.mov,.m4v,.webm,.mkv,.avi,.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.flac,' +
  '.png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,video/*,audio/*,image/*';

/** What may stand in for a clip's own sound. A video is accepted for its audio. */
export const ACCEPTED_AUDIO = '.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.flac,.mp4,.mov,.webm,.mkv,audio/*,video/*';

/** What may sit behind a text card. */
export const ACCEPTED_IMAGE = '.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,image/*';

/**
 * The playback rates offered, from half speed to ten times.
 *
 * A list rather than a free number: the useful rates are coarse, and the half
 * step is what people actually reach for. Ten is the ceiling because past it a
 * clip stops being footage and becomes a flicker — and every frame still has to
 * be decoded to get there, so the cost keeps rising while the result does not.
 */
export const SPEEDS: readonly number[] = Array.from({ length: 20 }, (_, index) => (index + 1) / 2);

/**
 * What a speed may actually be, which is not the same as what is on the menu.
 *
 * The list above is what somebody picks from, and it stops at ten because past
 * that a clip stops being footage and becomes a flicker. The ceiling here is far
 * higher because it is not reached by hand: a twenty-minute timelapse asked to
 * last fifteen seconds needs eighty times, and a limit of ten would not shorten
 * it — it would silently fail to. Two hundred and forty is where a clip of an
 * hour still reaches fifteen seconds.
 */
export const SPEED_LIMITS = { min: 0.5, max: 240, step: 0.5 } as const;

/** How long each fade lasts by default, and how far it can be pushed. */
export const FADE_SECONDS = { default: 1, min: 0.1, max: 10, step: 0.1 } as const;

/**
 * How a supplied soundtrack enters and leaves, and how far that can be pushed.
 *
 * Longer than a clip's fade by default, and on rather than off: music that
 * starts at full volume on a hard cut sounds like a mistake, and the reader who
 * chose a soundtrack has already said they want one to be heard rather than
 * noticed. Fifteen seconds is the ceiling because past that it stops being an
 * entrance and becomes the piece itself.
 */
export const SOUND_FADE_SECONDS = { default: 1.5, min: 0.1, max: 15, step: 0.1 } as const;

export const DEFAULT_SOUND_FADE: SoundFade = {
  fadeIn: true,
  fadeOut: true,
  seconds: SOUND_FADE_SECONDS.default
};

/**
 * How far a clip's own volume can be pushed, as a percentage.
 *
 * Zero is offered because it is a different instruction from "silence it": the
 * mute setting takes the clip's sound out of the plan entirely, while nought
 * per cent leaves it there and turns it down, which is what a reader riding one
 * take under another actually wants. Two hundred is the ceiling because past a
 * doubling the limiter is doing more of the work than the reader is.
 */
export const VOLUME_LIMITS = { default: 100, min: 0, max: 200, step: 5 } as const;

/** Bounds for a push-in placed by hand. */
export const MANUAL_ZOOM_LIMITS = {
  scalePercent: { default: 15, min: 2, max: 80, step: 1 },
  rampSeconds: { default: 0.6, min: 0, max: 5, step: 0.1 },
  /** How long a zoom added at the playhead lasts before the reader changes it. */
  seconds: { default: 3, min: 0.2, max: 600, step: 0.1 }
} as const;

/** The shapes the finished frame can take, in the order they are offered. */
export const ASPECTS: readonly { value: FrameAspect; label: string; hint: string }[] = [
  { value: 'source', label: 'As the footage is', hint: 'The shape the resolution above already decided.' },
  { value: '9:16', label: 'Vertical 9:16', hint: 'Phone-shaped, for stories, reels and shorts.' },
  { value: '1:1', label: 'Square 1:1', hint: 'Equal sides, for a feed that crops everything else.' }
];

/** What is done with a picture whose shape does not match the frame. */
export const REFRAME_FITS: readonly { value: ReframeFit; label: string; hint: string }[] = [
  { value: 'fill', label: 'Fill the frame', hint: 'The picture is enlarged until it covers the frame and the overflow is cropped.' },
  { value: 'fit', label: 'Fit inside it', hint: 'The whole picture is kept and the space around it stays black.' }
];

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return VOLUME_LIMITS.default;
  return Math.min(VOLUME_LIMITS.max, Math.max(VOLUME_LIMITS.min, Math.round(value)));
}

/** A push-in placed by hand, with every number inside what can be drawn. */
export function clampManualZoom(zoom: ManualZoom, duration: number): ManualZoom {
  const limits = MANUAL_ZOOM_LIMITS;
  const clamp = (value: number, min: number, max: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

  const start = clamp(zoom.start, 0, Math.max(0, duration), 0);
  const end = clamp(zoom.end, start + 0.05, Math.max(start + 0.05, duration), start + limits.seconds.default);

  return {
    ...zoom,
    start,
    end,
    scalePercent: clamp(zoom.scalePercent, limits.scalePercent.min, limits.scalePercent.max, limits.scalePercent.default),
    rampSeconds: clamp(zoom.rampSeconds, limits.rampSeconds.min, limits.rampSeconds.max, limits.rampSeconds.default),
    easeOut: zoom.easeOut !== false
  };
}

/**
 * How long a clip recognised as a timelapse should be made to last.
 *
 * Zero is the default and means "leave them alone", so the setting is inert
 * until somebody types a number into it. Ten minutes is the ceiling: past that
 * the reader is not shortening a timelapse any more, they are keeping it, and
 * the speed control is the honest way to say so.
 */
export const TIMELAPSE_TARGET = { default: 0, min: 0, max: 600, step: 1 } as const;

export function clampTimelapseTarget(value: number): number {
  if (!Number.isFinite(value)) return TIMELAPSE_TARGET.default;
  return Math.min(TIMELAPSE_TARGET.max, Math.max(TIMELAPSE_TARGET.min, Math.round(value)));
}

/**
 * The speed that makes a clip of `sourceSeconds` last `targetSeconds`.
 *
 * Pure, and separate from the component, because it is the one piece of this
 * feature with arithmetic worth testing: the clamp at both ends is what decides
 * whether a two-hour timelapse can reach the target at all, and the caller has
 * to be able to see that it could not.
 */
export function timelapseSpeedFor(sourceSeconds: number, targetSeconds: number): number {
  if (!Number.isFinite(sourceSeconds) || sourceSeconds <= 0) return 1;
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return 1;

  return clampSpeed(sourceSeconds / targetSeconds);
}

/** When a cut removes more than this share, the project soundtrack fills in. */
export const SILENT_CUT_REPLACEMENT = { default: 0.8, min: 0, max: 1, step: 0.05 } as const;

/** How long a still image stays on screen when nothing else decides for it. */
export const IMAGE_SECONDS = { default: 5, min: 0.1, max: 3600, step: 0.5 } as const;

/** Bounds for the caption, as shares of the frame height. */
export const CAPTION_LIMITS = {
  fontScale: { min: 0.02, max: 0.4, step: 0.005 },
  bottomMargin: { min: 0, max: 0.3, step: 0.005 },
  outlinePercent: { min: 0, max: 30, step: 1 },
  fadeSeconds: { min: 0.1, max: 5, step: 0.1 },
  positionX: { min: 0.08, max: 0.92, step: 0.01 },
  positionY: { min: 0.15, max: 0.85, step: 0.01 },
  rotationDegrees: { min: -20, max: 20, step: 1 },
  shadowBlurPercent: { min: 10, max: 120, step: 5 },
  shadowOpacity: { min: 0, max: 1, step: 0.05 }
} as const;

export const CAPTION_FONTS: readonly { value: NonNullable<ClipCaption['fontFamily']>; label: string }[] = [
  { value: 'sans', label: 'Clean sans serif' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'serif', label: 'Editorial serif' },
  { value: 'mono', label: 'Monospace' },
  { value: 'impact', label: 'Condensed heavy' },
  { value: 'display', label: 'Display' },
  { value: 'geometric', label: 'Geometric' },
  { value: 'slab', label: 'Slab serif' },
  { value: 'handwritten', label: 'Handwritten' }
];

export const CAPTION_ANIMATIONS: readonly { value: NonNullable<ClipCaption['animation']>; label: string }[] = [
  { value: 'none', label: 'Still' },
  { value: 'zoom-in', label: 'Subtle zoom in' },
  { value: 'zoom-out', label: 'Subtle zoom out' },
  { value: 'scroll-left', label: 'Slow scroll left' },
  { value: 'scroll-right', label: 'Slow scroll right' },
  { value: 'scroll-up', label: 'Slow scroll up' },
  { value: 'scroll-down', label: 'Slow scroll down' }
];

export const CAPTION_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;

export type CaptionPresetGroupId = 'classic' | 'background';
export interface CaptionPresetDefinition {
  id: string;
  label: string;
  group: CaptionPresetGroupId;
  style: Partial<ClipCaption>;
}

export const CAPTION_PRESET_GROUPS: readonly { id: CaptionPresetGroupId; label: string }[] = [
  { id: 'classic', label: 'Classic captions' },
  { id: 'background', label: 'Background captions · Behind subject' }
];

export const CAPTION_PRESETS: readonly CaptionPresetDefinition[] = [
  { id: 'classic', group: 'classic', label: 'Classic · white, black outline + shadow', style: { fontFamily: 'sans', fontWeight: 700, italic: false, textColor: '#ffffff', outlineColor: '#000000', outlinePercent: 16, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'white-clean', group: 'classic', label: 'Clean · white, black outline', style: { fontFamily: 'sans', fontWeight: 700, italic: false, textColor: '#ffffff', outlineColor: '#000000', outlinePercent: 16, shadowEnabled: false, shadowColor: '#000000' } },
  { id: 'yellow-shadow', group: 'classic', label: 'Yellow · black outline + shadow', style: { fontFamily: 'sans', fontWeight: 800, italic: false, textColor: '#ffd928', outlineColor: '#000000', outlinePercent: 17, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'yellow-clean', group: 'classic', label: 'Yellow · black outline', style: { fontFamily: 'sans', fontWeight: 800, italic: false, textColor: '#ffd928', outlineColor: '#000000', outlinePercent: 17, shadowEnabled: false, shadowColor: '#000000' } },
  { id: 'black-white-shadow', group: 'classic', label: 'Black · white outline + shadow', style: { fontFamily: 'sans', fontWeight: 800, italic: false, textColor: '#000000', outlineColor: '#ffffff', outlinePercent: 17, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'black-white-clean', group: 'classic', label: 'Black · white outline', style: { fontFamily: 'sans', fontWeight: 800, italic: false, textColor: '#000000', outlineColor: '#ffffff', outlinePercent: 17, shadowEnabled: false, shadowColor: '#000000' } },
  { id: 'cyan', group: 'classic', label: 'Cyan · navy outline + shadow', style: { fontFamily: 'rounded', fontWeight: 800, italic: false, textColor: '#54e7ff', outlineColor: '#071a38', outlinePercent: 18, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'pink', group: 'classic', label: 'Pink · plum outline + shadow', style: { fontFamily: 'rounded', fontWeight: 800, italic: false, textColor: '#ff82d8', outlineColor: '#3a082e', outlinePercent: 18, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'lime', group: 'classic', label: 'Lime · black outline', style: { fontFamily: 'sans', fontWeight: 900, italic: false, textColor: '#baff3c', outlineColor: '#000000', outlinePercent: 18, shadowEnabled: false, shadowColor: '#000000' } },
  { id: 'editorial', group: 'classic', label: 'Editorial · warm white serif', style: { fontFamily: 'serif', fontWeight: 700, italic: false, textColor: '#fff4dc', outlineColor: '#24180e', outlinePercent: 10, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'mono', group: 'classic', label: 'Tech · green monospace', style: { fontFamily: 'mono', fontWeight: 700, italic: false, textColor: '#8dffad', outlineColor: '#07150c', outlinePercent: 13, shadowEnabled: true, shadowColor: '#000000' } },
  {
    id: 'behind-subject',
    group: 'background',
    label: 'Upper center · Clean white',
    style: {
      style: 'behind-subject', fontFamily: 'sans', fontWeight: 600, italic: false,
      fontScale: 0.28, textColor: '#ffffff', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#000000', shadowBlurPercent: 70, shadowOpacity: 0.9,
      positionX: 0.5, positionY: 0.25, rotationDegrees: 0, uppercase: true
    }
  },
  {
    id: 'behind-subject-upper-left', group: 'background', label: 'Upper left · Warm editorial',
    style: {
      style: 'behind-subject', fontFamily: 'serif', fontWeight: 600, italic: false,
      fontScale: 0.25, textColor: '#fff4dc', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#160f09', shadowBlurPercent: 55, shadowOpacity: 0.82,
      positionX: 0.3, positionY: 0.24, rotationDegrees: -2, uppercase: true
    }
  },
  {
    id: 'behind-subject-upper-right', group: 'background', label: 'Upper right · Cyan rounded',
    style: {
      style: 'behind-subject', fontFamily: 'rounded', fontWeight: 600, italic: false,
      fontScale: 0.26, textColor: '#67e8f9', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#071a38', shadowBlurPercent: 60, shadowOpacity: 0.85,
      positionX: 0.7, positionY: 0.24, rotationDegrees: 2, uppercase: true
    }
  },
  {
    id: 'behind-subject-center', group: 'background', label: 'Center · Cinematic white',
    style: {
      style: 'behind-subject', fontFamily: 'sans', fontWeight: 600, italic: false,
      fontScale: 0.3, textColor: '#ffffff', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#000000', shadowBlurPercent: 75, shadowOpacity: 0.88,
      positionX: 0.5, positionY: 0.5, rotationDegrees: 0, uppercase: true
    }
  },
  {
    id: 'behind-subject-center-left', group: 'background', label: 'Center left · Golden',
    style: {
      style: 'behind-subject', fontFamily: 'sans', fontWeight: 600, italic: false,
      fontScale: 0.27, textColor: '#fde047', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#1c1500', shadowBlurPercent: 60, shadowOpacity: 0.86,
      positionX: 0.34, positionY: 0.5, rotationDegrees: -1, uppercase: true
    }
  },
  {
    id: 'behind-subject-center-right', group: 'background', label: 'Center right · Soft pink',
    style: {
      style: 'behind-subject', fontFamily: 'rounded', fontWeight: 600, italic: false,
      fontScale: 0.27, textColor: '#f9a8d4', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#3a082e', shadowBlurPercent: 60, shadowOpacity: 0.84,
      positionX: 0.66, positionY: 0.5, rotationDegrees: 1, uppercase: true
    }
  },
  {
    id: 'behind-subject-zoom-in-display', group: 'background', label: 'Center · Display zoom in',
    style: {
      style: 'behind-subject', fontFamily: 'display', fontWeight: 600, italic: false,
      fontScale: 0.3, textColor: '#ffffff', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#06152d', shadowBlurPercent: 65, shadowOpacity: 0.88,
      positionX: 0.5, positionY: 0.5, rotationDegrees: 0, uppercase: true, animation: 'zoom-in'
    }
  },
  {
    id: 'behind-subject-zoom-out-slab', group: 'background', label: 'Center · Slab gold zoom out',
    style: {
      style: 'behind-subject', fontFamily: 'slab', fontWeight: 600, italic: false,
      fontScale: 0.29, textColor: '#fcd34d', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#241803', shadowBlurPercent: 60, shadowOpacity: 0.86,
      positionX: 0.5, positionY: 0.5, rotationDegrees: 0, uppercase: true, animation: 'zoom-out'
    }
  },
  {
    id: 'behind-subject-scroll-left-geometric', group: 'background', label: 'Upper center · Geometric scroll left',
    style: {
      style: 'behind-subject', fontFamily: 'geometric', fontWeight: 500, italic: false,
      fontScale: 0.26, textColor: '#a5f3fc', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#062735', shadowBlurPercent: 55, shadowOpacity: 0.82,
      positionX: 0.5, positionY: 0.25, rotationDegrees: 0, uppercase: true, animation: 'scroll-left'
    }
  },
  {
    id: 'behind-subject-scroll-right-handwritten', group: 'background', label: 'Upper center · Handwritten scroll right',
    style: {
      style: 'behind-subject', fontFamily: 'handwritten', fontWeight: 600, italic: false,
      fontScale: 0.25, textColor: '#fdf2f8', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#4a1236', shadowBlurPercent: 58, shadowOpacity: 0.84,
      positionX: 0.5, positionY: 0.25, rotationDegrees: -2, uppercase: false, animation: 'scroll-right'
    }
  },
  {
    id: 'behind-subject-scroll-up-mono', group: 'background', label: 'Center left · Mono scroll up',
    style: {
      style: 'behind-subject', fontFamily: 'mono', fontWeight: 600, italic: false,
      fontScale: 0.25, textColor: '#86efac', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#052e16', shadowBlurPercent: 52, shadowOpacity: 0.82,
      positionX: 0.34, positionY: 0.5, rotationDegrees: 0, uppercase: true, animation: 'scroll-up'
    }
  },
  {
    id: 'behind-subject-scroll-down-serif', group: 'background', label: 'Upper right · Serif scroll down',
    style: {
      style: 'behind-subject', fontFamily: 'serif', fontWeight: 500, italic: true,
      fontScale: 0.25, textColor: '#ffedd5', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#431407', shadowBlurPercent: 55, shadowOpacity: 0.82,
      positionX: 0.7, positionY: 0.24, rotationDegrees: 1, uppercase: false, animation: 'scroll-down'
    }
  },
  {
    id: 'behind-subject-upper-left-display-zoom', group: 'background', label: 'Upper left · Display zoom out',
    style: {
      style: 'behind-subject', fontFamily: 'display', fontWeight: 700, italic: false,
      fontScale: 0.26, textColor: '#fca5a5', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#450a0a', shadowBlurPercent: 62, shadowOpacity: 0.86,
      positionX: 0.3, positionY: 0.24, rotationDegrees: -1, uppercase: true, animation: 'zoom-out'
    }
  },
  {
    id: 'behind-subject-center-right-geometric-zoom', group: 'background', label: 'Center right · Geometric zoom in',
    style: {
      style: 'behind-subject', fontFamily: 'geometric', fontWeight: 600, italic: false,
      fontScale: 0.27, textColor: '#c4b5fd', outlineColor: '#000000', outlinePercent: 0,
      shadowEnabled: true, shadowColor: '#2e1065', shadowBlurPercent: 60, shadowOpacity: 0.84,
      positionX: 0.66, positionY: 0.5, rotationDegrees: 1, uppercase: true, animation: 'zoom-in'
    }
  }
];

export function captionPresetIsBackground(presetId: string | null | undefined): boolean {
  return presetId === 'custom-background' || CAPTION_PRESETS.some((preset) => preset.id === presetId && preset.group === 'background');
}

export function isBackgroundCaption(caption: { style?: string; stylePreset?: string }): boolean {
  return caption.style === 'behind-subject' || captionPresetIsBackground(caption.stylePreset);
}

export const DEFAULT_CAPTION: ClipCaption = {
  text: '',
  fontScale: 0.045,
  bottomMargin: 0.06,
  stylePreset: 'classic',
  style: 'classic',
  fontFamily: 'sans',
  fontWeight: 700,
  italic: false,
  textColor: '#ffffff',
  outlineColor: '#000000',
  outlinePercent: 16,
  shadowEnabled: true,
  shadowColor: '#000000',
  animation: 'none',
  fadeIn: true,
  fadeOut: true,
  fadeSeconds: 0.5
};

/**
 * What a project starts as, and what a clip follows until it is given its own.
 *
 * Silence cutting is off to begin with: a reader who drags in five clips
 * expects to see five clips, not five clips already shortened by a detector
 * they have not looked at yet. But when it is switched on it starts on
 * **Aggressive** rather than Balanced — an edit is where someone came to
 * tighten footage, and a preset that leaves the rhythm of the speech intact is
 * the wrong first answer here even though it is the right one in the silence
 * cutter, where the reader is repairing a recording rather than cutting one.
 */
/** What a transition added by hand starts out as. */
export const DEFAULT_TRANSITION: TransitionSettings = {
  kind: DEFAULT_TRANSITION_KIND,
  seconds: TRANSITION_SECONDS.default,
  colour: DEFAULT_TRANSITION_COLOUR
};

export const DEFAULT_EDITS: ClipEdits = {
  cutSilence: false,
  silence: { ...settingsForPreset('aggressive'), autoZoom: { ...DEFAULT_AUTO_ZOOM } },
  fadeIn: false,
  fadeOut: false,
  fadeSeconds: FADE_SECONDS.default,
  speed: 1,
  audioMode: 'original',
  volumePercent: VOLUME_LIMITS.default
};

export const DEFAULT_PROJECT: ProjectSettings = {
  edits: cloneEdits(DEFAULT_EDITS),
  loudness: { ...DEFAULT_LOUDNESS },
  defaultAudio: null,
  silentCutReplacementThreshold: SILENT_CUT_REPLACEMENT.default,
  soundFade: { ...DEFAULT_SOUND_FADE },
  // Cuts, until the reader says otherwise. A transition applied to every join in
  // a project nobody asked to have one is the tool having an opinion about
  // someone else's edit.
  defaultTransition: null,
  // A tag to copy from, not a tag to apply. Every clip starts without one; this
  // is what the first one takes its shape from, so a reader who has settled how
  // their badges look sets it once instead of on every clip.
  defaultTag: { ...DEFAULT_TAG, text: 'New' },
  resolution: 'auto',
  // The shape of the footage, until the reader asks for another one. Reframing
  // a project nobody asked to reframe is the tool having an opinion about
  // someone else's edit, which is the same reasoning as the default transition.
  aspect: 'source',
  reframe: 'fill',
  // Off. A project only speeds a timelapse up once somebody has said how long
  // they want it to be.
  timelapseTargetSeconds: TIMELAPSE_TARGET.default,
  videoFormatId: VIDEO_FORMATS[0].id,
  audioFormatId: AUDIO_FORMATS[0].id
};

export function clampSilentCutReplacementThreshold(value: number): number {
  if (!Number.isFinite(value)) return SILENT_CUT_REPLACEMENT.default;
  return Math.min(SILENT_CUT_REPLACEMENT.max, Math.max(SILENT_CUT_REPLACEMENT.min, value));
}

/** The text card a new one starts as. */
export const DEFAULT_TEXT_DRAFT: TextClipDraft = {
  text: '',
  fontId: 'sans',
  fontScale: 0.09,
  fontWeight: 700,
  color: '#ffffff',
  backgroundColor: '#050b18',
  align: 'center',
  vertical: 'middle',
  margin: 0.07,
  letterSpacing: 0,
  lineHeight: 1.25,
  legibility: 'shadow',
  animation: 'rise',
  revealSeconds: 7.5,
  holdSeconds: 6,
  holdAuto: true
};

/**
 * How long a text card stays up, worked out from how much there is to read.
 *
 * Subtitle practice puts a comfortable adult reading rate at somewhere around
 * seventeen characters a second, and a title card wants to be slower than that:
 * it arrives without context, often over a photograph, and there is no second
 * chance at it. So the rate here is deliberately gentle, and there is a floor —
 * even one word needs long enough to be noticed, read and left behind.
 *
 * The reveal is not counted. The text is still arriving during it, and time
 * spent watching letters appear is not time spent reading them.
 */
export function readingSeconds(text: string): number {
  const characters = text.trim().length;
  if (!characters) return TEXT_HOLD_FLOOR * 3;

  return 3 * Math.min(TEXT_HOLD_CEILING, Math.max(TEXT_HOLD_FLOOR, TEXT_HOLD_FLOOR + characters / READING_RATE));
}

/** Characters a second the card is timed for. Lower than subtitle practice. */
const READING_RATE = 11;

/** Shortest a card is ever held, however little it says. */
const TEXT_HOLD_FLOOR = 1.4;

/** Longest the automatic timing will go before the reader has to say so. */
const TEXT_HOLD_CEILING = 20;

/**
 * A copy nothing else shares.
 *
 * `ClipEdits` is handed out by value everywhere — a clip that overrides the
 * project starts from the project's current values — so a shallow spread would
 * quietly leave the two sharing one `silence` object, and moving a slider for
 * one clip would move it for the project.
 */
export function cloneEdits(edits: ClipEdits): ClipEdits {
  return {
    ...edits,
    // Absent in every document written before a clip could be turned down, and
    // absent has to read as "leave it exactly as it is" rather than as silence.
    volumePercent: clampVolume(edits.volumePercent ?? VOLUME_LIMITS.default),
    silence: { ...edits.silence, autoZoom: { ...edits.silence.autoZoom } }
  };
}

/** The gain a clip's own volume setting asks for. 1 leaves the samples alone. */
export function volumeGain(edits: ClipEdits): number {
  return clampVolume(edits.volumePercent ?? VOLUME_LIMITS.default) / 100;
}

export function clampSoundFade(fade: SoundFade): SoundFade {
  const seconds = Number.isFinite(fade.seconds) ? fade.seconds : SOUND_FADE_SECONDS.default;
  return {
    fadeIn: fade.fadeIn,
    fadeOut: fade.fadeOut,
    seconds: Math.min(SOUND_FADE_SECONDS.max, Math.max(SOUND_FADE_SECONDS.min, seconds))
  };
}

/** Clamps the playback rate onto the offered list. */
export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const stepped = Math.round(value / SPEED_LIMITS.step) * SPEED_LIMITS.step;
  return Math.min(SPEED_LIMITS.max, Math.max(SPEED_LIMITS.min, Math.round(stepped * 10) / 10));
}

export function clampCaption(caption: ClipCaption): ClipCaption {
  const clamp = (value: number, limits: { min: number; max: number }) =>
    Number.isFinite(value) ? Math.min(limits.max, Math.max(limits.min, value)) : limits.min;
  const behindSubject = isBackgroundCaption(caption);

  return {
    ...caption,
    style: behindSubject ? 'behind-subject' : 'classic',
    fontScale: clamp(caption.fontScale, behindSubject ? { min: 0.2, max: 0.4 } : { min: 0.02, max: 0.12 }),
    bottomMargin: clamp(caption.bottomMargin, CAPTION_LIMITS.bottomMargin),
    outlinePercent: clamp(caption.outlinePercent ?? DEFAULT_CAPTION.outlinePercent ?? 16, CAPTION_LIMITS.outlinePercent),
    fadeSeconds: clamp(caption.fadeSeconds, CAPTION_LIMITS.fadeSeconds),
    positionX: clamp(caption.positionX ?? 0.5, CAPTION_LIMITS.positionX),
    positionY: clamp(caption.positionY ?? (behindSubject ? 0.25 : 0.5), CAPTION_LIMITS.positionY),
    rotationDegrees: clamp(caption.rotationDegrees ?? 0, CAPTION_LIMITS.rotationDegrees),
    shadowBlurPercent: clamp(caption.shadowBlurPercent ?? 70, CAPTION_LIMITS.shadowBlurPercent),
    shadowOpacity: clamp(caption.shadowOpacity ?? 0.9, CAPTION_LIMITS.shadowOpacity),
    animation: CAPTION_ANIMATIONS.some((item) => item.value === caption.animation) ? caption.animation : 'none'
  };
}

/**
 * Every placement value of a picture brought inside its limits.
 *
 * Applied on the way in from a document and on the way in from an MCP call, for
 * the same reason the captions are: a value that arrived out of range should
 * become the nearest legal one rather than quietly draw nothing.
 */
export function clampClipImage(image: ClipImage): ClipImage {
  const clamp = (value: number | undefined, limits: { min: number; max: number }, fallback: number) =>
    Number.isFinite(value) ? Math.min(limits.max, Math.max(limits.min, value as number)) : fallback;

  return {
    ...image,
    style: isImageStyle(image.style) ? image.style : 'overlay',
    positionX: clamp(image.positionX, IMAGE_LIMITS.position, 0.5),
    positionY: clamp(image.positionY, IMAGE_LIMITS.position, 0.5),
    scale: clamp(image.scale, IMAGE_LIMITS.scale, IMAGE_LIMITS.scale.default),
    rotationDegrees: clamp(image.rotationDegrees, IMAGE_LIMITS.rotationDegrees, 0),
    opacity: clamp(image.opacity, IMAGE_LIMITS.opacity, IMAGE_LIMITS.opacity.default),
    fadeSeconds: clamp(image.fadeSeconds, IMAGE_LIMITS.fadeSeconds, IMAGE_LIMITS.fadeSeconds.default)
  };
}

/** Shared style switching for the editor and partial MCP mutations. */
export function captionPresetPatch(caption: ClipCaption, presetId: string): Partial<ClipCaption> | null {
  const customBackground = presetId === 'custom-background';
  const alreadyBackground = isBackgroundCaption(caption);
  const preset = CAPTION_PRESETS.find((item) => item.id === presetId) ??
    (customBackground && !alreadyBackground ? CAPTION_PRESETS.find((item) => item.id === 'behind-subject') : undefined);
  if (!preset && presetId !== 'custom' && !customBackground) return null;
  const behind = preset?.group === 'background' || customBackground;
  const leavingBehind = !behind && isBackgroundCaption(caption);
  return {
    ...(leavingBehind ? {
      ...CAPTION_PRESETS[0].style,
      fontScale: DEFAULT_CAPTION.fontScale,
      bottomMargin: DEFAULT_CAPTION.bottomMargin
    } : {}),
    ...preset?.style,
    ...(preset ? { animation: preset.style.animation ?? 'none' } : {}),
    style: behind ? 'behind-subject' : 'classic',
    stylePreset: customBackground ? 'custom-background' : presetId
  };
}

/** `2×`, `0.5×`, `1×` — the label used everywhere a rate is shown. */
export function speedLabel(speed: number): string {
  return `${speed % 1 === 0 ? speed : speed.toFixed(1)}×`;
}
