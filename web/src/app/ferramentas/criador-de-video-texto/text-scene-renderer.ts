import { HorizontalAlign, TextScene, sceneDuration } from './text-video.models';

/**
 * Draws one frame of a text scene.
 *
 * This file is the single source of truth for what the tool produces. The
 * preview on the page and the encoder that writes the file call the same
 * function with the same scene, so the reader is never shown an approximation
 * of their result — they are shown the result, one frame at a time.
 *
 * Everything is expressed in terms of the frame's own height, never in pixels:
 * the type size, the margins and the animation offsets are all fractions. That
 * is what lets a design composed against a 720p preview export at 4K with the
 * proportions untouched.
 */

/** How long a single letter or word takes to arrive, as a share of the reveal. */
const ITEM_DURATION = 0.35;

/** Blinks per second of the typewriter cursor. */
const CURSOR_BLINKS = 1.6;

/** How much the background creeps closer over a wipe-reveal clip. */
const KEN_BURNS_ZOOM = 0.09;

/** Shared drawing surface type: the tool never cares which kind it has. */
export type SceneContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** One laid-out line of text, in device pixels. */
interface LaidOutLine {
  text: string;
  x: number;
  y: number;
  width: number;
  /** Left edge of every character, relative to the line's own left edge. */
  charOffsets: number[];
  /** Start index and left edge of every word. */
  words: { text: string; start: number; offset: number; width: number }[];
}

interface Layout {
  lines: LaidOutLine[];
  fontSize: number;
  lineStep: number;
  top: number;
  height: number;
  left: number;
  right: number;
}

/** Whether this browser can apply a blur to canvas drawing operations. */
let filterSupport: boolean | null = null;

function supportsFilter(context: SceneContext): boolean {
  // Feature-detected once rather than assumed: without it the out-of-focus
  // animation still runs, it simply arrives sharp instead of blurred.
  filterSupport ??= typeof (context as CanvasRenderingContext2D).filter === 'string';
  return filterSupport;
}

/**
 * Paints the whole frame at `time`, in seconds from the start of the clip.
 *
 * `matte` is painted first, for callers whose output cannot carry an alpha
 * channel. It belongs here rather than in the caller because this function
 * clears the surface before it draws — anything laid down beforehand would be
 * wiped by the very first operation.
 */
export function drawFrame(context: SceneContext, scene: TextScene, time: number, matte?: string): void {
  const { width, height } = scene;
  const duration = sceneDuration(scene);
  const clamped = Math.max(0, Math.min(time, duration));

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.globalAlpha = 1;
  context.filter = 'none';

  if (matte) {
    context.fillStyle = matte;
    context.fillRect(0, 0, width, height);
  }

  drawBackground(context, scene, clamped, duration);
  drawText(context, scene, clamped);
  drawFade(context, scene, clamped, duration);

  context.restore();
}

// --------------------------------------------------------------- background

/**
 * Fills the frame with the chosen background.
 *
 * An image is never stretched. It is scaled until it covers the frame and the
 * overflow is cropped away, which is the only way to honour both a fixed output
 * shape and the picture's own proportions — a portrait photo in a 16:9 video
 * loses its top and bottom rather than being squashed into it.
 */
function drawBackground(context: SceneContext, scene: TextScene, time: number, duration: number): void {
  const { width, height, background } = scene;

  if (background.kind === 'color') {
    context.fillStyle = background.color;
    context.fillRect(0, 0, width, height);
    return;
  }

  // Nothing is painted under the picture: a PNG with transparency in it stays
  // transparent, which is what lets the still export keep an alpha channel.
  // The video encoder draws on an opaque surface, so there it becomes black on
  // its own, and the image export paints the matte first when the chosen file
  // type cannot carry transparency.
  const source = background.width / background.height;
  const frame = width / height;
  let scale = source > frame ? height / background.height : width / background.width;

  // The wipe reveal drifts the background closer across the whole clip; the
  // extra scale is applied on top of the cover fit so the frame never uncovers.
  if (scene.animation === 'mask-zoom' && duration > 0) {
    scale *= 1 + KEN_BURNS_ZOOM * (time / duration);
  }

  const drawWidth = background.width * scale;
  const drawHeight = background.height * scale;
  context.drawImage(
    background.image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight
  );
}

// --------------------------------------------------------------------- text

