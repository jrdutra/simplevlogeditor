import { groupWords, isDigitalSilence, normalizeChunks, ownedWords, recognitionWindows } from './recognition-timing';
import { downmix, readSpeechAudio } from './speech-recognizer';

describe('recognition timing and signal integrity', () => {
  it('keeps context around seams without exceeding the model window', () => {
    const windows = recognitionWindows(95 * 16000, 16000);
    expect(windows[0].keepFrom).toBe(0);
    expect(windows.at(-1)!.keepTo).toBe(95 * 16000);
    windows.forEach((window, index) => {
      expect(window.to - window.from).toBeLessThanOrEqual(30 * 16000);
      if (index) {
        expect(window.keepFrom).toBe(windows[index - 1].keepTo);
        expect(window.from).toBeLessThan(windows[index - 1].to);
      }
    });
  });
  it('handles null ends and invalid bounds without shifting the timeline', () => {
    expect(normalizeChunks([{ text: 'hello', timestamp: [2, null] }], 24, 6))
      .toEqual([{ start: 26, end: 30, text: 'hello' }]);
    expect(normalizeChunks([{ text: 'hello', timestamp: [-2, 99] }], 24, 6))
      .toEqual([{ start: 24, end: 30, text: 'hello' }]);
    expect(normalizeChunks([{ text: 'outside', timestamp: [99, 100] }], 24, 6)).toEqual([]);
  });
  it('assigns boundary words to one core and preserves intentional repetitions', () => {
    const windows = recognitionWindows(48, 1);
    const words = [{ start: 23.8, end: 24.2, text: 'yes' }, { start: 24.3, end: 24.8, text: 'yes' }];
    expect(ownedWords(words, windows[0], 1)).toEqual([]);
    expect(ownedWords(words, windows[1], 1)).toEqual(words);
  });
  it('groups using actual word timing and breaks at pauses', () => {
    const words = [{ start: 1, end: 1.3, text: 'Hello' }, { start: 1.4, end: 2, text: 'world.' },
      { start: 4, end: 5, text: 'Next' }];
    expect(groupWords(words)).toEqual([{ start: 1, end: 2, text: 'Hello world.' }, words[2]]);
  });
  it('does not confuse quiet audio with digital silence', () => {
    expect(isDigitalSilence(new Float32Array(100))).toBeTrue();
    expect(isDigitalSilence(new Float32Array([0, 1e-8]))).toBeFalse();
  });
  it('retains speech in opposite-polarity stereo and ignores nonfinite samples', () => {
    expect([...downmix(new Float32Array([0.5, -0.5, -0.5, 0.5]), 2)]).toEqual([0.5, -0.5]);
    expect([...downmix(new Float32Array([0.5, 0.5, NaN, Infinity]), 2)]).toEqual([0.5, 0]);
  });
  it('resamples a real WAV across block seams without losing the timeline', async () => {
    const rate = 48000, seconds = 10.2, count = Math.round(rate * seconds);
    const bytes = new ArrayBuffer(44 + count * 2);
    const view = new DataView(bytes);
    const text = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, i < rate ? 0 : Math.round(10000 * Math.sin(2 * Math.PI * 440 * i / rate)), true);
    const audio = await readSpeechAudio(new File([bytes], 'tone.wav'), () => {}, new AbortController().signal);
    expect(audio.length).toBe(Math.ceil(seconds * 16000));
    expect(Math.max(...audio.subarray(0, 15000))).toBe(0);
    for (const from of [16000, 159900, 160000]) {
      const rms = Math.sqrt(audio.subarray(from, from + 100).reduce((sum, value) => sum + value * value, 0) / 100);
      expect(rms).toBeGreaterThan(0.19);
      expect(rms).toBeLessThan(0.24);
    }
  });
});
