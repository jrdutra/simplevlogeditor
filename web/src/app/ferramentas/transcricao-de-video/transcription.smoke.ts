/** Optional network integration test. Run explicitly; downloads the Tiny model.
 * Public JFK sample supplied by the Transformers.js documentation dataset. */
import { readSpeechAudio, transcribe, TranscriptionCanceled } from './speech-recognizer';

describe('real browser speech recognition', () => {
  it('recognizes public speech with word timestamps through the worker', async () => {
    const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
    expect(response.ok).toBeTrue();
    const controller = new AbortController();
    const samples = await readSpeechAudio(new File([await response.blob()], 'jfk.wav'), () => {}, controller.signal);
    const duration = samples.length / 16000;
    let partialCount = 0;
    const cues = await transcribe(samples, { model: 'onnx-community/whisper-tiny_timestamped', language: 'english' },
      () => {}, controller.signal, words => { partialCount = words.length; });
    const text = cues.map(cue => cue.text).join(' ').toLowerCase();
    expect(text).toContain('country');
    expect(text).toContain('you');
    expect(cues.length).toBeGreaterThan(10);
    expect(partialCount).toBe(cues.length);
    for (const cue of cues) {
      expect(cue.start).toBeGreaterThanOrEqual(0);
      expect(cue.end).toBeGreaterThan(cue.start);
      expect(cue.end).toBeLessThanOrEqual(duration);
    }
    console.info('Real Whisper transcript:', text);
  }, 240000);

  it('runs the default Small model across multiple audio windows', async () => {
    const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
    const controller = new AbortController();
    const audio = await readSpeechAudio(new File([await response.blob()], 'jfk.wav'), () => {}, controller.signal);
    const repeated = new Float32Array(audio.length * 3);
    for (let index = 0; index < 3; index++) repeated.set(audio, index * audio.length);
    const words = await transcribe(repeated, { model: 'onnx-community/whisper-small_timestamped', language: 'english' },
      () => {}, controller.signal);
    const normalize = (text: string) => text.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/);
    const reference = normalize(('And so my fellow Americans ask not what your country can do for you ask what you can do for your country ').repeat(3));
    const actual = normalize(words.map(word => word.text).join(' '));
    // Levenshtein word error rate = (substitutions + deletions + insertions) / reference words.
    let row = Array.from({ length: actual.length + 1 }, (_, index) => index);
    reference.forEach((word, index) => {
      const next = [index + 1];
      actual.forEach((other, at) => next.push(Math.min(next[at] + 1, row[at + 1] + 1, row[at] + Number(word !== other))));
      row = next;
    });
    const wer = row[actual.length] / reference.length;
    console.info('Small repeated public fixture WER:', wer, 'Transcript:', actual.join(' '));
    expect(wer).toBeLessThan(0.15);
    expect(words.at(-1)!.end).toBeGreaterThan(audio.length * 2 / 16000);
  }, 240000);

  it('cancels a worker immediately and rejects without waiting for inference', async () => {
    const controller = new AbortController();
    const job = transcribe(new Float32Array(16000).fill(0.1),
      { model: 'onnx-community/whisper-tiny_timestamped', language: 'english' }, () => {}, controller.signal);
    controller.abort();
    await expectAsync(job).toBeRejectedWith(jasmine.any(TranscriptionCanceled));
  });
});
