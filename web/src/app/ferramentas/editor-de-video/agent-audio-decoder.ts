import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';
import { EditorAgentError } from './editor-agent-api';
import { createRenderInput, readRenderAudio, AUDIO_READ_TIMEOUT_MS } from './render-media';
import { SourceAudioMeter } from './audio-range-meter';
import { EditorCanceledError, EditorError } from './video-editor.models';

/** Decode only a requested source interval; no whole-file waveform prerequisite. */
export async function readAgentAudioRange(file: File, start: number, end: number, interval: number,
  includeAudio: boolean, signal: AbortSignal, progress?: (percent: number) => void) {
  let meter: SourceAudioMeter;
  try { meter = new SourceAudioMeter(start, end, interval, includeAudio); }
  catch (error) { throw new EditorAgentError((error as Error).message, 'invalid_range'); }
  if (signal.aborted) throw new EditorAgentError('Audio inspection was cancelled.', 'cancelled');
  const library = await loadMediabunny();
  const input = createRenderInput(library, file);
  try {
    const track = await new Promise<Awaited<ReturnType<typeof input.getPrimaryAudioTrack>>>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: Awaited<ReturnType<typeof input.getPrimaryAudioTrack>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) { input.dispose(); reject(error); } else resolve(value ?? null);
      };
      const abort = () => finish(new EditorAgentError('Audio inspection was cancelled.', 'cancelled'));
      const timer = setTimeout(() => finish(new EditorAgentError('Audio track reading timed out.', 'media_timeout')), AUDIO_READ_TIMEOUT_MS);
      signal.addEventListener('abort', abort, { once: true });
      input.getPrimaryAudioTrack().then(track => finish(undefined, track), error => finish(error));
      if (signal.aborted) abort();
    });
    if (!track) return { ...meter.result(), noAudio: true, warning: 'The source has no audio track.', audio: null };
    const sink = new library.AudioSampleSink(track);
    for await (const sample of readRenderAudio(sink.samples(start, end), input, signal, file.name)) {
      try {
        const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
        sample.copyTo(data, { planeIndex: 0, format: 'f32' });
        meter.add(sample, data);
        progress?.(Math.min(99, Math.max(0, (sample.timestamp + sample.duration - start) / (end - start) * 100)));
      } finally { sample.close(); }
    }
    if (signal.aborted) throw new EditorAgentError('Audio inspection was cancelled.', 'cancelled');
    const result = meter.result();
    if (!result.summary.sampleCount) throw new EditorAgentError('No PCM was decoded in the requested source range.', 'decode_failed');
    const bytes = meter.wav();
    let base64 = '';
    if (bytes) {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
      base64 = btoa(binary);
    }
    progress?.(100);
    return { ...result, noAudio: false, audio: bytes ? {
      mimeType: 'audio/wav', data: base64, start, end, duration: end - start,
      sampleRate: result.sampleRate, channelCount: result.channelCount, encoding: 'pcm-s16le',
      note: 'Original source excerpt. Undecoded gaps are padded with zero; inspect bucket coverage before treating them as silence.'
    } : null };
  } catch (error) {
    if (error instanceof EditorAgentError) throw error;
    if (signal.aborted || error instanceof EditorCanceledError) throw new EditorAgentError('Audio inspection was cancelled.', 'cancelled');
    if (error instanceof EditorError) throw new EditorAgentError(error.message, 'media_timeout');
    throw new EditorAgentError(error instanceof Error ? error.message : String(error), 'decode_failed');
  } finally { input.dispose(); }
}
