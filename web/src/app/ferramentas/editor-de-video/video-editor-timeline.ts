/**
 * Turning a list of clips into a finished timeline.
 *
 * Everything here is pure. The renderer asks this module one question — "what
 * does the output look like?" — and gets back an answer complete enough to
 * encode from: the size, the rate, where every clip starts, which stretches of
 * it survive, and every fade, zoom and caption already expressed in output
 * time. That separation is what lets the same plan drive the summary the reader
 * reads before pressing the button and the file that comes out of it, and it is
 * what makes the arithmetic testable without a media file in sight.
 *
 * The order of operations inside a clip is fixed and matters: **cut, then
 * speed, then place**. Cuts are measured in the source; speed compresses what
 * is left; the result is laid down after whatever came before it.
 */

import { ZoomSegment, planAutoZooms } from '../../shared/media/auto-zoom';
import { audioFormat, resolutionSize, videoFormat } from '../juntador-de-midias/media-merger-formats';
import { complementRanges, mergeEditableRanges, totalDuration } from '../cortador-de-silencio/silence-detector';
import {
  clampManualZoom,
  clampSilentCutReplacementThreshold,
  clampSoundFade,
  clampSpeed
} from './video-editor-defaults';
import { ClipTag, tagLifetime } from './tag-overlay';
import {
  CaptionSegment,
  ClipEdits,
  ClipPlan,
  ClipSoundPlan,
  EditableRange,
  EditorClip,
  FadeSegment,
  FrameAspect,
  ManualZoom,
  MediaClip,
  ProjectPlan,
  ProjectSettings,
  SoundFade,
  SuppliedSound,
  TagSegment,
  TimeRange,
  TransitionClip,
  TransitionPlan,
  TransitionSettings,
  isMediaClip,
  isPlayable,
  isTransitionClip,
  soundStart,
  soundUsableDuration
} from './video-editor.models';
import { TRANSITION_SECONDS } from './video-transitions';

/** Frame rate used when not a single clip declares one. */
const FALLBACK_FRAME_RATE = 30;
const MIN_FRAME_RATE = 1;
const MAX_FRAME_RATE = 60;

/** The size a project of nothing but text cards is composed at. */
const TEXT_ONLY_SIZE = { width: 1920, height: 1080 };

/** Shorter than this and a surviving fragment is not worth encoding. */
const EPSILON = 1e-6;

/**
 * The frame the reader asked for, worked out from the one the footage implies.
 *
 * The long side is kept and the short one recomputed, rather than the other way
 * round: a 1920×1080 project asked to go vertical becomes 1080×1920, which is
 * the size everyone means by "vertical", and not 608×1080, which is the same
 * shape at a third of the detail. Square takes the short side, because keeping
 * the long one there would invent pixels down the sides that no clip has.
 */
export function reframeSize(width: number, height: number, aspect: FrameAspect): { width: number; height: number } {
  if (aspect === 'source' || width <= 0 || height <= 0) return { width, height };

  const long = Math.max(width, height);
  const short = Math.min(width, height);

  if (aspect === '1:1') return { width: short, height: short };
  return { width: Math.round((long * 9) / 16), height: long };
}

/** Stable mode: ties keep the first value encountered on the visible timeline. */
function mostCommon<T>(values: readonly T[], keyOf: (value: T) => string): T | null {
  const counts = new Map<string, number>();
  let winner: T | null = null;
  let winningCount = 0;

  for (const value of values) {
    const key = keyOf(value);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > winningCount) {
      winner = value;
      winningCount = count;
    }
  }

  return winner;
}

/** What this clip actually uses: its own settings, or the project's. */
export function effectiveEdits(clip: EditorClip, project: ProjectSettings): ClipEdits {
  // A transition owns no settings of its own — it is a join, not a shot — so it
  // answers with the project's rather than making every caller check first.
  if (isTransitionClip(clip)) return project.edits;
  return clip.overrides ?? project.edits;
}

/** True when the clip has been given settings of its own. */
export function isOverridden(clip: EditorClip): boolean {
  return !isTransitionClip(clip) && clip.overrides !== null;
}

/** How long the clip's source material lasts, before anything is done to it. */
export function sourceDuration(clip: EditorClip): number {
  if (isMediaClip(clip)) return Math.max(0, clip.summary.durationSeconds);
  // A transition takes no time of its own: it is paid for by overlapping the
  // two shots around it, so its length lives in `ProjectPlan.transitions`.
  if (isTransitionClip(clip)) return 0;
  return Math.max(0.1, clip.draft.revealSeconds + clip.draft.holdSeconds);
}

/**
 * The stretch of the file this clip is actually made of.
 *
 * Everything else in this module works inside it. A clip with no in or out
 * point is the whole file, which is what every clip was before the points
 * existed — so the answer for an untouched project is exactly what it always
 * was, and nothing downstream needed a second code path.
 */
export function clipBounds(clip: EditorClip): TimeRange {
  const duration = sourceDuration(clip);
  if (!isMediaClip(clip)) return { start: 0, end: duration };

  const start = Math.min(Math.max(0, clip.inPoint ?? 0), duration);
  const end = Math.max(start, Math.min(clip.outPoint ?? duration, duration));
  return { start, end };
}

/** How long the clip is once its in and out points are taken into account. */
export function trimmedDuration(clip: EditorClip): number {
  const bounds = clipBounds(clip);
  return Math.max(0, bounds.end - bounds.start);
}

/** True when the reader has moved either point off the ends of the file. */
export function isTrimmed(clip: EditorClip): boolean {
  const duration = sourceDuration(clip);
  const bounds = clipBounds(clip);
  return bounds.start > EPSILON || bounds.end < duration - EPSILON;
}

/**
 * What the in and out points take off the ends, as ordinary removed ranges.
 *
 * Expressed this way so that one function — `keepRangesFor` — still answers
 * "what survives", and every reader of it (the plan, the waveform, the export,
 * the length on the card) gets trimming for nothing. They are marked `manual`
 * because that is what they are to everything that asks: a decision of the
 * reader's, which a transition is not allowed to quietly buy back.
 */
function trimmedRanges(clip: EditorClip): EditableRange[] {
  if (!isMediaClip(clip)) return [];

  const duration = sourceDuration(clip);
  const bounds = clipBounds(clip);
  const ranges: EditableRange[] = [];

  if (bounds.start > EPSILON) ranges.push({ start: 0, end: bounds.start, source: 'manual', enabled: true });
  if (bounds.end < duration - EPSILON) ranges.push({ start: bounds.end, end: duration, source: 'manual', enabled: true });

  return ranges;
}

/**
 * Every range this clip removes, whether found, drawn or trimmed off the ends.
 *
 * The sources are merged rather than concatenated because they overlap all
 * the time: the usual way to correct a detection is to draw a region over the
 * top of it, and two ranges covering the same second would otherwise be cut
 * twice and shift everything after them.
 */
