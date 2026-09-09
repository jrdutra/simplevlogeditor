/**
 * Levelling the volume of a whole project.
 *
 * Two different complaints hide behind "the sound is uneven". One is that two
 * recordings sit at different levels, so the viewer reaches for the volume
 * every time the edit cuts between them. The other is that inside a single
 * recording the speaker drifts — leaning in, turning away, dropping their voice
 * at the end of every sentence. This module answers both with the same machine:
 * measure how loud the speech actually is, then apply the gain that brings it
 * to a stated target, either once for the whole clip or as a slow curve that
 * follows the drift.
 *
 * It works from the per-bucket RMS the waveform already carries, so levelling
 * costs nothing extra to measure: the file was decoded once for the silence
 * analysis and this reads the numbers that pass produced. That also means the
 * curve is in **source** time, the same clock the waveform is drawn against.
 *
 * The one thing it deliberately will not do is boost silence. Room tone,
 * breathing and the hiss of a cheap microphone all sit below the noise floor,
 * and lifting them to speech level is the single most recognisable way to make
 * an edit sound processed.
 */

/** Below this level a bucket carries no signal worth measuring. */
export const SILENCE_DB = -120;

/** How the correction is applied across a clip. */
export type LoudnessMode = 'match' | 'level';

export interface LoudnessSettings {
  enabled: boolean;
  /**
   * `match` applies one gain to the whole clip, so every clip in the project
   * arrives at the same level while the dynamics inside each one are untouched.
   * `level` additionally follows the drift within a clip.
   */
  mode: LoudnessMode;
  /** The level speech is brought to, in dBFS RMS. */
  targetDb: number;
  /** The most the signal may be lifted, in dB. */
  maxBoostDb: number;
  /** The most it may be held back, in dB. */
  maxCutDb: number;
  /** How slowly the moving gain is allowed to change, in seconds. */
  smoothingSeconds: number;
  /** Below this, audio is treated as room tone and never boosted. */
  noiseFloorDb: number;
  /** Rounds off anything that would overshoot instead of letting it clip. */
  limiter: boolean;
}

export const DEFAULT_LOUDNESS: LoudnessSettings = {
  enabled: false,
  mode: 'level',
  targetDb: -20,
  maxBoostDb: 12,
  maxCutDb: 12,
  smoothingSeconds: 1.5,
  noiseFloorDb: -50,
  limiter: true
};

export const LOUDNESS_LIMITS = {
  targetDb: { min: -34, max: -10, step: 1 },
  maxBoostDb: { min: 0, max: 30, step: 1 },
  maxCutDb: { min: 0, max: 30, step: 1 },
  smoothingSeconds: { min: 0.1, max: 10, step: 0.1 },
  noiseFloorDb: { min: -80, max: -20, step: 1 }
} as const;

export function clampLoudness(settings: LoudnessSettings): LoudnessSettings {
  const clamp = (value: number, limits: { min: number; max: number }) =>
    Number.isFinite(value) ? Math.min(limits.max, Math.max(limits.min, value)) : limits.min;

  return {
    enabled: Boolean(settings.enabled),
    mode: settings.mode === 'match' ? 'match' : 'level',
    targetDb: clamp(settings.targetDb, LOUDNESS_LIMITS.targetDb),
    maxBoostDb: clamp(settings.maxBoostDb, LOUDNESS_LIMITS.maxBoostDb),
    maxCutDb: clamp(settings.maxCutDb, LOUDNESS_LIMITS.maxCutDb),
    smoothingSeconds: clamp(settings.smoothingSeconds, LOUDNESS_LIMITS.smoothingSeconds),
    noiseFloorDb: clamp(settings.noiseFloorDb, LOUDNESS_LIMITS.noiseFloorDb),
    limiter: Boolean(settings.limiter)
  };
}

/** The gain to apply across one clip, in source time. */
export interface GainEnvelope {
  /** Linear gain per bucket. A single entry means one gain for the whole clip. */
  gain: Float32Array;
  secondsPerBucket: number;
  duration: number;
  /** The speech level that was found, in dBFS. */
  measuredDb: number;
  /** What a single flat correction would have been, in dB. */
  staticGainDb: number;
  /** True once the correction was held back by the boost or cut limit. */
  clipped: boolean;
}

/** A clip that needs no correction at all. */
export const UNITY_ENVELOPE: GainEnvelope = {
  gain: Float32Array.from([1]),
  secondsPerBucket: 1,
  duration: 0,
  measuredDb: SILENCE_DB,
  staticGainDb: 0,
  clipped: false
};

/**
 * The level of the speech in a clip, ignoring everything below the floor.
 *
 * Energy is averaged rather than decibels: loudness adds as power, and taking
 * the mean of the decibel values would let one very quiet bucket drag the
 * answer down far more than it should.
 */
export function measureSpeechLevel(rms: Float32Array, noiseFloorDb: number): number {
  const floor = dbToAmplitude(noiseFloorDb);
  let energy = 0;
  let counted = 0;

  for (let i = 0; i < rms.length; i++) {
    const value = rms[i];
    if (value < floor) continue;
    energy += value * value;
    counted++;
  }

  if (!counted) return SILENCE_DB;
  return amplitudeToDb(Math.sqrt(energy / counted));
}

/**
 * Builds the gain curve for one clip.
 *
 * Returns `null` when the clip holds nothing above the noise floor: there is no
 * speech level to measure, and inventing one would mean amplifying hiss.
 */
