import { AnalysisSettings, NoiseReport } from './noise-analysis';
import { SuppressionCanceled, SuppressionError } from './noise-suppression-client';

export function analyseNoise(channels: Float32Array[], rate: number, settings: AnalysisSettings,
  progress: (ratio: number, detail: string) => void, signal: AbortSignal): Promise<NoiseReport> {
  if (signal.aborted) return Promise.reject(new SuppressionCanceled());
  if (typeof Worker === 'undefined') return Promise.reject(new Error('This browser cannot run local noise analysis.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./noise-analysis.worker', import.meta.url), { type: 'module' });
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new SuppressionCanceled()); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (signal.aborted) return;
      if (data.type === 'progress') progress(data.ratio, data.detail);
      else if (data.type === 'done') { cleanup(); resolve(data.report); }
      else if (data.type === 'error') { cleanup(); reject(new SuppressionError('Noise analysis failed.', data.message)); }
    };
    worker.onerror = error => { cleanup(); reject(new Error(error.message || 'Analysis worker failed.')); };
    worker.onmessageerror = () => { cleanup(); reject(new Error('Analysis worker returned invalid data.')); };
    try { worker.postMessage({ channels, rate, settings }, [...new Set(channels.map(channel => channel.buffer))]); }
    catch (error) { cleanup(); reject(error); }
  });
}
