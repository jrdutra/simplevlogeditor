import { Injectable, inject } from '@angular/core';

import { GpuWindowReducer } from './gpu-window-reducer';
import { MediaCapabilitiesService } from './media-capabilities.service';
import { ProcessingEngineSelectorService } from './processing-engine-selector.service';
import { describeError, silenceLog } from './silence-cutter-log';
import { detectSilence, totalDuration } from './silence-detector';
import { loadMediabunny } from './mediabunny-loader';
import { CpuWindowReducer, WindowReduction } from './window-reducer';
import type { AnalysisWorkerRequest, AnalysisWorkerResult } from './audio-analysis.protocol';
import {
  AnalysisStage,
  AudioAnalysisMode,
  MediaInfo,
  MediaToolError,
  OperationCanceledError,
  ProcessingStrategy,
  ProgressReport,
  SilenceAnalysis,
  SilenceSettings,
  WaveformData
} from './silence-cutter.models';

/**
 * Horizontal resolution of the stored waveform.
 *
 * One bucket per horizontal pixel of a wide display, with headroom for a
 * couple of zoom steps. Storing anything close to per-sample detail would mean
 * holding hundreds of megabytes to draw a few thousand pixels.
 */
const WAVEFORM_BUCKETS = 3000;

/**
 * Frames buffered before a chunk is handed to the reducer.
 *
 * Decoders emit small packets — an AAC frame is 1024 samples — and posting each
 * one to a worker would mean hundreds of thousands of messages for a long
 * recording. Roughly two and a half seconds per message keeps both the message
 * count and the buffer size small.
 */
const CHUNK_FRAMES = 1 << 17;

/**
 * Upper bound on the number of analysis windows.
 *
 * A five-millisecond window over a ten-hour recording is seven million windows;
 * past this point the accumulators themselves start to matter, so the window is
 * widened and the reader is told the effective value.
 */
const MAX_WINDOWS = 8_000_000;

/** Channels analysed. Beyond this, the extra channels are ignored. */
const MAX_ANALYSIS_CHANNELS = 8;

export interface AnalysisOptions {
  settings: SilenceSettings;
  strategy: ProcessingStrategy;
  signal: AbortSignal;
  onProgress: (report: ProgressReport<AnalysisStage>) => void;
}

/**
 * Turns a media file into a waveform and a list of ranges to remove.
 *
 * Decoding streams: samples are pulled from the file a few at a time, folded
 * into per-window statistics, and dropped. At no point does the whole decoded
 * signal exist — which is what allows a multi-gigabyte recording to be analysed
 * in a tab that has a few hundred megabytes to spare.
 *
 * Which engine performs the fold is decided by
 * {@link ProcessingEngineSelectorService}; this service only knows that it has
 * something to push chunks into. If the GPU path fails at any point it is torn
 * down and the CPU worker takes over from the beginning, because a partially
 * reduced signal is worse than a slower one.
 */
@Injectable({ providedIn: 'root' })
export class AudioAnalysisService {
  private readonly capabilities = inject(MediaCapabilitiesService);
  private readonly selector = inject(ProcessingEngineSelectorService);

  async analyze(file: File, info: MediaInfo, options: AnalysisOptions): Promise<SilenceAnalysis> {
    if (!info.hasAudioTrack) {
      throw new MediaToolError(
        'No audio track was found in this file.',
        'Silence detection requires an audio track.'
      );
    }

    const started = performance.now();
    const preferred = options.strategy.audioAnalysisMode;

    try {
      const analysis = await this.run(file, info, options, preferred);
      this.selector.record(`analysis:${preferred}`, performance.now() - started);
      return analysis;
    } catch (error) {
      if (error instanceof OperationCanceledError || error instanceof MediaToolError) throw error;
      if (preferred !== 'webgpu') throw error;

      // The GPU path is a shortcut, never a requirement: anything unexpected
      // there is answered by redoing the work on the CPU rather than by
      // failing in front of the reader.
      silenceLog.warn('analysis', 'GPU analyser failed, redoing the pass on the CPU', describeError(error));
      return this.run(file, info, options, 'worker');
    }
  }