export function removedRanges(clip: EditorClip, edits: ClipEdits): EditableRange[] {
  if (!isMediaClip(clip)) return [];
  // A clip that has not been listened to yet reports nothing removed, which is
  // the honest answer and also why transition handles are measured from here.

  const detected = edits.cutSilence ? clip.detected.filter((range) => range.enabled) : [];
  const manual = clip.manualCuts.filter((range) => range.enabled);
  const trimmed = trimmedRanges(clip);
  if (!detected.length && !manual.length && !trimmed.length) return [];

  return mergeEditableRanges([...detected, ...manual, ...trimmed], sourceDuration(clip)).filter(
    (range) => range.enabled
  );
}

/** What survives, in source time. A clip with no cuts is one whole range. */
export function keepRangesFor(clip: EditorClip, edits: ClipEdits): TimeRange[] {
  const duration = sourceDuration(clip);
  const removed = removedRanges(clip, edits);
  if (!removed.length) return [{ start: 0, end: duration }];

  return complementRanges(removed, duration).filter((range) => range.end - range.start > EPSILON);
}

/** Share of the source removed specifically by enabled automatic silence cuts. */
export function silenceCutRatio(clip: EditorClip, edits: ClipEdits): number {
  if (!isMediaClip(clip) || !edits.cutSilence) return 0;
  const duration = sourceDuration(clip);
  if (duration <= EPSILON) return 0;

  const detected = mergeEditableRanges(
    clip.detected.filter((range) => range.enabled),
    duration
  );
  return Math.min(1, totalDuration(detected) / duration);
}

/**
 * The whole plan.
 *
 * `kind` decides whether a picture is being produced at all: an audio-only
 * export has no size, no frame rate and no zooms, and computing them anyway
 * would put numbers in the summary that describe a file the reader is not
 * about to get.
 */
/** Ways of planning the same edit that only the preview ever asks for. */
export interface PlanOptions {
  /**
   * Plan as though the automatic silence cuts were switched off.
   *
   * For the preview's "play the pauses" checkbox, and for nothing else: the
   * export always plans with the reader's real settings. Hand-drawn cuts still
   * apply, because those were placed deliberately and are not what the reader
   * is asking to hear.
   */
  readonly ignoreSilenceCuts?: boolean;
}

/**
 * What the planner reads for a clip, after the preview's options are applied.
 *
 * Every place inside the planner that resolves a clip's settings goes through
 * here, so one flag reaches the cuts, the transition handles and the auto-zoom
 * together. Resolving them separately is how a preview ends up playing the
 * pauses while its transitions are still measured as if they were gone.
 */
function planningEdits(clip: EditorClip, project: ProjectSettings, options: PlanOptions): ClipEdits {
  const edits = effectiveEdits(clip, project);
  return options.ignoreSilenceCuts && edits.cutSilence ? { ...edits, cutSilence: false } : edits;
}

