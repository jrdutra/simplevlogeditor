/**
 * Pictures placed over a stretch of a container.
 *
 * Three jobs that belong together and nowhere else: the limits a placement is
 * held to, the cache that turns a file into something a canvas can draw, and
 * the drawing itself. The compositor and the panel both speak to this module
 * and neither of them has to know that decoding a picture is asynchronous while
 * drawing a frame is not — that is the whole reason the cache exists.
 */

import { ClipImage, ClipImageSource, ClipImageStyle, ImageSegment, ProjectPlan } from './video-editor.models';
import { FrameContext } from './frame-source';

/** What every placement control is allowed to be. */
export const IMAGE_LIMITS = {
  /** Width as a share of the frame width. */
  scale: { min: 0.02, max: 2, step: 0.01, default: 0.35 },
  /** Centre of the picture, as shares of the frame. */
  position: { min: 0, max: 1, step: 0.005 },
  /**
   * Full freedom by hand, and a much narrower habit asked of the AI clients.
   *
   * A placed picture reads as part of the shot up to about twenty degrees and
   * as a mistake past it, so the clients are told to stay inside
   * {@link IMAGE_RESTRAINED_ROTATION} unless the reader asked for more. The
   * editor itself refuses nothing: a reader who wants a picture on its side is
   * not being overruled by a guideline written for an agent.
   */
  rotationDegrees: { min: -180, max: 180, step: 1 },
  opacity: { min: 0.05, max: 1, step: 0.01, default: 1 },
  fadeSeconds: { min: 0, max: 10, step: 0.05, default: 0.3 }
} as const;

/** The rotation the AI clients keep inside of unless the reader asks for more. */
export const IMAGE_RESTRAINED_ROTATION = 20;

export const IMAGE_STYLES: { id: ClipImageStyle; label: string; description: string }[] = [
  {
    id: 'overlay',
    label: 'Over everything',
    description: 'The picture sits on top of the frame, in front of the person.'
  },
  {
    id: 'behind-subject',
    label: 'Behind the person',
    description: 'The picture joins the middle layer: in front of the scenery, behind whoever is talking.'
  }
];

/** File types a placement will accept. */
export const IMAGE_FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];

export function isImageStyle(value: unknown): value is ClipImageStyle {
  return value === 'overlay' || value === 'behind-subject';
}

/** True when this placement belongs to the middle layer. */
export function imageBehindSubject(image: Pick<ClipImage, 'style'>): boolean {
  return image.style === 'behind-subject';
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Every placement value, with the defaults filled in. */
export function imagePlacement(image: ClipImage): {
  positionX: number; positionY: number; scale: number; rotationDegrees: number; opacity: number;
} {
  return {
    positionX: clamp(Number.isFinite(image.positionX) ? image.positionX! : 0.5, IMAGE_LIMITS.position.min, IMAGE_LIMITS.position.max),
    positionY: clamp(Number.isFinite(image.positionY) ? image.positionY! : 0.5, IMAGE_LIMITS.position.min, IMAGE_LIMITS.position.max),
    scale: clamp(Number.isFinite(image.scale) ? image.scale! : IMAGE_LIMITS.scale.default, IMAGE_LIMITS.scale.min, IMAGE_LIMITS.scale.max),
    rotationDegrees: clamp(Number.isFinite(image.rotationDegrees) ? image.rotationDegrees! : 0,
      IMAGE_LIMITS.rotationDegrees.min, IMAGE_LIMITS.rotationDegrees.max),
    opacity: clamp(Number.isFinite(image.opacity) ? image.opacity! : IMAGE_LIMITS.opacity.default,
      IMAGE_LIMITS.opacity.min, IMAGE_LIMITS.opacity.max)
  };
}

/**
 * Where a picture lands on a frame of the given size, in pixels.
 *
 * Exported because two very different readers need the same answer: the drawing
 * below, and the report an agent reads back to find out whether the picture it
 * placed actually fits inside the frame. Working it out twice in two places is
 * how the report and the picture come to disagree.
 */
export function imageBox(
  image: ClipImage, frameWidth: number, frameHeight: number
): { x: number; y: number; width: number; height: number; angle: number; left: number; top: number; right: number; bottom: number; contained: boolean } {
  const placement = imagePlacement(image);
  const natural = imageAspect(image.source);
  const width = Math.max(1, frameWidth * placement.scale);
  const height = Math.max(1, width / natural);
  const x = frameWidth * placement.positionX;
  const y = frameHeight * placement.positionY;
  const angle = placement.rotationDegrees * Math.PI / 180;
  // The bounding box of the rotated rectangle, which is what decides whether
  // anything has been pushed off the frame.
  const halfWidth = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height) / 2;
  const halfHeight = (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height) / 2;
  const left = x - halfWidth;
  const top = y - halfHeight;
  const right = x + halfWidth;
  const bottom = y + halfHeight;
  return {
    x, y, width, height, angle, left, top, right, bottom,
    contained: left >= -0.5 && top >= -0.5 && right <= frameWidth + 0.5 && bottom <= frameHeight + 0.5
  };
}

