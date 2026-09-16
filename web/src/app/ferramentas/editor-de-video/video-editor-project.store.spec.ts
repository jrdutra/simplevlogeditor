import { DEFAULT_CAPTION, DEFAULT_PROJECT, SILENT_CUT_REPLACEMENT, clampCaption, cloneEdits } from './video-editor-defaults';
import { MediaClip, ProjectSettings } from './video-editor.models';
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

  it('preserves per-clip noise settings and diagnostic evidence without persisting derived audio', () => {
    const clip: MediaClip = {
      kind: 'media',
      id: 'clip-noisy',
      file: new File(['media'], 'noisy.mp4', { lastModified: 123 }),
      summary: {
        fileName: 'noisy.mp4', fileSize: 5, containerName: 'mp4', kind: 'video', durationSeconds: 12,
        hasVideoTrack: true, hasAudioTrack: true, videoCodec: 'avc', audioCodec: 'aac', width: 1920,
        height: 1080, frameRate: 30, sampleRate: 48000, channelCount: 2, videoUsable: true,
        audioUsable: true, warning: null, isTimelapse: false, timelapseReason: null
      },
      info: null,
      overrides: null,
      detected: [],
      manualCuts: [],
      analysis: null,
      analyzedWith: null,
      replacementAudio: null,
      noiseSuppression: { enabled: true, engine: 'rnnoise', strength: 'maximum', preserveHighs: true },
      noiseReport: {
        status: 'Relevant noise',
        settings: { content: 'speech', sensitivity: 'high', background: null, cleanVoice: null },
        seconds: 12,
        speechSeconds: 8,
        pauseSeconds: 4,
        backgroundDb: -31.5,
        voiceBackgroundGapDb: 7.2,
        quality: { speech: 3.7, background: 2.1, overall: 2.8 },
        intervals: [{ start: 2, end: 11, speech: 3.7, background: 2.1, overall: 2.8 }],
        evidence: ['Background is clearly audible.'],
        warnings: []
      },
      noiseAnalyzedWith: { content: 'speech', sensitivity: 'high', background: null, cleanVoice: null },
      noiseCleanedAudio: new File(['derived'], 'cleaned.wav'),
      noiseCleanedWith: { enabled: true, engine: 'rnnoise', strength: 'maximum', preserveHighs: true },
      noiseCleanedUrl: 'blob:preview',
      noiseReductionDb: 8.4,
      caption: null,
      captions: [{
        ...DEFAULT_CAPTION,
        id: 'depth-title',
        text: '2 DIAS',
        startSeconds: 2,
        durationSeconds: 3,
        style: 'behind-subject',
        stylePreset: 'behind-subject-zoom-in-display',
        fontFamily: 'display',
        animation: 'zoom-in',
        fontScale: 0.28,
        positionX: 0.66,
        positionY: 0.34,
        shadowBlurPercent: 70,
        shadowOpacity: 0.9
      }],
      previewUrl: null,
      thumbUrl: null
    };

    const stored = serializeProject([clip], project(0.65), 1);
    const restored = restoreProject(JSON.parse(JSON.stringify(stored))).clips[0] as MediaClip;

    expect(restored.noiseSuppression).toEqual(clip.noiseSuppression);
    expect(restored.noiseReport).toEqual(clip.noiseReport);
    expect(restored.noiseAnalyzedWith).toEqual(clip.noiseAnalyzedWith);
    expect(restored.noiseCleanedAudio).toBeNull();
    expect(restored.noiseCleanedWith).toBeNull();
    expect(restored.noiseCleanedUrl).toBeNull();
    expect(restored.noiseReductionDb).toBeNull();
    expect(restored.captions?.[0]).toEqual(clampCaption(clip.captions![0]));
  });
});
