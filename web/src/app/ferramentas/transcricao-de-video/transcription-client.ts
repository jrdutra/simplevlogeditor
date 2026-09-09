import { Cue } from './subtitle-formats';
import { TranscriptionProgress } from './transcription.models';
import { TranscriptionCanceled, TranscriptionError } from './transcription-errors';
import { TranscribeOptions, TranscriptionResponse } from './transcription-protocol';

export function transcribe(samples: Float32Array, options: TranscribeOptions,
  onProgress: (progress: TranscriptionProgress) => void, signal: AbortSignal,
  onPartial: (words: Cue[]) => void = () => {}): Promise<Cue[]> {
  if (signal.aborted) return Promise.reject(new TranscriptionCanceled());
  if (typeof Worker === 'undefined') return Promise.reject(new TranscriptionError('This browser cannot run speech recognition workers.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./transcription.worker', import.meta.url), { type: 'module' });
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new TranscriptionCanceled()); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<TranscriptionResponse>) => {
      if (signal.aborted) return;
      switch (data.type) {
        case 'progress': onProgress(data.progress); break;
        case 'partial': onPartial(data.words); break;
        case 'done': cleanup(); onProgress({ stage: 'done', ratio: 1, detail: '' }); resolve(data.words); break;
        case 'error': cleanup(); reject(new TranscriptionError('Speech recognition failed.', data.message)); break;
      }
    };
    worker.onerror = (error) => { cleanup(); reject(new TranscriptionError('The recognition worker failed.', error.message)); };
    worker.onmessageerror = () => { cleanup(); reject(new TranscriptionError('The recognition worker returned unreadable data.')); };
    try { worker.postMessage({ samples, options }, [samples.buffer]); }
    catch (error) { cleanup(); reject(error); }
  });
}
