import { transcribe } from './transcription-client';

describe('recognition worker lifecycle', () => {
  let worker: any;
  beforeEach(() => {
    worker = { postMessage: jasmine.createSpy('postMessage'), terminate: jasmine.createSpy('terminate') };
    spyOn(window, 'Worker').and.callFake(function () { return worker; });
  });

  it('reports startup immediately and terminates a worker that sends no progress', async () => {
    const report = jasmine.createSpy('progress');
    const task = transcribe(new Float32Array(16000), { model: 'small', language: 'portuguese', stageTimeoutMs: 10 }, report, new AbortController().signal);
    expect(report).toHaveBeenCalledWith(jasmine.objectContaining({ stage: 'worker-startup' }));
    await expectAsync(task).toBeRejectedWith(jasmine.objectContaining({ code: 'transcription_stalled', stage: 'worker-startup' }));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('names worker creation failures and keeps their original cause', async () => {
    const cause = new Error('worker blocked by security policy');
    (window.Worker as unknown as jasmine.Spy).and.throwError(cause);
    await expectAsync(transcribe(new Float32Array(16000), { model: 'small', language: '' }, () => {}, new AbortController().signal))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'worker_startup_failed', stage: 'worker-startup', cause, recoverable: false }));
  });

  it('does not keep a job alive with identical download notifications', async () => {
    const task = transcribe(new Float32Array(16000), { model: 'small', language: '', stageTimeoutMs: 30 }, () => {}, new AbortController().signal);
    const event = { data: { type: 'progress', progress: { stage: 'downloading', ratio: .2, detail: 'encoder.onnx' } } };
    worker.onmessage(event);
    const repeats = setInterval(() => worker.onmessage(event), 5);
    await expectAsync(task).toBeRejectedWith(jasmine.objectContaining({ code: 'transcription_stalled', stage: 'downloading' }));
    clearInterval(repeats);
  });

  it('cancels a model download immediately and releases the worker', async () => {
    const controller = new AbortController();
    const task = transcribe(new Float32Array(16000), { model: 'small', language: '' }, () => {}, controller.signal);
    worker.onmessage({ data: { type: 'progress', progress: { stage: 'downloading', ratio: .1, detail: 'decoder.onnx' } } });
    controller.abort();
    await expectAsync(task).toBeRejectedWith(jasmine.objectContaining({ code: 'cancelled' }));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('retains aligned words and partial output on successful completion', async () => {
    const words = [{ start: .2, end: .8, text: 'Olá' }];
    const partial = jasmine.createSpy('partial');
    const task = transcribe(new Float32Array(16000), { model: 'small', language: 'portuguese' }, () => {}, new AbortController().signal, partial);
    worker.onmessage({ data: { type: 'partial', words } });
    worker.onmessage({ data: { type: 'done', words } });
    await expectAsync(task).toBeResolvedTo(words);
    expect(partial).toHaveBeenCalledWith(words);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
