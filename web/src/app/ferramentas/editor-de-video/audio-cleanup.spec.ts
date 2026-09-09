import { settingsForPreset } from '../cortador-de-silencio/silence-cutter-presets';
import { cleanName, cutSilences, joinRanges, windowStatistics } from './audio-cleanup';

/**
 * The parts of the cleanup that can be checked without a microphone.
 *
 * Deliberately not the noise remover: what "less noise" sounds like is a
 * judgement, and a spec asserting a particular gain curve would lock the
 * algorithm rather than its behaviour. What is checked here is everything that
 * has a right answer — how long the result is, which samples survive, and
 * whether the joins land where the arithmetic says.
 */

/** A signal that is loud for `loud` seconds, then quiet, then loud again. */
function speech(sampleRate: number, loud: number, quiet: number): Float32Array {
  const samples = new Float32Array(Math.round((loud * 2 + quiet) * sampleRate));
  const loudSamples = Math.round(loud * sampleRate);
  const quietStart = loudSamples;
  const quietEnd = quietStart + Math.round(quiet * sampleRate);

  for (let index = 0; index < samples.length; index++) {
    const inside = index >= quietStart && index < quietEnd;
    // A tone rather than a constant: RMS of a constant is the constant, which
    // would pass a threshold test that a real signal fails.
    samples[index] = inside ? 0 : Math.sin((index / sampleRate) * 2 * Math.PI * 440) * 0.5;
  }

  return samples;
}

describe('joining the kept ranges', () => {
  it('keeps exactly the samples inside the ranges when nothing is crossfaded', () => {
    const samples = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const [joined] = joinRanges([samples], 10, [{ start: 0, end: 0.3 }, { start: 0.7, end: 1 }], 0);

    expect(Array.from(joined)).toEqual([0, 1, 2, 7, 8, 9]);
  });

  /**
   * Each join costs one crossfade's worth of length, because the fade is the
   * stretch where both pieces are playing. Getting this wrong is how a cut
   * timeline ends up a few frames adrift of what the editor claimed.
   */
  it('gives up one fade per join', () => {
    const samples = new Float32Array(1000);
    const ranges = [
      { start: 0, end: 0.2 },
      { start: 0.4, end: 0.6 },
      { start: 0.8, end: 1 }
    ];

    const [plain] = joinRanges([samples], 1000, ranges, 0);
    const [faded] = joinRanges([samples], 1000, ranges, 0.01);

    expect(plain.length).toBe(600);
    expect(faded.length).toBe(600 - 2 * 10);
  });

  it('never lets a fade be longer than the piece it is joining', () => {
    const samples = new Float32Array(100);

    // Two-sample ranges with a one-second fade asked for: the fade has to
    // shrink to the range rather than producing a negative length.
    const [joined] = joinRanges([samples], 100, [{ start: 0, end: 0.02 }, { start: 0.5, end: 0.52 }], 1);

    expect(joined.length).toBeGreaterThan(0);
  });

  /**
   * The failure this was written for: a join as long as the segment it opens
   * left the write cursor where it started, so the segment after it faded into
   * the same stretch of output and painted over it. A short kept syllable
   * between two long ones simply vanished.
   */
  it('keeps a segment shorter than the crossfade', () => {
    const samples = new Float32Array(3000);
    samples.fill(0.5, 1000, 1050);

    const [joined] = joinRanges([samples], 1000, [
      { start: 0, end: 1 },
      { start: 1, end: 1.05 },
      { start: 2, end: 3 }
    ], 0.1);

    // Something of the middle segment survives into the output.
    expect(Array.from(joined).some((value) => Math.abs(value) > 0.1)).toBe(true);
    expect(joined.length).toBe(1000 + (50 - 50 + 1) + (1000 - 1));
  });

  it('returns nothing when nothing was kept', () => {
    const [joined] = joinRanges([new Float32Array(100)], 100, [], 0.005);

    expect(joined.length).toBe(0);
  });

  it('crossfades rather than stepping', () => {
    const first = new Float32Array(20).fill(1);
    const second = new Float32Array(20).fill(-1);
    const samples = Float32Array.from([...first, ...second]);

    const [joined] = joinRanges([samples], 20, [{ start: 0, end: 1 }, { start: 1, end: 2 }], 0.2);

    // Somewhere in the overlap the two must meet, which a hard cut never does.
    expect(Math.min(...Array.from(joined).map(Math.abs))).toBeLessThan(0.5);
  });
});

describe('the window statistics handed to the detector', () => {
  it('measures the RMS of each window per channel', () => {
    const left = new Float32Array(1000).fill(0.5);
    const right = new Float32Array(1000).fill(0);

    const stats = windowStatistics([left, right], 1000, 100);

    expect(stats.channelCount).toBe(2);
    expect(stats.windowCount).toBe(10);
    expect(stats.windowSeconds).toBeCloseTo(0.1, 6);
    expect(stats.duration).toBeCloseTo(1, 6);
    expect(stats.rms[0]).toBeCloseTo(0.5, 5);
    expect(stats.rms[1]).toBeCloseTo(0, 5);
  });
});

describe('cutting the silences out', () => {
  it('removes the pause and keeps the speech', () => {
    const sampleRate = 8000;
    const samples = speech(sampleRate, 1, 2);

    const [cut] = cutSilences([samples], sampleRate, settingsForPreset('aggressive'));

    const seconds = cut.length / sampleRate;
    expect(seconds).toBeLessThan(4 - 1);
    expect(seconds).toBeGreaterThan(1.5);
  });

  it('leaves a recording with no pauses in it alone', () => {
    const sampleRate = 8000;
    const samples = speech(sampleRate, 1, 0);

    const [cut] = cutSilences([samples], sampleRate, settingsForPreset('aggressive'));

    expect(cut.length / sampleRate).toBeCloseTo(samples.length / sampleRate, 1);
  });

  it('survives being handed nothing', () => {
    expect(cutSilences([], 48000, settingsForPreset('balanced'))).toEqual([]);
  });
});

describe('naming the result', () => {
  it('always ends up a wav', () => {
    expect(cleanName('narration.webm')).toBe('narration.wav');
    expect(cleanName('holiday')).toBe('holiday.wav');
    expect(cleanName('  ')).toBe('narration.wav');
    expect(cleanName('a.b.mp3')).toBe('a.b.wav');
  });
});
