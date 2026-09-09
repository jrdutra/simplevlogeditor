import { Injectable, inject } from '@angular/core';

import { MediaCapabilitiesService } from './media-capabilities.service';
import { silenceLog } from './silence-cutter-log';
import { MediaInfo, OptimizationPreference, ProcessingStrategy } from './silence-cutter.models';

/**
 * Below this duration, moving audio to the GPU costs more than it saves.
 *
 * A compute pass has to upload the samples, dispatch, and read the result back.
 * For a short clip that round trip dwarfs the arithmetic itself, and a worker
 * with a typed array wins outright. The number is a starting point, not a
 * measurement of any particular machine — {@link ProcessingEngineSelectorService}
 * treats it as a hint and the analyser still falls back at runtime if the GPU
 * path fails.
 */
export const GPU_AUDIO_ANALYSIS_MIN_DURATION = 90;

/** Container the output is written into, and the codecs it will carry. */
export interface OutputPlan {
  /** Identifier consumed by the render service to build the Mediabunny format. */
  container: 'mp4' | 'webm' | 'wav' | 'ogg';
  extension: string;
  videoCodec: string | null;
  audioCodec: string;
}

/**
 * Chooses the cheapest pipeline that can actually do the job.
 *
 * The order is deliberate and follows one rule: avoid work before accelerating
 * work. Copying an encoded stream beats re-encoding it on any hardware, so that
 * is checked first; only when the cut forces a re-encode does the hardware
 * question arise at all. The UI never sees any of this — it receives a
 * {@link ProcessingStrategy} and a few sentences to show under "Processing
 * details".
 */
@Injectable({ providedIn: 'root' })
export class ProcessingEngineSelectorService {
  private readonly capabilities = inject(MediaCapabilitiesService);

  /** Timings collected during the session. Numbers only — never media. */
  private readonly metrics = new Map<string, number[]>();

  async select(
    info: MediaInfo,
    preference: OptimizationPreference,
    options: { hasCuts: boolean }
  ): Promise<ProcessingStrategy> {
    const capabilities = await this.capabilities.detect();
    const notes: string[] = [];

    const plan = await this.planOutput(info, preference);

    // ---------------------------------------------------------------- video
    let videoMode: ProcessingStrategy['videoMode'] = 'none';
    let hardwarePreferred = false;

    if (info.kind === 'video' && info.width && info.height) {
      if (!options.hasCuts) {
        // Nothing to remove means nothing to re-encode: the encoded stream is
        // copied across untouched, which is both faster and lossless.
        videoMode = 'stream-copy';
        notes.push('No cut falls inside the video, so the encoded stream is copied without re-encoding.');
      } else if (preference === 'compatibility') {
        videoMode = 'webcodecs-software';
        notes.push('Compatibility mode: the encoder is configured without asking for hardware acceleration.');
      } else {
        const encode = await this.probeEncode(plan.videoCodec, info);
        const decode = await this.probeDecode(info);

        if (encode.supported && encode.hardwarePreferred) {
          videoMode = 'webcodecs-hardware-preferred';
          hardwarePreferred = true;
          notes.push('Hardware acceleration preferred for the selected video pipeline.');
        } else if (encode.supported) {
          videoMode = 'webcodecs-software';
          notes.push('This browser accepted the encoder without a hardware preference.');
        } else {
          videoMode = 'webcodecs-software';
          notes.push('No accelerated encoder configuration was accepted; falling back to a compatible one.');
        }

        if (!decode.supported) {
          notes.push('The decoder configuration could not be validated up front; it will be retried while rendering.');
        }
      }
    }

    // ------------------------------------------------------- audio analysis
    const gpuWorthIt =
      capabilities.webGpuAdapterAvailable &&
      (preference === 'prefer-hardware' || info.durationSeconds >= GPU_AUDIO_ANALYSIS_MIN_DURATION);

    let audioAnalysisMode: ProcessingStrategy['audioAnalysisMode'];
    if (preference !== 'compatibility' && gpuWorthIt) {
      audioAnalysisMode = 'webgpu';
      notes.push('Loudness statistics are reduced on the GPU in batches.');
    } else if (capabilities.webWorkers) {
      audioAnalysisMode = 'worker';
      notes.push(
        capabilities.webGpuAdapterAvailable
          ? 'The media is short enough that a worker beats the cost of moving data to the GPU.'
          : 'Loudness statistics are computed in a worker, off the interface thread.'
      );
    } else {
      audioAnalysisMode = 'inline';
      notes.push('Workers are unavailable, so analysis runs in small slices on the main thread.');
    }

    // ------------------------------------------------------------ waveform
    const waveformMode: ProcessingStrategy['waveformMode'] =
      typeof OffscreenCanvas !== 'undefined' ? 'accelerated-canvas' : 'canvas2d';

    if (!capabilities.secureContext) {
      notes.push('This page is not in a secure context, so some accelerated APIs are unavailable.');
    }

    const strategy: ProcessingStrategy = {
      videoMode,
      audioAnalysisMode,
      waveformMode,
      audioCodec: plan.audioCodec,
      videoCodec: info.kind === 'video' ? plan.videoCodec : null,
      container: plan.container,
      hardwareAccelerationPreferred: hardwarePreferred,
      notes
    };

    silenceLog.info('strategy', 'selected', { preference, hasCuts: options.hasCuts, ...strategy });
    return strategy;
  }

