/**
 * Getting the sound out of a file and putting it back in.
 *
 * Any container the site can open comes in here, and what leaves is either the
 * same file with a new soundtrack or the soundtrack on its own.
 *
 * ## The picture is never touched
 *
 * When a video comes in, its video packets are copied to the output exactly as
 * they were read — not decoded, not re-encoded, not even inspected beyond the
 * codec name. Suppressing noise is an audio operation, and a tool that quietly
 * costs a generation of video quality on the way is a tool people stop
 * trusting. Only the audio is decoded, processed and encoded again.
 */

import { loadMediabunny, ensureMp3Encoder } from '../../services/mediabunny/mediabunny-loader';
import { MAX_WORKING_BYTES, estimatedWorkingBytes } from './audio-metrics';
import { AudioFormat, MAX_MINUTES, SuppressionProgress } from './noise-suppression.models';
import { SuppressionCanceled, SuppressionError } from './noise-suppression-client';

export interface DecodedAudio {
  channels: Float32Array[];
  rate: number;
  seconds: number;
  /** True when the file also carries a picture worth keeping. */
  hasVideo: boolean;
}

/** Reads every channel of a file at the rate it was recorded at. */
export async function readAudio(
  file: File,
  onProgress: (report: SuppressionProgress) => void,
  signal: AbortSignal
): Promise<DecodedAudio> {
  const library = await loadMediabunny();
  const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });

  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      throw new SuppressionError(
        'This file has no sound in it.',
        'There is nothing to suppress. Check that the recording is not a silent screen capture.'
      );
    }

    if (!(await track.canDecode())) {
      throw new SuppressionError(
        `This browser has no decoder for the recording's audio (${track.codec ?? 'unknown codec'}).`,
        'Convert it first — a WAV or a WebM file is decoded everywhere.'
      );
    }

    const seconds = await input.computeDuration();
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new SuppressionError('The recording has no valid duration.', 'Try exporting it as WAV or MP4.');
    }
    if (seconds > MAX_MINUTES * 60) {
      throw new SuppressionError(
        `This recording is ${Math.round(seconds / 60)} minutes long, and the limit is ${MAX_MINUTES}.`,
        'Split it in the Video Editor and clean the halves separately.'
      );
    }

    const rate = track.sampleRate;
    const count = track.numberOfChannels;
    if (!Number.isFinite(rate) || rate <= 0 || !count) {
      throw new SuppressionError('The audio track does not describe its own format.');
    }

    // Refused here rather than discovered halfway through. Minutes alone do not
    // decide this: eight channels at 192 kHz is thirty times the memory of mono
    // at 48 kHz for the same length, and the tab dies without saying why.
    const working = estimatedWorkingBytes(seconds, rate, count);
    if (working > MAX_WORKING_BYTES) {
      throw new SuppressionError(
        `This recording needs about ${Math.round(working / (1024 * 1024 * 1024) * 10) / 10} GB of memory to clean — ` +
          `${count} channel${count === 1 ? '' : 's'} at ${Math.round(rate / 1000)} kHz for ${Math.round(seconds / 60)} minutes.`,
        'Shorten it, or export it as mono at 48 kHz first and clean that.'
      );
    }

    const total = Math.ceil(seconds * rate) + rate;
    const channels: Float32Array[] = [];
    for (let index = 0; index < count; index++) channels.push(new Float32Array(total));

    const sink = new library.AudioSampleSink(track);
    let written = 0;
    let last = 0;

    for await (const sample of sink.samples()) {
      try {
        if (signal.aborted) throw new SuppressionCanceled();

        const frames = sample.numberOfFrames;

        // Written at the timestamp the container gives, so a track that starts
        // late or has a gap in it keeps its silence instead of sliding forward
        // and losing sync with the picture.
        const at = Math.max(0, Math.round(sample.timestamp * rate));

        // One call per channel: a planar copy fills a single plane at a time.
        for (let channel = 0; channel < Math.min(count, sample.numberOfChannels); channel++) {
          const plane = new Float32Array(sample.allocationSize({ planeIndex: channel, format: 'f32-planar' }) / 4);
          sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });

          const target = channels[channel];
          const room = Math.min(frames, target.length - at);
          if (room > 0) target.set(plane.subarray(0, room), at);
        }
        written = Math.max(written, at + frames);

        const now = Date.now();
        if (now - last > 120) {
          last = now;
          onProgress({ stage: 'reading', ratio: Math.min(1, sample.timestamp / seconds), detail: file.name });
        }
      } finally {
        sample.close();
      }
    }

    if (!written) throw new SuppressionError('No audio samples could be decoded.');

    const length = Math.min(total, written);
    const video = await input.getPrimaryVideoTrack();

    return {
      channels: channels.map((channel) => channel.subarray(0, length)),
      rate,
      seconds: length / rate,
      hasVideo: Boolean(video)
    };
  } finally {
    input.dispose();
  }
}

export interface WriteRequest {
  file: File;
  channels: Float32Array[];
  rate: number;
  /** Audio-only when null: the picture, if any, is left behind. */
  format: AudioFormat | null;
}

