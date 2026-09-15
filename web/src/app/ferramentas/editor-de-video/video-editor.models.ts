/**
 * Types shared by every layer of the Video Editor.
 *
 * Three ideas hold the whole tool together.
 *
 * The first is that **the list is the timeline**: clips play in the order they
 * are shown, back to back, and nothing else decides when anything happens.
 *
 * The second is that **a setting has exactly one home**. Inheritable controls
 * live in {@link ClipEdits}, and a clip either follows the project's copy or
 * owns a complete copy of its own — `overrides` is never a matrix of partial
 * flags. Features that are intentionally clip-only, such as noise suppression,
 * live directly on the media clip and cannot accidentally become a project
 * default.
 *
 * The third is that **time is in seconds**, always, and that there are two
 * clocks: *source* time, which is a position inside a file the reader added,
 * and *output* time, which is a position in the finished video. Every field
 * below says which one it means, because mixing them is the only way this tool
 * can go quietly wrong.
 */

import type { ClipTag } from './tag-overlay';
import type { TransitionKind } from './video-transitions';
import type { TextAnimation } from '../criador-de-video-texto/text-video.models';
import type { AutoZoomSettings, ZoomSegment } from '../../shared/media/auto-zoom';
import type { LoudnessSettings } from '../../shared/media/loudness';
import type { MediaSummary, ResolutionPreset } from '../juntador-de-midias/media-merger.models';
import type {
  EditableRange,
  MediaInfo,
  SilenceAnalysis,
  SilenceSettings,
  TimeRange
} from '../cortador-de-silencio/silence-cutter.models';
import type { AnalysisSettings, NoiseReport } from '../supressao-de-ruido/noise-analysis';
import type { ClipNoiseSettings } from './clip-noise';
import type { VideoEffect } from './video-effects';

export type { EditableRange, MediaInfo, SilenceAnalysis, SilenceSettings, TimeRange };
export type { MediaSummary, ResolutionPreset };
export type { AutoZoomSettings, LoudnessSettings, ZoomSegment };
export type { TextAnimation };

/**
 * Where the sound of a clip comes from.
 *
 * `continue` is what makes one supplied track span several clips: the clip
 * takes no sound of its own and instead picks up the file an earlier clip
 * started, from exactly where that clip left it. It is how a piece of music
 * chosen once plays across a whole sequence without being cut and re-attached
 * for every shot.
 */
export type ClipAudioMode = 'original' | 'replace' | 'continue' | 'mute';

/**
 * The sound one clip will actually be given, resolved against its neighbours.
 *
 * `audioMode` alone cannot answer this: "continue" only means something in the
 * light of what came before, and a clip asking to be replaced with a file it
 * has not been given has to fall back to something. The timeline settles all of
 * that once, in order, so the renderer never has to look at another clip.
 */
export type ClipSoundPlan =
  | { kind: 'original' }
  | { kind: 'mute' }
  | { kind: 'file'; file: File; label: string; offset: number };

/** A timed text layer carried by an individual media clip. */
export interface ClipCaption {
  /** Stable identity when a clip carries more than one caption. */
  id?: string;
  text: string;
  /** Position and lifetime on the source clip's clock. Older captions omit both and fill the clip. */
  startSeconds?: number;
  durationSeconds?: number;
  /** Kept true until the reader explicitly changes the suggested reading time. */
  durationAutomatic?: boolean;
  /** Type size as a share of the frame height, so it survives a change of resolution. */
  fontScale: number;
  /** Gap kept below the text, as a share of the frame height. */
  bottomMargin: number;
  /** A named shortcut while its visual values still match a preset. */
  stylePreset?: string;
  /** Classic text-over-picture, or text composited below a segmented subject. */
  style?: 'classic' | 'behind-subject';
  /** Browser-local font family; the renderer maps it to a deterministic stack. */
  fontFamily?: 'sans' | 'rounded' | 'serif' | 'mono' | 'impact' | 'display' | 'geometric' | 'slab' | 'handwritten';
  fontWeight?: number;
  italic?: boolean;
  textColor?: string;
  outlineColor?: string;
  /** Outline thickness as a percentage of the font size. */
  outlinePercent?: number;
  shadowEnabled?: boolean;
  shadowColor?: string;
  /** Behind-subject placement, expressed as shares of the finished frame. */
  positionX?: number;
  positionY?: number;
  rotationDegrees?: number;
  shadowBlurPercent?: number;
  shadowOpacity?: number;
  uppercase?: boolean;
  /** Optional, deliberately subtle motion for background captions. */
  animation?: 'none' | 'zoom-in' | 'zoom-out' | 'scroll-left' | 'scroll-right' | 'scroll-up' | 'scroll-down';
  fadeIn: boolean;
  fadeOut: boolean;
  /** Length of each of the caption's own fades, in seconds. */
  fadeSeconds: number;
}

