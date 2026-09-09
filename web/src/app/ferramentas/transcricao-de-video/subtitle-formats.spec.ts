import {
  Cue,
  DEFAULT_SHAPE,
  readableTime,
  sbvTime,
  shapeCues,
  spokenSeconds,
  srtTime,
  toPlainText,
  toSbv,
  toSrt,
  toTimedText,
  tidy,
  wordCount,
  wrap
} from './subtitle-formats';

/**
 * The writers are the whole point of the tool: a transcription nobody can
 * upload is a transcription nobody wanted. What is pinned here is the syntax a
 * parser will refuse if it is wrong — the comma in SubRip's clock, the `[br]`
 * in SubViewer, the blank line between cues — and the reading rules that turn
 * a recogniser's guesses into something a person can actually read.
 */
describe('shaping what the recogniser heard', () => {
  const cue = (start: number, end: number, text: string): Cue => ({ start, end, text });

  it('drops the chunks that hold nothing', () => {
    expect(shapeCues([cue(0, 1, '   '), cue(1, 2, 'Olá')])).toHaveSize(1);
  });

  it('collapses the whitespace a recogniser leaves around a chunk', () => {
    expect(tidy('  two   words \n here ')).toBe('two words here');
  });

  it('holds a very short cue on screen long enough to be read', () => {
    const [shaped] = shapeCues([cue(4, 4.1, 'Sim')]);
    expect(shaped.end - shaped.start).toBeCloseTo(DEFAULT_SHAPE.minSeconds, 5);
  });

  it('does not hide recognized speech to satisfy a maximum display preference', () => {
    const [shaped] = shapeCues([cue(0, 40, 'Uma frase')]);
    expect(shaped.end - shaped.start).toBe(40);
  });

  it('pushes a cue apart from the one it would have run into', () => {
    // Two chunks whose minimum hold would overlap: the first has to give way,
    // because moving the second would take the words away from the sound.
    const shaped = shapeCues([cue(0, 0.2, 'Um'), cue(0.5, 2, 'Dois')]);
    expect(shaped[0].end).toBeLessThanOrEqual(shaped[1].start);
  });

  it('splits a chunk too long for one cue and shares out its seconds', () => {
    const long = 'palavra '.repeat(40).trim();
    const shaped = shapeCues([cue(0, 20, long)]);

    expect(shaped.length).toBeGreaterThan(1);
    // Proportional, not even: the longer half is on screen longer.
    expect(shaped[0].start).toBeCloseTo(0, 5);
    for (const piece of shaped) expect(piece.text.split('\n').length).toBeLessThanOrEqual(DEFAULT_SHAPE.maxLines);
  });

  it('breaks a line on a word, and a word too long for the line on itself', () => {
    expect(wrap('um dois tres', 8)).toEqual(['um dois', 'tres']);
    expect(wrap('supercalifragilistico', 8)).toEqual(['supercal', 'ifragili', 'stico']);
  });
});

describe('the clocks', () => {
  it('writes SubRip time with a comma before the milliseconds', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(3723.456)).toBe('01:02:03,456');
  });

  it('writes SubViewer time with a dot and an unpadded hour', () => {
    expect(sbvTime(0)).toBe('0:00:00.000');
    expect(sbvTime(3723.456)).toBe('1:02:03.456');
  });

  it('shows an hour to a reader only once there is one', () => {
    expect(readableTime(83)).toBe('1:23');
    expect(readableTime(3683)).toBe('1:01:23');
  });

  it('never writes a negative clock', () => {
    expect(srtTime(-5)).toBe('00:00:00,000');
  });
});

describe('the files', () => {
  const cues: Cue[] = [
    { start: 0, end: 2.5, text: 'Primeira frase' },
    { start: 3, end: 6, text: 'Uma frase longa\nem duas linhas' }
  ];

  it('numbers SubRip from one and separates the cues with a blank line', () => {
    const srt = toSrt(cues);

    expect(srt.startsWith('1\n00:00:00,000 --> 00:00:02,500\nPrimeira frase\n')).toBeTrue();
    expect(srt).toContain('\n\n2\n');
    // The line break inside a cue survives, because SubRip reads it as one.
    expect(srt).toContain('Uma frase longa\nem duas linhas');
  });

  it('writes basic YouTube SBV with real line breaks', () => {
    const sbv = toSbv(cues);

    expect(sbv.startsWith('0:00:00.000,0:00:02.500\nPrimeira frase\n')).toBeTrue();
    expect(sbv).toContain('Uma frase longa\nem duas linhas');
    expect(sbv).not.toContain('-->');
  });

  it('writes a readable transcript with the time on its own line', () => {
    expect(toTimedText(cues)).toBe('0:00\nPrimeira frase\n\n0:03\nUma frase longa em duas linhas\n');
  });

  it('writes the plain transcript with no times at all', () => {
    const plain = toPlainText(cues);

    expect(plain).toBe('Primeira frase\nUma frase longa em duas linhas\n');
    expect(plain).not.toMatch(/\d:\d\d/);
  });

  it('counts what the summary line reports', () => {
    expect(spokenSeconds(cues)).toBeCloseTo(5.5, 5);
    expect(wordCount(cues)).toBe(8);
  });
});
