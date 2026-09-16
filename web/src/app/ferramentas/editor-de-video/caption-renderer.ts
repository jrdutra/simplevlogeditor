/**
 * The caption burned into the bottom of a clip.
 *
 * One function, drawn the same way in the preview and in the encoder, because a
 * caption that sits differently in the exported file than it did on screen is
 * worse than no preview at all.
 *
 * Every visual choice is carried by the caption itself. Presets only fill those
 * values in the editor; this painter never needs to know whether the reader
 * chose a preset or built the style by hand.
 */

import { ClipCaption } from './video-editor.models';
import { canvasOfSize, sizeCanvas } from './frame-source';
import { isBackgroundCaption } from './video-editor-defaults';

export type CaptionContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const behindLayers = new WeakMap<CaptionContext, {
  key: string;
  canvas: OffscreenCanvas | HTMLCanvasElement;
}>();

/** Only stacks the browser already has: a font fetched late would draw twice. */
const FONT_STACKS: Record<NonNullable<ClipCaption['fontFamily']>, string> = {
  sans: '"Inter", "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif',
  rounded: '"Arial Rounded MT Bold", "Trebuchet MS", "Segoe UI", Verdana, "DejaVu Sans", sans-serif',
  serif: 'Georgia, "Times New Roman", "Liberation Serif", "DejaVu Serif", serif',
  mono: 'Consolas, "Courier New", "Liberation Mono", "DejaVu Sans Mono", monospace',
  impact: 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", "Liberation Sans Narrow", sans-serif',
  display: 'Bahnschrift, "Arial Narrow", "Liberation Sans Narrow", "DejaVu Sans Condensed", "Segoe UI", sans-serif',
  geometric: '"Century Gothic", Futura, Avenir, "URW Gothic", "Segoe UI", sans-serif',
  slab: 'Rockwell, "Roboto Slab", "Bitstream Vera Serif", Georgia, serif',
  handwritten: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "URW Chancery L", cursive'
};

/** Share of the frame width a caption line may occupy before it wraps. */
const MAX_WIDTH_SHARE = 0.86;

/** Line spacing, as a multiple of the type size. */
const LINE_HEIGHT = 1.25;

/**
 * Draws the caption, or does nothing when there is nothing to draw.
 *
 * `opacity` is the caption's own fade, which is separate from the clip's: a
 * caption can arrive after the picture has, and leave before it does.
 */
