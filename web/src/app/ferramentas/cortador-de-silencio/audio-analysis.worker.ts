/// <reference lib="webworker" />

import { AnalysisWorkerRequest, AnalysisWorkerResult } from './audio-analysis.protocol';
import { CpuWindowReducer } from './window-reducer';

/**
 * Runs the loudness arithmetic off the interface thread.
 *
 * Squaring every sample of a two-hour recording is the one genuinely expensive
 * part of the analysis, and it is pure number crunching over typed arrays —
 * exactly the work a worker should own. Decoding stays on the main thread,
 * where the browser's own codec implementation already runs off-thread, and
 * only the decoded chunks travel here, transferred rather than copied.
 */

let reducer: CpuWindowReducer | null = null;

addEventListener('message', ({ data }: MessageEvent<AnalysisWorkerRequest>) => {
  if (data.type === 'init') {
    reducer = new CpuWindowReducer(data.channelCount, data.samplesPerWindow, data.windowCount);
    return;
  }

  if (!reducer) return;

  if (data.type === 'chunk') {
    reducer.push(data.startFrame, data.channels);
    return;
  }

  const result = reducer.finish();
  reducer = null;

  const message: AnalysisWorkerResult = { type: 'result', ...result };
  postMessage(message, [result.rms.buffer, result.min.buffer, result.max.buffer]);
});