  /**
   * Asks whether this browser can encode the planned codec, hardware first.
   *
   * The check goes through Mediabunny rather than through a hand-built config,
   * because the codec here is a family name (`avc`) and `isConfigSupported`
   * needs a full codec string (`avc1.640028`). Passing the family name makes
   * every probe answer "unsupported", which quietly demotes a machine that can
   * in fact encode in hardware.
   */
  private async probeEncode(
    codec: string | null,
    info: MediaInfo
  ): Promise<{ supported: boolean; hardwarePreferred: boolean }> {
    if (!codec) return { supported: false, hardwarePreferred: false };

    const { canEncodeVideo } = await import('mediabunny');
    const width = info.width ?? 1280;
    const height = info.height ?? 720;

    return this.capabilities.probeAccelerated(
      `encode|${codec}|${width}x${height}`,
      (hardwareAcceleration) =>
        canEncodeVideo(codec as import('mediabunny').VideoCodec, { width, height, hardwareAcceleration })
    );
  }

  /** The decoder counterpart, probed with the track's real codec string. */
  private async probeDecode(info: MediaInfo): Promise<{ supported: boolean; hardwarePreferred: boolean }> {
    if (!info.videoCodecString || !info.width || !info.height) {
      return { supported: false, hardwarePreferred: false };
    }

    return this.capabilities.probeVideoDecode({
      codec: info.videoCodecString,
      width: info.width,
      height: info.height,
      framerate: info.frameRate ?? undefined
    });
  }

  /**
   * Picks the output container and codecs.
   *
   * The container of the input is kept whenever the browser can encode
   * something it accepts, so an MP4 stays an MP4. When nothing in the original
   * container can be encoded — an MP3, for instance, since no browser ships an
   * MP3 encoder — the audio falls back to uncompressed WAV rather than silently
   * changing the reader's file into a format they did not ask for without
   * saying so.
   */
  async planOutput(info: MediaInfo, preference: OptimizationPreference): Promise<OutputPlan> {
    const { getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } = await import('mediabunny');
    silenceLog.info('strategy', 'planning output', {
      kind: info.kind,
      container: info.containerName,
      preference
    });

    if (info.kind === 'video') {
      const webm = /matroska|webm/i.test(info.containerName);
      const videoCandidates = webm ? (['vp9', 'vp8', 'av1'] as const) : (['avc', 'hevc', 'av1'] as const);
      const audioCandidates = webm ? (['opus', 'vorbis'] as const) : (['aac', 'opus'] as const);

      const videoCodec = await getFirstEncodableVideoCodec([...videoCandidates], {
        width: info.width ?? 1280,
        height: info.height ?? 720
      });
      const audioCodec = await getFirstEncodableAudioCodec([...audioCandidates], {
        numberOfChannels: info.channelCount ?? 2,
        sampleRate: info.sampleRate ?? 48000
      });

      // Falling back to MP4/AVC keeps the file playable everywhere; if even
      // that is refused the render service reports it rather than guessing.
      return {
        container: webm ? 'webm' : 'mp4',
        extension: webm ? 'webm' : 'mp4',
        videoCodec: videoCodec ?? (webm ? 'vp9' : 'avc'),
        audioCodec: audioCodec ?? (webm ? 'opus' : 'aac')
      };
    }

    if (/wave|wav/i.test(info.containerName) || preference === 'compatibility') {
      return { container: 'wav', extension: 'wav', videoCodec: null, audioCodec: 'pcm-s16' };
    }

    if (/ogg/i.test(info.containerName)) {
      const codec = await getFirstEncodableAudioCodec(['opus', 'vorbis'], {
        numberOfChannels: info.channelCount ?? 2,
        sampleRate: info.sampleRate ?? 48000
      });
      if (codec) return { container: 'ogg', extension: 'ogg', videoCodec: null, audioCodec: codec };
    }

    if (/isobmff|mp4|mov|m4a|adts|aac/i.test(info.containerName)) {
      const codec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
        numberOfChannels: info.channelCount ?? 2,
        sampleRate: info.sampleRate ?? 48000
      });
      if (codec) return { container: 'mp4', extension: 'm4a', videoCodec: null, audioCodec: codec };
    }

    // MP3, FLAC and anything else the browser cannot re-encode: PCM in a WAV
    // container is always available and never loses a second generation.
    return { container: 'wav', extension: 'wav', videoCodec: null, audioCodec: 'pcm-s16' };
  }

  /**
   * Records how long a stage took, so a later session can compare engines.
   *
   * Only the label and the duration are stored, in memory, for the lifetime of
   * the page. No file name, no media, nothing that leaves the tab.
   */
  record(label: string, milliseconds: number): void {
    const samples = this.metrics.get(label) ?? [];
    samples.push(milliseconds);
    if (samples.length > 20) samples.shift();
    this.metrics.set(label, samples);
  }

  /** Median of the recorded timings for a stage, or null if never measured. */
  median(label: string): number | null {
    const samples = this.metrics.get(label);
    if (!samples?.length) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}
