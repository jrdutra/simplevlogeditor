import { DEFAULT_AUTO_ZOOM } from '../../shared/media/auto-zoom';
import {
  DEFAULT_EDITS,
  DEFAULT_PROJECT,
  SPEED_LIMITS,
  cloneEdits,
  timelapseSpeedFor
} from './video-editor-defaults';
import {
  ClipTag,
  DEFAULT_TAG,
  TAG_SPECIALS,
  clampTag,
  shapeIsSpecial,
  specialShape,
  tagLifetime
} from './tag-overlay';
import { needsCompositing } from './frame-compositor';
import {
  buildProjectPlan,
  captionAt,
  clipBounds,
  clipIndexAt,
  cutTimeOf,
  effectiveEdits,
  fadeGainAt,
  isTrimmed,
  keepRangesFor,
  outputTimeOf,
  reframeSize,
  slicePlan,
  sourceTimeAt,
  tagAt,
  transitionAt,
  transitionProgress,
  trimmedDuration,
  videoEffectAt,
  videoEffectGain,
  videoEffectSlotFor,
  videoEffectsOverlap
} from './video-editor-timeline';
import {
  ClipEdits,
  EditableRange,
  EditorClip,
  MediaClip,
  ProjectSettings,
  SuppliedSound,
  TextClip,
  TransitionClip
} from './video-editor.models';
import type { TransitionKind } from './video-transitions';

/**
 * The arithmetic of the timeline is where this tool is either right or subtly
 * wrong, and it is the one part that can be checked without a media file: cut,
 * then speed, then place, and everything that follows from those three.
 */
function mediaClip(id: string, duration: number, overrides: Partial<MediaClip> = {}): MediaClip {
  return {
    kind: 'media',
    id,
    file: new File([], `${id}.mp4`),
    summary: {
      fileName: `${id}.mp4`,
      fileSize: 1000,
      containerName: 'MP4',
      kind: 'video',
      durationSeconds: duration,
      hasVideoTrack: true,
      hasAudioTrack: true,
      videoCodec: 'avc',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channelCount: 2,
      videoUsable: true,
      audioUsable: true,
      warning: null,
      isTimelapse: false,
      timelapseReason: null
    },
    info: null,
    overrides: null,
    detected: [],
    manualCuts: [],
    analysis: null,
    analyzedWith: null,
    replacementAudio: null,
    caption: null,
    previewUrl: null,
    thumbUrl: null,
    ...overrides
  };
}

function textClip(id: string, reveal: number, hold: number): TextClip {
  return {
    kind: 'text',
    id,
    draft: textDraft(reveal, hold),
    backgroundFile: null,
    backgroundUrl: null,
    replacementAudio: null,
    overrides: null
  };
}

function textDraft(reveal: number, hold: number) {
  return {
    text: 'Chapter one',
    fontId: 'sans',
    fontScale: 0.09,
    fontWeight: 700,
    color: '#ffffff',
    backgroundColor: '#000000',
    align: 'center' as const,
    vertical: 'middle' as const,
    margin: 0.07,
    letterSpacing: 0,
    lineHeight: 1.25,
    legibility: 'shadow' as const,
    animation: 'none' as const,
    revealSeconds: reveal,
    holdSeconds: hold
  };
}

function range(start: number, end: number): EditableRange {
  return { start, end, source: 'automatic', enabled: true };
}

function project(edits: Partial<ClipEdits> = {}, extra: Partial<ProjectSettings> = {}): ProjectSettings {
  return { ...DEFAULT_PROJECT, ...extra, edits: { ...cloneEdits(DEFAULT_EDITS), ...edits } };
}

/** A soundtrack for the project to fall back to. */
function soundtrack(name = 'music.mp3'): SuppliedSound {
  return {
    file: new File([], name),
    summary: { ...mediaClip('x', 60).summary, fileName: name, kind: 'audio' as const }
  };
}

/** A join between two shots, with everything at its defaults but the name. */
function transitionClip(id: string, seconds = 0.6, kind: TransitionKind = 'dissolve'): TransitionClip {
  return { kind: 'transition', id, settings: { kind, seconds, colour: '#0b0f1a' } };
}

/** A clip whose own soundtrack is missing — the microphone was off. */
function silentClip(id: string, duration: number): MediaClip {
  const clip = mediaClip(id, duration);
  clip.summary.audioUsable = false;
  clip.summary.hasAudioTrack = false;
  return clip;
}

describe('effectiveEdits', () => {
  it('follows the project until the clip has its own copy', () => {
    const clip = mediaClip('a', 10);
    const settings = project({ speed: 2 });

    expect(effectiveEdits(clip, settings).speed).toBe(2);

    clip.overrides = { ...cloneEdits(settings.edits), speed: 4 };
    expect(effectiveEdits(clip, settings).speed).toBe(4);
  });

  it('hands out a copy, so one clip never moves the settings of another', () => {
    const settings = project();
    const clip = mediaClip('a', 10, { overrides: cloneEdits(settings.edits) });

    (clip.overrides as ClipEdits).silence.thresholdDb = -12;

    expect(settings.edits.silence.thresholdDb).not.toBe(-12);
  });
});

describe('keepRangesFor', () => {
  it('keeps the whole clip when nothing is cut', () => {
    const clip = mediaClip('a', 10, { detected: [range(2, 4)] });

    expect(keepRangesFor(clip, cloneEdits(DEFAULT_EDITS))).toEqual([{ start: 0, end: 10 }]);
  });

  it('removes the detected silences once cutting is on', () => {
    const clip = mediaClip('a', 10, { detected: [range(2, 4)] });

    expect(keepRangesFor(clip, { ...cloneEdits(DEFAULT_EDITS), cutSilence: true })).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 10 }
    ]);
  });

  it('merges a hand-drawn cut that overlaps a detected one', () => {
    const clip = mediaClip('a', 10, {
      detected: [range(2, 4)],
      manualCuts: [{ start: 3, end: 6, source: 'manual', enabled: true }]
    });

    expect(keepRangesFor(clip, { ...cloneEdits(DEFAULT_EDITS), cutSilence: true })).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 10 }
    ]);
  });

  it('applies a hand-drawn cut even with silence cutting off', () => {
    const clip = mediaClip('a', 10, {
      detected: [range(2, 4)],
      manualCuts: [{ start: 8, end: 9, source: 'manual', enabled: true }]
    });

    expect(keepRangesFor(clip, cloneEdits(DEFAULT_EDITS))).toEqual([
      { start: 0, end: 8 },
      { start: 9, end: 10 }
    ]);
  });

  it('ignores a range the reader switched off', () => {
    const clip = mediaClip('a', 10, { detected: [{ ...range(2, 4), enabled: false }] });

    expect(keepRangesFor(clip, { ...cloneEdits(DEFAULT_EDITS), cutSilence: true })).toEqual([
      { start: 0, end: 10 }
    ]);
  });
});

