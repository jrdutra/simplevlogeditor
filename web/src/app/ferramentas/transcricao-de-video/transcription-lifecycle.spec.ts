import { transcriptionSamples, transcriptionStep } from './transcription-lifecycle';
import { TranscriptionCanceled } from './transcription-errors';

describe('cancellable transcription waits', () => {
  it('rejects an unresolved metadata read immediately on cancellation', async () => {
    const controller = new AbortController();
    const stop = jasmine.createSpy('dispose input');
    const task = transcriptionStep(() => new Promise(() => {}), { signal: controller.signal,
      stage: 'probing-audio-track', timeoutMs: 60000, stop });
    controller.abort();
    await expectAsync(task).toBeRejectedWith(jasmine.any(TranscriptionCanceled));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('names the exact stalled stage and timeout without advertising an automatic replay', async () => {
    const stop = jasmine.createSpy('stop');
    const task = transcriptionStep(() => new Promise(() => {}), { signal: new AbortController().signal,
      stage: 'decoding-aac-audio', timeoutMs: 10, stop });
    await expectAsync(task).toBeRejectedWith(jasmine.objectContaining({ code: 'transcription_stalled',
      stage: 'decoding-aac-audio', recoverable: false, details: { timeoutMs: 10 } }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('closes a decoder sample that arrives after cancellation without waiting for iterator.return', async () => {
    const controller = new AbortController();
    let finish!: (value: IteratorResult<{ close(): void }>) => void;
    const close = jasmine.createSpy('sample.close');
    const samples = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<{ close(): void }>>(resolve => finish = resolve),
      return: () => new Promise<IteratorResult<{ close(): void }>>(() => {}) }) };
    const iterator = transcriptionSamples(samples, { signal: controller.signal, stage: 'reading', timeoutMs: 60000, stop: () => {} });
    const next = iterator.next();
    await Promise.resolve();
    controller.abort();
    await expectAsync(next).toBeRejectedWith(jasmine.any(TranscriptionCanceled));
    finish({ done: false, value: { close } });
    await Promise.resolve(); await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not begin a decoder task when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const task = jasmine.createSpy('read').and.resolveTo('audio');
    await expectAsync(transcriptionStep(task, { signal: controller.signal, stage: 'reading', timeoutMs: 1000 }))
      .toBeRejectedWith(jasmine.any(TranscriptionCanceled));
    expect(task).not.toHaveBeenCalled();
  });
});
