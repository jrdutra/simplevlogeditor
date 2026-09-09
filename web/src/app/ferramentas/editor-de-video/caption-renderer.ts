/**
 * The caption burned into the bottom of a clip.
 *
 * One function, drawn the same way in the preview and in the encoder, because a
 * caption that sits differently in the exported file than it did on screen is
 * worse than no preview at all.
 *
 * The look is fixed on purpose — white letters, a black outline, a soft shadow —
 * and the reader can change only what has to change: how big it is, how far it
 * sits from the bottom edge, and whether it fades. Those three are the ones that
 * depend on the footage. The rest is what keeps text legible over a picture
 * nobody has seen yet: the outline survives a white sky, the shadow separates
 * the letters from a busy background, and together they work on footage that is
 * light in one corner and dark in the other.
 */

import { ClipCaption } from './video-editor.models';

export type CaptionContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Only stacks the browser already has: a font fetched late would draw twice. */
const FONT_STACK = '"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif';

/** Share of the frame width a caption line may occupy before it wraps. */
const MAX_WIDTH_SHARE = 0.86;

/** Line spacing, as a multiple of the type size. */
const LINE_HEIGHT = 1.25;

/** Outline thickness, as a share of the type size. */
const OUTLINE_SHARE = 0.16;

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
  opacity = 1
): void {
  const text = caption.text.trim();
  if (!text || opacity <= 0.002) return;

  const fontSize = Math.max(8, frameHeight * caption.fontScale);
  const lineHeight = fontSize * LINE_HEIGHT;

  context.save();
  context.globalAlpha = Math.min(1, Math.max(0, opacity));
  context.font = `700 ${fontSize}px ${FONT_STACK}`;
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
    context.shadowColor = 'rgba(0, 0, 0, 0.6)';
    context.shadowBlur = fontSize * 0.22;
    context.shadowOffsetY = fontSize * 0.06;
    context.lineWidth = fontSize * OUTLINE_SHARE;
    context.strokeStyle = '#000000';
    context.strokeText(line, x, y);

    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
    context.fillStyle = '#ffffff';
    context.fillText(line, x, y);
  }

  context.restore();
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
export function captionHeight(caption: ClipCaption, frameHeight: number, lineCount: number): number {
  return Math.max(8, frameHeight * caption.fontScale) * LINE_HEIGHT * Math.max(1, lineCount);
}
