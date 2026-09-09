import { cueWarnings, DEFAULT_SHAPE, shapeCues, spokenSeconds, srtTime, toVtt, wrap } from './subtitle-formats';

describe('subtitle export regressions', () => {
  it('carries rounded milliseconds into minutes and hours', () => {
    expect(srtTime(59.9999)).toBe('00:01:00,000');
    expect(srtTime(3599.9999)).toBe('01:00:00,000');
    expect(srtTime(NaN)).toBe('00:00:00,000');
  });
  it('does not overlap captions even when their starts are very close', () => {
    const cues = shapeCues([{ start: 1, end: 2, text: 'one' }, { start: 1.01, end: 3, text: 'two' }]);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
    expect(cues[0].end).toBeGreaterThan(cues[0].start);
  });
  it('sorts input, merges coincident cues and stays inside the media duration', () => {
    const cues = shapeCues([{ start: 2, end: 5, text: 'last' }, { start: 0, end: 1, text: 'a' },
      { start: 0, end: 1, text: 'b' }, { start: NaN, end: 4, text: 'invalid' }], DEFAULT_SHAPE, 3);
    expect(cues.map(c => c.text)).toEqual(['a\nb', 'last']);
    expect(cues.at(-1)!.end).toBe(3);
  });
  it('counts covered time once when raw ranges overlap', () => {
    expect(spokenSeconds([{ start: 0, end: 3, text: '' }, { start: 2, end: 4, text: '' }])).toBe(4);
  });
  it('exports escaped WebVTT with a valid header', () => {
    expect(toVtt([{ start: 0, end: 1, text: '<test> & text' }]))
      .toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n&lt;test&gt; &amp; text\n');
  });
  it('preserves Unicode code points when wrapping long words', () => {
    expect(wrap('😀'.repeat(10), 8)).toEqual(['😀'.repeat(8), '😀'.repeat(2)]);
  });
  it('flags readability without inventing a recognition confidence score', () => {
    expect(cueWarnings({ start: 0, end: 1, text: 'A very long caption that is difficult to read in one second' }).join(' ')).toContain('Fast reading');
  });
});
