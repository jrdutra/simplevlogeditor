import { composeFrame } from './frame-compositor';
import { DEFAULT_CAPTION } from './video-editor-defaults';
import { ProjectPlan } from './video-editor.models';

describe('frame compositor subject layering', () => {
  it('occludes only the masked region while fallback preserves readable text', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const plan = {
      fillFrame: true, zooms: [], fades: [], tags: [], transitions: [],
      captions: [{ start: 0, end: 2, caption: {
        ...DEFAULT_CAPTION, text: 'DEPTH', style: 'behind-subject', fontScale: 0.28,
        shadowEnabled: false, fadeIn: false, fadeOut: false
      } }]
    } as unknown as ProjectPlan;
    const source = { width: 320, height: 180, draw: (target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
      target.fillStyle = '#0000ff';
      target.fillRect(0, 0, 320, 180);
    } };
    composeFrame(context, plan, 1, 320, 180, source);
    const fallback = context.getImageData(0, 0, 320, 180).data;
    composeFrame(context, plan, 1, 320, 180, source, null, {
      width: 320, height: 1, alpha: Uint8ClampedArray.from({ length: 320 }, (_, x) => x < 160 ? 0 : 255), coverage: 0.5
    });
    const masked = context.getImageData(0, 0, 320, 180).data;
    let visibleLeft = 0;
    let coveredRight = 0;
    let leakedRight = 0;
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
      const offset = (y * 320 + x) * 4;
      if (x >= 160 && masked[offset] > 0) leakedRight++;
      if (fallback[offset] < 200) continue;
      if (x < 155 && masked[offset] > 200) visibleLeft++;
      if (x > 165 && masked[offset] < 5) coveredRight++;
    }
    expect(visibleLeft).toBeGreaterThan(0);
    expect(coveredRight).toBeGreaterThan(0);
    expect(leakedRight).toBe(0);
    expect(plan.captions[0].caption.style).toBe('behind-subject');
  });
  it('draws the source again above a Behind Subject caption when a mask exists', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const draw = jasmine.createSpy('draw').and.callFake(
      (target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number) => {
        target.fillStyle = '#2474ff';
        target.fillRect(x, y, width, height);
      }
    );
    const plan = {
      width: 320,
      height: 180,
      fillFrame: true,
      zooms: [],
      fades: [],
      tags: [],
      transitions: [],
      captions: [{
        start: 0,
        end: 2,
        caption: {
          ...DEFAULT_CAPTION,
          text: 'DEPTH',
          style: 'behind-subject',
          stylePreset: 'behind-subject',
          fontScale: 0.28
        }
      }]
    } as unknown as ProjectPlan;

    composeFrame(context, plan, 1, 320, 180, { draw, width: 320, height: 180 }, null, {
      width: 1,
      height: 1,
      alpha: new Uint8ClampedArray([255]),
      coverage: 0.25
    });

    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('preserves a one-pixel matte detail without creating a blurred halo around it', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const caption = {
      ...DEFAULT_CAPTION,
      text: 'HAIR',
      style: 'behind-subject' as const,
      stylePreset: 'behind-subject',
      positionX: 0.5,
      positionY: 0.25,
      fontScale: 0.28,
      textColor: '#ff0000',
      shadowEnabled: false,
      fadeIn: false,
      fadeOut: false
    };
    const plan = {
      fillFrame: true, zooms: [], fades: [], tags: [], transitions: [],
      captions: [{ start: 0, end: 2, caption }]
    } as unknown as ProjectPlan;
    const source = {
      width: 320,
      height: 180,
      draw: (target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
        target.fillStyle = '#0000ff';
        target.fillRect(0, 0, 320, 180);
      }
    };

    composeFrame(context, plan, 1, 320, 180, source);
    const baseline = context.getImageData(0, 0, 320, 180);
    let chosen = -1;
    for (let pixel = 321; pixel < 320 * 179 - 321; pixel++) {
      const offset = pixel * 4;
      if (baseline.data[offset] > 200 && baseline.data[offset + 2] < 40) {
        chosen = pixel;
        break;
      }
    }
    expect(chosen).toBeGreaterThan(0);
    const alpha = new Uint8ClampedArray(320 * 180);
    alpha[chosen] = 255;
    composeFrame(context, plan, 1, 320, 180, source, null, { width: 320, height: 180, alpha, coverage: 1 / alpha.length });
    const result = context.getImageData(0, 0, 320, 180).data;
    const chosenOffset = chosen * 4;
    expect(Array.from(result.slice(chosenOffset, chosenOffset + 4))).toEqual([0, 0, 255, 255]);
    for (const neighbour of [chosen - 321, chosen - 320, chosen - 319, chosen - 1, chosen + 1, chosen + 319, chosen + 320, chosen + 321]) {
      const offset = neighbour * 4;
      expect(Array.from(result.slice(offset, offset + 4)))
        .withContext(`unexpected halo at pixel ${neighbour}`)
        .toEqual(Array.from(baseline.data.slice(offset, offset + 4)));
    }
  });
});
