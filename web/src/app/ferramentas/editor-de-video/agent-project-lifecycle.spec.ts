import { EditorDeVideoComponent } from './editor-de-video.component';

describe('project replacement and source transcript identity', () => {
  function editor() {
    const instance = Object.create(EditorDeVideoComponent.prototype) as any;
    Object.assign(instance, { projectInstanceId: 1, revision: 4, nextId: 2,
      history: [{ old: true }], future: [{ old: true }], pending: { old: true }, pendingSignature: 'old',
      clips: [], heardByClip: new Map(), transcriptModelId: 'small', transcriptLanguage: 'pt', transcriptDenoise: false,
      agentAssetId: (clip: any) => clip.asset, cancelAnalyses: () => {}, release: () => {},
      closeAllDialogs: () => {}, closeTimelinePreview: () => {}, touch: () => {} });
    Object.defineProperty(instance, 'transcriptStrength', { value: { attenuationDb: 20 } });
    return instance;
  }

  it('opening another project resets undo/redo and transcript cache', () => {
    const instance = editor(); instance.heardByClip.set('old', []);
    instance.applyRestored({ clips: [], project: {}, nextId: 0, projectRevision: 2, savedAt: '' });
    expect(instance.history).toEqual([]); expect(instance.future).toEqual([]);
    expect(instance.pending).toBeNull(); expect(instance.pendingSignature).toBe('');
    expect(instance.heardByClip.size).toBe(0); expect(instance.projectInstanceId).toBe(2);
    expect(instance.revision).toBe(4);
  });

  it('rejects an import from the old document before looking at its media', async () => {
    const instance = editor();
    await expectAsync(instance.agentImportMediaPath({ expectedProjectInstanceId: 0 }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'project_changed' }));
    expect(instance.clips).toEqual([]);
  });

  it('rejects an import if the user changes project during the asynchronous probe', async () => {
    const instance = editor();
    let release!: () => void;
    instance.probe = { detectTimelapseFor: () => new Promise<void>(resolve => { release = resolve; }) };
    instance.agentHasMediaPath = () => ({ present: false });
    const task = instance.agentImportMediaPath({ expectedProjectInstanceId: 1,
      descriptor: { url: 'http://localhost/media', filePath: 'C:/clips/a.mov', name: 'a.mov', size: 100, lastModified: 1, type: 'video/quicktime' },
      summary: { fileName: 'a.mov' } });
    instance.projectInstanceId = 2; release();
    await expectAsync(task).toBeRejectedWith(jasmine.objectContaining({ code: 'project_changed' }));
    expect(instance.clips).toEqual([]); expect(instance.nextId).toBe(2);
  });

  it('requires matching source, model and full requested scope before declaring a transcript ready', () => {
    const instance = editor(); const clip = { id: 'a', asset: 'new' };
    instance.heardByClip.set('a|old||small|pt|raw|0|900', []);
    instance.heardByClip.set('a|new||small|pt|raw|10|20', []);
    instance.heardByClip.set('a|new||turbo|pt|raw|0|900', []);
    expect(instance.cachedSourceTranscript(clip, 0, 900)).toBeUndefined();
    expect(instance.cachedSourceTranscript(clip, 10, 20)).toEqual([]);
    expect(instance.cachedSourceTranscript(clip, 0, 900, false)).toEqual([]);
    instance.heardByClip.set('a|new||small|pt|raw|0|900', []);
    expect(instance.cachedSourceTranscript(clip, 0, 900)).toEqual([]);
  });

  it('reuses a complete transcript for a trimmed scope, but still honours cancellation', async () => {
    const instance = editor(); const clip = { id: 'a', asset: 'new', summary: { durationSeconds: 900 } };
    const words = [{ start: 11, end: 12, text: 'Olá' }];
    instance.heardByClip.set('a|new||small|pt|raw|0|900', words);
    const entry = { keepRanges: [{ start: 10, end: 20 }] };
    expect(await instance.wordsFor(clip, entry, new AbortController().signal)).toBe(words);
    const cancelled = new AbortController(); cancelled.abort();
    await expectAsync(instance.wordsFor(clip, entry, cancelled.signal))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'cancelled' }));
  });
});
