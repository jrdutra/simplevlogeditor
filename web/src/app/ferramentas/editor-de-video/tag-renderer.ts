/**
 * The animated tag, painted onto a frame.
 *
 * One function, drawn the same way in the preview and in the encoder, for the
 * same reason the caption is: a tag that sits somewhere else in the exported
 * file than it did on screen is worse than no preview at all.
 *
 * ## Why this is canvas and not CSS
 *
 * The tag was designed as a stack of CSS layers with keyframe animations, and
 * none of that survives the trip into a video file: the encoder is handed one
 * still frame at a time and has nowhere to put a stylesheet. So every shape is a
 * `Path2D`, every finish is a gradient or a clipped shadow, and every animation
 * is a function from progress to a transform. The look is faithful; the
 * mechanism is completely different, and two things are honestly approximations
 * rather than copies:
 *
 * - the 3D rotations, which project a flat plane and so become an axis scale
 *   (a plane turned by an angle is exactly `cos` narrower, so this is closer to
 *   right than it sounds — what it lacks is the perspective foreshortening that
 *   would make the near edge larger than the far one);
 * - the glass finish, which really does blur what is behind it, by lifting that
 *   rectangle of the frame into a scratch canvas rather than by asking the
 *   compositor for a backdrop it does not have.
 *
 * ## The clock
 *
 * `elapsed` is seconds since the tag arrived — zero at the first frame of its
 * entrance. Everything is derived from it: the entrance runs from zero to
 * `animSeconds`, the exit ends the tag's life, and the looping animations use it
 * directly so they keep their phase across a seek. Nothing here reads the wall
 * clock, which is what lets an export at four times real speed draw the same
 * pictures as a preview at one.
 */

import {
  ClipTag,
  TAG_LIMITS,
  TagAnim,
  TagExit,
  TagFinish,
  TagShape,
  TagTextAnim,
  animIsLooping,
  finishIsSeeThrough,
  positionAnchor,
  specialShape,
  tagFontStack,
  tagHold,
  typeScale
} from './tag-overlay';
import { SpecialFrame, SpecialText, specialPainter } from './tag-specials';

export type TagContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Below this the tag contributes nothing and the whole pass is skipped. */
const INVISIBLE = 0.003;

/* ------------------------------------------------------------------ easing */

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Fast out, slow in — the curve almost every arrival uses. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Slow out, fast in, for the departures. */
function easeIn(t: number): number {
  return t * t * t;
}