  private async run(
    file: File,
    info: MediaInfo,
    options: AnalysisOptions,
    mode: AudioAnalysisMode
  ): Promise<SilenceAnalysis> {
    const { Input, BlobSource, ALL_FORMATS, AudioSampleSink } = await loadMediabunny();
    const { settings, signal, onProgress } = options;

    onProgress({ stage: 'reading', ratio: null });

    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const engine = await this.createEngine(mode, info, settings);

    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) {
        throw new MediaToolError(
          'No audio track was found in this file.',
          'Silence detection requires an audio track.'
        );
      }

      const sampleRate = await track.getSampleRate();
      const channelCount = Math.min(await track.getNumberOfChannels(), MAX_ANALYSIS_CHANNELS);
      const duration = info.durationSeconds;

      const { samplesPerWindow, windowCount } = this.windowPlan(sampleRate, duration, settings);
      silenceLog.info('analysis', 'window plan', {
        engine: mode,
        sampleRate,
        channelCount,
        duration,
        requestedWindowMs: settings.detectionWindowMs,
        effectiveWindowMs: Math.round((samplesPerWindow / sampleRate) * 100000) / 100,
        windowCount
      });
      await engine.initialise(channelCount, samplesPerWindow, windowCount);

      const sink = new AudioSampleSink(track);
      const buffers = Array.from({ length: channelCount }, () => new Float32Array(CHUNK_FRAMES));
      let buffered = 0;
      let bufferStartFrame = 0;
      let lastReport = 0;
      let decodedSamples = 0;
      let decodedFrames = 0;
      const decodeStartedAt = performance.now();

      onProgress({ stage: 'decoding', ratio: 0 });

      for await (const sample of sink.samples()) {
        if (signal.aborted) throw new OperationCanceledError();

        const frames = sample.numberOfFrames;
        const sampleStartFrame = Math.round(sample.timestamp * sampleRate);
        decodedSamples++;
        decodedFrames += frames;

        let consumed = 0;
        while (consumed < frames) {
          if (buffered === 0) bufferStartFrame = sampleStartFrame + consumed;

          const take = Math.min(CHUNK_FRAMES - buffered, frames - consumed);
          this.copyPlanes(sample, buffers, channelCount, consumed, take, buffered);
          buffered += take;
          consumed += take;

          if (buffered === CHUNK_FRAMES) {
            await engine.push(bufferStartFrame, buffers, buffered);
            buffered = 0;
          }
        }

        // Decoded audio is released the moment it has been folded in; holding
        // even a few seconds of it would defeat the streaming design.
        sample.close();

        const now = performance.now();
        if (now - lastReport > 200) {
          lastReport = now;
          const ratio = duration > 0 ? Math.min(1, sample.timestamp / duration) : null;
          onProgress({ stage: 'decoding', ratio });
        }
      }

      if (buffered > 0) await engine.push(bufferStartFrame, buffers, buffered);
      if (signal.aborted) throw new OperationCanceledError();

      silenceLog.timing('analysis', 'decoded', decodeStartedAt, {
        samples: decodedSamples,
        frames: decodedFrames,
        expectedFrames: Math.round(duration * sampleRate)
      });

      onProgress({ stage: 'waveform', ratio: null });
      const reduction = await engine.finish();

      onProgress({ stage: 'detecting', ratio: null });
      const windowSeconds = samplesPerWindow / sampleRate;
      // Named rather than inlined, because it is returned as well as detected
      // from: keeping it is what lets the reader move the threshold afterwards
      // without the file being decoded a second time.
      const stats = { rms: reduction.rms, channelCount, windowCount, windowSeconds, duration };
      const { silenceRanges, keepRanges, peakDb } = detectSilence(stats, settings);

      onProgress({ stage: 'preparing', ratio: null });
      const waveform = this.buildWaveform(reduction, windowCount, channelCount, duration);
      const removedDuration = totalDuration(silenceRanges);

      silenceLog.info('analysis', 'detection finished', {
        engine: mode,
        thresholdDb: settings.thresholdDb,
        peakDb: Math.round(peakDb * 10) / 10,
        cuts: silenceRanges.length,
        keepRanges: keepRanges.length,
        removedDuration: Math.round(removedDuration * 100) / 100,
        outputDuration: Math.round((duration - removedDuration) * 100) / 100
      });

