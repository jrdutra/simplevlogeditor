import { splitOnQuiet } from './speech-recognizer';

const RATE = 16000;

/**
 * A recording of `seconds` seconds that is loud everywhere except in the
 * moments listed, each a fifth of a second of true silence.
 */
function speech(seconds: number, pauses: readonly number[] = []): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let at = 0; at < samples.length; at++) samples[at] = at % 2 ? 0.5 : -0.5;

  for (const pause of pauses) {
    const from = Math.round(pause * RATE);
    samples.fill(0, from, from + Math.round(0.2 * RATE));
  }

  return samples;
}

describe('splitOnQuiet', () => {
  it('leaves a short recording in one piece', () => {
    const windows = splitOnQuiet(speech(12), RATE);

    expect(windows.length).toBe(1);
    expect(windows[0].from).toBe(0);
    expect(windows[0].to).toBe(12 * RATE);
  });

  it('covers the whole recording with no gap and no overlap', () => {
    const windows = splitOnQuiet(speech(95, [27.5, 56, 84]), RATE);

    expect(windows[0].from).toBe(0);
    expect(windows[windows.length - 1].to).toBe(95 * RATE);

    for (let index = 1; index < windows.length; index++) {
      expect(windows[index].from).toBe(windows[index - 1].to);
    }
  });

  it('cuts in the pause rather than at the thirty second mark', () => {
    // The pause runs from 27.5 s to 27.7 s, so the seam belongs in the middle
    // of it — a tenth of a second either side is close enough.
    const windows = splitOnQuiet(speech(60, [27.5]), RATE);
    const seam = windows[0].to / RATE;

    expect(seam).toBeGreaterThan(27.5);
    expect(seam).toBeLessThan(27.7);
  });

  it('does not walk back further than the seam window allows', () => {
    // The only pause is twenty seconds in, well outside the six seconds a seam
    // may move. The cut must stay near thirty rather than chase it.
    const windows = splitOnQuiet(speech(60, [20]), RATE);
    const seam = windows[0].to / RATE;

    expect(seam).toBeGreaterThan(23.9);
    expect(seam).toBeLessThanOrEqual(30);
  });

  it('never emits an empty window', () => {
    // Thirty seconds exactly: the first window takes all of it and there is
    // nothing left for a second one.
    for (const seconds of [30, 30.001, 59.9, 60, 90]) {
      for (const window of splitOnQuiet(speech(seconds), RATE)) {
        expect(window.to).toBeGreaterThan(window.from);
      }
    }
  });

  it('holds together on silence from end to end', () => {
    const windows = splitOnQuiet(new Float32Array(70 * RATE), RATE);

    expect(windows[0].from).toBe(0);
    expect(windows[windows.length - 1].to).toBe(70 * RATE);
    for (const window of windows) expect(window.to).toBeGreaterThan(window.from);
  });
});
