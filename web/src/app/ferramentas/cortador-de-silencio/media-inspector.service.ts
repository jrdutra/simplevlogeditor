import { Injectable } from '@angular/core';

import { loadMediabunny } from './mediabunny-loader';
import { describeError, silenceLog } from './silence-cutter-log';
import { MediaInfo, MediaToolError } from './silence-cutter.models';

/**
 * Reads what a file actually is, from its bytes.
 *
 * Extensions lie and MIME types are guesses the operating system made; both are
 * routinely wrong for media that has been renamed, remuxed or downloaded. The
 * container here is identified by parsing the header, and every field the
 * interface later shows is one the parser genuinely resolved — anything that
 * could not be determined stays `null` and is simply not displayed, rather than
 * being filled with a plausible-looking default.
 *
 * Nothing is read into memory beyond the few kilobytes the parser needs: the
 * file is handed over as a `Blob` source that reads ranges on demand, so a
 * four-gigabyte recording is inspected as cheaply as a four-megabyte one.
 */
@Injectable({ providedIn: 'root' })
export class MediaInspectorService {
  async inspect(file: File): Promise<MediaInfo> {
    const library = await loadMediabunny();
    const { Input, BlobSource, ALL_FORMATS } = library;
    silenceLog.attachMediabunny(library);

    const startedAt = performance.now();
    silenceLog.info('inspect', 'opening file', {
      bytes: file.size,
      type: file.type || null,
      extension: file.name.replace(/^.*\./, '').toLowerCase().slice(0, 8)
    });

    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

    try {
      if (!(await input.canRead())) {
        silenceLog.error('inspect', 'container not recognised');
        throw new MediaToolError(
          'This media format or codec is not supported by your browser.',
          'Try MP4/H.264/AAC, WebM, MP3 or WAV.'
        );
      }

      const format = await input.getFormat();
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack()
      ]);

      if (!videoTrack && !audioTrack) {
        throw new MediaToolError('No audio or video track was found in this file.');
      }

      const duration = await input.computeDuration();
      silenceLog.info('inspect', 'container read', {
        format: format.name,
        mimeType: format.mimeType,
        duration,
        hasVideo: Boolean(videoTrack),
        hasAudio: Boolean(audioTrack)
      });

      const info: MediaInfo = {
        fileName: file.name,
        fileSize: file.size,
        containerName: format.name,
        mimeType: format.mimeType,
        kind: videoTrack ? 'video' : 'audio',
        durationSeconds: Number.isFinite(duration) ? duration : 0,
        hasAudioTrack: Boolean(audioTrack),
        audioCodec: null,
        sampleRate: null,
        channelCount: null,
        videoCodec: null,
        videoCodecString: null,
        width: null,
        height: null,
        frameRate: null
      };

      if (audioTrack) {
        info.audioCodec = await audioTrack.getCodec();
        info.sampleRate = await audioTrack.getSampleRate();
        info.channelCount = await audioTrack.getNumberOfChannels();

        const decoderConfig = await audioTrack.getDecoderConfig().catch((error: unknown) => {
          silenceLog.warn('inspect', 'audio decoder config unavailable', describeError(error));
          return null;
        });
        silenceLog.info('inspect', 'audio track', {
          codec: info.audioCodec,
          sampleRate: info.sampleRate,
          channels: info.channelCount,
          decoderCodec: decoderConfig?.codec ?? null
        });

        if (!(await audioTrack.canDecode())) {
          silenceLog.error('inspect', 'audio codec cannot be decoded here', { codec: info.audioCodec });
          throw new MediaToolError(
            'Your browser cannot decode the audio codec of this file.',
            'Try MP4/H.264/AAC, WebM, MP3 or WAV.'
          );
        }
      }

      if (videoTrack) {
        info.videoCodec = await videoTrack.getCodec();
        info.videoCodecString = await videoTrack.getCodecParameterString();
        info.width = await videoTrack.getDisplayWidth();
        info.height = await videoTrack.getDisplayHeight();
        info.frameRate = await this.frameRate(videoTrack);
        silenceLog.info('inspect', 'video track', {
          codec: info.videoCodec,
          codecString: info.videoCodecString,
          width: info.width,
          height: info.height,
          frameRate: info.frameRate,
          canDecode: await videoTrack.canDecode().catch(() => null)
        });
      }

      silenceLog.timing('inspect', 'done', startedAt);
      return info;
    } finally {
      input.dispose();
    }
  }

  /**
   * Best guess at the frame rate, or nothing.
   *
   * The metric is heuristic by nature — variable frame-rate video has no single
   * answer — so a low-confidence result is discarded rather than displayed as
   * if it were a property of the file.
   */
  private async frameRate(track: { computeFrameRateMetrics(): Promise<{ bestGuessFrameRate: number }> }): Promise<number | null> {
    try {
      const metrics = await track.computeFrameRateMetrics();
      const rate = metrics.bestGuessFrameRate;
      return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) / 100 : null;
    } catch {
      return null;
    }
  }
}
