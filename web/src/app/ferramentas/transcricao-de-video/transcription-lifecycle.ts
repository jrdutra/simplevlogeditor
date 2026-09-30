import { TranscriptionCanceled, TranscriptionError } from './transcription-errors';

/** A signal must reject independently of a stalled decoder/worker promise. */
export function transcriptionStep<T>(task: () => Promise<T>, options: {
  signal: AbortSignal; stage: string; timeoutMs: number; stop?: () => void; discard?: (value: T) => void;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (error) { try { options.stop?.(); } catch { /* Preserve the failure. */ } reject(error); }
      else resolve(value as T);
    };
    const abort = () => finish(new TranscriptionCanceled());
    const timer = setTimeout(() => finish(new TranscriptionError(
      `Transcription stopped waiting during ${options.stage} after ${options.timeoutMs} ms.`,
      'Check the source decoder, model download and available memory; retry explicitly after resolving the cause.',
      { code: 'transcription_stalled', stage: options.stage, details: { timeoutMs: options.timeoutMs }, recoverable: false }
    )), options.timeoutMs);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) { abort(); return; }
    Promise.resolve().then(() => {
      if (settled) throw new TranscriptionCanceled();
      return task();
    }).then(value => {
      if (settled) options.discard?.(value); else finish(undefined, value);
    }, error => finish(error));
  });
}

/** Every decoded sample is released, including samples arriving after abort. */
export async function* transcriptionSamples<T extends { close(): void }>(samples: AsyncIterable<T>,
  options: { signal: AbortSignal; stage: string; timeoutMs: number; stop: () => void }) {
  const iterator = samples[Symbol.asyncIterator]();
  try {
    while (true) {
      const step = await transcriptionStep(() => iterator.next(), {
        ...options, discard: late => { if (!late.done) late.value.close(); }
      });
      if (step.done) return;
      yield step.value;
    }
  } finally { void iterator.return?.().catch(() => undefined); }
}