describe('buildProjectPlan', () => {
  it('lays the clips out back to back', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), mediaClip('b', 5)];
    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.clips[0].outputStart).toBe(0);
    expect(plan.clips[1].outputStart).toBe(10);
    expect(plan.totalDuration).toBe(15);
  });

  it('uses the selected container to choose the export sample rate', () => {
    const clip = mediaClip('a', 10);
    clip.summary.sampleRate = 44100;
    const settings = project({}, { videoFormatId: 'webm', audioFormatId: 'mp3' });

    expect(buildProjectPlan([clip], settings, 'video').sampleRate).toBe(48000);
    expect(buildProjectPlan([clip], settings, 'audio').sampleRate).toBe(44100);
  });

  it('uses the resolution and frame rate shared by most video clips in automatic mode', () => {
    const first = mediaClip('a', 10);
    const second = mediaClip('b', 10);
    const outlier = mediaClip('c', 10);
    first.summary.width = second.summary.width = 1280;
    first.summary.height = second.summary.height = 720;
    first.summary.frameRate = second.summary.frameRate = 30;
    outlier.summary.width = 3840;
    outlier.summary.height = 2160;
    outlier.summary.frameRate = 60;

    const plan = buildProjectPlan([first, textClip('title', 1, 2), second, outlier], project(), 'video');

    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(720);
    expect(plan.frameRate).toBe(30);
  });

  it('keeps an explicitly selected resolution while still matching the majority frame rate', () => {
    const clips = [mediaClip('a', 10), mediaClip('b', 10), mediaClip('c', 10)];
    clips[0].summary.frameRate = clips[1].summary.frameRate = 24;
    clips[2].summary.frameRate = 60;

    const plan = buildProjectPlan(clips, project({}, { resolution: '1920x1080' }), 'video');

    expect(plan.width).toBe(1920);
    expect(plan.height).toBe(1080);
    expect(plan.frameRate).toBe(24);
  });

  /**
   * The trap the container-name version was one table entry away from.
   *
   * MKV can hold Opus, and the moment such a format is offered the id `mkv` says
   * nothing about the rate the encoder will accept — while its codec says
   * everything. Opus is 48 kHz or it is a failed export.
   */
  it('follows the codec rather than the container name', () => {
    const clip = mediaClip('a', 10);
    clip.summary.sampleRate = 44100;

    // MP4 and MKV both carry AAC, which takes the file's own rate.
    expect(buildProjectPlan([clip], project({}, { videoFormatId: 'mkv' }), 'video').sampleRate).toBe(44100);
    // WebM carries Opus, which does not.
    expect(buildProjectPlan([clip], project({}, { videoFormatId: 'webm' }), 'video').sampleRate).toBe(48000);
    // And an unknown id falls back to the first format rather than to a rate no
    // encoder asked for.
    expect(buildProjectPlan([clip], project({}, { videoFormatId: 'nonsense' }), 'video').sampleRate).toBe(44100);
  });

  it('shortens a clip by its speed', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), mediaClip('b', 6)];
    const plan = buildProjectPlan(clips, project({ speed: 2 }), 'video');

    expect(plan.clips[0].outputDuration).toBe(5);
    expect(plan.clips[1].outputStart).toBe(5);
    expect(plan.totalDuration).toBe(8);
  });

  it('lengthens a clip that is slowed down', () => {
    // The direction the row used to hide: slowing a clip makes it longer than
    // the file, so a display that only mentions the source when the clip got
    // shorter said nothing at all here.
    const plan = buildProjectPlan([mediaClip('a', 10), mediaClip('b', 6)], project({ speed: 0.5 }), 'video');

    expect(plan.clips[0].outputDuration).toBe(20);
    expect(plan.clips[1].outputStart).toBe(20);
    expect(plan.totalDuration).toBe(32);
  });

  it('cuts first and slows down what is left', () => {
    const clips: EditorClip[] = [mediaClip('a', 10, { detected: [range(2, 6)] })];
    const plan = buildProjectPlan(clips, project({ cutSilence: true, speed: 0.5 }), 'video');

    expect(plan.clips[0].keptDuration).toBe(6);
    expect(plan.clips[0].outputDuration).toBe(12);
  });

  it('cuts first and speeds up what is left', () => {
    const clips: EditorClip[] = [mediaClip('a', 10, { detected: [range(2, 6)] })];
    const plan = buildProjectPlan(clips, project({ cutSilence: true, speed: 2 }), 'video');

    expect(plan.clips[0].keptDuration).toBe(6);
    expect(plan.clips[0].outputDuration).toBe(3);
    expect(plan.removedDuration).toBe(4);
    expect(plan.cutCount).toBe(1);
  });

  it('places a text card by its reveal and hold', () => {
    const clips: EditorClip[] = [textClip('t', 2, 3), mediaClip('a', 4)];
    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.clips[0].outputDuration).toBe(5);
    expect(plan.clips[1].outputStart).toBe(5);
  });

  it('clamps a fade to the clip it belongs to', () => {
    const clips: EditorClip[] = [mediaClip('a', 1)];
    const plan = buildProjectPlan(clips, project({ fadeIn: true, fadeOut: true, fadeSeconds: 3 }), 'video');

    // Two fades on a one-second clip meet in the middle instead of overlapping.
    expect(plan.fades).toEqual([
      { start: 0, end: 0.5, kind: 'in' },
      { start: 0.5, end: 1, kind: 'out' }
    ]);
  });

  it('translates a clip zoom onto the project timeline', () => {
    const clip = mediaClip('a', 60, {
      detected: [range(10, 10.5), range(20, 20.5), range(30, 33), range(40, 40.5)]
    });
    const plan = buildProjectPlan([mediaClip('lead', 4), clip], project({
      cutSilence: true,
      speed: 2,
      silence: { ...DEFAULT_EDITS.silence, autoZoom: { ...DEFAULT_AUTO_ZOOM, enabled: true, holdSeconds: 2, rampSeconds: 0 } }
    }), 'video');

    expect(plan.zooms.length).toBe(1);
    // The lead clip lasts two seconds at double speed; inside the second clip
    // the zoom starts 29 seconds in, which is 14.5 seconds once halved.
    expect(plan.zooms[0].start).toBeCloseTo(2 + 14.5, 6);
    expect(plan.zooms[0].end).toBeCloseTo(2 + 15.5, 6);
  });

  it('leaves zooms and captions out of an audio-only export', () => {
    const clip = mediaClip('a', 20, {
      caption: { text: 'Hello', fontScale: 0.045, bottomMargin: 0.06, fadeIn: true, fadeOut: true, fadeSeconds: 0.5 }
    });
    const plan = buildProjectPlan([clip], project(), 'audio');

    expect(plan.captions).toEqual([]);
    expect(plan.zooms).toEqual([]);
  });

  it('places several timed captions and truncates the last one at the end of its clip', () => {
    const style = { fontScale: 0.045, bottomMargin: 0.06, fadeIn: true, fadeOut: true, fadeSeconds: 0.5 };
    const clip = mediaClip('a', 10, {
      captions: [
        { ...style, id: 'one', text: 'First', startSeconds: 1, durationSeconds: 2 },
        {
          ...style, id: 'two', text: 'Second', startSeconds: 3, durationSeconds: 20,
          style: 'behind-subject', stylePreset: 'behind-subject', positionX: 0.5, positionY: 0.5
        }
      ]
    });

    const plan = buildProjectPlan([clip], project(), 'video');

    expect(plan.captions.map(({ start, end, caption }) => [start, end, caption.text])).toEqual([
      [1, 3, 'First'],
      [3, 10, 'Second']
    ]);
    expect(captionAt(plan.captions, 2)?.caption.text).toBe('First');
    expect(captionAt(plan.captions, 3)?.caption.text).toBe('Second');
    expect(captionAt(plan.captions, 3)?.caption.style).toBe('behind-subject');
    expect(captionAt(plan.captions, 10)).toBeNull();
  });

  it('places several Video Effects on the source clock and leaves gaps untouched', () => {
    const clip = mediaClip('a', 10, { videoEffects: [
      { id: 'one', effectId: 'cinematic', intensity: 0.5, startSeconds: 1, durationSeconds: 2 },
      { id: 'two', effectId: 'vhs', intensity: 0.8, startSeconds: 5, durationSeconds: 2 }
    ] });
    const plan = buildProjectPlan([clip], project(), 'video');

    expect(plan.videoEffects.map(segment => [segment.start, segment.end, segment.effect.id])).toEqual([
      [1, 3, 'cinematic'], [5, 7, 'vhs']
    ]);
    expect(videoEffectAt(plan.videoEffects, 2)?.id).toBe('cinematic');
    expect(videoEffectAt(plan.videoEffects, 4)).toBeNull();
    expect(videoEffectAt(plan.videoEffects, 6)?.id).toBe('vhs');
  });

  it('translates effect segments through cuts, speed and trim', () => {
    const cut = mediaClip('cut', 10, {
      manualCuts: [range(3, 5)],
      videoEffects: [{ effectId: 'film', intensity: 1, startSeconds: 2, durationSeconds: 5 }]
    });
    const fast = mediaClip('fast', 10, {
      videoEffects: [{ effectId: 'vibrant', intensity: 1, startSeconds: 2, durationSeconds: 4 }]
    });
    const trimmed = mediaClip('trimmed', 10, {
      inPoint: 2,
      videoEffects: [{ effectId: 'noir', intensity: 1, startSeconds: 3, durationSeconds: 2 }]
    });

    const cutPlan = buildProjectPlan([cut], project(), 'video');
    expect(cutPlan.videoEffects[0]).toEqual(jasmine.objectContaining({ start: 2, end: 5 }));
    const fastPlan = buildProjectPlan([fast], project({ speed: 2 }), 'video');
    expect(fastPlan.videoEffects[0]).toEqual(jasmine.objectContaining({ start: 1, end: 3 }));
    const trimPlan = buildProjectPlan([trimmed], project(), 'video');
    expect(trimPlan.videoEffects[0]).toEqual(jasmine.objectContaining({ start: 1, end: 3 }));
  });

  it('migrates a legacy whole-clip effect into the plan', () => {
    const clip = mediaClip('legacy', 8, { videoEffect: { id: 'cinematic', intensity: 0.6 } });
    const plan = buildProjectPlan([clip], project(), 'video');
    expect(plan.videoEffects).toEqual([jasmine.objectContaining({
      start: 0, end: 8, clipId: 'legacy', effect: { id: 'cinematic', intensity: 0.6 }
    })]);
  });

  it('reports free effect slots and rejects overlapping source intervals', () => {
    const clip = mediaClip('slots', 10, { videoEffects: [
      { id: 'a', effectId: 'film', intensity: 1, startSeconds: 1, durationSeconds: 2 },
      { id: 'b', effectId: 'vhs', intensity: 1, startSeconds: 5, durationSeconds: 2 }
    ] });
    expect(videoEffectSlotFor(clip, 0)).toBe(1);
    expect(videoEffectSlotFor(clip, 2)).toBe(0);
    expect(videoEffectSlotFor(clip, 3)).toBe(2);
    expect(videoEffectsOverlap(clip)).toBeFalse();
    expect(videoEffectsOverlap(clip, [...clip.videoEffects!, {
      id: 'c', effectId: 'noir', intensity: 1, startSeconds: 2.5, durationSeconds: 1
    }])).toBeTrue();
  });

  it('reports the clips that would play over black or over silence', () => {
    const silent = mediaClip('s', 5);
    silent.summary.audioUsable = false;
    const pictureless = mediaClip('p', 5);
    pictureless.summary.videoUsable = false;

    const plan = buildProjectPlan([silent, pictureless], project(), 'video');

    expect(plan.silentCount).toBe(1);
    expect(plan.audioOnlyCount).toBe(1);
    expect(plan.hasPicture).toBeTrue();
  });
});