function drawText(context: SceneContext, scene: TextScene, time: number): void {
  if (!scene.text.trim()) return;

  const layout = layOutText(context, scene);
  if (!layout.lines.length) return;

  if (scene.legibility === 'band') drawBand(context, scene, layout);

  const progress = scene.revealSeconds > 0 ? Math.min(1, time / scene.revealSeconds) : 1;

  switch (scene.animation) {
    case 'typewriter':
      drawTypewriter(context, scene, layout, progress, time);
      break;
    case 'rise':
      drawRisingLetters(context, scene, layout, progress);
      break;
    case 'blur-words':
      drawBlurredWords(context, scene, layout, progress);
      break;
    case 'mask-zoom':
      drawWipe(context, scene, layout, progress);
      break;
    case 'fade':
      drawWholeBlock(context, scene, layout, { alpha: progress });
      break;
    case 'scale-up':
      // Overshoot then settle. A title that arrives at exactly its final size
      // reads as a cut; the small spring past it is what makes it a move.
      drawWholeBlock(context, scene, layout, { alpha: progress, scale: overshoot(progress, 0.14, 0.03) });
      break;
    case 'slide-lines':
      drawSlidingLines(context, scene, layout, progress);
      break;
    case 'word-drop':
      drawDroppingWords(context, scene, layout, progress);
      break;
    case 'tracking-in':
      drawTrackingIn(context, scene, layout, progress);
      break;
    case 'line-reveal':
      drawLineReveal(context, scene, layout, progress);
      break;
    case 'glitch':
      drawGlitch(context, scene, layout, progress);
      break;
    default:
      for (const line of layout.lines) paintText(context, scene, line.text, line.x, line.y);
  }
}

/**
 * Breaks the text into lines and places the block.
 *
 * Character positions are taken from the width of each *prefix* rather than by
 * adding up individual letters: measuring `"Wa"` and subtracting `"W"` keeps
 * the kerning the font asked for, while measuring `"a"` on its own throws it
 * away and leaves the per-letter animations visibly loose.
 */
function layOutText(context: SceneContext, scene: TextScene): Layout {
  const fontSize = scene.height * scene.fontScale;
  const margin = scene.height * scene.margin;
  const maxWidth = scene.width - margin * 2;

  applyFont(context, scene, fontSize);

  const paragraphs = scene.text.replace(/\r/g, '').split('\n');
  const wrapped: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      wrapped.push('');
      continue;
    }

    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        wrapped.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    wrapped.push(line);
  }

  const lineStep = fontSize * scene.lineHeight;
  const blockHeight = lineStep * wrapped.length;

  const top =
    scene.vertical === 'top'
      ? margin
      : scene.vertical === 'bottom'
        ? scene.height - margin - blockHeight
        : (scene.height - blockHeight) / 2;

  const lines: LaidOutLine[] = wrapped.map((text, index) => {
    const width = context.measureText(text).width;
    const x = alignedX(scene.align, width, margin, scene.width);

    const charOffsets: number[] = [];
    for (let i = 0; i <= text.length; i++) charOffsets.push(context.measureText(text.slice(0, i)).width);

    const words: LaidOutLine['words'] = [];
    const pattern = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      words.push({
        text: match[0],
        start: match.index,
        offset: charOffsets[match.index],
        width: charOffsets[match.index + match[0].length] - charOffsets[match.index]
      });
    }

    return {
      text,
      x,
      // The baseline sits inside the line box, leaving the descender room.
      y: top + index * lineStep + fontSize * 0.8,
      width,
      charOffsets,
      words
    };
  });

  return {
    lines,
    fontSize,
    lineStep,
    top,
    height: blockHeight,
    left: Math.min(...lines.map((line) => line.x)),
    right: Math.max(...lines.map((line) => line.x + line.width))
  };
}

function alignedX(align: HorizontalAlign, lineWidth: number, margin: number, frameWidth: number): number {
  if (align === 'left') return margin;
  if (align === 'right') return frameWidth - margin - lineWidth;
  return (frameWidth - lineWidth) / 2;
}

function applyFont(context: SceneContext, scene: TextScene, fontSize: number): void {
  context.font = `${scene.fontWeight} ${fontSize}px ${scene.fontFamily}`;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';

  // Letter spacing is a recent canvas property; where it is missing the text
  // simply keeps the font's own spacing rather than failing to draw.
  const spaced = context as CanvasRenderingContext2D & { letterSpacing?: string };
  if (typeof spaced.letterSpacing === 'string') {
    spaced.letterSpacing = `${scene.letterSpacing}em`;
  }
}

/**
 * Draws a run of text with whatever legibility treatment is in force.
 *
 * The order matters: the outline is stroked before the fill, so the dark edge
 * sits behind the letter instead of eating into it.
 */