export function buildProjectPlan(
  clips: readonly EditorClip[],
  project: ProjectSettings,
  kind: 'video' | 'audio',
  options: PlanOptions = {}
): ProjectPlan {
  const media = clips.filter(isMediaClip);
  const pictures = media.filter((clip) => clip.summary.videoUsable);
  const videos = pictures.filter((clip) => clip.summary.kind === 'video');
  const chosen = resolutionSize(project.resolution);
  const sizeCandidates = (videos.length ? videos : pictures).filter(
    (clip) => (clip.summary.width ?? 0) > 0 && (clip.summary.height ?? 0) > 0
  );
  const commonSize = mostCommon(
    sizeCandidates,
    (clip) => `${clip.summary.width ?? 0}x${clip.summary.height ?? 0}`
  );

  const baseWidth = chosen?.width ?? commonSize?.summary.width ?? TEXT_ONLY_SIZE.width;
  const baseHeight = chosen?.height ?? commonSize?.summary.height ?? TEXT_ONLY_SIZE.height;
  const { width, height } = reframeSize(baseWidth, baseHeight, project.aspect ?? 'source');

  const declaredRates = videos
    .map((clip) => Math.round(clip.summary.frameRate ?? 0))
    .filter((rate) => rate > 0);
  const commonRate = mostCommon(declaredRates, (rate) => String(rate)) ?? FALLBACK_FRAME_RATE;
  const frameRate = Math.min(MAX_FRAME_RATE, Math.max(MIN_FRAME_RATE, commonRate));

  const sounded = media.filter((clip) => clip.summary.audioUsable);
  const declaredSampleRate = Math.max(0, ...sounded.map((clip) => clip.summary.sampleRate ?? 0));
  const declaredChannels = Math.max(0, ...sounded.map((clip) => clip.summary.channelCount ?? 0));

  const plans: ClipPlan[] = [];
  const fades: FadeSegment[] = [];
  const audioFades: FadeSegment[] = [];
  const zooms: ZoomSegment[] = [];
  const captions: CaptionSegment[] = [];
  const tags: TagSegment[] = [];
  /**
   * Where each uninterrupted stretch of one supplied file begins and ends.
   *
   * Collected as the clips are walked rather than worked out afterwards,
   * because "the same track, still playing" is exactly the state `carry` is
   * already keeping — a run continues while consecutive clips play the same
   * file and picks up where it left off, and ends the moment anything else
   * happens: a different file, the clip's own sound, silence, or the same file
   * started again from its beginning.
   */
  const runs: { file: File; start: number; end: number }[] = [];

  let cursor = 0;
  let removedTotal = 0;
  let cutCount = 0;
  let source = 0;

  /**
   * The supplied track a later clip may continue, and how much of it has been
   * used. It survives a clip that keeps its own sound, so a piece of music can
   * pause under an interview and resume afterwards where it stopped rather than
   * starting over.
   */
  let carry: RunningTrack | null = null;

  /**
   * The shots, without the transitions between them.
   *
   * A transition is a row in the editor and nothing at all in the finished
   * video — it is paid for by making its two neighbours overlap — so from here
   * on the timeline is only what actually plays.
   */
  const playable = clips.filter(isPlayable);
  /** The transition arriving *at* each shot, or null for a plain cut. */
  const joins = joinSettings(clips, project);
  const { handles, restored, overlaps } = silenceHandles(playable, joins, project, options);
  const transitions: TransitionPlan[] = [];

  for (const [position, clip] of playable.entries()) {
    const edits = planningEdits(clip, project, options);
    const speed = clampSpeed(edits.speed);
    const duration = sourceDuration(clip);
    // The handles put back the silence at this clip's edges that the cut would
    // have thrown away, but only as much of it as the transitions on either side
    // are about to spend. Everything downstream then treats it as ordinary kept
    // material, which is what it is.
    const keepRanges = withHandles(keepRangesFor(clip, edits), handles[position], clipBounds(clip));
    const keptDuration = totalDuration(keepRanges);
    const outputDuration = keptDuration / speed;

    const join = joins[position];
    const previous = plans[plans.length - 1];
    // Worked out with the handles, against a per-clip budget, so that the silence
    // bought back and the time spent are always the same number.
    const overlap = join && previous ? overlaps[position] : 0;
    const outputStart = Math.max(0, cursor - overlap);
    /** True when this clip arrives over the one before it rather than after it. */
    const joined = overlap > EPSILON;

    // The clip's own extent, not the file's. Two halves of a split clip share
    // one file, and counting that file twice would report a project "was" twice
    // as long as anything the reader ever put on the timeline.
    const extent = trimmedDuration(clip);
    source += extent;
    removedTotal += extent - keptDuration;
    cutCount += Math.max(0, keepRanges.length - 1);

    /**
     * The running track, wound back by the join this clip overlaps.
     *
     * The rewind is owed only when the *previous* clip was reading this same
     * track: then the two clips were both allotted the overlapping seconds and
     * the file has been consumed that much too fast. When the previous clip was
     * playing something else — its own sound, or nothing — the track was paused,
     * not double-read, and it resumes exactly where it stopped. Winding it back
     * anyway makes the music jump backwards and repeat the join's length at the
     * resume point.
     *
     * Held separately rather than written into `carry` so a clip that does not
     * read the track leaves it exactly as it found it.
     */
    const running = readingSameTrack(previous, carry) ? rewind(carry, overlap) : carry;

    let sound: ClipSoundPlan;
    // A clip's own file wins; the project's default is what makes "replace the
    // sound" mean something when it is set for everything at once. A text card
    // takes a file the same way footage does — it has no soundtrack of its own
    // to keep, but it is still a place where music belongs.
    const replacement = clip.replacementAudio ?? project.defaultAudio;
    // Anything that brings no sound of its own: footage shot with the microphone
    // off, a silent screen capture, a still photograph — and a text card, which
    // never had one to begin with.
    //
    // The card used to be excluded here, on the reasoning that a title is not
    // footage that lost its sound and so music arriving under one should be a
    // decision rather than something it inherits. That was a distinction the
    // tool was making and the reader was not: "the project's sound plays where
    // there is none" is one rule, and carving an exception out of it for one kind
    // of clip only produces a title that falls silent in the middle of a
    // soundtrack. It is still a different case from a clip silenced on purpose,
    // which is what the `mute` branch above is for.
    const mostlySilent =
      isMediaClip(clip) &&
      clip.summary.audioUsable &&
      silenceCutRatio(clip, edits) > clampSilentCutReplacementThreshold(project.silentCutReplacementThreshold);
    const silent = !isMediaClip(clip) || !clip.summary.audioUsable || mostlySilent;

    /** True when this clip picked up a track rather than starting one. */
    let continuing = false;
    /** The supplied file this clip ended up playing, for the shortfall check. */
    let playing: SuppliedSound | null = null;

    if (edits.audioMode === 'mute') {
      sound = { kind: 'mute' };
    } else if (edits.audioMode === 'replace' && replacement) {
      // The same file twice in a row is one piece of music, not two. Restarting
      // it under every clip is what "replace the sound for the whole project"
      // used to do, and it made a single track sound like a stutter; picking up
      // where the previous clip left it is the only reading that produces the
      // sound the reader chose. A *different* file plainly starts at its own
      // beginning.
      if (running && running.sound.file === replacement.file) {
        continuing = true;
        ({ plan: sound, carry } = carryInto(running, project.defaultAudio, outputDuration));
        playing = carry.sound;
      } else {
        playing = replacement;
        ({ plan: sound, carry } = openTrack(replacement, outputDuration));
      }
    } else if (edits.audioMode === 'continue' && running) {
      continuing = true;
      ({ plan: sound, carry } = carryInto(running, project.defaultAudio, outputDuration));
      playing = carry.sound;
    } else if (mostlySilent && project.defaultAudio) {
      // This clip still contains a sliver of its original sound, but after a
      // predominantly-silence cut that remnant behaves like no soundtrack at
      // all. The project sound is explicit here so a different track left
      // running by an earlier clip cannot win over the configured fallback.
      playing = project.defaultAudio;
      if (running && running.sound.file === project.defaultAudio.file) {
        continuing = true;
        ({ plan: sound, carry } = carryInto(running, project.defaultAudio, outputDuration));
        playing = carry.sound;
      } else {
        ({ plan: sound, carry } = openTrack(project.defaultAudio, outputDuration));
      }
    } else if (silent && running) {
      // Nothing of its own, and a track is already running: letting it keep
      // running is better than dropping to silence for one shot and then
      // starting the same file again from the top on the next. This is what
      // makes a run of silent clips play as one continuous soundtrack — across
      // a clip in the middle that kept its own sound, too.
      continuing = true;
      ({ plan: sound, carry } = carryInto(running, project.defaultAudio, outputDuration));
      playing = carry.sound;
    } else if (silent && replacement) {
      // Nothing of its own and nothing running, so the file this clip was given
      // — or failing that the project's default — fills the gap rather than
      // leaving a hole in the middle of the edit. It also opens the track every
      // silent clip after it will continue.
      playing = replacement;
      ({ plan: sound, carry } = openTrack(replacement, outputDuration));
    } else {
      // Includes a clip asking to be replaced that has not been given a file:
      // keeping its own sound is the only answer that loses nothing.
      sound = { kind: 'original' };
    }

    const inheritsPreviousSound =
      continuing &&
      previous?.sound.kind === 'file' &&
      sound.kind === 'file' &&
      previous.sound.file === sound.file;

    plans.push({
      clip,
      edits,
      keepRanges,
      keptDuration,
      outputStart,
      outputDuration,
      removedDuration: duration - keptDuration,
      sound,
      // What is left of the file from where this clip reads it, against how long
      // the clip lasts. Short means part of the clip plays in silence — invisible
      // on the timeline, and only discovered by watching the export.
      //
      // A file the reader chose *for this clip* is never flagged. Putting a
      // three-second sting under a ten-second title is a decision, and the tool
      // documents what it does with one; shouting about it in red would make the
      // warning something to learn to ignore, which is the end of its usefulness.
      soundShort:
        sound.kind === 'file' && playing !== null && sound.file !== clip.replacementAudio?.file
          ? playing.summary.durationSeconds - sound.offset < outputDuration - EPSILON
          : false
    });

    if (join && previous && joined) {
      // Where the sound changes hands. See `TransitionPlan.soundSwitch`: a file
      // starts with its clip, a clip's own sound starts where the silence bought
      // back for the animation runs out, and a clip with nothing to say lets the
      // one before it play through.
      const headSeconds = handles[position].head / speed;
      const soundSwitch =
        sound.kind === 'mute'
          ? outputStart + overlap
          : sound.kind === 'file'
          ? outputStart
          : outputStart + Math.min(overlap, headSeconds);

      transitions.push({
        clipId: join.clipId,
        fromIndex: plans.length - 2,
        toIndex: plans.length - 1,
        settings: { ...join.settings, seconds: overlap },
        start: outputStart,
        end: outputStart + overlap,
        soundSwitch,
        fromSilence: Math.min(overlap, restored[position]),
        overContent: restored[position] < overlap - EPSILON
      });
    }

    appendRun(runs, sound, outputStart, outputDuration, playing ? soundStart(playing) : 0);

    // The picture always takes the clip's fade. The sound only takes it when it
    // is this clip's own — a soundtrack playing straight through the cut must
    // not dip at it, or the edit sounds broken rather than deliberate.
    //
    // Except across a transition, where the two fades facing each other are the
    // one thing nobody asked for. A transition is already a dissolve from one
    // shot to the other; running the fades inside it as well takes the outgoing
    // picture down to black and brings the incoming one up out of black
    // *underneath* the dissolve, so the join reads as a blink. The clip before
    // gives up its fade-out and the clip after gives up its fade-in; the far end
    // of each keeps the fade it was asked for, and a project set to fade every
    // clip still opens and closes the way it was told to.
    //
    // The sound follows the picture rather than crossfading, because a
    // transition does not mix the two tracks: it hands the sound over at one
    // instant (`soundSwitch`). Two ramps meeting around that instant are not a
    // crossfade, they are a dip to silence in the middle of the join.
    if (joined && previous) {
      removeFadeOutAt(fades, previous.outputStart + previous.outputDuration);
      removeFadeOutAt(audioFades, previous.outputStart + previous.outputDuration);
    }
    appendFades(fades, edits, outputStart, outputDuration, joined);
    if (inheritsPreviousSound && previous) {
      removeFadeOutAt(audioFades, previous.outputStart + previous.outputDuration);
    }
    if (!continuing) appendFades(audioFades, edits, outputStart, outputDuration, joined);
    if (kind === 'video') {
      appendZooms(zooms, clip, edits, keepRanges, outputStart, speed);
      appendCaption(captions, clip, keepRanges, outputStart, outputDuration, speed);
    }

    // Outside the picture guard on purpose: a tag belongs to a *clip*, not to
    // footage, and a still or a text card is a perfectly good thing to put a
    // badge on. The one thing it needs is somewhere to be drawn, and every
    // playable clip has that even when it is drawing black.
    appendTag(tags, clip, outputStart, outputDuration, overlap);

    cursor = outputStart + outputDuration;
  }

  // Overlapping clips push things out of clip order, and every lookup that
  // walks these arrays stops at the first segment starting after the instant it
  // was asked about. Sorted once here rather than defended against in four
  // separate readers.
  const byStart = <T extends { start: number }>(a: T, b: T) => a.start - b.start;
  fades.sort(byStart);
  audioFades.sort(byStart);
  zooms.sort(byStart);
  captions.sort(byStart);
  tags.sort(byStart);

  return {
    clips: plans,
    // Encoders reject odd dimensions, and the transform that fits the frames
    // rounds to two on its own — so the number reported here has to be the
    // rounded one, or the summary would disagree with the file.
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2),
    frameRate,
    // Asked of the codec that will actually do the encoding, not of the
    // container it will sit in. Which container is chosen decides which codec —
    // a video export uses its container's audio codec, not the one picked for
    // audio-only exports — and it is the codec that has an opinion about rates.
    sampleRate: sampleRateFor(
      kind === 'video' ? videoFormat(project.videoFormatId).audioCodec : audioFormat(project.audioFormatId).audioCodec,
      declaredSampleRate
    ),
    // Beyond stereo the layouts stop being interchangeable between formats, and
    // an edit is the wrong place to guess at a surround mapping.
    channelCount: Math.min(2, Math.max(1, declaredChannels || 2)),
    totalDuration: cursor,
    sourceDuration: source,
    removedDuration: removedTotal,
    cutCount,
    fades,
    audioFades,
    zooms,
    captions,
    tags,
    soundFades: planSoundFades(runs, project.soundFade),
    transitions,
    audioOnlyCount: kind === 'video' ? media.filter((clip) => !clip.summary.videoUsable).length : 0,
    // Anything that reaches the finished file with nothing to be heard: silenced
    // on purpose, or keeping a sound it does not have. A text card with no
    // soundtrack under it counts, which it did not while it was a special case.
    silentCount: plans.filter(
      (entry) =>
        entry.sound.kind === 'mute' ||
        (entry.sound.kind === 'original' && !(isMediaClip(entry.clip) && entry.clip.summary.audioUsable))
    ).length,
    hasPicture: pictures.length > 0 || playable.some((clip) => !isMediaClip(clip)),
    // Only a reframed project crops. Left alone, the picture is fitted into the
    // frame exactly as it always was, so nothing about an existing project
    // changes because this field arrived.
    fillFrame: (project.aspect ?? 'source') !== 'source' && (project.reframe ?? 'fill') === 'fill'
  };
}

