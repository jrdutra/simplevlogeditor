import {
  IMAGE_LIMITS,
  IMAGE_RESTRAINED_ROTATION,
  drawClipImage,
  imageBehindSubject,
  imageBox,
  imageKey,
  imagePlacement,
  imagesAt,
  isImageStyle,
  loadPlanImages
} from './clip-image';
import { clampClipImage } from './video-editor-defaults';
import { needsCompositing } from './frame-compositor';
import { buildProjectPlan } from './video-editor-timeline';
import { restoreProject, serializeProject } from './video-editor-project.store';
import { DEFAULT_PROJECT, cloneEdits } from './video-editor-defaults';
import { ClipImage, ClipImageSource, ImageSegment, MediaClip, ProjectPlan } from './video-editor.models';

function pictureFile(name = 'chart.png'): File {
  return new File(['picture'], name, { type: 'image/png', lastModified: 1000 });
}

function source(name = 'chart.png', width = 400, height = 200): ClipImageSource {
  const file = pictureFile(name);
  return {
    file, name, width, height,
    fileRef: { name, size: file.size, lastModified: file.lastModified }
  };
}

function placement(overrides: Partial<ClipImage> = {}): ClipImage {
  return clampClipImage({
    id: overrides.id ?? 'image-1',
    source: overrides.source ?? source(),
    startSeconds: 1,
    durationSeconds: 4,
    fadeSeconds: 0,
    ...overrides
  });
}

function segment(image: ClipImage, start = 0, end = 4, fadeSeconds = 0): ImageSegment {
  return { start, end, image, clipId: 'clip-1', fadeSeconds };
}

function clip(id: string, images: ClipImage[] = []): MediaClip {
  return {
    kind: 'media', id, file: new File(['video'], `${id}.mp4`), summary: {
      fileName: `${id}.mp4`, fileSize: 5, containerName: 'mp4', kind: 'video', durationSeconds: 10,
      hasVideoTrack: true, hasAudioTrack: true, videoCodec: 'avc', audioCodec: 'aac', width: 1280, height: 720,
      frameRate: 30, sampleRate: 48000, channelCount: 2, videoUsable: true, audioUsable: true, warning: null,
      isTimelapse: false, timelapseReason: null
    },
    info: null, overrides: null, detected: [], manualCuts: [], analysis: null, analyzedWith: null,
    replacementAudio: null, caption: null, images, thumbUrl: null, previewUrl: null
  };
}

describe('placement values', () => {
  it('fills in the defaults for a placement that states nothing', () => {
    const values = imagePlacement({ source: source() });
    expect(values.positionX).toBe(0.5);
    expect(values.positionY).toBe(0.5);
    expect(values.scale).toBe(IMAGE_LIMITS.scale.default);
    expect(values.rotationDegrees).toBe(0);
    expect(values.opacity).toBe(1);
  });

  it('brings an out-of-range value to the nearest legal one', () => {
    const values = imagePlacement({ source: source(), positionX: 4, scale: 99, rotationDegrees: -900, opacity: 0 });
    expect(values.positionX).toBe(IMAGE_LIMITS.position.max);
    expect(values.scale).toBe(IMAGE_LIMITS.scale.max);
    expect(values.rotationDegrees).toBe(IMAGE_LIMITS.rotationDegrees.min);
    expect(values.opacity).toBe(IMAGE_LIMITS.opacity.min);
  });

  it('only calls the middle layer the middle layer', () => {
    expect(imageBehindSubject({ style: 'behind-subject' })).toBe(true);
    expect(imageBehindSubject({ style: 'overlay' })).toBe(false);
    expect(imageBehindSubject({})).toBe(false);
    expect(isImageStyle('overlay')).toBe(true);
    expect(isImageStyle('middle')).toBe(false);
  });

  it('recognises the same file again and two different files apart', () => {
    expect(imageKey(source('a.png'))).toBe(imageKey(source('a.png')));
    expect(imageKey(source('a.png'))).not.toBe(imageKey(source('b.png')));
    expect(imageKey({ ...source(), sourcePath: 'D:\\a.png' })).toBe('path:D:\\a.png');
  });
});

