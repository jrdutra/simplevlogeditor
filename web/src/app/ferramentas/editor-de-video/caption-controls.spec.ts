import { EditorDeVideoComponent } from './editor-de-video.component';
import {
  CAPTION_PRESET_GROUPS,
  CAPTION_PRESETS,
  CAPTION_ANIMATIONS,
  DEFAULT_CAPTION,
  captionPresetIsBackground,
  captionPresetPatch,
  isBackgroundCaption
} from './video-editor-defaults';
import { ClipCaption } from './video-editor.models';

describe('caption controls and MCP patches', () => {
  const behind: ClipCaption = {
    ...DEFAULT_CAPTION, ...captionPresetPatch(DEFAULT_CAPTION, 'behind-subject'),
    text: 'DOIS DIAS', positionX: 0.66, fontScale: 0.35
  };
  const patch = (values: Record<string, unknown>, current = behind) =>
    EditorDeVideoComponent.prototype['agentCaptionPatch'](values, current);

  it('uses the same classic size and outline when switching via UI or MCP', () => {
    for (const id of ['classic', 'yellow-shadow', 'custom']) {
      const ui = captionPresetPatch(behind, id)!;
      const agent = patch({ stylePreset: id });
      expect(agent).toEqual(ui);
      expect(agent.style).toBe('classic');
      expect(agent.fontScale).toBe(DEFAULT_CAPTION.fontScale);
      expect(agent.outlinePercent).toBeGreaterThan(0);
    }
    expect(patch({ style: 'classic' })).toEqual(captionPresetPatch(behind, 'classic')!);
  });

  it('preserves customized placement when the client repeats the current style', () => {
    expect({ ...behind, ...patch({ style: 'behind-subject', text: 'TRÊS DIAS' }) })
      .toEqual({ ...behind, text: 'TRÊS DIAS' });
  });

  it('preserves style and preset on timing-only changes', () => {
    for (const current of [behind, { ...DEFAULT_CAPTION, stylePreset: 'yellow-shadow' }]) {
      const result = { ...current, ...patch({ startSeconds: 3, durationSeconds: 2 }, current) };
      expect(result.style).toBe(current.style);
      expect(result.stylePreset).toBe(current.stylePreset);
      expect(result.durationAutomatic).toBeFalse();
    }
  });

  it('rejects unknown and contradictory style declarations', () => {
    expect(() => patch({ style: 'unknown', stylePreset: 'classic' })).toThrow();
    expect(() => patch({ style: 'classic', stylePreset: 'behind-subject' })).toThrow();
    expect(() => patch({ style: 'behind-subject', stylePreset: 'classic' })).toThrow();
  });

  it('clamps explicitly supplied sizes for the destination style', () => {
    expect(patch({ style: 'classic', fontScale: 0.4 }).fontScale).toBe(0.12);
    expect(patch({ fontScale: 0.02 }).fontScale).toBe(0.2);
  });

  it('groups classic and background presets and exposes static and animated background designs', () => {
    expect(CAPTION_PRESET_GROUPS.map((group) => group.id)).toEqual(['classic', 'background']);
    const background = CAPTION_PRESETS.filter((preset) => preset.group === 'background');
    expect(background.map((preset) => preset.id)).toEqual([
      'behind-subject',
      'behind-subject-upper-left',
      'behind-subject-upper-right',
      'behind-subject-center',
      'behind-subject-center-left',
      'behind-subject-center-right',
      'behind-subject-zoom-in-display',
      'behind-subject-zoom-out-slab',
      'behind-subject-scroll-left-geometric',
      'behind-subject-scroll-right-handwritten',
      'behind-subject-scroll-up-mono',
      'behind-subject-scroll-down-serif',
      'behind-subject-upper-left-display-zoom',
      'behind-subject-center-right-geometric-zoom'
    ]);
    expect(new Set(background.map((preset) => `${preset.style.positionX}:${preset.style.positionY}`)).size).toBe(6);
    expect(new Set(background.map((preset) => preset.style.animation ?? 'none')))
      .toEqual(new Set(CAPTION_ANIMATIONS.map((animation) => animation.value)));
    for (const preset of background) {
      expect(captionPresetIsBackground(preset.id)).toBeTrue();
      expect(isBackgroundCaption({ stylePreset: preset.id })).toBeTrue();
      expect(captionPresetPatch(DEFAULT_CAPTION, preset.id)).toEqual(jasmine.objectContaining({
        style: 'behind-subject', stylePreset: preset.id
      }));
      expect(patch({ stylePreset: preset.id }, DEFAULT_CAPTION)).toEqual(captionPresetPatch(DEFAULT_CAPTION, preset.id)!);
    }
  });

  it('preserves manually customized background values under the custom background option', () => {
    const customized = { ...behind, textColor: '#123456', stylePreset: 'custom-background' };
    expect(captionPresetPatch(customized, 'custom-background')).toEqual({
      style: 'behind-subject', stylePreset: 'custom-background'
    });
    expect(isBackgroundCaption(customized)).toBeTrue();
  });

  it('validates caption motion sent by MCP and keeps it customizable', () => {
    expect(patch({ animation: 'scroll-left' }).animation).toBe('scroll-left');
    expect(patch({ animation: 'scroll-left' }).stylePreset).toBe('custom-background');
    expect(() => patch({ animation: 'bounce' })).toThrow();
  });
});