/**
 * True when the clip before this one was playing the very track still running.
 *
 * Written as a function taking both as parameters because `carry` is a `let`
 * that later lines reassign by destructuring, which is enough for the compiler
 * to stop narrowing it out of `null` at the top of the loop.
 */
function readingSameTrack(previous: ClipPlan | undefined, track: RunningTrack | null): boolean {
  if (!previous || !track || previous.sound.kind !== 'file') return false;

  return previous.sound.file === track.sound.file;
}

/**
 * Winds a running track back by the length of the join it is about to cross.
 *
 * Every clip is given a window into the file as long as itself, and the windows
 * used to be laid end to end because clips were. An overlap breaks that: the two
 * clips sharing it are each allotted the overlapping seconds, so the file is
 * consumed faster than the timeline advances — and a piece of music jumps
 * forward by the length of every transition it passes under. Winding back by
 * exactly the overlap is what keeps the file's clock and the timeline's the same
 * clock. Never back past the first sound in the file.
 *
 * A function rather than three lines at the call site because `carry` is a `let`
 * that later lines reassign by destructuring, which is enough for the compiler
 * to stop narrowing it out of `null` — a parameter has no such history.
 */
function rewind(track: RunningTrack | null, seconds: number): RunningTrack | null {
  if (!track || seconds <= EPSILON) return track;

  return { ...track, consumed: Math.max(soundStart(track.sound), track.consumed - seconds) };
}

/** A supplied file that is playing, and how far into it the timeline has read. */
interface RunningTrack {
  sound: SuppliedSound;
  label: string;
  consumed: number;
}

/** Opens a supplied file at its first real sound, and starts counting. */
function openTrack(sound: SuppliedSound, duration: number): { plan: ClipSoundPlan; carry: RunningTrack } {
  const start = soundStart(sound);

  return {
    plan: { kind: 'file', file: sound.file, label: sound.summary.fileName, offset: start },
    carry: { sound, label: sound.summary.fileName, consumed: start + duration }
  };
}

/** The running track, read from a given point. */
function readFrom(running: RunningTrack, offset: number, duration: number): { plan: ClipSoundPlan; carry: RunningTrack } {
  return {
    plan: { kind: 'file', file: running.sound.file, label: running.label, offset },
    carry: { ...running, consumed: offset + duration }
  };
}

/**
 * Carries the running track into the next clip, or finds one that can cover it.
 *
 * Three things can be wrong with "just keep reading", and each of them shows up
 * as the same symptom — a clip that is silent for part of its length, which
 * nobody notices until they watch the finished file.
 *
 * The tail may be too short. Reading the last twenty seconds of a track under a
 * thirty-second clip leaves ten seconds of nothing, so the track goes back to
 * its beginning instead: the reader asked for music under this clip, not for
 * music under two thirds of it.
 *
 * The file may be too short *entirely* — a three-second sting that one clip was
 * given, still being carried several clips later. Restarting it would not help,
 * and looping a sting is not what anyone meant; the project's own soundtrack is
 * the better answer whenever it can cover the clip.
 *
 * And it may simply have run out, which is the case that used to produce
 * silence: reading past the end of a file yields nothing at all.
 */
