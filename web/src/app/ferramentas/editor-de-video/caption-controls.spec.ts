import { EditorDeVideoComponent } from './editor-de-video.component';
import {
  CAPTION_PRESET_GROUPS,
  CAPTION_PRESETS,
  CAPTION_ANIMATIONS,
  DEFAULT_CAPTION,
  DEFAULT_BACKGROUND_CAPTION_POSITION,
  DEFAULT_EDITS,
  cloneEdits,
  clampCaption,
  captionPresetIsBackground,
  captionPresetPatch,
  isBackgroundCaption
} from './video-editor-defaults';
import { ClipCaption } from './video-editor.models';

describe('caption controls and MCP patches', () => {
  it('accepts deliberate picture-and-sound fades from MCP without changing other clip edits', () => {
    const current = { ...cloneEdits(DEFAULT_EDITS), speed: 4, volumePercent: 70 };
    const result = EditorDeVideoComponent.prototype['agentClipEdits'](current, {
      fadeAudioWithVideo: true, fadeOut: true, fadeSeconds: 1
    });
    expect(result).toEqual({ ...current, fadeAudioWithVideo: true, fadeOut: true, fadeSeconds: 1 });
    expect(current.fadeOut).toBeFalse();
    expect(EditorDeVideoComponent.prototype['agentClipEdits'](result, { fadeAudioWithVideo: false })
      .fadeAudioWithVideo).toBeFalse();
  });

  it('accepts explicit picture-only MCP edges without losing sound fades at the opposite edge', () => {
    const current = { ...cloneEdits(DEFAULT_EDITS), fadeIn: true, fadeOut: true, fadeAudioWithVideo: true };
    const result = EditorDeVideoComponent.prototype['agentClipEdits'](current,
      { fadeInAudio: true, fadeOutAudio: false });
    expect(result).toEqual({ ...current, fadeInAudio: true, fadeOutAudio: false });
    expect(current.fadeAudioWithVideo).toBeTrue();
  });

  it('reports resolved project music and the actual picture and audio fades to AI clients', () => {
    const file = new File(['music'], 'score.mp3');
    const fades = [{ start: 0, end: 1, kind: 'in' }];
    const clip = { kind: 'text', id: 'card', draft: { text: 'Chapter' } };
    const subject = {
      clips: [clip], revision: 4, project: { defaultAudio: { file } },
      editsFor: () => DEFAULT_EDITS,
      plan: { clips: [{ clip, outputStart: 0, outputDuration: 5,
        sound: { kind: 'file', file, label: file.name, offset: 10 }, soundShort: false }],
        totalDuration: 5, fades, audioFades: fades, soundFades: [], transitions: [] }
    } as unknown as EditorDeVideoComponent;
    const timeline = EditorDeVideoComponent.prototype['agentTimeline'].call(subject) as {
      clips: { resolvedSound: unknown; soundShort: boolean }[]; plannedFades: unknown; plannedTransitions: unknown
    };
    expect(timeline.clips[0].resolvedSound).toEqual({ kind: 'file', name: 'score.mp3', offset: 10, projectDefault: true });
    expect(timeline.clips[0].soundShort).toBeFalse();
    expect(timeline.plannedFades).toEqual({ timeSpace: 'output', picture: fades, audio: fades, soundtrack: [] });
    expect(timeline.plannedTransitions).toEqual([]);
  });
  it('defaults new background captions to regular Impact at upper-left through UI, MCP and legacy fallback', () => {
    const expected = {
      positionX: DEFAULT_BACKGROUND_CAPTION_POSITION.x, positionY: DEFAULT_BACKGROUND_CAPTION_POSITION.y,
      fontFamily: 'impact', fontWeight: 400
    };
    expect(captionPresetPatch(DEFAULT_CAPTION, 'behind-subject')).toEqual(jasmine.objectContaining(expected));
    expect(captionPresetPatch(DEFAULT_CAPTION, 'custom-background')).toEqual(jasmine.objectContaining(expected));
    expect(EditorDeVideoComponent.prototype['agentCaptionPatch']({ style: 'behind-subject' }, DEFAULT_CAPTION))
      .toEqual(jasmine.objectContaining(expected));
    expect(clampCaption({ ...DEFAULT_CAPTION, style: 'behind-subject', fontFamily: undefined, fontWeight: undefined }))
      .toEqual(jasmine.objectContaining(expected));
    for (const fontWeight of [700, 900]) {
      expect(clampCaption({ ...DEFAULT_CAPTION, style: 'behind-subject', fontFamily: 'impact', fontWeight }).fontWeight)
        .toBe(400);
    }
  });

  it('preserves the font and position explicitly chosen by the user in existing captions', () => {
    const caption: ClipCaption = {
      ...DEFAULT_CAPTION, style: 'behind-subject', positionX: 0.7, positionY: 0.5,
      fontFamily: 'serif', fontWeight: 500
    };
    expect(clampCaption(caption)).toEqual(jasmine.objectContaining({
      positionX: 0.7, positionY: 0.5, fontFamily: 'serif', fontWeight: 500
    }));
    expect({ ...caption, ...EditorDeVideoComponent.prototype['agentCaptionPatch']({ text: 'NOVO TEXTO' }, caption) })
      .toEqual(jasmine.objectContaining({ fontFamily: 'serif', fontWeight: 500 }));
    expect(EditorDeVideoComponent.prototype['agentCaptionPatch']({ text: 'NOVO TEXTO' }, caption))
      .not.toEqual(jasmine.objectContaining({ positionX: 0.3 }));
    const patch = EditorDeVideoComponent.prototype['agentCaptionPatch'](
      { stylePreset: 'behind-subject-center', positionX: 0.7, positionY: 0.24 }, DEFAULT_CAPTION);
    expect(patch).toEqual(jasmine.objectContaining({ positionX: 0.7, positionY: 0.24 }));
  });
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