/** How many frames of audio go into one encoded sample. */
const CHUNK = 4096;

/**
 * Writes the cleaned audio out, with or without the original picture.
 *
 * With a picture, the container is whatever the input was — an MP4 stays an MP4
 * — because the video packets can only be copied into a container that accepts
 * that codec, and the one they came from certainly does.
 */
export async function writeAudio(
  request: WriteRequest,
  onProgress: (report: SuppressionProgress) => void,
  signal: AbortSignal
): Promise<{ blob: Blob; extension: string }> {
  const library = await loadMediabunny();

  // The input is opened only when the picture is wanted. Asked for audio alone,
  // this writes from the samples it was handed and never reads the source
  // again — which also means it works when there is no source to read.
  const input = request.format
    ? null
    : new library.Input({ source: new library.BlobSource(request.file), formats: library.ALL_FORMATS });

  try {
    const video = input ? await input.getPrimaryVideoTrack() : null;
    const videoCodec = video ? await video.getCodec() : null;
    const keepsPicture = Boolean(video && videoCodec);

    const container = request.format?.container ?? (await containerOf(library, input!));
    const codec = request.format?.codec ?? defaultCodecFor(container);
    if (codec === 'mp3') await ensureMp3Encoder();

    const output = new library.Output({
      format: formatFor(library, container),
      target: new library.BufferTarget()
    });

    let videoSource: import('mediabunny').EncodedVideoPacketSource | null = null;
    if (keepsPicture && video && videoCodec) {
      videoSource = new library.EncodedVideoPacketSource(videoCodec);
      output.addVideoTrack(videoSource);
    }

    const audioSource = new library.AudioSampleSource({
      codec: codec as import('mediabunny').AudioCodec,
      ...(codec.startsWith('pcm-') ? {} : { quality: new library.Quality('high') })
    });
    output.addAudioTrack(audioSource);

    await output.start();

    if (keepsPicture && video && videoSource) {
      const config = await video.getDecoderConfig();
      const sink = new library.EncodedPacketSink(video);
      let first = true;
      for await (const packet of sink.packets()) {
        if (signal.aborted) throw new SuppressionCanceled();
        await videoSource.add(packet, first && config ? { decoderConfig: config } : undefined);
        first = false;
      }
    }

    const frames = request.channels[0]?.length ?? 0;
    const count = request.channels.length;
    let last = 0;

    for (let at = 0; at < frames; at += CHUNK) {
      if (signal.aborted) throw new SuppressionCanceled();

      const size = Math.min(CHUNK, frames - at);
      const data = new Float32Array(size * count);
      for (let channel = 0; channel < count; channel++) {
        data.set(request.channels[channel].subarray(at, at + size), channel * size);
      }

      const chunk = new library.AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: count,
        sampleRate: request.rate,
        timestamp: at / request.rate
      });
      try {
        await audioSource.add(chunk);
      } finally {
        // Closed as soon as the encoder has it: these hold memory outside the
        // JavaScript heap, and waiting for a collector to notice is what turns
        // a long file into a tab that runs out of it.
        chunk.close();
      }

      const now = Date.now();
      if (now - last > 120) {
        last = now;
        onProgress({ stage: 'writing', ratio: at / frames, detail: '' });
      }
    }

    audioSource.close();
    videoSource?.close();
    await output.finalize();

    const buffer = (output.target as import('mediabunny').BufferTarget).buffer;
    if (!buffer) throw new SuppressionError('The cleaned file could not be assembled.');

    return {
      blob: new Blob([buffer], { type: output.format.mimeType }),
      extension: request.format?.extension ?? extensionFor(container, keepsPicture)
    };
  } finally {
    input?.dispose();
  }
}

type Library = Awaited<ReturnType<typeof loadMediabunny>>;

/** The container to write a video back into: the one it arrived in. */
async function containerOf(library: Library, input: import('mediabunny').Input): Promise<'mp4' | 'webm'> {
  const format = await input.getFormat();
  return format.name.toLowerCase().includes('webm') || format.name.toLowerCase().includes('matroska')
    ? 'webm'
    : 'mp4';
}

function defaultCodecFor(container: string): string {
  if (container === 'webm') return 'opus';
  if (container === 'wav') return 'pcm-s16';
  if (container === 'ogg') return 'opus';
  if (container === 'mp3') return 'mp3';
  return 'aac';
}

function formatFor(library: Library, container: string): import('mediabunny').OutputFormat {
  switch (container) {
    case 'webm': return new library.WebMOutputFormat();
    case 'wav': return new library.WavOutputFormat();
    case 'ogg': return new library.OggOutputFormat();
    // An MP3 is a bare stream of MP3 frames, not an MP4 with an MP3 track in
    // it. Players accept both; only the first is what anyone means by "an mp3".
    case 'mp3': return new library.Mp3OutputFormat();
    default: return new library.Mp4OutputFormat();
  }
}

function extensionFor(container: string, hasVideo: boolean): string {
  if (container === 'mp4') return hasVideo ? 'mp4' : 'm4a';
  return container;
}