export function planGainEnvelope(
  rms: Float32Array,
  secondsPerBucket: number,
  duration: number,
  settings: LoudnessSettings
): GainEnvelope | null {
  if (!settings.enabled || !rms.length || secondsPerBucket <= 0) return null;

  const measuredDb = measureSpeechLevel(rms, settings.noiseFloorDb);
  if (measuredDb <= SILENCE_DB) return null;

  const wanted = settings.targetDb - measuredDb;
  const staticGainDb = Math.min(settings.maxBoostDb, Math.max(-settings.maxCutDb, wanted));
  const clipped = Math.abs(wanted - staticGainDb) > 0.01;

  if (settings.mode === 'match') {
    return {
      gain: Float32Array.from([dbToAmplitude(staticGainDb)]),
      secondsPerBucket,
      duration,
      measuredDb,
      staticGainDb,
      clipped
    };
  }

  // The per-bucket correction, before it is allowed to move.
  const floor = dbToAmplitude(settings.noiseFloorDb);
  const wantedDb = new Float32Array(rms.length);
  let held = staticGainDb;

  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < floor) {
      // A pause carries the gain of the speech around it. Recomputing one for
      // room tone would lift the hiss between sentences, and dropping to unity
      // would make every pause audibly change colour.
      wantedDb[i] = held;
      continue;
    }

    const desired = settings.targetDb - amplitudeToDb(rms[i]);
    held = Math.min(settings.maxBoostDb, Math.max(-settings.maxCutDb, desired));
    wantedDb[i] = held;
  }

  // Smoothed in both directions so the curve has no delay: a gain that lags the
  // signal ducks the start of every sentence and releases after it has ended,
  // which is exactly the pumping this is supposed to avoid.
  const window = Math.max(1, Math.round(settings.smoothingSeconds / secondsPerBucket));
  const smoothed = movingAverage(movingAverage(wantedDb, window), window);

  const gain = new Float32Array(smoothed.length);
  for (let i = 0; i < smoothed.length; i++) gain[i] = dbToAmplitude(smoothed[i]);

  return { gain, secondsPerBucket, duration, measuredDb, staticGainDb, clipped };
}

/**
 * The gain at one instant of the clip's own timeline.
 *
 * Interpolated between buckets rather than stepped: a bucket is a fraction of a
 * second, and a staircase in amplitude is audible as a series of clicks — the
 * same reason the fades elsewhere are computed per frame rather than per packet.
 */
export function gainAt(envelope: GainEnvelope, time: number): number {
  const { gain, secondsPerBucket } = envelope;
  if (gain.length === 1) return gain[0];

  const position = time / secondsPerBucket;
  if (!Number.isFinite(position) || position <= 0) return gain[0];
  if (position >= gain.length - 1) return gain[gain.length - 1];

  const index = Math.floor(position);
  const fraction = position - index;
  return gain[index] * (1 - fraction) + gain[index + 1] * fraction;
}

/** True when the envelope would leave the signal exactly as it is. */
export function isUnity(envelope: GainEnvelope): boolean {
  for (let i = 0; i < envelope.gain.length; i++) {
    if (Math.abs(envelope.gain[i] - 1) > 1e-3) return false;
  }
  return true;
}

/** Ceiling the limiter rounds off towards, one decibel below full scale. */
const LIMIT = 0.891;

/**
 * Rounds off a peak instead of letting it square off into distortion.
 *
 * Anything under the ceiling passes through untouched, so the limiter cannot
 * colour a signal that never needed it; above the ceiling the curve flattens
 * smoothly and can never reach 1.
 */
export function softLimit(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= LIMIT) return value;

  const excess = (magnitude - LIMIT) / (1 - LIMIT);
  const shaped = LIMIT + (1 - LIMIT) * Math.tanh(excess);
  return value < 0 ? -shaped : shaped;
}

/** One line describing what levelling did to a clip. */
export function describeLoudness(envelope: GainEnvelope | null, settings: LoudnessSettings): string {
  if (!settings.enabled) {
    return 'Brings every clip to the same speech level, and optionally evens out the drift inside each one.';
  }
  if (!envelope) return 'Nothing above the noise floor was found to measure.';

  const direction = envelope.staticGainDb >= 0 ? 'up' : 'down';
  const amount = Math.abs(Math.round(envelope.staticGainDb * 10) / 10);
  const measured = Math.round(envelope.measuredDb * 10) / 10;
  const limit = envelope.clipped ? ' (held back by the boost/cut limit)' : '';

  return `Speech measured at ${measured} dBFS, brought ${direction} by ${amount} dB${limit}.`;
}

// ---------------------------------------------------------------- internals

export function amplitudeToDb(amplitude: number): number {
  if (!(amplitude > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(amplitude));
}

export function dbToAmplitude(db: number): number {
  return Math.pow(10, db / 20);
}

/** Box filter with the ends held, so the curve does not sag at the edges. */
function movingAverage(values: Float32Array, window: number): Float32Array {
  if (window <= 1) return values;

  const output = new Float32Array(values.length);
  const half = Math.floor(window / 2);
  let sum = 0;

  // A running sum rather than a fresh loop per bucket: at a second and a half
  // of smoothing over a ten-hour recording the naive version is minutes of work.
  for (let i = -half; i <= half; i++) sum += values[clampIndex(i, values.length)];

  for (let i = 0; i < values.length; i++) {
    output[i] = sum / (half * 2 + 1);
    sum -= values[clampIndex(i - half, values.length)];
    sum += values[clampIndex(i + half + 1, values.length)];
  }

  return output;
}

function clampIndex(index: number, length: number): number {
  return Math.min(length - 1, Math.max(0, index));
}
