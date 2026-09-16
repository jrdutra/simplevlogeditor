import { backgroundCaptionEnvelope, backgroundCaptionMotion, drawCaption } from './caption-renderer';
import { DEFAULT_CAPTION, clampCaption } from './video-editor-defaults';
import { ClipCaption } from './video-editor.models';
import { SubjectSegmentationClient } from './subject-segmentation';

function contextStub(): CanvasRenderingContext2D {
  return {
    save: jasmine.createSpy('save'),
    restore: jasmine.createSpy('restore'),
    translate: jasmine.createSpy('translate'),
    rotate: jasmine.createSpy('rotate'),
    fillText: jasmine.createSpy('fillText'),
    strokeText: jasmine.createSpy('strokeText'),
    measureText: (text: string) => ({ width: text.length * 20 }) as TextMetrics
  } as unknown as CanvasRenderingContext2D;
}

describe('caption renderer', () => {
  it('keeps classic captions on the existing outlined path', () => {
    const context = contextStub();
    drawCaption(context, { ...DEFAULT_CAPTION, text: 'Classic caption' }, 1920, 1080);

    expect(context.strokeText).toHaveBeenCalled();
    expect(context.translate).not.toHaveBeenCalled();
  });

  it('draws Behind Subject as fixed uppercase multiline text without a hard outline', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const caption: ClipCaption = {
      ...DEFAULT_CAPTION,
      style: 'behind-subject',
      stylePreset: 'behind-subject',
      text: 'dois\ndias',
      fontFamily: 'impact',
      fontWeight: 900,
      fontScale: 0.28,
      positionX: 0.5,
      positionY: 0.34,
      outlinePercent: 0,
      shadowBlurPercent: 70,
      shadowOpacity: 0.9,
      uppercase: true
    };

    drawCaption(context, caption, 320, 180);
    const automatic = context.getImageData(0, 0, 320, 180).data;
    context.clearRect(0, 0, 320, 180);
    drawCaption(context, { ...caption, text: 'DOIS\nDIAS', uppercase: false }, 320, 180);
    expect(context.getImageData(0, 0, 320, 180).data).toEqual(automatic);
    expect(automatic.some((value) => value > 0)).toBeTrue();
  });

  it('uses the background rendering path for every grouped preset even without a legacy style field', () => {
    const presetOnly = document.createElement('canvas');
    const explicitStyle = document.createElement('canvas');
    presetOnly.width = explicitStyle.width = 320;
    presetOnly.height = explicitStyle.height = 180;
    const caption: ClipCaption = {
      ...DEFAULT_CAPTION,
      style: undefined,
      stylePreset: 'behind-subject-upper-right',
      text: 'BACKGROUND',
      positionX: 0.7,
      positionY: 0.24,
      fontScale: 0.26,
      outlinePercent: 0
    };
    drawCaption(presetOnly.getContext('2d')!, caption, 320, 180);
    drawCaption(explicitStyle.getContext('2d')!, { ...caption, style: 'behind-subject' }, 320, 180);

    expect(presetOnly.getContext('2d')!.getImageData(0, 0, 320, 180).data)
      .toEqual(explicitStyle.getContext('2d')!.getImageData(0, 0, 320, 180).data);
  });

  it('fades the shadow and glyphs as one layer and produces a visible diffuse shadow', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const caption: ClipCaption = { ...DEFAULT_CAPTION, style: 'behind-subject', text: 'DEPTH', fontScale: 0.28 };
    drawCaption(context, caption, 320, 180, 0.25);
    const pixels = context.getImageData(0, 0, 320, 180).data;
    let maxAlpha = 0;
    let shadowPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      maxAlpha = Math.max(maxAlpha, pixels[i + 3]);
      if (pixels[i] < 30 && pixels[i + 3] > 3) shadowPixels++;
    }
    expect(maxAlpha).toBeLessThanOrEqual(64);
    expect(maxAlpha).toBeGreaterThan(60);
    expect(shadowPixels).toBeGreaterThan(100);
  });

  for (const [width, height] of [[640, 360], [360, 640], [360, 360]]) {
    it(`keeps rotated multiline glyphs inside ${width}x${height} at lateral and upper anchors`, () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      for (const [positionX, positionY] of [[0.34, 0.5], [0.66, 0.5], [0.5, 0.34], [0.08, 0.15], [0.92, 0.85]]) {
        context.clearRect(0, 0, width, height);
        drawCaption(context, {
          ...DEFAULT_CAPTION, style: 'behind-subject', text: 'FINALMENTE\nCHEGAMOS',
          fontScale: 0.4, fontFamily: 'impact', positionX, positionY, rotationDegrees: 20,
          shadowEnabled: false
        }, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        let visible = 0;
        let clipped = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (!pixels[(y * width + x) * 4 + 3]) continue;
          visible++;
          if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) clipped++;
        }
        expect(visible).toBeGreaterThan(0);
        expect(clipped).toBe(0);
      }
    });
  }

  it('clamps classic and Behind Subject sizes independently', () => {
    const classic = clampCaption({ ...DEFAULT_CAPTION, text: 'A', fontScale: 0.4 });
    const behind = clampCaption({
      ...DEFAULT_CAPTION, text: 'B', style: 'behind-subject', stylePreset: 'behind-subject', fontScale: 0.02
    });

    expect(classic.fontScale).toBe(0.12);
    expect(behind.fontScale).toBe(0.2);
    expect(behind.style).toBe('behind-subject');
  });

  it('keeps zooms and scrolls subtle, smooth and symmetric', () => {
    expect(backgroundCaptionMotion('zoom-in', 0, 1000, 500).scale).toBeCloseTo(0.92, 6);
    expect(backgroundCaptionMotion('zoom-in', 1, 1000, 500).scale).toBeCloseTo(1.02, 6);
    expect(backgroundCaptionMotion('zoom-out', 0, 1000, 500).scale).toBeCloseTo(1.1, 6);
    expect(backgroundCaptionMotion('zoom-out', 1, 1000, 500).scale).toBeCloseTo(1, 6);
    expect(backgroundCaptionMotion('scroll-left', 0, 1000, 500).x).toBeCloseTo(25, 6);
    expect(backgroundCaptionMotion('scroll-left', 1, 1000, 500).x).toBeCloseTo(-25, 6);
    expect(backgroundCaptionMotion('scroll-up', 0.5, 1000, 500).y).toBeCloseTo(0, 6);
    expect(backgroundCaptionMotion('none', 0.5, 1000, 500)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('animated background captions stay inside the frame', () => {
  const PROGRESS = [0, 0.15, 0.35, 0.5, 0.7, 0.85, 1];

  it('declares an envelope the motion never leaves', () => {
    for (const animation of ['none','zoom-in','zoom-out','scroll-left','scroll-right','scroll-up','scroll-down'] as const) {
      const envelope = backgroundCaptionEnvelope(animation as ClipCaption['animation']);
      for (let step = 0; step <= 100; step++) {
        const motion = backgroundCaptionMotion(animation as ClipCaption['animation'], step / 100, 1000, 1000);
        expect(motion.scale).toBeGreaterThanOrEqual(envelope.minScale - 1e-6);
        expect(motion.scale).toBeLessThanOrEqual(envelope.maxScale + 1e-6);
        expect(Math.abs(motion.x)).toBeLessThanOrEqual(1000 * envelope.shiftX + 1e-6);
        expect(Math.abs(motion.y)).toBeLessThanOrEqual(1000 * envelope.shiftY + 1e-6);
      }
    }
  });

  /** Painted pixels touching an outer row or column mean the text was cut off. */
  function touchesEdge(context: CanvasRenderingContext2D, width: number, height: number): boolean {
    const pixels = context.getImageData(0, 0, width, height).data;
    const painted = (x: number, y: number) => pixels[(y * width + x) * 4 + 3] > 8;
    for (let x = 0; x < width; x++) if (painted(x, 0) || painted(x, height - 1)) return true;
    for (let y = 0; y < height; y++) if (painted(0, y) || painted(width - 1, y)) return true;
    return false;
  }

  for (const [aspect, width, height] of [
    ['16:9', 640, 360], ['9:16', 360, 640], ['1:1', 480, 480]
  ] as const) {
    for (const animation of ['zoom-in','zoom-out','scroll-left','scroll-right','scroll-up','scroll-down'] as const) {
      for (const [label, positionX, positionY] of [
        ['upper-left', 0.08, 0.15], ['upper-right', 0.92, 0.15],
        ['centre-left', 0.08, 0.5], ['centre-right', 0.92, 0.85]
      ] as const) {
        it(`keeps a ${label} ${animation} caption off the edges in ${aspect}`, () => {
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext('2d')!;
          const caption = {
            ...DEFAULT_CAPTION, text: 'ANNOUNCING THE RESULT', style: 'behind-subject',
            fontScale: 0.4, positionX, positionY, animation,
            shadowEnabled: false, fadeIn: false, fadeOut: false
          } as unknown as ClipCaption;
          for (const progress of PROGRESS) {
            context.clearRect(0, 0, width, height);
            drawCaption(context, caption, width, height, 1, progress);
            expect(touchesEdge(context, width, height))
              .withContext(`${label} ${animation} at progress ${progress}`).toBeFalse();
          }
        });
      }
    }
  }
});

describe('preview analysis adapts without touching the export', () => {
  it('never reduces the analysis an export is given', () => {
    const encoder = new SubjectSegmentationClient({ adaptive: false });
    const reading = encoder.status();
    expect(reading.reduced).toBeFalse();
    expect(reading.analysisEdge).toBe(1024);
    encoder.dispose();
  });

  it('starts a preview at full analysis resolution', () => {
    const preview = new SubjectSegmentationClient();
    expect(preview.status().reduced).toBeFalse();
    expect(preview.status().analysisEdge).toBe(1024);
    expect(preview.status().averageMs).toBe(0);
    preview.dispose();
  });
});