describe('the sound of a clip', () => {
  /**
   * Where a clip's sound comes from is settled by the whole timeline, not by
   * the clip alone: "continue" reads backwards, and the project's default fills
   * in for footage that arrived with nothing.
   */
  it('gives a clip with no sound of its own the project default', () => {
    const plan = buildProjectPlan([silentClip('a', 10)], project({}, { defaultAudio: soundtrack() }), 'video');

    expect(plan.clips[0].sound.kind).toBe('file');
    expect(plan.silentCount).toBe(0);
  });

  it('gives recognized timelapse footage the project default instead of accelerated source audio', () => {
    const clip = mediaClip('timelapse', 60);
    clip.summary.isTimelapse = true;
    const plan = buildProjectPlan([clip], project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');

    expect(plan.clips[0].sound.kind).toBe('file');
    if (plan.clips[0].sound.kind === 'file') expect(plan.clips[0].sound.label).toBe('score.mp3');
  });

  it('uses the project sound when silence cutting removes more than the configured share', () => {
    const clip = mediaClip('mostly-silence', 10, { detected: [range(0, 8.1)] });
    const settings = project(
      { cutSilence: true },
      { defaultAudio: soundtrack(), silentCutReplacementThreshold: 0.8 }
    );

    const plan = buildProjectPlan([clip], settings, 'video');

    expect(plan.clips[0].sound.kind).toBe('file');
  });

  it('keeps the original sound at or below the configured silence-cut share', () => {
    const clip = mediaClip('mostly-speech', 10, { detected: [range(0, 8)] });
    const settings = project(
      { cutSilence: true },
      { defaultAudio: soundtrack(), silentCutReplacementThreshold: 0.8 }
    );

    const plan = buildProjectPlan([clip], settings, 'video');

    expect(plan.clips[0].sound.kind).toBe('original');
  });

  it('does not count manual cuts as silence for automatic sound replacement', () => {
    const clip = mediaClip('manual-edit', 10, {
      manualCuts: [{ start: 0, end: 9, source: 'manual', enabled: true }]
    });
    const settings = project(
      { cutSilence: true },
      { defaultAudio: soundtrack(), silentCutReplacementThreshold: 0.8 }
    );

    const plan = buildProjectPlan([clip], settings, 'video');

    expect(plan.clips[0].sound.kind).toBe('original');
  });

  it('leaves it silent when the project has no default', () => {
    const plan = buildProjectPlan([silentClip('a', 10)], project(), 'video');

    expect(plan.clips[0].sound.kind).toBe('original');
    expect(plan.silentCount).toBe(1);
  });

  /**
   * The condition the timeline draws a red ring for: a clip with nothing of its
   * own, nothing chosen for it, and nothing running into it. A clip that keeps
   * its own sound starts no track — there is no file to carry — so the silent
   * clip after it really does play over nothing, and the row must say so.
   *
   * Checked here rather than in the component because this is the fact; the
   * component only reads `sound.kind` back and colours it.
   */
  it('leaves a silent clip after a clip playing its own sound silent', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), silentClip('b', 6)];

    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.clips[0].sound.kind).toBe('original');
    expect(plan.clips[1].sound.kind).toBe('original');
  });

  /** The same pair, once the project has a default: no hole, so no warning. */
  it('covers that clip as soon as the project has a default', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), silentClip('b', 6)];

    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack() }), 'video');

    expect(plan.clips[1].sound.kind).toBe('file');
  });

  it('lets a track already running carry through a silent clip', () => {
    const first = mediaClip('a', 10, {
      replacementAudio: soundtrack('score.mp3'),
      overrides: { ...cloneEdits(DEFAULT_EDITS), audioMode: 'replace' }
    });
    const clips: EditorClip[] = [first, silentClip('b', 6)];

    // The first clip is told to play the file; the second brought nothing, so
    // rather than restarting the same file it picks up where the first left it.
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack() }), 'video');
    const second = plan.clips[1].sound;

    expect(second.kind).toBe('file');
    if (second.kind === 'file') {
      expect(second.label).toBe('score.mp3');
      expect(second.offset).toBe(10);
    }
  });

  /**
   * "Keep the clip's own sound" is about what to keep, not a refusal of help.
   *
   * A clip that has sound keeps it and is given nothing else — no doubling with
   * the project's track. A clip that has none has nothing to keep, so the
   * fallback applies and it plays the project's default rather than leaving a
   * hole in the middle of the edit.
   */
  it('leaves a clip that has its own sound alone, even with a project default', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), silentClip('b', 10)];

    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack() }), 'video');

    expect(plan.clips[0].sound.kind).toBe('original');
    expect(plan.clips[1].sound.kind).toBe('file');
  });

  /**
   * "Continue the sound from the previous clip" with nothing running keeps the
   * clip's own sound rather than falling silent — the instruction is about a
   * track that exists, and there is no track.
   */
  it('falls back to a clip\'s own sound when there is nothing to continue', () => {
    const clip = mediaClip('b', 10);
    clip.overrides = { ...cloneEdits(DEFAULT_EDITS), audioMode: 'continue' };
    const clips: EditorClip[] = [mediaClip('a', 10), clip];

    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.clips[1].sound.kind).toBe('original');
  });

  it('respects a clip silenced on purpose', () => {
    const plan = buildProjectPlan(
      [silentClip('a', 10)],
      project({ audioMode: 'mute' }, { defaultAudio: soundtrack() }),
      'video'
    );

    expect(plan.clips[0].sound.kind).toBe('mute');
  });

  /**
   * One rule, with no exception carved out for one kind of clip.
   *
   * This used to assert the opposite, on the reasoning that a title never had
   * sound to lose and so music under one should be a decision rather than
   * something inherited. That was a distinction the tool was making and the
   * reader was not — the visible result was a title falling silent in the middle
   * of a soundtrack. "The project's sound plays wherever there is none" is the
   * rule, and a card is a place with none.
   */
  it('puts the default under a text card, like anything else with no sound', () => {
    const plan = buildProjectPlan([textClip('t', 2, 3)], project({}, { defaultAudio: soundtrack() }), 'video');

    expect(plan.clips[0].sound.kind).toBe('file');
  });

  it('leaves a text card silent when the project has no default', () => {
    const plan = buildProjectPlan([textClip('t', 2, 3)], project(), 'video');

    // Nothing to inherit, so nothing plays — and the summary counts it.
    expect(plan.clips[0].sound.kind).toBe('original');
    expect(plan.silentCount).toBe(1);
  });

  /**
   * A card between two shots is where a soundtrack used to break. It now carries
   * the track straight through, which is the whole point of the change.
   */
  it('carries a running soundtrack through a text card', () => {
    const clips: EditorClip[] = [silentClip('a', 6), textClip('t', 2, 3), silentClip('b', 4)];

    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack() }), 'video');

    expect(plan.clips.map((entry) => entry.sound.kind)).toEqual(['file', 'file', 'file']);

    // One unbroken run: the card picks the track up where the shot before it
    // left off, and the shot after it picks up from the card.
    const card = plan.clips[1].sound;
    const after = plan.clips[2].sound;
    if (card.kind === 'file') expect(card.offset).toBeCloseTo(6, 5);
    if (after.kind === 'file') expect(after.offset).toBeCloseTo(11, 5);
  });

  /**
   * ...but the decision has to be available. A card is where an opening theme
   * goes, and until it could be given a file the only way to put one there was
   * to hang it on the shot afterwards.
   */
  it('plays the file a text card was given', () => {
    const card = textClip('t', 2, 3);
    card.replacementAudio = soundtrack('theme.mp3');
    card.overrides = { ...cloneEdits(DEFAULT_EDITS), audioMode: 'replace' };

    const sound = buildProjectPlan([card], project(), 'video').clips[0].sound;
    expect(sound.kind).toBe('file');
    if (sound.kind === 'file') expect(sound.label).toBe('theme.mp3');
  });

  it("falls back to the project's sound for a card asked to play one", () => {
    const card = textClip('t', 2, 3);
    card.overrides = { ...cloneEdits(DEFAULT_EDITS), audioMode: 'replace' };

    const plan = buildProjectPlan([card], project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');
    const sound = plan.clips[0].sound;

    expect(sound.kind).toBe('file');
    if (sound.kind === 'file') expect(sound.label).toBe('score.mp3');
  });

  it('lets a card carry a running track straight through a title', () => {
    const card = textClip('t', 1, 1);
    card.overrides = { ...cloneEdits(DEFAULT_EDITS), audioMode: 'continue' };

    const clips: EditorClip[] = [silentClip('a', 6), card, silentClip('b', 4)];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');
    const offsets = plan.clips.map((entry) => (entry.sound.kind === 'file' ? entry.sound.offset : -1));

    // One unbroken track: nothing restarts, and nothing drops to silence under
    // the title — so the run gets one ramp at each end rather than three pairs.
    expect(offsets).toEqual([0, 6, 8]);
    expect(plan.soundFades.length).toBe(2);
  });

  /**
   * Replacing the sound of the whole project means one piece of music over the
   * whole project. Every clip used to start the same file again from its
   * beginning, which turned a soundtrack into a stutter — audible immediately
   * and impossible to explain by anything on screen.
   */
  it('carries one replacement track across every clip that asks for it', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), mediaClip('b', 6), mediaClip('c', 4)];
    const plan = buildProjectPlan(
      clips,
      project({ audioMode: 'replace' }, { defaultAudio: soundtrack('score.mp3') }),
      'video'
    );

    const offsets = plan.clips.map((entry) => (entry.sound.kind === 'file' ? entry.sound.offset : -1));
    expect(offsets).toEqual([0, 10, 16]);
  });

  it('starts a different file at its own beginning', () => {
    const second = mediaClip('b', 6, {
      replacementAudio: soundtrack('other.mp3'),
      overrides: { ...cloneEdits(DEFAULT_EDITS), audioMode: 'replace' }
    });
    const clips: EditorClip[] = [mediaClip('a', 10), second];

    const plan = buildProjectPlan(
      clips,
      project({ audioMode: 'replace' }, { defaultAudio: soundtrack('score.mp3') }),
      'video'
    );

    const sound = plan.clips[1].sound;
    expect(sound.kind).toBe('file');
    if (sound.kind === 'file') {
      expect(sound.label).toBe('other.mp3');
      expect(sound.offset).toBe(0);
    }
  });

  /**
   * The case the whole rule exists for: two clips in a row that brought no
   * sound. The second must continue what the first started rather than drop to
   * silence or restart the file.
   */
  it('plays one continuous track under a run of silent clips', () => {
    const clips: EditorClip[] = [silentClip('a', 4), silentClip('b', 5), silentClip('c', 3)];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');

    const offsets = plan.clips.map((entry) => (entry.sound.kind === 'file' ? entry.sound.offset : -1));
    expect(offsets).toEqual([0, 4, 9]);
    expect(plan.silentCount).toBe(0);
  });

  /**
   * The soundtrack's own ramps. Not the clip's: a clip's fade takes the picture
   * with it and happens at a cut, while these belong to the *track* — one rise
   * where a piece of music begins and one fall where it ends, however many
   * clips it spans.
   */
  it('opens and closes each run of supplied sound once', () => {
    const clips: EditorClip[] = [silentClip('a', 10), silentClip('b', 10), silentClip('c', 10)];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack() }), 'video');

    // Three clips, one file, one continuous run: two ramps, not six.
    expect(plan.soundFades.length).toBe(2);
    expect(plan.soundFades[0]).toEqual({ start: 0, end: 1.5, kind: 'in' });
    expect(plan.soundFades[1]).toEqual({ start: 28.5, end: 30, kind: 'out' });
  });

  it('gives a second file a run of its own', () => {
    const second = mediaClip('b', 8, {
      replacementAudio: soundtrack('other.mp3'),
      overrides: { ...cloneEdits(DEFAULT_EDITS), audioMode: 'replace' }
    });
    const clips: EditorClip[] = [silentClip('a', 10), second];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');

    expect(plan.soundFades.length).toBe(4);
    expect(plan.soundFades.map((fade) => fade.kind)).toEqual(['in', 'out', 'in', 'out']);
    expect(plan.soundFades[2].start).toBe(10);
  });

  it('splits a run too short for both ramps in half', () => {
    const plan = buildProjectPlan([silentClip('a', 2)], project({}, { defaultAudio: soundtrack() }), 'video');

    expect(plan.soundFades[0]).toEqual({ start: 0, end: 1, kind: 'in' });
    expect(plan.soundFades[1]).toEqual({ start: 1, end: 2, kind: 'out' });
  });

  /**
   * A clip's fade is about the shot. A soundtrack playing straight through the
   * cut must not dip at it, or the edit sounds like a fault rather than a
   * decision — so the picture takes the ramp and the sound does not.
   */
  it('fades the picture but not a soundtrack carrying on through the cut', () => {
    const clips: EditorClip[] = [silentClip('a', 10), silentClip('b', 10)];
    const settings = project({ fadeIn: true, fadeOut: true, fadeSeconds: 1 }, { defaultAudio: soundtrack() });
    const plan = buildProjectPlan(clips, settings, 'video');

    // Four ramps on the picture — one at each end of each clip.
    expect(plan.fades.length).toBe(4);
    // Only the first entrance remains. The first clip's fade-out is also
    // removed, because it would dip the same track immediately before the
    // second clip inherits it.
    expect(plan.audioFades).toEqual([{ start: 0, end: 1, kind: 'in' }]);
  });

  it('does not fade inherited sound inside a transition overlap', () => {
    const second = silentClip('b', 10);
    second.overrides = { ...cloneEdits(DEFAULT_EDITS), fadeIn: true, fadeOut: true, audioMode: 'continue' };
    const clips: EditorClip[] = [
      silentClip('a', 10),
      transitionClip('join', 1),
      second
    ];
    const settings = project(
      { fadeIn: true, fadeOut: true, fadeSeconds: 1 },
      { defaultAudio: soundtrack() }
    );

    const plan = buildProjectPlan(clips, settings, 'video');

    // Two ramps on the picture, not four: the transition takes the pair that
    // would have met inside it, leaving the opening and the closing fade.
    expect(plan.fades.length).toBe(2);
    expect(plan.audioFades).toEqual([{ start: 0, end: 1, kind: 'in' }]);
  });

  it('still fades the sound of a clip playing its own', () => {
    const settings = project({ fadeIn: true, fadeOut: true, fadeSeconds: 1 });
    const plan = buildProjectPlan([mediaClip('a', 10), mediaClip('b', 10)], settings, 'video');

    expect(plan.audioFades.length).toBe(plan.fades.length);
  });

  it('leaves the track alone when both ramps are off', () => {
    const settings = project({}, { defaultAudio: soundtrack() });
    settings.soundFade = { fadeIn: false, fadeOut: false, seconds: 1.5 };

    expect(buildProjectPlan([silentClip('a', 10)], settings, 'video').soundFades).toEqual([]);
  });

  it('plans no ramps for a timeline with no supplied sound', () => {
    expect(buildProjectPlan([mediaClip('a', 10)], project(), 'video').soundFades).toEqual([]);
  });

  /**
   * The failure this was written for: a silent clip that came *after* a clip
   * with sound of its own stopped playing the project's soundtrack, because the
   * track had already been used up by the silent clips before it and reading
   * past the end of a file yields nothing at all.
   */
  it('restarts a carried track whose tail is too short for the clip', () => {
    const clips: EditorClip[] = [silentClip('a', 40), mediaClip('b', 10), silentClip('c', 30)];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');

    // The soundtrack is 60s long. Clip A eats 40 of it and clip B keeps its own
    // sound. Reading on from 40s would give clip C twenty seconds of music and
    // ten of silence, so it goes back to the top instead — and there is nothing
    // to warn about.
    const third = plan.clips[2].sound;
    expect(third.kind).toBe('file');
    if (third.kind === 'file') expect(third.offset).toBe(0);
    expect(plan.clips[2].soundShort).toBeFalse();
  });

  it('keeps reading on when the tail is long enough', () => {
    // The restart is a repair, not a habit: a track with room to spare carries
    // on where it left off, which is what makes a sequence sound continuous.
    const clips: EditorClip[] = [silentClip('a', 10), silentClip('b', 10)];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');
    const second = plan.clips[1].sound;

    expect(second.kind).toBe('file');
    if (second.kind === 'file') expect(second.offset).toBe(10);
  });

  /**
   * A soundtrack chosen for one clip used to become the track every later
   * silent clip inherited. A three-second sting under a title would then be
   * carried — and flagged in red — under the forty-second shot after it, while
   * the project's own minute of music sat unused.
   */
  it('does not carry a clip\'s short sting into the clips after it', () => {
    const sting = silentClip('b', 10);
    sting.replacementAudio = soundtrack('sting.mp3');
    sting.replacementAudio.summary.durationSeconds = 3;
    sting.overrides = { ...cloneEdits(DEFAULT_EDITS), audioMode: 'replace' };

    const clips: EditorClip[] = [silentClip('a', 5), sting, silentClip('c', 40)];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');
    const third = plan.clips[2].sound;

    expect(third.kind).toBe('file');
    if (third.kind === 'file') expect(third.label).toBe('score.mp3');
    expect(plan.clips[2].soundShort).toBeFalse();
  });

  it('never flags a clip for a file the reader chose for it', () => {
    // Putting a three-second sting under a ten-second title is a decision, and
    // the tool documents what it does with one. Shouting about it in red would
    // make the warning something to learn to ignore.
    const sting = silentClip('a', 10);
    sting.replacementAudio = soundtrack('sting.mp3');
    sting.replacementAudio.summary.durationSeconds = 3;
    sting.overrides = { ...cloneEdits(DEFAULT_EDITS), audioMode: 'replace' };

    expect(buildProjectPlan([sting], project(), 'video').clips[0].soundShort).toBeFalse();
  });

  it('says when nothing available can cover a clip', () => {
    // Sixty seconds of music under ninety seconds of picture, and no other file
    // to fall back to. This is the one case worth a warning.
    const plan = buildProjectPlan([silentClip('a', 90)], project({}, { defaultAudio: soundtrack() }), 'video');

    expect(plan.clips[0].soundShort).toBeTrue();
  });

  it('reads a supplied file from its first sound rather than its first sample', () => {
    const music = soundtrack('score.mp3');
    music.trimStart = 3;
    music.skipLeadingSilence = true;

    const clips: EditorClip[] = [silentClip('a', 5), silentClip('b', 5)];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: music }), 'video');
    const offsets = plan.clips.map((entry) => (entry.sound.kind === 'file' ? entry.sound.offset : -1));

    expect(offsets).toEqual([3, 8]);
  });

  it('prefers the file a silent clip was given over the project default', () => {
    const clip = silentClip('a', 4);
    clip.replacementAudio = soundtrack('its-own.mp3');

    const plan = buildProjectPlan([clip], project({}, { defaultAudio: soundtrack('score.mp3') }), 'video');

    const sound = plan.clips[0].sound;
    expect(sound.kind).toBe('file');
    if (sound.kind === 'file') expect(sound.label).toBe('its-own.mp3');
  });
});