function carryInto(
  running: RunningTrack,
  fallback: SuppliedSound | null,
  duration: number
): { plan: ClipSoundPlan; carry: RunningTrack } {
  const start = soundStart(running.sound);
  const total = soundUsableDuration(running.sound);
  const left = start + total - running.consumed;

  if (left >= duration - EPSILON) return readFrom(running, running.consumed, duration);
  if (total >= duration - EPSILON) return readFrom(running, start, duration);

  if (
    fallback &&
    fallback.file !== running.sound.file &&
    soundUsableDuration(fallback) >= duration - EPSILON
  ) {
    return openTrack(fallback, duration);
  }

  // Nothing available can cover this clip. It reads from the top of what is
  // running, which is the most sound this timeline can put under it, and the
  // plan marks it so the row can say the rest will be silent.
  return readFrom(running, start, duration);
}

/**
 * Extends the stretch of supplied sound that is running, or starts a new one.
 *
 * The test for "still the same music" is the file *and* the offset: a clip
 * that plays the same file from the top has not continued anything, it has
 * started it again, and treating that as one long run would put the fade in
 * the wrong place — at the beginning of the first stretch instead of at the
 * beginning of this one.
 */
/** Seconds of a clip's edges that a transition is about to spend, in source time. */
interface SilenceHandle {
  head: number;
  tail: number;
}

/** A join, and the row on the timeline that asked for it. Null id = the project's. */
interface Join {
  settings: TransitionSettings;
  clipId: string | null;
}

/**
 * Keeps a transition's numbers inside what the tool can actually draw.
 *
 * Applied to the project's default as well as to one added by hand, because a
 * document written by an older version — or edited by hand — is not obliged to
 * agree with today's limits.
 */
export function clampTransition(settings: TransitionSettings | null): TransitionSettings | null {
  if (!settings) return null;

  const seconds = Number.isFinite(settings.seconds) ? settings.seconds : TRANSITION_SECONDS.default;
  return {
    ...settings,
    seconds: Math.min(TRANSITION_SECONDS.max, Math.max(TRANSITION_SECONDS.min, seconds))
  };
}

/**
 * Which transition arrives at each shot.
 *
 * One entry per playable clip, holding the transition that plays *into* it. The
 * first shot always gets null — there is nothing before it to come from — and a
 * transition left dangling at the end of the list is ignored rather than being
 * an error, because dragging the last clip away is a normal thing to do and
 * should not put the project into a state it has to be rescued from.
 */
function joinSettings(clips: readonly EditorClip[], project: ProjectSettings): (Join | null)[] {
  const joins: (Join | null)[] = [];
  let pending: TransitionClip | null = null;
  let seen = false;

  for (const clip of clips) {
    if (isTransitionClip(clip)) {
      // Only between two shots. One before the first is not a transition, it is
      // a decoration with nothing to transition from. Two in a row leave the
      // later one standing, and `clipId` is what lets the editor mark the other
      // as doing nothing rather than guessing from its neighbours.
      if (seen) pending = clip;
      continue;
    }

    if (!seen) {
      joins.push(null);
    } else {
      const settings = clampTransition(pending?.settings ?? project.defaultTransition);
      joins.push(settings ? { settings, clipId: pending?.id ?? null } : null);
    }

    pending = null;
    seen = true;
  }

  return joins;
}

/**
 * How much silence each join can be paid for out of, and from where.
 *
 * This is the whole reason transitions here are not simply an overlap. A cut
 * throws away the pause at the end of one shot and the pause at the start of the
 * next; a transition wants exactly that much time and nothing else. So the
 * silence is bought back — but only as much of it as the animation is going to
 * spend, and split between the two sides so the animation sits *on* the join
 * rather than being dragged into one of the shots.
 *
 * Where there is not enough, the shortfall is simply played over content. That
 * is a deliberate answer to a real fork: a transition that silently shortens
 * itself gives the same animation a different length at every join, which reads
 * as a bug rather than as a decision.
 */
function silenceHandles(
  playable: readonly EditorClip[],
  joins: readonly (Join | null)[],
  project: ProjectSettings,
  options: PlanOptions = {}
): { handles: SilenceHandle[]; restored: number[]; overlaps: number[] } {
  const handles: SilenceHandle[] = playable.map(() => ({ head: 0, tail: 0 }));
  const restored: number[] = playable.map(() => 0);
  const overlaps: number[] = playable.map(() => 0);

  /**
   * How long each shot is before any of this, and how much of it is already
   * promised to a join.
   *
   * The budget is per clip, not per join, and that is the whole reason it is
   * kept: a clip in the middle of two transitions is the outgoing side of one
   * and the incoming side of the other, and two joins each allowed most of it
   * would between them consume more than exists — the second transition would
   * then start before the first had finished and be reduced, in the encoder, to
   * its last two frames.
   */
  const plain = playable.map((clip) => {
    const edits = planningEdits(clip, project, options);
    return totalDuration(keepRangesFor(clip, edits)) / clampSpeed(edits.speed);
  });
  const spent = playable.map(() => 0);

  for (let position = 1; position < playable.length; position++) {
    const join = joins[position];
    if (!join) continue;

    const before = playable[position - 1];
    const after = playable[position];
    const editsBefore = planningEdits(before, project, options);
    const editsAfter = planningEdits(after, project, options);
    const speedBefore = clampSpeed(editsBefore.speed);
    const speedAfter = clampSpeed(editsAfter.speed);

    // Never more than most of what is left of either shot, so that both are on
    // screen alone for at least a moment.
    const overlap = Math.max(
      0,
      Math.min(
        join.settings.seconds,
        (plain[position - 1] - spent[position - 1]) * 0.9,
        (plain[position] - spent[position]) * 0.9
      )
    );

    if (overlap <= EPSILON) continue;

    overlaps[position] = overlap;
    spent[position - 1] += overlap;
    spent[position] += overlap;

    // Measured in source seconds, spent in output seconds: a clip running at
    // double speed gives up two seconds of silence to buy one on screen. Sized
    // from `overlap` rather than from what was asked for — buying back silence
    // the join will not spend would leave dead air the cut had removed.
    const tail = trailingSilence(before, editsBefore) / speedBefore;
    const head = leadingSilence(after, editsAfter) / speedAfter;

    let fromTail = Math.min(tail, overlap / 2);
    let fromHead = Math.min(head, overlap - fromTail);
    // A second pass at the tail: if the incoming shot had less to give than half,
    // the outgoing one is allowed to make up the difference.
    fromTail = Math.min(tail, overlap - fromHead);

    handles[position - 1].tail = fromTail * speedBefore;
    handles[position].head = fromHead * speedAfter;
    restored[position] = fromTail + fromHead;
  }

  return { handles, restored, overlaps };
}

/**
 * What a transition is allowed to buy back at a clip's edges.
 *
 * Detected silence only — never a region the reader drew by hand. Silence the
 * detector removed is the tool's own decision and giving some of it back to pay
 * for an animation is a trade the tool may make; a range the reader painted over
 * is them saying "this take is no good", and quietly putting a third of a second
 * of it back under a transition is the tool overruling them.
 *
 * Anything the reader cut by hand at the very edge therefore shrinks what is
 * available, because the kept range starts after it either way.
 */