      return {
        silenceRanges,
        keepRanges,
        originalDuration: duration,
        removedDuration,
        outputDuration: Math.max(0, duration - removedDuration),
        waveform,
        peakDb,
        engine: mode,
        stats
      };
    } finally {
      engine.destroy();
      input.dispose();
    }
  }

  /**
   * Window size in samples, and how many of them cover the media.
   *
   * The reader's millisecond value is honoured unless it would produce so many
   * windows that the accumulators become the problem the streaming design was
   * meant to avoid; in that case the window grows just enough to fit.
   */
  private windowPlan(
    sampleRate: number,
    duration: number,
    settings: SilenceSettings
  ): { samplesPerWindow: number; windowCount: number } {
    const totalFrames = Math.max(1, Math.round(duration * sampleRate));
    let samplesPerWindow = Math.max(1, Math.round((settings.detectionWindowMs / 1000) * sampleRate));
    let windowCount = Math.ceil(totalFrames / samplesPerWindow);

    if (windowCount > MAX_WINDOWS) {
      samplesPerWindow = Math.ceil(totalFrames / MAX_WINDOWS);
      windowCount = Math.ceil(totalFrames / samplesPerWindow);
    }

    return { samplesPerWindow, windowCount };
  }

  /** Copies one slice of a decoded sample into the reusable planar buffers. */
  private copyPlanes(
    sample: { allocationSize(options: { planeIndex: number; format: 'f32-planar' }): number; copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void; numberOfFrames: number },
    buffers: Float32Array[],
    channelCount: number,
    sourceOffset: number,
    length: number,
    destinationOffset: number
  ): void {
    for (let c = 0; c < channelCount; c++) {
      const plane = this.planeCache(sample, c);
      buffers[c].set(plane.subarray(sourceOffset, sourceOffset + length), destinationOffset);
    }
  }

  /**
   * One decoded sample's channel data, planar.
   *
   * The plane is extracted once per channel per sample and cached on the sample
   * itself for the duration of the copy loop, so splitting a sample across two
   * buffered chunks does not decode or copy it twice.
   */
  private planeCache(
    sample: { allocationSize(options: { planeIndex: number; format: 'f32-planar' }): number; copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void },
    channel: number
  ): Float32Array {
    const holder = sample as unknown as { __planes?: Float32Array[] };
    holder.__planes ??= [];

    const cached = holder.__planes[channel];
    if (cached) return cached;

    const bytes = sample.allocationSize({ planeIndex: channel, format: 'f32-planar' });
    const plane = new Float32Array(bytes / 4);
    sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
    holder.__planes[channel] = plane;
    return plane;
  }

  /**
   * Collapses the per-window statistics into the waveform the canvas draws.
   *
   * Buckets are built from windows rather than from samples, which is why both
   * analysis engines only ever have to produce per-window numbers.
   */
  private buildWaveform(
    reduction: WindowReduction,
    windowCount: number,
    channelCount: number,
    duration: number
  ): WaveformData {
    const buckets = Math.max(1, Math.min(WAVEFORM_BUCKETS, windowCount));
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const rms = new Float32Array(buckets);
    const windowsPerBucket = windowCount / buckets;

    for (let b = 0; b < buckets; b++) {
      const from = Math.floor(b * windowsPerBucket);
      const to = Math.max(from + 1, Math.floor((b + 1) * windowsPerBucket));

      let low = 0;
      let high = 0;
      let sumSquares = 0;
      let counted = 0;

      for (let w = from; w < to && w < windowCount; w++) {
        if (reduction.min[w] < low) low = reduction.min[w];
        if (reduction.max[w] > high) high = reduction.max[w];
        for (let c = 0; c < channelCount; c++) {
          const value = reduction.rms[w * channelCount + c];
          sumSquares += value * value;
          counted++;
        }
      }

      min[b] = low;
      max[b] = high;
      rms[b] = counted ? Math.sqrt(sumSquares / counted) : 0;
    }

    return { min, max, rms, secondsPerBucket: duration / buckets, duration };
  }

  /** Builds the reducer for the chosen engine, all behind one small interface. */
  private async createEngine(
    mode: AudioAnalysisMode,
    info: MediaInfo,
    settings: SilenceSettings
  ): Promise<AnalysisEngine> {
    if (mode === 'webgpu') {
      const device = await this.capabilities.requestGpuDevice();
      if (device) return new GpuAnalysisEngine(device);
      silenceLog.warn('analysis', 'GPU engine requested but no device was available');
    }

    if (mode !== 'inline' && typeof Worker !== 'undefined') {
      try {
        return new WorkerAnalysisEngine();
      } catch (error) {
        // Some environments expose Worker but refuse module workers.
        silenceLog.warn('analysis', 'module worker could not be started', describeError(error));
      }
    }

    silenceLog.warn('analysis', 'falling back to the main-thread analyser');

    void info;
    void settings;
    return new InlineAnalysisEngine();
  }
}

