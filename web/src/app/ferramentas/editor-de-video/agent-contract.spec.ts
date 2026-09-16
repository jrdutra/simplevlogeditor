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

function editor(): any {
  const instance: any = Object.create(EditorDeVideoComponent.prototype);
  Object.assign(instance, {
    clips: [],
    project: { ...DEFAULT_PROJECT, edits: cloneEdits(DEFAULT_PROJECT.edits) },
    nextId: 1,
    history: [], future: [], lastChangeAt: 0, exporting: null, revision: 0,
    player: null, restoring: false,
    snapshotBoard: () => ({}), scheduleSave: () => {}, closeAllDialogs: () => {},
    aplicarLayoutBoard: () => {}, cdr: { markForCheck: () => {} }
  });
  return instance;
}

describe('the declared operation list', () => {
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