function reclaimable(clip: EditorClip, edits: ClipEdits): EditableRange[] {
  if (!isMediaClip(clip) || !edits.cutSilence) return [];

  const detected = clip.detected.filter((range) => range.enabled);
  if (!detected.length) return [];

  const manual = clip.manualCuts.filter((range) => range.enabled);
  const duration = sourceDuration(clip);

  return mergeEditableRanges(detected, duration).filter(
    (range) => range.enabled && !manual.some((cut) => cut.start < range.end && cut.end > range.start)
  );
}

/**
 * Silence at the very end of a clip that the cut would remove, in source seconds.
 *
 * Measured against the clip's own end rather than the file's. A clip trimmed to
 * the middle of a take has no silence at its edges to sell, and letting a
 * transition buy back a pause that sits past the out point would put footage
 * the reader deliberately cut off back on screen.
 */
function trailingSilence(clip: EditorClip, edits: ClipEdits): number {
  const removed = reclaimable(clip, edits);
  const bounds = clipBounds(clip);
  const last = removed[removed.length - 1];
  if (!last || last.end < bounds.end - EPSILON) return 0;

  return Math.max(0, Math.min(last.end, bounds.end) - Math.max(last.start, bounds.start));
}

/** The same at the head. */
function leadingSilence(clip: EditorClip, edits: ClipEdits): number {
  const removed = reclaimable(clip, edits);
  const bounds = clipBounds(clip);
  const first = removed[0];
  if (!first || first.start > bounds.start + EPSILON) return 0;

  return Math.max(0, Math.min(first.end, bounds.end) - Math.max(first.start, bounds.start));
}

/** Gives a clip's outermost kept ranges back the silence a transition will use. */
function withHandles(ranges: TimeRange[], handle: SilenceHandle, bounds: TimeRange): TimeRange[] {
  if (!ranges.length || (handle.head <= EPSILON && handle.tail <= EPSILON)) return ranges;

  const grown = ranges.map((range) => ({ ...range }));
  grown[0].start = Math.max(bounds.start, grown[0].start - handle.head);
  const last = grown[grown.length - 1];
  last.end = Math.min(bounds.end, last.end + handle.tail);

  return grown;
}

/** The join covering this instant, or null. */
export function transitionAt(plan: ProjectPlan, time: number): TransitionPlan | null {
  for (const entry of plan.transitions) {
    if (time >= entry.start && time < entry.end) return entry;
  }
  return null;
}

/** How far through a join an instant is, from zero to one. */
export function transitionProgress(entry: TransitionPlan, time: number): number {
  const span = entry.end - entry.start;
  if (span <= EPSILON) return 1;

  return Math.min(1, Math.max(0, (time - entry.start) / span));
}

function appendRun(
  runs: { file: File; start: number; end: number }[],
  sound: ClipSoundPlan,
  start: number,
  duration: number,
  /** Where reading this file begins when it is played from the top. */
  head: number
): void {
  if (sound.kind !== 'file' || duration <= EPSILON) return;

  const open = runs[runs.length - 1];
  // `start <= open.end` rather than `start === open.end`: a transition makes the
  // next clip begin *before* the previous one finished, and an exact-abutment
  // test would see that as a new run — which would put a fade-out and a fade-in
  // into the middle of a piece of music at every single join.
  //
  // And "not at the beginning" is asked as `offset > head`, not `offset > 0`.
  // A file whose first sound was measured to be a third of a second in restarts
  // at that third of a second, and against zero that reads as "still playing" —
  // so the music would jump back to its own beginning at full volume, with no
  // ramp, in the middle of the project.
  const continues =
    open !== undefined &&
    open.file === sound.file &&
    start <= open.end + EPSILON &&
    sound.offset > head + EPSILON;

  if (continues) {
    open.end = start + duration;
    return;
  }

  runs.push({ file: sound.file, start, end: start + duration });
}

/**
 * Turns each run into the pair of ramps that opens and closes it.
 *
 * Clamped to the run for the same reason a clip's fade is clamped to the clip:
 * a three-second entrance on two seconds of music would still be arriving when
 * the music had gone. A run short enough for both ramps splits itself in half
 * at worst, so they meet rather than overlap.
 */
function planSoundFades(
  runs: readonly { file: File; start: number; end: number }[],
  settings: SoundFade
): FadeSegment[] {
  const fade = clampSoundFade(settings);
  if (!fade.fadeIn && !fade.fadeOut) return [];

  const both = fade.fadeIn && fade.fadeOut;
  const segments: FadeSegment[] = [];

  for (const run of runs) {
    const duration = run.end - run.start;
    const span = Math.min(fade.seconds, duration / (both ? 2 : 1));
    if (span <= EPSILON) continue;

    if (fade.fadeIn) segments.push({ start: run.start, end: run.start + span, kind: 'in' });
    if (fade.fadeOut) segments.push({ start: run.end - span, end: run.end, kind: 'out' });
  }

  return segments;
}

/**
 * Resolves the clip's fades onto the finished timeline.
 *
 * A fade is clamped to the clip it belongs to: letting a one-second ramp spill
 * out of a half-second clip would fade footage the reader never asked to touch.
 * A clip fading at both ends splits itself in half at worst, so the two ramps
 * meet rather than overlap.
 *
 * `skipIn` is set when the clip arrives over the one before it: the entrance is
 * then the transition's job, and a fade under it would only darken the join.
 * There is no matching `skipOut`, because whether a clip is joined at its tail
 * is not known until the next one is placed — that ramp is taken back then.
 */
function appendFades(
  fades: FadeSegment[],
  edits: ClipEdits,
  start: number,
  duration: number,
  skipIn = false
): void {
  const both = edits.fadeIn && edits.fadeOut;
  const span = Math.min(edits.fadeSeconds, duration / (both ? 2 : 1));
  if (span <= 0) return;

  if (edits.fadeIn && !skipIn) fades.push({ start, end: start + span, kind: 'in' });
  if (edits.fadeOut) fades.push({ start: start + duration - span, end: start + duration, kind: 'out' });
}

/** Removes the outgoing clip ramp when the next clip inherits that same sound. */
function removeFadeOutAt(fades: FadeSegment[], end: number): void {
  for (let index = fades.length - 1; index >= 0; index--) {
    const fade = fades[index];
    if (fade.kind === 'out' && Math.abs(fade.end - end) <= EPSILON) {
      fades.splice(index, 1);
      return;
    }
  }
}

/**
 * Translates a clip's zooms from its own clock onto the project's.
 *
 * The planner works in the clip's cut timeline, which is the only place the
 * pauses it reads about make sense. Speed compresses that timeline and the clip
 * starts somewhere, so both are applied here — including to the ramp, since a
 * push-in at four times speed has to happen four times faster or it would still
 * be arriving when the clip has ended.
 */
