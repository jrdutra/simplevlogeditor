import { Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';

import { AgentOutputHandle, createAgentOutputHandle } from './desktop.service';

describe('desktop agent output stream', () => {
  it('publishes only once when finalization and cancellation overlap', async () => {
    let finish!: () => void;
    const commit = jasmine.createSpy('commit').and.callFake(() => new Promise<void>(resolve => finish = resolve));
    const abort = jasmine.createSpy('abort').and.resolveTo();
    const handle = createAgentOutputHandle('out', { write: async () => 0, commit, abort });
    const writer = handle.stream.getWriter();
    await writer.close(); writer.releaseLock();
    const first = handle.commit(), second = handle.commit();
    await Promise.resolve();
    const cancelled = handle.abort();
    expect(abort).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second, cancelled]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it('cleans up when publication fails during a cancellation', async () => {
    let fail!: (error: Error) => void;
    const commit = () => new Promise<void>((_, reject) => fail = reject);
    const abort = jasmine.createSpy('abort').and.resolveTo();
    const handle = createAgentOutputHandle('out', { write: async () => 0, commit, abort });
    const writer = handle.stream.getWriter();
    await writer.close(); writer.releaseLock();
    const publishing = handle.commit();
    const rejected = expectAsync(publishing).toBeRejectedWithError('disk full');
    await Promise.resolve();
    const cancelled = handle.abort();
    fail(new Error('disk full'));
    await Promise.all([rejected, cancelled]);
    expect(abort).toHaveBeenCalledTimes(1);
    await expectAsync(handle.commit()).toBeRejectedWithError('The export destination was aborted.');
  });

  it('allows retrying cleanup after an IPC failure without reopening the stream', async () => {
    const abort = jasmine.createSpy('abort').and.returnValues(
      Promise.reject(new Error('disconnected')), Promise.resolve());
    const handle = createAgentOutputHandle('out', { write: async () => 0, commit: async () => {}, abort });
    await expectAsync(handle.abort()).toBeRejectedWithError('disconnected');
    await handle.abort();
    expect(abort).toHaveBeenCalledTimes(2);
    await expectAsync(handle.commit()).toBeRejectedWithError('The export destination was aborted.');
  });

  function output() {
    const writes: Array<{ id: string; position: number; bytes: number[] }> = [];
    const committed: string[] = [];
    const aborted: string[] = [];
    const handle = createAgentOutputHandle('out-1', {
      write: async (id, position, data) => {
        const bytes = [...new Uint8Array(data)];
        writes.push({ id, position, bytes });
        return position + bytes.length;
      },
      commit: async id => { committed.push(id); },
      abort: async id => { aborted.push(id); }
    });
    return { handle, writes, committed, aborted };
  }

  it('reproduces the old nominal-type failure and supplies a real same-realm stream', () => {
    const oldIpcFacade = { write: async () => {}, close: async () => {}, abort: async () => {} };
    expect(() => new StreamTarget(oldIpcFacade as never, { chunked: true }))
      .toThrowError('StreamTarget requires a WritableStream instance.');

    for (const format of [new Mp4OutputFormat(), new WebMOutputFormat()]) {
      const { handle } = output();
      expect(handle.stream instanceof WritableStream).toBeTrue();
      expect(() => new Output({ format, target: new StreamTarget(handle.stream, { chunked: true }) }))
        .not.toThrow();
    }
  });

  it('streams positioned chunks through IPC and commits only after close', async () => {
    const { handle, writes, committed, aborted } = output();
    const writer = handle.stream.getWriter();

    await writer.write({ type: 'write', data: new Uint8Array([1, 2, 3]), position: 8 });
    await writer.write({ type: 'write', data: new Uint8Array([4, 5]) });
    expect(writes).toEqual([
      { id: 'out-1', position: 8, bytes: [1, 2, 3] },
      { id: 'out-1', position: 11, bytes: [4, 5] }
    ]);
    expect(committed).toEqual([]);

    await writer.close();
    await handle.commit();
    expect(committed).toEqual(['out-1']);
    expect(aborted).toEqual([]);
    writer.releaseLock();
  });

  it('deletes the staged output after Mediabunny closes a cancelled stream', async () => {
    const { handle, committed, aborted } = output();
    const writer = handle.stream.getWriter();
    await writer.write({ type: 'write', data: new Uint8Array([9]) });
    // Output.cancel() closes StreamTarget's writer. That must not publish the
    // temporary file; the component follows it with the explicit abort below.
    await writer.close();
    writer.releaseLock();
    await handle.abort();

    expect(committed).toEqual([]);
    expect(aborted).toEqual(['out-1']);
    await expectAsync(handle.commit()).toBeRejectedWithError('The export destination was aborted.');
  });
});