/** Width over height of the file, falling back to a square when unmeasured. */
export function imageAspect(source: ClipImageSource): number {
  const width = Number.isFinite(source.width) && source.width > 0 ? source.width : 0;
  const height = Number.isFinite(source.height) && source.height > 0 ? source.height : 0;
  return width && height ? width / height : 1;
}

/** How a decoded picture is recognised again without holding on to the file. */
export function imageKey(source: ClipImageSource): string {
  if (source.sourcePath) return `path:${source.sourcePath}`;
  const ref = source.fileRef;
  if (ref) return `ref:${ref.name}:${ref.size}:${ref.lastModified}`;
  return `file:${source.name}:${source.file?.size ?? 0}:${source.file?.lastModified ?? 0}`;
}

type Decoded = ImageBitmap | HTMLImageElement;

const decoded = new Map<string, Decoded>();
const failures = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

/**
 * How much decoded picture is worth holding on to.
 *
 * A decoded 4K PNG is about 33 MB of memory, and a reader who tries twenty
 * pictures over an afternoon would otherwise never get any of them back. The
 * cap is only enforced against pictures the current plan does not need, so
 * nothing the timeline is about to draw is ever evicted mid-export.
 */
const DECODED_BUDGET_BYTES = 192 * 1024 * 1024;

function decodedBytes(image: Decoded): number {
  return Math.max(1, image.width) * Math.max(1, image.height) * 4;
}

function releaseDecoded(key: string): void {
  const held = decoded.get(key);
  if (held && 'close' in held && typeof held.close === 'function') held.close();
  decoded.delete(key);
}

/** Drops the oldest pictures the plan does not need, until the cache fits. */
function enforceDecodedBudget(keep: ReadonlySet<string>): void {
  let total = 0;
  for (const image of decoded.values()) total += decodedBytes(image);
  if (total <= DECODED_BUDGET_BYTES) return;
  // Map iteration is insertion order, so this drops what was decoded longest
  // ago first — which for a cache nobody reorders is the best available guess
  // at what is least likely to be wanted next.
  for (const [key, image] of [...decoded]) {
    if (total <= DECODED_BUDGET_BYTES) break;
    if (keep.has(key)) continue;
    total -= decodedBytes(image);
    releaseDecoded(key);
  }
}

/**
 * The decoded picture for a placement, or null.
 *
 * Synchronous on purpose. `composeFrame` runs sixty times a second and once per
 * exported frame; making it await a decode would make every frame of the export
 * wait on a picture that was already in memory. {@link loadPlanImages} does the
 * waiting, once, before anything is drawn.
 */
export function decodedImage(image: ClipImage): Decoded | null {
  return decoded.get(imageKey(image.source)) ?? null;
}

/** Why this picture could not be decoded, or an empty string. */
export function imageFailure(image: ClipImage): string {
  return failures.get(imageKey(image.source)) ?? '';
}