function appendZooms(
  zooms: ZoomSegment[],
  clip: EditorClip,
  edits: ClipEdits,
  keepRanges: readonly TimeRange[],
  start: number,
  speed: number
): void {
  if (!isMediaClip(clip) || !clip.summary.videoUsable) return;

  const planned = planAutoZooms(removedRanges(clip, edits), keepRanges, edits.silence.autoZoom, clip.id);

  for (const segment of planned) {
    zooms.push({
      ...segment,
      start: start + segment.start / speed,
      end: start + segment.end / speed,
      rampSeconds: segment.rampSeconds / speed
    });
  }

  // The reader's own push-ins, translated the same way. They come second so
  // that where the two collide the hand-placed one is the survivor: it was
  // asked for, and the automatic one was only inferred.
  for (const zoom of manualZoomSegments(clip, keepRanges)) {
    const overlapping = zooms.findIndex(
      (existing) =>
        existing.start < start + zoom.end / speed && existing.end > start + zoom.start / speed
    );
    if (overlapping >= 0) zooms.splice(overlapping, 1);

    zooms.push({
      start: start + zoom.start / speed,
      end: start + zoom.end / speed,
      scale: zoom.scale,
      rampSeconds: zoom.rampSeconds / speed,
      pauseSeconds: 0,
      reason: 'above-average',
      easeOut: zoom.easeOut
    });
  }
}

/**
 * Where on the cut timeline each hand-placed push-in lands.
 *
 * The reader draws it against the file — the clock the waveform under their
 * cursor is drawn on — and everything downstream counts in the timeline the
 * cuts left behind, so the translation happens exactly once, here. A zoom whose
 * whole span was cut away collapses to nothing and is dropped rather than being
 * drawn as an instantaneous jump.
 */
function manualZoomSegments(
  clip: MediaClip,
  keepRanges: readonly TimeRange[]
): { start: number; end: number; scale: number; rampSeconds: number; easeOut: boolean }[] {
  const zooms = clip.manualZooms ?? [];
  if (!zooms.length) return [];

  const duration = sourceDuration(clip);

  return zooms
    .map((zoom) => clampManualZoom(zoom, duration))
    .map((zoom) => ({
      start: cutTimeOf(keepRanges, zoom.start),
      end: cutTimeOf(keepRanges, zoom.end),
      scale: 1 + zoom.scalePercent / 100,
      rampSeconds: zoom.rampSeconds,
      easeOut: zoom.easeOut
    }))
    .filter((segment) => segment.end - segment.start > EPSILON)
    .sort((a, b) => a.start - b.start);
}

/**
 * A position in the source, read on the clock the cuts left behind.
 *
 * An instant inside a removed stretch has no place of its own on that clock, so
 * it answers with the join it collapsed to — which is the only reading that
 * keeps a zoom drawn across a pause on screen either side of it.
 */
export function cutTimeOf(keepRanges: readonly TimeRange[], sourceTime: number): number {
  let elapsed = 0;

  for (const range of keepRanges) {
    if (sourceTime < range.start) return elapsed;
    if (sourceTime <= range.end) return elapsed + (sourceTime - range.start);
    elapsed += range.end - range.start;
  }

  return elapsed;
}

/**
 * Places one clip's tag on the output timeline.
 *
 * The second the reader typed is counted in **output** time — seconds into the
 * clip as it appears in the finished video — rather than in the source. Someone
 * who says "at one second" is watching, and on a clip sped up four times the
 * source second and the watched second are very different things; the watched
 * one is the one they meant.
 *
 * A tag with no exit lasts as long as its clip, and one with an exit stops when
 * the exit finishes — but never later than the clip, because a tag outliving the
 * shot it belongs to would be drawn over the next one.
 */
function appendTag(
  tags: TagSegment[],
  clip: EditorClip,
  start: number,
  duration: number,
  overlap: number
): void {
  if (!isPlayable(clip) || duration <= 0) return;

  const tag = clip.tag;
  if (!tag || !tag.text.trim()) return;

  // Never before the transition into this clip has finished. The compositor
  // draws nothing over a join — two shots are on screen and a badge belonging
  // to one of them would be a lie about the other — so a tag placed inside one
  // would spend its entrance invisible and turn up already arrived. Waiting is
  // the difference between the animation the reader chose and no animation at
  // all, and it costs at most the length of the join.
  const at = Math.max(start + Math.max(0, tag.startSeconds), start + overlap);
  const clipEnd = start + duration;
  // A tag told to arrive after its clip has already finished is not an error
  // worth refusing — the reader trimmed the clip and forgot — it simply never
  // appears, which is what the timeline says and what the preview will show.
  if (at >= clipEnd - EPSILON) return;

  tags.push({ start: at, end: Math.min(clipEnd, at + tagLifetime(tag)), tag });
}

function appendCaption(
  captions: CaptionSegment[],
  clip: EditorClip,
  keepRanges: readonly TimeRange[],
  start: number,
  duration: number,
  speed: number
): void {
  if (!isMediaClip(clip)) return;

  if (duration <= 0) return;
  const bounds = clipBounds(clip);
  const timed = clip.captions?.length
    ? clip.captions
    : clip.caption?.text.trim()
      ? [{ ...clip.caption, startSeconds: bounds.start, durationSeconds: bounds.end - bounds.start }]
      : [];

  for (const caption of timed) {
    if (!caption.text.trim()) continue;
    const sourceStart = Math.max(bounds.start, caption.startSeconds ?? bounds.start);
    const sourceEnd = Math.min(bounds.end, sourceStart + Math.max(0, caption.durationSeconds ?? bounds.end - sourceStart));
    const segmentStart = start + cutTimeOf(keepRanges, sourceStart) / speed;
    const segmentEnd = Math.min(start + duration, start + cutTimeOf(keepRanges, sourceEnd) / speed);
    if (segmentEnd - segmentStart > EPSILON) captions.push({ start: segmentStart, end: segmentEnd, caption });
  }
}

/** The nearest rate the chosen codec actually accepts. */
function sampleRateFor(codec: string | null, declared: number): number {
  // Opus is a 48 kHz codec. Handing it anything else is not a preference the
  // encoder will politely round — it is an export that fails. Asked of the codec
  // rather than of the container's name because the two only happen to agree
  // today: every Opus container is called `webm` or `ogg` right now, and the
  // first WebM-with-Opus-in-an-MKV anyone adds would break the coincidence and
  // take the export with it.
  if (codec === 'opus') return 48000;
  if (!declared) return 48000;
  // MP3 has a fixed ladder of rates, and 44.1 is the one nothing refuses.
  if (codec === 'mp3') return declared <= 44100 ? 44100 : 48000;

  return Math.min(96000, Math.max(8000, Math.round(declared)));
}

/**
 * The volume, and the brightness, at one instant: 1 outside every ramp.
 *
 * The segments are in order, so the first one that starts after the instant ends
 * the search — but they can now overlap, because a transition makes two clips
 * share a stretch of the timeline and one may be fading out while the other
 * fades in. Taking the quietest of the ramps covering an instant is what keeps
 * the curve continuous; returning the first would step from one ramp onto the
 * other, which is a click on the sound and a flicker on the picture.
 */
export function fadeGainAt(fades: readonly FadeSegment[], time: number): number {
  let gain = 1;

  for (const fade of fades) {
    if (time < fade.start) break;
    if (time >= fade.end) continue;

    const progress = (time - fade.start) / (fade.end - fade.start);
    gain = Math.min(gain, fade.kind === 'in' ? progress : 1 - progress);
  }

  return gain;
}