/** Overshoots and settles. `back` is how far past one it goes. */
function easeBack(t: number, back = 1.7): number {
  const c = back + 1;
  const u = t - 1;
  return 1 + c * u * u * u + back * u * u;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/* ------------------------------------------------------------------ colour */

function channels(hex: string): [number, number, number] {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function mix(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  const out = a.map((value, index) => Math.round(lerp(value, b[index], t)));
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ------------------------------------------------------------------ motion */

/**
 * What an animation does to the tag at one instant.
 *
 * A plain record rather than a matrix so the entrance and the exit can be
 * *composed* — multiplied where they scale, added where they move — which is
 * how a tag with a looping pulse can also be falling off the bottom of the
 * frame. A matrix would have made that a question about multiplication order.
 */
interface Motion {
  alpha: number;
  /** Movement, in multiples of the tag's own height. */
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  /** Radians. */
  rotate: number;
  /** Blur radius, in multiples of the type size. */
  blur: number;
  /** Extra glow around the block, in multiples of the type size. */
  glow: number;
  /** Origin of the rotation and scale, as shares of the box. Default is centred. */
  originX: number;
  originY: number;
}

const STILL: Motion = {
  alpha: 1,
  dx: 0,
  dy: 0,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  blur: 0,
  glow: 0,
  originX: 0.5,
  originY: 0.5
};

function motion(partial: Partial<Motion>): Motion {
  return { ...STILL, ...partial };
}

function compose(a: Motion, b: Motion): Motion {
  return {
    alpha: a.alpha * b.alpha,
    dx: a.dx + b.dx,
    dy: a.dy + b.dy,
    scaleX: a.scaleX * b.scaleX,
    scaleY: a.scaleY * b.scaleY,
    rotate: a.rotate + b.rotate,
    blur: Math.max(a.blur, b.blur),
    glow: Math.max(a.glow, b.glow),
    // The origin is not a quantity that can be averaged: whichever animation
    // moved it away from the middle is the one that meant something by it.
    originX: b.originX !== 0.5 ? b.originX : a.originX,
    originY: b.originY !== 0.5 ? b.originY : a.originY
  };
}

/* -------------------------------------------------------- entrance and exit */

/**
 * Where a rotation in space lands once it is flattened.
 *
 * A plane turned by `degrees` about a vertical axis is exactly `cos(degrees)`
 * narrower on screen. Past ninety degrees the cosine goes negative, which is the
 * plane showing its back — and mirroring it is precisely what the browser does
 * with `backface-visibility: visible`, so the sign is kept rather than taken
 * away.
 */
function turn(degrees: number): number {
  const value = Math.cos((degrees * Math.PI) / 180);
  // Zero width is a degenerate transform the canvas refuses to invert, and it is
  // invisible anyway; a hair of width keeps the matrix well formed.
  return Math.abs(value) < 0.002 ? 0.002 * Math.sign(value || 1) : value;
}

/** The entrance, as a function of its own progress and of the tag's clock. */
function entranceMotion(anim: TagAnim, progress: number, clock: number, seconds: number): Motion {
  const p = clamp01(progress);
  const e = easeOut(p);

  switch (anim) {
    case 'none':
      return STILL;

    case 'fade':
      return motion({ alpha: p });
    case 'rise':
      return motion({ alpha: p, dy: lerp(1.1, 0, e) });
    case 'slide':
      return motion({ alpha: p, dx: lerp(-1.9, 0, e) });
    case 'zoom':
      return motion({ alpha: p, scaleX: lerp(0.4, 1, e), scaleY: lerp(0.4, 1, e) });
    case 'pop': {
      const s = easeBack(p);
      return motion({ alpha: Math.min(1, p * 2.2), scaleX: s, scaleY: s });
    }
    case 'drop': {
      const s = easeBack(p, 1.4);
      return motion({ alpha: Math.min(1, p * 3), dy: lerp(-3.6, 0, s) });
    }
    case 'unroll':
      return motion({ alpha: lerp(0.2, 1, p), scaleX: e, originX: 0 });
    case 'unblur':
      return motion({ alpha: p, blur: lerp(0.5, 0, e), scaleX: lerp(1.1, 1, e), scaleY: lerp(1.1, 1, e) });

    /* The looping ones ignore progress: they are the tag's resting state, not
       its arrival, and they keep running for as long as it is on screen. */
    case 'pulse': {
      const s = 1 + 0.07 * Math.sin((clock / seconds) * Math.PI * 2);
      return motion({ scaleX: s, scaleY: s });
    }
    case 'float':
      return motion({ dy: 0.2 * Math.sin((clock / seconds) * Math.PI * 2) });
    case 'sway':
      return motion({ rotate: (3.5 * Math.PI / 180) * Math.sin((clock / seconds) * Math.PI * 2) });
    case 'shake':
      return motion({ dx: 0.09 * Math.sin((clock / seconds) * Math.PI * 8) });
    case 'heartbeat': {
      const beat = (clock / seconds) % 1;
      const s = beat < 0.14 ? 1 + 0.13 * (beat / 0.14)
        : beat < 0.28 ? 1 + 0.13 * (1 - (beat - 0.14) / 0.14)
        : beat < 0.42 ? 1 + 0.09 * ((beat - 0.28) / 0.14)
        : beat < 0.6 ? 1 + 0.09 * (1 - (beat - 0.42) / 0.18)
        : 1;
      return motion({ scaleX: s, scaleY: s });
    }
    case 'swing':
      return motion({
        rotate: (9 * Math.PI / 180) * Math.sin((clock / seconds) * Math.PI * 2),
        originY: 0
      });
    case 'shine':
      return motion({ glow: 0.6 * (0.5 + 0.5 * Math.sin((clock / seconds) * Math.PI * 2)) });
    case 'sweep':
      // The light itself is painted by the finish pass, which reads the clock;
      // the block does not move.
      return STILL;

    case 'flip-x':
      return motion({ alpha: Math.min(1, p * 2), scaleY: turn(lerp(-96, 0, easeBack(p, 1.2))) });
    case 'flip-y':
      return motion({ alpha: Math.min(1, p * 2), scaleX: turn(lerp(96, 0, easeBack(p, 1.2))) });
    case 'propeller': {
      const s = easeBack(p, 1.1);
      return motion({
        alpha: Math.min(1, p * 2),
        scaleX: turn(lerp(220, 0, s)),
        scaleY: lerp(0.5, 1, s),
        rotate: lerp(0.6, 0, s)
      });
    }
    case 'corner':
      return motion({
        alpha: Math.min(1, p * 2),
        scaleX: lerp(0.75, 1, easeBack(p, 1.2)),
        scaleY: turn(lerp(72, 0, easeBack(p, 1.2))),
        rotate: lerp(0.4, 0, easeOut(p)),
        originX: 0,
        originY: 0
      });
    case 'cube':
      return motion({
        alpha: Math.min(1, p * 2),
        scaleY: turn(lerp(-90, 0, easeBack(p, 1.1))),
        dy: lerp(-0.5, 0, easeBack(p, 1.1)),
        originY: 0
      });
    case 'coin': {
      const s = easeOut(p);
      return motion({
        alpha: Math.min(1, p * 3),
        scaleX: turn(lerp(-900, 0, s)),
        scaleY: lerp(0.5, 1, s)
      });
    }
    case 'spin':
      return motion({ scaleX: turn(((clock / seconds) % 1) * 360) });
    case 'gyro': {
      const phase = (clock / seconds) % 1;
      return motion({ scaleX: turn(phase * 360), scaleY: turn(18 * Math.sin(phase * Math.PI * 2)) });
    }
    case 'pendulum': {
      const phase = Math.sin((clock / seconds) * Math.PI * 2);
      return motion({ scaleX: turn(30 * phase), scaleY: turn(8 * phase) });
    }
    case 'pushpull': {
      const s = 1 + 0.12 * Math.sin((clock / seconds) * Math.PI * 2);
      return motion({ scaleX: s, scaleY: s });
    }
    default:
      return STILL;
  }
}

/** The exit, as a function of its own progress. One at the last frame. */
function exitMotion(exit: TagExit, progress: number): Motion {
  const p = clamp01(progress);
  const e = easeIn(p);

  switch (exit) {
    case 'none':
      return STILL;
    case 'fade':
      return motion({ alpha: 1 - p });
    case 'shrink':
      return motion({ alpha: 1 - p, scaleX: lerp(1, 0.35, e), scaleY: lerp(1, 0.35, e) });
    case 'blur':
      return motion({ alpha: 1 - p, blur: 0.55 * p, scaleX: lerp(1, 1.12, e), scaleY: lerp(1, 1.12, e) });
    case 'rollup':
      return motion({ alpha: lerp(1, 0.15, p), scaleX: 1 - e, originX: 0 });
    case 'pop': {
      const s = p < 0.32 ? lerp(1, 1.14, p / 0.32) : lerp(1.14, 0.2, (p - 0.32) / 0.68);
      return motion({ alpha: p < 0.32 ? 1 : 1 - (p - 0.32) / 0.68, scaleX: s, scaleY: s });
    }
    case 'fall':
      return motion({ alpha: 1 - p, dy: 1.4 * e });
    case 'rise':
      return motion({ alpha: 1 - p, dy: -1.4 * e });
    case 'left':
      return motion({ alpha: 1 - p, dx: -2.5 * e });
    case 'right':
      return motion({ alpha: 1 - p, dx: 2.5 * e });
    case 'tumble': {
      const lift = p < 0.18 ? -0.5 * (p / 0.18) : lerp(-0.5, 5.6, (p - 0.18) / 0.82);
      return motion({ alpha: 1 - easeIn(p), dy: lift, rotate: lerp(0, 0.28, p) });
    }
    case 'flip-x':
      return motion({ alpha: 1 - p, scaleY: turn(96 * e) });
    case 'flip-y':
      return motion({ alpha: 1 - p, scaleX: turn(-96 * e) });
    case 'propeller':
      return motion({ alpha: 1 - p, scaleX: turn(-220 * e), scaleY: lerp(1, 0.5, e), rotate: -0.6 * e });
    case 'coin':
      return motion({ alpha: 1 - p, scaleX: turn(900 * easeIn(p)), scaleY: lerp(1, 0.45, e) });
    case 'topple':
      return motion({
        alpha: 1 - p,
        scaleX: lerp(1, 0.8, e),
        scaleY: turn(-80 * e),
        rotate: -0.42 * e,
        originX: 0,
        originY: 1
      });
    case 'recede':
      return motion({ alpha: 1 - p, scaleX: lerp(1, 0.12, e), scaleY: lerp(1, 0.12, e) });
    default:
      return STILL;
  }
}

/* ------------------------------------------------------------------ shapes */

/** Extra room a shape needs so its pointed parts do not eat the text. */
interface ShapePadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const NO_PADDING: ShapePadding = { left: 0, right: 0, top: 0, bottom: 0 };

function shapePadding(shape: TagShape, scale: number): ShapePadding {
  switch (shape) {
    case 'pricetag':
      return { ...NO_PADDING, left: 30 * scale };
    case 'ribbon':
      return { ...NO_PADDING, left: 14 * scale, right: 14 * scale };
    case 'arrow':
      return { ...NO_PADDING, right: 16 * scale };
    case 'hexagon':
      return { ...NO_PADDING, left: 12 * scale, right: 12 * scale };
    case 'bookmark':
      return { ...NO_PADDING, bottom: 16 * scale };
    case 'slant':
      return { ...NO_PADDING, left: 10 * scale, right: 10 * scale };
    default:
      return NO_PADDING;
  }
}

/**
 * How far below the box the shape reaches.
 *
 * Only the speech bubble does, with its tail, and the number matters twice: the
 * frame margin has to clear it, and the cast shadow has to include it.
 */
function shapeOverhang(shape: TagShape, scale: number): number {
  return shape === 'bubble' ? 24 * scale : 0;
}

interface ShapeGeometry {
  path: Path2D;
  /**
   * `evenodd` for the shapes that punch a hole.
   *
   * The hole is a second subpath rather than a second draw, so it survives
   * everything the finish does — a clip, a gradient, an inner shadow — instead
   * of having to be re-punched at each step.
   */
  rule: CanvasFillRule;
}

function polygon(points: readonly (readonly [number, number])[]): Path2D {
  const path = new Path2D();
  points.forEach(([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  path.closePath();
  return path;
}

/** The outline of one shape, in a box whose top left corner is the origin. */
function shapePath(shape: TagShape, w: number, h: number, scale: number): ShapeGeometry {
  const path = new Path2D();

  switch (shape) {
    case 'pill':
      path.roundRect(0, 0, w, h, h / 2);
      return { path, rule: 'nonzero' };

    case 'rounded':
      path.roundRect(0, 0, w, h, Math.min(16 * scale, h / 2));
      return { path, rule: 'nonzero' };

    case 'rect':
      path.rect(0, 0, w, h);
      return { path, rule: 'nonzero' };

    case 'circle': {
      const r = Math.max(w, h) / 2;
      path.arc(w / 2, h / 2, r, 0, Math.PI * 2);
      return { path, rule: 'nonzero' };
    }

    case 'cut': {
      const c = Math.min(14 * scale, h / 2, w / 2);
      return {
        path: polygon([
          [c, 0], [w - c, 0], [w, c], [w, h - c],
          [w - c, h], [c, h], [0, h - c], [0, c]
        ]),
        rule: 'nonzero'
      };
    }

    case 'pricetag': {
      const nose = Math.min(24 * scale, w / 2);
      const body = polygon([[0, h / 2], [nose, 0], [w, 0], [w, h], [nose, h]]);
      body.arc(36 * scale, h / 2, 6 * scale, 0, Math.PI * 2);
      return { path: body, rule: 'evenodd' };
    }

    case 'ribbon': {
      const notch = Math.min(20 * scale, w / 3);
      return {
        path: polygon([
          [0, 0], [w, 0], [w - notch, h / 2], [w, h], [0, h], [notch, h / 2]
        ]),
        rule: 'nonzero'
      };
    }

    case 'arrow': {
      const head = Math.min(24 * scale, w / 2);
      return {
        path: polygon([[0, 0], [w - head, 0], [w, h / 2], [w - head, h], [0, h]]),
        rule: 'nonzero'
      };
    }

    case 'hexagon': {
      const point = Math.min(22 * scale, w / 3);
      return {
        path: polygon([
          [point, 0], [w - point, 0], [w, h / 2], [w - point, h], [point, h], [0, h / 2]
        ]),
        rule: 'nonzero'
      };
    }

    case 'bookmark': {
      const notch = Math.min(18 * scale, h / 2);
      return {
        path: polygon([[0, 0], [w, 0], [w, h], [w / 2, h - notch], [0, h]]),
        rule: 'nonzero'
      };
    }

    case 'ticket': {
      const body = new Path2D();
      body.roundRect(0, 0, w, h, Math.min(8 * scale, h / 2));
      const r = Math.min(9 * scale, h / 2.2);
      body.arc(0, h / 2, r, 0, Math.PI * 2);
      body.arc(w, h / 2, r, 0, Math.PI * 2);
      return { path: body, rule: 'evenodd' };
    }

    case 'slant': {
      const lean = Math.min(20 * scale, w / 3);
      return {
        path: polygon([[lean, 0], [w, 0], [w - lean, h], [0, h]]),
        rule: 'nonzero'
      };
    }

    case 'bubble': {
      const body = new Path2D();
      body.roundRect(0, 0, w, h, Math.min(18 * scale, h / 2));
      const tail = new Path2D();
      const foot = Math.min(24 * scale, w * 0.4);
      tail.moveTo(foot, h - 1);
      tail.lineTo(foot + 26 * scale, h - 1);
      tail.lineTo(foot + 4 * scale, h + 24 * scale);
      tail.closePath();
      body.addPath(tail);
      return { path: body, rule: 'nonzero' };
    }

    default:
      path.roundRect(0, 0, w, h, h / 2);
      return { path, rule: 'nonzero' };
  }
}

/* ----------------------------------------------------------------- finishes */

/**
 * A shadow cast *into* the shape.
 *
 * Canvas only knows how to throw a shadow outwards, so this fills everything
 * *outside* the shape — a big rectangle with the shape punched out of it — while
 * clipped to the shape itself. The fill lands entirely outside the clip and is
 * never seen; its shadow falls inwards and is all that survives. It is the one
 * trick in this file worth knowing, and it is what makes the bevel, the emboss
 * and the deboss possible at all.
 */
function innerShadow(
  context: TagContext,
  geo: ShapeGeometry,
  w: number,
  h: number,
  colour: string,
  blur: number,
  dx: number,
  dy: number
): void {
  const outside = new Path2D();
  outside.rect(-w * 2, -h * 2, w * 5, h * 5);
  outside.addPath(geo.path);

  context.save();
  context.clip(geo.path, geo.rule);
  context.shadowColor = colour;
  context.shadowBlur = blur;
  context.shadowOffsetX = dx;
  context.shadowOffsetY = dy;
  context.fillStyle = '#000000';
  context.fill(outside, 'evenodd');
  context.restore();
}

/** A stroke that lives entirely inside the shape, like an inset border. */
function innerStroke(
  context: TagContext,
  geo: ShapeGeometry,
  width: number,
  colour: string
): void {
  if (width <= 0) return;
  context.save();
  context.clip(geo.path, geo.rule);
  context.lineWidth = width * 2;
  context.lineJoin = 'round';
  context.strokeStyle = colour;
  context.stroke(geo.path);
  context.restore();
}

/**
 * Blurs the picture already on the canvas, behind the tag.
 *
 * The glass finish is the only thing here that reads what it is drawn over. The
 * rectangle under the tag is lifted into a scratch canvas, blurred on the way
 * in, and drawn back clipped to the shape. It costs a copy of a small rectangle
 * per frame, which is why no other finish does it.
 */
function blurBackdrop(
  context: TagContext,
  geo: ShapeGeometry,
  w: number,
  h: number,
  radius: number
): boolean {
  const surface = context.canvas as HTMLCanvasElement | OffscreenCanvas;
  const matrix = context.getTransform();
  // The box in device pixels, grown by the blur so the edges have something to
  // pull from instead of smearing the transparent outside inwards.
  const pad = Math.ceil(radius * 2);
  const corners = [
    [0, 0], [w, 0], [0, h], [w, h]
  ].map(([x, y]) => ({
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f
  }));

  const left = Math.floor(Math.min(...corners.map((p) => p.x)) - pad);
  const top = Math.floor(Math.min(...corners.map((p) => p.y)) - pad);
  const right = Math.ceil(Math.max(...corners.map((p) => p.x)) + pad);
  const bottom = Math.ceil(Math.max(...corners.map((p) => p.y)) + pad);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return false;

  const scratch = scratchCanvas(width, height);
  if (!scratch) return false;

  scratch.context.clearRect(0, 0, width, height);
  scratch.context.filter = `blur(${radius}px)`;
  try {
    scratch.context.drawImage(
      surface as CanvasImageSource,
      left, top, width, height,
      0, 0, width, height
    );
  } catch {
    // A tainted or zero-sized surface: fall back to a plain translucent face,
    // which is what the caller does when this returns false.
    return false;
  }
  scratch.context.filter = 'none';

  context.save();
  context.clip(geo.path, geo.rule);
  // Back into frame coordinates: the scratch holds device pixels, so the draw
  // has to happen with the transform undone and then be put back.
  context.setTransform(1, 0, 0, 1, 0, 0);
  // Nine arguments, not five: the scratch is a cache that only ever grows, so
  // the blurred picture is the top-left corner of it and never the whole
  // surface. Naming the source rectangle is what keeps a preview opened after
  // an export from drawing a third-size backdrop.
  context.drawImage(
    scratch.canvas as CanvasImageSource,
    0, 0, width, height,
    left, top, width, height
  );
  context.restore();
  return true;
}

/** One scratch surface, kept between frames rather than allocated per draw. */
let scratch: { canvas: HTMLCanvasElement | OffscreenCanvas; context: TagContext } | null = null;

function scratchCanvas(width: number, height: number): { canvas: HTMLCanvasElement | OffscreenCanvas; context: TagContext } | null {
  if (scratch && scratch.canvas.width >= width && scratch.canvas.height >= height) {
    return scratch;
  }
  const w = Math.max(width, scratch?.canvas.width ?? 0);
  const h = Math.max(height, scratch?.canvas.height ?? 0);

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const context = canvas.getContext('2d');
    if (!context) return null;
    scratch = { canvas, context };
    return scratch;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) return null;
  scratch = { canvas, context };
  return scratch;
}

/**
 * The light a finish paints with, at the strength it was asked for.
 *
 * Every one of these used to be a literal `rgba(255,255,255,…)`, which is why
 * the sheen on a bevelled tag could not be turned down or tinted: the highlight
 * was not a setting, it was a number in this file. The alphas below are the
 * ones that were always there; what changed is that they are multiplied by the
 * reader's strength and take the reader's colour.
 */
function light(tag: ClipTag, alpha: number): string {
  return withAlpha(tag.sheenColor, Math.min(1, alpha * (tag.sheen / 100)));
}

/** Paints the face of the tag: its colour, and whatever the finish does to it. */
function paintFace(
  context: TagContext,
  geo: ShapeGeometry,
  w: number,
  h: number,
  tag: ClipTag,
  scale: number,
  clock: number,
  animation: TagAnim
): void {
  const finish: TagFinish = tag.finish;
  const base = tag.color;

  if (finish === 'glass') {
    if (!blurBackdrop(context, geo, w, h, 11 * scale)) {
      // Nothing to blur — an empty canvas, or a surface we may not read. A
      // translucent wash still reads as glass; it just has nothing behind it.
    }
    const wash = context.createLinearGradient(0, 0, w * 0.4, h);
    wash.addColorStop(0, light(tag, 0.3));
    wash.addColorStop(1, light(tag, 0.05));
    context.fillStyle = withAlpha(base, 0.34);
    context.fill(geo.path, geo.rule);
    context.fillStyle = wash;
    context.fill(geo.path, geo.rule);
    innerStroke(context, geo, 1 * scale, light(tag, 0.5));
    return;
  }

  if (finish === 'hollow') {
    innerStroke(context, geo, Math.max(3 * scale, tag.strokeIn * scale), tag.outlineColor);
    return;
  }

  context.fillStyle = base;
  context.fill(geo.path, geo.rule);

  switch (finish) {
    case 'flat':
      break;

    case 'bevel': {
      const wash = context.createLinearGradient(w * 0.2, 0, w * 0.8, h);
      wash.addColorStop(0, light(tag, 0.3));
      wash.addColorStop(0.46, light(tag, 0));
      wash.addColorStop(1, 'rgba(0,0,0,0.26)');
      context.fillStyle = wash;
      context.fill(geo.path, geo.rule);
      innerShadow(context, geo, w, h, light(tag, 0.55), 0, 0, 3 * scale);
      innerShadow(context, geo, w, h, 'rgba(0,0,0,0.42)', 0, 0, -4 * scale);
      break;
    }

    case 'emboss':
      innerShadow(context, geo, w, h, light(tag, 0.45), 7 * scale, 3 * scale, 3 * scale);
      innerShadow(context, geo, w, h, 'rgba(0,0,0,0.45)', 9 * scale, -4 * scale, -4 * scale);
      break;

    case 'deboss':
      innerShadow(context, geo, w, h, 'rgba(0,0,0,0.5)', 9 * scale, 4 * scale, 4 * scale);
      innerShadow(context, geo, w, h, light(tag, 0.35), 7 * scale, -3 * scale, -3 * scale);
      break;

    case 'cylinder': {
      const wash = context.createLinearGradient(0, 0, 0, h);
      wash.addColorStop(0, light(tag, 0.42));
      wash.addColorStop(0.26, light(tag, 0.05));
      wash.addColorStop(0.56, 'rgba(0,0,0,0.08)');
      wash.addColorStop(1, 'rgba(0,0,0,0.40)');
      context.fillStyle = wash;
      context.fill(geo.path, geo.rule);
      break;
    }

    case 'gloss': {
      const top = context.createRadialGradient(w * 0.3, h * 0.12, 0, w * 0.3, h * 0.12, Math.max(w, h) * 0.7);
      top.addColorStop(0, light(tag, 0.62));
      top.addColorStop(0.46, light(tag, 0));
      const foot = context.createRadialGradient(w * 0.72, h * 1.18, 0, w * 0.72, h * 1.18, Math.max(w, h) * 0.9);
      foot.addColorStop(0, 'rgba(0,0,0,0.48)');
      foot.addColorStop(0.58, 'rgba(0,0,0,0)');
      context.fillStyle = foot;
      context.fill(geo.path, geo.rule);
      context.fillStyle = top;
      context.fill(geo.path, geo.rule);
      break;
    }

    case 'metal': {
      const brush = context.createLinearGradient(0, h, w, 0);
      const stops: [number, string][] = [
        [0, light(tag, 0.3)], [0.09, light(tag, 0.3)],
        [0.2, 'rgba(0,0,0,0.30)'], [0.33, light(tag, 0.52)],
        [0.47, 'rgba(0,0,0,0.34)'], [0.61, light(tag, 0.38)],
        [0.76, 'rgba(0,0,0,0.30)'], [1, light(tag, 0.26)]
      ];
      for (const [at, colour] of stops) brush.addColorStop(at, colour);
      context.fillStyle = brush;
      context.fill(geo.path, geo.rule);
      innerShadow(context, geo, w, h, light(tag, 0.5), 0, 0, 2 * scale);
      innerShadow(context, geo, w, h, 'rgba(0,0,0,0.4)', 0, 0, -3 * scale);
      break;
    }

    case 'neon':
      context.fillStyle = mix(base, '#05070a', 0.86);
      context.fill(geo.path, geo.rule);
      innerStroke(context, geo, 2 * scale, base);
      innerShadow(context, geo, w, h, withAlpha(base, 0.7), 14 * scale, 0, 0);
      break;

    case 'sticker':
      innerShadow(context, geo, w, h, 'rgba(0,0,0,0.16)', 0, 0, -5 * scale);
      innerStroke(context, geo, Math.max(6 * scale, tag.strokeIn * scale), '#ffffff');
      break;

    case 'hatched': {
      context.save();
      context.clip(geo.path, geo.rule);
      context.strokeStyle = 'rgba(0,0,0,0.26)';
      context.lineWidth = 7 * scale;
      const step = 14 * scale;
      const span = w + h;
      for (let offset = -h; offset < span; offset += step) {
        context.beginPath();
        context.moveTo(offset, h);
        context.lineTo(offset + h, 0);
        context.stroke();
      }
      context.restore();
      innerStroke(context, geo, 2 * scale, 'rgba(0,0,0,0.22)');
      break;
    }

    case 'double':
      innerStroke(context, geo, Math.max(2 * scale, tag.strokeIn * scale) * 2.4, mix(base, '#ffffff', 0.4));
      innerStroke(context, geo, Math.max(2 * scale, tag.strokeIn * scale), tag.outlineColor);
      break;
  }

  if (animation === 'sweep') {
    // A band of light crossing the face, on the tag's own clock so it keeps its
    // phase across a seek. Two and a half seconds a pass, with a long dark rest
    // between them, which is what makes it read as a highlight rather than as a
    // flicker.
    const phase = ((clock / 2.5) % 1) * 2.6 - 0.8;
    const band = context.createLinearGradient(w * (phase - 0.35), 0, w * (phase + 0.35), h);
    band.addColorStop(0, light(tag, 0));
    band.addColorStop(0.5, light(tag, 0.4));
    band.addColorStop(1, light(tag, 0));
    context.fillStyle = band;
    context.fill(geo.path, geo.rule);
  }
}

/* -------------------------------------------------------------------- text */

interface Letter {
  ch: string;
  /** Left edge of this letter's advance, from the start of the line. */
  x: number;
  width: number;
}

interface TextLayout {
  letters: Letter[];
  width: number;
}

function layOut(context: TagContext, text: string, fontSize: number, tracking: number): TextLayout {
  const letters: Letter[] = [];
  let x = 0;

  for (const ch of Array.from(text)) {
    const width = context.measureText(ch).width;
    letters.push({ ch, x, width });
    x += width + tracking * fontSize;
  }

  // The last letter carries no trailing tracking: a tag centred with it would
  // sit visibly left of centre at the wide settings.
  return { letters, width: Math.max(0, x - (letters.length ? tracking * fontSize : 0)) };
}

/** How the whole line is treated, rather than one letter at a time. */
const WHOLE_LINE: readonly TagTextAnim[] = [
  'typewriter', 'reveal', 'gradient', 'neon', 'glitch', 'carved', 'extruded'
];

/** What one letter looks like at this instant, for the letter-by-letter set. */
function letterMotion(
  anim: TagTextAnim,
  index: number,
  elapsed: number,
  stagger: number,
  seconds: number
): Motion {
  const t = clamp01((elapsed - index * stagger) / Math.max(0.05, seconds));
  const e = easeOut(t);

  switch (anim) {
    case 'fade':
      return motion({ alpha: t });
    case 'letters':
      return motion({ alpha: t, dy: lerp(0.5, 0, e) });
    case 'slide':
      return motion({ alpha: t, dx: lerp(-0.7, 0, e) });
    case 'grow':
      return motion({ alpha: t, scaleX: lerp(0.1, 1, easeBack(t, 1.6)), scaleY: lerp(0.1, 1, easeBack(t, 1.6)) });
    case 'cascade':
      return motion({ alpha: t, dy: lerp(-0.8, 0, easeBack(t, 1.3)), rotate: lerp(-0.24, 0, easeBack(t, 1.3)) });
    case 'focus':
      return motion({ alpha: t, blur: lerp(0.26, 0, e) });
    case 'flip':
      return motion({ alpha: Math.min(1, t * 2), scaleY: turn(lerp(-92, 0, easeBack(t, 1.2))) });
    case 'wave': {
      const phase = elapsed / Math.max(0.2, seconds) - index * stagger;
      return motion({ dy: -0.24 * Math.sin(phase * Math.PI * 2) });
    }
    case 'bounce': {
      const phase = (elapsed / Math.max(0.2, seconds) - index * stagger) % 1;
      const hop = phase < 0 || phase > 0.55 ? 0 : Math.sin((phase / 0.55) * Math.PI);
      return motion({ dy: -0.3 * hop, scaleX: 1 + 0.14 * hop, scaleY: 1 + 0.14 * hop });
    }
    default:
      return STILL;
  }
}

/**
 * Draws the tag's text, centred on `(cx, baseline)`.
 *
 * The whole-line animations get their own branch because they are not made of
 * letters at all: a typewriter is a count, a gradient is one fill, a glitch is
 * the same line drawn three times slightly wrong.
 */
function paintText(
  context: TagContext,
  layout: TextLayout,
  tag: ClipTag,
  cx: number,
  baseline: number,
  fontSize: number,
  scale: number,
  elapsed: number,
  alpha: number
): void {
  const anim = tag.textAnim;
  const left = cx - layout.width / 2;
  const seconds = Math.max(0.05, tag.animSeconds);

  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = tag.textColor;

  if (anim === 'none') {
    for (const letter of layout.letters) context.fillText(letter.ch, left + letter.x, baseline);
    return;
  }

  if (!WHOLE_LINE.includes(anim)) {
    for (const [index, letter] of layout.letters.entries()) {
      const m = letterMotion(anim, index, elapsed, tag.stagger, seconds);
      if (m.alpha <= INVISIBLE) continue;

      const x = left + letter.x + letter.width / 2;
      context.save();
      // Multiplied, never replaced: the tag's own alpha is already on the
      // context, and a letter that set its own would go on burning at full
      // strength while the block it is written on faded out from under it.
      context.globalAlpha = alpha * m.alpha;
      if (m.blur > 0) context.filter = `blur(${(m.blur * fontSize).toFixed(2)}px)`;
      context.translate(x + m.dx * fontSize, baseline + m.dy * fontSize);
      context.rotate(m.rotate);
      context.scale(m.scaleX, m.scaleY);
      context.fillText(letter.ch, -letter.width / 2, 0);
      context.restore();
    }
    return;
  }

  const line = layout.letters.map((letter) => letter.ch).join('');

  switch (anim) {
    case 'typewriter': {
      const shown = Math.min(layout.letters.length, Math.floor((elapsed / seconds) * layout.letters.length));
      for (const letter of layout.letters.slice(0, shown)) {
        context.fillText(letter.ch, left + letter.x, baseline);
      }
      // The caret blinks twice a second and stops once the line is finished,
      // which is what tells the reader the typing was the animation and not a
      // field waiting for them.
      if (shown < layout.letters.length && Math.floor(elapsed * 2) % 2 === 0) {
        const at = shown ? left + layout.letters[shown].x : left;
        context.fillRect(at, baseline - fontSize * 0.78, fontSize * 0.07, fontSize * 0.88);
      }
      break;
    }

    case 'reveal': {
      // A soft edge sweeping left to right, done as a per-letter alpha rather
      // than as a mask: the result is the same and it needs no second surface.
      const front = lerp(-0.2, 1.2, clamp01(elapsed / seconds)) * layout.width;
      const soft = Math.max(fontSize * 0.6, layout.width * 0.12);
      for (const letter of layout.letters) {
        const edge = clamp01((front - (letter.x + letter.width / 2)) / soft + 0.5);
        if (edge <= INVISIBLE) continue;
        context.globalAlpha = alpha * edge;
        context.fillText(letter.ch, left + letter.x, baseline);
      }
      context.globalAlpha = alpha;
      break;
    }

    case 'gradient': {
      const sweep = ((elapsed / 1.6) % 1) * 2.6 - 0.8;
      const paint = context.createLinearGradient(
        left + layout.width * (sweep - 0.5), 0,
        left + layout.width * (sweep + 0.5), 0
      );
      paint.addColorStop(0, tag.textColor);
      paint.addColorStop(0.5, '#ffffff');
      paint.addColorStop(1, tag.textColor);
      context.fillStyle = paint;
      context.fillText(line, left, baseline);
      break;
    }

    case 'neon': {
      const beat = (elapsed / 1.4) % 1;
      const dim = (beat > 0.19 && beat < 0.215) || (beat > 0.22 && beat < 0.245);
      context.globalAlpha = alpha * (dim ? 0.35 : 1);
      if (!dim) {
        context.shadowColor = tag.textColor;
        context.shadowBlur = fontSize * 0.4;
      }
      context.fillText(line, left, baseline);
      context.shadowBlur = 0;
      context.shadowColor = 'transparent';
      context.globalAlpha = alpha;
      break;
    }

    case 'glitch': {
      const beat = (elapsed * 3) % 1;
      const kick = beat < 0.08 ? -1 : beat < 0.16 ? 1 : beat < 0.62 ? 0 : beat < 0.7 ? 0.6 : 0;
      if (kick !== 0) {
        context.globalAlpha = alpha * 0.85;
        context.fillStyle = '#ff2d55';
        context.fillText(line, left + 3 * scale * kick, baseline + scale * kick);
        context.fillStyle = '#00e0ff';
        context.fillText(line, left - 3 * scale * kick, baseline - scale * kick);
        context.globalAlpha = alpha;
      }
      context.fillStyle = tag.textColor;
      context.fillText(line, left + (kick !== 0 ? 2 * scale * kick : 0), baseline);
      break;
    }

    case 'carved':
      context.fillStyle = 'rgba(0,0,0,0.5)';
      context.fillText(line, left, baseline - scale);
      context.fillStyle = 'rgba(255,255,255,0.45)';
      context.fillText(line, left, baseline + scale);
      context.fillStyle = tag.textColor;
      context.fillText(line, left, baseline);
      break;

    case 'extruded': {
      for (let i = 6; i >= 1; i--) {
        context.fillStyle = `rgba(0,0,0,${(0.36 - i * 0.03).toFixed(3)})`;
        context.fillText(line, left + i * scale, baseline + i * scale);
      }
      context.fillStyle = tag.textColor;
      context.fillText(line, left, baseline);
      break;
    }
  }
}

/* ------------------------------------------------------------------ the tag */

/** The box a tag occupies, worked out from its text and its shape. */
export interface TagBox {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

/**
 * Where the tag lands in this frame, and how big it is.
 *
 * Exported because the dialog draws a selection grid over the preview and needs
 * to know what it is pointing at, and because a caller that wants to reserve
 * room can ask without drawing.
 */
export function measureTag(
  context: TagContext,
  tag: ClipTag,
  frameWidth: number,
  frameHeight: number
): TagBox {
  const margin = Math.min(frameWidth, frameHeight) * tag.margin;

  // A special tag is a finished design with a proportion of its own, so there
  // is nothing to measure: its size comes from the reader's one Size control
  // and its shape comes from the drawing.
  const design = specialShape(tag.shape);
  if (design) {
    const width = frameWidth * design.fit * (tag.scale / 100);
    const height = (width * design.natural.height) / design.natural.width;
    const anchor = positionAnchor(tag.position);
    return {
      x: lerp(margin, frameWidth - width - margin, anchor.x),
      y: lerp(margin + (design.verticalOverflow ?? 0) * width / design.natural.width,
        frameHeight - height - margin - (design.verticalOverflow ?? 0) * width / design.natural.width, anchor.y),
      width,
      height,
      fontSize: (width / design.natural.width) * design.natural.height * 0.2
    };
  }

  const text = tag.caps ? tag.text.toUpperCase() : tag.text;

  const boxAt = (size: number) => {
    const scale = typeScale(size);
    context.save();
    context.font = `${Math.round(tag.weight)} ${size}px ${tagFontStack(tag.fontId)}`;
    const line = layOut(context, text, size, tag.tracking);
    context.restore();

    const pad = shapePadding(tag.shape, scale);
    return {
      scale,
      width: line.width + tag.padX * scale * 2 + pad.left + pad.right,
      height: size * 1.15 + tag.padY * scale * 2 + pad.top + pad.bottom
    };
  };

  let fontSize = Math.max(8, frameHeight * tag.fontScale);
  let measured = boxAt(fontSize);

  // A tag wider than the frame is not a size somebody chose, it is a sentence
  // somebody typed. Rather than let it run off both edges — where the ends are
  // unreadable and the shape is gone — the type shrinks until the badge fits
  // between the margins. Everything in the box scales with the type, so one
  // pass lands within a pixel, and the floor stops a paragraph from turning
  // into a grey line.
  const room = Math.max(1, frameWidth - margin * 2);
  if (measured.width > room) {
    fontSize = Math.max(8, fontSize * Math.max(0.25, room / measured.width));
    measured = boxAt(fontSize);
  }

  const scale = measured.scale;
  let width = measured.width;
  let height = measured.height;

  if (tag.shape === 'circle') {
    const side = Math.max(width, height);
    width = side;
    height = side;
  }

  const anchor = positionAnchor(tag.position);
  const overhang = shapeOverhang(tag.shape, scale);

  // The anchor says which edge the box is against; the margin pushes it in from
  // that edge and does nothing on the axis where the box is already centred.
  const x = lerp(margin, frameWidth - width - margin, anchor.x);
  const y = lerp(margin, frameHeight - height - overhang - margin, anchor.y);

  return { x, y, width, height, fontSize };
}

/**
 * The tag's whole life, in seconds, as three phases.
 *
 * `null` means there is nothing on screen at this instant — before it arrives,
 * or after its exit has finished.
 */
function phaseAt(tag: ClipTag, elapsed: number): { entrance: number; exit: number } | null {
  if (elapsed < 0) return null;

  // A special design times its own arrival and departure; only the hold in
  // between is the reader's, and it starts once the piece has finished landing.
  const design = specialShape(tag.shape);
  if (design) {
    const entrance = design.enter <= 0 ? 1 : clamp01(elapsed / design.enter);
    const leavesAt = design.enter + tagHold(tag);
    if (elapsed < leavesAt) return { entrance, exit: 0 };
    const exit = design.leave <= 0 ? 1 : (elapsed - leavesAt) / design.leave;
    return exit >= 1 ? null : { entrance, exit };
  }

  const entrance = tag.animSeconds <= 0 ? 1 : clamp01(elapsed / tag.animSeconds);
  if (tag.exit === 'none') return { entrance, exit: 0 };

  const leavesAt = tag.animSeconds + tagHold(tag);
  if (elapsed < leavesAt) return { entrance, exit: 0 };

  const exit = tag.exitSeconds <= 0 ? 1 : (elapsed - leavesAt) / tag.exitSeconds;
  return exit >= 1 ? null : { entrance, exit };
}

/**
 * Breaks a line into as many as it takes to stay inside a width.
 *
 * The plain tags never need this: their box is built around one line and grows
 * to fit it. The special designs are the other way round — the box was drawn
 * first and the words have to live in it — so they wrap, and a single word too
 * long for the space is broken rather than allowed to run out of the picture,
 * which is what `overflow-wrap: anywhere` does in the originals.
 */
function wrapLines(
  context: TagContext,
  text: string,
  fontSize: number,
  tracking: number,
  maxWidth: number
): TextLayout[] {
  const room = Math.max(fontSize, maxWidth);
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (!words.length) return [];

  const lines: string[] = [];
  let line = '';

  const fits = (candidate: string) => layOut(context, candidate, fontSize, tracking).width <= room;

  const place = (word: string) => {
    if (!line) {
      line = word;
      return;
    }
    if (fits(`${line} ${word}`)) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  };

  for (const word of words) {
    if (fits(word)) {
      place(word);
      continue;
    }
    // Longer than the whole line on its own: spill it a character at a time.
    for (const ch of Array.from(word)) {
      if (line && !fits(line + ch)) {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
  }
  if (line) lines.push(line);

  return lines.map((one) => layOut(context, one, fontSize, tracking));
}

/**
 * Draws one of the finished designs.
 *
 * The whole painter works in the design's own pixels — the same numbers its
 * stylesheet used — and one scale at the top maps them onto this frame, which
 * is what lets the drawing be a transcription rather than a re-derivation. The
 * painter calls back at the point in its own layer stack where the words
 * belong, so they arrive and leave carried by the panel they sit on.
 */
function drawSpecial(
  context: TagContext,
  tag: ClipTag,
  design: NonNullable<ReturnType<typeof specialShape>>,
  box: TagBox,
  elapsed: number,
  opacity: number
): void {
  const k = box.width / design.natural.width;
  if (!(k > 0)) return;

  const leavesAt = design.enter + tagHold(tag);
  const frame: SpecialFrame = {
    t: elapsed,
    out: elapsed >= leavesAt ? elapsed - leavesAt : -1,
    tag
  };

  const zoom = tag.fontScale / TAG_LIMITS['fontScale'].default;
  const words = (tag.caps ? tag.text.toUpperCase() : tag.text).trim();

  const write: SpecialText = (cx, cy, size, maxWidth, alpha) => {
    // Whatever the painter has already faded down to is the ceiling: a panel at
    // a fifth of its opacity cannot carry text at full strength.
    const shown = context.globalAlpha * alpha;
    if (shown <= INVISIBLE) return;

    const type = Math.max(4, size * zoom);
    context.save();
    context.font = `${Math.round(tag.weight)} ${type}px ${tagFontStack(tag.fontId)}`;
    context.globalAlpha = shown;

    const lines = wrapLines(context, words, type, tag.tracking, maxWidth);
    const step = type * 1.15;
    const middle = cx + design.natural.width * (tag.textX / 100);
    const first = cy + design.natural.height * (tag.textY / 100) - ((lines.length - 1) * step) / 2;

    let letters = 0;
    for (let i = 0; i < lines.length; i++) {
      paintText(
        context,
        lines[i],
        tag,
        middle,
        first + i * step + type * 0.36,
        type,
        typeScale(type),
        elapsed - design.textAt - letters * tag.stagger,
        shown
      );
      letters += lines[i].letters.length;
    }
    context.restore();
  };

  context.save();
  context.globalAlpha = opacity;
  context.lineJoin = 'round';
  context.translate(box.x, box.y);
  context.scale(k, k);
  specialPainter(design.id)(context, frame, write);
  context.restore();
}

/**
 * Draws the tag, or does nothing when there is nothing to draw.
 *
 * `elapsed` is seconds since the tag arrived: zero at the first frame of its
 * entrance, and the caller is the one that knows when that was. `opacity` is the
 * clip's own fade, applied on top of whatever the tag's animations are doing —
 * a tag fading out with the shot it belongs to should not stay bright over
 * black.
 */
export function drawTag(
  context: TagContext,
  tag: ClipTag,
  frameWidth: number,
  frameHeight: number,
  elapsed: number,
  opacity = 1
): void {
  const text = (tag.caps ? tag.text.toUpperCase() : tag.text).trim();
  if (!text || opacity <= INVISIBLE) return;

  const phase = phaseAt(tag, elapsed);
  if (!phase) return;

  const box = measureTag(context, tag, frameWidth, frameHeight);

  const design = specialShape(tag.shape);
  if (design) {
    drawSpecial(context, tag, design, box, elapsed, opacity);
    return;
  }

  const scale = typeScale(box.fontSize);

  const looping = animIsLooping(tag.anim);
  // A looping animation has no arrival of its own, so it fades in over the
  // entrance's seconds rather than popping into place at full strength.
  const arrival = entranceMotion(tag.anim, phase.entrance, elapsed, Math.max(0.2, tag.animSeconds));
  const entrance = looping ? compose(motion({ alpha: phase.entrance }), arrival) : arrival;
  const departure = exitMotion(tag.exit, phase.exit);

  const m = compose(entrance, departure);
  const alpha = m.alpha * opacity;
  if (alpha <= INVISIBLE) return;

  // The camera tilt is a fixed rotation in space, so it folds into the same
  // axis scaling the 3D animations use rather than being a step of its own.
  const scaleX = m.scaleX * turn(tag.tiltY);
  const scaleY = m.scaleY * turn(tag.tiltX);
  if (Math.abs(scaleX) < 0.002 || Math.abs(scaleY) < 0.002) return;

  const geo = shapePath(tag.shape, box.width, box.height, scale);
  // Measured again at the box's own type size rather than at the tag's, because
  // a long line shrinks to fit and the letters have to be laid out at the size
  // the box was actually built for.
  const layout = (() => {
    context.save();
    context.font = `${Math.round(tag.weight)} ${box.fontSize}px ${tagFontStack(tag.fontId)}`;
    const measured = layOut(context, tag.caps ? tag.text.toUpperCase() : tag.text, box.fontSize, tag.tracking);
    context.restore();
    return measured;
  })();

  context.save();
  context.globalAlpha = alpha;
  context.font = `${Math.round(tag.weight)} ${box.fontSize}px ${tagFontStack(tag.fontId)}`;
  context.lineJoin = 'round';
  context.miterLimit = 2;
  if (m.blur > 0) context.filter = `blur(${(m.blur * box.fontSize).toFixed(2)}px)`;

  const originX = m.originX * box.width;
  const originY = m.originY * box.height;
  context.translate(box.x + originX + m.dx * box.height, box.y + originY + m.dy * box.height);
  context.rotate(m.rotate);
  context.scale(scaleX, scaleY);
  context.translate(-originX, -originY);

  paintBlock(context, geo, box, tag, scale, elapsed, m.glow);

  // The offset is a share of the tag's own box rather than a pixel count, so a
  // text nudged into place on a 1080p preview stays where it was put when the
  // same plan is encoded at another size.
  paintText(
    context,
    layout,
    tag,
    box.width / 2 + (box.width * tag.textX) / 100,
    box.height / 2 + box.fontSize * 0.36 + (box.height * tag.textY) / 100,
    box.fontSize,
    scale,
    elapsed,
    alpha
  );

  context.restore();
}

/**
 * Everything behind the letters: the 3D block, the cast shadow, the outline and
 * the face.
 *
 * The order is the whole behaviour. The block is furthest back and darkest at
 * its far end; the shadow is thrown by the block rather than by the face, so a
 * thick tag casts the shadow of a thick tag; the outline is a wide stroke on the
 * boundary, half of which the face then covers, which is what makes it exactly
 * as thick as it was asked to be on every shape including the clipped ones.
 */
function paintBlock(
  context: TagContext,
  geo: ShapeGeometry,
  box: TagBox,
  tag: ClipTag,
  scale: number,
  elapsed: number,
  glow: number
): void {
  const angle = (tag.lightAngle * Math.PI) / 180;
  const ox = Math.cos(angle) * 0.92 * scale;
  const oy = Math.sin(angle) * 0.92 * scale;
  const back = mix(tag.color, '#000000', Math.min(0.92, tag.darken / 100));
  const depth = Math.round(tag.depth);
  const seeThrough = finishIsSeeThrough(tag.finish);

  // The cast shadow, thrown from the far end of the block. A face you can see
  // past goes without one: a solid silhouette behind glass reads as a blot.
  if (tag.shadow > 0 && !seeThrough) {
    context.save();
    context.translate(depth * ox, depth * oy);
    context.shadowColor = 'rgba(0, 0, 0, 0.36)';
    context.shadowBlur = tag.shadow * scale;
    context.shadowOffsetY = tag.shadow * 0.55 * scale;
    context.fillStyle = back;
    context.fill(geo.path, geo.rule);
    context.restore();
  }

  if (glow > 0 || tag.finish === 'neon') {
    context.save();
    context.shadowColor = withAlpha(tag.color, tag.finish === 'neon' ? 0.9 : glow);
    context.shadowBlur = (tag.finish === 'neon' ? 22 : 20 * glow) * scale;
    context.fillStyle = tag.color;
    context.fill(geo.path, geo.rule);
    context.fill(geo.path, geo.rule);
    context.restore();
  }

  for (let i = depth; i >= 1; i--) {
    context.save();
    context.translate(i * ox, i * oy);
    context.fillStyle = mix(back, tag.color, depth > 1 ? (1 - i / depth) * 0.55 : 0);
    context.fill(geo.path, geo.rule);
    context.restore();
  }

  if (tag.ring > 0) {
    context.save();
    context.lineWidth = tag.ring * scale * 2;
    context.lineJoin = 'round';
    context.strokeStyle = tag.outlineColor;
    context.stroke(geo.path);
    context.restore();
  }

  paintFace(context, geo, box.width, box.height, tag, scale, elapsed, tag.anim);

  if (tag.strokeIn > 0 && tag.finish !== 'hollow' && tag.finish !== 'sticker' && tag.finish !== 'double') {
    innerStroke(context, geo, tag.strokeIn * scale, tag.outlineColor);
  }
}
