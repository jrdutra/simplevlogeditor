import { DEFAULT_LOUDNESS, LoudnessSettings, amplitudeToDb } from '../../shared/media/loudness';
import { BUCKET_SECONDS, applyLevelling, bucketRms, planLevelling } from './levelling';

const RATE = 48000;

/** Speech-shaped enough for a level meter: a tone at a chosen amplitude. */
function speech(seconds: number, amplitude: number, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let index = 0; index < out.length; index++) {
    out[index] = amplitude * Math.sin((2 * Math.PI * 300 * index) / rate);
  }
  return out;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let total = 0;
  for (let index = from; index < to; index++) total += samples[index] ** 2;
  return Math.sqrt(total / Math.max(1, to - from));
}

function settings(change: Partial<LoudnessSettings> = {}): LoudnessSettings {
  return { ...DEFAULT_LOUDNESS, enabled: true, ...change };
}

describe('bucketRms', () => {
  it('measures one number per bucket of the stated length', () => {
    const rmsValues = bucketRms(speech(1, 0.5), RATE);
    expect(rmsValues.length).toBe(Math.ceil(1 / BUCKET_SECONDS));

    // A sine of amplitude a has an RMS of a divided by root two.
    for (const value of rmsValues) expect(value).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('reports silence as zero rather than as a small number', () => {
    expect(bucketRms(new Float32Array(RATE), RATE).every((value) => value === 0)).toBeTrue();
  });
});

describe('planLevelling', () => {
  it('does nothing at all when it is switched off', () => {
    expect(planLevelling(speech(1, 0.05), RATE, settings({ enabled: false }))).toBeNull();
  });

  it('refuses to invent a level for a recording with nothing above the floor', () => {
    expect(planLevelling(new Float32Array(RATE), RATE, settings())).toBeNull();
  });

  // Amplitudes chosen to sit inside the default lift and hold limits of 12 dB;
  // the limits themselves are the subject of the two tests after these.
  it('brings quiet speech up to the target', () => {
    const quiet = speech(4, 0.05);
    const plan = planLevelling(quiet, RATE, settings({ mode: 'match', targetDb: -20 }));

    expect(plan).not.toBeNull();
    applyLevelling(quiet, RATE, plan!, false);
    expect(amplitudeToDb(rms(quiet))).toBeCloseTo(-20, 1);
  });

  it('holds loud speech back to the target', () => {
    const loud = speech(4, 0.3);
    const plan = planLevelling(loud, RATE, settings({ mode: 'match', targetDb: -20 }));

    applyLevelling(loud, RATE, plan!, false);
    expect(amplitudeToDb(rms(loud))).toBeCloseTo(-20, 1);
  });

  it('never holds back further than the cut limit allows', () => {
    const loud = speech(4, 0.7);
    const plan = planLevelling(loud, RATE, settings({ mode: 'match', targetDb: -20, maxCutDb: 12 }));

    expect(plan!.envelope.clipped).toBeTrue();
    expect(plan!.envelope.staticGainDb).toBeCloseTo(-12, 6);
  });

  it('never lifts further than the boost limit allows', () => {
    const tiny = speech(4, 0.001);
    const plan = planLevelling(tiny, RATE, settings({ mode: 'match', targetDb: -6, maxBoostDb: 6, noiseFloorDb: -80 }));

    expect(plan!.envelope.clipped).toBeTrue();
    expect(plan!.envelope.staticGainDb).toBeCloseTo(6, 6);
  });
});

describe('applyLevelling', () => {
  it('follows a speaker who drifts, without touching the pause between them', () => {
    // Loud for two seconds, then quiet for two, with the level mode on.
    const drifting = new Float32Array(4 * RATE);
    drifting.set(speech(2, 0.4), 0);
    drifting.set(speech(2, 0.04), 2 * RATE);

    const plan = planLevelling(drifting, RATE, settings({ mode: 'level', targetDb: -20, smoothingSeconds: 0.3 }));
    applyLevelling(drifting, RATE, plan!, false);

    const first = amplitudeToDb(rms(drifting, Math.round(0.6 * RATE), Math.round(1.4 * RATE)));
    const second = amplitudeToDb(rms(drifting, Math.round(2.6 * RATE), Math.round(3.4 * RATE)));

    expect(first).toBeCloseTo(-20, 0);
    expect(second).toBeCloseTo(-20, 0);
  });

  it('keeps the two halves of a stereo pair in step', () => {
    const left = speech(3, 0.05);
    const right = Float32Array.from(left, (value) => value * 0.5);
    const plan = planLevelling(left, RATE, settings({ mode: 'match' }));

    applyLevelling(left, RATE, plan!, false);
    applyLevelling(right, RATE, plan!, false);

    // Right was six decibels below left before, and must still be after.
    expect(amplitudeToDb(rms(left)) - amplitudeToDb(rms(right))).toBeCloseTo(6.02, 1);
  });

  it('keeps a boosted recording inside full scale when the limiter is on', () => {
    const quiet = speech(2, 0.3);
    const plan = planLevelling(quiet, RATE, settings({ mode: 'match', targetDb: -3, maxBoostDb: 30 }));

    applyLevelling(quiet, RATE, plan!, true);
    for (const value of quiet) expect(Math.abs(value)).toBeLessThan(1);
  });
});
