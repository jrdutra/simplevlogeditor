import { SubjectSegmentationClient, subjectFailureMessage } from './subject-segmentation';
import { FrameSource } from './frame-source';

describe('SubjectSegmentationClient cache keys', () => {
  it('reuses only the same frame, not the following frame', () => {
    const client = new SubjectSegmentationClient();
    expect(client.key('clip-1', 1.001, 960, 540, 1, true))
      .toBe(client.key('clip-1', 1.001, 960, 540, 1, true));
    expect(client.key('clip-1', 1.001, 960, 540, 1, true))
      .not.toBe(client.key('clip-1', 1.034, 960, 540, 1, true));
    client.dispose();
  });

  it('invalidates masks when time, framing or output aspect changes', () => {
    const client = new SubjectSegmentationClient();
    const base = client.key('clip-1', 1, 960, 540, 1, true);
    expect(client.key('clip-1', 1.2, 960, 540, 1, true)).not.toBe(base);
    expect(client.key('clip-1', 1, 540, 960, 1, true)).not.toBe(base);
    expect(client.key('clip-1', 1, 960, 540, 1.2, true)).not.toBe(base);
    client.dispose();
  });
});

describe('subject segmentation recovery', () => {
  let client: SubjectSegmentationClient;
  const source: FrameSource = { width: 320, height: 180, draw: () => undefined };
  const matte = () => ({ width: 1, height: 1, alpha: new Uint8ClampedArray([255]), coverage: 0.5 });
  beforeEach(() => { client = new SubjectSegmentationClient(); });
  afterEach(() => client.dispose());

  it('falls back after frame read failure and does not repeatedly redraw an unavailable model', async () => {
    const broken = { ...source, draw: () => { throw new Error('Unreadable frame'); } };
    let redraws = 0;
    const redraw = () => {
      redraws++;
      if (redraws < 5) client.requestForPreview(broken, 320, 180, 1, true, 'a', 0, redraw);
    };
    client.requestForPreview(broken, 320, 180, 1, true, 'a', 0, redraw);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.state).toBe('unavailable');
    expect(client.lastError).toContain('Unreadable frame');
    expect(redraws).toBe(1);
  });

  it('does not reuse a stale mask after crop, zoom, aspect or backwards seek changes', async () => {
    spyOn<any>(client, 'run').and.resolveTo(matte());
    await client.maskFor(source, 320, 180, 1, true, 'a', 1);
    expect(client.cached(client.key('a', 1, 320, 180, 1, true), 'a', 1)).not.toBeNull();
    expect(client.cached(client.key('a', 1.2, 320, 180, 1, true), 'a', 1.2)).toBeNull();
    for (const key of [
      client.key('a', 1.2, 180, 320, 1, true), client.key('a', 1.2, 320, 180, 1.2, true),
      client.key('a', 1.2, 320, 180, 1, false)
    ]) expect(client.cached(key, 'a', 1.2)).toBeNull();
    expect(client.cached(client.key('a', 0.8, 320, 180, 1, true), 'a', 0.8)).toBeNull();
  });

  it('clears temporal masks when the person disappears', async () => {
    const run = spyOn<any>(client, 'run').and.resolveTo(matte());
    await client.maskFor(source, 320, 180, 1, true, 'a', 1);
    run.and.resolveTo(null);
    await client.maskFor(source, 320, 180, 1, true, 'a', 1.2);
    expect(client.cached(client.key('a', 1.4, 320, 180, 1, true), 'a', 1.4)).toBeNull();
  });

  it('does not blend the previous silhouette into a moving edge', async () => {
    const run = spyOn<any>(client, 'run').and.resolveTo({
      width: 3, height: 1, alpha: new Uint8ClampedArray([0, 255, 0]), coverage: 0.33
    });
    await client.maskFor(source, 320, 180, 1, true, 'a', 1);
    run.and.resolveTo({ width: 3, height: 1, alpha: new Uint8ClampedArray([0, 0, 255]), coverage: 0.33 });
    const moved = await client.maskFor(source, 320, 180, 1, true, 'a', 1 + 1 / 30);
    expect(moved!.alpha).toEqual(new Uint8ClampedArray([0, 0, 255]));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retains more mask detail for HD footage without upscaling small frames', async () => {
    const run = spyOn<any>(client, 'run').and.resolveTo(matte());
    await client.maskFor(source, 1920, 1080, 1, true, 'a', 0);
    expect(run.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ width: 1024, height: 576 }));
    await client.maskFor(source, 1080, 1920, 1, true, 'a', 0);
    expect(run.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ width: 576, height: 1024 }));
    await client.maskFor(source, 320, 180, 1, true, 'a', 0);
    expect(run.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ width: 320, height: 180 }));
  });

  it('suppresses callbacks and cached results after disposal during inference', async () => {
    let finish!: (value: ReturnType<typeof matte>) => void;
    spyOn<any>(client, 'run').and.returnValue(new Promise((resolve) => { finish = resolve; }));
    const redraw = jasmine.createSpy('redraw');
    client.requestForPreview(source, 320, 180, 1, true, 'a', 0, redraw);
    client.dispose();
    finish(matte());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(redraw).not.toHaveBeenCalled();
    expect(await client.maskFor(source, 320, 180, 1, true, 'a', 0)).toBeNull();
  });

  it('times out one stalled request without terminating a worker leased by other previews', async () => {
    const worker = { postMessage: jasmine.createSpy('postMessage'), terminate: jasmine.createSpy('terminate') };
    spyOn(window, 'Worker').and.returnValue(worker as unknown as Worker);
    jasmine.clock().install();
    try {
      const pending = client.maskFor(source, 320, 180, 1, true, 'a', 0);
      jasmine.clock().tick(120_001);
      expect(await pending).toBeNull();
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(client.lastError).toContain('timed out');
      expect(client.failure).toEqual(jasmine.objectContaining({ kind: 'timeout', retryable: true }));
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('releases export immediately when the worker is disposed during model loading', async () => {
    const worker = { postMessage: jasmine.createSpy('postMessage'), terminate: jasmine.createSpy('terminate') };
    spyOn(window, 'Worker').and.returnValue(worker as unknown as Worker);
    const pending = client.maskFor(source, 320, 180, 1, true, 'a', 0);
    client.dispose();
    expect(await pending).toBeNull();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('leases one worker and routes responses independently until the last consumer leaves', async () => {
    const worker = { postMessage:jasmine.createSpy('postMessage'),terminate:jasmine.createSpy('terminate'),onmessage:null as any };
    const factory = spyOn(window,'Worker').and.returnValue(worker as unknown as Worker);
    const second = new SubjectSegmentationClient();
    try {
      const a = client.maskFor(source,320,180,1,true,'a',0);
      const b = second.maskFor(source,320,180,1,true,'b',0);
      expect(factory).toHaveBeenCalledTimes(1);
      const id = worker.postMessage.calls.argsFor(1)[0].id;
      client.dispose(); await a;
      expect(worker.terminate).not.toHaveBeenCalled();
      worker.onmessage({data:{id,type:'empty'}});
      expect(await b).toBeNull();
      expect(second.state).toBe('no-subject');
    } finally { second.dispose(); }
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('subject segmentation failure classification', () => {
  let client: SubjectSegmentationClient;
  beforeEach(() => client = new SubjectSegmentationClient());
  afterEach(() => client.dispose());

  it('starts with no failure at all', () => {
    expect(client.failure).toBeNull();
    expect(client.status()).toEqual(jasmine.objectContaining({
      state: 'idle', failure: null, reduced: false, analysisEdge: 1024, averageMs: 0
    }));
  });

  it('keeps every technical failure distinguishable', () => {
    client.reportFailure('timeout', 'Subject segmentation timed out.');
    expect(client.status().failure).toEqual({
      kind: 'timeout', message: 'Subject segmentation timed out.', retryable: true
    });
    client.reportFailure('model-unavailable', 'Not supported by this browser.');
    expect(client.status().failure!.kind).toBe('model-unavailable');
    expect(client.status().failure!.retryable).toBeFalse();
    client.reportFailure('cancelled', 'Disposed.');
    expect(client.status().failure!.kind).toBe('cancelled');
    client.reportFailure('inference-failed', 'Worker crashed.');
    expect(client.status().failure!.kind).toBe('inference-failed');
  });

  it('never reports an empty picture as a failure', () => {
    client.state = 'no-subject';
    expect(client.failure).toBeNull();
    expect(subjectFailureMessage(client.failure, 'caption')).toBe('');
  });

  it('retries a recoverable failure without a reload, and refuses an impossible one', () => {
    client.reportFailure('timeout', 'timed out');
    expect(client.retry()).toBeTrue();
    expect(client.state).toBe('idle');
    expect(client.failure).toBeNull();

    client.reportFailure('model-unavailable', 'unsupported');
    expect(client.retry()).toBeFalse();
    expect(client.failure!.kind).toBe('model-unavailable');
  });

  it('says what a Background Caption loses, not what an effect loses', () => {
    client.reportFailure('inference-failed', 'worker crashed');
    const caption = subjectFailureMessage(client.failure, 'caption');
    const effect = subjectFailureMessage(client.failure, 'effect');
    expect(caption).toContain('Background Caption');
    expect(caption).toContain('Classic');
    expect(effect).toContain('AI Video Effect');
    expect(effect).not.toBe(caption);
  });

  it('refuses to retry after disposal', () => {
    client.reportFailure('timeout', 'timed out');
    client.dispose();
    expect(client.retry()).toBeFalse();
  });
});
