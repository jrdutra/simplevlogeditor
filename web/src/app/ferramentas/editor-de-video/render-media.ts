import type { Input } from 'mediabunny';
import type { MediabunnyLib } from '../../services/mediabunny/mediabunny-loader';
import { EditorCanceledError, EditorError } from './video-editor.models';

/**
 * Export seeks between cut ranges, tracks and files. A persistent Blob stream
 * can stall on those seeks. For PathBackedFile it also holds an HTTP connection
 * while idle: a few cached inputs can exhaust Chromium's per-origin pool.
 * Bounded reads keep the cache, but finish each request before the next seek.
 */
export function createRenderInput(library: MediabunnyLib, file: Blob): Input {
  return new library.Input({
    source: new library.BlobSource(file, { useStreamReader: false }),
    formats: library.ALL_FORMATS
  });
}

export const AUDIO_READ_TIMEOUT_MS = 60_000;

/** Bounds each decoder read, not the duration of a clip or its encoding. */
export async function* readRenderAudio<T extends { close(): void }>(
  samples: AsyncIterable<T>,
  input: Pick<Input, 'dispose'>,
  signal: AbortSignal,
  label: string
): AsyncGenerator<T> {
  const iterator = samples[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal.aborted) throw new EditorCanceledError();
      const step = await new Promise<IteratorResult<T>>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          // Disposing alone does not always wake a pending decoder.next().
          // Reject independently so cancellation also works during a stall.
          reject(error);
          try { input.dispose(); } catch { /* Preserve the read failure. */ }
        };
        const abort = () => fail(new EditorCanceledError());
        const timer = setTimeout(() => fail(new EditorError(
          `Audio reading stopped responding for 60 seconds (${label}).`,
          'Try exporting again. If it repeats, copy the render trace.'
        )), AUDIO_READ_TIMEOUT_MS);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => iterator.next()).then(result => {
          if (settled) {
            if (!result.done) result.value.close();
            return;
          }
          settled = true;
          cleanup();
          resolve(result);
        }, fail);
        if (signal.aborted) abort();
      });
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // An async generator's return may wait behind its stalled next. Do not
    // block export cleanup; any late sample is closed by the handler above.
    void iterator.return?.().catch(() => undefined);
  }
}
