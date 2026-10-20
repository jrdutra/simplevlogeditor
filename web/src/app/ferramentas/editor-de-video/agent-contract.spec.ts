/**
 * The contract between the MCP schema, the declared capabilities and the code
 * that actually runs an operation.
 *
 * Three lists have to agree: `EDIT_OPERATIONS` in the Electron server, the
 * `operationTypes` the editor reports through `get_editor_capabilities`, and
 * the `switch` in `agentApplyOperation`. Nothing made them agree before — an
 * operation added to the schema and forgotten in the switch reached an agent as
 * "unknown edit operation", and only when somebody happened to call it.
 *
 * This spec closes the second half of that loop: everything the editor says it
 * can do, it can actually be asked to do. The Electron test closes the first
 * half, comparing the schema against this same declared list.
 */

import { EditorDeVideoComponent } from './editor-de-video.component';
import { DEFAULT_PROJECT, cloneEdits } from './video-editor-defaults';
import { ClipEditsPanelComponent } from './clip-edits-panel.component';

function editor(): any {
  const instance: any = Object.create(EditorDeVideoComponent.prototype);
  Object.assign(instance, {
    clips: [],
    project: { ...DEFAULT_PROJECT, edits: cloneEdits(DEFAULT_PROJECT.edits) },
    nextId: 1,
    history: [], future: [], lastChangeAt: 0, exporting: null, revision: 0,
    player: null, restoring: false,
    captionPresetGroups: [], behindSubjectPositions: [], noiseStrengthIds: [],
    snapshotBoard: () => ({}), scheduleSave: () => {}, closeAllDialogs: () => {},
    aplicarLayoutBoard: () => {}, cdr: { markForCheck: () => {} }
  });
  return instance;
}

describe('the declared operation list', () => {
  it('does not bake automatic text fades into unrelated UI or MCP settings changes', async () => {
    const instance = editor();
    instance.touch = () => {};
    instance.invalidateAnalysis = () => {};
    const video: any = { id: 'a', kind: 'media', summary: { kind: 'video' }, overrides: null };
    const text = { id: 'title', kind: 'text', overrides: null };
    instance.clips = [video, text];
    expect(instance.editsFor(video).fadeOut).toBeTrue();
    const panel = new ClipEditsPanelComponent();
    panel.edits = instance.editsFor(video);
    panel.storedEdits = instance.storedEditsFor(video);
    panel.editsChange.subscribe(edits => instance.onClipEdits(video, edits));
    panel.onVolume(75);
    expect(video.overrides.volumePercent).toBe(75);
    expect(video.overrides.fadeOut).toBe(instance.project.edits.fadeOut);
    expect(video.overrides.fadeOutAudio).toBeUndefined();
    expect(instance.editsFor(video).fadeOutAudio).toBeTrue();
    await instance.agentApplyOperation({ type: 'set_clip_edits', clipId: 'a', edits: { speed: 2 } });
    instance.clips = [video];
    expect(instance.editsFor(video).fadeOut).toBe(instance.project.edits.fadeOut);
    expect(instance.editsFor(video).fadeOutAudio).toBeUndefined();
    expect(instance.editsFor(video).speed).toBe(2);
  });

  it('preserves explicit fades while temporary text boundaries move away', async () => {
    const instance = editor();
    instance.touch = () => {};
    instance.invalidateAnalysis = () => {};
    const video: any = { id: 'a', kind: 'media', summary: { kind: 'video' }, overrides: null };
    instance.clips = [video, { id: 'title', kind: 'text', overrides: null }];
    instance.setFollowsProject(video, false);
    expect(video.overrides.fadeOutAudio).toBeUndefined();
    await instance.agentApplyOperation({ type: 'set_clip_edits', clipId: 'a',
      edits: { fadeOut: true, fadeOutAudio: false } });
    expect(instance.editsFor(video).fadeOutAudio).toBeTrue();
    instance.clips = [video];
    expect(instance.editsFor(video).fadeOut).toBeTrue();
    expect(instance.editsFor(video).fadeOutAudio).toBeFalse();
  });

  it('exposes and validates the plate setting through the actual MCP operation', async () => {
    const instance = editor();
    const a = { id: 'a', kind: 'media', summary: { kind: 'video' } };
    const b = { id: 'b', kind: 'media', summary: { kind: 'video' } };
    instance.clips = [a, b, { id: 'image', kind: 'media', summary: { kind: 'image' } },
      { id: 'audio', kind: 'media', summary: { kind: 'audio' } }, { id: 'text', kind: 'text' }];
    instance.touch = () => {};
    expect(instance.agentCapabilities().licensePlateBlur.scope).toBe('video-container-only');
    expect(instance.agentCapabilities().project.licensePlateBlur).toBeUndefined();
    await instance.agentApplyOperation({ type: 'set_license_plate_blur', clipId: 'a', enabled: true });
    expect(a).toEqual(jasmine.objectContaining({ blurLicensePlates: true }));
    expect(b).not.toEqual(jasmine.objectContaining({ blurLicensePlates: true }));
    await instance.agentApplyOperation({ type: 'set_license_plate_blur', clipId: 'a', enabled: false });
    expect(a).toEqual(jasmine.objectContaining({ blurLicensePlates: false }));
    await expectAsync(instance.agentApplyOperation({ type: 'set_license_plate_blur', clipId: 'a', enabled: 'yes' })).toBeRejected();
    for (const clipId of ['image', 'audio', 'text', 'missing']) {
      await expectAsync(instance.agentApplyOperation({ type: 'set_license_plate_blur', clipId, enabled: true })).toBeRejected();
    }
    expect(() => instance.agentSetProjectSettings({ blurLicensePlates: true })).toThrow();
    expect(() => instance.agentSetProjectSettings({ edits: { blurLicensePlates: true } })).toThrow();
  });
  it('names something the editor can actually be asked to do', async () => {
    const instance = editor();
    const capabilities = instance.agentCapabilities() as { operationTypes: string[] };
    expect(capabilities.operationTypes.length).toBeGreaterThan(30);

    const unimplemented: string[] = [];
    for (const type of capabilities.operationTypes) {
      try {
        // Deliberately called with nothing but a type. Every operation will
        // reject — for a missing clip, a missing argument, a bad target — and
        // any of those proves the case exists. Only `unknown_operation` means
        // the switch never heard of it.
        await instance.agentApplyOperation({ type });
      } catch (error) {
        if ((error as { code?: string }).code === 'unknown_operation') unimplemented.push(type);
      }
    }
    expect(unimplemented).toEqual([]);
  });

  it('lists every operation exactly once', () => {
    const { operationTypes } = editor().agentCapabilities() as { operationTypes: string[] };
    expect(operationTypes.length).toBe(new Set(operationTypes).size);
  });

  it('declares the families an agent is told to use', () => {
    const { operationTypes } = editor().agentCapabilities() as { operationTypes: string[] };
    for (const type of [
      'add_caption', 'update_caption', 'remove_caption',
      'add_image', 'update_image', 'remove_image',
      'add_video_effect', 'update_video_effect', 'remove_video_effect',
      'add_push_in', 'update_push_in', 'remove_push_in'
    ]) {
      expect(operationTypes).withContext(type).toContain(type);
    }
  });
});