/** A container-only Video Effect placed on the source clip's clock. */
export interface ClipVideoEffect {
  /** Stable identity when a clip carries more than one effect. */
  id?: string;
  effectId: string;
  intensity: number;
  /** Omitted together, these two fields mean the whole source clip. */
  startSeconds?: number;
  durationSeconds?: number;
  /**
   * How long the effect takes to arrive and to leave, in source seconds.
   *
   * Zero, the default, is a cut: the effect is fully on at the first frame of
   * the section and fully off at the first frame after it. Anything above zero
   * ramps it in and out over that many seconds at each end, which is what makes
   * a filter enter a shot without a visible step. Clamped to half the section,
   * so the two ramps can never meet and leave the effect never reaching full
   * strength without saying so.
   */
  fadeSeconds?: number;
}

/**
 * Where a placed picture's bytes come from.
 *
 * Shaped like {@link SuppliedSound} on purpose: a project never stores media
 * bytes, only enough to recognise the file again, so a picture placed on a clip
 * is found after a reload exactly the way a soundtrack is. `file` is a
 * zero-length stand-in while `awaitingFile` is true, and the relink hands the
 * real bytes back without the placement itself ever changing.
 */
export interface ClipImageSource {
  file: File;
  /** What to call it in the panel and in the render log. */
  name: string;
  /** Natural pixel size, measured once on attachment so the panel can shape a preview. */
  width: number;
  height: number;
  /** Absolute local path for Electron path-backed pictures. Never contains bytes. */
  sourcePath?: string;
  /** The key this browser filed a durable reference to the file under. */
  handleId?: string;
  /** How the file is recognised again after a reload. */
  fileRef?: { name: string; size: number; lastModified: number; path?: string };
  /** True while `file` is an empty stand-in rather than the reader's picture. */
  awaitingFile?: boolean;
}

/** How a placed picture sits against a segmented person. */
export type ClipImageStyle = 'overlay' | 'behind-subject';

/**
 * A picture placed over a stretch of one container, on that container's own
 * source clock.
 *
 * Deliberately the same shape as {@link ClipCaption}: a clip may carry any
 * number of them, each with its own interval, its own fade and its own
 * placement, and nothing here is ever inherited from the project or from
 * another container.
 */
export interface ClipImage {
  /** Stable identity when a clip carries more than one picture. */
  id?: string;
  source: ClipImageSource;
  /** Position and lifetime on the source clip's clock. Omitted means the whole clip. */
  startSeconds?: number;
  durationSeconds?: number;
  /**
   * Over everything, or composited below the person.
   *
   * `behind-subject` puts the picture in the same middle layer a background
   * caption uses: in front of the scenery, behind whoever is talking. When no
   * person is found the picture simply stays visible, which is the same
   * fallback the background captions take.
   */
  style?: ClipImageStyle;
  /** Centre of the picture, as shares of the finished frame. */
  positionX?: number;
  positionY?: number;
  /**
   * Width as a share of the frame width. The aspect ratio is always kept, so
   * one number is the whole size control.
   */
  scale?: number;
  rotationDegrees?: number;
  /** Steady opacity, separate from the fades at the two ends. */
  opacity?: number;
  /**
   * How long the picture takes to arrive and to leave, in source seconds.
   *
   * Zero is a cut. Clamped to half the section, so the two ramps can never
   * meet and leave the picture never reaching full strength without saying so.
   */
  fadeSeconds?: number;
}

/**
 * Everything a clip inherits from the project, or overrides for itself.
 *
 * `silence` carries the automatic zoom inside it, since the zoom is planned
 * from what the silence detection removed and the two are meaningless apart.
 */
export interface ClipEdits {
  /** Remove the detected silences from this clip. */
  cutSilence: boolean;
  silence: SilenceSettings;
  fadeIn: boolean;
  fadeOut: boolean;
  /** Length of each fade, in seconds, before it is clamped to the clip. */
  fadeSeconds: number;
  /** Playback rate. 2 means the clip lasts half as long. */
  speed: number;
  audioMode: ClipAudioMode;
  /**
   * How loud this clip plays, as a percentage. 100 leaves it exactly as it is.
   *
   * Deliberately *not* a replacement for levelling. Levelling exists to make
   * clips agree with one another and is measured from what was actually
   * recorded; this is the reader saying "that one take is still too quiet", and
   * it is applied on top of whatever levelling decided. So the default is 100
   * and the honest reading of that is "whatever the clip already was — its own
   * loudness, or the levelled one when levelling is on".
   */
  volumePercent: number;
}

