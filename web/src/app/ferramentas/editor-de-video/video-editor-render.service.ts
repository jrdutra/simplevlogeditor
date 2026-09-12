import { Injectable } from '@angular/core';
import { imageBitmapForFile } from '../../shared/desktop/path-backed-file';
import type { AudioSample, Output, OutputFormat, Target, VideoSample } from 'mediabunny';

import { ensureMp3Encoder, loadMediabunny, MediabunnyLib } from '../../services/mediabunny/mediabunny-loader';

import { GainEnvelope, gainAt, isUnity, softLimit } from '../../shared/media/loudness';
import { OutputFormatOption } from '../juntador-de-midias/media-merger.models';
import { drawFrame } from '../criador-de-video-texto/text-scene-renderer';
import { fontStack } from '../criador-de-video-texto/text-video-presets';
import type { SceneBackground, TextScene } from '../criador-de-video-texto/text-video.models';
import { FrameContext, FrameSource, canvasOfSize, composeFrame, needsCompositing } from './frame-compositor';
import { clampSpeed, volumeGain } from './video-editor-defaults';
import { fadeGainAt, sourceTimeAt, transitionAt } from './video-editor-timeline';
import { TransitionPainter } from './video-transitions';
import { EMPTY_SIDE, FootageSide, SceneSide, StillSide, TransitionSide } from './transition-sides';
import {
  ClipPlan,
  EditorCanceledError,
  FadeSegment,
  EditorError,
  MediaClip,
  ProjectPlan,
  ProjectSettings,
  RenderLogEntry,
  RenderProgress,
  RenderResult,
  TextClip,
  TimeRange,
  TransitionPlan,
  isMediaClip,
  technicalDetail
} from './video-editor.models';

/**
 * When a clip's sound takes over from the previous one and hands to the next.
 *
 * Both ends come from `TransitionPlan.soundSwitch`; a clip with no join on that
 * side is unbounded there.
 */
interface SoundWindow {
  from: number;
  to: number;
}

/** A clip with a join on neither side owns its sound from end to end. */
const OPEN_SOUND: SoundWindow = { from: -Infinity, to: Infinity };

/** The stretch of the output this clip's sound is actually responsible for. */
function audibleSpan(entry: ClipPlan, window: SoundWindow): { start: number; end: number; seconds: number } {
  const start = Math.max(entry.outputStart, window.from);
  const end = Math.min(entry.outputStart + entry.outputDuration, window.to);

  return { start, end, seconds: Math.max(0, end - start) };
}

/** The slice of the File System Access API this service uses. */
interface FileSystemWritableStreamLike extends WritableStream<{ type?: string; data?: BufferSource; position?: number }> {
  close(): Promise<void>;
}

interface SaveFilePickerGlobals {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<FileSystemWritableStreamLike> }>;
}

/** Where the finished file will be written. */
export interface RenderDestination {
  /** Present when the reader picked a location and the file streams to disk. */
  handle: FileSystemWritableStreamLike | null;
  fileName: string;
}

export interface EditorRenderOptions {
  plan: ProjectPlan;
  project: ProjectSettings;
  kind: 'video' | 'audio';
  format: OutputFormatOption;
  /** One gain curve per clip id, present only where levelling found something. */
  envelopes: ReadonlyMap<string, GainEnvelope>;
  destination: RenderDestination;
  signal: AbortSignal;
  /**
   * A second, gentler stop.
   *
   * `signal` means "throw this away": the output is cancelled and the file the
   * reader chose is left empty. That is the right answer for a mistake, and the
   * wrong one for a long export the reader simply wants to break in half. This
   * one is checked only *between* clips, so the clip in progress finishes, the
   * container's index is written, and what comes back is a file that plays and
   * knows where the rest of the edit starts.
   */
  stopSignal?: AbortSignal;
  onProgress: (report: RenderProgress) => void;
  /**
   * A running account of what the encoder is doing, for the reader watching it.
   *
   * Separate from `onProgress` because they answer different questions. Progress
   * says how far along; this says what is happening, and stays on screen
   * afterwards so a long export can be read back. It is called a few times per
   * container, never per frame.
   */
  onLog?: (entry: RenderLogEntry) => void;
}

/** Minutes and seconds, for a position on the timeline. */
function clock(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

/** A file size a reader can read. */
function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} kB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Seconds of silence written at a time when a clip has no sound of its own. */
const SILENCE_CHUNK = 0.5;

/** Seconds between the frames written for a still picture or a black screen. */
const STILL_FRAME_INTERVAL = 1;

/** Below this a fragment is not worth encoding. */
const EPSILON = 1e-6;

/**
 * Writes the finished video.
 *
 * The service does no deciding. Every question — what survives, how fast it
 * plays, where the zooms and captions and fades land — was answered by the
 * timeline module before this was called, and what arrives here is a plan
 * expressed entirely in output time. All this does is walk it and push samples
 * into an encoder, which is why it can afford to be long without being subtle.
 *
 * Two rules run through every path. Nothing is buffered: samples are pulled
 * from one clip at a time and awaited into the encoder, so backpressure keeps
 * memory flat however long the project is. And no timestamp may ever go
 * backwards: a muxer stores them unsigned, so a value that decreases does not
 * fail loudly — it wraps to an enormous number, and everything after it looks
 * out of order in a file that still opens.
 */