describe('sourceTimeAt', () => {
  /**
   * This is the calculation the preview and the encoder have to agree on: one
   * asks it sixty times a second to know what the decoder should show, the
   * other inverted it to place every sample. A discrepancy here is a preview
   * that shows a different edit than the file.
   */
  const clip = mediaClip('a', 20, { detected: [range(5, 10)] });

  it('maps straight through when nothing was cut and nothing sped up', () => {
    const plan = buildProjectPlan([clip], project(), 'video');

    expect(sourceTimeAt(plan.clips[0], 7).sourceTime).toBeCloseTo(7, 6);
  });

  it('steps over a removed stretch', () => {
    const plan = buildProjectPlan([clip], project({ cutSilence: true }), 'video');

    // The first five seconds survive; everything after them is the far side of
    // the cut, so output second six is source second eleven.
    expect(sourceTimeAt(plan.clips[0], 4).sourceTime).toBeCloseTo(4, 6);
    expect(sourceTimeAt(plan.clips[0], 6).sourceTime).toBeCloseTo(11, 6);
    expect(sourceTimeAt(plan.clips[0], 6).rangeIndex).toBe(1);
  });

  it('accounts for speed and for where the clip sits', () => {
    const plan = buildProjectPlan([mediaClip('lead', 4), clip], project({ cutSilence: true, speed: 2 }), 'video');
    const entry = plan.clips[1];

    // The lead clip lasts two seconds at double speed, so the second clip
    // starts there; two output seconds into it is four source seconds.
    expect(entry.outputStart).toBeCloseTo(2, 6);
    expect(sourceTimeAt(entry, 4).sourceTime).toBeCloseTo(4, 6);
  });

  it('is the inverse of outputTimeOf', () => {
    const plan = buildProjectPlan([mediaClip('lead', 4), clip], project({ cutSilence: true, speed: 2 }), 'video');
    const entry = plan.clips[1];

    for (const time of [2, 3, 3.5, 5, 6]) {
      const { rangeIndex, sourceTime } = sourceTimeAt(entry, time);
      expect(outputTimeOf(entry, rangeIndex, sourceTime)).toBeCloseTo(time, 6);
    }
  });
});