function paintText(context: SceneContext, scene: TextScene, text: string, x: number, y: number): void {
  if (!text) return;

  const size = scene.height * scene.fontScale;

  if (scene.legibility === 'shadow') {
    context.shadowColor = 'rgba(0, 0, 0, 0.65)';
    context.shadowBlur = size * 0.16;
    context.shadowOffsetY = size * 0.05;
  }

  if (scene.legibility === 'outline') {
    context.lineJoin = 'round';
    context.lineWidth = size * 0.14;
    context.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    context.strokeText(text, x, y);
  }

  context.fillStyle = scene.color;
  context.fillText(text, x, y);

  context.shadowColor = 'transparent';
  context.shadowBlur = 0;
  context.shadowOffsetY = 0;
}

/** The translucent panel that guarantees contrast on any background. */
function drawBand(context: SceneContext, scene: TextScene, layout: Layout): void {
  const padding = layout.fontSize * 0.45;
  const left = Math.max(0, layout.left - padding);
  const right = Math.min(scene.width, layout.right + padding);

  context.fillStyle = 'rgba(0, 0, 0, 0.45)';
  context.fillRect(
    left,
    Math.max(0, layout.top - padding * 0.6),
    right - left,
    layout.height + padding * 1.2
  );
}

// --------------------------------------------------------------- animations

/**
 * One letter at a time, across the whole block.
 *
 * Drawn as a growing prefix of each line rather than letter by letter, so the
 * kerning is exactly what the font would produce for the finished sentence —
 * letters do not shuffle sideways as their neighbours appear.
 */
function drawTypewriter(
  context: SceneContext,
  scene: TextScene,
  layout: Layout,
  progress: number,
  time: number
): void {
  const total = layout.lines.reduce((sum, line) => sum + line.text.length, 0);
  let revealed = Math.round(progress * total);

  for (const line of layout.lines) {
    const take = Math.max(0, Math.min(line.text.length, revealed));
    if (take > 0) paintText(context, scene, line.text.slice(0, take), line.x, line.y);
    revealed -= line.text.length;

    const finished = progress >= 1;
    const active = !finished && take > 0 && take <= line.text.length && revealed < 0;
    if (active && Math.floor(time * CURSOR_BLINKS * 2) % 2 === 0) {
      context.fillStyle = scene.color;
      context.fillRect(line.x + line.charOffsets[take], line.y - layout.fontSize * 0.78, layout.fontSize * 0.06, layout.fontSize * 0.9);
    }
  }
}

/** Each letter floats up into place, staggered along the line. */
function drawRisingLetters(context: SceneContext, scene: TextScene, layout: Layout, progress: number): void {
  const total = Math.max(1, layout.lines.reduce((sum, line) => sum + line.text.length, 0));
  let index = 0;

  for (const line of layout.lines) {
    for (let i = 0; i < line.text.length; i++) {
      const character = line.text[i];
      const local = itemProgress(progress, index++, total);
      if (local <= 0 || character === ' ') continue;

      context.save();
      context.globalAlpha = local;
      const lift = (1 - local) * layout.fontSize * 0.45;
      paintText(context, scene, character, line.x + line.charOffsets[i], line.y + lift);
      context.restore();
    }
  }
}

/** Each word arrives slightly large and out of focus, then settles. */
function drawBlurredWords(context: SceneContext, scene: TextScene, layout: Layout, progress: number): void {
  const total = Math.max(1, layout.lines.reduce((sum, line) => sum + line.words.length, 0));
  const canBlur = supportsFilter(context);
  let index = 0;

  for (const line of layout.lines) {
    for (const word of line.words) {
      const local = itemProgress(progress, index++, total);
      if (local <= 0) continue;

      const scale = 1 + (1 - local) * 0.08;
      const x = line.x + word.offset;

      context.save();
      context.globalAlpha = local;
      if (canBlur) context.filter = `blur(${(1 - local) * layout.fontSize * 0.12}px)`;

      // Scaled about the word's own centre, so it grows in place instead of
      // sliding toward the corner of the frame.
      context.translate(x + word.width / 2, line.y - layout.fontSize * 0.35);
      context.scale(scale, scale);
      context.translate(-(x + word.width / 2), -(line.y - layout.fontSize * 0.35));

      paintText(context, scene, word.text, x, line.y);
      context.restore();
    }
  }

  context.filter = 'none';
}