/**
 * A sound file the reader chose, and where in it the sound actually begins.
 *
 * `trimStart` is measured once, when the file is attached: recordings and
 * exported music routinely open with a fraction of a second — sometimes several
 * — of digital silence, and a soundtrack that starts by not playing reads as a
 * bug in the editor rather than as a property of the file. Every offset into
 * the file is taken from here rather than from zero, so nothing else in the
 * timeline has to know about it.
 */
export interface SuppliedSound {
  file: File;
  summary: MediaSummary;
  /** Seconds of silence at the head of the file, measured on attachment. */
  trimStart?: number;
  /** False when the reader would rather hear the file exactly as it is. */
  skipLeadingSilence?: boolean;
  /**
   * The key this browser filed a durable reference to the file under.
   *
   * Written into a settings document so that opening it later can offer to
   * reopen the music with one permission question. It is the nearest thing to
   * the file's path that a page is allowed to keep — the path itself is never
   * handed to a browser — and it is sturdier in one way, since a reference
   * follows a file that has been renamed and a path does not.
   */
  handleId?: string;
  /**
   * The file as it was written down, absolute path included when it had one.
   *
   * A restored sound is a zero-byte placeholder, and without this it is a
   * placeholder with no way home: the name and length survive the save, the
   * path did not, and the export then handed an empty blob to the demuxer and
   * reported an unrecognizable format. Keeping the reference is what lets the
   * music be reopened from disk.
   */
  fileRef?: { name: string; size: number; lastModified: number; path?: string };
}

/** Where reading this file should begin, in seconds. */
export function soundStart(sound: SuppliedSound): number {
  return sound.skipLeadingSilence === false ? 0 : Math.max(0, sound.trimStart ?? 0);
}

/** How much of the file is left once the silence at its head is skipped. */
export function soundUsableDuration(sound: SuppliedSound): number {
  return Math.max(0, sound.summary.durationSeconds - soundStart(sound));
}

/**
 * How a supplied soundtrack enters and leaves.
 *
 * Kept apart from {@link ClipEdits.fadeIn} because they answer different
 * questions. A clip's fade is about that clip — it takes the picture down with
 * the sound, and it happens at a cut. This is about the *track*: a piece of
 * music laid over six shots should rise once at the beginning and fall once at
 * the end, not six times, and it should do that without dimming the picture.
 *
 * One setting for the whole project rather than one per clip, because a run of
 * clips playing one file is one piece of music, and the planner already knows
 * where each such run begins and ends.
 */
export interface SoundFade {
  fadeIn: boolean;
  fadeOut: boolean;
  /** Seconds at each end of a run, before it is clamped to the run's length. */
  seconds: number;
}

/** What the reader sets once for the whole project. */
export interface ProjectSettings {
  /** The defaults every clip follows until it is given its own copy. */
  edits: ClipEdits;
  /** Levelling is project-wide by nature: it exists to make clips agree. */
  loudness: LoudnessSettings;
  /**
   * The soundtrack a clip falls back to when it is set to be replaced and has
   * been given nothing of its own.
   *
   * It is what makes "replace the sound" meaningful as a project-wide setting:
   * without it the instruction would apply to every clip and every clip would
   * ignore it for want of a file.
   */
  defaultAudio: SuppliedSound | null;
  /**
   * Share of a clip detected as silence above which its remaining original
   * sound is treated like a missing soundtrack and the project sound fills in.
   * Stored as 0..1; 0.8 means more than eighty percent.
   */
  silentCutReplacementThreshold: number;
  /** How any supplied soundtrack rises at its start and falls at its end. */
  soundFade: SoundFade;
  /**
   * A transition placed between every pair of shots that has none of its own.
   *
   * Null means the cuts stay cuts. This is the setting for a project with one
   * house style throughout; a transition added by hand between two particular
   * shots overrides it at that join and nowhere else.
   */
  defaultTransition: TransitionSettings | null;
  /**
   * The tag a clip starts from, when one is added to it.
   *
   * A *template*, not an inheritance. Nothing on the timeline wears this by
   * default — a badge appearing on every clip because the project has one
   * configured would be the tool putting words on somebody's footage — and a
   * clip given a tag takes a copy of this and then owns it. Changing the copy
   * never reaches back here, and changing this never reaches a tag that has
   * already been placed.
   *
   * That is deliberately unlike the default transition next door, which really
   * is applied everywhere. A transition is a join and has no content; a tag has
   * text, and text is the kind of thing that has to be asked for.
   */
  defaultTag: ClipTag;
  resolution: ResolutionPreset;
  /**
   * The proportion of the finished frame.
   *
   * Applied after the resolution has been settled, and expressed as a shape
   * rather than as a size, so "vertical" means the same thing whether the
   * footage behind it is 4K or a phone clip.
   */
  aspect: FrameAspect;
  /** Whether a picture of another shape is cropped to fill the frame, or boxed inside it. */
  reframe: ReframeFit;
  /**
   * How long each clip recognised as a timelapse should last, in seconds.
   *
   * Zero switches the whole thing off, and is the default: a project that has
   * never heard of this behaves exactly as it did before it existed.
   *
   * The target is **per clip**, not for the project: two timelapses on the
   * timeline with a target of ten seconds produce twenty seconds of video. That
   * is the reading that makes each take carry the same weight in the edit,
   * which is what somebody shortening a folder of timelapses is after.
   *
   * It only ever reaches a clip whose `summary.isTimelapse` is true. Ordinary
   * footage is never sped up behind the reader's back.
   */
  timelapseTargetSeconds: number;
  videoFormatId: string;
  audioFormatId: string;
}

