import { EditorDeVideoComponent } from './editor-de-video.component';

describe('MCP transcription progress and queue', () => {
  function fixture() {
    const editor = Object.create(EditorDeVideoComponent.prototype) as any;
    const clip = { id: 'a', kind: 'media', summary: { audioUsable: true, durationSeconds: 12 } };
    Object.defineProperty(editor, 'plan', { value: { clips: [{ clip, keepRanges: [{ start: 0, end: 12 }] }] } });
    Object.assign(editor, { agentMediaClip: () => clip, agentTranscriptionQueue: Promise.resolve(),
      cdr: { markForCheck: () => {} }, desktop: { reportAgentProgress: jasmine.createSpy('MCP progress') },
      currentAgentOperationId: 'transcription-one', agentWorking: true, agentProgress: () => {},
      agentProgressReset: () => {} });
    return editor;
  }

  it('sends actual phases, detail and percentage to the MCP operation', () => {
    const editor = fixture();
    editor.reportTranscript({ stage: 'reading', ratio: .4, detail: 'source.mov' });
    expect(editor.desktop.reportAgentProgress).toHaveBeenCalledWith({ operationId: 'transcription-one',
      state: 'processing', stage: 'reading', percent: 40, detail: 'source.mov' });
    editor.reportTranscript({ stage: 'initializing-model', ratio: null, detail: 'encoder.onnx' });
    expect(editor.desktop.reportAgentProgress).toHaveBeenCalledWith(jasmine.objectContaining({ stage: 'initializing-model', percent: null }));
  });

  it('cancellation releases a stalled transcription queue so the next job can complete', async () => {
    const editor = fixture();
    editor.wordsFor = () => new Promise(() => {});
    const controller = new AbortController();
    const stalled = editor.agentTranscribe({ clipId: 'a' }, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expectAsync(stalled).toBeRejectedWith(jasmine.objectContaining({ code: 'cancelled' }));
    editor.wordsFor = async () => [{ start: 0, end: 1, text: 'Hello' }];
    editor.agentAssetId = () => 'source';
    const result = await editor.agentTranscribe({ clipId: 'a', includeWords: false });
    expect(result.quality.wordCount).toBe(1);
  });

  it('honours a short no-progress deadline even when a dependency ignores abort', async () => {
    const editor = fixture(); editor.wordsFor = () => new Promise(() => {});
    await expectAsync(editor.agentTranscribe({ clipId: 'a', stageTimeoutMs: 1000, timeoutMs: 60000 }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'transcription_stage_timeout', stage: 'starting' }));
  });
});