describe('clipIndexAt', () => {
  it('finds the clip covering an instant, and holds the last one at the end', () => {
    const plan = buildProjectPlan([mediaClip('a', 10), mediaClip('b', 5)], project(), 'video');

    expect(clipIndexAt(plan, 0)).toBe(0);
    expect(clipIndexAt(plan, 9.9)).toBe(0);
    expect(clipIndexAt(plan, 10)).toBe(1);
    expect(clipIndexAt(plan, 99)).toBe(1);
  });
});

describe('fadeGainAt', () => {
  const fades = [
    { start: 0, end: 2, kind: 'in' as const },
    { start: 8, end: 10, kind: 'out' as const }
  ];

  it('is neutral between the ramps', () => {
    expect(fadeGainAt(fades, 5)).toBe(1);
  });

  it('rises from nothing and falls back to it', () => {
    expect(fadeGainAt(fades, 0)).toBe(0);
    expect(fadeGainAt(fades, 1)).toBeCloseTo(0.5, 6);
    expect(fadeGainAt(fades, 9)).toBeCloseTo(0.5, 6);
  });
});

describe('captionAt', () => {
  const caption = { text: 'Hello', fontScale: 0.045, bottomMargin: 0.06, fadeIn: true, fadeOut: true, fadeSeconds: 1 };
  const captions = [{ start: 10, end: 20, caption }];

  it('shows nothing outside the clip it belongs to', () => {
    expect(captionAt(captions, 5)).toBeNull();
    expect(captionAt(captions, 25)).toBeNull();
  });

  it('fades in and out on its own clock', () => {
    expect(captionAt(captions, 10)?.opacity).toBe(0);
    expect(captionAt(captions, 10.5)?.opacity).toBeCloseTo(0.5, 6);
    expect(captionAt(captions, 15)?.opacity).toBe(1);
    expect(captionAt(captions, 19.5)?.opacity).toBeCloseTo(0.5, 6);
    expect(captionAt(captions, 10)?.progress).toBe(0);
    expect(captionAt(captions, 15)?.progress).toBeCloseTo(0.5, 6);
    expect(captionAt(captions, 19.5)?.progress).toBeCloseTo(0.95, 6);
  });
});

/**
 * Transitions are the one thing on this timeline that makes two clips share a
 * stretch of it, and every number in the plan is downstream of where clips
 * start. So this is where the arithmetic is pinned: what the overlap costs, who
 * pays for it, and what happens when nobody can.
 */