/**
 * A push-in the reader placed themselves, in **source** time.
 *
 * The automatic zoom reads the pauses and decides for itself, which is the
 * right answer for a talking head and no answer at all for "hold on that
 * diagram for four seconds". So the two live side by side rather than one
 * replacing the other: the planner emits the automatic segments first and then
 * these, and a manual zoom is never invalidated by listening to the clip again
 * because nothing about it was inferred.
 *
 * Source time, like `manualCuts`, for the same reason: it is a position in the
 * file the reader is looking at, and it has to survive a change to the cuts.
 */
export interface ManualZoom {
  id: string;
  /** Where the push-in begins, in source seconds. */
  start: number;
  /** Where it ends, in source seconds. */
  end: number;
  /** How far in, as a percentage of the frame. 15 draws the picture 15% larger. */
  scalePercent: number;
  /** How long the move takes at each end, in seconds. */
  rampSeconds: number;
  /** False keeps the framing to the end of the segment instead of easing back. */
  easeOut: boolean;
}

/**
 * The shape of the finished video.
 *
 * `source` is what the tool has always done: the size comes from the footage or
 * from the resolution preset. The other two reframe — the output takes the new
 * proportion and the picture is fitted into it, cropped or letterboxed
 * according to {@link ProjectSettings.reframe}.
 */
export type FrameAspect = 'source' | '9:16' | '1:1';

/** What happens to a picture whose shape does not match the frame's. */
export type ReframeFit = 'fill' | 'fit';

