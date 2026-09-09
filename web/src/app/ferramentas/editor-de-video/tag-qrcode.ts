import { create } from 'qrcode';

type QrMatrix = ReturnType<typeof create>['modules'];

// Encoding is synchronous, as in texto-qrcode, and never repeated per frame.
// Bound the cache because an input event can produce a new payload per keystroke.
const matrices = new Map<string, QrMatrix | null>();
const paths = new WeakMap<QrMatrix, Path2D>();

export function qrTagMatrix(text: string): QrMatrix | null {
  if (!text.trim()) return null;
  if (matrices.has(text)) return matrices.get(text) ?? null;
  let matrix: QrMatrix | null = null;
  try {
    matrix = create(text, { errorCorrectionLevel: 'M' }).modules;
  } catch {
    // A payload exceeding QR capacity must not break playback or export.
  }
  if (matrices.size >= 16) matrices.delete(matrices.keys().next().value as string);
  matrices.set(text, matrix);
  return matrix;
}

export function qrTagError(text: string): string | null {
  if (!text.trim()) return 'Enter the text or URL to encode in the QR Code.';
  return qrTagMatrix(text) ? null : 'This content is too long for a QR Code. Shorten it to continue.';
}

export function drawQrTagCode(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number
): void {
  const matrix = qrTagMatrix(text);
  context.save();
  context.shadowColor = 'transparent';
  context.shadowBlur = 0;
  context.fillStyle = '#ffffff';
  context.fillRect(x, y, size, size);
  if (matrix) {
    // Four white modules on every side, including around the finder patterns.
    const unit = size / (matrix.size + 8);
    let modules = paths.get(matrix);
    if (!modules) {
      modules = new Path2D();
      for (let row = 0; row < matrix.size; row++) {
        for (let col = 0; col < matrix.size; col++) {
          if (matrix.get(row, col)) modules.rect(col + 4, row + 4, 1, 1);
        }
      }
      paths.set(matrix, modules);
    }
    context.translate(x, y);
    context.scale(unit, unit);
    context.fillStyle = '#000000';
    context.fill(modules);
  }
  context.restore();
}
