import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';
import { TranscriptionProgress, WHISPER_SAMPLE_RATE } from './transcription.models';
import { TranscriptionCanceled, TranscriptionError } from './transcription-errors';
export { TranscriptionCanceled, TranscriptionError } from './transcription-errors';
export { splitOnQuiet } from './speech-windowing';
export { transcribe } from './transcription-client';

/** One hour of mono 16 kHz floats uses about 230 MB, plus model memory. */
export const MAX_MINUTES = 60;

/** Mediabunny exposed the rate as a field in older releases and as an async
 * method in newer ones. Supporting both is essential for MP4/AAC projects
 * restored with either runtime bundle. */
export async function audioTrackSampleRate(
  track: { sampleRate?: number; getSampleRate?: () => Promise<number> }
): Promise<number> {
  return typeof track.getSampleRate === 'function' ? track.getSampleRate() : Number(track.sampleRate);
}

/** Energy-preserving fallback for stereo recordings with opposite polarity.
 * Normal recordings are averaged; only severe cancellation selects a channel. */
export function downmix(input: Float32Array, channels: number): Float32Array {
  const mono = new Float32Array(input.length / channels);
  const energies = new Float64Array(channels);
  let mixedEnergy = 0;
  for (let frame = 0; frame < mono.length; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const raw = input[frame * channels + channel];
      const value = Number.isFinite(raw) ? raw : 0;
      mono[frame] += value / channels;
      energies[channel] += value * value;
    }
    mixedEnergy += mono[frame] ** 2;
  }
  let strongest = 0;
  for (let channel = 1; channel < channels; channel++) if (energies[channel] > energies[strongest]) strongest = channel;
  if (mixedEnergy < energies[strongest] * 0.01) {
    for (let frame = 0; frame < mono.length; frame++) {
      const value = input[frame * channels + strongest];
      mono[frame] = Number.isFinite(value) ? value : 0;
    }
  }
  return mono;
}

/* ------------------------------------------------------------------ audio */

/**
 * Decodes a file down to mono 16 kHz floats.
 *
 * Decoding is mediabunny, the same toolkit every other media tool here uses, so
 * anything the site can already open works — including a video, where only the
 * audio track is touched. Resampling is handed to an `OfflineAudioContext`
 * rather than done by hand: the browser's resampler is a proper one, and a
 * naive linear interpolation down from 48 kHz aliases exactly the consonants a
 * speech model needs most.
 */
export async function readSpeechAudio(
  file: File,
  onProgress: (report: TranscriptionProgress) => void,
  signal: AbortSignal
): Promise<Float32Array> {
  let stage = 'loading-decoder';
  let input: InstanceType<(Awaited<ReturnType<typeof loadMediabunny>>)['Input']> | null = null;

  try {
    const library = await loadMediabunny();
    input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
    stage = 'probing-audio-track';
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      throw new TranscriptionError(
        'This file has no sound in it.',
        'A transcription needs an audio track. Check that the recording is not a silent screen capture.'
      );
    }

    // Containers name a codec; browsers decide whether they have a decoder for
    // it. Firefox has no AAC on some systems, and a Chromium build without the
    // proprietary codecs has neither AAC nor H.264 — asking first turns the
    // library's internal complaint into an answer the reader can act on.
    stage = 'checking-codec-support';
    if (!(await track.canDecode())) {
      throw new TranscriptionError(
        `This browser has no decoder for the recording's audio (${track.codec ?? 'unknown codec'}).`,
        'Convert it first — the Video Editor exports WAV, and a WebM or Opus file is decoded everywhere.'
      );
    }

    stage = 'reading-media-duration';
    const seconds = await input.computeDuration();
    if (seconds > MAX_MINUTES * 60) {
      throw new TranscriptionError(
        `This recording is ${Math.round(seconds / 60)} minutes long, and the limit is ${MAX_MINUTES}.`,
        'Split it in the Video Editor and transcribe the halves, then join the two files.'
      );
    }

    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new TranscriptionError('The recording has no valid duration.', 'Try exporting it as WAV or MP4.');
    }
    const trackWithRate = track as typeof track & { sampleRate?: number; getSampleRate?: () => Promise<number> };
    const rate = await audioTrackSampleRate(trackWithRate);
    if (!Number.isFinite(rate) || rate <= 0) throw new TranscriptionError('Invalid audio sample rate.');
    const decoded = new Float32Array(Math.ceil(seconds * WHISPER_SAMPLE_RATE));
    const sink = new library.AudioSampleSink(track);
    let frames = 0;
    // Resample bounded blocks with 50 ms of filter context. Sample timestamps
    // preserve initial delays and gaps instead of shifting captions earlier.
    stage = `decoding-${String(track.codec || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}-audio`;
    for (let start = 0; start < seconds; start += 10) {
      if (signal.aborted) throw new TranscriptionCanceled();
      const end = Math.min(seconds, start + 10);
      const from = Math.max(0, start - 0.05);
      const until = Math.min(seconds, end + 0.05);
      const mono = new Float32Array(Math.ceil((until - from) * rate));
      for await (const sample of sink.samples(from, until)) {
        try {
          if (signal.aborted) throw new TranscriptionCanceled();
          if (sample.sampleRate !== rate) throw new TranscriptionError('Changing sample rates are not supported.');
          const interleaved = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
          sample.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
          const channel = downmix(interleaved, sample.numberOfChannels);
          const offset = Math.round((sample.timestamp - from) * rate);
          const first = Math.max(0, -offset);
          const count = Math.min(channel.length - first, mono.length - Math.max(0, offset));
          if (count > 0) mono.set(channel.subarray(first, first + count), Math.max(0, offset));
          frames += Math.max(0, count);
        } finally { sample.close(); }
      }
      const converted = rate === WHISPER_SAMPLE_RATE ? mono : await resample(mono, rate);
      if (signal.aborted) throw new TranscriptionCanceled();
      const skip = Math.round((start - from) * WHISPER_SAMPLE_RATE);
      const offset = Math.round(start * WHISPER_SAMPLE_RATE);
      const count = Math.min(Math.round((end - start) * WHISPER_SAMPLE_RATE), decoded.length - offset);
      decoded.set(converted.subarray(skip, skip + count), offset);
      onProgress({ stage: 'reading', ratio: end / seconds, detail: file.name });
    }
    if (!frames) throw new TranscriptionError('No audio samples could be decoded.');
    return decoded;
  } catch (error) {
    if (error instanceof TranscriptionCanceled || error instanceof TranscriptionError) throw error;
    const original = error instanceof Error ? error.message : String(error);
    throw new TranscriptionError(
      `Audio preparation failed during ${stage}: ${original}`,
      `File: ${file.name}; type: ${file.type || 'unknown'}; size: ${file.size} bytes.`,
      { code: 'audio_decode_failed', stage, details: { fileName: file.name, mimeType: file.type, size: file.size }, cause: error }
    );
  } finally {
    input?.dispose();
  }
}

/** Hands the rate change to the browser, which has a real resampler. */
async function resample(samples: Float32Array, from: number): Promise<Float32Array> {
  const length = Math.max(1, Math.round((samples.length * WHISPER_SAMPLE_RATE) / from));
  const context = new OfflineAudioContext(1, length, WHISPER_SAMPLE_RATE);

  const buffer = context.createBuffer(1, samples.length, from);
  buffer.copyToChannel(samples, 0);

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();

  return (await context.startRendering()).getChannelData(0);
}