/** One piece of footage, audio or still image on the timeline. */
export interface MediaClip {
  kind: 'media';
  /** Stable across reordering, so the list can be tracked without index churn. */
  id: string;
  file: File;
  /** Absolute local path for Electron path-backed media. Never contains bytes. */
  sourcePath?: string;
  summary: MediaSummary;
  /**
   * The deeper inspection the analyser needs, fetched the first time this clip
   * is analysed rather than when it is added: probing a queue of thirty files
   * twice over is a visible delay for something most clips never use.
   */
  info: MediaInfo | null;
  /**
   * What this clip's file was called and how long it was, when the project was
   * restored from storage and the bytes have not been handed back yet.
   *
   * The browser is not allowed to reopen a file on its own, so a project that
   * survives a reload survives without its media. The clip is complete in every
   * other respect and `awaitingFile` says so; dropping the same files in again
   * matches them by this and the edit continues.
   */
  fileRef?: { name: string; size: number; lastModified: number; path?: string };
  /** True while `file` is an empty stand-in rather than the reader's media. */
  awaitingFile?: boolean;
  /** `null` means "follow the project"; anything else is this clip's own copy. */
  overrides: ClipEdits | null;
  /** Silences the detector found, with whatever the reader turned off. Source time. */
  detected: EditableRange[];
  /** Stretches the reader drew by hand on the waveform. Source time, never inherited. */
  manualCuts: EditableRange[];
  /**
   * Where this clip starts reading its file, in source seconds. Undefined is 0.
   *
   * Kept apart from `manualCuts`, even though the planner ends up treating both
   * as material that does not survive, because they mean different things: a
   * hand-drawn cut is a hole in the middle of a take and a transition may never
   * buy it back, whereas the in point is where the take *begins* — everything
   * before it was never part of this clip at all. It is also what a split is
   * made of, which is why the two halves of a split clip can share one `File`
   * and one analysis without sharing a single second of footage.
   */
  inPoint?: number;
  /** Where it stops reading, in source seconds. Undefined is the end of the file. */
  outPoint?: number;
  /** Push-ins the reader placed by hand. Source time, never inherited. */
  manualZooms?: ManualZoom[];
  /**
   * True when this clip's speed was worked out from the timelapse target rather
   * than chosen by hand.
   *
   * It is what lets the target be recalculated — the clip trimmed, the target
   * changed — without ever overwriting a speed somebody set themselves. The
   * moment they touch the speed control this turns false and the algorithm
   * stops having an opinion about this clip.
   */
  speedFromTimelapse?: boolean;
  analysis: SilenceAnalysis | null;
  /** The settings `analysis` was produced with, so a change can invalidate it. */
  analyzedWith: SilenceSettings | null;
  /** Sound that replaces this clip's own, when the audio mode says so. */
  replacementAudio: SuppliedSound | null;
  /** Per-clip only. Checking it schedules suppression for export; it never processes immediately. */
  noiseSuppression?: ClipNoiseSettings;
  /** Timed, independent container appearances; never inherited from project defaults. */
  videoEffects?: ClipVideoEffect[];
  /** Legacy whole-clip appearance, retained only to open older projects. */
  videoEffect?: VideoEffect;
  /** Last diagnostic result, retained so an AI can compare every clip without guessing. */
  noiseReport?: NoiseReport | null;
  /** The diagnostic settings used for {@link noiseReport}. */
  noiseAnalyzedWith?: AnalysisSettings | null;
  /** Derived session cache. Never serialized; export rebuilds it after a restart. */
  noiseCleanedAudio?: File | null;
  /** Settings that produced {@link noiseCleanedAudio}. */
  noiseCleanedWith?: ClipNoiseSettings | null;
  /** Object URL used only by the before/after dialog. */
  noiseCleanedUrl?: string | null;
  /** Measured quiet-region change from the most recent suppression pass. */
  noiseReductionDb?: number | null;
  /** Timed, independent placed pictures; never inherited from project defaults. */
  images?: ClipImage[];
  /** Timed captions. `caption` below is retained only to open older projects. */
  captions?: ClipCaption[];
  caption: ClipCaption | null;
  /**
   * The animated tag this clip wears, if any.
   *
   * Optional rather than nullable-and-required because it arrived after
   * documents were already being written: a project saved by an older build has
   * no such key, and the restore reads the absence as "no tag" rather than
   * having to be taught about it.
   */
  tag?: ClipTag | null;
  /** Object URL for the inline preview, created only when it is opened. */
  previewUrl: string | null;
  /**
   * A still from the clip, drawn on its row.
   *
   * A data URL rather than an object URL: it is a few kilobytes of JPEG that
   * outlives nothing in particular, and one fewer handle to remember to revoke
   * when a clip is removed.
   */
  thumbUrl: string | null;
}

/**
 * A full-screen text card standing on the timeline in its own right.
 *
 * Stored as a draft rather than as a finished `TextScene` because a scene holds
 * a decoded image and a pixel size, and neither survives being kept in a list
 * for an hour while the reader rearranges things. The scene is built from this,
 * at the output's size, at the moment it is drawn.
 */
export interface TextClipDraft {
  text: string;
  fontId: string;
  fontScale: number;
  fontWeight: number;
  color: string;
  backgroundColor: string;
  align: 'left' | 'center' | 'right';
  vertical: 'top' | 'middle' | 'bottom';
  margin: number;
  letterSpacing: number;
  lineHeight: number;
  legibility: 'none' | 'shadow' | 'outline' | 'band';
  /**
   * Imported rather than restated.
   *
   * This union used to be written out here as well, so every animation added to
   * the text tool had to be remembered in a second place — and a card built with
   * one the editor had not heard of would fail to type-check for no reason a
   * reader could see.
   */
  animation: TextAnimation;
  revealSeconds: number;
  holdSeconds: number;
  /**
   * Whether the hold follows the length of the text.
   *
   * A card is on screen to be *read*, and how long that takes depends entirely
   * on how much there is — two words and a paragraph are not the same shot. So
   * the hold is computed from the text by default and keeps up as it is typed;
   * the moment the reader sets the field themselves this turns off and stays
   * off, because a number that quietly rewrites itself is worse than one that
   * needs adjusting.
   */
  holdAuto?: boolean;
}

