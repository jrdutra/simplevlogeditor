import { TextScene } from './text-video.models';
import { drawFrame, measureTextLayout } from './text-scene-renderer';

function scene(width: number, height: number, text: string): TextScene {
  return {
    width, height,
    background: { kind: 'color', color: '#010203' },
    text,
    fontFamily: 'Arial, sans-serif',
    fontScale: 0.22,
    fontWeight: 900,
    color: '#ffffff',
    letterSpacing: 0.02,
    lineHeight: 1.15,
    align: 'center',
    vertical: 'middle',
    margin: 0.07,
    legibility: 'outline',
    animation: 'scale-up',
    revealSeconds: 1,
    holdSeconds: 2,
    fadeIn: false,
    fadeOut: false,
    fadeSeconds: 0.5
  };
}

function renderedBounds(canvas: HTMLCanvasElement): { left: number; right: number; top: number; bottom: number } {
  const context = canvas.getContext('2d')!;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width;
  let right = -1;
  let top = canvas.height;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const offset = (y * canvas.width + x) * 4;
      if (pixels[offset] === 1 && pixels[offset + 1] === 2 && pixels[offset + 2] === 3) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { left, right, top, bottom };
}

describe('text card fitting', () => {
  for (const [label, width, height] of [
    ['landscape', 640, 360],
    ['vertical', 360, 640]
  ] as const) {
    it(`keeps a long accented chapter title inside the rendered ${label} frame`, () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      const card = scene(
        width,
        height,
        'CAPÍTULO ESPECIAL: UMA EXPLICAÇÃO MUITO LONGA QUE PRECISA CABER SEM CORTAR NENHUMA LETRA'
      );

      const measured = measureTextLayout(context, card);
      drawFrame(context, card, card.revealSeconds);
      const pixels = renderedBounds(canvas);
      const safe = Math.floor(height * card.margin);

      expect(measured.fitted).toBeTrue();
      expect(measured.lines.length).toBeGreaterThan(1);
      expect(pixels.left).toBeGreaterThanOrEqual(safe - 1);
      expect(pixels.right).toBeLessThanOrEqual(width - safe);
      expect(pixels.top).toBeGreaterThanOrEqual(safe - 1);
      expect(pixels.bottom).toBeLessThanOrEqual(height - safe);
    });

    it(`leaves a short ${label} title larger than a long one`, () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      const short = measureTextLayout(context, scene(width, height, 'DIA 2'));
      const long = measureTextLayout(context, scene(
        width,
        height,
        'UM TÍTULO DE CAPÍTULO CONSIDERAVELMENTE MAIS LONGO PARA TESTAR O AJUSTE AUTOMÁTICO'
      ));

      expect(short.fontSize).toBeGreaterThan(long.fontSize);
    });
  }
});
