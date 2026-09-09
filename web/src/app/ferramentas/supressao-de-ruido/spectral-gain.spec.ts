import { APPLY_DEFAULTS, GainField, applyGains, fieldFromPair, frameSize, peak, smoothField, sqrtHann } from './spectral-gain';
import { resample, toMono } from './resample';

/** A field that says "keep everything", for the passthrough checks. */
function open(bins: number, frames: number, step = 0.016, bandwidth = 31.25): GainField {
  return { frames: Array.from({ length: frames }, () => new Float32Array(bins).fill(1)), step, bandwidth };
}

function tone(length: number, rate: number, hertz: number, level = 0.5): Float32Array {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index++) out[index] = level * Math.sin((2 * Math.PI * hertz * index) / rate);
  return out;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let total = 0;
  for (let index = from; index < to; index++) total += samples[index] ** 2;
  return Math.sqrt(total / Math.max(1, to - from));
}

describe('sqrtHann', () => {
  it('squares to a Hann window, which sums to one at half overlap', () => {
    const window = sqrtHann(64);
    for (let index = 0; index < 32; index++) {
      expect(window[index] ** 2 + window[index + 32] ** 2).toBeCloseTo(1, 5);
    }
  });
});

describe('frameSize', () => {
  it('is a power of two of roughly thirty milliseconds', () => {
    for (const rate of [16000, 22050, 44100, 48000, 96000]) {
      const size = frameSize(rate);
      expect(size & (size - 1)).toBe(0);
      expect(size / rate).toBeGreaterThan(0.012);
      expect(size / rate).toBeLessThan(0.09);
    }
  });
});

describe('smoothField', () => {
  it('opens quickly and closes slowly', () => {
    const field: GainField = { frames: [new Float32Array([0]), new Float32Array([1]), new Float32Array([0])], step: 0.016, bandwidth: 31.25 };
    const smoothed = smoothField(field, APPLY_DEFAULTS.attackMs, APPLY_DEFAULTS.releaseMs);

    expect(smoothed.frames[1][0]).toBeGreaterThan(0.8);
    expect(smoothed.frames[2][0]).toBeGreaterThan(0.6);
  });

  it("leaves the caller's own numbers alone", () => {
    const field = open(4, 3);
    const before = Array.from(field.frames[1]);
    smoothField(field, 1, 1);
    expect(Array.from(field.frames[1])).toEqual(before);
  });
});

describe('applyGains', () => {
  it('returns the recording unchanged when nothing is suppressed', () => {
    const rate = 48000;
    const input = tone(rate, rate, 440);
    const out = applyGains(input, rate, open(257, 80, 0.016, 31.25), { attenuationDb: 24 });

    // Away from the very edges, where the overlap is still filling in.
    let worst = 0;
    for (let index = 2048; index < input.length - 2048; index++) {
      worst = Math.max(worst, Math.abs(out[index] - input[index]));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('never turns anything down further than the strength allows', () => {
    const rate = 48000;
    const input = tone(rate, rate, 1000);
    const shut: GainField = { frames: Array.from({ length: 80 }, () => new Float32Array(257)), step: 0.016, bandwidth: 31.25 };

    for (const attenuationDb of [12, 24]) {
      const out = applyGains(input, rate, shut, { attenuationDb });
      const ratio = rms(out, 4096, input.length - 4096) / rms(input, 4096, input.length - 4096);
      const measured = -20 * Math.log10(ratio);
      expect(measured).toBeGreaterThan(attenuationDb - 2);
      expect(measured).toBeLessThan(attenuationDb + 2);
    }
  });

  it("reads the field at each bin's own frequency", () => {
    const rate = 48000;
    const bins = 257;
    const bandwidth = 16000 / 512;

    // Shut everything below 2 kHz, keep everything above it.
    const frames = Array.from({ length: 80 }, () => {
      const gains = new Float32Array(bins);
      for (let bin = 0; bin < bins; bin++) gains[bin] = bin * bandwidth < 2000 ? 0 : 1;
      return gains;
    });

    const low = tone(rate, rate, 400);
    const high = tone(rate, rate, 5000);
    const mixed = new Float32Array(rate);
    for (let index = 0; index < rate; index++) mixed[index] = low[index] + high[index];

    const out = applyGains(mixed, rate, { frames, step: 0.016, bandwidth }, { attenuationDb: 40 });
    const kept = rms(out, 8192, rate - 8192);
    const expected = rms(high, 8192, rate - 8192);

    expect(kept).toBeGreaterThan(expected * 0.9);
    expect(kept).toBeLessThan(expected * 1.1);
  });

  it('survives a field of a single frame and an empty recording', () => {
    expect(applyGains(new Float32Array(0), 48000, open(257, 4), { attenuationDb: 24 }).length).toBe(0);
    expect(applyGains(tone(4800, 48000, 440), 48000, open(257, 1), { attenuationDb: 24 }).length).toBe(4800);
  });
});

describe('fieldFromPair', () => {
  it('recovers the gain a denoiser applied', () => {
    const rate = 48000;
    const before = tone(rate, rate, 1000);
    const after = Float32Array.from(before, (value) => value * 0.25);
    const field = fieldFromPair(before, after, rate, 1024);

    const bin = Math.round((1000 * 1024) / rate);
    const middle = field.frames[Math.floor(field.frames.length / 2)];
    expect(middle[bin]).toBeCloseTo(0.25, 2);
    expect(field.bandwidth).toBeCloseTo(rate / 1024, 6);
  });

  it('keeps a silent band open rather than closing it on rounding noise', () => {
    const rate = 48000;
    const silence = new Float32Array(rate);
    const field = fieldFromPair(silence, silence, rate, 1024);
    expect(field.frames[2][100]).toBe(1);
  });
});

describe('peak and toMono', () => {
  it('measures the loudest sample either way up', () => {
    expect(peak(Float32Array.from([0.1, -0.9, 0.3]))).toBeCloseTo(0.9, 6);
  });

  it('averages channels', () => {
    const mono = toMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect(Array.from(mono)).toEqual([0.5, 0.5]);
  });
});

describe('resample', () => {
  it('keeps the length in proportion and the tone in place', () => {
    const input = tone(48000, 48000, 1000);
    const out = resample(input, 48000, 16000);

    expect(out.length).toBe(16000);

    // Zero crossings are the cheapest way to ask "is it still 1 kHz?". The
    // window below is 0.8 s long, so a 1 kHz tone rises through zero 800 times.
    let crossings = 0;
    for (let index = 1600; index < out.length - 1600; index++) {
      if (out[index - 1] <= 0 && out[index] > 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(795);
    expect(crossings).toBeLessThan(805);
  });

  it('returns the samples untouched when the rate already matches', () => {
    const input = tone(100, 16000, 440);
    expect(resample(input, 16000, 16000)).toBe(input);
  });
});
