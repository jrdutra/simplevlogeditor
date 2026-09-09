import { Injectable } from '@angular/core';
import type { Output, OutputFormat, Target } from 'mediabunny';

import { ensureMp3Encoder, loadMediabunny, MediabunnyLib } from '../../services/mediabunny/mediabunny-loader';
import { resolutionSize } from './media-merger-formats';
import {
  FadeSegment,
  MergeCanceledError,
  MergeError,
  MergePlan,
  MergeProgress,
  MergeResult,
  OutputFormatOption,
  QueuedMedia,
  ResolutionPreset
} from './media-merger.models';

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

/** Where the merged file will be written. */
export interface MergeDestination {
  /** Present when the reader picked a location and the file streams to disk. */
  handle: FileSystemWritableStreamLike | null;
  fileName: string;
}

export interface MergeOptions {
  items: readonly QueuedMedia[];
  kind: 'video' | 'audio';
  /** The container and codecs the reader picked for this kind of download. */
  format: OutputFormatOption;
  resolution: ResolutionPreset;
  /** Length of each fade in seconds, before it is clamped to the clip. */
  fadeSeconds: number;
  destination: MergeDestination;
  signal: AbortSignal;
  onProgress: (report: MergeProgress) => void;
}

/** Seconds of silence written at a time when a clip has no sound of its own. */
const SILENCE_CHUNK = 0.5;

/** Seconds between the frames written for a still picture or a black screen. */
const STILL_FRAME_INTERVAL = 1;

/** Frame rate used when not a single clip declares one. */
const FALLBACK_FRAME_RATE = 30;

/** Bounds on the output frame rate. The upper one also bounds the cost of the
 *  black stretches, which are padded frame by frame. */
const MIN_FRAME_RATE = 1;
const MAX_FRAME_RATE = 60;

/**
 * Joins the queue into one file.
 *
 * The whole tool rests on one idea: the output is a single timeline, and every
 * clip is copied onto it at the offset where the clips before it ended. Each
 * sample keeps its own position inside its file and gains that offset — which
 * is why picture and sound never drift apart, since both get the same number.
 *
 * What the reader gives us is rarely uniform: clips differ in size, frame rate,
 * sample rate and channel count, and some carry only sound or only picture. All
 * of that is normalised into one shape decided before the first byte is
 * encoded, and the holes are filled explicitly — a black screen where there is
 * no picture, digital silence where there is no sound — because a track with
 * gaps in it is a file that plays differently in every player.
 *
 * Nothing is buffered: samples are pulled from one input at a time and awaited
 * into the encoder, so backpressure keeps memory flat no matter how long the
 * queue is.
 */