/** A band sweeps across each line, uncovering it from the leading edge. */
function drawWipe(context: SceneContext, scene: TextScene, layout: Layout, progress: number): void {
  const total = Math.max(1, layout.lines.length);

  layout.lines.forEach((line, index) => {
    const local = itemProgress(progress, index, total);
    if (local <= 0 || !line.text) return;

    const top = line.y - layout.fontSize;
    const height = layout.lineStep + layout.fontSize * 0.3;
    const revealed = line.width * local;

    context.save();
    context.beginPath();
    // Right-aligned text is uncovered from its own edge inward, so the sweep
    // always runs with the reading direction of the block rather than against.
    context.rect(scene.align === 'right' ? line.x + line.width - revealed : line.x, top, revealed, height);
    context.clip();
    paintText(context, scene, line.text, line.x, line.y);
    context.restore();
  });
}

/**
 * How far one letter, word or line is through its own arrival.
 *
 * The items share the reveal window: each starts a little after the last and
 * takes {@link ITEM_DURATION} of the window to finish, so the block is complete
 * exactly when the window closes however many items it holds.
 */
function itemProgress(progress: number, index: number, total: number): number {
  const span = ITEM_DURATION;
  const start = total > 1 ? (index / (total - 1)) * (1 - span) : 0;
  return Math.max(0, Math.min(1, (progress - start) / span));
}

/**
 * A value that runs past its target and comes back, in one expression.
 *
 * `amount` is how far below the final size it starts and `spring` how far past
 * it goes on the way. Both are small on purpose: a title that visibly bounces
 * looks like a toy, while one that arrives dead on its mark looks like a cut.
 */
function overshoot(progress: number, amount: number, spring: number): number {
  if (progress >= 1) return 1;
  const eased = 1 - Math.pow(1 - progress, 3);
  return 1 - amount + eased * (amount + spring) - spring * eased * eased;
}

/**
 * Draws every line as one object, optionally faded and scaled about its centre.
 *
 * Scaling about the block's own middle rather than the canvas origin is what
 * makes it grow *in place*; scaling around the origin would send a centred
 * title sliding toward the corner as it appeared.
 */
function drawWholeBlock(
  context: SceneContext,
  scene: TextScene,
  layout: Layout,
  options: { alpha?: number; scale?: number; dx?: number; dy?: number }
): void {
  const alpha = options.alpha ?? 1;
  if (alpha <= 0) return;

  const scale = options.scale ?? 1;
  const centreX = (layout.left + layout.right) / 2;
  const centreY = layout.top + layout.height / 2;

  context.save();
  context.globalAlpha = alpha;
  context.translate(options.dx ?? 0, options.dy ?? 0);

  if (scale !== 1) {
    context.translate(centreX, centreY);
    context.scale(scale, scale);
    context.translate(-centreX, -centreY);
  }

  for (const line of layout.lines) paintText(context, scene, line.text, line.x, line.y);
  context.restore();
}

/** Lines arrive from alternating edges, staggered down the block. */
function drawSlidingLines(context: SceneContext, scene: TextScene, layout: Layout, progress: number): void {
  const total = Math.max(1, layout.lines.length);

  layout.lines.forEach((line, index) => {
    const local = itemProgress(progress, index, total);
    if (local <= 0 || !line.text) return;

    // Odd lines come from the right. A block that always enters from one side
    // reads as the whole thing sliding; alternating reads as lines arriving.
    const from = index % 2 === 0 ? -1 : 1;
    const eased = 1 - Math.pow(1 - local, 3);
    const travel = (1 - eased) * scene.width * 0.18 * from;

    context.save();
    context.globalAlpha = local;
    paintText(context, scene, line.text, line.x + travel, line.y);
    context.restore();
  });
}

/** Words fall in from above and settle with one small bounce. */
function drawDroppingWords(context: SceneContext, scene: TextScene, layout: Layout, progress: number): void {
  const total = Math.max(1, layout.lines.reduce((sum, line) => sum + line.words.length, 0));
  let index = 0;

  for (const line of layout.lines) {
    for (const word of line.words) {
      const local = itemProgress(progress, index++, total);
      if (local <= 0) continue;

      // Falls fast and rebounds shallowly, which is what gravity looks like
      // from the eye's point of view even at this scale.
      const eased = 1 - Math.pow(1 - local, 4);
      const bounce = local < 1 ? Math.sin(local * Math.PI) * layout.fontSize * 0.06 : 0;
      const drop = (1 - eased) * layout.fontSize * 1.1 - bounce;

      context.save();
      context.globalAlpha = Math.min(1, local * 1.6);
      paintText(context, scene, word.text, line.x + word.offset, line.y - drop);
      context.restore();
    }
  }
}

/**
 * Letters begin spread far apart and close onto their real spacing.
 *
 * Each letter is drawn at its own final offset pushed away from the centre of
 * the line, so the spacing collapses inward rather than the line sliding: the
 * word ends up exactly where the layout put it, kerning intact.
 */
