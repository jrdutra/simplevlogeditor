import { DEFAULT_SETTINGS, clampSettings, presetFor } from './silence-cutter-presets';
import {
  amplitudeToDb,
  complementRanges,
  detectSilence,
  keepRangesFor,
  normalizeRanges,
  reduceChannels,
  totalDuration,
  MIN_DB
} from './silence-detector';
import { WindowStatistics } from './silence-detector';
import { SilenceSettings, detectionSettingsChanged } from './silence-cutter.models';

/**
 * Builds window statistics from a written description of the signal.
 *
 * `'#'` is a loud window and `'.'` a silent one, one character per window, which
 * makes each case readable as the shape it is testing rather than as an array
 * of magic numbers.
 */
function statsFrom(pattern: string, windowSeconds = 0.02, channelCount = 1): WindowStatistics {
  const windowCount = pattern.length;
  const rms = new Float32Array(windowCount * channelCount);

  for (let w = 0; w < windowCount; w++) {
    // 0.5 is about -6 dBFS; 0.0001 is about -80 dBFS.
    const value = pattern[w] === '#' ? 0.5 : 0.0001;
    for (let c = 0; c < channelCount; c++) rms[w * channelCount + c] = value;
  }

  return { rms, channelCount, windowCount, windowSeconds, duration: windowCount * windowSeconds };
}

const NO_PADDING: SilenceSettings = {
  ...DEFAULT_SETTINGS,
  keepBeforeMs: 0,
  keepAfterMs: 0,
  minimumKeptSegmentMs: 0
};

describe('amplitudeToDb', () => {
  it('maps full scale to 0 dBFS', () => {
    expect(amplitudeToDb(1)).toBeCloseTo(0, 6);
  });

  it('maps half amplitude to about -6 dBFS', () => {
    expect(amplitudeToDb(0.5)).toBeCloseTo(-6.02, 1);
  });

  it('floors digital silence instead of returning -Infinity', () => {
    expect(amplitudeToDb(0)).toBe(MIN_DB);
    expect(Number.isFinite(amplitudeToDb(0))).toBe(true);
  });
});

describe('reduceChannels', () => {
  const rms = Float32Array.from([0.5, 0.001]);

  it('combines the energy of every channel', () => {
    expect(reduceChannels(rms, 0, 2, 'combined')).toBeCloseTo(Math.sqrt((0.25 + 0.000001) / 2), 6);
  });

  it('uses the quietest channel when any channel may signal silence', () => {
    expect(reduceChannels(rms, 0, 2, 'any')).toBeCloseTo(0.001, 6);
  });

  it('uses the loudest channel when every channel must fall quiet', () => {
    expect(reduceChannels(rms, 0, 2, 'all')).toBeCloseTo(0.5, 6);
  });
});

describe('normalizeRanges', () => {
  it('sorts, clamps and merges overlapping ranges', () => {
    const merged = normalizeRanges(
      [{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 2.5, end: 4 }, { start: 9, end: 20 }],
      10
    );

    expect(merged).toEqual([{ start: 1, end: 4 }, { start: 5, end: 7 }, { start: 9, end: 10 }]);
  });

  it('drops empty and inverted ranges', () => {
    expect(normalizeRanges([{ start: 3, end: 3 }, { start: 5, end: 2 }], 10)).toEqual([]);
  });
});

describe('complementRanges', () => {
  it('returns what the ranges do not cover', () => {
    expect(complementRanges([{ start: 2, end: 4 }], 10)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 10 }
    ]);
  });

  it('returns nothing when the ranges cover everything', () => {
    expect(complementRanges([{ start: 0, end: 10 }], 10)).toEqual([]);
  });
});

