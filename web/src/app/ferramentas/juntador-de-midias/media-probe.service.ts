import { Injectable } from '@angular/core';

import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';
import { IMAGE_SECONDS } from './media-merger-formats';
import { MediaSummary, MergeError } from './media-merger.models';

/** Extensions treated as still pictures when the type is not declared. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|svg)$/i;

/**
 * Reads what each selected file actually is, from its bytes.
 *
 * Extensions lie and MIME types are guesses the operating system made, so
 * nothing here trusts either. Everything the queue later displays — duration,
 * size of the picture, codecs — is a value the parser genuinely resolved;
 * whatever it could not resolve stays `null` and is simply not shown.
 *
 * The file is never read into memory: it is handed over as a blob source that
 * reads byte ranges on demand, so a four-gigabyte recording is probed as
 * cheaply as a four-megabyte one. That matters here more than in a
 * single-file tool, because a reader may drop twenty files at once.
 */
@Injectable({ providedIn: 'root' })
export class MediaProbeService {
  async probe(file: File): Promise<MediaSummary> {
    if (this.looksLikeImage(file)) return this.probeImage(file);

    const library = await loadMediabunny();
    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });

    try {
      if (!(await input.canRead())) {
        throw new MergeError(
          `"${file.name}" is not a media file your browser can read.`,
          'Supported inputs include MP4, MOV, MKV, WebM, MP3, M4A, WAV, OGG and FLAC.'
        );
      }

      const format = await input.getFormat();
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack()
      ]);

      if (!videoTrack && !audioTrack) {
        throw new MergeError(`"${file.name}" contains no audio or video track.`);
      }

      const duration = await input.computeDuration();
      const summary: MediaSummary = {
        fileName: file.name,
        fileSize: file.size,
        containerName: format.name,
        kind: videoTrack ? 'video' : 'audio',
        durationSeconds: Number.isFinite(duration) ? duration : 0,
        hasVideoTrack: Boolean(videoTrack),
        hasAudioTrack: Boolean(audioTrack),
        videoCodec: null,
        audioCodec: null,
        width: null,
        height: null,
        frameRate: null,
        sampleRate: null,
        channelCount: null,
        videoUsable: Boolean(videoTrack),
        audioUsable: Boolean(audioTrack),
        warning: null,
        isTimelapse: false,
        timelapseReason: null
      };

      if (videoTrack) {
        summary.videoCodec = await videoTrack.getCodec();
        summary.width = await videoTrack.getDisplayWidth();
        summary.height = await videoTrack.getDisplayHeight();
        summary.frameRate = await this.frameRate(videoTrack);

        if (!(await videoTrack.canDecode().catch(() => false))) {
          // The clip is kept rather than rejected: its sound may still be
          // wanted, and refusing the whole file would hide that choice.
          summary.videoUsable = false;
          summary.warning = `Your browser cannot decode ${summary.videoCodec ?? 'this'} video, so this clip plays over a black screen.`;
        }
      }

      if (audioTrack) {
        summary.audioCodec = await audioTrack.getCodec();
        summary.sampleRate = await audioTrack.getSampleRate();
        summary.channelCount = await audioTrack.getNumberOfChannels();

        if (!(await audioTrack.canDecode().catch(() => false))) {
          summary.audioUsable = false;
          summary.warning = `Your browser cannot decode ${summary.audioCodec ?? 'this'} audio, so this clip plays silently.`;
        }
      }

      if (!summary.videoUsable && !summary.audioUsable) {
        throw new MergeError(
          `Your browser cannot decode anything inside "${file.name}".`,
          'Supported inputs include MP4/H.264, WebM, MKV, MP3, M4A, WAV, OGG and FLAC.'
        );
      }

      // While the input is still open. Reading the tags costs one seek and the
      // file is already in hand; opening it again later to ask one question
      // would be a second read of a file that may be gigabytes.
      await this.detectTimelapse(input, file, summary);

      if (summary.durationSeconds <= 0) {
        throw new MergeError(
          `The length of "${file.name}" could not be determined.`,
          'A file with no duration cannot be placed on a timeline. Try remuxing it first.'
        );
      }

      return summary;
    } finally {
      input.dispose();
    }
  }

  private looksLikeImage(file: File): boolean {
    return file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name);
  }

  /**
   * Measures a still picture.
   *
   * An image has no timeline of its own, so the one thing a merge needs most —
   * how long it lasts — cannot be read from the file. It starts at a default
   * the reader can change, and it is the only kind of entry whose duration is
   * a decision rather than a measurement.
   */
  private async probeImage(file: File): Promise<MediaSummary> {
    let bitmap: ImageBitmap;

    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new MergeError(
        `"${file.name}" is not an image your browser can open.`,
        'Try PNG, JPEG, WebP, GIF, AVIF or BMP.'
      );
    }

    try {
      return {
        fileName: file.name,
        fileSize: file.size,
        containerName: (file.type.split('/')[1] ?? file.name.split('.').pop() ?? 'image').toUpperCase(),
        kind: 'image',
        durationSeconds: IMAGE_SECONDS.default,
        hasVideoTrack: false,
        hasAudioTrack: false,
        videoCodec: null,
        audioCodec: null,
        width: bitmap.width,
        height: bitmap.height,
        frameRate: null,
        sampleRate: null,
        channelCount: null,
        videoUsable: true,
        audioUsable: false,
        warning: null,
        // A still picture is not footage, so the question does not arise.
        isTimelapse: false,
        timelapseReason: null
      };
    } finally {
      // The pixels were only ever needed for the dimensions; the merge decodes
      // the file again when it actually has somewhere to draw it.
      bitmap.close();
    }
  }

  /**
   * Reads a file that is only ever going to supply sound.
   *
   * Used for the audio a reader attaches to a still image: a video file is
   * accepted here too, but only its audio track will be taken, so a file
   * without one is refused rather than silently attached.
   */
  async probeAudioOnly(file: File): Promise<MediaSummary> {
    const summary = await this.probe(file);

    if (!summary.audioUsable) {
      throw new MergeError(
        `"${file.name}" has no sound your browser can decode.`,
        'Attach an MP3, M4A, WAV, OGG or FLAC file, or a video that has an audio track.'
      );
    }

    return summary;
  }

  /**
   * How much longer than the finished clip the file took to write before that
   * counts as evidence of a timelapse.
   *
   * Three is deliberately generous. A camera writing a twenty-second clip over
   * a minute is doing something ordinary — buffering, finalising, a slow card;
   * a camera writing it over an hour was shooting frames at an interval. The
   * bar is set where the honest explanations run out rather than where the
   * detection rate is highest.
   */
  private static readonly TIMELAPSE_SPAN_RATIO = 3;

  /** What a camera calls this mode, in the words it writes into the file. */
  private static readonly TIMELAPSE_WORDS = [
    'timelapse',
    'time-lapse',
    'time lapse',
    'timewarp',
    'time-warp',
    'hyperlapse',
    'hyper-lapse',
    'intervalometer',
    'interval',
    'lapso'
  ];

  /**
   * Decides whether this file looks like a timelapse, and says why.
   *
   * Two signals, and both are needed. The first is that there is **no
   * soundtrack**: practically every timelapse a camera writes is video only.
   * On its own that means nothing — a screen recording, a muted export and a
   * clip somebody stripped the audio from all qualify — so it is only the free
   * first pass, and the second signal is what actually decides.
   *
   * That second signal is the container's own account of itself, in either of
   * two forms: the camera naming the mode, or the file having taken far longer
   * to write than it takes to play. Neither is available for every file, and
   * when neither is there the answer is simply no.
   *
   * Nothing here may fail loudly. A file that cannot be asked about its
   * metadata is a file that is not a timelapse as far as this is concerned —
   * it is not a file to reject.
   */
  private async detectTimelapse(
    input: { getMetadataTags(): Promise<import('mediabunny').MetadataTags> },
    file: File,
    summary: MediaSummary
  ): Promise<void> {
    // Sound is the disqualifier, and it is free. Everything below reads the
    // file, so it is worth not reaching it for the vast majority of clips.
    if (summary.hasAudioTrack || summary.kind !== 'video') return;

    try {
      const tags = await input.getMetadataTags();

      const named = this.namesTimelapse(tags);
      if (named) {
        summary.isTimelapse = true;
        summary.timelapseReason = `No sound, and the file declares a ${named} mode in its metadata.`;
        return;
      }

      const span = this.writingSpan(tags, file, summary.durationSeconds);
      if (span) {
        summary.isTimelapse = true;
        summary.timelapseReason = `No sound, and it was written over about ${span} for a clip this long.`;
      }
    } catch {
      // Some containers have no tags to give, and some readers refuse the
      // question. Either way this file simply is not marked.
    }
  }

  /**
   * The camera's own word for the mode, if it wrote one down.
   *
   * `raw` is where the answer lives, and it is a different shape per format.
   * For MP4 and QuickTime it holds the atoms of `ilst`, the keys of a `keys`
   * atom — the `com.apple.quicktime.*` family — and every atom inside `udta`,
   * those last ones as bytes whose internal format nobody documents. GoPro, DJI
   * and Insta360 all tend to leave the mode's name in plain text somewhere in
   * there, which is why the byte values are searched as text too rather than
   * being parsed.
   */
  private namesTimelapse(tags: import('mediabunny').MetadataTags): string | null {
    const haystacks: string[] = [];

    const add = (value: unknown): void => {
      if (typeof value === 'string') haystacks.push(value.toLowerCase());
      else if (value instanceof Uint8Array) {
        try {
          haystacks.push(new TextDecoder('utf-8', { fatal: false }).decode(value).toLowerCase());
        } catch {
          /* Not text. Nothing to read. */
        }
      }
    };

    for (const field of [tags.title, tags.description, tags.comment, tags.genre]) add(field);

    for (const [key, value] of Object.entries(tags.raw ?? {})) {
      haystacks.push(key.toLowerCase());
      add(value);
    }

    for (const text of haystacks) {
      const word = MediaProbeService.TIMELAPSE_WORDS.find((candidate) => text.includes(candidate));
      if (word) return word;
    }

    return null;
  }

  /**
   * How long the camera spent writing the file, when that is knowably longer
   * than the file plays.
   *
   * `tags.date` is when the recording began, as the container declares it;
   * `file.lastModified` is when the last byte was written. A twenty-second clip
   * whose two ends are forty minutes apart was not recorded in real time.
   *
   * The measurement is fragile in one direction only, and never in the other:
   * copying a file, syncing it or restoring it from a backup rewrites
   * `lastModified`, and some muxers write `date` at finalise rather than at the
   * start — in both cases the span collapses and the signal quietly disappears.
   * It cannot produce a false *positive* from that, which is why it is allowed
   * to decide on its own.
   *
   * Answers the span in words, or null when there is nothing to conclude.
   */
  private writingSpan(
    tags: import('mediabunny').MetadataTags,
    file: File,
    durationSeconds: number
  ): string | null {
    const started = tags.date?.getTime();
    if (!started || !Number.isFinite(started) || durationSeconds <= 0) return null;

    const spanSeconds = (file.lastModified - started) / 1000;
    if (!Number.isFinite(spanSeconds) || spanSeconds <= 0) return null;
    if (spanSeconds / durationSeconds < MediaProbeService.TIMELAPSE_SPAN_RATIO) return null;

    const minutes = spanSeconds / 60;
    if (minutes < 1) return `${Math.round(spanSeconds)} seconds`;
    if (minutes < 90) return `${Math.round(minutes)} minutes`;
    return `${Math.round(minutes / 6) / 10} hours`;
  }

  /**
   * Best guess at the frame rate, or nothing.
   *
   * The metric is heuristic by nature — variable frame-rate video has no single
   * answer — so a result that is not a sane rate is discarded rather than
   * displayed as if it were a property of the file.
   */
  private async frameRate(track: { computeFrameRateMetrics(): Promise<{ bestGuessFrameRate: number }> }): Promise<number | null> {
    try {
      const { bestGuessFrameRate } = await track.computeFrameRateMetrics();
      return Number.isFinite(bestGuessFrameRate) && bestGuessFrameRate > 0
        ? Math.round(bestGuessFrameRate * 100) / 100
        : null;
    } catch {
      return null;
    }
  }
}