@Injectable({ providedIn: 'root' })
export class VideoEditorRenderService {
  /**
   * Asks the reader where to save, while the click that started the render is
   * still fresh.
   *
   * The picker needs user activation, which does not survive a few awaited
   * promises — so it is called before anything else, and a browser without the
   * API falls back to a download at the end. A dismissed dialog is not a
   * failure; it is a reader who would rather have the download.
   */
  async pickDestination(
    kind: 'video' | 'audio',
    format: OutputFormatOption,
    /** `part-2` and so on, when this file continues one that was stopped. */
    suffix = ''
  ): Promise<RenderDestination> {
    const fileName = `edited-${kind}${suffix ? `-${suffix}` : ''}.${format.extension}`;
    const picker = (globalThis as unknown as SaveFilePickerGlobals).showSaveFilePicker;
    if (typeof picker !== 'function') return { handle: null, fileName };

    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: format.label, accept: { [format.mimeType]: [`.${format.extension}`] } }]
      });
      return { handle: await handle.createWritable(), fileName };
    } catch {
      return { handle: null, fileName };
    }
  }

  async render(options: EditorRenderOptions): Promise<RenderResult> {
    const { plan, kind, format, destination, signal, onProgress } = options;
    if (!plan.clips.length) throw new EditorError('Add at least one clip before exporting.');

    const library = await loadMediabunny();

    const report = (stage: RenderProgress['stage'], ratio: number | null, index: number, name: string) =>
      onProgress({ stage, ratio, clipIndex: index, clipCount: plan.clips.length, clipName: name });

    report('preparing', 0, 0, '');

    const log = (kind: RenderLogEntry['kind'], text: string) => options.onLog?.({ kind, text });

    log('step', `Export started — ${kind === 'video' ? 'video and sound' : 'sound only'}`);
    log('detail', `container ${format.label} (.${format.extension})`);
    log(
      'detail',
      `codecs ${kind === 'video' ? `${format.videoCodec ?? 'none'} / ` : ''}${format.audioCodec}`
    );
    if (kind === 'video') log('detail', `picture ${plan.width}x${plan.height} at ${plan.frameRate} fps`);
    log('detail', `sound ${plan.sampleRate} Hz, ${plan.channelCount === 1 ? 'mono' : `${plan.channelCount} channels`}`);
    log('detail', `${plan.clips.length} container${plan.clips.length === 1 ? '' : 's'}, ${clock(plan.totalDuration)} long`);
    log('detail', destination.handle
      ? `writing straight to ${destination.fileName}`
      : `building ${destination.fileName} in memory`);

    if (kind === 'video' && !plan.hasPicture) {
      throw new EditorError(
        'No clip in this project can put anything on screen.',
        'Export the audio instead, or add a video, an image or a text card.'
      );
    }

    // No browser encodes MP3 on its own, so LAME is fetched before the output
    // exists rather than in the middle of the first encode.
    if (format.audioCodec === 'mp3') await ensureMp3Encoder();
    await this.assertEncodable(library, kind, format, plan);

    const target = destination.handle
      ? new library.StreamTarget(destination.handle, { chunked: true })
      : new library.BufferTarget();
    const output = new library.Output({ format: this.containerFor(library, format), target }) as Output<OutputFormat, Target>;

    /** Once true the file is committed, and failures after it must not cancel. */
    let finalized = false;

    try {
      const videoSource =
        kind === 'video' && format.videoCodec
          ? new library.VideoSampleSource({
              codec: format.videoCodec,
              quality: new library.Quality('high'),
              keyFrameInterval: 2,
              // The guard against a mid-stream size change compares the frame as
              // it arrives, before any transform — and an edit is nothing but a
              // stream of size changes. `passThrough` waves it through; the
              // transform below is what actually makes every frame the same
              // size, letterboxed rather than cropped or stretched.
              sizeChangeBehavior: 'passThrough',
              transform: {
                width: plan.width,
                height: plan.height,
                fit: 'contain',
                // Normalising the rate as well is what lets a still picture be
                // written as one frame per second: the gaps are padded for us.
                frameRate: plan.frameRate,
                process: this.videoProcessor(plan)
              }
            })
          : null;
      if (videoSource) output.addVideoTrack(videoSource);

      const audioSource = new library.AudioSampleSource({
        codec: format.audioCodec,
        ...(format.audioCodec.startsWith('pcm-') ? {} : { quality: new library.Quality('high') }),
        transform: {
          numberOfChannels: plan.channelCount,
          sampleRate: plan.sampleRate,
          // `audioFades`, not `fades`: a clip carrying on the previous clip's
          // soundtrack fades its picture and not its sound.
          ...(plan.audioFades.length ? { process: this.audioFader(library, plan) } : {})
        }
      });
      output.addAudioTrack(audioSource);

      await output.start();

      const cursor = { video: -Infinity, audio: -Infinity };

      /**
       * Where each clip's own picture has to stop, because a join takes over.
       *
       * Only the *outgoing* side needs telling about the picture: the incoming
       * clip's early frames land at timestamps the transition has already written
       * past, and the monotonic guard every writer here shares drops them.
       *
       * The sound is a separate question and does not have the same answer. There
       * is no mixing bus here — one clip's samples are written, then the next
       * one's — so the two shots cannot both be heard across the join, and all
       * that is left to decide is when the sound changes hands. The planner
       * decides it per join, in `soundSwitch`, and both sides are told: the
       * outgoing clip stops there and the incoming one starts there. Letting the
       * monotonic guard settle it instead is what wrote a clip's restored room
       * tone over the first syllable of the next one.
       */
      const stops = new Map<number, number>();
      /** Where each clip's sound hands over, and where it takes over. */
      const soundEnds = new Map<number, number>();
      const soundStarts = new Map<number, number>();

      for (const join of plan.transitions) {
        stops.set(join.fromIndex, join.start);
        soundEnds.set(join.fromIndex, join.soundSwitch);
        soundStarts.set(join.toIndex, join.soundSwitch);
      }

      const painter = new TransitionPainter();

      /** Where the next part would begin, when the reader stopped this one. */
      let stoppedAt = plan.clips.length;

      for (const [index, entry] of plan.clips.entries()) {
        if (signal.aborted) throw new EditorCanceledError();
        // Checked here and nowhere else. Between two clips the encoder is at a
        // clean boundary — every sample of everything before is written and
        // nothing of what follows is — which is the only place this file can be
        // cut in half without the two halves overlapping or missing a moment.
        if (options.stopSignal?.aborted) {
          stoppedAt = index;
          log('warn', `Stopped here — the file holds ${index} of ${plan.clips.length} containers`);
          break;
        }

        const name = isMediaClip(entry.clip) ? entry.clip.summary.fileName : 'Text card';
        const label = `clip ${index + 1} of ${plan.clips.length} — ${name}`;
        const tick = (seconds: number) =>
          report(
            'encoding',
            plan.totalDuration > 0 ? Math.min(1, seconds / plan.totalDuration) : null,
            index + 1,
            name
          );

        tick(entry.outputStart);
        log('clip', `container ${index + 1}/${plan.clips.length} — ${name}`);

        // A clip whose every second was cut away contributes nothing, and
        // writing it anyway would put a frame and a packet at the instant the
        // next clip begins — two samples at one timestamp, which a muxer
        // refuses. Skipping it is the only thing that can be meant by it.
        if (entry.outputDuration <= EPSILON) {
          log('detail', 'nothing left after the cuts — skipped');
          continue;
        }

        for (const note of this.describeEntry(entry)) log('detail', note);

        // Every failure below belongs to a clip the reader can go and look at,
        // so it is labelled here rather than left as a sentence about the
        // project as a whole.
        const pictureEnd = stops.get(index) ?? Infinity;
        const sound = {
          from: soundStarts.get(index) ?? -Infinity,
          to: soundEnds.get(index) ?? Infinity
        };

        try {
          if (isMediaClip(entry.clip)) {
            await this.writeMediaClip(library, entry, entry.clip, plan, options, videoSource, audioSource, cursor, tick, pictureEnd, sound);
          } else {
            await this.writeTextClip(library, entry, entry.clip, plan, videoSource, audioSource, cursor, signal, tick, pictureEnd, sound);
          }

          const join = plan.transitions.find((candidate) => candidate.fromIndex === index);
          if (join && videoSource) {
            const incoming = plan.clips[join.toIndex];
            if (incoming) {
              log(
                'detail',
                `join into container ${join.toIndex + 1}: ${join.settings.kind} over ${join.settings.seconds.toFixed(2)}s`
              );
              cursor.video = await this.writeTransition(
                library,
                join,
                entry,
                incoming,
                plan,
                videoSource,
                painter,
                cursor.video,
                signal,
                tick
              );
            }
          }
        } catch (error) {
          if (error instanceof EditorCanceledError) throw error;
          const described = this.describe(error);
          throw described instanceof EditorError ? described.withClip(label) : described;
        }
      }

      report('muxing', 1, plan.clips.length, '');
      log('step', 'Assembling the container');

      // Finalizing writes the index and, for a stream target, closes the
      // underlying writable itself. Once it resolves the file is complete and
      // must not be touched again.
      await output.finalize();
      finalized = true;

      report('finishing', 1, plan.clips.length, '');

      const blob = destination.handle ? null : this.takeBuffer(output, format);
      log('done', destination.handle
        ? `Finished — saved as ${destination.fileName}`
        : `Finished — ${destination.fileName}, ${bytes(blob?.size ?? 0)}`);

      return {
        blob,
        fileName: destination.fileName,
        savedToDisk: Boolean(destination.handle),
        kind,
        plan,
        partial: stoppedAt < plan.clips.length,
        nextClipIndex: stoppedAt
      };
    } catch (error) {
      if (!finalized) await output.cancel().catch(() => undefined);
      throw this.describe(error, Boolean(destination.handle) && !finalized);
    }
  }

  /**
   * What is about to be done to one container, in the reader's own terms.
   *
   * Written from the plan rather than from inside the writers, so the account
   * stays in one place and no picture or sound path has to carry a logger
   * through it. It says what the plan decided, which is what a reader watching
   * a long export actually wants to check.
   */
  private describeEntry(entry: ClipPlan): string[] {
    const notes = [`from ${clock(entry.outputStart)}, ${entry.outputDuration.toFixed(2)}s long`];

    if (isMediaClip(entry.clip)) {
      const clip = entry.clip;
      notes.push(
        clip.summary.kind === 'image'
          ? 'picture: a still, held'
          : !clip.summary.videoUsable
          ? 'picture: none usable — writing black'
          : 'picture: copying the footage'
      );

      if (entry.keepRanges.length > 1 || entry.removedDuration > 0.01) {
        notes.push(
          `picture: ${entry.keepRanges.length} kept range${entry.keepRanges.length === 1 ? '' : 's'}` +
            `, ${entry.removedDuration.toFixed(2)}s cut away`
        );
      }

      const speed = entry.edits.speed;
      if (Math.abs(speed - 1) > 0.001) notes.push(`speed ${speed.toFixed(2)}x`);
    } else {
      notes.push('picture: drawing the text card');
    }

    notes.push(
      entry.sound.kind === 'mute'
        ? 'sound: silent'
        : entry.sound.kind === 'file'
        ? `sound: ${entry.sound.label} from ${entry.sound.offset.toFixed(2)}s`
        : "sound: the clip's own"
    );
    if (entry.soundShort) notes.push('sound: the supplied file runs out before this container ends');

    return notes;
  }

  // ------------------------------------------------------------- the clips

  /** Writes one piece of footage, sound or still picture. */
  private async writeMediaClip(
    library: MediabunnyLib,
    entry: ClipPlan,
    clip: MediaClip,
    plan: ProjectPlan,
    options: EditorRenderOptions,
    videoSource: import('mediabunny').VideoSampleSource | null,
    audioSource: import('mediabunny').AudioSampleSource,
    cursor: { video: number; audio: number },
    tick: (seconds: number) => void,
    /** Output time this clip's picture hands over to a transition, or Infinity. */
    pictureEnd = Infinity,
    /** Output times this clip's sound takes over and hands over. */
    soundWindow: SoundWindow = OPEN_SOUND
  ): Promise<void> {
    const { signal, envelopes, project } = options;
    const speed = clampSpeed(entry.edits.speed);
    const envelope = envelopes.get(clip.id) ?? null;
    const picture = Math.min(entry.outputDuration, Math.max(0, pictureEnd - entry.outputStart));
    const audible = audibleSpan(entry, soundWindow);

    if (clip.summary.kind === 'image') {
      if (videoSource) {
        cursor.video = await this.writeStill(library, videoSource, clip, entry, plan, cursor.video, signal, picture);
      }
      cursor.audio = await this.writeClipSound(library, audioSource, entry, clip, plan, options, cursor.audio, tick, audible);
      return;
    }

    const input = new library.Input({ source: new library.BlobSource(clip.file), formats: library.ALL_FORMATS });

    try {
      if (videoSource) {
        cursor.video = clip.summary.videoUsable
          ? await this.copyVideoRanges(library, input, videoSource, entry, speed, cursor.video, signal, tick, pictureEnd)
          : await this.writeBlack(library, videoSource, entry.outputStart, picture, plan, cursor.video, signal);
      }

      // The picture normally drives the progress bar, since it is the slower
      // half. A clip with no picture has to drive it from its sound instead, or
      // a long song in the middle of a project would look frozen.
      const audioDrives = !videoSource || !clip.summary.videoUsable;
      const sound = entry.sound;

      if (sound.kind === 'mute') {
        cursor.audio = await this.writeSilence(library, audioSource, audible.start, audible.seconds, plan, cursor.audio, signal);
      } else if (sound.kind === 'file') {
        cursor.audio = await this.writeExternalAudio(
          library,
          audioSource,
          sound.file,
          sound.offset,
          entry,
          plan,
          cursor.audio,
          signal,
          audioDrives ? tick : null,
          audible.start,
          audible.end
        );
      } else if (clip.summary.audioUsable) {
        cursor.audio = await this.copyAudioRanges(
          library,
          input,
          audioSource,
          entry,
          plan,
          speed,
          envelope,
          project,
          cursor.audio,
          signal,
          audioDrives ? tick : null,
          audible.start,
          audible.end
        );
      } else {
        cursor.audio = await this.writeSilence(library, audioSource, audible.start, audible.seconds, plan, cursor.audio, signal);
      }
    } finally {
      input.dispose();
    }
  }

  /**
   * Draws a text card frame by frame.
   *
   * Unlike everything else here there is no source to read: each frame is
   * composed from the draft at the instant it represents, which is what lets
   * the animations run. Speed multiplies the scene's own clock rather than
   * dropping frames, so a card at double speed animates twice as fast and still
   * has every frame drawn.
   */
  private async writeTextClip(
    library: MediabunnyLib,
    entry: ClipPlan,
    clip: TextClip,
    plan: ProjectPlan,
    videoSource: import('mediabunny').VideoSampleSource | null,
    audioSource: import('mediabunny').AudioSampleSource,
    cursor: { video: number; audio: number },
    signal: AbortSignal,
    tick: (seconds: number) => void,
    pictureEnd = Infinity,
    soundWindow: SoundWindow = OPEN_SOUND
  ): Promise<void> {
    const audible = audibleSpan(entry, soundWindow);

    if (videoSource) {
      const scene = await this.buildScene(clip, plan);
      const canvas = canvasOfSize(plan.width, plan.height);
      const context = canvas.getContext('2d', { alpha: false }) as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!context) throw new EditorError('This browser could not draw the text card.');

      const speed = clampSpeed(entry.edits.speed);
      const step = 1 / plan.frameRate;
      const frames = Math.max(1, Math.ceil(entry.outputDuration * plan.frameRate));

      try {
        for (let frame = 0; frame < frames; frame++) {
          if (signal.aborted) throw new EditorCanceledError();

          const timestamp = entry.outputStart + frame * step;
          if (timestamp >= pictureEnd) break;
          if (timestamp <= cursor.video) continue;

          drawFrame(context, scene, frame * step * speed);

          // A `VideoSample` built from a canvas copies its contents there and
          // then, which is what makes reusing one canvas for every frame safe.
          const sample = new library.VideoSample(canvas, { timestamp, duration: step });
          try {
            await videoSource.add(sample);
          } finally {
            sample.close();
          }

          cursor.video = timestamp;
          tick(timestamp);
        }
      } finally {
        this.releaseScene(scene);
      }
    }

    // A card usually plays over silence, but it may be continuing the track an
    // earlier clip started — a title over music that never stops.
    cursor.audio =
      entry.sound.kind === 'file'
        ? await this.writeExternalAudio(
            library,
            audioSource,
            entry.sound.file,
            entry.sound.offset,
            entry,
            plan,
            cursor.audio,
            signal,
            tick,
            audible.start,
            audible.end
          )
        : await this.writeSilence(library, audioSource, audible.start, audible.seconds, plan, cursor.audio, signal);
  }

  // ------------------------------------------------------------ the copies

  /** Copies the picture of every kept range onto the output timeline. */
  private async copyVideoRanges(
    library: MediabunnyLib,
    input: import('mediabunny').Input,
    source: import('mediabunny').VideoSampleSource,
    entry: ClipPlan,
    speed: number,
    lastTimestamp: number,
    signal: AbortSignal,
    tick: (seconds: number) => void,
    pictureEnd = Infinity
  ): Promise<number> {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return lastTimestamp;

    const sink = new library.VideoSampleSink(track);
    let last = lastTimestamp;
    let cut = 0;

    for (const range of entry.keepRanges) {
      for await (const sample of sink.samples(range.start, range.end)) {
        // A decoded frame holds a real GPU or system buffer, so it is closed in
        // a `finally`: an encoder that rejects mid-file must not leave frames
        // alive until the garbage collector notices them.
        try {
          if (signal.aborted) throw new EditorCanceledError();

          // `samples(start, end)` deliberately yields the frame that is on
          // screen at `start`, which usually began slightly earlier. Clamping
          // rather than shifting pins it to the start of the range: it is the
          // right picture for that instant, it just begins there now.
          const inRange = Math.max(0, sample.timestamp - range.start);
          const timestamp = entry.outputStart + (cut + inRange) / speed;
          // Handing over to a transition, which owns the picture from here and
          // will compose this clip's remaining frames together with the next
          // one's. Writing them here as well would put two frames on one
          // timestamp, and the muxer would take the first.
          if (timestamp >= pictureEnd) return last;
          if (timestamp <= last) continue;

          sample.setTimestamp(timestamp);
          await source.add(sample);
          last = timestamp;
          tick(timestamp);
        } finally {
          sample.close();
        }
      }
      cut += range.end - range.start;
    }

    return last;
  }

  /**
   * Copies the sound of every kept range, levelled and re-timed.
   *
   * Trimming, levelling, the click-removing fade at each cut and the speed
   * change are all done in a single pass over the samples. Doing them one after
   * another would mean three copies of every buffer, and at 48 kHz stereo that
   * is the difference between an export that keeps up with the picture and one
   * that does not.
   */
  private async copyAudioRanges(
    library: MediabunnyLib,
    input: import('mediabunny').Input,
    source: import('mediabunny').AudioSampleSource,
    entry: ClipPlan,
    plan: ProjectPlan,
    speed: number,
    envelope: GainEnvelope | null,
    project: ProjectSettings,
    lastTimestamp: number,
    signal: AbortSignal,
    tick: ((seconds: number) => void) | null,
    /** Output time this clip's sound becomes audible. */
    audioStart = entry.outputStart,
    /** Output time this clip's sound hands over to the next, or Infinity. */
    audioEnd = Infinity
  ): Promise<number> {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return lastTimestamp;

    const sink = new library.AudioSampleSink(track);
    const crossfade = entry.edits.silence.crossfadeMs / 1000;
    const levelling = envelope && !isUnity(envelope) ? envelope : null;
    const limiter = project.loudness.enabled && project.loudness.limiter && Boolean(levelling);
    const volume = volumeGain(entry.edits);

    let last = lastTimestamp;
    let cut = 0;

    for (const [index, range] of entry.keepRanges.entries()) {
      const fadeInEdge = crossfade > 0 && index > 0;
      const fadeOutEdge = crossfade > 0 && index < entry.keepRanges.length - 1;

      const rangeOutputStart = entry.outputStart + cut / speed;
      const rangeOutputEnd = rangeOutputStart + (range.end - range.start) / speed;
      const outputStart = Math.max(rangeOutputStart, audioStart);
      const outputEnd = Math.min(rangeOutputEnd, audioEnd);
      if (outputEnd <= outputStart + EPSILON) {
        cut += range.end - range.start;
        continue;
      }

      const audibleRange: TimeRange = {
        start: range.start + (outputStart - rangeOutputStart) * speed,
        end: range.start + (outputEnd - rangeOutputStart) * speed
      };

      for await (const sample of sink.samples(audibleRange.start, audibleRange.end)) {
        let shaped: AudioSample | null = null;

        try {
          if (signal.aborted) throw new EditorCanceledError();

          const trimmedStart = Math.max(sample.timestamp, audibleRange.start);
          const timestamp = entry.outputStart + (cut + (trimmedStart - range.start)) / speed;
          // `<=` rather than `<`: two packets landing on the very same instant
          // is not a rounding curiosity at ten times speed, and a track with two
          // samples at one timestamp is a file the muxer refuses to write.
          if (timestamp <= last && last > -Infinity) continue;

          // The whole-sample case is the common one — no cuts, no levelling,
          // ordinary speed, and sound already in the project's shape — and it is
          // worth keeping free of copies.
          const matchesOutput = sample.sampleRate === plan.sampleRate && sample.numberOfChannels === plan.channelCount;
          // A clip the reader has turned up or down is never untouched: the fast
          // path hands the packet to the encoder verbatim, and verbatim is
          // precisely what a volume change is not.
          const untouched =
            matchesOutput && speed === 1 && !levelling && !fadeInEdge && !fadeOutEdge && Math.abs(volume - 1) < 1e-6;

          if (
            untouched &&
            sample.timestamp >= audibleRange.start - EPSILON &&
            sample.timestamp + sample.duration <= audibleRange.end + EPSILON
          ) {
            sample.setTimestamp(timestamp);
            await source.add(sample);
            last = timestamp;
            tick?.(timestamp);
            continue;
          }

          shaped = this.shapeAudio(library, sample, audibleRange, {
            speed,
            volume,
            envelope: levelling,
            crossfade,
            fadeInEdge,
            fadeOutEdge,
            limiter,
            timestamp,
            sampleRate: plan.sampleRate,
            channelCount: plan.channelCount
          });
          if (!shaped) continue;

          await source.add(shaped);
          last = timestamp;
          tick?.(timestamp);
        } finally {
          if (shaped && shaped !== sample) shaped.close();
          sample.close();
        }
      }

      cut += range.end - range.start;
    }

    return last;
  }

  /**
   * Trims, levels, de-clicks, re-times and re-shapes one packet of sound at once.
   *
   * Returns `null` when nothing of the packet falls inside the range: a decoded
   * packet is around twenty milliseconds long and rarely lines up with a cut,
   * so the ones straddling a boundary are the normal case rather than the
   * exception.
   *
   * It always emits at the project's sample rate and channel count, and that is
   * not an optimisation — an encoder is configured from the first sample it is
   * given and rejects every later one whose shape differs. A timeline of a
   * 48 kHz stereo camera file, a 44.1 kHz mono voice memo and a stretch of
   * generated silence is three shapes, and used to fail halfway through the
   * export with a sentence about the file being invalid.
   */
  private shapeAudio(
    library: MediabunnyLib,
    sample: AudioSample,
    range: TimeRange,
    options: {
      speed: number;
      envelope: GainEnvelope | null;
      crossfade: number;
      fadeInEdge: boolean;
      fadeOutEdge: boolean;
      limiter: boolean;
      timestamp: number;
      sampleRate: number;
      channelCount: number;
      /**
       * The clip's own volume, as a multiplier. 1 leaves the samples alone.
       *
       * Applied on top of the levelling envelope rather than instead of it:
       * levelling is the tool making clips agree with one another, and this is
       * the reader disagreeing with the result for one of them.
       */
      volume?: number;
    }
  ): AudioSample | null {
    const rate = sample.sampleRate;
    const channels = sample.numberOfChannels;
    const frames = sample.numberOfFrames;

    const startFrame = Math.max(0, Math.round((range.start - sample.timestamp) * rate));
    const endFrame = Math.min(frames, Math.round((range.end - sample.timestamp) * rate));
    if (endFrame <= startFrame) return null;

    const input = new Float32Array(frames * channels);
    sample.copyTo(input, { planeIndex: 0, format: 'f32' });

    const { speed, envelope, crossfade, fadeInEdge, fadeOutEdge, limiter, sampleRate, channelCount } = options;
    const volume = options.volume ?? 1;
    const kept = endFrame - startFrame;
    // How long this packet lasts in the finished file, and therefore how many
    // frames of the *output's* rate it becomes. Speed and resampling are the
    // same operation seen twice, so they are done in one step rather than two.
    const seconds = kept / rate / speed;
    const outputFrames = Math.max(1, Math.round(seconds * sampleRate));
    const advance = kept / outputFrames;
    const data = new Float32Array(outputFrames * channelCount);

    for (let j = 0; j < outputFrames; j++) {
      // Reading at a fractional position and interpolating is what a speed
      // change is: the pitch rises with it, exactly as it does when a tape is
      // played faster. Nothing here tries to preserve pitch, and pretending to
      // would need an entirely different kind of processing.
      const read = startFrame + j * advance;
      const lower = Math.min(endFrame - 1, Math.floor(read));
      const upper = Math.min(endFrame - 1, lower + 1);
      const fraction = read - lower;
      const time = sample.timestamp + read / rate;

      let gain = (envelope ? gainAt(envelope, time) : 1) * volume;

      // A cut leaves a step in the waveform, and a step is a click. A few
      // milliseconds of ramp removes it without being audible as a fade. The
      // opening of the clip and its very end are left alone: there is no
      // discontinuity there to hide.
      if (fadeInEdge && time < range.start + crossfade) {
        gain *= Math.max(0, (time - range.start) / crossfade);
      }
      if (fadeOutEdge && time > range.end - crossfade) {
        gain *= Math.max(0, (range.end - time) / crossfade);
      }

      for (let channel = 0; channel < channelCount; channel++) {
        const value = this.sampleChannel(input, lower, upper, fraction, channels, channelCount, channel) * gain;
        data[j * channelCount + channel] = limiter ? softLimit(value) : value;
      }
    }

    return new library.AudioSample({
      data,
      format: 'f32',
      numberOfChannels: channelCount,
      sampleRate,
      timestamp: options.timestamp
    });
  }

  /**
   * One interpolated sample of one output channel, whatever the source had.
   *
   * Three cases and no more: the same count passes straight through, a mono
   * output is the average of everything (so nothing is silently thrown away),
   * and anything else repeats the source channels around — which turns mono
   * into a centred stereo pair and leaves a stereo pair alone. Beyond that the
   * layouts stop being interchangeable and an edit is the wrong place to guess
   * at a surround mapping.
   */
  private sampleChannel(
    input: Float32Array,
    lower: number,
    upper: number,
    fraction: number,
    channels: number,
    channelCount: number,
    channel: number
  ): number {
    const at = (index: number, source: number) => input[index * channels + source];
    const lerp = (source: number) => {
      const a = at(lower, source);
      return a + (at(upper, source) - a) * fraction;
    };

    if (channels === channelCount) return lerp(channel);

    if (channelCount === 1) {
      let total = 0;
      for (let source = 0; source < channels; source++) total += lerp(source);
      return total / channels;
    }

    return lerp(channel % channels);
  }

  /**
   * The same packet of sound, in the shape the encoder was configured with.
   *
   * Returns the packet itself, retimed, whenever it already matches — which is
   * the usual case and worth not copying. Anything else is resampled and
   * remixed, because a WebCodecs audio encoder locks its rate and channel count
   * to the first sample it is given and rejects every later one that differs.
   */
  private conformAudio(
    library: MediabunnyLib,
    sample: AudioSample,
    plan: ProjectPlan,
    timestamp: number,
    soundFades: readonly FadeSegment[] = [],
    sourceRange: TimeRange | null = null,
    /** The clip's own volume, as a multiplier. A soundtrack obeys it too. */
    volume = 1
  ): AudioSample | null {
    const rate = sample.sampleRate;
    const channels = sample.numberOfChannels;
    const frames = sample.numberOfFrames;
    const startFrame = sourceRange ? Math.max(0, Math.round((sourceRange.start - sample.timestamp) * rate)) : 0;
    const endFrame = sourceRange
      ? Math.min(frames, Math.round((sourceRange.end - sample.timestamp) * rate))
      : frames;
    if (endFrame <= startFrame) return null;

    const kept = endFrame - startFrame;
    const end = timestamp + kept / rate;
    // The track's own ramps. Applied here rather than in the transform that
    // fades everything, because that one sees a stream of samples with no way
    // of telling which came from a supplied file — and a soundtrack rising at
    // its entrance must not take the picture with it.
    const ramped = soundFades.some((fade) => fade.start < end && fade.end > timestamp);

    const quiet = Math.abs(volume - 1) > 1e-6;
    const wholeSample = startFrame === 0 && endFrame === frames;
    if (wholeSample && !ramped && !quiet && rate === plan.sampleRate && channels === plan.channelCount) {
      sample.setTimestamp(timestamp);
      return sample;
    }

    const input = new Float32Array(frames * channels);
    sample.copyTo(input, { planeIndex: 0, format: 'f32' });

    const outputFrames = Math.max(1, Math.round((kept / rate) * plan.sampleRate));
    const advance = kept / outputFrames;
    const data = new Float32Array(outputFrames * plan.channelCount);

    for (let j = 0; j < outputFrames; j++) {
      const read = startFrame + j * advance;
      const lower = Math.min(endFrame - 1, Math.floor(read));
      const upper = Math.min(endFrame - 1, lower + 1);
      const fraction = read - lower;
      // Per frame rather than per packet: a packet is around twenty
      // milliseconds, and one gain held across it turns a smooth ramp into a
      // staircase — which is audible as a series of clicks.
      const gain = (ramped ? fadeGainAt(soundFades, timestamp + j / plan.sampleRate) : 1) * volume;

      for (let channel = 0; channel < plan.channelCount; channel++) {
        data[j * plan.channelCount + channel] =
          this.sampleChannel(input, lower, upper, fraction, channels, plan.channelCount, channel) * gain;
      }
    }

    return new library.AudioSample({
      data,
      format: 'f32',
      numberOfChannels: plan.channelCount,
      sampleRate: plan.sampleRate,
      timestamp
    });
  }

  // ------------------------------------------------------------ the filling

  /** The sound of a still image: what was attached to it, or silence. */
  private async writeClipSound(
    library: MediabunnyLib,
    source: import('mediabunny').AudioSampleSource,
    entry: ClipPlan,
    clip: MediaClip,
    plan: ProjectPlan,
    options: EditorRenderOptions,
    lastTimestamp: number,
    tick: (seconds: number) => void,
    audible: { start: number; end: number; seconds: number } = {
      start: entry.outputStart,
      end: entry.outputStart + entry.outputDuration,
      seconds: entry.outputDuration
    }
  ): Promise<number> {
    const sound = entry.sound;
    if (sound.kind !== 'file') {
      // A still picture has no sound of its own, so `original` and `mute` come
      // to the same thing here: real silence, never a hole in the track.
      return this.writeSilence(library, source, audible.start, audible.seconds, plan, lastTimestamp, options.signal);
    }

    return this.writeExternalAudio(
      library,
      source,
      sound.file,
      sound.offset,
      entry,
      plan,
      lastTimestamp,
      options.signal,
      tick,
      audible.start,
      audible.end
    );
  }

  /**
   * Lays a supplied soundtrack across the clip, then fills what is left.
   *
   * Reading starts at `offset`, which is how much of the file the clips before
   * this one already used — zero for the clip that introduced the track, and
   * further in for each clip continuing it.
   *
   * The clip's length is the authority, never the audio file's: sound longer
   * than the clip is cut at its end, and sound shorter than it is followed by
   * real silence. Letting the file decide instead would push every later clip
   * out of place by the difference — and the picture would go with it.
   */
  private async writeExternalAudio(
    library: MediabunnyLib,
    source: import('mediabunny').AudioSampleSource,
    file: File,
    offset: number,
    entry: ClipPlan,
    plan: ProjectPlan,
    lastTimestamp: number,
    signal: AbortSignal,
    tick: ((seconds: number) => void) | null,
    /** Output time this clip's sound becomes audible. */
    audioStart = entry.outputStart,
    /** Output time this clip's sound hands over to the next, or Infinity. */
    audioEnd = Infinity
  ): Promise<number> {
    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });

    let last = lastTimestamp;
    // Where the sound genuinely stops. A packet is not cut at the range bound,
    // so the last one usually reaches past it — and starting the silence at the
    // requested bound instead would overlap it.
    let end = -Infinity;

    const outputStart = Math.max(entry.outputStart, audioStart);
    const outputEnd = Math.min(entry.outputStart + entry.outputDuration, audioEnd);
    if (outputEnd <= outputStart + EPSILON) {
      input.dispose();
      return last;
    }
    const sourceStart = offset + (outputStart - entry.outputStart);
    const sourceEnd = offset + (outputEnd - entry.outputStart);

    try {
      const track = await input.getPrimaryAudioTrack();
      if (track) {
        const sink = new library.AudioSampleSink(track);

        for await (const sample of sink.samples(sourceStart, sourceEnd)) {
          let conformed: AudioSample | null = null;

          try {
            if (signal.aborted) throw new EditorCanceledError();

            // `offset` is how far into the file the previous clips already
            // played, so subtracting it is what makes one track continue across
            // several clips instead of restarting under each of them.
            const trimmedStart = Math.max(sample.timestamp, sourceStart);
            const timestamp = outputStart + trimmedStart - sourceStart;
            if (timestamp <= last && last > -Infinity) continue;

            // A soundtrack chosen by the reader has whatever rate and channel
            // count its file happens to have, and the encoder was configured
            // from the first sample it ever saw. Conforming here is what lets a
            // 44.1 kHz mono voice-over sit between two 48 kHz stereo clips.
            conformed = this.conformAudio(
              library,
              sample,
              plan,
              timestamp,
              plan.soundFades,
              { start: sourceStart, end: sourceEnd },
              volumeGain(entry.edits)
            );
            if (!conformed) continue;
            await source.add(conformed);
            last = timestamp;
            end = Math.max(end, timestamp + conformed.duration);
            tick?.(timestamp);
          } finally {
            if (conformed && conformed !== sample) conformed.close();
            sample.close();
          }
        }
      }
    } finally {
      input.dispose();
    }

    const silenceStart = Math.max(outputStart, end);
    const remainder = outputEnd - silenceStart;
    if (remainder <= 1 / plan.sampleRate) return last;

    return this.writeSilence(library, source, silenceStart, remainder, plan, last, signal);
  }

  /**
   * Writes the stretch where two shots are on screen at once.
   *
   * The only output-clock loop in this file. Everywhere else frames arrive from
   * a decoder and are placed; here the finished video is walked frame by frame
   * and each side of the join is *asked* what it was showing — because the whole
   * point is to have both pictures for the same instant, and two decoders left
   * to their own pace will never produce them as a pair.
   *
   * Both clips' decoders are open at the same time, which happens nowhere else.
   * They are opened here rather than kept from the clip writers so that the
   * ordinary path stays exactly as it was: one file open, one frame in flight.
   */
  private async writeTransition(
    library: MediabunnyLib,
    join: TransitionPlan,
    from: ClipPlan,
    to: ClipPlan,
    plan: ProjectPlan,
    videoSource: import('mediabunny').VideoSampleSource,
    painter: TransitionPainter,
    lastTimestamp: number,
    signal: AbortSignal,
    tick: (seconds: number) => void
  ): Promise<number> {
    const canvas = canvasOfSize(plan.width, plan.height);
    const context = canvas.getContext('2d', { alpha: false }) as FrameContext | null;
    if (!context) throw new EditorError('This browser could not draw the transition.');

    const outgoing = await this.openSide(library, from, plan, join.start, join.end);
    let incoming: TransitionSide = EMPTY_SIDE;

    try {
      incoming = await this.openSide(library, to, plan, join.start, join.end);

      const step = 1 / plan.frameRate;
      const frames = Math.max(1, Math.round((join.end - join.start) / step));
      let last = lastTimestamp;

      for (let frame = 0; frame < frames; frame++) {
        if (signal.aborted) throw new EditorCanceledError();

        const timestamp = join.start + frame * step;
        if (timestamp <= last) continue;

        composeFrame(context, plan, timestamp, plan.width, plan.height, await outgoing.frameAt(timestamp), {
          entry: join,
          incoming: await incoming.frameAt(timestamp),
          painter
        });

        // Built from the canvas, which copies its contents there and then —
        // which is what makes drawing every frame of the join onto one canvas
        // safe.
        const sample = new library.VideoSample(canvas, { timestamp, duration: step });
        try {
          await videoSource.add(sample);
        } finally {
          sample.close();
        }

        last = timestamp;
        tick(timestamp);
      }

      return last;
    } finally {
      outgoing.dispose();
      incoming.dispose();
    }
  }

  /**
   * Opens whichever kind of picture this clip has, for the length of a join.
   *
   * A clip with nothing to show — audio with no picture, a file that would not
   * decode — comes back empty rather than throwing. A transition is a flourish;
   * losing the flourish is not a reason to lose the export, and the compositor
   * draws black for a side it was given nothing for.
   */
  private async openSide(
    library: MediabunnyLib,
    entry: ClipPlan,
    plan: ProjectPlan,
    windowStart: number,
    windowEnd: number
  ): Promise<TransitionSide> {
    const clip = entry.clip;

    try {
      if (!isMediaClip(clip)) {
        const scene = await this.buildScene(clip, plan);
        const canvas = canvasOfSize(plan.width, plan.height);
        const context = canvas.getContext('2d', { alpha: false }) as FrameContext | null;
        if (!context) {
          // The scene may already hold a decoded background bitmap.
          this.releaseScene(scene);
          return EMPTY_SIDE;
        }

        return new SceneSide(scene, canvas, context, entry, clampSpeed(entry.edits.speed), () =>
          this.releaseScene(scene)
        );
      }

      if (clip.summary.kind === 'image') {
        const bitmap = await imageBitmapForFile(clip.file);
        return new StillSide(bitmap, bitmap.width, bitmap.height, () => bitmap.close());
      }

      if (!clip.summary.videoUsable) return EMPTY_SIDE;

      const input = new library.Input({ source: new library.BlobSource(clip.file), formats: library.ALL_FORMATS });

      // Everything from here on can throw, and the outer `catch` cannot give the
      // decoder back because it cannot see it. A join that fails to open one side
      // leaks a decoder per join per export otherwise, which on a long timeline is
      // how a tab runs out of memory.
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) {
          input.dispose();
          return EMPTY_SIDE;
        }

        // A margin at each end because a decoder yields the frame that was
        // already on screen at the start of a range, and because the last instant
        // of the join must still find something to show.
        const duration = Math.max(0, clip.summary.durationSeconds);
        const first = Math.max(0, sourceTimeAt(entry, windowStart).sourceTime - 0.5);
        const lastTime = Math.min(duration, sourceTimeAt(entry, windowEnd).sourceTime + 0.5);

        return new FootageSide(input, new library.VideoSampleSink(track), entry, first, Math.max(first, lastTime));
      } catch (error) {
        input.dispose();
        throw error;
      }
    } catch {
      return EMPTY_SIDE;
    }
  }

  /** Holds a still picture on screen for as long as the clip lasts. */
  private async writeStill(
    library: MediabunnyLib,
    source: import('mediabunny').VideoSampleSource,
    clip: MediaClip,
    entry: ClipPlan,
    plan: ProjectPlan,
    lastTimestamp: number,
    signal: AbortSignal,
    picture = entry.outputDuration
  ): Promise<number> {
    let bitmap: ImageBitmap;

    try {
      bitmap = await imageBitmapForFile(clip.file);
    } catch {
      throw new EditorError(
        `"${clip.summary.fileName}" could not be decoded as an image.`,
        'Remove it from the timeline, or convert it to PNG or JPEG first.'
      );
    }

    try {
      return await this.holdFrame(library, source, bitmap, entry.outputStart, picture, plan, lastTimestamp, signal);
    } finally {
      bitmap.close();
    }
  }

  /** Writes the black screen a clip with no picture plays over. */
  private async writeBlack(
    library: MediabunnyLib,
    source: import('mediabunny').VideoSampleSource,
    start: number,
    duration: number,
    plan: ProjectPlan,
    lastTimestamp: number,
    signal: AbortSignal
  ): Promise<number> {
    const canvas = canvasOfSize(plan.width, plan.height);
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new EditorError('This browser could not draw the black frames.');

    context.fillStyle = '#000000';
    context.fillRect(0, 0, plan.width, plan.height);

    return this.holdFrame(library, source, canvas, start, duration, plan, lastTimestamp, signal);
  }

  /**
   * Repeats one image across a stretch of the output.
   *
   * Shared by the black screen and the still pictures, because they are the
   * same problem. The frame rate normalisation on the source repeats whatever
   * it was last given up to the next frame it receives, so a five-minute still
   * costs five decoded images rather than nine thousand.
   */
  private async holdFrame(
    library: MediabunnyLib,
    source: import('mediabunny').VideoSampleSource,
    image: CanvasImageSource,
    start: number,
    duration: number,
    plan: ProjectPlan,
    lastTimestamp: number,
    signal: AbortSignal
  ): Promise<number> {
    const step = 1 / plan.frameRate;
    let last = lastTimestamp;
    let written = 0;

    do {
      if (signal.aborted) throw new EditorCanceledError();

      const timestamp = Math.max(start + written, last + step);
      if (timestamp > start + duration && written > 0) break;

      // The duration is what the normaliser pads up to, so the last frame has
      // to reach the end of the clip: otherwise a still at the end of the
      // project would stop short of it.
      const remaining = Math.max(step, start + duration - timestamp);
      const sample = new library.VideoSample(image, {
        timestamp,
        duration: Math.min(remaining, STILL_FRAME_INTERVAL)
      });

      try {
        await source.add(sample);
      } finally {
        sample.close();
      }

      last = timestamp;
      written += STILL_FRAME_INTERVAL;
    } while (written < duration);

    return last;
  }

  /**
   * Writes digital silence for a clip that carries no sound.
   *
   * A muxed track with a hole in it is not a neutral thing: some players skip
   * the gap, some stall on it, and some lose sync for everything after it. So
   * the gap is filled with actual zero samples, in short pieces, so a long
   * silent stretch never builds one enormous buffer.
   */
  private async writeSilence(
    library: MediabunnyLib,
    source: import('mediabunny').AudioSampleSource,
    start: number,
    duration: number,
    plan: ProjectPlan,
    lastTimestamp: number,
    signal: AbortSignal
  ): Promise<number> {
    const { sampleRate, channelCount } = plan;
    let last = lastTimestamp;
    let written = 0;

    while (written < duration) {
      if (signal.aborted) throw new EditorCanceledError();

      const seconds = Math.min(SILENCE_CHUNK, duration - written);
      const frames = Math.max(1, Math.round(seconds * sampleRate));
      const timestamp = start + written;
      // Not `break`, and not a whole chunk skipped either. A clip whose sound
      // begins under a transition is handed a start that has already been
      // written past by a fraction of a chunk; stopping would abandon the rest
      // of the clip, and skipping half a second of it to reach the next boundary
      // would leave the hole this function exists to prevent. So the cursor moves
      // to exactly where the previous writer stopped and carries on from there.
      if (timestamp <= last) {
        written = Math.min(duration, last - start + 1 / sampleRate);
        continue;
      }

      const sample = new library.AudioSample({
        data: new Float32Array(frames * channelCount),
        format: 'f32',
        numberOfChannels: channelCount,
        sampleRate,
        timestamp
      });

      try {
        await source.add(sample);
      } finally {
        sample.close();
      }

      last = timestamp;
      written += frames / sampleRate;
    }

    return last;
  }

  // ------------------------------------------------------------ processors

  /**
   * Hands each frame to the shared compositor.
   *
   * The timestamp read here is already a position in the finished video —
   * Mediabunny calls this after its own transformations, and every sample was
   * placed on the output timeline before being added — which is the same clock
   * the preview draws against, and the reason both can use one function.
   */
  private videoProcessor(plan: ProjectPlan): (sample: VideoSample) => VideoSample | CanvasImageSource {
    let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    let context: FrameContext | null = null;

    return (sample) => {
      // A frame from inside a join arrives already finished: `writeTransition`
      // composed both shots, and the fade over them, onto its own canvas. Running
      // it through here again would apply the fade twice — visibly darker in the
      // file than in the preview — and would crop *both* shots with the outgoing
      // clip's zoom, which is the opposite of what a transition is supposed to do
      // with the framing.
      if (transitionAt(plan, sample.timestamp)) return sample;

      // A frame that needs none of the three is returned untouched, which is
      // the point: a project with two fades in it must not pay to redraw every
      // frame of every clip.
      if (!needsCompositing(plan, sample.timestamp)) return sample;

      if (!canvas || !context) {
        canvas = canvasOfSize(plan.width, plan.height);
        context = canvas.getContext('2d') as FrameContext | null;
        if (!context) throw new EditorError('This browser could not draw the effects.');
      }

      composeFrame(context, plan, sample.timestamp, plan.width, plan.height, {
        draw: (target, x, y, width, height) => sample.draw(target, x, y, width, height),
        width: sample.displayWidth,
        height: sample.displayHeight
      });

      return canvas;
    };
  }

  /**
   * Scales a block of audio by the fade ramp, sample by sample.
   *
   * The gain is recomputed per frame rather than per packet because a packet is
   * around twenty milliseconds long: holding one gain across it would turn a
   * smooth ramp into a staircase, and a staircase in amplitude is audible as a
   * series of clicks.
   */
  private audioFader(library: MediabunnyLib, plan: ProjectPlan): (sample: AudioSample) => AudioSample {
    return (sample) => {
      const start = sample.timestamp;
      const end = start + sample.duration;
      if (!plan.audioFades.some((fade) => fade.start < end && fade.end > start)) return sample;

      const frames = sample.numberOfFrames;
      const channels = sample.numberOfChannels;
      const data = new Float32Array(frames * channels);
      sample.copyTo(data, { planeIndex: 0, format: 'f32' });

      for (let frame = 0; frame < frames; frame++) {
        const gain = fadeGainAt(plan.audioFades, start + frame / sample.sampleRate);
        if (gain >= 1) continue;

        const offset = frame * channels;
        for (let channel = 0; channel < channels; channel++) data[offset + channel] *= gain;
      }

      return new library.AudioSample({
        data,
        format: 'f32',
        numberOfChannels: channels,
        sampleRate: sample.sampleRate,
        timestamp: start
      });
    };
  }

  // --------------------------------------------------------------- helpers

  /** Turns a text card's draft into a scene at the output's size. */
  private async buildScene(clip: TextClip, plan: ProjectPlan): Promise<TextScene> {
    const { draft } = clip;
    let background: SceneBackground = { kind: 'color', color: draft.backgroundColor };

    if (clip.backgroundFile) {
      try {
        const bitmap = await createImageBitmap(clip.backgroundFile);
        background = { kind: 'image', image: bitmap, width: bitmap.width, height: bitmap.height };
      } catch {
        // A background that will not decode is not worth failing an export
        // over: the card still says what it says, over the colour instead.
      }
    }

    return {
      width: plan.width,
      height: plan.height,
      background,
      text: draft.text,
      fontFamily: fontStack(draft.fontId),
      fontScale: draft.fontScale,
      fontWeight: draft.fontWeight,
      color: draft.color,
      letterSpacing: draft.letterSpacing,
      lineHeight: draft.lineHeight,
      align: draft.align,
      vertical: draft.vertical,
      margin: draft.margin,
      legibility: draft.legibility,
      animation: draft.animation,
      revealSeconds: draft.revealSeconds,
      holdSeconds: draft.holdSeconds,
      // The card's own fades are left off: the clip's fades are already on the
      // project timeline, and applying both would ramp the card twice.
      fadeIn: false,
      fadeOut: false,
      fadeSeconds: 0
    };
  }

  private releaseScene(scene: TextScene): void {
    if (scene.background.kind !== 'image') return;
    const image = scene.background.image;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
  }

  /**
   * Refuses early when the browser cannot encode what was asked for.
   *
   * The alternative is a failure thrown from inside the first encode, several
   * minutes in, phrased in terms of a WebCodecs configuration object.
   */
  private async assertEncodable(
    library: MediabunnyLib,
    kind: 'video' | 'audio',
    format: OutputFormatOption,
    plan: ProjectPlan
  ): Promise<void> {
    if (kind === 'video' && format.videoCodec) {
      const ok = await library.canEncodeVideo(format.videoCodec, { width: plan.width, height: plan.height });
      if (!ok) {
        throw new EditorError(
          `Your browser cannot encode ${format.label} at ${plan.width} × ${plan.height}.`,
          'Choose a smaller picture size, pick another format, or try a current desktop browser.'
        );
      }
    }

    const audioOk = await library.canEncodeAudio(format.audioCodec, {
      numberOfChannels: plan.channelCount,
      sampleRate: plan.sampleRate
    });
    if (!audioOk) {
      throw new EditorError(
        `Your browser cannot encode ${format.label} audio.`,
        'Pick another format, or try a current desktop browser.'
      );
    }
  }

  private containerFor(library: MediabunnyLib, format: OutputFormatOption): OutputFormat {
    switch (format.id) {
      case 'webm':
        return new library.WebMOutputFormat();
      case 'mkv':
        return new library.MkvOutputFormat();
      case 'mov':
        return new library.MovOutputFormat();
      case 'wav':
        return new library.WavOutputFormat();
      case 'ogg':
        return new library.OggOutputFormat();
      case 'mp3':
        return new library.Mp3OutputFormat();
      default:
        // `fastStart` is left unset on purpose: forcing `'in-memory'` would
        // hold every chunk in RAM until finalization, which is exactly what
        // streaming to disk exists to avoid.
        return new library.Mp4OutputFormat();
    }
  }

  /**
   * Wraps the muxed bytes for download.
   *
   * Only the in-memory path needs this. A stream target has already written
   * every byte to the file the reader chose, and closed it.
   */
  private takeBuffer(output: Output<OutputFormat, Target>, format: OutputFormatOption): Blob {
    const buffer = (output.target as import('mediabunny').BufferTarget).buffer;
    if (!buffer) throw new EditorError('The edited file could not be assembled.');
    // The catalogue's type, not `output.format.mimeType`: the muxer reports
    // `video/mp4` for an MP4 that only ever held an audio track.
    return new Blob([buffer], { type: format.mimeType });
  }

  /**
   * Turns a low-level failure into something worth reading.
   *
   * "The operation failed" tells nobody anything; whether the encoder was
   * refused, the disk filled up or a codec is simply absent decides what the
   * reader should try next.
   */
  private describe(error: unknown, partialFileOnDisk = false): EditorError | EditorCanceledError {
    if (error instanceof EditorCanceledError || error instanceof EditorError) return error;

    const raw = String((error as Error)?.message ?? error ?? '');
    const message = raw.toLowerCase();
    const detail = technicalDetail(error);
    const partial = partialFileOnDisk
      ? ' The file at the location you chose is incomplete and can be deleted.'
      : '';

    if (message.includes('quota') || message.includes('no space')) {
      return new EditorError(
        'There is not enough free space to write the edited file.' + partial,
        'Free some disk space, or export a shorter project.',
        undefined,
        detail
      );
    }
    if (message.includes('writable') || message.includes('not allowed')) {
      return new EditorError(
        'The edited file could not be written.' + partial,
        'Check that the destination is still available and that the browser still has permission to write there.',
        undefined,
        detail
      );
    }
    if (message.includes('memory') || message.includes('allocation')) {
      return new EditorError(
        'The browser ran out of memory while exporting.',
        'Choose a smaller picture size, close other tabs, or export fewer clips at a time.',
        undefined,
        detail
      );
    }
    if (message.includes('encod')) {
      return new EditorError(
        'Your browser refused to encode the edited file.',
        'Try another format or a smaller picture size.',
        undefined,
        detail
      );
    }
    if (message.includes('decod') || message.includes('codec')) {
      return new EditorError(
        'Your browser cannot decode one of the clips on the timeline.',
        'Remove it, or convert it to MP4/H.264/AAC first.',
        undefined,
        detail
      );
    }

    // Two failures worth naming, because they read as a mystery otherwise and
    // both are the tool's fault rather than the reader's.
    if (message.includes('audio parameters must remain constant')) {
      return new EditorError(
        'The sound of this clip does not match the rest of the project.',
        'The clips on this timeline do not all have the same sample rate or channel count. Re-export; if it happens' +
          ' again, tell us the technical detail below.',
        undefined,
        detail
      );
    }
    if (message.includes('timestamp')) {
      return new EditorError(
        'This clip landed at a moment the file already had sound or a picture in.',
        'It usually means the clip is empty after its cuts, or that the speed left it with nothing to show. Check its' +
          ' length on the timeline.',
        undefined,
        detail
      );
    }

    return new EditorError(
      'The edited file could not be generated.',
      raw ? `The browser reported: ${raw}` : 'Check that every clip on the timeline is valid and try again.',
      undefined,
      detail
    );
  }
}