describe('detectSilence', () => {
  it('finds a pause that is long enough', () => {
    // 10 loud windows, 40 silent (0.8 s), 10 loud — at 20 ms per window.
    const stats = statsFrom('#'.repeat(10) + '.'.repeat(40) + '#'.repeat(10));
    const { silenceRanges } = detectSilence(stats, NO_PADDING);

    expect(silenceRanges.length).toBe(1);
    expect(silenceRanges[0].start).toBeCloseTo(0.2, 6);
    expect(silenceRanges[0].end).toBeCloseTo(1.0, 6);
    expect(silenceRanges[0].source).toBe('automatic');
    expect(silenceRanges[0].enabled).toBe(true);
  });

  it('preserves a pause shorter than the minimum duration', () => {
    // 10 silent windows is 0.2 s, well under the 0.6 s default.
    const stats = statsFrom('#'.repeat(10) + '.'.repeat(10) + '#'.repeat(10));
    expect(detectSilence(stats, NO_PADDING).silenceRanges).toEqual([]);
  });

  it('shrinks the silence by the speech margins', () => {
    const stats = statsFrom('#'.repeat(10) + '.'.repeat(40) + '#'.repeat(10));
    const { silenceRanges } = detectSilence(stats, {
      ...NO_PADDING,
      keepAfterMs: 100,
      keepBeforeMs: 200
    });

    // The margins are taken out of the silence, never out of the speech.
    expect(silenceRanges[0].start).toBeCloseTo(0.3, 6);
    expect(silenceRanges[0].end).toBeCloseTo(0.8, 6);
  });

  it('never pads past the start or the end of the media', () => {
    const stats = statsFrom('.'.repeat(40) + '#'.repeat(10) + '.'.repeat(40));
    const { silenceRanges } = detectSilence(stats, {
      ...NO_PADDING,
      keepAfterMs: 200,
      keepBeforeMs: 200
    });

    expect(silenceRanges[0].start).toBe(0);
    expect(silenceRanges[silenceRanges.length - 1].end).toBeCloseTo(stats.duration, 6);
  });

  it('absorbs a fragment trapped between two pauses', () => {
    // 0.8 s silence, 0.1 s of audio, 0.8 s silence: the fragment is shorter
    // than the 250 ms minimum kept segment and joins the cut.
    const stats = statsFrom('#'.repeat(5) + '.'.repeat(40) + '#'.repeat(5) + '.'.repeat(40) + '#'.repeat(5));
    const { silenceRanges } = detectSilence(stats, { ...NO_PADDING, minimumKeptSegmentMs: 250 });

    expect(silenceRanges.length).toBe(1);
    expect(silenceRanges[0].start).toBeCloseTo(0.1, 6);
    expect(silenceRanges[0].end).toBeCloseTo(1.8, 6);
  });

  it('keeps the fragment when the minimum kept segment allows it', () => {
    const stats = statsFrom('#'.repeat(5) + '.'.repeat(40) + '#'.repeat(5) + '.'.repeat(40) + '#'.repeat(5));
    expect(detectSilence(stats, { ...NO_PADDING, minimumKeptSegmentMs: 0 }).silenceRanges.length).toBe(2);
  });

  it('produces kept ranges that complement the silences exactly', () => {
    const stats = statsFrom('#'.repeat(10) + '.'.repeat(40) + '#'.repeat(10));
    const { silenceRanges, keepRanges } = detectSilence(stats, NO_PADDING);

    expect(totalDuration(silenceRanges) + totalDuration(keepRanges)).toBeCloseTo(stats.duration, 6);
    for (const range of keepRanges) expect(range.end).toBeGreaterThan(range.start);
  });

  it('reports the loudest window it measured', () => {
    const stats = statsFrom('#'.repeat(10) + '.'.repeat(40));
    expect(detectSilence(stats, NO_PADDING).peakDb).toBeCloseTo(-6.02, 1);
  });

  it('detects nothing when the threshold sits below the noise floor', () => {
    const stats = statsFrom('#'.repeat(10) + '.'.repeat(40) + '#'.repeat(10));
    expect(detectSilence(stats, { ...NO_PADDING, thresholdDb: -90 }).silenceRanges).toEqual([]);
  });

  it('treats the whole file as silence when the threshold sits above the signal', () => {
    const stats = statsFrom('#'.repeat(60));
    const { silenceRanges, keepRanges } = detectSilence(stats, { ...NO_PADDING, thresholdDb: -3 });

    expect(silenceRanges.length).toBe(1);
    expect(keepRanges).toEqual([]);
  });
});

describe('keepRangesFor', () => {
  it('ignores ranges the reader disabled', () => {
    const ranges = [
      { start: 1, end: 2, source: 'automatic' as const, enabled: true },
      { start: 4, end: 5, source: 'automatic' as const, enabled: false }
    ];

    expect(keepRangesFor(ranges, 10)).toEqual([{ start: 0, end: 1 }, { start: 2, end: 10 }]);
  });
});

describe('analysis invalidation', () => {
  it('flags a change to any detection setting', () => {
    const base = { ...DEFAULT_SETTINGS };
    expect(detectionSettingsChanged(base, { ...base, thresholdDb: -35 })).toBe(true);
    expect(detectionSettingsChanged(base, { ...base, minimumSilenceMs: 900 })).toBe(true);
    expect(detectionSettingsChanged(base, { ...base, keepBeforeMs: 40 })).toBe(true);
    expect(detectionSettingsChanged(base, { ...base, keepAfterMs: 40 })).toBe(true);
    expect(detectionSettingsChanged(base, { ...base, minimumKeptSegmentMs: 10 })).toBe(true);
    expect(detectionSettingsChanged(base, { ...base, detectionWindowMs: 50 })).toBe(true);
    expect(detectionSettingsChanged(base, { ...base, channelMode: 'all' })).toBe(true);
  });

  it('does not flag the crossfade, which is applied while rendering', () => {
    const base = { ...DEFAULT_SETTINGS };
    expect(detectionSettingsChanged(base, { ...base, crossfadeMs: 20 })).toBe(false);
  });
});

describe('presets', () => {
  it('recognises its own presets', () => {
    expect(presetFor(DEFAULT_SETTINGS)).toBe('balanced');
  });

  it('reports a hand-tuned value as custom', () => {
    expect(presetFor({ ...DEFAULT_SETTINGS, thresholdDb: -37 })).toBe('custom');
  });

  it('stays on the preset when only the crossfade changed', () => {
    expect(presetFor({ ...DEFAULT_SETTINGS, crossfadeMs: 20 })).toBe('balanced');
  });

  it('clamps values outside the allowed range', () => {
    const clamped = clampSettings({ ...DEFAULT_SETTINGS, thresholdDb: 40, minimumSilenceMs: -5 });
    expect(clamped.thresholdDb).toBe(-20);
    expect(clamped.minimumSilenceMs).toBe(100);
  });
});