describe('where a placement lands on the frame', () => {
  it('keeps the aspect ratio and reads the size as a share of the frame width', () => {
    const box = imageBox(placement({ scale: 0.5 }), 1920, 1080);
    expect(box.width).toBe(960);
    // 400x200 is 2:1, so half the frame width is a quarter of it tall.
    expect(box.height).toBe(480);
  });

  it('centres on positionX and positionY', () => {
    const box = imageBox(placement({ scale: 0.25, positionX: 0.25, positionY: 0.75 }), 1000, 1000);
    expect(box.x).toBe(250);
    expect(box.y).toBe(750);
  });

  it('reports a picture pushed off the side as not contained', () => {
    expect(imageBox(placement({ scale: 0.2, positionX: 0.5 }), 1000, 1000).contained).toBe(true);
    expect(imageBox(placement({ scale: 0.2, positionX: 0.02 }), 1000, 1000).contained).toBe(false);
  });

  it('measures the rotated bounding box, not the upright one', () => {
    const upright = imageBox(placement({ scale: 0.5, rotationDegrees: 0 }), 1000, 1000);
    const turned = imageBox(placement({ scale: 0.5, rotationDegrees: 90 }), 1000, 1000);
    expect(turned.right - turned.left).toBeCloseTo(upright.bottom - upright.top, 5);
    expect(turned.bottom - turned.top).toBeCloseTo(upright.right - upright.left, 5);
  });
});

describe('what is on screen at an instant', () => {
  it('returns every placement covering the instant, not only the first', () => {
    const both = imagesAt([
      segment(placement({ id: 'image-1' }), 0, 5),
      segment(placement({ id: 'image-2' }), 1, 4)
    ], 2);
    expect(both.map(entry => entry.image.id)).toEqual(['image-1', 'image-2']);
  });

  it('excludes a placement whose section has ended', () => {
    expect(imagesAt([segment(placement(), 0, 2)], 2.5)).toEqual([]);
  });

  it('is fully on throughout a placement with no fade', () => {
    const [entry] = imagesAt([segment(placement(), 0, 4, 0)], 0);
    expect(entry.opacity).toBe(1);
  });

  it('ramps in and out over the fade and never past full strength', () => {
    const segments = [segment(placement(), 0, 4, 1)];
    expect(imagesAt(segments, 0.5)[0].opacity).toBeGreaterThan(0);
    expect(imagesAt(segments, 0.5)[0].opacity).toBeLessThan(1);
    expect(imagesAt(segments, 2)[0].opacity).toBe(1);
    expect(imagesAt(segments, 3.5)[0].opacity).toBeLessThan(1);
    expect(imagesAt(segments, 3.9)[0].opacity)
      .toBeLessThan(imagesAt(segments, 3.5)[0].opacity);
  });

  it('multiplies the fade by the placement own opacity', () => {
    const [entry] = imagesAt([segment(placement({ opacity: 0.5 }), 0, 4, 0)], 2);
    expect(entry.opacity).toBeCloseTo(0.5, 5);
  });

  it('keeps a fade from exceeding half the placement', () => {
    // A two-second placement asked for a four-second fade still reaches full
    // strength at its middle rather than never arriving at all.
    const [entry] = imagesAt([segment(placement(), 0, 2, 4)], 1);
    expect(entry.opacity).toBe(1);
  });

  it('answers only for the named container when one is given', () => {
    const segments = [segment(placement({ id: 'image-1' }), 0, 4)];
    expect(imagesAt(segments, 1, 'clip-1').length).toBe(1);
    expect(imagesAt(segments, 1, 'clip-2').length).toBe(0);
  });
});

