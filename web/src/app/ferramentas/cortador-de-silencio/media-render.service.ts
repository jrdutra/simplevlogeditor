import { Injectable, inject } from '@angular/core';
import type { AudioSample, Output, OutputFormat, Target } from 'mediabunny';

import { ZoomSegment, drawZoomed, planAutoZooms, zoomScaleAt } from '../../shared/media/auto-zoom';
import { ProcessingEngineSelectorService } from './processing-engine-selector.service';
import { loadMediabunny, MediabunnyLib } from './mediabunny-loader';
import { describeError, silenceLog } from './silence-cutter-log';
import { totalDuration } from './silence-detector';
import {
  MediaInfo,
  MediaToolError,
  OperationCanceledError,
  ProcessingStrategy,
  ProgressReport,
  RenderResult,
  RenderStage,
  SilenceAnalysis,
  SilenceSettings,
  TimeRange
} from './silence-cutter.models';

/** Where the finished file will be written. */
export interface RenderDestination {
  /** Present when the reader picked a location and the file streams to disk. */
  handle: FileSystemWritableStreamLike | null;
  fileName: string;
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

export interface RenderOptions {
  analysis: SilenceAnalysis;
  settings: SilenceSettings;
  strategy: ProcessingStrategy;
  destination: RenderDestination;
  signal: AbortSignal;
  onProgress: (report: ProgressReport<RenderStage>) => void;
}

/**
 * Writes the cut file.
 *
 * The pipeline is deliberately boring: read the kept ranges in order, shift
 * every timestamp back by the silence removed before it, and hand the samples
 * to the encoder. Everything interesting is in what it refuses to do — it never
 * decodes a range it is going to drop, never holds more than a few frames at a
 * time, and never re-encodes anything when there is nothing to cut.
 *
 * Backpressure comes for free: adding a sample resolves only once the encoder
 * and the writer are ready for more, so awaiting each `add` is what stops
 * thousands of frames from piling up in memory or in video RAM.
 */
@Injectable({ providedIn: 'root' })
export class MediaRenderService {
  private readonly selector = inject(ProcessingEngineSelectorService);

