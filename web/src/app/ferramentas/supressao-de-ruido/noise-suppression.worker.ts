/// <reference lib="webworker" />

/**
 * The suppression itself, off the main thread.
 *
 * A worker for the usual reason — thousands of inferences and a Fourier
 * transform per frame would freeze the page — and for one more: it is the only
 * way Stop can mean anything. The engines check between frames, and the owner
 * terminates the worker outright, which also releases the ONNX runtime's memory
 * whether it finished, failed or was interrupted.
 */

import { applyGains, peak, smoothField, APPLY_DEFAULTS } from './spectral-gain';
import { cacheableField } from './analysis-cache';
import { quietLevelChange } from './audio-metrics';
import { applyLevelling, planLevelling } from './levelling';
import { gtcrnField } from './gtcrn-engine';
import { rnnoiseField } from './rnnoise-engine';
import { MODEL_RATE, RNNOISE_RATE } from './noise-suppression.models';
import { LevellingReport, SuppressionRequest, SuppressionResponse } from './noise-suppression-protocol';
import { resample, toMono } from './resample';

const send = (message: SuppressionResponse, transfer: Transferable[] = []) =>
  (postMessage as (message: SuppressionResponse, transfer: Transferable[]) => void)(message, transfer);

addEventListener('message', async ({ data }: MessageEvent<SuppressionRequest>) => {
  try {
    const { channels, rate, engine, attenuationDb, preserveHighs, loudness, cachedField, device = 'cpu' } = data;
    if (!channels.length || !channels[0].length || channels.some(channel => channel.length !== channels[0].length)
      || !Number.isFinite(rate) || rate < 8000 || rate > 192000 || !Number.isFinite(attenuationDb)) {
      throw new Error('Invalid audio layout, sample rate or strength.');
    }
    if (device !== 'cpu' && device !== 'webgpu') throw new Error('Unknown processing device.');
    if (engine !== 'gtcrn' && engine !== 'rnnoise') throw new Error('Unknown suppression engine.');
    if (engine === 'rnnoise' && device === 'webgpu') throw new Error('GPU processing is available with Voice model only.');
    for (const channel of channels) for (let i = 0; i < channel.length; i++) {
      if (!Number.isFinite(channel[i])) channel[i] = 0;
    }
    const never = () => false;

    // Every engine listens to one channel. Applying one decision to all of them
    // is not a shortcut: a separate decision per channel would move the noise
    // between left and right as each side opened and closed on its own.

    let field = cachedField;
    if (!field) {
      send({ type: 'progress', progress: { stage: 'loading', ratio: null, detail: engine } });

      const wanted = engine === 'rnnoise' ? RNNOISE_RATE : MODEL_RATE;
      const listened = resample(toMono(channels), rate, wanted);
      const report = (ratio: number) =>
        send({ type: 'progress', progress: { stage: 'listening', ratio, detail: '' } });

      field = engine === 'rnnoise'
        ? await rnnoiseField(listened, report, never)
        : await gtcrnField(listened, report, never, device);
    }

    const cleaned: Float32Array[] = [];
    const prepared = smoothField(field, APPLY_DEFAULTS.attackMs, APPLY_DEFAULTS.releaseMs);
    for (let index = 0; index < channels.length; index++) {
      send({
        type: 'progress',
        progress: { stage: 'writing', ratio: index / channels.length, detail: `${index + 1}/${channels.length}` }
      });
      cleaned.push(applyGains(channels[index], rate, field, { attenuationDb, preserveHighs }, prepared));
    }

    // Taken before levelling: levelling moves the voice and the noise floor by
    // the same amount, so measuring afterwards would credit a boost with making
    // the background louder and a cut with removing it.
    const reduction = quietLevelChange(channels, cleaned, rate);

    // Levelling is measured on the cleaned audio, so the level it reads is the
    // voice rather than the voice plus whatever was behind it.
    let levelled: LevellingReport | null = null;
    if (loudness?.enabled) {
      send({ type: 'progress', progress: { stage: 'levelling', ratio: null, detail: '' } });

      const levelling = planLevelling(toMono(cleaned), rate, loudness);
      if (levelling) {
        for (const channel of cleaned) applyLevelling(channel, rate, levelling, loudness.limiter);
        levelled = {
          measuredDb: levelling.envelope.measuredDb,
          staticGainDb: levelling.envelope.staticGainDb,
          clipped: levelling.envelope.clipped
        };
      }
    }

    // Spectral filtering and levelling can both raise sample peaks. Scale all
    // channels together to retain the stereo balance when preventing clipping.
    let loudest = 0;
    for (const channel of cleaned) loudest = Math.max(loudest, peak(channel));
    if (loudest > 1) {
      const scale = 1 / loudest;
      for (const channel of cleaned) {
        for (let index = 0; index < channel.length; index++) channel[index] *= scale;
      }
    }

    const reusable = cacheableField(field);
    send(
      { type: 'done', channels: cleaned, reduction, levelling: levelled, field: reusable },
      [...new Set([...cleaned, ...(reusable?.frames ?? [])].map(value => value.buffer))]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: 'error', message: data.device === 'webgpu' ? `${message}\nSelect CPU to retry without WebGPU.` : message });
  }
});