describe('joining two shots', () => {
  it('makes the second shot begin before the first one ends', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6), mediaClip('b', 10)];

    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.clips.length).toBe(2);
    expect(plan.clips[1].outputStart).toBeCloseTo(9.4, 6);
    expect(plan.totalDuration).toBeCloseTo(19.4, 6);
    expect(plan.transitions.length).toBe(1);
    expect(plan.transitions[0].start).toBeCloseTo(9.4, 6);
    expect(plan.transitions[0].end).toBeCloseTo(10, 6);
  });

  /**
   * A project set to fade every clip, with a transition between two of them.
   *
   * The two things want the same seconds and mean opposite things by them. A
   * transition dissolves one shot into the other; the fades take the first one
   * down to black and bring the second one up out of black underneath it, so
   * the join blinks. The transition wins, and only the two ramps that face each
   * other across it are dropped.
   */
  it('drops the two fades that meet at a transition', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6), mediaClip('b', 10)];
    const settings = project({ fadeIn: true, fadeOut: true, fadeSeconds: 1 });

    const plan = buildProjectPlan(clips, settings, 'video');

    expect(plan.fades).toEqual([
      { start: 0, end: 1, kind: 'in' },
      { start: 18.4, end: 19.4, kind: 'out' }
    ]);
  });

  it('keeps every fade when the same two shots are simply cut together', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), mediaClip('b', 10)];
    const settings = project({ fadeIn: true, fadeOut: true, fadeSeconds: 1 });

    expect(buildProjectPlan(clips, settings, 'video').fades.length).toBe(4);
  });

  it('leaves only the opening and the closing fade across a run of joins', () => {
    const clips: EditorClip[] = [
      mediaClip('a', 10), transitionClip('t1', 0.6),
      mediaClip('b', 10), transitionClip('t2', 0.6),
      mediaClip('c', 10)
    ];
    const settings = project({ fadeIn: true, fadeOut: true, fadeSeconds: 1 });

    const plan = buildProjectPlan(clips, settings, 'video');

    expect(plan.fades.map((fade) => fade.kind)).toEqual(['in', 'out']);
    expect(plan.fades[0].start).toBeCloseTo(0, 6);
    expect(plan.fades[1].end).toBeCloseTo(plan.totalDuration, 6);
  });

  it('does not dip the sound to silence in the middle of a transition', () => {
    // A transition hands the sound over at one instant rather than mixing the
    // two tracks, so a fade-out and a fade-in meeting there are not a crossfade.
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6), mediaClip('b', 10)];
    const settings = project({ fadeIn: true, fadeOut: true, fadeSeconds: 1 });

    const plan = buildProjectPlan(clips, settings, 'video');
    const join = plan.transitions[0];

    expect(fadeGainAt(plan.audioFades, (join.start + join.end) / 2)).toBe(1);
    expect(fadeGainAt(plan.fades, (join.start + join.end) / 2)).toBe(1);
  });

  /**
   * The point of the whole design. With a pause at the end of one shot and the
   * start of the next, the transition is paid for out of silence the cut would
   * have thrown away — so it costs the edit nothing, and no speech goes under
   * the animation.
   */
  it('pays for itself out of the silence the cut would have removed', () => {
    const before = mediaClip('a', 10);
    before.detected = [range(9, 10)];
    const after = mediaClip('b', 10);
    after.detected = [range(0, 1)];

    const clips: EditorClip[] = [before, transitionClip('t', 0.6), after];
    const plan = buildProjectPlan(clips, project({ cutSilence: true }), 'video');

    // 9 + 9 kept, 0.3 of silence bought back at each side, 0.6 of overlap: the
    // two cancel exactly.
    expect(plan.totalDuration).toBeCloseTo(18, 5);
    expect(plan.transitions[0].fromSilence).toBeCloseTo(0.6, 5);
    expect(plan.transitions[0].overContent).toBe(false);
  });

  it('takes the shortfall from one side when the other has nothing to give', () => {
    const before = mediaClip('a', 10);
    before.detected = [range(9, 10)];
    const after = mediaClip('b', 10);

    const clips: EditorClip[] = [before, transitionClip('t', 0.6), after];
    const plan = buildProjectPlan(clips, project({ cutSilence: true }), 'video');

    expect(plan.transitions[0].fromSilence).toBeCloseTo(0.6, 5);
    expect(plan.transitions[0].overContent).toBe(false);
  });

  it('says so when the animation has to play over content', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6), mediaClip('b', 10)];

    const plan = buildProjectPlan(clips, project({ cutSilence: true }), 'video');

    expect(plan.transitions[0].fromSilence).toBeCloseTo(0, 6);
    expect(plan.transitions[0].overContent).toBe(true);
  });

  it('never eats a whole shot', () => {
    const clips: EditorClip[] = [mediaClip('a', 1), transitionClip('t', 4), mediaClip('b', 10)];

    const plan = buildProjectPlan(clips, project(), 'video');
    const join = plan.transitions[0];

    expect(join.end - join.start).toBeLessThan(1);
    expect(plan.clips[1].outputStart).toBeGreaterThan(0);
  });

  it('ignores a transition with nothing before it', () => {
    const clips: EditorClip[] = [transitionClip('t', 0.6), mediaClip('a', 10), mediaClip('b', 10)];

    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.transitions.length).toBe(0);
    expect(plan.totalDuration).toBeCloseTo(20, 6);
  });

  it('ignores one left dangling at the end', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), mediaClip('b', 10), transitionClip('t', 0.6)];

    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.transitions.length).toBe(0);
  });

  it('applies the project default at every join', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), mediaClip('b', 10), mediaClip('c', 10)];
    const settings = project({}, { defaultTransition: { kind: 'iris', seconds: 0.5, colour: '#000000' } });

    const plan = buildProjectPlan(clips, settings, 'video');

    expect(plan.transitions.length).toBe(2);
    expect(plan.transitions.every((join) => join.settings.kind === 'iris')).toBe(true);
    expect(plan.totalDuration).toBeCloseTo(29, 6);
  });

  it('lets a transition added by hand win over the project default', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6, 'ink-brush-down'), mediaClip('b', 10)];
    const settings = project({}, { defaultTransition: { kind: 'iris', seconds: 2, colour: '#000000' } });

    const plan = buildProjectPlan(clips, settings, 'video');

    expect(plan.transitions.length).toBe(1);
    expect(plan.transitions[0].settings.kind).toBe('ink-brush-down');
    expect(plan.transitions[0].end - plan.transitions[0].start).toBeCloseTo(0.6, 6);
  });

  /**
   * The failure this was written for: the run-continuation test used to demand
   * that one clip end exactly where the next began. An overlap breaks that by
   * construction, and the result was a fade-out and a fade-in dropped into the
   * middle of a piece of music at every single join.
   */
  /**
   * A track restarted from its own first sound is a new run, not a continuation.
   *
   * The test used to be `offset > 0`, which is only "not at the beginning" for a
   * file that begins at zero. A recording whose head silence was measured
   * restarts at that measured instant, and against zero that read as "still
   * playing" — so the music jumped back to its own beginning at full volume,
   * with no ramp, in the middle of the project.
   */
  it('ramps the soundtrack again when it restarts from a measured head', () => {
    const track: SuppliedSound = { ...soundtrack(), trimStart: 0.4, skipLeadingSilence: true };
    track.summary.durationSeconds = 45;

    const clips: EditorClip[] = [silentClip('a', 40), mediaClip('b', 10), silentClip('c', 30)];
    const settings = project({}, { defaultAudio: track, soundFade: { fadeIn: true, fadeOut: true, seconds: 0.5 } });

    const plan = buildProjectPlan(clips, settings, 'video');

    // Two runs — the first forty seconds and the restart after the interview —
    // so two ramps up and two down.
    expect(plan.soundFades.length).toBe(4);
  });

  it('does not dip the soundtrack at a join', () => {
    const clips: EditorClip[] = [silentClip('a', 10), transitionClip('t', 0.6), silentClip('b', 10)];
    const settings = project({}, { defaultAudio: soundtrack(), soundFade: { fadeIn: true, fadeOut: true, seconds: 0.5 } });

    const plan = buildProjectPlan(clips, settings, 'video');

    // One run, so one ramp up at the start and one down at the end — not four.
    expect(plan.soundFades.length).toBe(2);
  });

  /**
   * A soundtrack running under a join must stay in step with the clock.
   *
   * Each clip is given a window into the file that is as long as the clip, and
   * the windows used to be laid end to end because clips were. An overlap breaks
   * that: two clips are both allotted the overlapping seconds, so the file is
   * consumed faster than the timeline advances and the music jumps forward by
   * the length of every transition it passes under.
   *
   * Stated as the invariant rather than as a number: for one continuous run
   * starting at the top of the file, the offset a clip reads from is the instant
   * it starts.
   */
  it('keeps a continuing soundtrack in step across a join', () => {
    const clips: EditorClip[] = [silentClip('a', 10), transitionClip('t', 1), silentClip('b', 10)];
    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack() }), 'video');

    const second = plan.clips[1];
    expect(second.sound.kind).toBe('file');
    if (second.sound.kind === 'file') {
      expect(second.sound.offset).toBeCloseTo(second.outputStart, 5);
    }
  });

  /**
   * The rewind is owed only when the previous clip was reading the same track.
   *
   * The failure: a clip that keeps its own sound pauses the soundtrack rather
   * than consuming it, so nothing was double-read — but the join after it wound
   * the track back anyway, and the music jumped *backwards* and repeated the
   * join's length at the resume point.
   */
  it('does not wind the track back when the previous clip was not playing it', () => {
    const first = mediaClip('a', 10, {
      overrides: { ...cloneEdits(DEFAULT_EDITS), audioMode: 'replace' }
    });
    const middle = mediaClip('b', 10);
    const last = mediaClip('c', 10, {
      overrides: { ...cloneEdits(DEFAULT_EDITS), audioMode: 'continue' }
    });
    const clips: EditorClip[] = [first, middle, transitionClip('t', 0.6), last];

    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack() }), 'video');
    const third = plan.clips[2].sound;

    expect(third.kind).toBe('file');
    // Where the first clip left it, not six tenths of a second before.
    if (third.kind === 'file') expect(third.offset).toBeCloseTo(10, 5);
  });

  /**
   * When the sound changes hands, and why it is not simply the end of the join.
   *
   * The version that always handed over at the end wrote the outgoing clip's
   * restored room tone over the first syllable of every incoming one.
   */
  it('hands the sound over where the incoming shot starts talking', () => {
    const before = mediaClip('a', 10);
    before.detected = [range(9, 10)];
    const after = mediaClip('b', 10);
    after.detected = [range(0, 1)];

    const clips: EditorClip[] = [before, transitionClip('t', 0.6), after];
    const plan = buildProjectPlan(clips, project({ cutSilence: true }), 'video');
    const join = plan.transitions[0];

    // Three tenths of silence were bought back from each side, so the incoming
    // shot's content begins three tenths into the join.
    expect(join.soundSwitch).toBeCloseTo(join.start + 0.3, 5);
  });

  it('hands the sound over at once when the incoming shot plays a file', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6), silentClip('b', 10)];

    const plan = buildProjectPlan(clips, project({}, { defaultAudio: soundtrack() }), 'video');
    const join = plan.transitions[0];

    // A file starts with its clip, so handing over later would lose its opening.
    expect(join.soundSwitch).toBeCloseTo(join.start, 6);
  });

  it('lets the outgoing shot play through a join into a silenced clip', () => {
    const muted = mediaClip('b', 10, { overrides: { ...cloneEdits(DEFAULT_EDITS), audioMode: 'mute' } });
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6), muted];

    const plan = buildProjectPlan(clips, project(), 'video');
    const join = plan.transitions[0];

    expect(join.soundSwitch).toBeCloseTo(join.end, 6);
  });

  /**
   * A transition may buy back silence the detector removed. It may not buy back
   * a region the reader drew over — that is them saying the take is no good.
   */
  it('never reclaims a cut the reader drew by hand', () => {
    const before = mediaClip('a', 10);
    before.detected = [range(9, 10)];
    const after = mediaClip('b', 10);
    after.detected = [range(0, 2)];
    after.manualCuts = [range(0, 2)];

    const clips: EditorClip[] = [before, transitionClip('t', 0.6), after];
    const plan = buildProjectPlan(clips, project({ cutSilence: true }), 'video');

    // The incoming clip still starts where the hand-drawn cut ends.
    expect(plan.clips[1].keepRanges[0].start).toBeCloseTo(2, 5);
    // So the whole join had to be paid for by the outgoing clip alone.
    expect(plan.transitions[0].soundSwitch).toBeCloseTo(plan.transitions[0].start, 6);
  });

  it('reports where the playhead is inside a join', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 1), mediaClip('b', 10)];
    const plan = buildProjectPlan(clips, project(), 'video');

    expect(transitionAt(plan, 8)).toBeNull();
    const join = transitionAt(plan, 9.5);
    expect(join).not.toBeNull();
    if (join) expect(transitionProgress(join, 9.5)).toBeCloseTo(0.5, 5);
  });

  /**
   * The failure this was written for: the silence given back was sized from what
   * the reader asked for, while the overlap that spends it was clamped to what
   * the shots could afford. The difference stayed on the timeline as dead air
   * the silence cut had already removed.
   */
  it('gives back only as much silence as the join actually spends', () => {
    const before = mediaClip('a', 10);
    before.detected = [range(8, 10)];
    const after = mediaClip('b', 10);
    after.detected = [range(0, 2)];

    const clips: EditorClip[] = [before, transitionClip('t', 3), after];
    const plan = buildProjectPlan(clips, project({ cutSilence: true }), 'video');
    const join = plan.transitions[0];
    const spent = join.end - join.start;

    // Whatever the clamp allowed, the silence bought back is the same number —
    // so the finished length is exactly what it would have been without the join.
    expect(join.fromSilence).toBeCloseTo(spent, 5);
    expect(plan.totalDuration).toBeCloseTo(16, 5);
  });

  /**
   * A clip between two joins is the outgoing side of one and the incoming side
   * of the other. Without a budget they each took most of it, the second join
   * started before the first had finished, and the encoder — whose timestamps
   * only ever go forwards — threw away all but the last frame or two of it.
   */
  it('does not let two joins spend the same short clip twice', () => {
    const clips: EditorClip[] = [
      mediaClip('a', 10),
      transitionClip('t1', 2),
      mediaClip('b', 1),
      transitionClip('t2', 2),
      mediaClip('c', 10)
    ];

    const plan = buildProjectPlan(clips, project(), 'video');
    const [first, second] = plan.transitions;

    expect(plan.transitions.length).toBe(2);
    expect(second.start).toBeGreaterThanOrEqual(first.end);
  });

  it('says which row each join came from', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6), mediaClip('b', 10)];

    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.transitions[0].clipId).toBe('t');
  });

  it('credits a join to the later of two transitions side by side', () => {
    const clips: EditorClip[] = [
      mediaClip('a', 10),
      transitionClip('t1', 0.6),
      transitionClip('t2', 0.8, 'iris'),
      mediaClip('b', 10)
    ];

    const plan = buildProjectPlan(clips, project(), 'video');

    expect(plan.transitions.length).toBe(1);
    expect(plan.transitions[0].clipId).toBe('t2');
    expect(plan.transitions[0].settings.kind).toBe('iris');
  });

  it('leaves a join out of the plan when it comes from the project rather than a row', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), mediaClip('b', 10)];
    const settings = project({}, { defaultTransition: { kind: 'dissolve', seconds: 0.5, colour: '#000000' } });

    const plan = buildProjectPlan(clips, settings, 'video');

    expect(plan.transitions[0].clipId).toBeNull();
  });

  it('keeps the fades in order even though the clips overlap', () => {
    const clips: EditorClip[] = [mediaClip('a', 10), transitionClip('t', 0.6), mediaClip('b', 10)];
    const settings = project({ fadeIn: true, fadeOut: true, fadeSeconds: 0.5 });

    const plan = buildProjectPlan(clips, settings, 'video');
    const starts = plan.fades.map((fade) => fade.start);

    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

/**
 * In and out points, and the split that is built out of them.
 *
 * The arithmetic worth pinning down here is not that a trim shortens a clip —
 * it is that two halves of a split clip add up to exactly the one they came
 * from, and that the project stops claiming to be twice as long the moment one
 * file appears on the timeline twice.
 */
describe('in and out points', () => {
  it('shortens the clip and moves everything after it', () => {
    const first = mediaClip('a', 10, { inPoint: 2, outPoint: 8 });
    const second = mediaClip('b', 4);
    const plan = buildProjectPlan([first, second], project(), 'video');

    expect(plan.clips[0].outputDuration).toBeCloseTo(6);
    expect(plan.clips[1].outputStart).toBeCloseTo(6);
    expect(plan.totalDuration).toBeCloseTo(10);
  });

  it('reads what is kept from inside the points, not from the file', () => {
    const clip = mediaClip('a', 10, { inPoint: 3, outPoint: 7 });

    expect(clipBounds(clip)).toEqual({ start: 3, end: 7 });
    expect(trimmedDuration(clip)).toBeCloseTo(4);
    expect(isTrimmed(clip)).toBe(true);
    expect(keepRangesFor(clip, DEFAULT_EDITS)).toEqual([{ start: 3, end: 7 }]);
  });

  it('leaves an untouched clip exactly as it was', () => {
    const clip = mediaClip('a', 10);

    expect(isTrimmed(clip)).toBe(false);
    expect(keepRangesFor(clip, DEFAULT_EDITS)).toEqual([{ start: 0, end: 10 }]);
  });

  it('counts one file split in two only once in the source length', () => {
    // The two halves share a file and between them cover it exactly, so the
    // project is the same length as it was before the split — and says so.
    const whole = buildProjectPlan([mediaClip('a', 10)], project(), 'video');

    const first = mediaClip('a', 10, { outPoint: 4 });
    const second = mediaClip('a2', 10, { inPoint: 4 });
    const split = buildProjectPlan([first, second], project(), 'video');

    expect(split.totalDuration).toBeCloseTo(whole.totalDuration);
    expect(split.sourceDuration).toBeCloseTo(whole.sourceDuration);
    expect(split.removedDuration).toBeCloseTo(0);
  });

  it('does not let a transition buy back silence from outside the points', () => {
    // The pause at the head of the file is real, and cut. It is also before the
    // in point, so the clip does not own it and the join may not spend it.
    const first = mediaClip('a', 10);
    const second = mediaClip('b', 10, {
      inPoint: 4,
      detected: [range(0, 2)]
    });

    const plan = buildProjectPlan(
      [first, transitionClip('t'), second],
      project({ cutSilence: true }),
      'video'
    );

    expect(plan.transitions[0].fromSilence).toBeCloseTo(0);
  });
});

describe('push-ins placed by hand', () => {
  it('puts one on the output timeline, after the clip before it', () => {
    const first = mediaClip('a', 5);
    const second = mediaClip('b', 10, {
      manualZooms: [{ id: 'z1', start: 2, end: 6, scalePercent: 20, rampSeconds: 0.5, easeOut: true }]
    });

    const plan = buildProjectPlan([first, second], project(), 'video');
    const zoom = plan.zooms[0];

    expect(plan.zooms.length).toBe(1);
    expect(zoom.start).toBeCloseTo(7);
    expect(zoom.end).toBeCloseTo(11);
    expect(zoom.scale).toBeCloseTo(1.2);
  });

  it('reads its position on the timeline the cuts left behind', () => {
    // Two seconds are removed before the push-in, so it arrives two seconds
    // earlier in the finished file than it sits in the file it was drawn on.
    const clip = mediaClip('a', 10, {
      detected: [range(1, 3)],
      manualZooms: [{ id: 'z1', start: 5, end: 8, scalePercent: 10, rampSeconds: 0, easeOut: true }]
    });

    const plan = buildProjectPlan([clip], project({ cutSilence: true }), 'video');

    expect(plan.zooms[0].start).toBeCloseTo(3);
    expect(plan.zooms[0].end).toBeCloseTo(6);
  });

  it('compresses with the clip when the clip is sped up', () => {
    const clip = mediaClip('a', 10, {
      manualZooms: [{ id: 'z1', start: 4, end: 8, scalePercent: 10, rampSeconds: 1, easeOut: true }]
    });

    const plan = buildProjectPlan([clip], project({ speed: 2 }), 'video');

    expect(plan.zooms[0].start).toBeCloseTo(2);
    expect(plan.zooms[0].end).toBeCloseTo(4);
    expect(plan.zooms[0].rampSeconds).toBeCloseTo(0.5);
  });

  it('collapses to nothing when everything it covered was cut', () => {
    const clip = mediaClip('a', 10, {
      detected: [range(4, 8)],
      manualZooms: [{ id: 'z1', start: 5, end: 7, scalePercent: 10, rampSeconds: 0, easeOut: true }]
    });

    const plan = buildProjectPlan([clip], project({ cutSilence: true }), 'video');

    expect(plan.zooms.length).toBe(0);
  });

  it('reads a position inside a removed stretch as the join it collapsed to', () => {
    expect(cutTimeOf([{ start: 0, end: 2 }, { start: 5, end: 9 }], 3)).toBeCloseTo(2);
    expect(cutTimeOf([{ start: 0, end: 2 }, { start: 5, end: 9 }], 6)).toBeCloseTo(3);
  });
});

describe('the shape of the frame', () => {
  it('keeps the long side going vertical, and the short side going square', () => {
    expect(reframeSize(1920, 1080, '9:16')).toEqual({ width: 1080, height: 1920 });
    expect(reframeSize(1920, 1080, '1:1')).toEqual({ width: 1080, height: 1080 });
    expect(reframeSize(1920, 1080, 'source')).toEqual({ width: 1920, height: 1080 });
  });

  it('reshapes the plan and says the picture is being cropped', () => {
    const plan = buildProjectPlan([mediaClip('a', 5)], project({}, { aspect: '9:16' }), 'video');

    expect(plan.width).toBe(1080);
    expect(plan.height).toBe(1920);
    expect(plan.fillFrame).toBe(true);
  });

  it('leaves an untouched project alone', () => {
    const plan = buildProjectPlan([mediaClip('a', 5)], project(), 'video');

    expect(plan.width).toBe(1920);
    expect(plan.height).toBe(1080);
    expect(plan.fillFrame).toBe(false);
  });

  it('lets the reader ask for bars instead of a crop', () => {
    const plan = buildProjectPlan([mediaClip('a', 5)], project({}, { aspect: '1:1', reframe: 'fit' }), 'video');

    expect(plan.width).toBe(1080);
    expect(plan.fillFrame).toBe(false);
  });
});

describe('slicePlan', () => {
  it('rebases what is left onto a timeline that starts at nought', () => {
    const clips = [mediaClip('a', 4), mediaClip('b', 6), mediaClip('c', 5)];
    const whole = buildProjectPlan(clips, project(), 'video');
    const rest = slicePlan(whole, 1);

    expect(rest.clips.length).toBe(2);
    expect(rest.clips[0].outputStart).toBeCloseTo(0);
    expect(rest.clips[1].outputStart).toBeCloseTo(6);
    expect(rest.totalDuration).toBeCloseTo(11);
    expect(rest.sourceDuration).toBeCloseTo(11);
  });

  it('gives back the whole plan when nothing was written yet', () => {
    const whole = buildProjectPlan([mediaClip('a', 4)], project(), 'video');

    expect(slicePlan(whole, 0)).toBe(whole);
  });

  it('shifts the fades and drops the join the other file already owns', () => {
    const clips = [mediaClip('a', 4), transitionClip('t'), mediaClip('b', 6)];
    const settings = project({ fadeIn: true, fadeOut: true, fadeSeconds: 0.5 });
    const whole = buildProjectPlan(clips, settings, 'video');
    const rest = slicePlan(whole, 1);

    // The transition arriving at the second clip came from a shot that is in
    // the first file, so it cannot be drawn here.
    expect(rest.transitions.length).toBe(0);
    expect(rest.fades.every((fade) => fade.start >= -1e-6)).toBe(true);
  });

  it('shifts timed effects together with captions', () => {
    const second = mediaClip('b', 6, {
      videoEffects: [{ effectId: 'film', intensity: 1, startSeconds: 1, durationSeconds: 2 }]
    });
    const whole = buildProjectPlan([mediaClip('a', 4), second], project(), 'video');
    const rest = slicePlan(whole, 1);
    expect(rest.videoEffects[0]).toEqual(jasmine.objectContaining({ start: 1, end: 3, clipId: 'b' }));
  });
});

/**
 * The arithmetic behind the timelapse target.
 *
 * The component decides *which* clips this happens to and when; what belongs
 * here is the number it lands on, because that is the part that can be wrong
 * silently — a clip that misses the target by a factor of eight looks like a
 * clip somebody set to the wrong speed.
 */
describe('timelapseSpeedFor', () => {
  it('hits the target exactly when the speed is available', () => {
    // Sixty seconds asked to last ten is six times, and six is on the grid.
    expect(timelapseSpeedFor(60, 10)).toBeCloseTo(6);
    expect(timelapseSpeedFor(20 * 60, 15)).toBeCloseTo(80);
  });

  it('slows a clip down when the target is longer than it is', () => {
    expect(timelapseSpeedFor(10, 20)).toBeCloseTo(0.5);
  });

  it('stops at the ceiling rather than promising a speed it cannot reach', () => {
    // Two hours to five seconds would be 1440×.
    expect(timelapseSpeedFor(2 * 60 * 60, 5)).toBe(SPEED_LIMITS.max);
  });

  it('stops at the floor rather than going backwards', () => {
    expect(timelapseSpeedFor(10, 600)).toBe(SPEED_LIMITS.min);
  });

  it('leaves the clip alone when there is no target', () => {
    expect(timelapseSpeedFor(60, 0)).toBe(1);
    expect(timelapseSpeedFor(60, Number.NaN)).toBe(1);
    expect(timelapseSpeedFor(0, 10)).toBe(1);
  });

  it('produces a plan whose clip really lasts the target', () => {
    // The point of the whole feature, checked through the planner rather than
    // against the formula that produced it.
    const clip = mediaClip('a', 300);
    const speed = timelapseSpeedFor(300, 12);
    clip.overrides = { ...cloneEdits(DEFAULT_EDITS), speed };

    const plan = buildProjectPlan([clip], project(), 'video');
    expect(plan.totalDuration).toBeCloseTo(12, 1);
  });

  it('measures a trimmed clip by what is left of it, not by the file', () => {
    // Five minutes of file, one minute of clip, target of ten seconds: the
    // speed has to come from the minute or the clip lands at fifty seconds.
    const clip = mediaClip('a', 300, { inPoint: 60, outPoint: 120 });
    const speed = timelapseSpeedFor(trimmedDuration(clip), 10);
    clip.overrides = { ...cloneEdits(DEFAULT_EDITS), speed };

    expect(speed).toBeCloseTo(6);
    const plan = buildProjectPlan([clip], project(), 'video');
    expect(plan.totalDuration).toBeCloseTo(10, 1);
  });
});

/**
 * The tag's window on the timeline.
 *
 * The arithmetic worth testing is not what the tag looks like — that is a
 * canvas and a pair of eyes — but *when* it exists: a second counted in output
 * time rather than source time, a life that ends with the clip whatever the
 * animation asked for, and a start past the end of the clip that produces
 * nothing rather than a segment nobody can see.
 */
describe('tags on the timeline', () => {
  const tagOn = (clip: MediaClip, tag: Partial<ClipTag>): MediaClip => ({
    ...clip,
    tag: clampTag({ ...DEFAULT_TAG, text: 'New', ...tag })
  });

  it('places the tag at its second, counted from the start of the clip', () => {
    const clips = [mediaClip('a', 10), tagOn(mediaClip('b', 10), { startSeconds: 2 })];
    const plan = buildProjectPlan(clips, DEFAULT_PROJECT, 'video');

    expect(plan.tags.length).toBe(1);
    expect(plan.tags[0].start).toBeCloseTo(12, 5);
  });

  it('counts that second in output time, so a sped-up clip is not lied to', () => {
    // Two seconds into a clip playing at four times speed is half a second of
    // its own footage; what the reader typed is what they will watch.
    const fast = { ...cloneEdits(DEFAULT_EDITS), speed: 4 };
    const clip = tagOn(mediaClip('a', 20, { overrides: fast }), { startSeconds: 2 });
    const plan = buildProjectPlan([clip], DEFAULT_PROJECT, 'video');

    expect(plan.tags[0].start).toBeCloseTo(2, 5);
  });

  it('lets a tag with no exit last as long as its clip', () => {
    const clip = tagOn(mediaClip('a', 6), { startSeconds: 1, exit: 'none' });
    const plan = buildProjectPlan([clip], DEFAULT_PROJECT, 'video');

    expect(plan.tags[0].end).toBeCloseTo(6, 5);
  });

  it('ends a tag with an exit when the exit finishes', () => {
    const clip = tagOn(mediaClip('a', 30), {
      startSeconds: 1,
      exit: 'fade',
      animSeconds: 0.5,
      exitSeconds: 0.5,
      holdAuto: false,
      holdSeconds: 2
    });
    const plan = buildProjectPlan([clip], DEFAULT_PROJECT, 'video');

    // 1s in, then 0.5 arriving + 2 held + 0.5 leaving.
    expect(plan.tags[0].end).toBeCloseTo(4, 5);
  });

  it('never lets a tag outlive its clip', () => {
    const clip = tagOn(mediaClip('a', 3), {
      startSeconds: 1,
      exit: 'fade',
      animSeconds: 1,
      exitSeconds: 1,
      holdAuto: false,
      holdSeconds: 30
    });
    const plan = buildProjectPlan([clip], DEFAULT_PROJECT, 'video');

    expect(plan.tags[0].end).toBeCloseTo(3, 5);
  });

  it('times a ready-made tag by its own design, not by the animation fields', () => {
    // The design owns the arrival and the departure; the reader owns only the
    // hold, and the fields the Animation group would have set are ignored.
    const design = specialShape('news-plate');
    expect(design).not.toBeNull();

    const clip = tagOn(mediaClip('a', 40), {
      startSeconds: 1,
      shape: 'news-plate',
      exit: 'none',
      animSeconds: 6,
      exitSeconds: 6,
      holdAuto: false,
      holdSeconds: 3
    });
    const plan = buildProjectPlan([clip], DEFAULT_PROJECT, 'video');

    expect(plan.tags[0].end - plan.tags[0].start).toBeCloseTo(2.55 + 3 + 1.05, 5);
  });

  it('gives a ready-made tag an end even when the exit says it stays', () => {
    const tag = clampTag({ ...DEFAULT_TAG, text: 'New', shape: 'paper-tear', exit: 'none' });
    expect(Number.isFinite(tagLifetime(tag))).toBeTrue();
  });

  it('keeps every design in the catalogue through a clamp', () => {
    for (const design of TAG_SPECIALS) {
      const tag = clampTag({ ...DEFAULT_TAG, text: 'New', shape: design.id });
      expect(tag.shape).toBe(design.id);
      expect(shapeIsSpecial(tag.shape)).toBeTrue();
    }
  });

  it('falls back to a shape it can draw when the document names one it cannot', () => {
    const tag = clampTag({ ...DEFAULT_TAG, text: 'New', shape: 'bars-from-a-later-build' as never });
    expect(tag.shape).toBe(DEFAULT_TAG.shape);
    expect(shapeIsSpecial(tag.shape)).toBeFalse();
  });

  it('drops a tag told to arrive after its clip has already finished', () => {
    const clip = tagOn(mediaClip('a', 4), { startSeconds: 9 });
    expect(buildProjectPlan([clip], DEFAULT_PROJECT, 'video').tags).toEqual([]);
  });

  it('ignores a tag with nothing written on it', () => {
    const clip = tagOn(mediaClip('a', 8), { text: '   ' });
    expect(buildProjectPlan([clip], DEFAULT_PROJECT, 'video').tags).toEqual([]);
  });

  it('puts a tag on a text card too', () => {
    const card: TextClip = { ...textClip('t', 0.4, 2), tag: clampTag({ ...DEFAULT_TAG, text: 'Chapter one' }) };
    const plan = buildProjectPlan([card], DEFAULT_PROJECT, 'video');

    expect(plan.tags.length).toBe(1);
  });

  it('reports the seconds since the tag arrived, not since the clip did', () => {
    const clips = [mediaClip('a', 10), tagOn(mediaClip('b', 10), { startSeconds: 2, exit: 'none' })];
    const plan = buildProjectPlan(clips, DEFAULT_PROJECT, 'video');

    expect(tagAt(plan.tags, 11)).toBeNull();
    expect(tagAt(plan.tags, 12.5)?.elapsed).toBeCloseTo(0.5, 5);
    expect(tagAt(plan.tags, 19.9)?.elapsed).toBeCloseTo(7.9, 5);
    expect(tagAt(plan.tags, 20)).toBeNull();
  });

  it('moves the tag with the rest of the plan when the export resumes', () => {
    const clips = [mediaClip('a', 10), tagOn(mediaClip('b', 10), { startSeconds: 2 })];
    const plan = slicePlan(buildProjectPlan(clips, DEFAULT_PROJECT, 'video'), 1);

    expect(plan.tags[0].start).toBeCloseTo(2, 5);
  });

  it('sends a clip with a tag through the compositor', () => {
    const clip = tagOn(mediaClip('a', 8), { startSeconds: 1, exit: 'none' });
    const plan = buildProjectPlan([clip], DEFAULT_PROJECT, 'video');

    expect(needsCompositing(plan, 0.5)).toBe(false);
    expect(needsCompositing(plan, 2)).toBe(true);
  });
});

describe('a video effect section arrives hard or soft, as asked', () => {
  const section = (fadeSeconds: number) => ({
    start: 10, end: 14, clipId: 'a', fadeSeconds,
    effect: { id: 'cinematic', intensity: 0.8 }
  });

  it('is fully on from the first frame when the edge is a cut', () => {
    const cut = section(0);
    for (const time of [10, 10.001, 12, 13.999]) expect(videoEffectGain(cut, time)).toBe(1);
  });

  it('rides in from nothing and back out again when the edge is soft', () => {
    const soft = section(1);
    expect(videoEffectGain(soft, 10)).toBe(0);
    expect(videoEffectGain(soft, 10.5)).toBeCloseTo(0.5, 6);
    expect(videoEffectGain(soft, 11)).toBe(1);
    expect(videoEffectGain(soft, 12)).toBe(1);
    expect(videoEffectGain(soft, 13.5)).toBeCloseTo(0.5, 6);
    expect(videoEffectGain(soft, 14)).toBe(0);
  });

  it('never decreases on the way in, nor increases on the way out', () => {
    const soft = section(1);
    let previous = -1;
    for (let time = 10; time <= 11.0001; time += 0.05) {
      const gain = videoEffectGain(soft, time);
      expect(gain).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = gain;
    }
    previous = 2;
    for (let time = 13; time <= 14.0001; time += 0.05) {
      const gain = videoEffectGain(soft, time);
      expect(gain).toBeLessThanOrEqual(previous + 1e-9);
      previous = gain;
    }
  });

  it('clamps a ramp longer than half the section so the two ends cannot meet', () => {
    const tiny = { start: 10, end: 10.4, clipId: 'a', fadeSeconds: 5, effect: { id: 'vhs', intensity: 1 } };
    expect(videoEffectGain(tiny, 10)).toBe(0);
    expect(videoEffectGain(tiny, 10.2)).toBe(1);
    expect(videoEffectGain(tiny, 10.4)).toBe(0);
  });

  it('scales the effect intensity rather than adding a rendering path', () => {
    // Intensity 0 is an exact bypass in the engine, so the ends of a soft
    // section are the untouched picture by construction.
    const segments = [section(1)];
    expect(videoEffectAt(segments, 10)).toBeNull();
    expect(videoEffectAt(segments, 10.5)?.intensity).toBeCloseTo(0.4, 6);
    expect(videoEffectAt(segments, 12)?.intensity).toBe(0.8);
    expect(videoEffectAt(segments, 12)?.id).toBe('cinematic');
  });

  it('measures the ramp in output seconds, so speed carries it', () => {
    const clip = mediaClip('a', 10, {
      videoEffects: [{ effectId: 'cinematic', intensity: 1, startSeconds: 0, durationSeconds: 10, fadeSeconds: 2 }]
    });
    // A clip's own settings live in `overrides`; there is no `edits` field on a clip.
    const plan = buildProjectPlan([{ ...clip, overrides: cloneEdits({ ...DEFAULT_EDITS, speed: 2 }) }], DEFAULT_PROJECT, 'video');
    // A two-second ramp on a clip running at twice the speed is watched for one.
    expect(plan.videoEffects[0].fadeSeconds).toBeCloseTo(1, 6);
  });
});