  /**
   * Asks the reader where to save, while the click that started the render is
   * still fresh.
   *
   * The picker requires user activation, which does not survive a few awaited
   * promises — so it is called before anything else, and a browser without the
   * API simply falls back to a download at the end.
   */
  async pickDestination(info: MediaInfo, strategy: ProcessingStrategy): Promise<RenderDestination> {
    const fileName = this.outputName(info.fileName, strategy);
    const picker = (globalThis as unknown as SaveFilePickerGlobals).showSaveFilePicker;
    if (typeof picker !== 'function') {
      silenceLog.info('render', 'no save picker in this browser, the result will be downloaded', { fileName });
      return { handle: null, fileName };
    }

    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: 'Media file', accept: { [this.mimeFor(strategy)]: [`.${this.extensionFor(strategy)}`] } }]
      });
      const writable = await handle.createWritable();
      silenceLog.info('render', 'writing straight to the chosen file', { fileName });
      return { handle: writable, fileName };
    } catch (error) {
      // A reader who dismisses the dialog gets the download path instead of an
      // error; declining to choose a folder is not a failure.
      silenceLog.info('render', 'save dialog not used, falling back to download', {
        fileName,
        ...describeError(error)
      });
      return { handle: null, fileName };
    }
  }

  async render(file: File, info: MediaInfo, options: RenderOptions): Promise<RenderResult> {
    const library = await loadMediabunny();
    const { analysis, settings, strategy, destination, signal, onProgress } = options;

    const started = performance.now();
    onProgress({ stage: 'preparing', ratio: 0 });
    silenceLog.attachMediabunny(library);
    silenceLog.info('render', 'starting', {
      target: destination.handle ? 'stream-to-disk' : 'in-memory-download',
      fileName: destination.fileName,
      container: strategy.container,
      videoMode: strategy.videoMode,
      videoCodec: strategy.videoCodec,
      audioCodec: strategy.audioCodec,
      hardwarePreferred: strategy.hardwareAccelerationPreferred,
      crossfadeMs: settings.crossfadeMs
    });

    const keepRanges = analysis.keepRanges.filter((range) => range.end - range.start > 1e-6);
    if (!keepRanges.length) {
      throw new MediaToolError(
        'Every part of this media was marked as silence, so there would be nothing left to save.',
        'Lower the silence threshold or raise the minimum silence duration, then reanalyze.'
      );
    }

    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
    const target = destination.handle
      ? new library.StreamTarget(destination.handle, { chunked: true })
      : new library.BufferTarget();

    const output = new library.Output({ format: this.formatFor(library, strategy), target }) as Output<OutputFormat, Target>;

    /** Once true the file is committed, and failures after it must not cancel. */
    let finalized = false;

    try {
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack()
      ]);

      if (!audioTrack) throw new MediaToolError('No audio track was found in this file.');

      const streamCopy = strategy.videoMode === 'stream-copy' && analysis.silenceRanges.length === 0;
      const outputDuration = totalDuration(keepRanges);

      // Planned here rather than inside the encoder because it is decided
      // entirely by what was cut: the pauses that were removed and where the
      // takes around them land afterwards. The seed is the file itself, so the
      // same recording always gets the same zooms.
      const zooms = planAutoZooms(
        analysis.silenceRanges.filter((range) => range.enabled),
        keepRanges,
        settings.autoZoom,
        `${file.name}:${file.size}`
      );

      silenceLog.info('render', 'plan', {
        mode: streamCopy ? 'stream-copy' : 'decode-and-encode',
        keepRanges: keepRanges.length,
        cuts: analysis.silenceRanges.length,
        zooms: zooms.length,
        outputDuration: Math.round(outputDuration * 100) / 100,
        hasVideoTrack: Boolean(videoTrack)
      });

      const report = this.reporter(onProgress, outputDuration);

      if (streamCopy) {
        await this.copyStreams(library, output, videoTrack, audioTrack, report, signal);
      } else {
        await this.encodeRanges(
          library,
          output,
          videoTrack,
          audioTrack,
          keepRanges,
          settings,
          strategy,
          info,
          zooms,
          report,
          signal
        );
      }

      onProgress({ stage: 'muxing', ratio: 1 });
      onProgress({ stage: 'saving', ratio: null });

      // Finalizing writes the index and, for a stream target, closes the
      // underlying writable itself. Once it resolves the file on disk is
      // complete and must not be touched again.
      const finalizeStartedAt = performance.now();
      await output.finalize();
      finalized = true;
      silenceLog.timing('render', 'finalized', finalizeStartedAt);

      const blob = destination.handle ? null : this.takeBuffer(output);
      silenceLog.info('render', 'output ready', {
        savedToDisk: Boolean(destination.handle),
        bytes: blob?.size ?? null
      });

      onProgress({ stage: 'finishing', ratio: 1 });
      this.selector.record(`render:${strategy.videoMode}`, performance.now() - started);

      return {
        blob,
        fileName: destination.fileName,
        savedToDisk: Boolean(destination.handle),
        outputDuration,
        removedDuration: analysis.removedDuration,
        cutCount: analysis.silenceRanges.length,
        strategy
      };
    } catch (error) {
      // The raw failure is logged before it is turned into something readable:
      // the reader gets the friendly version, the diagnostic trail keeps the
      // one that says which API actually refused.
      silenceLog.error('render', 'failed', {
        outputState: output.state,
        finalized,
        ...describeError(error)
      });

      // Canceling closes the writer, so a partial file is left where the reader
      // chose to save it. Nothing here can delete it, so the message says so.
      if (!finalized) await output.cancel().catch(() => undefined);
      throw this.describe(error, Boolean(destination.handle) && !finalized);
    } finally {
      input.dispose();
    }
  }

  // ------------------------------------------------------------- pipelines

  /**
   * Copies both tracks packet for packet.
   *
   * When nothing is being removed there is no reason to decode anything: the
   * encoded packets are written straight through, which is faster than any
   * hardware encoder and costs nothing in quality.
   */
  private async copyStreams(
    library: MediabunnyLib,
    output: Output<OutputFormat, Target>,
    videoTrack: Awaited<ReturnType<import('mediabunny').Input['getPrimaryVideoTrack']>>,
    audioTrack: NonNullable<Awaited<ReturnType<import('mediabunny').Input['getPrimaryAudioTrack']>>>,
    report: (stage: RenderStage, seconds: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    const audioCodec = await audioTrack.getCodec();
    if (!audioCodec) throw new MediaToolError('The audio codec of this file could not be identified.');

    const audioSource = new library.EncodedAudioPacketSource(audioCodec);
    output.addAudioTrack(audioSource);

    let videoSource: import('mediabunny').EncodedVideoPacketSource | null = null;
    let videoCodec: import('mediabunny').VideoCodec | null = null;
    if (videoTrack) {
      videoCodec = await videoTrack.getCodec();
      if (videoCodec) {
        videoSource = new library.EncodedVideoPacketSource(videoCodec);
        output.addVideoTrack(videoSource);
      }
    }

    await output.start();

    if (videoTrack && videoSource) {
      const decoderConfig = await videoTrack.getDecoderConfig();
      const sink = new library.EncodedPacketSink(videoTrack);
      let first = true;
      for await (const packet of sink.packets()) {
        if (signal.aborted) throw new OperationCanceledError();
        await videoSource.add(packet, first && decoderConfig ? { decoderConfig } : undefined);
        first = false;
        report('cutting', packet.timestamp);
      }
    }

    const audioConfig = await audioTrack.getDecoderConfig();
    const audioSink = new library.EncodedPacketSink(audioTrack);
    let firstAudio = true;
    for await (const packet of audioSink.packets()) {
      if (signal.aborted) throw new OperationCanceledError();
      await audioSource.add(packet, firstAudio && audioConfig ? { decoderConfig: audioConfig } : undefined);
      firstAudio = false;
      if (!videoTrack) report('cutting', packet.timestamp);
    }
  }

  /**
   * Decodes only the kept ranges and re-encodes them back to back.
   *
   * Each range is shifted by the total silence removed before it, so the output
   * timeline is continuous and audio stays locked to picture: both tracks apply
   * the same shift, derived from the same list of ranges.
   */
  private async encodeRanges(
    library: MediabunnyLib,
    output: Output<OutputFormat, Target>,
    videoTrack: Awaited<ReturnType<import('mediabunny').Input['getPrimaryVideoTrack']>>,
    audioTrack: NonNullable<Awaited<ReturnType<import('mediabunny').Input['getPrimaryAudioTrack']>>>,
    keepRanges: readonly TimeRange[],
    settings: SilenceSettings,
    strategy: ProcessingStrategy,
    info: MediaInfo,
    zooms: readonly ZoomSegment[],
    report: (stage: RenderStage, seconds: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    const sampleRate = await audioTrack.getSampleRate();

    // Encoders reject odd dimensions, so the canvas the zoom draws on has to
    // agree with what the encoder will accept before the first frame is drawn.
    const frameWidth = Math.max(2, Math.round((info.width ?? 0) / 2) * 2);
    const frameHeight = Math.max(2, Math.round((info.height ?? 0) / 2) * 2);
    const zoomActive = zooms.length > 0 && frameWidth > 2 && frameHeight > 2;

    const audioSource = new library.AudioSampleSource({
      codec: strategy.audioCodec as import('mediabunny').AudioCodec,
      quality: new library.Quality('high')
    });
    output.addAudioTrack(audioSource);

    let videoSource: import('mediabunny').VideoSampleSource | null = null;
    if (videoTrack && strategy.videoCodec) {
      videoSource = new library.VideoSampleSource({
        codec: strategy.videoCodec as import('mediabunny').VideoCodec,
        quality: new library.Quality('high'),
        // Hardware is asked for, never assumed: the browser may serve the
        // request from a media block, a GPU or software, and does not say which.
        hardwareAcceleration:
          strategy.videoMode === 'webcodecs-hardware-preferred' ? 'prefer-hardware' : 'no-preference',
        // Each kept range starts a new key frame anyway; two seconds keeps
        // seeking usable in the result without inflating it.
        keyFrameInterval: 2,
        sizeChangeBehavior: 'contain',
        // `fit` is deliberately absent: Mediabunny refuses it alongside a
        // `sizeChangeBehavior` of `'contain'`, which already decides the
        // fitting. The processor draws at the frame's own size anyway, so
        // there is nothing left for a second fit to do.
        ...(zoomActive
          ? { transform: { process: this.zoomProcessor(zooms, frameWidth, frameHeight) } }
          : {})
      });
      output.addVideoTrack(videoSource);
    }

    await output.start();
    // Deliberately not `getMimeType()`: it only resolves once every track's
    // codec string is known, which for a fresh output means after the first
    // packet has been encoded — awaiting it here would deadlock the render.
    silenceLog.info('render', 'output started', {
      tracks: output.tracks.length,
      trackTypes: output.tracks.map((track) => track.type)
    });

    const videoSink =
      videoTrack && videoSource
        ? new library.VideoSampleSink(videoTrack, {
            hardwareAcceleration:
              strategy.videoMode === 'webcodecs-hardware-preferred' ? 'prefer-hardware' : 'no-preference'
          })
        : null;
    const audioSink = new library.AudioSampleSink(audioTrack);

    let outputCursor = 0;
    let totalVideoFrames = 0;
    let totalAudioSamples = 0;

    // The last timestamp written to each track, in output time. Nothing may
    // ever be written at or before it: a muxer stores timestamps unsigned, so a
    // single negative value does not fail loudly — it wraps to an enormous
    // number and every later frame then looks like it goes backwards.
    let lastVideoTimestamp = -Infinity;
    let lastAudioTimestamp = -Infinity;

    for (const [index, range] of keepRanges.entries()) {
      if (signal.aborted) throw new OperationCanceledError();
      const shift = range.start - outputCursor;
      const rangeStartedAt = performance.now();
      let videoFrames = 0;
      let audioSamples = 0;
      let droppedVideoFrames = 0;
      let droppedAudioSamples = 0;

      if (videoSink && videoSource) {
        for await (const sample of videoSink.samples(range.start, range.end)) {
          // A decoded frame holds a real GPU or system buffer, so it is closed
          // in a `finally`: an encoder that rejects mid-file must not leave
          // frames alive until the garbage collector notices them.
          try {
            if (signal.aborted) throw new OperationCanceledError();

            // `samples(start, end)` deliberately yields the frame that is on
            // screen at `start`, which usually began slightly earlier. Shifting
            // it like the rest would place it before the output's own start, so
            // it is pinned to the start instead — it is the correct picture for
            // that instant, it just begins there now.
            const timestamp = Math.max(sample.timestamp - shift, outputCursor, 0);

            if (timestamp <= lastVideoTimestamp) {
              // A second pre-roll frame would land on the same instant; the
              // later one carries the same picture, so it is dropped.
              droppedVideoFrames++;
              continue;
            }

            sample.setTimestamp(timestamp);
            await videoSource.add(sample);
            lastVideoTimestamp = timestamp;
            videoFrames++;
            report('encoding', timestamp);
          } finally {
            sample.close();
          }
        }
      }

      for await (const sample of audioSink.samples(range.start, range.end)) {
        let piece: AudioSample | null = null;
        let shaped: AudioSample | null = null;

        try {
          if (signal.aborted) throw new OperationCanceledError();

          piece = this.trimToRange(sample, range, sampleRate);
          if (!piece) continue;

          shaped = this.applyCrossfade(library, piece, range, settings, sampleRate, keepRanges);

          // Trimming rounds to whole frames, so the clipped sample can begin a
          // fraction before the range does. The same clamp applies for the same
          // reason as above.
          const timestamp = Math.max(shaped.timestamp - shift, outputCursor, 0);
          if (timestamp < lastAudioTimestamp) {
            droppedAudioSamples++;
            continue;
          }

          shaped.setTimestamp(timestamp);
          await audioSource.add(shaped);
          lastAudioTimestamp = timestamp;
          audioSamples++;

          if (!videoSink) report('encoding', timestamp);
        } finally {
          // `trim` and the crossfade may each return the same instance they
          // were given, so identity decides what still has to be released.
          if (shaped && shaped !== piece) shaped.close();
          if (piece && piece !== sample) piece.close();
          sample.close();
        }
      }

      outputCursor += range.end - range.start;
      totalVideoFrames += videoFrames;
      totalAudioSamples += audioSamples;

      // Per-range counters are what reveal a decoder that quietly stops partway
      // through: a range that yields no frames at all is the shape of that bug.
      silenceLog.info('render', `range ${index + 1}/${keepRanges.length}`, {
        start: Math.round(range.start * 100) / 100,
        end: Math.round(range.end * 100) / 100,
        videoFrames,
        audioSamples,
        droppedVideoFrames,
        droppedAudioSamples,
        ms: Math.round(performance.now() - rangeStartedAt)
      });

      if (videoSink && videoFrames === 0) {
        silenceLog.warn('render', `range ${index + 1} produced no video frames`, {
          start: range.start,
          end: range.end
        });
      }
    }

    silenceLog.info('render', 'all ranges encoded', { totalVideoFrames, totalAudioSamples });
  }

  // ------------------------------------------------------------------ zoom

  /**
   * Redraws a frame closer in while a planned zoom is on screen.
   *
   * Frames outside every zoom are returned untouched, which is the whole point:
   * an edit with four zooms in it must not pay to send every frame of the
   * recording through a canvas. The canvas itself is created once and reused,
   * since allocating one per frame is what turns a smooth encode into a
   * stutter.
   *
   * The timestamp read here is already in output time — Mediabunny calls this
   * after its own transformations, and the caller has shifted every sample onto
   * the cut timeline before adding it — which is the same clock the plan was
   * expressed in.
   */
  private zoomProcessor(
    zooms: readonly ZoomSegment[],
    width: number,
    height: number
  ): (sample: import('mediabunny').VideoSample) => import('mediabunny').VideoSample | CanvasImageSource {
    let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

    return (sample) => {
      const scale = zoomScaleAt(zooms, sample.timestamp);
      if (scale <= 1.0001) return sample;

      if (!canvas || !context) {
        canvas = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement('canvas'), { width, height });
        context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
        if (!context) throw new MediaToolError('This browser could not draw the automatic zoom.');
      }

      // Cleared to black rather than to transparent: a zoom of an odd aspect
      // ratio still letterboxes, and transparent bars would encode as black in
      // some formats and as nothing at all in the ones that carry alpha.
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#000000';
      context.fillRect(0, 0, width, height);

      drawZoomed(
        (x, y, w, h) =>
          sample.draw(context as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, x, y, w, h),
        sample.displayWidth,
        sample.displayHeight,
        width,
        height,
        scale
      );

      return canvas;
    };
  }

  // --------------------------------------------------------------- helpers

  /**
   * Clips a decoded audio sample to the kept range.
   *
   * A decoded packet is around twenty milliseconds long and rarely lines up
   * with a cut point. Without this, every cut would be off by up to a packet
   * and the two tracks would drift apart over a long recording.
   */
  private trimToRange(sample: AudioSample, range: TimeRange, sampleRate: number): AudioSample | null {
    const frames = sample.numberOfFrames;
    const start = Math.max(0, Math.round((range.start - sample.timestamp) * sampleRate));
    const end = Math.min(frames, Math.round((range.end - sample.timestamp) * sampleRate));

    if (end <= start) return null;
    if (start === 0 && end === frames) return sample;
    return sample.trim(start, end);
  }

  /**
   * Fades the first and last milliseconds of each kept range.
   *
   * Cutting at an arbitrary point leaves a step in the waveform, and a step is
   * a click. A few milliseconds of linear fade removes it without being
   * audible as a fade. The opening of the file and its very end are left alone —
   * there is no discontinuity there to hide.
   */
  private applyCrossfade(
    library: MediabunnyLib,
    sample: AudioSample,
    range: TimeRange,
    settings: SilenceSettings,
    sampleRate: number,
    keepRanges: readonly TimeRange[]
  ): AudioSample {
    const fade = settings.crossfadeMs / 1000;
    if (fade <= 0) return sample;

    const isFirst = range === keepRanges[0];
    const isLast = range === keepRanges[keepRanges.length - 1];

    const fadeInEnd = range.start + fade;
    const fadeOutStart = range.end - fade;
    const sampleEnd = sample.timestamp + sample.duration;

    const needsFadeIn = !isFirst && sample.timestamp < fadeInEnd;
    const needsFadeOut = !isLast && sampleEnd > fadeOutStart;
    if (!needsFadeIn && !needsFadeOut) return sample;

    const frames = sample.numberOfFrames;
    const channels = sample.numberOfChannels;
    const data = new Float32Array(frames * channels);

    for (let c = 0; c < channels; c++) {
      const plane = new Float32Array(sample.allocationSize({ planeIndex: c, format: 'f32-planar' }) / 4);
      sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      data.set(plane.subarray(0, frames), c * frames);
    }

    for (let i = 0; i < frames; i++) {
      const time = sample.timestamp + i / sampleRate;
      let gain = 1;
      if (needsFadeIn && time < fadeInEnd) gain = Math.min(gain, (time - range.start) / fade);
      if (needsFadeOut && time > fadeOutStart) gain = Math.min(gain, (range.end - time) / fade);
      if (gain >= 1) continue;

      const clamped = Math.max(0, gain);
      for (let c = 0; c < channels; c++) data[c * frames + i] *= clamped;
    }

    return new library.AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: channels,
      sampleRate: sample.sampleRate,
      timestamp: sample.timestamp
    });
  }

  /** Throttled progress, expressed as a fraction of the output duration. */
  private reporter(
    onProgress: (report: ProgressReport<RenderStage>) => void,
    outputDuration: number
  ): (stage: RenderStage, seconds: number) => void {
    let last = 0;
    return (stage, seconds) => {
      const now = performance.now();
      if (now - last < 200) return;
      last = now;
      onProgress({ stage, ratio: outputDuration > 0 ? Math.min(1, seconds / outputDuration) : null });
    };
  }

  private formatFor(library: MediabunnyLib, strategy: ProcessingStrategy): OutputFormat {
    switch (strategy.container) {
      case 'webm':
        return new library.WebMOutputFormat();
      case 'wav':
        return new library.WavOutputFormat();
      case 'ogg':
        return new library.OggOutputFormat();
      default:
        // `fastStart` is deliberately left unset. Forcing `'in-memory'` would
        // hold every media chunk in RAM until finalization, which is exactly
        // what streaming the output to disk exists to avoid; Mediabunny picks
        // the right placement from the target type on its own.
        return new library.Mp4OutputFormat();
    }
  }

  /**
   * Wraps the muxed bytes for download.
   *
   * Only the in-memory path needs this. A stream target has already written
   * every byte to the file the reader chose, and closed it — calling `close()`
   * again here would throw on an already-closed stream and turn a finished
   * export into a reported failure.
   */
  private takeBuffer(output: Output<OutputFormat, Target>): Blob {
    const buffer = (output.target as import('mediabunny').BufferTarget).buffer;
    if (!buffer) throw new MediaToolError('The output file could not be assembled.');
    return new Blob([buffer], { type: output.format.mimeType });
  }

  private extensionFor(strategy: ProcessingStrategy): string {
    if (strategy.container === 'mp4') return strategy.videoCodec ? 'mp4' : 'm4a';
    return strategy.container;
  }

  private mimeFor(strategy: ProcessingStrategy): string {
    switch (strategy.container) {
      case 'webm':
        return 'video/webm';
      case 'wav':
        return 'audio/wav';
      case 'ogg':
        return 'audio/ogg';
      default:
        return strategy.videoCodec ? 'video/mp4' : 'audio/mp4';
    }
  }

  /** `interview.mp4` becomes `interview-silence-cut.mp4`. */
  private outputName(original: string, strategy: ProcessingStrategy): string {
    const base = original.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || 'media';
    return `${base}-silence-cut.${this.extensionFor(strategy)}`;
  }

  /**
   * Turns a low-level failure into something worth reading.
   *
   * "The operation failed" tells nobody anything; whether the encoder was
   * refused, the disk filled up or the codec is simply absent decides what the
   * reader should try next.
   */
  private describe(error: unknown, partialFileOnDisk = false): Error {
    if (error instanceof OperationCanceledError || error instanceof MediaToolError) return error;

    const message = String((error as Error)?.message ?? error ?? '').toLowerCase();
    const partial = partialFileOnDisk
      ? ' The file at the location you chose is incomplete and can be deleted.'
      : '';

    if (message.includes('writable') || message.includes('stream') || message.includes('not allowed')) {
      return new MediaToolError(
        'The output file could not be written.' + partial,
        'Check that the destination is still available and that the browser still has permission to write there.'
      );
    }

    if (message.includes('quota') || message.includes('no space')) {
      return new MediaToolError(
        'There is not enough free space to write the output file.',
        'Free some disk space, or export a shorter selection.' + partial
      );
    }
    if (message.includes('encod')) {
      return new MediaToolError(
        'Your browser refused to encode this media.',
        'Try the Compatibility option under Processing details, or use a current desktop browser.'
      );
    }
    if (message.includes('decod') || message.includes('codec')) {
      return new MediaToolError(
        'Your browser cannot decode this codec.',
        'Try MP4/H.264/AAC, WebM, MP3 or WAV.'
      );
    }
    if (message.includes('memory') || message.includes('allocation')) {
      return new MediaToolError(
        'The browser ran out of memory while rendering.',
        'Close other tabs and try again, or process a shorter file.'
      );
    }

    return new MediaToolError('The file could not be generated.', 'Check that the media is valid and try again.');
  }
}