export interface TextClip {
  kind: 'text';
  id: string;
  draft: TextClipDraft;
  /** Optional photograph behind the text. */
  backgroundFile: File | null;
  backgroundUrl: string | null;
  /** What that photograph was called, when the project came back without it. */
  backgroundRef?: { name: string; size: number; lastModified: number };
  /**
   * Sound chosen for this card.
   *
   * A title has no soundtrack of its own to keep or replace, but it is still a
   * place where music belongs — an opening card over a theme, a chapter break
   * over a sting. So it takes a file the same way a clip does, and the same
   * three answers are open to it: this one, the project's, or the track the
   * previous clip was already playing.
   */
  replacementAudio: SuppliedSound | null;
  /** Text cards take fades and speed like anything else; cuts mean nothing here. */
  overrides: ClipEdits | null;
  /**
   * The animated tag this clip wears, if any.
   *
   * Optional rather than nullable-and-required because it arrived after
   * documents were already being written: a project saved by an older build has
   * no such key, and the restore reads the absence as "no tag" rather than
   * having to be taught about it.
   */
  tag?: ClipTag | null;
}

/**
 * How one shot becomes the next.
 *
 * `seconds` is asked for rather than promised. A transition is paid for out of
 * the silence at the end of the shot before it and the start of the one after —
 * silence the cut would otherwise have thrown away — and when there is not
 * enough of it the animation plays over real content instead. The planner
 * records what actually happened; this is only the request.
 */
export interface TransitionSettings {
  kind: TransitionKind;
  seconds: number;
  /** Used by the drawn animations, ignored by the rest. Always one colour. */
  colour: string;
}

/**
 * A transition, sitting on the timeline between two shots.
 *
 * It is a row in the list rather than a property of the clip after it, because
 * that is what it is to the reader: a thing they put *between* two others, drag
 * around, open and change. It is deliberately not a clip in the finished video —
 * the planner never gives it a place of its own, it makes its two neighbours
 * overlap instead — so a transition takes up room in the editor and no room at
 * all in the export.
 *
 * The rule that it must have a neighbour on each side is enforced where clips
 * are added and reordered, not here: a type cannot say "not first, not last, and
 * never next to another one of me".
 */
export interface TransitionClip {
  kind: 'transition';
  id: string;
  settings: TransitionSettings;
}

export type EditorClip = MediaClip | TextClip | TransitionClip;

/** Anything that occupies time in the finished video: everything but a transition. */
export type PlayableClip = MediaClip | TextClip;

export function isMediaClip(clip: EditorClip): clip is MediaClip {
  return clip.kind === 'media';
}

export function isTextClip(clip: EditorClip): clip is TextClip {
  return clip.kind === 'text';
}

export function isTransitionClip(clip: EditorClip): clip is TransitionClip {
  return clip.kind === 'transition';
}

/** True for the clips that become part of the finished video. */
export function isPlayable(clip: EditorClip): clip is PlayableClip {
  return clip.kind !== 'transition';
}

/** One ramp on the **output** timeline. */
export interface FadeSegment {
  start: number;
  end: number;
  kind: 'in' | 'out';
}

/** A caption placed on the output timeline, ready to be drawn. */
export interface CaptionSegment {
  start: number;
  end: number;
  caption: ClipCaption;
}

/** A placed picture translated onto the output timeline, ready to be drawn. */
export interface ImageSegment {
  start: number;
  end: number;
  image: ClipImage;
  /** Needed only when two clips share an instant during a transition. */
  clipId: string;
  /** Already in output seconds, so the clip's speed is accounted for. */
  fadeSeconds: number;
}

/** A Video Effect translated onto the output timeline, ready to be rendered. */
export interface VideoEffectSegment {
  start: number;
  end: number;
  effect: VideoEffect;
  /** Needed only when two clips share an instant during a transition. */
  clipId: string;
  /** Already in output seconds, so a clip's speed is accounted for. */
  fadeSeconds: number;
}

/**
 * A tag placed on the output timeline, ready to be drawn.
 *
 * `start` is when the tag *arrives*, not when its clip does — the whole point of
 * the feature is that it turns up a second or two in. Everything the painter
 * animates is measured from there, so the reader hands it `time - start` and
 * nothing has to know which clip the tag belonged to.
 */
export interface TagSegment {
  start: number;
  end: number;
  tag: ClipTag;
}