export function drawCaption(
  context: CaptionContext,
  caption: ClipCaption,
  frameWidth: number,
  frameHeight: number,
  opacity = 1,
  animationProgress = 0
): void {
  const text = caption.text.trim();
  if (!text || opacity <= 0.002) return;

  if (isBackgroundCaption(caption)) {
    drawBehindSubjectCaption(context, caption, frameWidth, frameHeight, opacity, animationProgress);
    return;
  }

  const fontSize = Math.max(8, frameHeight * caption.fontScale);
  const lineHeight = fontSize * LINE_HEIGHT;

  context.save();
  context.globalAlpha = Math.min(1, Math.max(0, opacity));
  const family = FONT_STACKS[caption.fontFamily ?? 'sans'];
  const weight = Math.min(900, Math.max(100, caption.fontWeight ?? 700));
  context.font = `${caption.italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.lineJoin = 'round';
  // Without this a sharp corner — the point of a `W`, an accent — grows a spike
  // several times the stroke width when the outline is this thick.
  context.miterLimit = 2;

  const lines = wrap(context, text, frameWidth * MAX_WIDTH_SHARE);
  const x = frameWidth / 2;

  // The block grows upwards from the margin, so adding a second line pushes the
  // first one up and the caption never creeps towards the bottom edge.
  const bottom = frameHeight - frameHeight * caption.bottomMargin;
  const firstBaseline = bottom - (lines.length - 1) * lineHeight;

  for (const [index, line] of lines.entries()) {
    const y = firstBaseline + index * lineHeight;

    // The shadow is carried by the outline pass alone. Painting it under the
    // fill as well would darken the inside of every letter, since the fill sits
    // exactly on top of the stroke.
    if (caption.shadowEnabled !== false) {
      context.shadowColor = caption.shadowColor ?? '#000000';
      context.shadowBlur = fontSize * 0.22;
      context.shadowOffsetY = fontSize * 0.06;
    } else {
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;
    }
    context.lineWidth = fontSize * Math.max(0, caption.outlinePercent ?? 16) / 100;
    context.strokeStyle = caption.outlineColor ?? '#000000';
    const hasOutline = context.lineWidth > 0.01;
    if (hasOutline) context.strokeText(line, x, y);

    // With an outline the shadow belongs to that pass; without one it belongs
    // to the fill, so the shadow switch remains genuinely independent.
    if (hasOutline) {
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;
    }
    context.fillStyle = caption.textColor ?? '#ffffff';
    context.fillText(line, x, y);
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
  }

  context.restore();
}

/**
 * Paints the middle layer of a behind-subject caption. The compositor may draw
 * the isolated subject over this afterwards; without a mask this remains a
 * complete, readable caption in exactly the same position.
 */
function drawBehindSubjectCaption(
  context: CaptionContext,
  caption: ClipCaption,
  frameWidth: number,
  frameHeight: number,
  opacity: number,
  animationProgress: number
): void {
  // Build opaque glyphs and their shadows together, then fade the entire layer
  // once. Fading each shadow pass separately would make the glyphs too opaque.
  const envelope = backgroundCaptionEnvelope(caption.animation);
  // Rasterised with as many pixels as the zoom will ever ask for. Drawing a
  // frame-sized layer at 1.1x resamples the glyphs upwards and softens exactly
  // the moment the caption is largest and most read.
  const supersample = Math.max(1, envelope.maxScale);
  const layerWidth = Math.max(1, Math.round(frameWidth * supersample));
  const layerHeight = Math.max(1, Math.round(frameHeight * supersample));
  const key = JSON.stringify([frameWidth, frameHeight, supersample, caption]);
  let layer = behindLayers.get(context);
  if (!layer) {
    layer = { key: '', canvas: canvasOfSize(layerWidth, layerHeight) };
    behindLayers.set(context, layer);
  }
  if (layer.key !== key) {
    sizeCanvas(layer.canvas, layerWidth, layerHeight);
    const target = layer.canvas.getContext('2d') as CaptionContext | null;
    if (!target) return;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, layerWidth, layerHeight);
    // The geometry stays in frame coordinates; only the pixel density changes.
    target.save();
    target.scale(supersample, supersample);
    paintBehindSubjectCaption(target, caption, frameWidth, frameHeight, envelope);
    target.restore();
    layer.key = key;
  }
  const layerCanvas = layer.canvas;
  context.save();
  context.globalAlpha = Math.min(1, Math.max(0, opacity));
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const motion = backgroundCaptionMotion(caption.animation, animationProgress, frameWidth, frameHeight);
  const paint = (x: number, y: number) => context.drawImage(
    layerCanvas as CanvasImageSource, 0, 0, layerWidth, layerHeight, x, y, frameWidth, frameHeight
  );
  if (motion.scale === 1 && motion.x === 0 && motion.y === 0) {
    paint(0, 0);
  } else {
    context.translate(frameWidth / 2 + motion.x, frameHeight / 2 + motion.y);
    context.scale(motion.scale, motion.scale);
    paint(-frameWidth / 2, -frameHeight / 2);
  }
  context.restore();
}

/**
 * The extremes {@link backgroundCaptionMotion} will reach over a whole caption.
 *
 * The fit used to be computed at rest and the animation applied afterwards, so
 * a caption fitted exactly to its margin was then scaled up to 1.1x about the
 * centre of the frame — which pushes an upper-left or centre-right anchor
 * outwards, not inwards, and clipped the first or last letters off screen. The
 * text is now fitted against the worst instant of its own animation.
 */
export function backgroundCaptionEnvelope(animation: ClipCaption['animation']): {
  minScale: number; maxScale: number; shiftX: number; shiftY: number;
} {
  switch (animation) {
    case 'zoom-in': return { minScale: 0.92, maxScale: 1.02, shiftX: 0, shiftY: 0 };
    case 'zoom-out': return { minScale: 1, maxScale: 1.1, shiftX: 0, shiftY: 0 };
    case 'scroll-left':
    case 'scroll-right': return { minScale: 1, maxScale: 1, shiftX: 0.025, shiftY: 0 };
    case 'scroll-up':
    case 'scroll-down': return { minScale: 1, maxScale: 1, shiftX: 0, shiftY: 0.02 };
    default: return { minScale: 1, maxScale: 1, shiftX: 0, shiftY: 0 };
  }
}

/**
 * How far the text may reach from its anchor and still be on screen at every
 * instant of the animation.
 *
 * The compositor maps a point `p` to `centre + shift + scale * (p - centre)`.
 * Requiring both ends of the block to stay inside the margin gives a bound on
 * the half-extent for each extreme of the envelope; the smallest one wins. With
 * no animation this returns exactly what the static fit always used, so no
 * still preset moves by a pixel.
 */
function safeHalfExtent(
  anchor: number, size: number, margin: number, scales: readonly number[], shift: number
): number {
  const centre = size / 2;
  let limit = Infinity;
  for (const scale of scales) {
    for (const offset of shift ? [-shift, shift] : [0]) {
      limit = Math.min(
        limit,
        (centre + offset - margin) / scale + (anchor - centre),
        (centre - margin - offset) / scale - (anchor - centre)
      );
    }
  }
  return Math.max(0, limit);
}

/** A restrained, continuous transform driven by the caption's own lifetime. */
export function backgroundCaptionMotion(
  animation: ClipCaption['animation'],
  progress: number,
  frameWidth: number,
  frameHeight: number
): { scale: number; x: number; y: number } {
  const position = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const eased = position * position * (3 - 2 * position);
  switch (animation) {
    case 'zoom-in': return { scale: 0.92 + eased * 0.1, x: 0, y: 0 };
    case 'zoom-out': return { scale: 1.1 - eased * 0.1, x: 0, y: 0 };
    case 'scroll-left': return { scale: 1, x: frameWidth * (0.025 - eased * 0.05), y: 0 };
    case 'scroll-right': return { scale: 1, x: frameWidth * (-0.025 + eased * 0.05), y: 0 };
    case 'scroll-up': return { scale: 1, x: 0, y: frameHeight * (0.02 - eased * 0.04) };
    case 'scroll-down': return { scale: 1, x: 0, y: frameHeight * (-0.02 + eased * 0.04) };
    default: return { scale: 1, x: 0, y: 0 };
  }
}

/**
 * Where a background caption's lettering ends up, before anything is drawn.
 *
 * Split out of the painter so that one piece of code answers the question for
 * both of its readers: the painter, which draws there, and `captionBox`, which
 * reports it so the panel can say that a placed picture is about to cover the
 * words. Two implementations of this arithmetic would disagree the first time
 * either was touched, and the disagreement would be invisible — a warning that
 * never fires, or one that fires over nothing.
 *
 * Nothing here transforms the context. The measurements are taken in frame
 * coordinates and the painter applies its own translate and rotate afterwards,
 * which is safe because `measureText` ignores the transform anyway.
 */
interface BackgroundCaptionLayout {
  x: number;
  y: number;
  angle: number;
  fontSize: number;
  lines: string[];
  family: string;
  weight: number;
  /** The lettering's own size, upright, before rotation. */
  width: number;
  height: number;
}

function backgroundCaptionLayout(
  context: CaptionContext, caption: ClipCaption, frameWidth: number, frameHeight: number,
  envelope = backgroundCaptionEnvelope(caption.animation)
): BackgroundCaptionLayout {
  const text = caption.uppercase === false ? caption.text.trim() : caption.text.trim().toUpperCase();
  const requestedSize = frameHeight * Math.min(0.4, Math.max(0.2, caption.fontScale || 0.28));
  const family = FONT_STACKS[caption.fontFamily ?? 'sans'];
  const weight = Math.min(900, Math.max(100, caption.fontWeight ?? 600));
  const x = frameWidth * Math.min(0.92, Math.max(0.08, caption.positionX ?? 0.5));
  const y = frameHeight * Math.min(0.85, Math.max(0.15, caption.positionY ?? 0.25));
  const scales = [envelope.minScale, envelope.maxScale];
  const maxWidth = 2 * safeHalfExtent(x, frameWidth, frameWidth * 0.03, scales, frameWidth * envelope.shiftX);
  const maxHeight = 2 * safeHalfExtent(y, frameHeight, frameHeight * 0.03, scales, frameHeight * envelope.shiftY);
  const angle = (caption.rotationDegrees ?? 0) * Math.PI / 180;

  context.save();
  let fontSize = requestedSize;
  context.font = `${caption.italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`;
  let lines = wrap(context, text, maxWidth);
  const heightLimit = Math.min(frameHeight * 0.72, maxHeight);
  const neededHeight = lines.length * fontSize * 0.92;
  if (neededHeight > heightLimit) {
    fontSize *= heightLimit / neededHeight;
    context.font = `${caption.italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`;
    lines = wrap(context, text, maxWidth);
  }

  // Long single words should remain in-frame without being arbitrarily split.
  // Include glyph overhang and rotation when fitting the fixed anchor. Moving
  // to center-left/right must not crop the first or last letters off screen.
  const widest = lines.reduce((width, line) => {
    const metrics = context.measureText(line);
    return Math.max(width, metrics.width, 2 * (metrics.actualBoundingBoxLeft || 0), 2 * (metrics.actualBoundingBoxRight || 0));
  }, 0);
  const blockHeight = ((lines.length - 1) * 0.92 + 1.3) * fontSize;
  const rotatedWidth = Math.abs(Math.cos(angle)) * widest + Math.abs(Math.sin(angle)) * blockHeight;
  const rotatedHeight = Math.abs(Math.sin(angle)) * widest + Math.abs(Math.cos(angle)) * blockHeight;
  const fit = Math.min(1, maxWidth / Math.max(1, rotatedWidth), maxHeight / Math.max(1, rotatedHeight));
  if (fit < 1) fontSize *= fit;
  context.restore();

  return { x, y, angle, fontSize, lines, family, weight, width: widest * fit, height: blockHeight * fit };
}

function paintBehindSubjectCaption(
  context: CaptionContext, caption: ClipCaption, frameWidth: number, frameHeight: number,
  envelope = backgroundCaptionEnvelope(caption.animation)
): void {
  const layout = backgroundCaptionLayout(context, caption, frameWidth, frameHeight, envelope);
  const { lines, fontSize, family, weight } = layout;

  context.save();
  context.globalAlpha = 1;
  context.translate(layout.x, layout.y);
  context.rotate(layout.angle);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.font = `${caption.italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`;

  const lineHeight = fontSize * 0.92;
  const firstY = -((lines.length - 1) * lineHeight) / 2;
  const shadowOpacity = Math.min(1, Math.max(0, caption.shadowOpacity ?? 0.9));
  const blur = fontSize * Math.min(1.2, Math.max(0.1, (caption.shadowBlurPercent ?? 70) / 100));

  for (const [index, line] of lines.entries()) {
    const lineY = firstY + index * lineHeight;
    if (caption.shadowEnabled !== false && shadowOpacity > 0) {
      // Three soft passes create a deep gradient without the hard edge of a
      // stroke. Opaque glyphs are required: the canvas also multiplies a shadow
      // by the source glyph's alpha, so a nearly transparent fill loses depth.
      for (const pass of [
        { blur: blur * 0.34, y: fontSize * 0.035, alpha: shadowOpacity * 0.55 },
        { blur: blur * 0.72, y: fontSize * 0.075, alpha: shadowOpacity * 0.36 },
        { blur, y: fontSize * 0.12, alpha: shadowOpacity * 0.2 }
      ]) {
        context.shadowColor = colourWithAlpha(caption.shadowColor ?? '#000000', pass.alpha);
        context.shadowBlur = pass.blur;
        context.shadowOffsetY = pass.y;
        context.fillStyle = caption.textColor ?? '#ffffff';
        context.fillText(line, 0, lineY);
      }
    }
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
    context.fillStyle = caption.textColor ?? '#ffffff';
    context.fillText(line, 0, lineY);
  }

  context.restore();
}

function colourWithAlpha(colour: string, alpha: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (!match) return colour;
  return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${Math.min(1, Math.max(0, alpha))})`;
}

/**
 * Breaks the caption into lines that fit.
 *
 * Line breaks the reader typed are honoured first and always: someone who
 * pressed Enter meant it. Everything else wraps on spaces, and a single word
 * too long for the width is left to overflow rather than broken — a hyphen the
 * writer did not ask for is a worse outcome than a wide line.
 */
function wrap(context: CaptionContext, text: string, maxWidth: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }

    let current = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${current} ${word}`;
      if (context.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }
      lines.push(current);
      current = word;
    }
    lines.push(current);
  }

  return lines;
}

/** How tall the caption will be, so a preview can reserve room for it. */
/**
 * The rectangle a caption occupies on the frame, in pixels.
 *
 * Reported rather than guessed: the panel uses it to say that a placed picture
 * is about to cover the words, and a guess would either cry wolf or stay quiet
 * over a caption that really is hidden. A classic caption is a block above the
 * bottom margin; a background caption is the rotated lettering around its own
 * anchor, measured by the same function the painter lays out with.
 *
 * `null` when there is nothing to draw, so a caller can tell "no caption" from
 * "a caption somewhere else".
 */
export function captionBox(
  context: CaptionContext, caption: ClipCaption, frameWidth: number, frameHeight: number
): { left: number; top: number; right: number; bottom: number } | null {
  const text = caption.text.trim();
  if (!text) return null;

  if (isBackgroundCaption(caption)) {
    const layout = backgroundCaptionLayout(context, caption, frameWidth, frameHeight);
    const cos = Math.abs(Math.cos(layout.angle));
    const sin = Math.abs(Math.sin(layout.angle));
    const halfWidth = (cos * layout.width + sin * layout.height) / 2;
    const halfHeight = (sin * layout.width + cos * layout.height) / 2;
    return {
      left: layout.x - halfWidth, top: layout.y - halfHeight,
      right: layout.x + halfWidth, bottom: layout.y + halfHeight
    };
  }

  const fontSize = Math.max(8, frameHeight * caption.fontScale);
  const lineHeight = fontSize * LINE_HEIGHT;
  context.save();
  const family = FONT_STACKS[caption.fontFamily ?? 'sans'];
  const weight = Math.min(900, Math.max(100, caption.fontWeight ?? 700));
  context.font = `${caption.italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`;
  const lines = wrap(context, text, frameWidth * MAX_WIDTH_SHARE);
  const widest = lines.reduce((width, line) => Math.max(width, context.measureText(line).width), 0);
  context.restore();

  // `bottomMargin` positions the last baseline, so the block reaches a little
  // below it for the descenders and upwards by one line for each extra line.
  const lastBaseline = frameHeight - frameHeight * caption.bottomMargin;
  return {
    left: frameWidth / 2 - widest / 2,
    top: lastBaseline - (lines.length - 1) * lineHeight - fontSize,
    right: frameWidth / 2 + widest / 2,
    bottom: lastBaseline + fontSize * 0.25
  };
}

export function captionHeight(caption: ClipCaption, frameHeight: number, lineCount: number): number {
  return Math.max(8, frameHeight * caption.fontScale) * LINE_HEIGHT * Math.max(1, lineCount);
}
