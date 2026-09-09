import { SuppressionProgress } from './noise-suppression.models';
import { LevellingReport, SuppressionRequest, SuppressionResponse } from './noise-suppression-protocol';
import { GainField } from './spectral-gain';

/** Refusals worth making by name, so the page can say what to do instead. */
export class SuppressionError extends Error {
  constructor(message: string, readonly hint = '') {
    super(message);
    this.name = 'SuppressionError';
  }
}

export class SuppressionCanceled extends Error {
  constructor() {
    super('The noise suppression was stopped.');
    this.name = 'SuppressionCanceled';
  }
}

export interface SuppressionResult {
  channels: Float32Array[];
  /** How much quieter the background between the words became, in decibels. */
  reduction: number;
  /** What levelling did, or null when it was off or had nothing to measure. */
  levelling: LevellingReport | null;
  /** The engine's decision, to hand back as `cachedField` next time. */
  field?: GainField;
}

/**
 * Runs one suppression job in its own worker and tears it down afterwards.
 *
 * One job per worker, deliberately: the ONNX runtime holds tens of megabytes
 * once it has loaded, and a reader who suppresses a file and then leaves the
 * page open should not be holding that for the rest of the afternoon.
 */
export function suppress(
  request: SuppressionRequest,
  onProgress: (progress: SuppressionProgress) => void,
  signal: AbortSignal
): Promise<SuppressionResult> {
  if (signal.aborted) return Promise.reject(new SuppressionCanceled());
  if (typeof Worker === 'undefined') {
    return Promise.reject(new SuppressionError('This browser cannot run the noise suppressor.'));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./noise-suppression.worker', import.meta.url), { type: 'module' });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      stop();
      reject(new SuppressionCanceled());
    };
    signal.addEventListener('abort', abort, { once: true });

    worker.onmessage = ({ data }: MessageEvent<SuppressionResponse>) => {
      if (signal.aborted) return;
      switch (data.type) {
        case 'progress':
          onProgress(data.progress);
          break;
        case 'done':
          stop();
          onProgress({ stage: 'done', ratio: 1, detail: '' });
          resolve({
            channels: data.channels,
            reduction: data.reduction,
            levelling: data.levelling,
            field: data.field
          });
          break;
        case 'error':
          stop();
          reject(new SuppressionError('The noise suppression failed.', data.message));
          break;
      }
    };
    worker.onerror = (error) => {
      stop();
      reject(new SuppressionError('The suppression worker failed to start.', error.message));
    };
    worker.onmessageerror = () => {
      stop();
      reject(new SuppressionError('The suppression worker returned unreadable data.'));
    };

    try {
      // Ownership moves to the worker; the caller must release its cached field.
      const buffers = [...request.channels, ...(request.cachedField?.frames ?? [])].map(value => value.buffer);
      worker.postMessage(request, [...new Set(buffers)]);
    } catch (error) {
      stop();
      reject(error);
    }
  });
}