function drawTrackingIn(context: SceneContext, scene: TextScene, layout: Layout, progress: number): void {
  const eased = 1 - Math.pow(1 - Math.min(1, progress), 3);
  const spread = (1 - eased) * layout.fontSize * 0.9;

  for (const line of layout.lines) {
    if (!line.text) continue;
    const middle = line.width / 2;

    for (let i = 0; i < line.text.length; i++) {
      const character = line.text[i];
      if (character === ' ') continue;

      const offset = line.charOffsets[i];
      const away = ((offset - middle) / Math.max(1, middle)) * spread;

      context.save();
      context.globalAlpha = eased;
      paintText(context, scene, character, line.x + offset + away, line.y);
      context.restore();
    }
  }
}

/** Each line is wiped upward into view, as if rising from behind an edge. */
function drawLineReveal(context: SceneContext, scene: TextScene, layout: Layout, progress: number): void {
  const total = Math.max(1, layout.lines.length);

  layout.lines.forEach((line, index) => {
    const local = itemProgress(progress, index, total);
    if (local <= 0 || !line.text) return;

    const eased = 1 - Math.pow(1 - local, 3);
    // The clip is the line's own box; the text is drawn low inside it and rises
    // into place, so it appears from behind the bottom edge rather than fading.
    const top = line.y - layout.fontSize;
    const height = layout.lineStep + layout.fontSize * 0.3;

    context.save();
    context.beginPath();
    context.rect(layout.left - layout.fontSize, top, layout.right - layout.left + layout.fontSize * 2, height);
    context.clip();
    paintText(context, scene, line.text, line.x, line.y + (1 - eased) * height);
    context.restore();
  });
}

/**
 * The letters arrive split into colour channels and jittering, then register.
 *
 * Two offset copies in cyan and magenta under the real text is the whole trick
 * — it is what a mistimed colour signal actually looked like, and the eye reads
 * it as interference rather than as a drop shadow. Everything scales with the
 * type size, so it survives a change of resolution like the rest of the scene.
 */
function drawGlitch(context: SceneContext, scene: TextScene, layout: Layout, progress: number): void {
  const settled = Math.min(1, progress);
  const chaos = 1 - settled;

  for (const [index, line] of layout.lines.entries()) {
    if (!line.text) continue;

    // Deterministic rather than random: the same frame has to look the same
    // every time it is drawn, or the preview and the export would disagree.
    const wobble = Math.sin((settled * 24 + index * 3.7) * Math.PI) * chaos;
    const split = chaos * layout.fontSize * 0.16;
    const jitterY = wobble * layout.fontSize * 0.08;

    context.save();
    context.globalAlpha = Math.min(1, settled * 1.4);

    if (chaos > 0.01) {
      // The channels are drawn plainly, without the legibility treatment: an
      // outline on each copy would read as three separate words.
      context.globalCompositeOperation = 'lighter';
      context.fillStyle = 'rgba(0, 220, 255, 0.55)';
      context.fillText(line.text, line.x - split, line.y + jitterY);
      context.fillStyle = 'rgba(255, 0, 128, 0.55)';
      context.fillText(line.text, line.x + split, line.y - jitterY);
      context.globalCompositeOperation = 'source-over';
    }

    paintText(context, scene, line.text, line.x + wobble * layout.fontSize * 0.05, line.y);
    context.restore();
  }
}

// -------------------------------------------------------------------- fades

function drawFade(context: SceneContext, scene: TextScene, time: number, duration: number): void {
  const span = Math.min(scene.fadeSeconds, duration / (scene.fadeIn && scene.fadeOut ? 2 : 1));
  if (span <= 0) return;

  let gain = 1;
  if (scene.fadeIn && time < span) gain = time / span;
  else if (scene.fadeOut && time > duration - span) gain = (duration - time) / span;

  if (gain >= 1) return;

  context.globalAlpha = Math.max(0, Math.min(1, 1 - gain));
  context.fillStyle = '#000000';
  context.fillRect(0, 0, scene.width, scene.height);
  context.globalAlpha = 1;
}

/** The gain a fade applies at one instant, for the soundtrack to match. */
export function fadeGainAt(scene: TextScene, time: number): number {
  const duration = sceneDuration(scene);
  const span = Math.min(scene.fadeSeconds, duration / (scene.fadeIn && scene.fadeOut ? 2 : 1));
  if (span <= 0) return 1;

  if (scene.fadeIn && time < span) return Math.max(0, time / span);
  if (scene.fadeOut && time > duration - span) return Math.max(0, (duration - time) / span);
  return 1;
}