describe('placements on the timeline', () => {
  it('translates a placement onto the output clock and back', () => {
    const image = placement({ startSeconds: 2, durationSeconds: 3 });
    const plan = buildProjectPlan([clip('clip-1', [image])], DEFAULT_PROJECT, 'video');
    expect(plan.images?.length).toBe(1);
    expect(plan.images![0].start).toBeCloseTo(2, 5);
    expect(plan.images![0].end).toBeCloseTo(5, 5);
    expect(plan.images![0].clipId).toBe('clip-1');
  });

  it('divides the fade by the speed, as the section edges are divided', () => {
    const project = { ...DEFAULT_PROJECT, edits: { ...cloneEdits(DEFAULT_PROJECT.edits), speed: 2 } };
    const image = placement({ startSeconds: 0, durationSeconds: 4, fadeSeconds: 1 });
    const plan = buildProjectPlan([clip('clip-1', [image])], project, 'video');
    expect(plan.images![0].fadeSeconds).toBeCloseTo(0.5, 5);
  });

  it('asks for compositing at an instant a placement covers, and not outside it', () => {
    const plan = buildProjectPlan(
      [clip('clip-1', [placement({ startSeconds: 2, durationSeconds: 2 })])], DEFAULT_PROJECT, 'video'
    );
    expect(needsCompositing(plan, 3)).toBe(true);
    expect(needsCompositing(plan, 6)).toBe(false);
  });
});

describe('a placement through the project document', () => {
  it('survives a save and an open, without storing any picture bytes', () => {
    const image = placement({ startSeconds: 1.5, durationSeconds: 2.5, style: 'behind-subject', scale: 0.4, rotationDegrees: 12 });
    const stored = serializeProject([clip('clip-1', [image])], DEFAULT_PROJECT, 3);
    const written = JSON.stringify(stored);
    expect(written).not.toContain('data:image');
    expect(written).toContain('chart.png');

    const restored = restoreProject(JSON.parse(written));
    const back = (restored.clips[0] as MediaClip).images ?? [];
    expect(back.length).toBe(1);
    expect(back[0].startSeconds).toBeCloseTo(1.5, 5);
    expect(back[0].durationSeconds).toBeCloseTo(2.5, 5);
    expect(back[0].style).toBe('behind-subject');
    expect(back[0].scale).toBeCloseTo(0.4, 5);
    expect(back[0].rotationDegrees).toBe(12);
    expect(back[0].source.name).toBe('chart.png');
    // The bytes are not in the document, so the placement comes back waiting
    // for its file rather than silently rendering nothing.
    expect(back[0].source.awaitingFile).toBe(true);
  });

  it('opens a project written before placements existed', () => {
    const stored = serializeProject([clip('clip-1')], DEFAULT_PROJECT, 3);
    const restored = restoreProject(JSON.parse(JSON.stringify(stored)));
    expect((restored.clips[0] as MediaClip).images).toEqual([]);
  });
});

describe('drawing a placement', () => {
  it('draws nothing when the picture has not been decoded', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const context = canvas.getContext('2d')!;
    expect(drawClipImage(context, placement(), 100, 100, 1)).toBe(false);
  });

  it('reports a picture it cannot read instead of failing silently', async () => {
    const broken: ClipImageSource = { ...source('broken.png'), file: new File([], 'broken.png'), awaitingFile: true };
    const plan = { images: [segment(placement({ id: 'image-broken', source: broken }))] } as unknown as ProjectPlan;
    const missing = await loadPlanImages(plan);
    expect(missing.length).toBe(1);
    expect(missing[0]).toContain('broken.png');
  });
});

describe('the restraint the clients are held to', () => {
  it('is twenty degrees, and is a guideline rather than a limit', () => {
    expect(IMAGE_RESTRAINED_ROTATION).toBe(20);
    // The editor itself refuses nothing: a reader who wants a picture on its
    // side is not overruled by a guideline written for an agent.
    expect(imagePlacement({ source: source(), rotationDegrees: 90 }).rotationDegrees).toBe(90);
  });
});