/** What one clip contributes to the finished file. */
export interface ClipPlan {
  /**
   * Never a transition: those have no place of their own in the finished video,
   * they are the reason two of these overlap.
   */
  clip: PlayableClip;
  edits: ClipEdits;
  /** Stretches of the source that survive, in **source** time. */
  keepRanges: TimeRange[];
  /** Their total length, before speed is applied. */
  keptDuration: number;
  /** Where this clip begins in the finished file. */
  outputStart: number;
  /** How long it lasts there, after cuts and speed. */
  outputDuration: number;
  /** Seconds of source this clip threw away. */
  removedDuration: number;
  /** Where its sound comes from, once the whole timeline has been read. */
  sound: ClipSoundPlan;
  /**
   * True when the supplied file cannot cover this clip from where it is read.
   *
   * A soundtrack laid across a run of clips is finite, and the clip where it
   * runs out plays part of itself in silence — which is invisible until the
   * export is watched. It is worth saying on the row instead.
   */
  soundShort: boolean;
}

/** One join, once the planner has worked out what it could actually afford. */
export interface TransitionPlan {
  /**
   * The transition row that produced this join, or null for the project default.
   *
   * Kept so the editor can point at exactly the row that is in effect. Matching
   * by neighbour instead breaks the moment two transitions end up side by side,
   * where only the later one is used — and the reader is then told that the one
   * doing the work is doing nothing.
   */
  clipId: string | null;
  /** Index into `ProjectPlan.clips` of the shot being left. */
  fromIndex: number;
  /** Index into `ProjectPlan.clips` of the shot being arrived at. Always `fromIndex + 1`. */
  toIndex: number;
  settings: TransitionSettings;
  /** Where the overlap begins in the finished video. */
  start: number;
  /** Where it ends. `end - start` is what the animation really got. */
  end: number;
  /**
   * The instant, in output time, at which the sound changes hands.
   *
   * The picture dissolves across the whole join; the sound cannot, because there
   * is no mixing bus here — one clip's samples are written and then the next
   * one's. So the question is only *when*, and the answer depends on what the
   * arriving shot is playing:
   *
   * - a file of its own starts with the shot, so the sound changes at the very
   *   beginning of the join, or the file would lose its first moments;
   * - its own sound starts where the silence bought back for the animation runs
   *   out, so the outgoing shot keeps talking until the incoming one does;
   * - nothing at all, and the outgoing shot plays through to the end of the join.
   *
   * Getting this wrong is not subtle: the version that always changed hands at
   * the end of the join wrote the outgoing clip's restored room tone over the
   * first syllable of every incoming one.
   */
  soundSwitch: number;
  /**
   * Seconds of the overlap paid for out of silence the cut would have removed.
   *
   * The rest is played over real content. Worth knowing because it is the
   * difference between a transition nobody notices and one that talks over the
   * first word of the next sentence.
   */
  fromSilence: number;
  /** True when the animation is playing over content rather than over silence. */
  overContent: boolean;
}

/** The whole finished timeline, decided before a single byte is encoded. */
export interface ProjectPlan {
  clips: ClipPlan[];
  width: number;
  height: number;
  frameRate: number;
  sampleRate: number;
  channelCount: number;
  totalDuration: number;
  /** Length of everything, before any cut or speed change. */
  sourceDuration: number;
  removedDuration: number;
  cutCount: number;
  /** Ramps applied to the picture — and to a clip's own sound. */
  fades: FadeSegment[];
  /**
   * The subset of `fades` that may touch the sound.
   *
   * A clip that is carrying on the previous clip's soundtrack contributes
   * nothing here: its fade is about the shot, and dipping a piece of music that
   * is playing straight through the cut would be heard as a fault rather than
   * as an edit. The picture still fades.
   */
  audioFades: FadeSegment[];
  /** Every automatic zoom, already translated into output time. */
  zooms: ZoomSegment[];
  captions: CaptionSegment[];
  /**
   * Every placed picture, already translated into output time.
   *
   * Optional for the same reason `videoEffects` is read defensively: plans are
   * also built by hand, by the specs and by integrations written before this
   * existed, and every reader here treats an absent list as an empty one.
   */
  images?: ImageSegment[];
  /** Every per-container effect, already translated into output time. */
  videoEffects: VideoEffectSegment[];
  /** Every tag, already placed on the output timeline. */
  tags: TagSegment[];
  /**
   * Ramps that belong to the supplied soundtrack alone.
   *
   * One pair per uninterrupted run of clips playing the same file, in output
   * time. Deliberately not merged into `fades`: those are applied to everything
   * including the picture, and these must touch nothing but the track.
   */
  soundFades: FadeSegment[];
  /**
   * Every join where two shots overlap, in output time.
   *
   * Separate from `clips` because a transition is not a place on the timeline
   * that belongs to nobody — it is a stretch where two clips are both playing,
   * and both of them still have to be findable by everything that walks the
   * plan looking for what is on screen.
   */
  transitions: TransitionPlan[];
  /** Clips with no picture the browser can draw; they play over black. */
  audioOnlyCount: number;
  /** Clips that contribute no sound; they play over real silence. */
  silentCount: number;
  /** True when at least one clip can put something on screen. */
  hasPicture: boolean;
  /**
   * True when a picture of the wrong shape is cropped rather than letterboxed.
   *
   * Carried on the plan rather than read from the project by the compositor,
   * because the preview and the encoder both draw from the plan and nothing
   * else — that is the whole reason they agree about where a zoom lands.
   */
  fillFrame: boolean;
}

