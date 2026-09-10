import { DEFAULT_TRANSITION_COLOUR, DEFAULT_TRANSITION_KIND, TRANSITION_SECONDS } from './video-transitions';
import { DEFAULT_TAG } from './tag-overlay';
import { DEFAULT_AUTO_ZOOM } from '../../shared/media/auto-zoom';
import { DEFAULT_LOUDNESS } from '../../shared/media/loudness';
import { AUDIO_FORMATS, VIDEO_FORMATS } from '../juntador-de-midias/media-merger-formats';
import { settingsForPreset } from '../cortador-de-silencio/silence-cutter-presets';
import {
  ClipCaption,
  ClipEdits,
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
  fontScale: { min: 0.02, max: 0.12, step: 0.005 },
  bottomMargin: { min: 0, max: 0.3, step: 0.005 },
  outlinePercent: { min: 0, max: 30, step: 1 },
  fadeSeconds: { min: 0.1, max: 5, step: 0.1 }
} as const;

export const CAPTION_FONTS: readonly { value: NonNullable<ClipCaption['fontFamily']>; label: string }[] = [
  { value: 'sans', label: 'Clean sans serif' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'serif', label: 'Editorial serif' },
  { value: 'mono', label: 'Monospace' }
];

export const CAPTION_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;

export const CAPTION_PRESETS: readonly { id: string; label: string; style: Partial<ClipCaption> }[] = [
  { id: 'classic', label: 'Classic · white, black outline + shadow', style: { fontFamily: 'sans', fontWeight: 700, italic: false, textColor: '#ffffff', outlineColor: '#000000', outlinePercent: 16, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'white-clean', label: 'Clean · white, black outline', style: { fontFamily: 'sans', fontWeight: 700, italic: false, textColor: '#ffffff', outlineColor: '#000000', outlinePercent: 16, shadowEnabled: false, shadowColor: '#000000' } },
  { id: 'yellow-shadow', label: 'Yellow · black outline + shadow', style: { fontFamily: 'sans', fontWeight: 800, italic: false, textColor: '#ffd928', outlineColor: '#000000', outlinePercent: 17, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'yellow-clean', label: 'Yellow · black outline', style: { fontFamily: 'sans', fontWeight: 800, italic: false, textColor: '#ffd928', outlineColor: '#000000', outlinePercent: 17, shadowEnabled: false, shadowColor: '#000000' } },
  { id: 'black-white-shadow', label: 'Black · white outline + shadow', style: { fontFamily: 'sans', fontWeight: 800, italic: false, textColor: '#000000', outlineColor: '#ffffff', outlinePercent: 17, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'black-white-clean', label: 'Black · white outline', style: { fontFamily: 'sans', fontWeight: 800, italic: false, textColor: '#000000', outlineColor: '#ffffff', outlinePercent: 17, shadowEnabled: false, shadowColor: '#000000' } },
  { id: 'cyan', label: 'Cyan · navy outline + shadow', style: { fontFamily: 'rounded', fontWeight: 800, italic: false, textColor: '#54e7ff', outlineColor: '#071a38', outlinePercent: 18, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'pink', label: 'Pink · plum outline + shadow', style: { fontFamily: 'rounded', fontWeight: 800, italic: false, textColor: '#ff82d8', outlineColor: '#3a082e', outlinePercent: 18, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'lime', label: 'Lime · black outline', style: { fontFamily: 'sans', fontWeight: 900, italic: false, textColor: '#baff3c', outlineColor: '#000000', outlinePercent: 18, shadowEnabled: false, shadowColor: '#000000' } },
  { id: 'editorial', label: 'Editorial · warm white serif', style: { fontFamily: 'serif', fontWeight: 700, italic: false, textColor: '#fff4dc', outlineColor: '#24180e', outlinePercent: 10, shadowEnabled: true, shadowColor: '#000000' } },
  { id: 'mono', label: 'Tech · green monospace', style: { fontFamily: 'mono', fontWeight: 700, italic: false, textColor: '#8dffad', outlineColor: '#07150c', outlinePercent: 13, shadowEnabled: true, shadowColor: '#000000' } }
];

export const DEFAULT_CAPTION: ClipCaption = {
  text: '',
  fontScale: 0.045,
  bottomMargin: 0.06,
  stylePreset: 'classic',
  fontFamily: 'sans',
  fontWeight: 700,
  italic: false,
  textColor: '#ffffff',
  outlineColor: '#000000',
  outlinePercent: 16,
  shadowEnabled: true,
  shadowColor: '#000000',
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
  revealSeconds: 2.5,
  holdSeconds: 2,
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
  if (!characters) return TEXT_HOLD_FLOOR;

  return Math.min(TEXT_HOLD_CEILING, Math.max(TEXT_HOLD_FLOOR, TEXT_HOLD_FLOOR + characters / READING_RATE));
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

  return {
    ...caption,
    fontScale: clamp(caption.fontScale, CAPTION_LIMITS.fontScale),
    bottomMargin: clamp(caption.bottomMargin, CAPTION_LIMITS.bottomMargin),
    outlinePercent: clamp(caption.outlinePercent ?? DEFAULT_CAPTION.outlinePercent ?? 16, CAPTION_LIMITS.outlinePercent),
    fadeSeconds: clamp(caption.fadeSeconds, CAPTION_LIMITS.fadeSeconds)
  };
}

/** `2×`, `0.5×`, `1×` — the label used everywhere a rate is shown. */
export function speedLabel(speed: number): string {
  return `${speed % 1 === 0 ? speed : speed.toFixed(1)}×`;
}
