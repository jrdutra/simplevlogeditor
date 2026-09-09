/// <reference lib="webworker" />
import { analyseSamples } from './noise-analysis-engine';
import { AnalysisSettings } from './noise-analysis';
import { resample, toMono } from './resample';

addEventListener('message', async ({ data }: MessageEvent<{ channels: Float32Array[]; rate: number; settings: AnalysisSettings }>) => {
  try {
    if (!Number.isFinite(data.rate) || data.rate < 8000 || data.rate > 192000 || !data.channels.length
      || data.channels.some(channel => channel.length !== data.channels[0].length)) throw new Error('Invalid audio layout.');
    const samples = resample(toMono(data.channels), data.rate, 16000);
    const report = await analyseSamples(samples, data.settings, (ratio, detail) => postMessage({ type: 'progress', ratio, detail }));
    postMessage({ type: 'done', report });
  } catch (error) { postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
});