/** Stages reported while rendering, in the order they run. */
export type RenderStage = 'preparing' | 'analyzing' | 'encoding' | 'muxing' | 'finishing';

export interface RenderProgress {
  stage: RenderStage;
  /** 0..1, or null when the stage genuinely cannot be measured. */
  ratio: number | null;
  /** Position of the clip being read, 1-based, for "clip 3 of 7". */
  clipIndex: number;
  clipCount: number;
  clipName: string;
}

/**
 * What one line of the render log is about.
 *
 * The kind is not decoration: it is what lets a reader skim a hundred lines and
 * find the two that matter. A step is a phase of the whole export, a clip line
 * opens the container being written, a detail belongs to whatever line opened
 * above it, and the last three are outcomes.
 */
export type RenderLogKind =
  | 'step' | 'clip' | 'detail' | 'done' | 'warn' | 'fail'
  /** Timed things inside one container, each with a colour of its own. */
  | 'effect' | 'caption' | 'image' | 'zoom' | 'tag';

/**
 * One line, as the renderer says it.
 *
 * No timestamp and no sequence number: the renderer is inside a
 * `runOutsideAngular` and has no business knowing how long the reader has been
 * watching. The page stamps each line as it arrives.
 */
export interface RenderLogEntry {
  kind: RenderLogKind;
  text: string;
  /**
   * How far the export had got when this line was written, 0..100.
   *
   * Absent before the encoder has reported anything measurable, which is every
   * line of the opening summary.
   */
  percent?: number;
}

export interface RenderResult {
  /** Null when the file was streamed straight to the location the reader chose. */
  blob: Blob | null;
  fileName: string;
  /** The full destination when one was named; null for a browser save picker. */
  filePath: string | null;
  savedToDisk: boolean;
  kind: 'video' | 'audio';
  plan: ProjectPlan;
  /**
   * True when the reader stopped the export and this file holds part of the edit.
   *
   * A stopped export used to throw away everything it had written, which for a
   * long project meant an hour of encoding lost to one mistimed click. Stopping
   * now waits for the clip in progress to finish, writes the container's index
   * and hands back a file that plays — and says here that there is more of the
   * edit where that came from.
   */
  partial: boolean;
  /**
   * The clip the next part would begin at, as an index into the plan's clips.
   *
   * Always a clip boundary: the stop is honoured *between* clips precisely so
   * that the two parts meet at a cut rather than in the middle of a shot.
   */
  nextClipIndex: number;
}

/** Raised when the reader cancels; callers treat it as a normal outcome. */
export class EditorCanceledError extends Error {
  constructor() {
    super('The render was canceled.');
    this.name = 'EditorCanceledError';
  }
}

/**
 * Raised with a message already written for the reader.
 *
 * `clipLabel` and `detail` exist because "the file could not be generated" is
 * true of every failure and useful for none of them. The label says which clip
 * the export was on when it stopped, so the reader can go and look at it; the
 * detail carries the original message and stack, kept out of sight behind a
 * disclosure so it is there when a bug has to be reported and invisible when it
 * does not.
 */
export class EditorError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    /** Which clip was being written when this happened, in words. */
    readonly clipLabel?: string,
    /** The underlying failure, verbatim, for the collapsible technical detail. */
    readonly detail?: string
  ) {
    super(message);
    this.name = 'EditorError';
  }

  /** The same error, now known to belong to a clip. */
  withClip(clipLabel: string): EditorError {
    if (this.clipLabel) return this;
    return new EditorError(this.message, this.hint, clipLabel, this.detail);
  }
}

/** Everything worth knowing about a failure, for the disclosure under it. */
export function technicalDetail(error: unknown): string {
  if (error instanceof EditorError && error.detail) return error.detail;
  if (error instanceof Error) {
    const stack = error.stack ?? '';
    return stack.includes(error.message) ? stack : `${error.name}: ${error.message}\n${stack}`;
  }
  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
}
