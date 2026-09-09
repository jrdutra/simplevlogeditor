/// <reference lib="webworker" />
import { pipeline } from '@huggingface/transformers';
import { isDigitalSilence, normalizeChunks, ownedWords, recognitionWindows } from './recognition-timing';
import { Cue, readableTime } from './subtitle-formats';
import { WHISPER_SAMPLE_RATE as RATE } from './transcription.models';
import { TranscriptionRequest, TranscriptionResponse } from './transcription-protocol';

const send = (message: TranscriptionResponse) => postMessage(message);
addEventListener('message', async ({ data }: MessageEvent<TranscriptionRequest>) => {
  // One job per worker. The owner terminates it on completion or cancellation,
  // releasing ONNX memory even after model download or inference fails.
  try {
    const { samples, options } = data;
    if (isDigitalSilence(samples)) {
      send({ type: 'done', words: [] });
      return;
    }
    send({ type: 'progress', progress: { stage: 'downloading', ratio: null, detail: options.model } });
    const downloads = new Map<string, { loaded: number; total: number }>();
    const pipe = await pipeline('automatic-speech-recognition', options.model, {
      dtype: 'q8', device: 'wasm',
      // ORT 1.26-dev's extended QDQ rewrite fails on these Whisper q8 decoders
      // (missing embedding scale). Basic optimizations retain the original graph.
      session_options: { graphOptimizationLevel: 'basic' },
      progress_callback: (event: any) => {
        if (event.status !== 'progress') return;
        downloads.set(event.file, { loaded: event.loaded, total: event.total });
        const all = [...downloads.values()];
        const total = all.reduce((sum, file) => sum + file.total, 0);
        const loaded = all.reduce((sum, file) => sum + file.loaded, 0);
        send({ type: 'progress', progress: { stage: 'downloading',
          ratio: total > 0 ? Math.min(1, loaded / total) : null, detail: event.file } });
      }
    });
    const words: Cue[] = [];
    for (const window of recognitionWindows(samples.length, RATE)) {
      send({ type: 'progress', progress: { stage: 'listening', ratio: window.keepFrom / samples.length,
        detail: `${readableTime(window.keepFrom / RATE)} – ${readableTime(window.keepTo / RATE)}` } });
      const audio = samples.subarray(window.from, window.to);
      if (!isDigitalSilence(audio)) {
        const englishOnly = /\.en(?:_|$)/.test(options.model);
        const result = await pipe(audio, { return_timestamps: 'word',
          ...(!englishOnly ? { task: 'transcribe', ...(options.language ? { language: options.language } : {}) } : {}) });
        const heard = Array.isArray(result) ? result[0] : result;
        if (heard.text.trim() && !heard.chunks?.length) {
          throw new Error('This model did not return aligned timestamps. Please select another model.');
        }
        words.push(...ownedWords(normalizeChunks(heard.chunks ?? [], window.from / RATE,
          audio.length / RATE), window, RATE));
        send({ type: 'partial', words: [...words] });
      }
    }
    send({ type: 'done', words });
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
