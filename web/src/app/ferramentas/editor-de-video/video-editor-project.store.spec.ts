import { DEFAULT_PROJECT, SILENT_CUT_REPLACEMENT, cloneEdits } from './video-editor-defaults';
import { ProjectSettings } from './video-editor.models';
import { restoreProject, serializeProject } from './video-editor-project.store';

function project(threshold: number): ProjectSettings {
  return {
    ...DEFAULT_PROJECT,
    edits: cloneEdits(DEFAULT_PROJECT.edits),
    loudness: { ...DEFAULT_PROJECT.loudness },
    soundFade: { ...DEFAULT_PROJECT.soundFade },
    silentCutReplacementThreshold: threshold
  };
}

describe('video editor project persistence', () => {
  it('keeps the mostly-silent replacement threshold in a saved project', () => {
    const stored = serializeProject([], project(0.65), 0);

    expect(restoreProject(stored).project.silentCutReplacementThreshold).toBe(0.65);
  });

  it('opens older projects with the current default threshold', () => {
    const stored = serializeProject([], project(0.65), 0);
    delete stored.settings.silentCutReplacementThreshold;

    expect(restoreProject(stored).project.silentCutReplacementThreshold).toBe(
      SILENT_CUT_REPLACEMENT.default
    );
  });

  it('preserves the MCP project revision across save, restart and recovery', () => {
    const stored = serializeProject([], project(0.65), 7, { projectRevision: 25 });
    const restored = restoreProject(JSON.parse(JSON.stringify(stored)));

    expect(stored.projectRevision).toBe(25);
    expect(restored.projectRevision).toBe(25);
  });
});
