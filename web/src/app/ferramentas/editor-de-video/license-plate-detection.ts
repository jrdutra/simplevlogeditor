/** Country-independent plate localization; no OCR, number collection or remote inference. */
export const PLATE_MODEL = {
  url: '/assets/models/license-plates/detector.onnx',
  sha256: 'e5350bb2152eb44fa129b2438d1e39bbbf3c27accfe51cd893ce6e17d028d0b9',
  size: 640,
  confidence: 0.2
} as const;

export interface PlateBox { x: number; y: number; width: number; height: number; score: number }

export function plateLetterbox(width: number, height: number, size = PLATE_MODEL.size): {
  scale: number; width: number; height: number; left: number; top: number
} {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) throw new Error('Invalid plate frame size.');
  const scale = size / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  return { scale, width: w, height: h, left: Math.floor((size - w) / 2), top: Math.floor((size - h) / 2) };
}

/** Pinned YOLOX output: [1,8400,6], decoded cx/cy/w/h, objectness, plate probability. */
export function decodePlateBoxes(data: ArrayLike<number>, dims: readonly number[], width: number, height: number): PlateBox[] {
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 8400 || dims[2] !== 6 || data.length !== 8400 * 6) {
    throw new Error('Unexpected license plate detector output.');
  }
  const geometry = plateLetterbox(width, height);
  const boxes: PlateBox[] = [];
  for (let i = 0; i < data.length; i += 6) {
    const score = data[i + 4] * data[i + 5];
    if (!Number.isFinite(score) || score < PLATE_MODEL.confidence || score > 1) continue;
    const [cx, cy, w, h] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (![cx, cy, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const x1 = Math.max(0, (cx - w / 2 - geometry.left) / geometry.scale / width);
    const y1 = Math.max(0, (cy - h / 2 - geometry.top) / geometry.scale / height);
    const x2 = Math.min(1, (cx + w / 2 - geometry.left) / geometry.scale / width);
    const y2 = Math.min(1, (cy + h / 2 - geometry.top) / geometry.scale / height);
    if (x2 <= x1 || y2 <= y1) continue;
    boxes.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, score });
  }
  const kept: PlateBox[] = [];
  for (const box of boxes.sort((a, b) => b.score - a.score)) {
    if (!kept.some(other => plateIoU(box, other) > 0.45)) kept.push(box);
  }
  return kept;
}

function plateIoU(a: PlateBox, b: PlateBox): number {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Slightly over-cover a detected plate, including its border and nearby motion. */
export function paddedPlateBox(box: PlateBox, width: number, height: number): PlateBox {
  const dx = Math.max(4 / width, box.width * 0.18), dy = Math.max(4 / height, box.height * 0.3);
  const x = Math.max(0, box.x - dx), y = Math.max(0, box.y - dy);
  return { ...box, x, y, width: Math.min(1, box.x + box.width + dx) - x,
    height: Math.min(1, box.y + box.height + dy) - y };
}

/** Short, bounded hold reduces missed-frame flicker. Never carry boxes through a cut or seek. */
export class PlateBoxHistory {
  // A dissolve analyses two sources alternately. Keep their short histories
  // independent, with a fixed bound so old clips cannot accumulate in memory.
  private streams = new Map<string, { time: number; boxes: PlateBox[] }[]>();
  update(identity: string, time: number, boxes: PlateBox[]): PlateBox[] {
    let frames = this.streams.get(identity) ?? [];
    // A short backwards seek must invalidate *all* frames, including older
    // ones that would otherwise still pass the age filter.
    if (frames.length && time <= frames[frames.length - 1].time) frames = [];
    frames = frames.filter(frame => time - frame.time <= 0.12).slice(-2);
    const held = frames.flatMap(frame => frame.boxes);
    frames.push({ time, boxes });
    this.streams.delete(identity);
    this.streams.set(identity, frames);
    if (this.streams.size > 4) this.streams.delete(this.streams.keys().next().value!);
    return [...boxes, ...held];
  }
}
