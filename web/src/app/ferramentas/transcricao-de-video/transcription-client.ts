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
    let worker: Worker;
    try { worker = new Worker(new URL('./transcription.worker', import.meta.url), { type: 'module' }); }
    catch (error) {
      reject(new TranscriptionError(`Could not start the recognition worker: ${error instanceof Error ? error.message : String(error)}`,
        `Model: ${options.model}. Check worker loading and browser security settings.`,
        { code: 'worker_startup_failed', stage: 'worker-startup', cause: error }));
      return;
    }
    let stage = 'worker-startup';
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    let token = '';
    const cleanup = () => { settled = true; clearTimeout(watchdog); worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new TranscriptionCanceled()); };
    const report = (progress: TranscriptionProgress) => {
      if (settled || signal.aborted) return;
      stage = progress.stage;
      const nextToken = `${stage}|${progress.ratio}|${progress.detail}`;
      if (token !== nextToken) {
        token = nextToken;
        clearTimeout(watchdog);
        const budget = options.stageTimeoutMs ?? 5 * 60_000;
        const timeoutMs = stage === 'worker-startup' ? Math.min(budget, 60_000) : budget;
        watchdog = setTimeout(() => {
          cleanup();
          reject(new TranscriptionError(`The recognition worker made no progress during ${stage} for ${timeoutMs} ms.`,
            `Model: ${options.model}; language: ${options.language || 'auto'}. Check model download, worker startup and memory.`,
            { code: 'transcription_stalled', stage, details: { timeoutMs, model: options.model }, recoverable: false }));
        }, timeoutMs);
      }
      onProgress(progress);
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<TranscriptionResponse>) => {
      if (settled || signal.aborted) return;
      switch (data.type) {
        case 'progress': report(data.progress); break;
        case 'partial': onPartial(data.words); report({ stage: 'listening', ratio: null, detail: `${data.words.length} words recognized` }); break;
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
    try {
      report({ stage: 'worker-startup', ratio: null, detail: options.model });
      if (signal.aborted) { abort(); return; }
      worker.postMessage({ samples, options }, [samples.buffer]);
    }
    catch (error) { cleanup(); reject(new TranscriptionError(
      `Could not send decoded audio to the recognition worker: ${error instanceof Error ? error.message : String(error)}`,
      '', { code: 'worker_transfer_failed', stage: 'worker-transfer', cause: error }
    )); }
  });
}