@Injectable({ providedIn: 'root' })
export class MediaMergeService {
  /**
   * Asks the reader where to save, while the click that started the merge is
   * still fresh.
   *
   * The picker needs user activation, which does not survive a few awaited
   * promises — so it is called before anything else. A browser without the API
   * simply falls back to a download at the end, which is also why nothing here
   * treats a dismissed dialog as a failure.
   */
  async pickDestination(kind: 'video' | 'audio', format: OutputFormatOption): Promise<MergeDestination> {
    const fileName = `merged-${kind === 'video' ? 'video' : 'audio'}.${format.extension}`;
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

  async merge(options: MergeOptions): Promise<MergeResult> {
    const { items, kind, format, resolution, fadeSeconds, destination, signal, onProgress } = options;
    if (!items.length) throw new MergeError('Add at least one file before merging.');

    const library = await loadMediabunny();
    const fades = this.buildFades(items, fadeSeconds);
    const plan = { ...this.buildPlan(items, kind, resolution, format.audioCodec), fadeCount: fades.length };

    onProgress({ stage: 'preparing', ratio: 0, itemIndex: 0, itemCount: items.length, itemName: '' });

    if (kind === 'video' && !plan.videoSources) {
      throw new MergeError(
        'None of the files in the queue contain a picture your browser can decode.',
        'Download the result as audio instead, or add a video file to the queue.'
      );
    }

    // No browser encodes MP3 on its own, so LAME is fetched before the output
    // is created rather than in the middle of the first encode.
    if (format.audioCodec === 'mp3') await ensureMp3Encoder();
    await this.assertEncodable(library, kind, format, plan);

    const target = destination.handle
      ? new library.StreamTarget(destination.handle, { chunked: true })
      : new library.BufferTarget();
    const output = new library.Output({
      format: this.containerFor(library, format),
      target
    }) as Output<OutputFormat, Target>;

    /** Once true the file is committed, and failures after it must not cancel. */
    let finalized = false;

    try {
      const videoSource =
        kind === 'video' && format.videoCodec
          ? new library.VideoSampleSource({
              codec: format.videoCodec,
              quality: new library.Quality('high'),
              keyFrameInterval: 2,
              // The guard against a mid-stream size change compares the frame
              // as it arrives, before any transform — and a merge is nothing
              // but a stream of size changes. `passThrough` waves it through;
              // the transform below is what actually makes every frame the
              // same size, letterboxed rather than cropped or stretched.
              sizeChangeBehavior: 'passThrough',
              // Normalising the frame rate as well is what lets a black
              // stretch be written as a single frame: the gap up to the next
              // real frame is padded for us, at the output rate.
              transform: {
                width: plan.width,
                height: plan.height,
                fit: 'contain',
                frameRate: plan.frameRate,
                ...(fades.length ? { process: this.videoFader(fades, plan) } : {})
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
          ...(fades.length ? { process: this.audioFader(fades, library) } : {})
        }
      });
      output.addAudioTrack(audioSource);

      await output.start();

      /** Where on the output timeline the next clip begins, in seconds. */
      let cursor = 0;
      // A muxer stores timestamps unsigned, so a value that goes backwards does
      // not fail loudly — it wraps to an enormous number and every later sample
      // then looks out of order. These two make that impossible.
      let lastVideo = -Infinity;
      let lastAudio = -Infinity;

      for (const [index, item] of items.entries()) {
        if (signal.aborted) throw new MergeCanceledError();

        const report = (seconds: number) =>
          onProgress({
            stage: 'encoding',
            ratio: plan.totalDuration > 0 ? Math.min(1, seconds / plan.totalDuration) : null,
            itemIndex: index + 1,
            itemCount: items.length,
            itemName: item.summary.fileName
          });

        report(cursor);
        const duration = item.summary.durationSeconds;

        if (item.summary.kind === 'image') {
          if (videoSource) {
            lastVideo = await this.writeStill(library, videoSource, item, cursor, duration, plan, lastVideo, signal);
          }
          lastAudio = await this.writeImageAudio(
            library,
            audioSource,
            item,
            cursor,
            duration,
            plan,
            lastAudio,
            signal,
            report
          );
          cursor += duration;
          continue;
        }

        const input = new library.Input({
          source: new library.BlobSource(item.file),
          formats: library.ALL_FORMATS
        });

        try {
          if (videoSource) {
            lastVideo = item.summary.videoUsable
              ? await this.copyVideo(library, input, videoSource, cursor, lastVideo, signal, report)
              : await this.writeBlack(library, videoSource, cursor, duration, plan, lastVideo, signal);
          }

          // The picture normally drives the progress bar, since it is the
          // slower half. A clip with no picture has to drive it from its sound
          // instead, or a long song in the middle of a queue would look frozen.
          const audioDrivesProgress = !videoSource || !item.summary.videoUsable;

          lastAudio = item.summary.audioUsable
            ? (
                await this.copyAudio(
                  library,
                  input,
                  audioSource,
                  cursor,
                  lastAudio,
                  signal,
                  audioDrivesProgress ? report : null
                )
              ).last
            : await this.writeSilence(library, audioSource, cursor, duration, plan, lastAudio, signal);

          cursor += duration;
        } finally {
          input.dispose();
        }
      }

      onProgress({ stage: 'muxing', ratio: 1, itemIndex: items.length, itemCount: items.length, itemName: '' });

      // Finalizing writes the index and, for a stream target, closes the
      // underlying writable itself. Once it resolves the file is complete and
      // must not be touched again.
      await output.finalize();
      finalized = true;

      onProgress({ stage: 'finishing', ratio: 1, itemIndex: items.length, itemCount: items.length, itemName: '' });

      return {
        blob: destination.handle ? null : this.takeBuffer(output, format),
        fileName: destination.fileName,
        savedToDisk: Boolean(destination.handle),
        kind,
        plan
      };
    } catch (error) {
      if (!finalized) await output.cancel().catch(() => undefined);
      throw this.describe(error, Boolean(destination.handle) && !finalized);
    }
  }

  // -------------------------------------------------------------- the plan

  /**
   * Decides the single shape every clip is normalised into.
   *
   * It is settled before anything is encoded because an encoder is configured
   * once: discovering halfway through the queue that a clip is 4K, or 96 kHz,
   * is far too late. Automatic sizing takes the largest picture in the queue so
   * that nothing is ever scaled *up* — enlarging a small clip to match a big
   * one costs bytes and adds no detail.
   */
  private buildPlan(
    items: readonly QueuedMedia[],
    kind: 'video' | 'audio',
    resolution: ResolutionPreset,
    audioCodec: string
  ): MergePlan & { videoSources: number } {
    const videos = items.filter((item) => item.summary.videoUsable);
    const chosen = resolutionSize(resolution);

    const width = chosen?.width ?? Math.max(2, ...videos.map((item) => item.summary.width ?? 0));
    const height = chosen?.height ?? Math.max(2, ...videos.map((item) => item.summary.height ?? 0));

    const declaredRate = Math.max(0, ...videos.map((item) => item.summary.frameRate ?? 0));
    const frameRate = Math.round(
      Math.min(MAX_FRAME_RATE, Math.max(MIN_FRAME_RATE, declaredRate || FALLBACK_FRAME_RATE))
    );

    const declaredSampleRate = Math.max(
      0,
      ...items.filter((item) => item.summary.audioUsable).map((item) => item.summary.sampleRate ?? 0)
    );
    const declaredChannels = Math.max(
      0,
      ...items.filter((item) => item.summary.audioUsable).map((item) => item.summary.channelCount ?? 0)
    );

    return {
      // Encoders reject odd dimensions, and `roundDimensionsTo: 2` inside the
      // transform would silently disagree with the number reported here.
      width: Math.max(2, Math.round(width / 2) * 2),
      height: Math.max(2, Math.round(height / 2) * 2),
      frameRate,
      sampleRate: this.sampleRateFor(audioCodec, declaredSampleRate),
      // Beyond stereo the layouts stop being interchangeable between formats,
      // and a merged file is the wrong place to guess at a surround mapping.
      channelCount: Math.min(2, Math.max(1, declaredChannels || 2)),
      totalDuration: items.reduce((total, item) => total + item.summary.durationSeconds, 0),
      audioOnlyCount: kind === 'video' ? items.filter((item) => !item.summary.videoUsable).length : 0,
      silentCount: items.filter((item) => !item.summary.audioUsable && !item.attachedAudio).length,
      fadeCount: 0,
      videoSources: videos.length
    };
  }

  /**
   * Resolves every checked fade to a ramp on the finished timeline.
   *
   * A fade is clamped to the clip it belongs to: asking for a one-second fade
   * on a half-second clip cannot be honoured literally, and letting the ramp
   * spill into the neighbouring clip would fade out footage the reader never
   * asked to touch. A clip fading at both ends splits itself in half at worst,
   * so the two ramps meet rather than overlap.
   */
  private buildFades(items: readonly QueuedMedia[], fadeSeconds: number): FadeSegment[] {
    const fades: FadeSegment[] = [];
    let cursor = 0;

    for (const item of items) {
      const duration = item.summary.durationSeconds;
      const both = item.fadeIn && item.fadeOut;
      const span = Math.min(fadeSeconds, duration / (both ? 2 : 1));

      if (span > 0 && item.fadeIn) fades.push({ start: cursor, end: cursor + span, kind: 'in' });
      if (span > 0 && item.fadeOut) {
        fades.push({ start: cursor + duration - span, end: cursor + duration, kind: 'out' });
      }

      cursor += duration;
    }

    return fades;
  }

  /**
   * The volume, and the brightness, at one instant: 1 outside every ramp.
   *
   * The segments are sorted and never overlap, so the first one that starts
   * after the instant ends the search.
   */
  private gainAt(fades: readonly FadeSegment[], time: number): number {
    for (const fade of fades) {
      if (time < fade.start) break;
      if (time >= fade.end) continue;

      const progress = (time - fade.start) / (fade.end - fade.start);
      return fade.kind === 'in' ? progress : 1 - progress;
    }
    return 1;
  }

  /**
   * Darkens a frame toward black according to the ramp it falls in.
   *
   * Returning the sample untouched outside a ramp is the whole point: a merge
   * with two fades in it must not pay to redraw every frame of every clip.
   */
  private videoFader(
    fades: readonly FadeSegment[],
    plan: MergePlan
  ): (sample: import('mediabunny').VideoSample) => import('mediabunny').VideoSample | CanvasImageSource {
    let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

    return (sample) => {
      const gain = this.gainAt(fades, sample.timestamp);
      if (gain >= 1) return sample;

      if (!canvas || !context) {
        canvas = this.canvasOfSize(plan.width, plan.height);
        context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
        if (!context) throw new MergeError('This browser could not draw the fades.');
      }

      context.globalAlpha = 1;
      context.clearRect(0, 0, plan.width, plan.height);
      sample.draw(context, 0, 0, plan.width, plan.height);

      // Black laid over the picture rather than the picture drawn at reduced
      // opacity: a transparent frame over a cleared canvas would fade to
      // nothing at all in the formats that carry an alpha channel.
      context.globalAlpha = 1 - gain;
      context.fillStyle = '#000000';
      context.fillRect(0, 0, plan.width, plan.height);
      context.globalAlpha = 1;

      return canvas;
    };
  }

  /**
   * Scales a block of audio by the ramp, sample by sample.
   *
   * The gain is recomputed per frame rather than per packet because a packet is
   * around twenty milliseconds long: holding one gain across it would turn a
   * smooth ramp into a staircase, and a staircase in amplitude is audible as a
   * series of clicks.
   */
  private audioFader(
    fades: readonly FadeSegment[],
    library: MediabunnyLib
  ): (sample: import('mediabunny').AudioSample) => import('mediabunny').AudioSample {
    return (sample) => {
      const start = sample.timestamp;
      const end = start + sample.duration;
      if (!fades.some((fade) => fade.start < end && fade.end > start)) return sample;

      const frames = sample.numberOfFrames;
      const channels = sample.numberOfChannels;
      const data = new Float32Array(frames * channels);
      sample.copyTo(data, { planeIndex: 0, format: 'f32' });

      for (let frame = 0; frame < frames; frame++) {
        const gain = this.gainAt(fades, start + frame / sample.sampleRate);
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

  /** The nearest rate the chosen codec actually accepts. */
  private sampleRateFor(codec: string, declared: number): number {
    if (codec === 'opus') return 48000;
    if (!declared) return 48000;
    if (codec === 'mp3') return declared <= 44100 ? 44100 : 48000;
    return Math.min(96000, Math.max(8000, Math.round(declared)));
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
    plan: MergePlan
  ): Promise<void> {
    if (kind === 'video' && format.videoCodec) {
      const ok = await library.canEncodeVideo(format.videoCodec, {
        width: plan.width,
        height: plan.height
      });
      if (!ok) {
        throw new MergeError(
          `Your browser cannot encode ${format.label} at ${plan.width} × ${plan.height}.`,
          'Choose a smaller resolution, pick another output format, or try a current desktop browser.'
        );
      }
    }

    const audioOk = await library.canEncodeAudio(format.audioCodec, {
      numberOfChannels: plan.channelCount,
      sampleRate: plan.sampleRate
    });
    if (!audioOk) {
      throw new MergeError(
        `Your browser cannot encode ${format.label} audio.`,
        'Pick another output format, or try a current desktop browser.'
      );
    }
  }

  // --------------------------------------------------------------- copying

  /** Copies one clip's picture onto the output timeline. */
  private async copyVideo(
    library: MediabunnyLib,
    input: import('mediabunny').Input,
    source: import('mediabunny').VideoSampleSource,
    cursor: number,
    lastTimestamp: number,
    signal: AbortSignal,
    report: (seconds: number) => void
  ): Promise<number> {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return lastTimestamp;

    let last = lastTimestamp;
    const sink = new library.VideoSampleSink(track);

    for await (const sample of sink.samples()) {
      // A decoded frame holds a real GPU or system buffer, so it is closed in a
      // `finally`: an encoder that rejects mid-file must not leave frames alive
      // until the garbage collector notices them.
      try {
        if (signal.aborted) throw new MergeCanceledError();

        const timestamp = Math.max(sample.timestamp + cursor, cursor);
        if (timestamp <= last) continue;

        sample.setTimestamp(timestamp);
        await source.add(sample);
        last = timestamp;
        report(timestamp);
      } finally {
        sample.close();
      }
    }

    return last;
  }

  /** Copies one clip's sound onto the output timeline. */
  private async copyAudio(
    library: MediabunnyLib,
    input: import('mediabunny').Input,
    source: import('mediabunny').AudioSampleSource,
    cursor: number,
    lastTimestamp: number,
    signal: AbortSignal,
    report: ((seconds: number) => void) | null,
    /** Seconds of the source to take, when the entry is shorter than the file. */
    limit?: number
  ): Promise<{ last: number; end: number }> {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { last: lastTimestamp, end: -Infinity };

    let last = lastTimestamp;
    // Where the sound genuinely stops. A packet is not cut at the range bound,
    // so the last one usually reaches past it — and writing silence from the
    // requested bound instead would overlap it.
    let end = -Infinity;
    const sink = new library.AudioSampleSink(track);

    for await (const sample of limit === undefined ? sink.samples() : sink.samples(0, limit)) {
      try {
        if (signal.aborted) throw new MergeCanceledError();

        const timestamp = Math.max(sample.timestamp + cursor, cursor);
        if (timestamp < last) continue;

        sample.setTimestamp(timestamp);
        await source.add(sample);
        last = timestamp;
        end = Math.max(end, timestamp + sample.duration);
        report?.(timestamp);
      } finally {
        sample.close();
      }
    }

    return { last, end };
  }

  // --------------------------------------------------------------- filling

  /**
   * Writes the black screen an audio-only clip plays over.
   *
   * The frame rate normalisation on the source repeats whatever it was last
   * given up to the next frame it receives, so a black stretch does not have to
   * be drawn frame by frame: one frame per second is enough, and the gaps are
   * filled in at the output rate. Progress is reported by the sound of the same
   * clip rather than from here, since both cover the same span and two sources
   * driving one bar would make it jump backwards.
   */
  private async writeBlack(
    library: MediabunnyLib,
    source: import('mediabunny').VideoSampleSource,
    cursor: number,
    duration: number,
    plan: MergePlan,
    lastTimestamp: number,
    signal: AbortSignal
  ): Promise<number> {
    const canvas = this.blackCanvas(plan.width, plan.height);
    return this.holdFrame(library, source, canvas, cursor, duration, plan, lastTimestamp, signal);
  }

  /**
   * Repeats one image across a stretch of the output timeline.
   *
   * Shared by the black screen and the still pictures, because they are the
   * same problem: a span of output that has to carry a picture, from a source
   * that only has one.
   */
  private async holdFrame(
    library: MediabunnyLib,
    source: import('mediabunny').VideoSampleSource,
    image: CanvasImageSource,
    cursor: number,
    duration: number,
    plan: MergePlan,
    lastTimestamp: number,
    signal: AbortSignal
  ): Promise<number> {
    const step = 1 / plan.frameRate;
    let last = lastTimestamp;
    let written = 0;

    do {
      if (signal.aborted) throw new MergeCanceledError();

      const timestamp = Math.max(cursor + written, last + step);
      if (timestamp > cursor + duration && written > 0) break;

      // The duration is what the normaliser pads up to, so the last frame has
      // to reach the end of the clip: otherwise the black would stop short
      // whenever this is the final item in the queue.
      const remaining = Math.max(step, cursor + duration - timestamp);
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
   * Holds a still picture on screen for as long as the entry lasts.
   *
   * Mechanically the same as the black screen: one frame per second, with the
   * frame rate normalisation filling the gaps between them, so a five-minute
   * still costs five decoded images rather than nine thousand. The picture is
   * handed over at its own size and letterboxed by the same transform that
   * fits the video clips, so a portrait photo between two landscape clips
   * lands centred instead of stretched.
   */
  private async writeStill(
    library: MediabunnyLib,
    source: import('mediabunny').VideoSampleSource,
    item: QueuedMedia,
    cursor: number,
    duration: number,
    plan: MergePlan,
    lastTimestamp: number,
    signal: AbortSignal
  ): Promise<number> {
    let bitmap: ImageBitmap;

    try {
      bitmap = await createImageBitmap(item.file);
    } catch {
      throw new MergeError(
        `"${item.summary.fileName}" could not be decoded as an image.`,
        'Remove it from the queue, or convert it to PNG or JPEG first.'
      );
    }

    try {
      return await this.holdFrame(library, source, bitmap, cursor, duration, plan, lastTimestamp, signal);
    } finally {
      bitmap.close();
    }
  }

  /**
   * The sound that plays under a still image.
   *
   * The entry's duration is the authority, not the attached file's: audio
   * longer than the image is cut at the image's end, and audio shorter than it
   * is followed by real silence. Letting the file decide instead would push
   * every later clip out of place by the difference.
   */
  private async writeImageAudio(
    library: MediabunnyLib,
    source: import('mediabunny').AudioSampleSource,
    item: QueuedMedia,
    cursor: number,
    duration: number,
    plan: MergePlan,
    lastTimestamp: number,
    signal: AbortSignal,
    report: (seconds: number) => void
  ): Promise<number> {
    const attached = item.attachedAudio;
    if (!attached) {
      return this.writeSilence(library, source, cursor, duration, plan, lastTimestamp, signal);
    }

    const input = new library.Input({
      source: new library.BlobSource(attached.file),
      formats: library.ALL_FORMATS
    });

    let last: number;
    let end: number;
    try {
      ({ last, end } = await this.copyAudio(
        library,
        input,
        source,
        cursor,
        lastTimestamp,
        signal,
        report,
        duration
      ));
    } finally {
      input.dispose();
    }

    // Silence begins where the sound actually stopped, never earlier: the last
    // packet reaches past the point it was cut at, and starting on top of it
    // would hand the encoder two samples covering the same instant.
    const silenceStart = Math.max(cursor, end);
    const remainder = cursor + duration - silenceStart;
    if (remainder <= 1 / plan.sampleRate) return last;

    return this.writeSilence(library, source, silenceStart, remainder, plan, last, signal);
  }

  /**
   * Writes digital silence for a clip that carries no usable sound.
   *
   * A muxed track with a hole in it is not a neutral thing: some players skip
   * the gap, some stall on it, and some lose sync for everything after it. So
   * the gap is filled with actual zero samples, in short pieces so a long
   * silent video never builds one enormous buffer.
   */
  private async writeSilence(
    library: MediabunnyLib,
    source: import('mediabunny').AudioSampleSource,
    cursor: number,
    duration: number,
    plan: MergePlan,
    lastTimestamp: number,
    signal: AbortSignal
  ): Promise<number> {
    const { sampleRate, channelCount } = plan;
    let last = lastTimestamp;
    let written = 0;

    while (written < duration) {
      if (signal.aborted) throw new MergeCanceledError();

      const seconds = Math.min(SILENCE_CHUNK, duration - written);
      const frames = Math.max(1, Math.round(seconds * sampleRate));
      const timestamp = cursor + written;
      if (timestamp < last) break;

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

  /** A canvas of the output size, painted black. */
  private blackCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
    const canvas = this.canvasOfSize(width, height);
    this.paintBlack(
      canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null,
      width,
      height
    );
    return canvas;
  }

  /** An offscreen canvas where one is available, a detached element otherwise. */
  private canvasOfSize(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  private paintBlack(
    context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null,
    width: number,
    height: number
  ): void {
    if (!context) throw new MergeError('This browser could not draw the black frames the audio-only clips play over.');
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
  }

  // --------------------------------------------------------------- helpers

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
        // streaming to disk exists to avoid. Mediabunny picks the right
        // placement from the target type on its own.
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
    if (!buffer) throw new MergeError('The merged file could not be assembled.');
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
  private describe(error: unknown, partialFileOnDisk = false): Error {
    if (error instanceof MergeCanceledError || error instanceof MergeError) return error;

    const message = String((error as Error)?.message ?? error ?? '').toLowerCase();
    const partial = partialFileOnDisk
      ? ' The file at the location you chose is incomplete and can be deleted.'
      : '';

    if (message.includes('quota') || message.includes('no space')) {
      return new MergeError(
        'There is not enough free space to write the merged file.' + partial,
        'Free some disk space, or merge fewer clips at a time.'
      );
    }
    if (message.includes('writable') || message.includes('not allowed')) {
      return new MergeError(
        'The merged file could not be written.' + partial,
        'Check that the destination is still available and that the browser still has permission to write there.'
      );
    }
    if (message.includes('memory') || message.includes('allocation')) {
      return new MergeError(
        'The browser ran out of memory while merging.',
        'Choose a smaller resolution, close other tabs, or merge fewer clips at a time.'
      );
    }
    if (message.includes('encod')) {
      return new MergeError(
        'Your browser refused to encode the merged file.',
        'Try another output format or a smaller resolution.'
      );
    }
    if (message.includes('decod') || message.includes('codec')) {
      return new MergeError(
        'Your browser cannot decode one of the files in the queue.',
        'Remove it, or convert it to MP4/H.264/AAC first.'
      );
    }

    return new MergeError('The merged file could not be generated.', 'Check that every file in the queue is valid and try again.');
  }
}