/** The caption on screen at one instant, and how far it has faded in. */
/**
 * The tag on screen at this instant, and how far into its life it is.
 *
 * The elapsed seconds rather than the raw time, because every animation in the
 * painter is written against a clock that starts when the tag arrives — and the
 * painter has no way to find out when that was.
 */
export function tagAt(
  tags: readonly TagSegment[],
  time: number
): { tag: ClipTag; elapsed: number } | null {
  for (const segment of tags) {
    if (time < segment.start) break;
    if (time >= segment.end) continue;
    return { tag: segment.tag, elapsed: time - segment.start };
  }
  return null;
}

export function captionAt(
  captions: readonly CaptionSegment[],
  time: number
): { caption: CaptionSegment['caption']; opacity: number } | null {
  for (const segment of captions) {
    if (time < segment.start) break;
    if (time >= segment.end) continue;

    const { caption } = segment;
    const fade = caption.fadeSeconds;
    let opacity = 1;

    if (fade > 0 && caption.fadeIn) opacity = Math.min(opacity, (time - segment.start) / fade);
    if (fade > 0 && caption.fadeOut) opacity = Math.min(opacity, (segment.end - time) / fade);

    return { caption, opacity: Math.min(1, Math.max(0, opacity)) };
  }
  return null;
}

/**
 * Where in the source file an instant of the finished video comes from.
 *
 * The inverse of everything the plan did to this clip: undo the placement, undo
 * the speed, then walk the kept ranges until the remaining time falls inside
 * one. The preview needs it on every frame — it is the question "what should
 * the decoder be showing right now?" — and it is the one calculation that has
 * to agree exactly with what the encoder did, or the preview would show a
 * different edit than the file.
 */
export function sourceTimeAt(entry: ClipPlan, outputTime: number): { rangeIndex: number; sourceTime: number } {
  const speed = clampSpeed(entry.edits.speed);
  const cutTime = Math.max(0, (outputTime - entry.outputStart) * speed);

  let consumed = 0;
  for (const [index, range] of entry.keepRanges.entries()) {
    const length = range.end - range.start;
    if (cutTime < consumed + length || index === entry.keepRanges.length - 1) {
      return { rangeIndex: index, sourceTime: range.start + Math.min(length, cutTime - consumed) };
    }
    consumed += length;
  }

  return { rangeIndex: 0, sourceTime: 0 };
}

/** The instant of the finished video a position in the source lands on. */
export function outputTimeOf(entry: ClipPlan, rangeIndex: number, sourceTime: number): number {
  const speed = clampSpeed(entry.edits.speed);

  let consumed = 0;
  for (let index = 0; index < rangeIndex && index < entry.keepRanges.length; index++) {
    consumed += entry.keepRanges[index].end - entry.keepRanges[index].start;
  }

  const range = entry.keepRanges[rangeIndex];
  const inside = range ? Math.max(0, Math.min(range.end - range.start, sourceTime - range.start)) : 0;

  return entry.outputStart + (consumed + inside) / speed;
}

/** Position of the clip covering an instant, or -1 when the plan is empty. */
export function clipIndexAt(plan: ProjectPlan, time: number): number {
  for (const [index, entry] of plan.clips.entries()) {
    if (time >= entry.outputStart && time < entry.outputStart + entry.outputDuration) return index;
  }
  return plan.clips.length ? plan.clips.length - 1 : -1;
}

/** Which clip of the plan covers an instant of the output, for the scrubber. */
export function clipAt(plan: ProjectPlan, time: number): ClipPlan | null {
  for (const entry of plan.clips) {
    if (time >= entry.outputStart && time < entry.outputStart + entry.outputDuration) return entry;
  }
  return plan.clips[plan.clips.length - 1] ?? null;
}

/** The clips that still need an analysis before the plan they describe is true. */
export function clipsNeedingAnalysis(clips: readonly EditorClip[], project: ProjectSettings): MediaClip[] {
  return clips.filter((clip): clip is MediaClip => {
    if (!isMediaClip(clip) || !clip.summary.audioUsable) return false;
    // A clip restored from storage has its settings but not its bytes; there is
    // nothing to listen to until the reader hands the file back.
    if (clip.awaitingFile) return false;

    const edits = effectiveEdits(clip, project);
    const wanted = edits.cutSilence || edits.silence.autoZoom.enabled || project.loudness.enabled;
    if (!wanted) return false;

    return clip.analysis === null;
  });
}

/**
 * The same plan, starting at one clip instead of at the beginning.
 *
 * An export that stopped — cancelled, or interrupted by the machine going to
 * sleep — has already written everything up to the clip it was on, and there is
 * no honest way to reopen a finalised file and append to it: the container's
 * index has been written and the muxer is gone. What there *is* a way to do is
 * write the rest as a second file, and that is what this makes possible. The
 * reader gets two parts they can join back together, instead of an hour of
 * encoding thrown away.
 *
 * Everything is rebased onto the new zero rather than filtered in place,
 * because the renderer trusts one rule above all others — timestamps start at
 * nought and never go backwards — and a plan whose first clip began at eleven
 * minutes would break it on the first sample.
 *
 * The join arriving at the first surviving clip is deliberately dropped. A
 * transition is two shots overlapping, and the shot it would come from is in
 * the other file; drawing half of one would be worse than the cut that replaces
 * it.
 */
export function slicePlan(plan: ProjectPlan, fromIndex: number): ProjectPlan {
  const start = Math.max(0, Math.min(fromIndex, plan.clips.length));
  if (start === 0) return plan;

  const kept = plan.clips.slice(start);
  if (!kept.length) return { ...plan, clips: [], totalDuration: 0, transitions: [], fades: [], audioFades: [], zooms: [], captions: [], tags: [], soundFades: [] };

  const offset = kept[0].outputStart;
  const shift = <T extends { start: number; end: number }>(segments: readonly T[]): T[] =>
    segments
      .filter((segment) => segment.end > offset + EPSILON)
      .map((segment) => ({ ...segment, start: Math.max(0, segment.start - offset), end: segment.end - offset }));

  const clips = kept.map((entry) => ({ ...entry, outputStart: entry.outputStart - offset }));

  return {
    ...plan,
    clips,
    totalDuration: Math.max(0, plan.totalDuration - offset),
    sourceDuration: clips.reduce((total, entry) => total + trimmedDuration(entry.clip), 0),
    removedDuration: clips.reduce((total, entry) => total + entry.removedDuration, 0),
    cutCount: clips.reduce((total, entry) => total + Math.max(0, entry.keepRanges.length - 1), 0),
    fades: shift(plan.fades),
    audioFades: shift(plan.audioFades),
    zooms: shift(plan.zooms),
    captions: shift(plan.captions),
    tags: shift(plan.tags),
    soundFades: shift(plan.soundFades),
    transitions: plan.transitions
      .filter((join) => join.fromIndex >= start)
      .map((join) => ({
        ...join,
        fromIndex: join.fromIndex - start,
        toIndex: join.toIndex - start,
        start: join.start - offset,
        end: join.end - offset,
        soundSwitch: join.soundSwitch - offset
      }))
  };
}
