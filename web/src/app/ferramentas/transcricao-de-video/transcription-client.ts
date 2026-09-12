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
    let stage = 'worker-startup';
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new TranscriptionCanceled()); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<TranscriptionResponse>) => {
      if (signal.aborted) return;
      switch (data.type) {
        case 'progress': stage = data.progress.stage; onProgress(data.progress); break;
        case 'partial': onPartial(data.words); break;
        case 'done': cleanup(); onProgress({ stage: 'done', ratio: 1, detail: '' }); resolve(data.words); break;
        case 'error': {
          cleanup();
          const original = Object.assign(new Error(data.error.message), {
            name: data.error.name,
            stack: data.error.stack,
            code: data.error.code,
            stage: data.error.stage
          });
          reject(new TranscriptionError(
            `Speech recognition failed during ${data.error.stage}: ${data.error.message}`,
            `Model: ${data.error.model}; language: ${data.error.language}. Check model availability, memory and the complete diagnostic.`,
            { code: data.error.code || 'recognition_failed', stage: data.error.stage, details: data.error, cause: original, recoverable: data.error.recoverable }
          ));
          break;
        }
      }
    };
    worker.onerror = (error) => { cleanup(); reject(new TranscriptionError(
      `The recognition worker failed during ${stage}: ${error.message || 'unknown worker error'}`,
      'Inspect the worker stack and available memory in the diagnostic.',
      { code: 'worker_failed', stage, details: { filename: error.filename, line: error.lineno, column: error.colno } }
    )); };
    worker.onmessageerror = () => { cleanup(); reject(new TranscriptionError(
      `The recognition worker returned unreadable data during ${stage}.`, '', { code: 'worker_message_error', stage }
    )); };
    try { worker.postMessage({ samples, options }, [samples.buffer]); }
    catch (error) { cleanup(); reject(new TranscriptionError(
      `Could not send decoded audio to the recognition worker: ${error instanceof Error ? error.message : String(error)}`,
      '', { code: 'worker_transfer_failed', stage: 'worker-transfer', cause: error }
    )); }
  });
}