/** What the analysis loop needs from a reducer, whichever engine backs it. */
interface AnalysisEngine {
  initialise(channelCount: number, samplesPerWindow: number, windowCount: number): Promise<void>;
  /** `length` may be shorter than the buffers, which are reused between chunks. */
  push(startFrame: number, buffers: Float32Array[], length: number): Promise<void>;
  finish(): Promise<WindowReduction>;
  destroy(): void;
}

/** Folds chunks in a module worker, transferring each chunk instead of copying it. */
class WorkerAnalysisEngine implements AnalysisEngine {
  private readonly worker = new Worker(new URL('./audio-analysis.worker', import.meta.url), { type: 'module' });

  async initialise(channelCount: number, samplesPerWindow: number, windowCount: number): Promise<void> {
    this.post({ type: 'init', channelCount, samplesPerWindow, windowCount });
  }

  async push(startFrame: number, buffers: Float32Array[], length: number): Promise<void> {
    // The worker takes ownership of what it receives, so each chunk is a fresh
    // copy of the used part of the reusable buffers rather than the buffers
    // themselves.
    const channels = buffers.map((buffer) => buffer.slice(0, length));
    this.worker.postMessage(
      { type: 'chunk', startFrame, channels } satisfies AnalysisWorkerRequest,
      channels.map((channel) => channel.buffer)
    );
  }

  finish(): Promise<WindowReduction> {
    return new Promise<WindowReduction>((resolve, reject) => {
      this.worker.addEventListener(
        'message',
        ({ data }: MessageEvent<AnalysisWorkerResult>) => resolve({ rms: data.rms, min: data.min, max: data.max }),
        { once: true }
      );
      this.worker.addEventListener('error', () => reject(new Error('The analysis worker stopped unexpectedly.')), { once: true });
      this.post({ type: 'finish' });
    });
  }

  destroy(): void {
    this.worker.terminate();
  }

  private post(message: AnalysisWorkerRequest): void {
    this.worker.postMessage(message);
  }
}

/** Folds chunks with compute shaders, releasing every GPU object afterwards. */
class GpuAnalysisEngine implements AnalysisEngine {
  private reducer: GpuWindowReducer | null = null;

  constructor(private readonly device: import('./media-capabilities.service').MinimalGpuDevice) {}

  async initialise(channelCount: number, samplesPerWindow: number, windowCount: number): Promise<void> {
    this.reducer = new GpuWindowReducer(this.device, channelCount, samplesPerWindow, windowCount);
    await this.reducer.initialise();
  }

  async push(_startFrame: number, buffers: Float32Array[], length: number): Promise<void> {
    await this.reducer?.push(buffers.map((buffer) => buffer.subarray(0, length)));
  }

  async finish(): Promise<WindowReduction> {
    if (!this.reducer) throw new Error('The GPU analyser was not initialised.');
    return this.reducer.finish();
  }

  destroy(): void {
    this.reducer?.destroy();
    this.reducer = null;
    try {
      this.device.destroy();
    } catch {
      /* Already lost. */
    }
  }
}

/** Last resort: the same arithmetic, on the main thread, in small slices. */
class InlineAnalysisEngine implements AnalysisEngine {
  private reducer: CpuWindowReducer | null = null;

  async initialise(channelCount: number, samplesPerWindow: number, windowCount: number): Promise<void> {
    this.reducer = new CpuWindowReducer(channelCount, samplesPerWindow, windowCount);
  }

  async push(startFrame: number, buffers: Float32Array[], length: number): Promise<void> {
    this.reducer?.push(startFrame, buffers.map((buffer) => buffer.subarray(0, length)));
    // Yield to the event loop so the progress bar and the cancel button keep
    // responding even without a worker.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  async finish(): Promise<WindowReduction> {
    if (!this.reducer) throw new Error('The analyser was not initialised.');
    return this.reducer.finish();
  }

  destroy(): void {
    this.reducer = null;
  }
}