async function decode(source: ClipImageSource): Promise<void> {
  const key = imageKey(source);
  if (decoded.has(key)) return;
  if (source.awaitingFile || !source.file || source.file.size === 0) {
    failures.set(key, `${source.name} is not open in this session. Reopen the picture to render it.`);
    return;
  }
  try {
    if (typeof createImageBitmap === 'function') {
      decoded.set(key, await createImageBitmap(source.file));
    } else {
      const url = URL.createObjectURL(source.file);
      try {
        const element = new Image();
        element.decoding = 'async';
        await new Promise<void>((resolve, reject) => {
          element.onload = () => resolve();
          element.onerror = () => reject(new Error('decode failed'));
          element.src = url;
        });
        decoded.set(key, element);
      } finally {
        // Revoked only after the element has finished loading; an object URL
        // released too early gives a picture that silently never arrives.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    }
    failures.delete(key);
  } catch {
    failures.set(key, `${source.name} could not be decoded. It may not be an image this browser reads.`);
  }
}

/**
 * Decodes every picture the plan will need.
 *
 * Both the preview and the encoder call this before the first frame. Failures
 * are recorded rather than thrown: an export must say which picture is missing,
 * not stop with a stack trace, and the caller decides whether a missing picture
 * is worth refusing to export over.
 */
export async function loadPlanImages(plan: Pick<ProjectPlan, 'images'>): Promise<string[]> {
  const sources = new Map<string, ClipImageSource>();
  for (const segment of plan.images ?? []) sources.set(imageKey(segment.image.source), segment.image.source);
  await Promise.all([...sources.entries()].map(async ([key, source]) => {
    const running = pending.get(key) ?? decode(source).finally(() => pending.delete(key));
    pending.set(key, running);
    await running;
  }));
  enforceDecodedBudget(new Set(sources.keys()));
  return [...sources.keys()].map(key => failures.get(key) ?? '').filter(Boolean);
}

/** Decodes one picture on its own, for the panel's preview. */
export async function loadImage(source: ClipImageSource): Promise<Decoded | null> {
  await decode(source);
  return decoded.get(imageKey(source)) ?? null;
}

/** Forgets a decoded picture, so a replaced file is read again. */
export function forgetImage(source: ClipImageSource): void {
  const key = imageKey(source);
  releaseDecoded(key);
  failures.delete(key);
}

/**
 * The picture on screen at one instant, and how far it has faded in.
 *
 * Shaped like `captionAt`, but it answers with every picture rather than the
 * first: two placements may legitimately be on screen together — a logo in a
 * corner and a screenshot in the middle — and returning only one of them would
 * make the second silently never appear.
 */
export function imagesAt(
  segments: readonly ImageSegment[], time: number, clipId?: string
): { image: ClipImage; opacity: number }[] {
  const active: { image: ClipImage; opacity: number }[] = [];
  for (const segment of segments) {
    if (time < segment.start) break;
    if (time >= segment.end) continue;
    if (clipId && segment.clipId !== clipId) continue;
    const span = segment.end - segment.start;
    const fade = Math.min(Math.max(0, segment.fadeSeconds), span / 2);
    let gain = 1;
    if (fade > 0) {
      gain = Math.min((time - segment.start) / fade, (segment.end - time) / fade);
      gain = Math.min(1, Math.max(0, gain));
      // The same smoothstep the effect sections ramp with, so a picture and a
      // filter asked to arrive together arrive together.
      gain = gain * gain * (3 - 2 * gain);
    }
    const opacity = gain * imagePlacement(segment.image).opacity;
    if (opacity > 0.002) active.push({ image: segment.image, opacity });
  }
  return active;
}

/**
 * Draws one placed picture.
 *
 * Nothing here is in pixels of a particular output: the size is a share of the
 * frame width and the centre is a share of the frame, which is what lets the
 * preview compose at a quarter of the export's resolution and still show the
 * same picture in the same place.
 */
export function drawClipImage(
  context: FrameContext,
  image: ClipImage,
  frameWidth: number,
  frameHeight: number,
  opacity = 1
): boolean {
  if (opacity <= 0.002) return false;
  const bitmap = decodedImage(image);
  if (!bitmap) return false;

  const natural = bitmap.width && bitmap.height ? bitmap.width / bitmap.height : imageAspect(image.source);
  const placement = imagePlacement(image);
  const width = Math.max(1, frameWidth * placement.scale);
  const height = Math.max(1, width / natural);

  context.save();
  context.globalAlpha = Math.min(1, Math.max(0, opacity));
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.translate(frameWidth * placement.positionX, frameHeight * placement.positionY);
  context.rotate(placement.rotationDegrees * Math.PI / 180);
  context.drawImage(bitmap as CanvasImageSource, -width / 2, -height / 2, width, height);
  context.restore();
  return true;
}
