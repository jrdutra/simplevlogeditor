/**
 * The special tags: whole designs, not a shape and a colour.
 *
 * Everything else in this catalogue is a badge the reader builds — pick a
 * silhouette, pick a finish, pick a colour. These are the opposite: each one is
 * a finished piece of motion design, handed over as a page of HTML and CSS, with
 * its own palette, its own layers and its own choreography. The reader chooses
 * the text, the type and where it sits; the rest is the design, and there is
 * nothing to configure because there was never a decision to make.
 *
 * ## What "the same design" means here
 *
 * The originals are CSS: stacked boxes with gradients, box-shadows, clip-paths
 * and keyframes. None of that reaches a video file, so each one is rebuilt as
 * canvas painting driven by a clock, exactly as `tag-renderer` rebuilds the
 * ordinary tags. The translation is deliberate and close:
 *
 * - `border-radius` with four values, including the percentage blobs the petals
 *   use, is four elliptical arcs — which is precisely what the browser draws;
 * - a `linear-gradient(Adeg, …)` is the same gradient, along the gradient line
 *   CSS defines for that angle and box;
 * - `box-shadow: inset` splits into the two things it is actually used for
 *   here — a hard band along one edge, and a soft glow falling inward from one —
 *   and both are painted by filling *outside* the shape while clipped *to* it;
 * - `clip-path: polygon(…)` is a path, and the torn-paper reveal is the same
 *   arithmetic the original ran every frame;
 * - the keyframe tables are copied number for number rather than re-derived.
 *
 * Two things are approximations and are marked where they occur: the 3D turns of
 * the wind-blown petals become an axis scale, the way the rest of the renderer
 * handles rotation; and the paper's `feTurbulence` grain becomes a small tile of
 * value noise, because a canvas cannot reference an SVG filter.
 *
 * ## Where the flash went
 *
 * Several of the originals blink just before they leave. It is not a design
 * choice, it is a bug in how they were driven: the script removes the entrance
 * class and adds the exit class, and for one frame — between the two — every
 * layer is back at the state the entrance started from, off screen and
 * transparent. Here there are no classes and no frame in between. A painter is
 * asked what the tag looks like at a given instant, and the exit is written to
 * start from the resting pose, so the departure continues the arrival instead of
 * jumping over it.
 */

import { ClipTag, TagSpecial } from './tag-overlay';
import { drawQrTagCode } from './tag-qrcode';

export type SpecialContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draws the tag's own text, in design pixels, under whatever transform the
 * painter is holding.
 *
 * The painter cannot write the text itself: the letters obey the reader's font,
 * size, tracking and text animation, and all of that lives in the renderer. So
 * the painter says where and how big, and calls back at the point in its own
 * layer stack where the text belongs — inside the front panel, so it flies in
 * and out with it.
 */
export type SpecialText = (
  cx: number,
  cy: number,
  size: number,
  maxWidth: number,
  alpha: number
) => void;

export interface SpecialFrame {
  /** Seconds since the tag arrived. Zero is the first frame of the entrance. */
  t: number;
  /** Seconds since the exit began, or -1 while the tag is still resting. */
  out: number;
  /** The tag, for the handful of painters that read a setting of their own. */
  tag: ClipTag;
}

/**
 * What one special design draws at one instant.
 *
 * The catalogue entry — its size, its palette's ink, how long it takes to
 * arrive — lives in `tag-overlay` with everything else the dialog reads. What
 * is here is only the painting, keyed by the same id.
 */
export type SpecialPainter = (c: SpecialContext, f: SpecialFrame, text: SpecialText) => void;

/* ------------------------------------------------------------------ easing */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A CSS timing function, solved the way the browser solves it.
 *
 * The curve is a cubic Bezier from (0,0) to (1,1); the input is the x of a point
 * on it and the output is that point's y, so x has to be inverted first. Newton
 * converges in three or four steps over this domain and bisection catches the
 * flat starts where the derivative is near zero.
 */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const curve = (a: number, b: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  const slope = (a: number, b: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b);
  };

  return (input: number) => {
    const x = clamp01(input);
    if (x === 0 || x === 1) return x;

    let t = x;
    for (let i = 0; i < 5; i++) {
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      const err = curve(x1, x2, t) - x;
      if (Math.abs(err) < 1e-6) return curve(y1, y2, t);
      t -= err / d;
    }

    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const err = curve(x1, x2, t) - x;
      if (Math.abs(err) < 1e-6) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return curve(y1, y2, t);
  };
}

export const LINEAR = (t: number) => clamp01(t);
export const EASE = bezier(0.25, 0.1, 0.25, 1);
export const EASE_IN = bezier(0.42, 0, 1, 1);
export const EASE_OUT = bezier(0, 0, 0.58, 1);
export const EASE_IN_OUT = bezier(0.42, 0, 0.58, 1);

/** The curves the supplied designs name, by the numbers they name them with. */
export const SOFT_LAND = bezier(0.22, 0.72, 0.36, 1);
export const SOFT_LEAVE = bezier(0.4, 0, 0.2, 1);
export const SNAP_IN = bezier(0.2, 0.85, 0.2, 1);
export const SNAP_OUT = bezier(0.2, 0.8, 0.2, 1);
export const RUSH_AWAY = bezier(0.7, 0, 0.9, 0.5);
export const GLIDE = bezier(0.16, 1, 0.3, 1);

/**
 * One CSS animation's progress at this instant, with `forwards` fill.
 *
 * Before the delay it is nought and after the run it is one, which is what
 * `animation-fill-mode: forwards` on an animation that has not started yet and
 * one that has finished amount to.
 */
export function run(t: number, delay: number, duration: number, ease = LINEAR): number {
  if (t <= delay) return 0;
  if (duration <= 0) return 1;
  return ease(clamp01((t - delay) / duration));
}

/**
 * A keyframe table, sampled.
 *
 * The curved designs ship their motion as twenty-one stops with a linear timing
 * function — a Bezier flight path baked flat on purpose, so the browser would
 * not ease into and out of every intermediate stop and make the movement stutter.
 * Copying the stops keeps that exactly; re-deriving the curve would not.
 *
 * Each row is `[offset, …values]` and every row carries the same values.
 */
export function sample(table: readonly (readonly number[])[], p: number): number[] {
  const x = clamp01(p);
  let i = 1;
  while (i < table.length - 1 && table[i][0] < x) i++;

  const a = table[i - 1];
  const b = table[i];
  const span = b[0] - a[0];
  const k = span <= 0 ? 0 : (x - a[0]) / span;

  // A fresh row every time, deliberately. Reusing one buffer across the four
  // layers of a stack made all four read whichever was sampled last, so every
  // panel was drawn at the pane's position and the pane's opacity.
  const out: number[] = [];
  for (let v = 1; v < a.length; v++) out.push(a[v] + (b[v] - a[v]) * k);
  return out;
}

/* ---------------------------------------------------------------- geometry */

export type Corners = number | readonly [number, number, number, number];

function corner(r: Corners, i: number): number {
  return typeof r === 'number' ? r : r[i];
}

/** A rounded rectangle, corners in the CSS order: top-left, then clockwise. */
export function rrect(x: number, y: number, w: number, h: number, r: Corners): Path2D {
  const path = new Path2D();
  const half = Math.min(w, h) / 2;
  const tl = Math.min(corner(r, 0), half);
  const tr = Math.min(corner(r, 1), half);
  const br = Math.min(corner(r, 2), half);
  const bl = Math.min(corner(r, 3), half);

  path.moveTo(x + tl, y);
  path.lineTo(x + w - tr, y);
  path.quadraticCurveTo(x + w, y, x + w, y + tr);
  path.lineTo(x + w, y + h - br);
  path.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  path.lineTo(x + bl, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - bl);
  path.lineTo(x, y + tl);
  path.quadraticCurveTo(x, y, x + tl, y);
  path.closePath();
  return path;
}

/**
 * The blob `border-radius: a b c d / e f g h` draws.
 *
 * Each corner is a quarter of an ellipse whose horizontal radius comes from the
 * first group and whose vertical radius comes from the second — that is the
 * whole of the CSS rule, and with percentages it is the only way to get the
 * lopsided petal silhouettes the designs use. The supplied values are all
 * chosen so no pair overflows its side, so the browser's shrink factor is one
 * and there is nothing to correct for.
 */
export function blob(
  x: number,
  y: number,
  w: number,
  h: number,
  across: readonly [number, number, number, number],
  down: readonly [number, number, number, number]
): Path2D {
  const hx = across.map((p) => (p / 100) * w);
  const vy = down.map((p) => (p / 100) * h);

  const path = new Path2D();
  path.moveTo(x + hx[0], y);
  path.lineTo(x + w - hx[1], y);
  path.ellipse(x + w - hx[1], y + vy[1], hx[1], vy[1], 0, -Math.PI / 2, 0);
  path.lineTo(x + w, y + h - vy[2]);
  path.ellipse(x + w - hx[2], y + h - vy[2], hx[2], vy[2], 0, 0, Math.PI / 2);
  path.lineTo(x + hx[3], y + h);
  path.ellipse(x + hx[3], y + h - vy[3], hx[3], vy[3], 0, Math.PI / 2, Math.PI);
  path.lineTo(x, y + vy[0]);
  path.ellipse(x + hx[0], y + vy[0], hx[0], vy[0], 0, Math.PI, Math.PI * 1.5);
  path.closePath();
  return path;
}

/** An ellipse as a path, for the round layers and the highlights. */
export function oval(x: number, y: number, w: number, h: number): Path2D {
  const path = new Path2D();
  path.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  return path;
}

/** A polygon from `clip-path: polygon(…)`, in per-cent of the box. */
export function shape(
  x: number,
  y: number,
  w: number,
  h: number,
  points: readonly number[]
): Path2D {
  const path = new Path2D();
  for (let i = 0; i < points.length; i += 2) {
    const px = x + (points[i] / 100) * w;
    const py = y + (points[i + 1] / 100) * h;
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  }
  path.closePath();
  return path;
}

/* ------------------------------------------------------------------ colour */

export type Stop = readonly [number, string];

/**
 * A `linear-gradient(Adeg, …)` over a box, on the gradient line CSS defines.
 *
 * Nought degrees points up and the angle turns clockwise, so the direction is
 * `(sin A, -cos A)` in a y-up world and `(sin A, cos A)` on a canvas. The line
 * is long enough that its ends sit on the corners the direction points at,
 * which is what makes a 135-degree gradient reach both diagonal corners of a
 * wide box instead of running out early.
 */
export function linear(
  c: SpecialContext,
  angle: number,
  x: number,
  y: number,
  w: number,
  h: number,
  stops: readonly Stop[]
): CanvasGradient {
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const length = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2;
  const cy = y + h / 2;

  const paint = c.createLinearGradient(
    cx - (dx * length) / 2,
    cy - (dy * length) / 2,
    cx + (dx * length) / 2,
    cy + (dy * length) / 2
  );
  for (const [at, colour] of stops) paint.addColorStop(clamp01(at), colour);
  return paint;
}

/**
 * A `radial-gradient(ellipse at …)`, and the SVG radial gradients that come
 * with it, painted into a path.
 *
 * A canvas radial gradient is always a circle, so the ellipse is made by
 * squashing the coordinate space around its centre and drawing the circle
 * there. That has to happen while the fill is going down, which is why this
 * paints rather than returning a paint like its linear sibling does.
 */
export function paintRadial(
  c: SpecialContext,
  path: Path2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  stops: readonly Stop[]
): void {
  if (rx <= 0 || ry <= 0) return;
  c.save();
  c.clip(path);
  c.translate(cx, cy);
  c.scale(1, ry / rx);
  const paint = c.createRadialGradient(0, 0, 0, 0, 0, rx);
  for (const [at, colour] of stops) paint.addColorStop(clamp01(at), colour);
  c.fillStyle = paint;
  c.fillRect(-rx * 6, -rx * 6, rx * 12, rx * 12);
  c.restore();
}

/** Multiplies a colour's alpha, so one painter can fade a whole palette. */
export function fade(colour: string, alpha: number): string {
  if (alpha >= 0.999) return colour;
  const a = Math.max(0, Math.min(1, alpha));

  if (colour.startsWith('#')) {
    const hex = colour.length === 4
      ? colour.slice(1).split('').map((ch) => ch + ch).join('')
      : colour.slice(1, 7);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(4)})`;
  }

  const parts = colour.replace(/^rgba?\(|\)$/g, '').split(',').map((p) => p.trim());
  if (parts.length < 3) return colour;
  const own = parts.length > 3 ? parseFloat(parts[3]) : 1;
  return `rgba(${parts[0]},${parts[1]},${parts[2]},${(own * a).toFixed(4)})`;
}

/* -------------------------------------------------------------- box shadow */

/**
 * `box-shadow: dx dy blur colour` — the outer one.
 *
 * A canvas has no way to ask for a shadow on its own: something has to be drawn
 * to cast one. So the shape is filled with the shadow switched on, while the
 * clip is set to everything *outside* the shape — which is where an outer
 * box-shadow lives anyway, since CSS clips it to outside the border box. What
 * lands is the shadow and nothing else.
 *
 * Filling without that clip is the mistake this replaced: under an opaque layer
 * the leftover silhouette is covered and never seen, but under a pane you can
 * see through it turns the whole thing black.
 */
export function cast(
  c: SpecialContext,
  path: Path2D,
  dx: number,
  dy: number,
  blur: number,
  colour: string
): void {
  const reach = 4000;
  const outside = new Path2D();
  outside.rect(-reach, -reach, reach * 2, reach * 2);
  outside.addPath(path);

  c.save();
  c.clip(outside, 'evenodd');
  c.shadowColor = colour;
  c.shadowOffsetX = dx;
  c.shadowOffsetY = dy;
  c.shadowBlur = blur;
  c.fillStyle = 'rgba(0,0,0,1)';
  c.fill(path);
  c.restore();
}

/**
 * `box-shadow: inset dx dy blur colour`.
 *
 * The trick the ordinary tags already use: clip to the shape, then fill
 * everything *outside* it with the shadow switched on. The fill itself is never
 * seen — it is entirely outside the clip — and all that lands on the canvas is
 * the shadow it throws inward.
 */
export function innerGlow(
  c: SpecialContext,
  path: Path2D,
  bounds: readonly [number, number, number, number],
  dx: number,
  dy: number,
  blur: number,
  colour: string
): void {
  const [x, y, w, h] = bounds;
  const pad = blur + Math.abs(dx) + Math.abs(dy) + 40;

  const around = new Path2D();
  around.rect(x - pad, y - pad, w + pad * 2, h + pad * 2);
  around.addPath(path);

  c.save();
  c.clip(path);
  c.shadowColor = colour;
  c.shadowOffsetX = dx;
  c.shadowOffsetY = dy;
  c.shadowBlur = blur;
  c.fillStyle = 'rgba(0,0,0,1)';
  c.fill(around, 'evenodd');
  c.restore();
}

/**
 * A hard `inset 0 n 0` band along one edge, which is what every one of these
 * designs uses an un-blurred inset shadow for: a lit lip along the top, and
 * once or twice a dark one along the bottom.
 */
export function innerBand(
  c: SpecialContext,
  path: Path2D,
  bounds: readonly [number, number, number, number],
  thickness: number,
  colour: string,
  edge: 'top' | 'bottom' = 'top'
): void {
  if (thickness <= 0) return;
  const [x, y, w, h] = bounds;

  c.save();
  c.clip(path);
  c.fillStyle = colour;
  c.fillRect(x, edge === 'top' ? y : y + h - thickness, w, thickness);
  c.restore();
}

/** A `border: n solid colour`, drawn inside the shape the way CSS does. */
export function border(c: SpecialContext, path: Path2D, width: number, colour: string): void {
  if (width <= 0) return;
  c.save();
  c.clip(path);
  c.lineWidth = width * 2;
  c.strokeStyle = colour;
  c.stroke(path);
  c.restore();
}

/** The same, with each side taking its own colour, for the bevel rings. */
export function bevelRing(
  c: SpecialContext,
  path: Path2D,
  bounds: readonly [number, number, number, number],
  width: number,
  lit: string,
  shaded: string
): void {
  const [x, y, w, h] = bounds;
  c.save();
  c.clip(path);
  c.lineWidth = width * 2;
  c.strokeStyle = linear(c, 135, x, y, w, h, [
    [0, lit],
    [0.42, fade(lit, 0.35)],
    [0.58, fade(shaded, 0.35)],
    [1, shaded]
  ]);
  c.stroke(path);
  c.restore();
}

/** Fills a path with a paint, in one call, because it happens everywhere. */
export function fill(c: SpecialContext, path: Path2D, paint: string | CanvasGradient): void {
  c.fillStyle = paint;
  c.fill(path);
}

/**
 * The moving highlight every one of the layered designs sends across its front
 * panel: a soft vertical band, tipped over, clipped to the panel.
 */
export function sheenBand(
  c: SpecialContext,
  panel: Path2D,
  left: number,
  top: number,
  width: number,
  height: number,
  tilt: number,
  alpha: number,
  strength = 0.2
): void {
  if (alpha <= 0.002) return;
  c.save();
  c.clip(panel);
  c.globalAlpha *= alpha;
  c.translate(left + width / 2, top + height / 2);
  c.rotate((tilt * Math.PI) / 180);
  const paint = linear(c, 90, -width / 2, -height / 2, width, height, [
    [0, 'rgba(255,255,255,0)'],
    [0.24, `rgba(255,255,255,${(strength * 0.2).toFixed(3)})`],
    [0.5, `rgba(255,255,255,${strength.toFixed(3)})`],
    [0.76, `rgba(255,255,255,${(strength * 0.2).toFixed(3)})`],
    [1, 'rgba(255,255,255,0)']
  ]);
  c.fillStyle = paint;
  c.fillRect(-width / 2, -height / 2, width, height);
  c.restore();
}

/* ------------------------------------------------------- the layered tags */

/**
 * The silhouette a layer is cut to.
 *
 * Three of the four are ordinary CSS shapes; the fourth is the percentage
 * `border-radius` blob the petals are drawn with, which is why it carries its
 * eight numbers rather than a single radius.
 */
export type Silhouette =
  | { readonly kind: 'rect'; readonly r: Corners }
  | { readonly kind: 'oval' }
  | {
      readonly kind: 'blob';
      readonly across: readonly [number, number, number, number];
      readonly down: readonly [number, number, number, number];
    };

export function outline(s: Silhouette, x: number, y: number, w: number, h: number): Path2D {
  if (s.kind === 'oval') return oval(x, y, w, h);
  if (s.kind === 'blob') return blob(x, y, w, h, s.across, s.down);
  return rrect(x, y, w, h, s.r);
}

/** The 1px double border the front panels wear just inside their edge. */
export interface LayerRing {
  readonly inset: number;
  readonly shape: Silhouette;
  readonly lit: string;
  readonly shaded: string;
}

export interface LayerSpec {
  readonly box: readonly [number, number, number, number];
  readonly shape: Silhouette;
  /** The `linear-gradient(135deg, …)` the layer is filled with. */
  readonly grad: readonly Stop[];
  /** The `linear-gradient(180deg, rgba(255,255,255,a), transparent n)` over it. */
  readonly gloss?: readonly [number, number];
  readonly border?: string;
  /** `box-shadow: 0 dy blur colour`. */
  readonly cast?: readonly [number, number, string];
  /** `box-shadow: inset 0 n 0` — the lit lip along the top. */
  readonly lip?: readonly [number, string];
  /** `box-shadow: inset 0 -dy blur colour` — the shade rising from the bottom. */
  readonly under?: readonly [number, number, string];
  readonly ring?: LayerRing;
}

function paintLayer(c: SpecialContext, layer: LayerSpec, alpha: number): Path2D {
  const [x, y, w, h] = layer.box;
  const path = outline(layer.shape, x, y, w, h);

  c.save();
  c.globalAlpha *= alpha;

  if (layer.cast) {
    const [dy, blur, colour] = layer.cast;
    cast(c, path, 0, dy, blur, colour);
  }

  fill(c, path, linear(c, 135, x, y, w, h, layer.grad));

  if (layer.gloss) {
    const [strength, end] = layer.gloss;
    fill(c, path, linear(c, 180, x, y, w, h, [
      [0, `rgba(255,255,255,${strength})`],
      [end, 'rgba(255,255,255,0)'],
      [1, 'rgba(255,255,255,0)']
    ]));
  }

  if (layer.lip) innerBand(c, path, layer.box, layer.lip[0], layer.lip[1]);
  if (layer.under) innerGlow(c, path, layer.box, 0, -layer.under[0], layer.under[1], layer.under[2]);
  if (layer.border) border(c, path, 1, layer.border);

  if (layer.ring) {
    const { inset, shape: ringShape, lit, shaded } = layer.ring;
    const box: readonly [number, number, number, number] =
      [x + inset, y + inset, w - inset * 2, h - inset * 2];
    bevelRing(c, outline(ringShape, box[0], box[1], box[2], box[3]), box, 1, lit, shaded);
  }

  c.restore();
  return path;
}

/** The see-through pane that rides behind the stack in most of these designs. */
export interface GlassSpec {
  readonly box: readonly [number, number, number, number];
  readonly shape: Silhouette;
  readonly tint: readonly [string, string];
  readonly border: string;
  readonly cast: readonly [number, number, string];
  readonly shade: string;
  readonly glow: string;
  readonly ring: LayerRing;
  readonly gleam: 'strip' | 'ellipse';
}

function paintGlass(c: SpecialContext, glass: GlassSpec, alpha: number): void {
  const [x, y, w, h] = glass.box;
  const path = outline(glass.shape, x, y, w, h);

  c.save();
  c.globalAlpha *= alpha;

  cast(c, path, 0, glass.cast[0], glass.cast[1], glass.cast[2]);

  // The pane really is a backdrop filter in the original. Blurring the picture
  // behind a layer that is itself behind the tag would cost a whole scratch
  // surface a frame for a tint this faint, so what survives is the tint, the
  // bevel and the gleam — the parts a reader can actually name.
  fill(c, path, linear(c, 135, x, y, w, h, [[0, glass.tint[0]], [1, glass.tint[1]]]));
  fill(c, path, linear(c, 145, x, y, w, h, [
    [0, 'rgba(255,255,255,0.18)'],
    [1, 'rgba(255,255,255,0.03)']
  ]));

  innerGlow(c, path, glass.box, 2, 2, 2, 'rgba(255,255,255,0.45)');
  innerGlow(c, path, glass.box, -2, -2, 3, glass.shade);
  innerGlow(c, path, glass.box, 0, 0, 18, glass.glow);
  border(c, path, 1, glass.border);

  const inset = glass.ring.inset;
  const ringBox: readonly [number, number, number, number] =
    [x + inset, y + inset, w - inset * 2, h - inset * 2];
  bevelRing(
    c,
    outline(glass.ring.shape, ringBox[0], ringBox[1], ringBox[2], ringBox[3]),
    ringBox,
    1,
    glass.ring.lit,
    glass.ring.shaded
  );

  c.save();
  c.clip(path);
  c.globalAlpha *= 0.75;
  if (glass.gleam === 'strip') {
    const g = rrect(x + 12, y + 10, w - 24, 22, 12);
    fill(c, g, linear(c, 180, x + 12, y + 10, w - 24, 22, [
      [0, 'rgba(255,255,255,0.25)'],
      [1, 'rgba(255,255,255,0)']
    ]));
  } else {
    const gx = x + w * 0.15;
    const gy = y + h * 0.08;
    const gw = w * 0.7;
    const gh = h * 0.22;
    paintRadial(c, oval(gx, gy, gw, gh), gx + gw / 2, gy + gh / 2, gw / 2, gh / 2, [
      [0, 'rgba(255,255,255,0.28)'],
      [0.58, 'rgba(255,255,255,0.08)'],
      [0.76, 'rgba(255,255,255,0)'],
      [1, 'rgba(255,255,255,0)']
    ]);
  }
  c.restore();

  c.restore();
}

/* --------------------------------------------------------------- the flight */

/**
 * Two ways the stack arrives, both copied from the stylesheets rather than
 * re-invented.
 *
 * The angular one turns a corner: each layer crosses on one axis, stops, and
 * finishes on the other, which is why its table has a stop at 58 per cent and
 * an easing curve that lands softly. The curved one is a Bezier flight already
 * flattened into twenty-one stops with a linear timing function, precisely so
 * the browser would not ease into and out of every stop and make the movement
 * stutter. Sampling the stops keeps that; fitting a curve to them would not.
 *
 * Every row is `[offset, x, y, degrees, alpha]`.
 */
type Table = readonly (readonly number[])[];

const A_BACK_IN: Table = [[0, -260, -110, 0, 0], [0.58, 0, -110, 0, 1], [1, 0, 0, 0, 1]];
const A_MID_IN: Table = [[0, 260, -115, 0, 0], [0.58, 0, -115, 0, 1], [1, 0, 0, 0, 1]];
const A_FRONT_IN: Table = [[0, 290, 125, 0, 0], [0.55, 0, 125, 0, 1], [1, 0, 0, 0, 1]];
const A_GLASS_IN: Table = [[0, -210, 0, 0, 0], [1, 0, 0, 0, 0.62]];
const A_FRONT_OUT: Table = [[0, 0, 0, 0, 1], [0.46, 0, 120, 0, 1], [1, 300, 120, 0, 0]];
const A_MID_OUT: Table = [[0, 0, 0, 0, 1], [0.46, 0, -110, 0, 1], [1, -280, -110, 0, 0]];
const A_BACK_OUT: Table = [[0, 0, 0, 0, 1], [0.46, 0, 105, 0, 1], [1, -290, 105, 0, 0]];
const A_GLASS_OUT: Table = [[0, 0, 0, 0, 0.62], [1, -240, 0, 0, 0]];

const C_BACK_IN: Table = [
  [0, -260, -110, -4, 0], [0.05, -259.5, -108.26, -3.971, 0.014], [0.1, -257.83, -103.33, -3.888, 0.053],
  [0.15, -254.51, -95.66, -3.757, 0.112], [0.2, -248.91, -85.77, -3.584, 0.189], [0.25, -240.42, -74.23, -3.375, 0.278],
  [0.3, -228.65, -61.66, -3.136, 0.376], [0.35, -213.46, -48.71, -2.873, 0.479], [0.4, -195.07, -36.01, -2.592, 0.583],
  [0.45, -173.99, -24.17, -2.299, 0.684], [0.5, -151, -13.75, -2, 0.777], [0.55, -127.08, -5.17, -1.701, 0.859],
  [0.6, -103.25, 1.28, -1.408, 0.926], [0.65, -80.54, 5.49, -1.127, 0.973], [0.7, -59.8, 7.55, -0.864, 0.998],
  [0.75, -41.73, 7.74, -0.625, 1], [0.8, -26.75, 6.52, -0.416, 1], [0.85, -15.07, 4.49, -0.243, 1],
  [0.9, -6.74, 2.31, -0.112, 1], [0.95, -1.71, 0.64, -0.029, 1], [1, 0, 0, 0, 1]
];
const C_MID_IN: Table = [
  [0, 260, -115, 4, 0], [0.05, 259.5, -113.2, 3.971, 0.014], [0.1, 257.83, -108.07, 3.888, 0.053],
  [0.15, 254.51, -100.1, 3.757, 0.112], [0.2, 248.91, -89.81, 3.584, 0.189], [0.25, 240.42, -77.78, 3.375, 0.278],
  [0.3, 228.65, -64.65, 3.136, 0.376], [0.35, 213.46, -51.09, 2.873, 0.479], [0.4, 195.07, -37.77, 2.592, 0.583],
  [0.45, 173.99, -25.34, 2.299, 0.684], [0.5, 151, -14.38, 2, 0.777], [0.55, 127.08, -5.34, 1.701, 0.859],
  [0.6, 103.25, 1.47, 1.408, 0.926], [0.65, 80.54, 5.91, 1.127, 0.973], [0.7, 59.8, 8.08, 0.864, 0.998],
  [0.75, 41.73, 8.26, 0.625, 1], [0.8, 26.75, 6.96, 0.416, 1], [0.85, 15.07, 4.79, 0.243, 1],
  [0.9, 6.74, 2.46, 0.112, 1], [0.95, 1.71, 0.68, 0.029, 1], [1, 0, 0, 0, 1]
];
const C_FRONT_IN: Table = [
  [0, 290, 125, 4.5, 0], [0.05, 289.15, 123.2, 4.467, 0.014], [0.1, 286.52, 118.05, 4.374, 0.053],
  [0.15, 281.72, 109.97, 4.227, 0.112], [0.2, 274.28, 99.45, 4.032, 0.189], [0.25, 263.73, 87, 3.797, 0.278],
  [0.3, 249.78, 73.23, 3.528, 0.376], [0.35, 232.39, 58.82, 3.232, 0.479], [0.4, 211.85, 44.45, 2.916, 0.583],
  [0.45, 188.7, 30.83, 2.586, 0.684], [0.5, 163.75, 18.62, 2.25, 0.777], [0.55, 137.96, 8.38, 1.914, 0.859],
  [0.6, 112.37, 0.49, 1.584, 0.926], [0.65, 87.96, -4.85, 1.268, 0.973], [0.7, 65.63, -7.67, 0.972, 0.998],
  [0.75, 46.05, -8.27, 0.703, 1], [0.8, 29.69, -7.15, 0.468, 1], [0.85, 16.83, -5, 0.273, 1],
  [0.9, 7.57, -2.6, 0.126, 1], [0.95, 1.93, -0.72, 0.033, 1], [1, 0, 0, 0, 1]
];
const C_GLASS_IN: Table = [
  [0, -210, 0, -2.8, 0], [0.05, -209.33, -0.81, -2.78, 0.009], [0.1, -207.27, -2.97, -2.722, 0.033],
  [0.15, -203.55, -5.9, -2.63, 0.07], [0.2, -197.83, -8.94, -2.509, 0.117], [0.25, -189.79, -11.45, -2.362, 0.172],
  [0.3, -179.26, -12.94, -2.195, 0.233], [0.35, -166.22, -13.15, -2.011, 0.297], [0.4, -150.93, -12.03, -1.814, 0.361],
  [0.45, -133.81, -9.78, -1.609, 0.424], [0.5, -115.5, -6.75, -1.4, 0.482], [0.55, -96.72, -3.42, -1.191, 0.533],
  [0.6, -78.23, -0.28, -0.986, 0.574], [0.65, -60.78, 2.22, -0.789, 0.604], [0.7, -44.97, 3.8, -0.605, 0.619],
  [0.75, -31.28, 4.33, -0.438, 0.62], [0.8, -20, 3.9, -0.291, 0.62], [0.85, -11.24, 2.82, -0.17, 0.62],
  [0.9, -5.02, 1.5, -0.078, 0.62], [0.95, -1.27, 0.42, -0.02, 0.62], [1, 0, 0, 0, 0.62]
];
const C_FRONT_OUT: Table = [
  [0, 0, 0, 0, 1], [0.05, 1.64, 0.13, 0.033, 1], [0.1, 6.5, 0.69, 0.126, 1],
  [0.15, 14.57, 2.14, 0.273, 1], [0.2, 25.96, 5.05, 0.468, 1], [0.25, 40.7, 9.91, 0.703, 0.989],
  [0.3, 58.68, 17.03, 0.972, 0.957], [0.35, 79.61, 26.42, 1.268, 0.908], [0.4, 102.94, 37.8, 1.584, 0.844],
  [0.45, 127.95, 50.62, 1.914, 0.768], [0.5, 153.75, 64.12, 2.25, 0.684], [0.55, 179.38, 77.44, 2.586, 0.593],
  [0.6, 203.9, 89.73, 2.916, 0.5], [0.65, 226.46, 100.26, 3.232, 0.407], [0.7, 246.4, 108.56, 3.528, 0.316],
  [0.75, 263.26, 114.44, 3.797, 0.232], [0.8, 276.84, 118.02, 4.032, 0.156], [0.85, 287.14, 119.74, 4.227, 0.092],
  [0.9, 294.32, 120.21, 4.374, 0.043], [0.95, 298.57, 120.11, 4.467, 0.011], [1, 300, 120, 4.5, 0]
];
const C_MID_OUT: Table = [
  [0, 0, 0, 0, 1], [0.05, -1.54, -0.06, -0.029, 1], [0.1, -6.06, -0.44, -0.112, 1],
  [0.15, -13.61, -1.59, -0.243, 1], [0.2, -24.24, -4.11, -0.416, 1], [0.25, -38.02, -8.5, -0.625, 0.989],
  [0.3, -54.84, -15.07, -0.864, 0.957], [0.35, -74.42, -23.86, -1.127, 0.908], [0.4, -96.24, -34.59, -1.408, 0.844],
  [0.45, -119.63, -46.72, -1.701, 0.768], [0.5, -143.75, -59.5, -2, 0.684], [0.55, -167.7, -72.08, -2.299, 0.593],
  [0.6, -190.6, -83.62, -2.592, 0.5], [0.65, -211.65, -93.43, -2.873, 0.407], [0.7, -230.24, -101.02, -3.136, 0.316],
  [0.75, -245.93, -106.24, -3.375, 0.232], [0.8, -258.55, -109.24, -3.584, 0.156], [0.85, -268.11, -110.46, -3.757, 0.092],
  [0.9, -274.75, -110.54, -3.888, 0.043], [0.95, -278.68, -110.2, -3.971, 0.011], [1, -280, -110, -4, 0]
];
const C_BACK_OUT: Table = [
  [0, 0, 0, 0, 1], [0.05, -1.54, 0.08, -0.03, 1], [0.1, -6.09, 0.51, -0.118, 1],
  [0.15, -13.71, 1.73, -0.255, 1], [0.2, -24.55, 4.3, -0.437, 1], [0.25, -38.68, 8.69, -0.656, 0.989],
  [0.3, -56.04, 15.2, -0.907, 0.957], [0.35, -76.35, 23.84, -1.183, 0.908], [0.4, -99.09, 34.33, -1.478, 0.844],
  [0.45, -123.52, 46.13, -1.786, 0.768], [0.5, -148.75, 58.5, -2.1, 0.684], [0.55, -173.81, 70.6, -2.414, 0.593],
  [0.6, -197.76, 81.62, -2.722, 0.5], [0.65, -219.72, 90.87, -3.017, 0.407], [0.7, -239.04, 97.93, -3.293, 0.316],
  [0.75, -255.28, 102.63, -3.544, 0.232], [0.8, -268.25, 105.17, -3.763, 0.156], [0.85, -278, 106.01, -3.945, 0.092],
  [0.9, -284.73, 105.8, -4.082, 0.043], [0.95, -288.68, 105.26, -4.17, 0.011], [1, -290, 105, -4.2, 0]
];
const C_GLASS_OUT: Table = [
  [0, 0, 0, 0, 0.62], [0.05, -1.27, 0.65, -0.02, 0.62], [0.1, -5.04, 2.43, -0.078, 0.62],
  [0.15, -11.35, 5.05, -0.17, 0.62], [0.2, -20.32, 8.15, -0.291, 0.62], [0.25, -32.01, 11.37, -0.438, 0.613],
  [0.3, -46.37, 14.36, -0.605, 0.593], [0.35, -63.16, 16.84, -0.789, 0.563], [0.4, -81.95, 18.6, -0.986, 0.523],
  [0.45, -102.14, 19.5, -1.191, 0.476], [0.5, -123, 19.5, -1.4, 0.424], [0.55, -143.72, 18.63, -1.609, 0.368],
  [0.6, -163.52, 16.98, -1.814, 0.31], [0.65, -181.7, 14.72, -2.011, 0.252], [0.7, -197.69, 12.05, -2.195, 0.196],
  [0.75, -211.15, 9.2, -2.362, 0.144], [0.8, -221.91, 6.38, -2.509, 0.097], [0.85, -230.01, 3.85, -2.63, 0.057],
  [0.9, -235.61, 1.81, -2.722, 0.027], [0.95, -238.9, 0.48, -2.78, 0.007], [1, -240, 0, -2.8, 0]
];

interface Track {
  readonly table: Table;
  readonly delay: number;
  readonly dur: number;
  readonly ease: (t: number) => number;
}

interface Flight {
  readonly back: Track;
  readonly mid: Track;
  readonly front: Track;
  readonly glass: Track;
}

const ANGULAR_IN: Flight = {
  back: { table: A_BACK_IN, delay: 0.05, dur: 0.95, ease: SOFT_LAND },
  mid: { table: A_MID_IN, delay: 0.18, dur: 1.0, ease: SOFT_LAND },
  front: { table: A_FRONT_IN, delay: 0.35, dur: 1.05, ease: SOFT_LAND },
  glass: { table: A_GLASS_IN, delay: 0.46, dur: 0.9, ease: SOFT_LAND }
};
const ANGULAR_OUT: Flight = {
  back: { table: A_BACK_OUT, delay: 0.28, dur: 0.85, ease: SOFT_LEAVE },
  mid: { table: A_MID_OUT, delay: 0.18, dur: 0.82, ease: SOFT_LEAVE },
  front: { table: A_FRONT_OUT, delay: 0.08, dur: 0.78, ease: SOFT_LEAVE },
  glass: { table: A_GLASS_OUT, delay: 0.22, dur: 0.78, ease: SOFT_LEAVE }
};
const CURVED_IN: Flight = {
  back: { table: C_BACK_IN, delay: 0.05, dur: 1.05, ease: LINEAR },
  mid: { table: C_MID_IN, delay: 0.18, dur: 1.1, ease: LINEAR },
  front: { table: C_FRONT_IN, delay: 0.35, dur: 1.15, ease: LINEAR },
  glass: { table: C_GLASS_IN, delay: 0.46, dur: 1.0, ease: LINEAR }
};
const CURVED_OUT: Flight = {
  back: { table: C_BACK_OUT, delay: 0.28, dur: 1.0, ease: LINEAR },
  mid: { table: C_MID_OUT, delay: 0.18, dur: 0.96, ease: LINEAR },
  front: { table: C_FRONT_OUT, delay: 0.08, dur: 0.92, ease: LINEAR },
  glass: { table: C_GLASS_OUT, delay: 0.22, dur: 0.92, ease: LINEAR }
};

/** Seconds from arrival to the last thing that moves, and from cue to gone. */
export const STACK_ENTER = 2.57;
const STACK_TEXT_AT = 1.22;
const ANGULAR_LEAVE = 1.13;
const CURVED_LEAVE = 1.28;

/**
 * Places one layer for this instant.
 *
 * While the tag is resting the entrance table has already run to its last row,
 * which is the resting pose; when the exit starts, its table begins from that
 * same pose. There is no moment where the two disagree, which is the whole of
 * why nothing flashes here.
 */
function placed(track: Track, clock: number): readonly number[] {
  return sample(track.table, run(clock, track.delay, track.dur, track.ease));
}

export interface StackDesign {
  readonly glass: GlassSpec | null;
  readonly back: LayerSpec;
  readonly mid: LayerSpec;
  readonly front: LayerSpec;
  readonly shine: boolean;
  readonly text: { readonly x: number; readonly y: number; readonly size: number; readonly width: number };
  readonly textShadow: readonly [number, number, string];
  readonly curved: boolean;
}

function moved(c: SpecialContext, box: readonly [number, number, number, number], at: readonly number[]): void {
  const cx = box[0] + box[2] / 2;
  const cy = box[1] + box[3] / 2;
  c.translate(at[0], at[1]);
  if (at[2] !== 0) {
    c.translate(cx, cy);
    c.rotate((at[2] * Math.PI) / 180);
    c.translate(-cx, -cy);
  }
}

/** Draws one of the ten layered designs at this instant. */
export function paintStack(
  c: SpecialContext,
  f: SpecialFrame,
  write: SpecialText,
  design: StackDesign
): void {
  const leaving = f.out >= 0;
  const flight = design.curved
    ? (leaving ? CURVED_OUT : CURVED_IN)
    : (leaving ? ANGULAR_OUT : ANGULAR_IN);
  const clock = leaving ? f.out : f.t;

  const back = placed(flight.back, clock);
  const mid = placed(flight.mid, clock);
  const front = placed(flight.front, clock);
  const glass = placed(flight.glass, clock);

  // The pane first. It sits ahead of the panels in the markup but behind all
  // three in the stacking order, which is a distinction that only matters
  // because the pane is larger than they are: painted in document order it
  // would wash the back panel out instead of standing behind it.
  if (design.glass) {
    c.save();
    moved(c, design.glass.box, glass);
    paintGlass(c, design.glass, glass[3]);
    c.restore();
  }

  c.save();
  moved(c, design.back.box, back);
  paintLayer(c, design.back, back[3]);
  c.restore();

  c.save();
  moved(c, design.mid.box, mid);
  paintLayer(c, design.mid, mid[3]);
  c.restore();

  c.save();
  moved(c, design.front.box, front);
  const panel = paintLayer(c, design.front, front[3]);

  if (design.shine && !leaving) {
    const p = run(f.t, 1.42, 1.15, EASE_OUT);
    const strength = p <= 0 ? 0 : p < 0.2 ? (p / 0.2) * 0.75 : 0.75 * (1 - (p - 0.2) / 0.8);
    const [bx, by, , bh] = design.front.box;
    c.save();
    c.globalAlpha *= front[3];
    sheenBand(c, panel, bx - 260 + lerp(0, 1160, p), by - bh * 0.45, 220, bh * 1.9, 18, strength);
    c.restore();
  }

  const ink = leaving
    ? 1 - run(f.out, 0, 0.28, EASE_IN)
    : run(f.t, STACK_TEXT_AT, 0.55, EASE_OUT);
  if (ink > 0.002) {
    c.save();
    c.shadowColor = design.textShadow[2];
    c.shadowOffsetY = design.textShadow[0];
    c.shadowBlur = design.textShadow[1];
    write(design.text.x, design.text.y, design.text.size, design.text.width, ink * front[3]);
    c.restore();
  }
  c.restore();
}

export function stackEnter(): number {
  return STACK_ENTER;
}

export function stackLeave(curved: boolean): number {
  return curved ? CURVED_LEAVE : ANGULAR_LEAVE;
}

export const STACK_TEXT_CUE = STACK_TEXT_AT;

/* ------------------------------------------------------------------- skins */

/** A layered design's palette, one field per declaration in its stylesheet. */
interface StackSkin {
  readonly back: Omit<LayerSpec, 'box' | 'shape' | 'ring'>;
  readonly mid: Omit<LayerSpec, 'box' | 'shape' | 'ring'>;
  readonly front: Omit<LayerSpec, 'box' | 'shape' | 'ring'>;
  readonly bevel: { readonly lit: string; readonly shaded: string } | null;
  readonly glass: {
    readonly tint: readonly [string, string];
    readonly border: string;
    readonly cast: readonly [number, number, string];
    readonly shade: string;
    readonly glow: string;
    readonly ring: { readonly lit: string; readonly shaded: string };
  } | null;
  readonly ink: string;
  readonly textShadow: readonly [number, number, string];
}

const PINK_A: StackSkin = {
  back: {
    grad: [[0, '#c72f6a'], [1, '#a91e5b']], gloss: [0.17, 0.34],
    border: 'rgba(255,225,238,0.25)', cast: [14, 26, 'rgba(104,12,52,0.20)'],
    lip: [2, 'rgba(255,255,255,0.28)'], under: [4, 8, 'rgba(91,8,45,0.15)']
  },
  mid: {
    grad: [[0, '#f7a8c5'], [1, '#f08bb0']], gloss: [0.34, 0.32],
    border: 'rgba(255,244,249,0.48)', cast: [12, 22, 'rgba(104,12,52,0.15)'],
    lip: [2, 'rgba(255,255,255,0.54)'], under: [4, 8, 'rgba(158,38,89,0.12)']
  },
  front: {
    grad: [[0, '#eb6399'], [0.55, '#e04f8a'], [1, '#cb3472']], gloss: [0.24, 0.34],
    border: 'rgba(255,232,242,0.32)', cast: [18, 30, 'rgba(104,12,52,0.23)'],
    lip: [2, 'rgba(255,255,255,0.34)'], under: [5, 10, 'rgba(111,11,55,0.16)']
  },
  bevel: { lit: 'rgba(255,255,255,0.28)', shaded: 'rgba(103,12,53,0.14)' },
  glass: {
    tint: ['rgba(255,214,231,0.22)', 'rgba(255,245,250,0.14)'],
    border: 'rgba(255,245,250,0.58)', cast: [12, 26, 'rgba(104,12,52,0.18)'],
    shade: 'rgba(127,19,65,0.15)', glow: 'rgba(255,191,218,0.10)',
    ring: { lit: 'rgba(255,255,255,0.42)', shaded: 'rgba(124,15,61,0.12)' }
  },
  ink: '#fff6fa',
  textShadow: [3, 8, 'rgba(104,12,52,0.25)']
};

const PINK_B: StackSkin = {
  back: {
    grad: [[0, '#a91f5f'], [1, '#7a1646']], gloss: [0.17, 0.34],
    border: 'rgba(255,218,235,0.25)', cast: [14, 26, 'rgba(122,22,70,0.20)'],
    lip: [2, 'rgba(255,255,255,0.28)'], under: [4, 8, 'rgba(92,12,52,0.15)']
  },
  mid: {
    grad: [[0, '#f49bc0'], [1, '#ee77a5']], gloss: [0.34, 0.32],
    border: 'rgba(255,232,242,0.48)', cast: [12, 22, 'rgba(122,22,70,0.15)'],
    lip: [2, 'rgba(255,255,255,0.54)'], under: [4, 8, 'rgba(145,30,83,0.12)']
  },
  front: {
    grad: [[0, '#e45796'], [0.55, '#d83f7d'], [1, '#9a245d']], gloss: [0.24, 0.34],
    border: 'rgba(255,218,235,0.32)', cast: [18, 30, 'rgba(122,22,70,0.23)'],
    lip: [2, 'rgba(255,255,255,0.34)'], under: [5, 10, 'rgba(98,15,58,0.16)']
  },
  bevel: { lit: 'rgba(255,255,255,0.28)', shaded: 'rgba(112,18,66,0.14)' },
  glass: {
    tint: ['rgba(255,195,221,0.22)', 'rgba(255,239,247,0.14)'],
    border: 'rgba(255,226,240,0.58)', cast: [12, 26, 'rgba(122,22,70,0.18)'],
    shade: 'rgba(126,22,72,0.15)', glow: 'rgba(255,174,211,0.10)',
    ring: { lit: 'rgba(255,255,255,0.42)', shaded: 'rgba(123,20,70,0.12)' }
  },
  ink: '#fff8fc',
  textShadow: [3, 8, 'rgba(122,22,70,0.25)']
};

const BLUE: StackSkin = {
  back: {
    grad: [[0, '#244a6b'], [1, '#17324d']], gloss: [0.17, 0.34],
    border: 'rgba(211,225,236,0.22)', cast: [14, 26, 'rgba(16,39,61,0.22)'],
    lip: [2, 'rgba(255,255,255,0.28)'], under: [4, 8, 'rgba(10,31,49,0.16)']
  },
  mid: {
    grad: [[0, '#9fb7ca'], [1, '#7898b3']], gloss: [0.34, 0.32],
    border: 'rgba(230,238,244,0.38)', cast: [12, 22, 'rgba(16,39,61,0.16)'],
    lip: [2, 'rgba(255,255,255,0.54)'], under: [4, 8, 'rgba(44,78,108,0.14)']
  },
  front: {
    grad: [[0, '#5b82a4'], [0.55, '#3f6f96'], [1, '#274f73']], gloss: [0.24, 0.34],
    border: 'rgba(218,229,238,0.28)', cast: [18, 30, 'rgba(16,39,61,0.24)'],
    lip: [2, 'rgba(255,255,255,0.34)'], under: [5, 10, 'rgba(10,31,49,0.17)']
  },
  bevel: { lit: 'rgba(255,255,255,0.28)', shaded: 'rgba(15,41,63,0.14)' },
  glass: {
    tint: ['rgba(158,190,216,0.20)', 'rgba(225,235,243,0.12)'],
    border: 'rgba(224,235,244,0.46)', cast: [12, 26, 'rgba(16,39,61,0.20)'],
    shade: 'rgba(35,67,94,0.15)', glow: 'rgba(168,199,221,0.10)',
    ring: { lit: 'rgba(255,255,255,0.42)', shaded: 'rgba(31,62,89,0.12)' }
  },
  ink: '#f4f8fb',
  textShadow: [3, 8, 'rgba(16,39,61,0.26)']
};

const AMBER: StackSkin = {
  back: {
    grad: [[0, '#b86608'], [1, '#8a4a05']], gloss: [0.17, 0.34],
    border: 'rgba(255,225,173,0.24)', cast: [14, 26, 'rgba(96,49,4,0.22)'],
    lip: [2, 'rgba(255,255,255,0.28)'], under: [4, 8, 'rgba(96,45,2,0.18)']
  },
  mid: {
    grad: [[0, '#f6c64a'], [1, '#efa51b']], gloss: [0.34, 0.32],
    border: 'rgba(255,240,198,0.42)', cast: [12, 22, 'rgba(96,49,4,0.17)'],
    lip: [2, 'rgba(255,255,255,0.54)'], under: [4, 8, 'rgba(151,83,5,0.14)']
  },
  front: {
    grad: [[0, '#e9a117'], [0.55, '#d9820b'], [1, '#b75a05']], gloss: [0.24, 0.34],
    border: 'rgba(255,229,174,0.30)', cast: [18, 30, 'rgba(96,49,4,0.24)'],
    lip: [2, 'rgba(255,255,255,0.34)'], under: [5, 10, 'rgba(100,45,2,0.17)']
  },
  bevel: { lit: 'rgba(255,255,255,0.28)', shaded: 'rgba(95,48,3,0.16)' },
  glass: {
    tint: ['rgba(232,161,31,0.18)', 'rgba(255,250,236,0.10)'],
    border: 'rgba(255,232,178,0.42)', cast: [12, 26, 'rgba(96,49,4,0.20)'],
    shade: 'rgba(104,52,4,0.16)', glow: 'rgba(239,165,27,0.10)',
    ring: { lit: 'rgba(255,255,255,0.42)', shaded: 'rgba(96,49,4,0.14)' }
  },
  ink: '#fffaf0',
  textShadow: [3, 8, 'rgba(96,49,4,0.27)']
};

const WINE: StackSkin = {
  back: {
    grad: [[0, '#7f1d2d'], [1, '#5f0f1b']], gloss: [0.17, 0.34],
    border: 'rgba(255,220,224,0.22)', cast: [14, 26, 'rgba(72,8,18,0.22)'],
    lip: [2, 'rgba(255,255,255,0.28)'], under: [4, 8, 'rgba(58,6,14,0.18)']
  },
  mid: {
    grad: [[0, '#d46a78'], [1, '#c94b5d']], gloss: [0.34, 0.32],
    border: 'rgba(255,232,234,0.38)', cast: [12, 22, 'rgba(72,8,18,0.18)'],
    lip: [2, 'rgba(255,255,255,0.54)'], under: [4, 8, 'rgba(100,20,32,0.14)']
  },
  front: {
    grad: [[0, '#b73a4c'], [0.55, '#a62a3a'], [1, '#7a1828']], gloss: [0.24, 0.34],
    border: 'rgba(255,222,225,0.28)', cast: [18, 30, 'rgba(72,8,18,0.25)'],
    lip: [2, 'rgba(255,255,255,0.34)'], under: [5, 10, 'rgba(58,6,14,0.18)']
  },
  bevel: { lit: 'rgba(255,255,255,0.28)', shaded: 'rgba(63,8,16,0.16)' },
  glass: {
    tint: ['rgba(198,70,88,0.18)', 'rgba(255,245,246,0.10)'],
    border: 'rgba(255,225,229,0.42)', cast: [12, 26, 'rgba(72,8,18,0.22)'],
    shade: 'rgba(78,10,20,0.16)', glow: 'rgba(201,75,93,0.10)',
    ring: { lit: 'rgba(255,255,255,0.42)', shaded: 'rgba(72,8,18,0.14)' }
  },
  ink: '#fff7f7',
  textShadow: [3, 8, 'rgba(72,8,18,0.28)']
};

const RED: StackSkin = {
  back: {
    grad: [[0, '#981421'], [1, '#6f0712']], gloss: [0.17, 0.34],
    border: 'rgba(255,218,218,0.25)', cast: [14, 26, 'rgba(105,8,15,0.20)'],
    lip: [2, 'rgba(255,255,255,0.28)'], under: [4, 8, 'rgba(80,5,10,0.15)']
  },
  mid: {
    grad: [[0, '#f18b8f'], [1, '#e85b61']], gloss: [0.34, 0.32],
    border: 'rgba(255,236,236,0.48)', cast: [12, 22, 'rgba(105,8,15,0.15)'],
    lip: [2, 'rgba(255,255,255,0.54)'], under: [4, 8, 'rgba(132,23,30,0.12)']
  },
  front: {
    grad: [[0, '#df474d'], [0.55, '#c62828'], [1, '#8f111c']], gloss: [0.24, 0.34],
    border: 'rgba(255,222,222,0.32)', cast: [18, 30, 'rgba(105,8,15,0.23)'],
    lip: [2, 'rgba(255,255,255,0.34)'], under: [5, 10, 'rgba(86,6,12,0.16)']
  },
  bevel: { lit: 'rgba(255,255,255,0.28)', shaded: 'rgba(100,8,14,0.14)' },
  glass: {
    tint: ['rgba(255,206,206,0.22)', 'rgba(255,242,242,0.14)'],
    border: 'rgba(255,236,236,0.58)', cast: [12, 26, 'rgba(105,8,15,0.18)'],
    shade: 'rgba(112,12,18,0.15)', glow: 'rgba(255,178,178,0.10)',
    ring: { lit: 'rgba(255,255,255,0.42)', shaded: 'rgba(110,10,16,0.12)' }
  },
  ink: '#fff7f7',
  textShadow: [3, 8, 'rgba(105,8,15,0.25)']
};

/** The one that is flat on purpose: primary colours, no glass, no bevel. */
const PRIMARY: StackSkin = {
  back: { grad: [[0, '#ff1f2d'], [1, '#ff1f2d']], cast: [14, 26, 'rgba(0,0,0,0.16)'] },
  mid: { grad: [[0, '#ffe500'], [1, '#ffe500']], cast: [12, 22, 'rgba(0,0,0,0.12)'] },
  front: { grad: [[0, '#4650d8'], [1, '#4650d8']], cast: [18, 30, 'rgba(0,0,0,0.18)'] },
  bevel: null,
  glass: null,
  ink: '#ffffff',
  textShadow: [3, 8, 'rgba(0,0,0,0.18)']
};

/* -------------------------------------------------------------- the shapes */

type Box = readonly [number, number, number, number];

interface StackGeometry {
  readonly natural: { readonly width: number; readonly height: number };
  readonly fit: number;
  readonly panel: Silhouette;
  readonly ringInset: number;
  readonly ringShape: Silhouette;
  readonly glassBox: Box | null;
  readonly glassShape: Silhouette;
  readonly glassRingInset: number;
  readonly glassRingShape: Silhouette;
  readonly gleam: 'strip' | 'ellipse';
  readonly back: Box;
  readonly mid: Box;
  readonly front: Box;
  readonly text: { readonly x: number; readonly y: number; readonly size: number; readonly width: number };
}

const RECT_20: Silhouette = { kind: 'rect', r: 20 };
const RECT_18: Silhouette = { kind: 'rect', r: 18 };
const RECT_15: Silhouette = { kind: 'rect', r: 15 };
const RECT_12: Silhouette = { kind: 'rect', r: 12 };
const OVAL: Silhouette = { kind: 'oval' };

/** The lower-third bar: three 820x120 panels stepped down and to the right. */
const BAR_GEOMETRY: StackGeometry = {
  natural: { width: 930, height: 228 },
  fit: 0.7,
  panel: RECT_20,
  ringInset: 5,
  ringShape: RECT_15,
  glassBox: [0, 0, 930, 228],
  glassShape: RECT_18,
  glassRingInset: 6,
  glassRingShape: RECT_12,
  gleam: 'strip',
  back: [30, 30, 820, 120],
  mid: [55, 52, 820, 120],
  front: [80, 78, 820, 120],
  text: { x: 490, y: 138, size: 44, width: 780 }
};

/** The same bar without the pane behind it, which shrinks the resting bounds. */
const BAR_BARE_GEOMETRY: StackGeometry = {
  ...BAR_GEOMETRY,
  natural: { width: 870, height: 168 },
  fit: 0.66,
  glassBox: null,
  back: [0, 0, 820, 120],
  mid: [25, 22, 820, 120],
  front: [50, 48, 820, 120],
  text: { x: 460, y: 108, size: 44, width: 780 }
};

const SQUARE_GEOMETRY: StackGeometry = {
  natural: { width: 360, height: 360 },
  fit: 0.3,
  panel: RECT_20,
  ringInset: 5,
  ringShape: RECT_15,
  glassBox: [0, 0, 300, 300],
  glassShape: RECT_18,
  glassRingInset: 6,
  glassRingShape: RECT_12,
  gleam: 'strip',
  back: [20, 20, 300, 300],
  mid: [40, 40, 300, 300],
  front: [60, 60, 300, 300],
  text: { x: 210, y: 210, size: 36, width: 260 }
};

const ROUND_GEOMETRY: StackGeometry = {
  ...SQUARE_GEOMETRY,
  panel: OVAL,
  ringShape: OVAL,
  glassShape: OVAL,
  glassRingShape: OVAL,
  gleam: 'ellipse'
};

function stackDesign(geom: StackGeometry, skin: StackSkin, curved: boolean): StackDesign {
  const ring = skin.bevel
    ? { inset: geom.ringInset, shape: geom.ringShape, lit: skin.bevel.lit, shaded: skin.bevel.shaded }
    : undefined;

  return {
    glass: skin.glass && geom.glassBox
      ? {
          box: geom.glassBox,
          shape: geom.glassShape,
          tint: skin.glass.tint,
          border: skin.glass.border,
          cast: skin.glass.cast,
          shade: skin.glass.shade,
          glow: skin.glass.glow,
          ring: {
            inset: geom.glassRingInset,
            shape: geom.glassRingShape,
            lit: skin.glass.ring.lit,
            shaded: skin.glass.ring.shaded
          },
          gleam: geom.gleam
        }
      : null,
    back: { ...skin.back, box: geom.back, shape: geom.panel },
    mid: { ...skin.mid, box: geom.mid, shape: geom.panel },
    front: { ...skin.front, box: geom.front, shape: geom.panel, ring },
    shine: skin.glass !== null,
    text: geom.text,
    textShadow: skin.textShadow,
    curved
  };
}

function layered(geom: StackGeometry, skin: StackSkin, curved: boolean): SpecialPainter {
  const design = stackDesign(geom, skin, curved);
  return (c, f, write) => paintStack(c, f, write, design);
}

const LAYERED_PAINTERS: Readonly<Record<string, SpecialPainter>> = {
  'bars-primary': layered(BAR_BARE_GEOMETRY, PRIMARY, false),
  'bars-pink': layered(BAR_GEOMETRY, PINK_A, false),
  'bars-blue': layered(BAR_GEOMETRY, BLUE, false),
  'bars-amber': layered(BAR_GEOMETRY, AMBER, false),
  'bars-wine': layered(BAR_GEOMETRY, WINE, false),
  'bars-curved': layered(BAR_GEOMETRY, PINK_A, true),
  'square-pink': layered(SQUARE_GEOMETRY, PINK_A, true),
  'square-red': layered(SQUARE_GEOMETRY, RED, true),
  'round-pink': layered(ROUND_GEOMETRY, PINK_B, true),
  'round-red': layered(ROUND_GEOMETRY, RED, true)
};

/* ------------------------------------------------------------------ petals */

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
const easeInCubic = (t: number) => t * t * t;

/** The cubic the petals fly along, as the original writes it. */
function curveAt(p: readonly number[], t: number): [number, number] {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return [
    a * p[0] + b * p[2] + d * p[4] + e * p[6],
    a * p[1] + b * p[3] + d * p[5] + e * p[7]
  ];
}

interface Pose {
  x: number;
  y: number;
  rot: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
}

/**
 * A petal of the blob design, at this instant.
 *
 * The original animates these by hand every frame rather than with keyframes,
 * for the reason its own comment gives: interpolating between a dozen stops
 * makes the browser ease in and out of each one and the flight stutters. What is
 * here is the same arithmetic — one Bezier for the path, a half-sine of sway on
 * the rotation, a smaller one of "breath" on the scale, and a smoothstep on the
 * fade so the petal is solid well before it lands.
 */
interface BlobPetalSpec {
  readonly path: readonly number[];
  readonly delay: number;
  readonly dur: number;
  readonly rot: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly alpha: readonly [number, number];
  readonly sway: number;
  readonly out: boolean;
}

function blobPetal(spec: BlobPetalSpec, seconds: number): Pose {
  const raw = spec.dur <= 0 ? 1 : clamp01((seconds - spec.delay) / spec.dur);
  const t = spec.out ? easeInCubic(raw) : easeOutQuint(raw);
  const [x, y] = curveAt(spec.path, t);

  const organic = Math.sin(Math.PI * t) * spec.sway;
  const breath = Math.sin(Math.PI * t) * 0.012;
  const scale = lerp(spec.scale[0], spec.scale[1], t) + breath;
  const shade = spec.out ? smoothstep(0.18, 1, t) : smoothstep(0, 0.46, t);

  return {
    x,
    y,
    rot: lerp(spec.rot[0], spec.rot[1], t) + organic,
    scaleX: scale,
    scaleY: scale,
    alpha: lerp(spec.alpha[0], spec.alpha[1], shade)
  };
}

/**
 * A petal of the wind design, at this instant.
 *
 * Same skeleton with a gust laid over it: two sine waves of different periods
 * push the petal sideways and tip it, `air` fades that gust out as it lands and
 * back in as it is carried away, and the depth becomes the only foreshortening
 * this renderer can honestly offer — the turns about X and Y are painted as an
 * axis scale of `cos`, which is what a flat plane turned by that angle actually
 * measures, and the parent's perspective becomes a scale about the same point.
 */
interface WindPetalSpec extends BlobPetalSpec {
  readonly rx: readonly [number, number];
  readonly ry: readonly [number, number];
  readonly flutter: number;
  readonly speed: number;
  readonly swayX: number;
  readonly swayY: number;
  readonly depth: number;
  readonly phase: number;
}

function windPetal(spec: WindPetalSpec, seconds: number): Pose {
  const raw = spec.dur <= 0 ? 1 : clamp01((seconds - spec.delay) / spec.dur);
  const t = spec.out ? easeInCubic(raw) : easeOutQuart(raw);
  const [px, py] = curveAt(spec.path, t);

  const air = spec.out ? smoothstep(0, 0.82, raw) : 1 - smoothstep(0.38, 1, raw);
  const waveA = Math.sin(raw * Math.PI * 2 * spec.speed + spec.phase);
  const waveB = Math.sin(raw * Math.PI * 2 * (spec.speed * 0.63) + spec.phase * 0.71);

  const z = Math.sin(raw * Math.PI * 2 + spec.phase) * spec.depth * air;
  const near = 1100 / (1100 - z);

  const rz = lerp(spec.rot[0], spec.rot[1], t) + waveA * spec.flutter * 0.33 * air;
  const rx = lerp(spec.rx[0], spec.rx[1], t) + waveB * spec.flutter * 0.78 * air;
  const ry = lerp(spec.ry[0], spec.ry[1], t) + waveA * spec.flutter * air;

  const breath = Math.sin(Math.PI * raw) * 0.014;
  const scale = (lerp(spec.scale[0], spec.scale[1], t) + breath) * near;
  const shade = spec.out ? smoothstep(0.58, 1, raw) : smoothstep(0.02, 0.34, raw);

  return {
    x: px + waveA * spec.swayX * air,
    y: py + waveB * spec.swayY * air,
    rot: rz,
    scaleX: scale * Math.cos((ry * Math.PI) / 180),
    scaleY: scale * Math.cos((rx * Math.PI) / 180),
    alpha: lerp(spec.alpha[0], spec.alpha[1], shade)
  };
}

/** Applies a pose about a point given as a share of the layer's own box. */
function posed(c: SpecialContext, box: Box, pose: Pose, originX = 0.5, originY = 0.5): void {
  const ox = box[0] + box[2] * originX;
  const oy = box[1] + box[3] * originY;
  c.translate(pose.x, pose.y);
  c.translate(ox, oy);
  c.rotate((pose.rot * Math.PI) / 180);
  c.scale(pose.scaleX, pose.scaleY);
  c.translate(-ox, -oy);
}

/* ------------------------------------------------- petals, the blob design */

const PETAL_TEXT = { x: 252, y: 173.5, size: 36, width: 260 };

const BLOB_BACK: LayerSpec = {
  ...PINK_B.back,
  box: [27, 19, 310, 235],
  shape: { kind: 'blob', across: [72, 28, 68, 32], down: [78, 34, 66, 22] }
};
const BLOB_MID: LayerSpec = {
  ...PINK_B.mid,
  box: [61, 38, 310, 235],
  shape: { kind: 'blob', across: [30, 70, 34, 66], down: [24, 72, 28, 76] }
};
const BLOB_FRONT: LayerSpec = {
  ...PINK_B.front,
  box: [97, 56, 310, 235],
  shape: { kind: 'blob', across: [68, 32, 74, 26], down: [30, 70, 34, 66] }
};
const BLOB_GLASS_SHAPE: Silhouette = {
  kind: 'blob',
  across: [70, 30, 66, 34],
  down: [76, 36, 64, 24]
};
const BLOB_GLASS: GlassSpec = {
  box: [0, 0, 310, 235],
  shape: BLOB_GLASS_SHAPE,
  tint: PINK_B.glass!.tint,
  border: PINK_B.glass!.border,
  cast: PINK_B.glass!.cast,
  shade: PINK_B.glass!.shade,
  glow: PINK_B.glass!.glow,
  ring: { inset: 6, shape: BLOB_GLASS_SHAPE, lit: PINK_B.glass!.ring.lit, shaded: PINK_B.glass!.ring.shaded },
  gleam: 'ellipse'
};

const BLOB_IN: Readonly<Record<string, BlobPetalSpec>> = {
  back: {
    path: [-360, -180, -310, -112, -118, 72, 0, 0], delay: 0.04, dur: 1.58,
    rot: [-38, 0], scale: [0.72, 1], alpha: [0, 1], sway: 7, out: false
  },
  mid: {
    path: [370, -210, 335, -118, 112, 78, 0, 0], delay: 0.15, dur: 1.64,
    rot: [42, 0], scale: [0.74, 1], alpha: [0, 1], sway: -7, out: false
  },
  front: {
    path: [390, 210, 350, 154, 138, -82, 0, 0], delay: 0.285, dur: 1.7,
    rot: [54, 0], scale: [0.76, 1], alpha: [0, 1], sway: 8, out: false
  },
  glass: {
    path: [-330, 160, -274, 138, -90, -76, 0, 0], delay: 0.405, dur: 1.51,
    rot: [-48, 0], scale: [0.78, 1], alpha: [0, 0.62], sway: -8, out: false
  }
};

const BLOB_OUT: Readonly<Record<string, BlobPetalSpec>> = {
  front: {
    path: [0, 0, 42, -20, 215, -72, 440, -225], delay: 0.05, dur: 1.36,
    rot: [0, 82], scale: [1, 0.68], alpha: [1, 0], sway: 5, out: true
  },
  mid: {
    path: [0, 0, -38, -22, -188, -96, -420, -250], delay: 0.145, dur: 1.45,
    rot: [0, -78], scale: [1, 0.68], alpha: [1, 0], sway: -5, out: true
  },
  glass: {
    path: [0, 0, 30, 34, 145, 142, 342, 272], delay: 0.19, dur: 1.37,
    rot: [0, 86], scale: [1, 0.64], alpha: [0.62, 0], sway: 5, out: true
  },
  back: {
    path: [0, 0, -42, 22, -220, 118, -470, 235], delay: 0.25, dur: 1.51,
    rot: [0, -86], scale: [1, 0.66], alpha: [1, 0], sway: -5, out: true
  }
};

const BLOB_SHEEN = bezier(0.22, 0.61, 0.36, 1);

function paintBlobPetals(c: SpecialContext, f: SpecialFrame, write: SpecialText): void {
  const leaving = f.out >= 0;
  const clock = leaving ? f.out : f.t;
  const set = leaving ? BLOB_OUT : BLOB_IN;

  const draw = (layer: LayerSpec, key: string) => {
    const pose = blobPetal(set[key], clock);
    c.save();
    posed(c, layer.box, pose);
    const panel = paintLayer(c, layer, pose.alpha);
    c.restore();
    return { pose, panel };
  };

  const glassPose = blobPetal(set['glass'], clock);
  c.save();
  posed(c, BLOB_GLASS.box, glassPose);
  paintGlass(c, BLOB_GLASS, glassPose.alpha);
  c.restore();

  draw(BLOB_BACK, 'back');
  draw(BLOB_MID, 'mid');

  const frontPose = blobPetal(set['front'], clock);
  c.save();
  posed(c, BLOB_FRONT.box, frontPose);
  const panel = paintLayer(c, BLOB_FRONT, frontPose.alpha);

  if (!leaving) {
    const p = BLOB_SHEEN(clamp01((f.t - 1.78) / 1.28));
    if (f.t > 1.78) {
      const strength = p < 0.18 ? (p / 0.18) * 0.75 : 0.75 * (1 - (p - 0.18) / 0.82);
      const [bx, by, , bh] = BLOB_FRONT.box;
      c.save();
      c.globalAlpha *= frontPose.alpha;
      sheenBand(c, panel, bx - 260 + lerp(0, 1160, p), by - bh * 0.45, 220, bh * 1.9, 18, strength);
      c.restore();
    }
  }

  const ink = leaving
    ? 1 - run(f.out, 0, 0.34, EASE_IN)
    : run(f.t, 1.57, 0.62, GLIDE);
  if (ink > 0.002) {
    c.save();
    c.shadowColor = 'rgba(122,22,70,0.25)';
    c.shadowOffsetY = 3;
    c.shadowBlur = 8;
    write(PETAL_TEXT.x, PETAL_TEXT.y, PETAL_TEXT.size, PETAL_TEXT.width, ink * frontPose.alpha);
    c.restore();
  }
  c.restore();
}

/* ------------------------------------------------ petals, the wind design */

/**
 * The second petal design draws its silhouettes as SVG curves rather than as
 * rounded boxes, which is what gives them a narrow base and a lopsided body.
 * The path data is the original's, unchanged, on the same 320 by 240 grid.
 */
interface WingArt {
  readonly body: string;
  readonly sheenPath: string;
  readonly fillStops: readonly Stop[];
  readonly fillLine: readonly [number, number, number, number];
  readonly softStops: readonly Stop[];
  readonly softAt: readonly [number, number, number];
  readonly edge: string;
  readonly edgeWidth: number;
  readonly cast: readonly [number, number, string];
}

const WING_DEEP: WingArt = {
  body: 'M18 127 C35 83 70 39 121 19 C171 -2 233 6 276 40 C310 67 321 107 305 143 C287 185 243 218 190 231 C139 243 86 227 52 197 C29 177 18 151 18 127Z',
  sheenPath: 'M32 123 C63 73 119 33 183 28 C229 24 269 39 294 68 C261 47 215 43 169 52 C107 64 61 94 32 123Z',
  fillStops: [[0, '#c43172'], [0.48, '#a91f5f'], [1, '#6f123f']],
  fillLine: [0.12, 0.18, 0.92, 0.86],
  softStops: [[0, 'rgba(255,255,255,0.18)'], [0.56, 'rgba(255,255,255,0.03)'], [1, 'rgba(255,255,255,0)']],
  softAt: [0.67, 0.3, 0.66],
  edge: 'rgba(255,216,233,0.22)',
  edgeWidth: 1,
  cast: [16, 19, 'rgba(122,22,70,0.18)']
};

const WING_GLASS: WingArt = {
  body: 'M17 126 C35 76 77 35 129 17 C183 -2 244 8 282 44 C315 75 320 116 299 154 C277 194 232 220 181 230 C127 240 76 222 45 192 C25 172 16 149 17 126Z',
  sheenPath: 'M29 117 C70 63 132 31 199 29 C240 28 274 39 299 60 C259 45 218 43 178 51 C117 62 68 86 29 117Z',
  fillStops: [[0, 'rgba(255,255,255,0.28)'], [0.45, 'rgba(255,197,221,0.18)'], [1, 'rgba(223,92,150,0.10)']],
  fillLine: [0.07, 0.07, 0.92, 0.93],
  softStops: [[0, 'rgba(255,255,255,0.33)'], [0.7, 'rgba(255,255,255,0.04)'], [1, 'rgba(255,255,255,0)']],
  softAt: [0.66, 0.26, 0.7],
  edge: 'rgba(255,240,247,0.62)',
  edgeWidth: 1.2,
  cast: [14, 18, 'rgba(122,22,70,0.11)']
};

const WING_LIGHT: WingArt = {
  body: 'M16 122 C34 75 74 35 124 18 C177 0 238 9 279 42 C312 69 321 107 306 143 C288 184 246 216 194 229 C143 242 91 228 55 200 C30 181 17 153 16 122Z',
  sheenPath: 'M33 117 C72 68 126 39 189 33 C235 29 271 39 297 62 C260 49 221 48 180 57 C120 68 72 91 33 117Z',
  fillStops: [[0, '#ffc6dd'], [0.48, '#ef86b0'], [1, '#c83d7a']],
  fillLine: [0.08, 0.15, 0.91, 0.88],
  softStops: [[0, 'rgba(255,255,255,0.32)'], [0.55, 'rgba(255,255,255,0.05)'], [1, 'rgba(255,255,255,0)']],
  softAt: [0.64, 0.28, 0.68],
  edge: 'rgba(255,241,247,0.34)',
  edgeWidth: 1,
  cast: [16, 19, 'rgba(122,22,70,0.18)']
};

const WING_MAIN: WingArt = {
  body: 'M17 124 C35 79 72 39 121 19 C170 -1 228 3 271 34 C307 60 321 99 310 135 C297 178 254 214 200 228 C146 242 92 230 56 203 C30 184 17 155 17 124Z',
  sheenPath: 'M34 116 C72 66 124 37 186 31 C230 27 269 36 298 57 C261 46 220 46 180 55 C122 67 74 90 34 116Z',
  fillStops: [[0, '#ef6ca4'], [0.52, '#d83f7d'], [1, '#912052']],
  fillLine: [0.09, 0.12, 0.94, 0.9],
  softStops: [[0, 'rgba(255,255,255,0.22)'], [0.52, 'rgba(255,255,255,0.04)'], [1, 'rgba(255,255,255,0)']],
  softAt: [0.63, 0.25, 0.68],
  edge: 'rgba(255,215,232,0.25)',
  edgeWidth: 1,
  cast: [16, 19, 'rgba(122,22,70,0.18)']
};

const WING_GLOW = 'M72 59 C119 38 178 31 228 42 C205 51 183 62 161 78 C128 74 99 68 72 59Z';

const WING_W = 320;
const WING_H = 240;

function paintWing(c: SpecialContext, art: WingArt, box: Box, alpha: number, glow: number): void {
  if (alpha <= 0.002) return;
  const [x, y] = box;

  c.save();
  c.globalAlpha *= alpha;
  c.translate(x, y);

  const body = new Path2D(art.body);
  cast(c, body, 0, art.cast[0], art.cast[1], art.cast[2]);

  const [x1, y1, x2, y2] = art.fillLine;
  const paint = c.createLinearGradient(x1 * WING_W, y1 * WING_H, x2 * WING_W, y2 * WING_H);
  for (const [at, colour] of art.fillStops) paint.addColorStop(at, colour);
  c.fillStyle = paint;
  c.fill(body);

  c.lineWidth = art.edgeWidth;
  c.strokeStyle = art.edge;
  c.stroke(body);

  const [cx, cy, r] = art.softAt;
  paintRadial(
    c,
    new Path2D(art.sheenPath),
    cx * WING_W, cy * WING_H, r * WING_W, r * WING_H,
    art.softStops
  );

  if (glow > 0.002) {
    c.save();
    c.globalAlpha *= glow;
    const sweep = c.createLinearGradient(0, 0, WING_W, 0);
    sweep.addColorStop(0, 'rgba(255,255,255,0)');
    sweep.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    sweep.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = sweep;
    c.fill(new Path2D(WING_GLOW));
    c.restore();
  }

  c.restore();
}

const WIND_BOX: Readonly<Record<string, Box>> = {
  glass: [0, 0, WING_W, WING_H],
  back: [30, 20, WING_W, WING_H],
  mid: [66, 39, WING_W, WING_H],
  front: [104, 63, WING_W, WING_H]
};

function wind(
  path: readonly number[],
  delay: number,
  dur: number,
  rot: readonly [number, number],
  rx: readonly [number, number],
  ry: readonly [number, number],
  scale: readonly [number, number],
  alpha: readonly [number, number],
  flutter: number,
  speed: number,
  swayX: number,
  swayY: number,
  depth: number,
  phase: number,
  out: boolean
): WindPetalSpec {
  return { path, delay, dur, rot, rx, ry, scale, alpha, flutter, speed, swayX, swayY, depth, phase, out, sway: 0 };
}

const WIND_IN: Readonly<Record<string, WindPetalSpec>> = {
  back: wind([-455, -212, -330, -330, -176, 112, 0, 0], 0.02, 1.82, [-58, 0], [52, 0], [-62, 0], [0.64, 1], [0, 1], 20, 2.15, 18, 22, 45, 0.3, false),
  mid: wind([472, -246, 378, -344, 168, 126, 0, 0], 0.105, 1.9, [64, 0], [-44, 0], [72, 0], [0.66, 1], [0, 1], 22, 2.32, 19, 24, 50, 1.1, false),
  front: wind([505, 238, 430, 316, 196, -128, 0, 0], 0.22, 1.98, [78, 0], [58, 0], [-76, 0], [0.68, 1], [0, 1], 24, 2.5, 22, 25, 58, 2.05, false),
  glass: wind([-430, 214, -350, 306, -138, -104, 0, 0], 0.34, 1.76, [-70, 0], [-56, 0], [68, 0], [0.7, 1], [0, 0.55], 22, 2.38, 18, 23, 48, 2.8, false)
};

const WIND_OUT: Readonly<Record<string, WindPetalSpec>> = {
  front: wind([0, 0, 76, -48, 276, -118, 560, -296], 0.045, 1.5, [0, 118], [0, 74], [0, -112], [1, 0.58], [1, 0], 26, 2.72, 23, 28, 72, 0.55, true),
  mid: wind([0, 0, -62, -58, -258, -132, -548, -310], 0.12, 1.58, [0, -112], [0, -66], [0, 108], [1, 0.59], [1, 0], 25, 2.55, 22, 27, 68, 1.7, true),
  glass: wind([0, 0, 48, 64, 212, 202, 472, 360], 0.18, 1.46, [0, 132], [0, -82], [0, 116], [1, 0.55], [0.55, 0], 28, 2.9, 25, 31, 78, 2.4, true),
  back: wind([0, 0, -72, 50, -294, 172, -590, 326], 0.245, 1.6, [0, -126], [0, 70], [0, -118], [1, 0.56], [1, 0], 27, 2.65, 24, 30, 74, 3.2, true)
};

function paintWindPetals(c: SpecialContext, f: SpecialFrame, write: SpecialText): void {
  const leaving = f.out >= 0;
  const clock = leaving ? f.out : f.t;
  const set = leaving ? WIND_OUT : WIND_IN;

  const layer = (key: string, art: WingArt, glow = 0) => {
    const pose = windPetal(set[key], clock);
    c.save();
    posed(c, WIND_BOX[key], pose, 0.18, 0.54);
    paintWing(c, art, WIND_BOX[key], pose.alpha, glow);
    c.restore();
    return pose;
  };

  layer('glass', WING_GLASS);
  layer('back', WING_DEEP);
  layer('mid', WING_LIGHT);

  const shimmer = leaving ? 0 : (() => {
    const p = EASE_OUT(clamp01((f.t - 2.05) / 1.2));
    if (f.t <= 2.05 || p >= 1) return 0;
    return p < 0.35 ? (p / 0.35) * 0.58 : 0.58 * (1 - (p - 0.35) / 0.65);
  })();

  const front = windPetal(set['front'], clock);
  c.save();
  posed(c, WIND_BOX['front'], front, 0.18, 0.54);
  paintWing(c, WING_MAIN, WIND_BOX['front'], front.alpha, shimmer);

  const ink = leaving
    ? 1 - run(f.out, 0, 0.28, EASE_IN)
    : run(f.t, 1.81, 0.68, GLIDE);
  if (ink > 0.002) {
    c.save();
    c.shadowColor = 'rgba(104,14,56,0.27)';
    c.shadowOffsetY = 3;
    c.shadowBlur = 8;
    write(264, 183, 36, 250, ink * front.alpha);
    c.restore();
  }
  c.restore();
}

/* ------------------------------------------------------ the social ribbons */

/**
 * Both social designs arrive the same way: the whole piece rises, overshoots,
 * settles, and then breathes on a three-second loop for as long as it stays.
 *
 * In the originals the float is a second animation on the same element, so it
 * takes the transform over from the entrance the moment its delay is up — which
 * is also the moment the entrance has finished, so nothing jumps. Keeping the
 * float running through the exit is the one deliberate difference: the original
 * stops it by removing a class, and that is exactly the frame where it blinks.
 */
const POP_IN: Table = [
  [0, 80, 0.68, 8, 0], [0.65, -10, 1.06, 0, 1], [0.82, 5, 0.98, 0, 1], [1, 0, 1, 0, 1]
];
const RUSH_OUT: Table = [
  [0, 0, 1, 0, 1], [0.2, -30, 1.04, 0, 1], [1, 900, 0.75, 8, 0]
];

interface Ribbon {
  x: number;
  y: number;
  scale: number;
  blur: number;
  alpha: number;
}

function ribbonPose(f: SpecialFrame, smallest: number): Ribbon {
  const rise = sample(POP_IN, run(f.t, 0, 0.9, SOFT_LAND));
  const grow = smallest + (rise[1] - 0.68) * ((1 - smallest) / (1 - 0.68));

  const bob = f.t <= 1.1 ? 0 : (() => {
    const phase = ((f.t - 1.1) / 3) % 1;
    const half = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    return -5 * EASE_IN_OUT(half);
  })();

  if (f.out < 0) {
    return { x: 0, y: rise[0] + bob, scale: grow, blur: rise[2], alpha: rise[3] };
  }

  const go = sample(RUSH_OUT, run(f.out, 0, 0.65, RUSH_AWAY));
  return { x: go[0], y: bob, scale: go[1], blur: go[2], alpha: go[3] };
}

function ribbonTransform(c: SpecialContext, pose: Ribbon, w: number, h: number): void {
  c.translate(pose.x, pose.y);
  c.translate(w / 2, h / 2);
  c.scale(pose.scale, pose.scale);
  c.translate(-w / 2, -h / 2);
  if (pose.blur > 0.05) c.filter = `blur(${pose.blur.toFixed(2)}px)`;
}

/** The band of light that crosses both bars on a loop. */
function ribbonShine(
  c: SpecialContext,
  panel: Path2D,
  bar: Box,
  t: number,
  delay: number,
  period: number,
  width: number,
  tilt: number,
  strength: number,
  peak: number,
  ends: number,
  far: number
): void {
  if (t <= delay) return;
  const p = EASE_IN_OUT(((t - delay) / period) % 1);
  const left = bar[0] + lerp(-0.3, far, Math.min(1, p / ends)) * bar[2];
  const alpha = p < 0.2 ? 0
    : p < 0.35 ? ((p - 0.2) / 0.15) * peak
    : p < ends ? peak * (1 - (p - 0.35) / (ends - 0.35))
    : 0;
  if (alpha <= 0.002) return;
  sheenBand(c, panel, left, bar[1] - bar[3] * 0.55, width, bar[3] * 2.3, tilt, alpha, strength);
}

/* ------------------------------------------------------------- Instagram */

const IG_BAR: Box = [105, 40, 870, 150];
const IG_ICON: Box = [8, 21, 188, 188];
const IG_HEART: Box = [813, 37.5, 155, 155];

const IG_BAR_STOPS: readonly Stop[] = [
  [0, '#405DE6'], [0.18, '#5851DB'], [0.38, '#833AB4'], [0.58, '#C13584'],
  [0.72, '#E1306C'], [0.84, '#FD1D1D'], [0.92, '#F56040'], [1, '#FCAF45']
];

const IG_PULSE: Table = [[0, 1, 0], [0.7, 1, 0], [0.82, 1.08, -2], [0.9, 0.98, 1], [1, 1, 0]];
const IG_BEAT: Table = [
  [0, 1, 0], [0.62, 1, 0], [0.68, 1.16, -4], [0.73, 0.96, 3], [0.79, 1.12, -2], [0.86, 1, 0], [1, 1, 0]
];

const HEART_BODY = 'M60 99 C52 91, 18 67, 18 39 C18 20, 31 10, 46 10 C55 10, 61 15, 66 22 C71 15, 78 10, 88 10 C104 10, 113 23, 113 39 C113 66, 80 91, 60 99 Z';
const HEART_GLINT = 'M36 25 C31 29, 29 35, 29 42';

/** A looping keyframe table read at this instant, or its resting row. */
function loop(table: Table, t: number, delay: number, period: number, ease = EASE_IN_OUT): readonly number[] {
  if (t <= delay) return sample(table, 0);
  const phase = ((t - delay) / period) % 1;
  return sample(table, ease(phase));
}

/** The little hearts that lift off the big one. */
function miniHeart(
  c: SpecialContext,
  base: Box,
  from: readonly [number, number, number, number],
  to: readonly [number, number, number, number],
  peak: number,
  fadeIn: number,
  gone: number,
  t: number,
  delay: number
): void {
  if (t <= delay) return;
  const phase = ((t - delay) / 2.8) % 1;
  if (phase < 0.62 || phase > gone) return;

  const move = EASE_OUT((phase - 0.62) / (gone - 0.62));
  const alpha = phase < fadeIn
    ? ((phase - 0.62) / (fadeIn - 0.62)) * peak
    : peak * (1 - (phase - fadeIn) / (gone - fadeIn));
  if (alpha <= 0.002) return;

  const body = new Path2D();
  body.addPath(rrect(0, 0, 21, 19, [3, 0, 4, 0]));
  body.addPath(oval(0, -10, 21, 21));
  body.addPath(oval(10, 0, 21, 21));

  c.save();
  c.globalAlpha *= alpha;
  c.translate(base[0] + lerp(from[0], to[0], move), base[1] + lerp(from[1], to[1], move));
  c.translate(10.5, 9.5);
  c.rotate((lerp(from[2], to[2], move) * Math.PI) / 180);
  const s = lerp(from[3], to[3], move);
  c.scale(s, s);
  c.translate(-10.5, -9.5);
  cast(c, body, 0, 3, 2, 'rgba(0,0,0,0.48)');
  c.fillStyle = '#ffffff';
  c.fill(body);
  c.restore();
}

function paintInstagram(c: SpecialContext, f: SpecialFrame, write: SpecialText): void {
  const pose = ribbonPose(f, 0.68);
  if (pose.alpha <= 0.002) return;

  c.save();
  ribbonTransform(c, pose, 1080, 230);
  c.globalAlpha *= pose.alpha;

  /* the bar */
  const bar = rrect(IG_BAR[0], IG_BAR[1], IG_BAR[2], IG_BAR[3], 40);
  cast(c, bar, 0, 16, 24, 'rgba(0,0,0,0.34)');
  cast(c, bar, 0, 0, 24, 'rgba(193,53,132,0.36)');
  fill(c, bar, linear(c, 120, IG_BAR[0], IG_BAR[1], IG_BAR[2], IG_BAR[3], IG_BAR_STOPS));
  innerGlow(c, bar, IG_BAR, 0, 7, 9, 'rgba(255,255,255,0.34)');
  innerGlow(c, bar, IG_BAR, 0, -10, 16, 'rgba(70,0,80,0.30)');

  c.save();
  c.clip(bar);
  c.globalAlpha *= 0.72;
  fill(
    c,
    oval(IG_BAR[0] + 28, IG_BAR[1] + 9, IG_BAR[2] - 56, 6),
    linear(c, 90, IG_BAR[0] + 28, 0, IG_BAR[2] - 56, 6, [
      [0, 'rgba(255,255,255,0)'], [0.5, 'rgba(255,255,255,0.78)'], [1, 'rgba(255,255,255,0)']
    ])
  );
  c.restore();

  ribbonShine(c, bar, IG_BAR, f.t, 1.3, 3.3, 125, 18, 0.44, 0.9, 0.62, 1.16);

  /* the handle */
  const shadows: readonly (readonly [number, number, string])[] = [
    [9, 7, 'rgba(0,0,0,0.45)'], [5, 0, 'rgba(150,90,160,0.55)'], [3, 0, 'rgba(230,230,230,0.88)']
  ];
  for (const [dy, blur, colour] of shadows) {
    c.save();
    c.shadowColor = colour;
    c.shadowOffsetY = dy;
    c.shadowBlur = blur;
    write(555, 115, 61, 670, 1);
    c.restore();
  }

  /* the camera badge */
  const pulse = loop(IG_PULSE, f.t, 1.2, 2.3);
  c.save();
  c.translate(IG_ICON[0] + 94, IG_ICON[1] + 94);
  c.rotate((pulse[1] * Math.PI) / 180);
  c.scale(pulse[0], pulse[0]);
  c.translate(-(IG_ICON[0] + 94), -(IG_ICON[1] + 94));

  const badge = rrect(IG_ICON[0], IG_ICON[1], 188, 188, 48);
  cast(c, badge, 0, 13, 20, 'rgba(0,0,0,0.30)');
  cast(c, badge, 0, 0, 14, 'rgba(165,72,190,0.30)');
  fill(c, badge, linear(c, 145, IG_ICON[0], IG_ICON[1], 188, 188, [
    [0, '#6a5cff'], [0.32, '#8b4be8'], [0.63, '#d84f8f'], [1, '#ff7a59']
  ]));
  innerGlow(c, badge, IG_ICON, 0, 8, 10, 'rgba(255,255,255,0.34)');
  innerGlow(c, badge, IG_ICON, 0, -9, 14, 'rgba(55,0,80,0.24)');
  border(c, badge, 4, 'rgba(255,255,255,0.28)');

  // `overflow: hidden` on the badge, kept because it is load-bearing: two of
  // the camera's flourishes are positioned against the badge rather than the
  // camera and end up almost entirely outside it, which is what the page shows.
  c.save();
  c.clip(badge);

  c.save();
  c.filter = 'blur(2px)';
  c.translate(40 + 44, 42 + 10);
  c.rotate((-10 * Math.PI) / 180);
  c.fillStyle = 'rgba(255,255,255,0.42)';
  c.fill(oval(-44, -10, 88, 20));
  c.restore();

  // The camera, its lens, its shutter hood and its spark: all four are placed
  // against the camera's own box, which is why they stay together when it is
  // tipped over by seven degrees.
  c.save();
  c.translate(102, 115);
  c.rotate((-7 * Math.PI) / 180);
  c.translate(-102, -115);
  c.strokeStyle = '#ffffff';
  c.shadowColor = 'rgba(0,0,0,0.26)';
  c.shadowOffsetY = 6;
  c.shadowBlur = 4;

  c.lineWidth = 9;
  c.stroke(rrect(50.5, 73.5, 103, 83, [19.5, 29.5, 17.5, 25.5]));

  c.beginPath();
  c.arc(102, 115, 17.5, 0, Math.PI * 2);
  c.lineWidth = 8;
  c.stroke();

  const hood = new Path2D();
  hood.moveTo(63.5, 67);
  hood.lineTo(63.5, 62);
  hood.quadraticCurveTo(63.5, 54.5, 71, 54.5);
  hood.lineTo(84, 54.5);
  hood.quadraticCurveTo(91.5, 54.5, 91.5, 62);
  hood.lineTo(91.5, 67);
  c.lineWidth = 7;
  c.stroke(hood);

  c.shadowColor = 'rgba(0,0,0,0.28)';
  c.shadowOffsetY = 4;
  c.shadowBlur = 5;
  c.font = '900 31px Arial, Helvetica, sans-serif';
  c.textAlign = 'right';
  c.textBaseline = 'top';
  c.fillStyle = '#ffffff';
  c.fillText('\u2726', 176, 45);
  c.restore();
  c.restore();
  c.restore();

  /* the heart */
  const beat = loop(IG_BEAT, f.t, 1.25, 2.8);
  c.save();
  c.translate(IG_HEART[0] + 77.5, IG_HEART[1] + 77.5);
  c.rotate((beat[1] * Math.PI) / 180);
  c.scale(beat[0], beat[0]);
  c.translate(-(IG_HEART[0] + 77.5), -(IG_HEART[1] + 77.5));

  c.save();
  c.translate(IG_HEART[0] + 23.5, IG_HEART[1] + 28);
  c.scale(0.9, 0.9);
  const heart = new Path2D(HEART_BODY);
  cast(c, heart, 0, 6, 0, 'rgba(150,150,150,0.42)');
  cast(c, heart, 0, 10, 8, 'rgba(0,0,0,0.30)');
  const shine = c.createLinearGradient(18, 10, 113, 99);
  shine.addColorStop(0, '#ffffff');
  shine.addColorStop(0.58, '#f5f5f5');
  shine.addColorStop(1, '#d7d7d7');
  c.fillStyle = shine;
  c.fill(heart);
  c.lineJoin = 'round';
  c.lineWidth = 2.5;
  c.strokeStyle = 'rgba(255,255,255,0.78)';
  c.stroke(heart);
  c.save();
  c.globalAlpha *= 0.75;
  c.lineCap = 'round';
  c.lineWidth = 5;
  c.strokeStyle = 'rgba(255,255,255,0.72)';
  c.stroke(new Path2D(HEART_GLINT));
  c.restore();
  c.restore();

  miniHeart(c, [IG_HEART[0] + 116, IG_HEART[1] + 52, 0, 0], [0, 0, -45, 0.6], [18, -42, -36, 1.1], 1, 0.7, 0.91, f.t, 1.25);
  miniHeart(c, [IG_HEART[0] + 92, IG_HEART[1] + 23, 0, 0], [0, 0, -45, 0.5], [-10, -43, -55, 0.92], 0.95, 0.72, 0.92, f.t, 1.38);
  miniHeart(c, [IG_HEART[0] + 125, IG_HEART[1] + 8, 0, 0], [0, 0, -45, 0.45], [9, -35, -38, 0.78], 0.9, 0.74, 0.94, f.t, 1.5);
  c.restore();

  c.restore();
}

/* ------------------------------------------------------------- Subscribe */

const YT_BAR: Box = [100, 37.5, 850, 145];
const YT_PLAY: Box = [5, 17.5, 185, 185];
const YT_BELL: Box = [802, 30, 160, 160];

const YT_PULSE: Table = [[0, 1], [0.7, 1], [0.82, 1.1], [0.9, 0.97], [1, 1]];
const YT_SWING: Table = [
  [0, 0], [0.63, 0], [0.68, 13], [0.73, -13], [0.78, 10], [0.83, -8], [0.88, 4], [0.93, 0], [1, 0]
];
const YT_WAVE: Table = [
  [0, 0, 0.5], [0.63, 0, 0.5], [0.7, 1, 1], [0.84, 0.9, 1.25], [0.94, 0, 1.5], [1, 0, 0.5]
];

const BELL_BODY = 'M90 18 C65 18 51 37 51 66 L51 99 C51 112 45 124 34 134 C30 138 32 146 39 148 C72 156 108 156 141 148 C148 146 150 138 146 134 C135 124 129 112 129 99 L129 66 C129 37 115 18 90 18 Z';
const BELL_GLINT = 'M67 42 C61 52 59 65 59 79';

/** One of the two rings that flick out beside the bell when it rings. */
function bellWave(c: SpecialContext, x: number, y: number, left: boolean, t: number): void {
  if (t <= 1.3) return;
  const at = sample(YT_WAVE, ((t - 1.3) / 3) % 1);
  if (at[0] <= 0.002) return;

  c.save();
  c.globalAlpha *= at[0];
  c.translate(x + 15, y + 32.5);
  c.scale(at[1], at[1]);

  // The original is a bordered ellipse with three of its four sides made
  // transparent, which leaves one arc of the ring. An arc of the same ellipse,
  // stroked at the border's width, is the same picture.
  c.beginPath();
  c.ellipse(0, 0, 11, 28.5, 0, left ? Math.PI * 0.62 : -Math.PI * 0.38, left ? Math.PI * 1.38 : Math.PI * 0.38);
  c.lineWidth = 8;
  c.strokeStyle = '#ffffff';
  c.shadowColor = 'rgba(0,0,0,0.55)';
  c.shadowOffsetY = 3;
  c.shadowBlur = 2;
  c.stroke();
  c.restore();
}

function paintSubscribe(c: SpecialContext, f: SpecialFrame, write: SpecialText): void {
  const pose = ribbonPose(f, 0.65);
  if (pose.alpha <= 0.002) return;

  c.save();
  ribbonTransform(c, pose, 1050, 220);
  c.globalAlpha *= pose.alpha;

  /* the bar */
  const bar = rrect(YT_BAR[0], YT_BAR[1], YT_BAR[2], YT_BAR[3], 38);
  cast(c, bar, 0, 15, 22, 'rgba(0,0,0,0.35)');
  cast(c, bar, 0, 0, 15, 'rgba(255,0,0,0.4)');
  fill(c, bar, linear(c, 180, YT_BAR[0], YT_BAR[1], YT_BAR[2], YT_BAR[3], [
    [0, '#ff3838'], [0.23, '#fb1010'], [0.55, '#e60000'], [1, '#bd0000']
  ]));
  innerGlow(c, bar, YT_BAR, 0, 6, 7, 'rgba(255,255,255,0.55)');
  innerGlow(c, bar, YT_BAR, 0, -9, 15, 'rgba(100,0,0,0.45)');
  border(c, bar, 5, '#ff4141');

  c.save();
  c.clip(bar);
  c.globalAlpha *= 0.75;
  fill(
    c,
    oval(YT_BAR[0] + 30, YT_BAR[1] + 8, YT_BAR[2] - 60, 5),
    linear(c, 90, YT_BAR[0] + 30, 0, YT_BAR[2] - 60, 5, [
      [0, 'rgba(255,255,255,0)'], [0.5, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']
    ])
  );
  c.restore();

  ribbonShine(c, bar, YT_BAR, f.t, 1.3, 3.4, 120, 20, 0.45, 0.8, 0.6, 1.15);

  for (const [dy, blur, colour] of [
    [9, 6, 'rgba(0,0,0,0.55)'], [5, 0, '#a2a2a2'], [3, 0, '#d0d0d0']
  ] as readonly (readonly [number, number, string])[]) {
    c.save();
    c.shadowColor = colour;
    c.shadowOffsetY = dy;
    c.shadowBlur = blur;
    write(532.5, 110, 68, 655, 1);
    c.restore();
  }

  /* the play button */
  const pulse = loop(YT_PULSE, f.t, 1.2, 2.2);
  c.save();
  c.translate(YT_PLAY[0] + 92.5, YT_PLAY[1] + 92.5);
  c.scale(pulse[0], pulse[0]);
  c.translate(-(YT_PLAY[0] + 92.5), -(YT_PLAY[1] + 92.5));

  const button = rrect(YT_PLAY[0], YT_PLAY[1], 185, 185, 44);
  cast(c, button, 0, 14, 20, 'rgba(0,0,0,0.35)');
  cast(c, button, 0, 0, 15, 'rgba(255,0,0,0.5)');
  fill(c, button, linear(c, 145, YT_PLAY[0], YT_PLAY[1], 185, 185, [
    [0, '#ff3030'], [0.45, '#f00000'], [1, '#c00000']
  ]));
  innerGlow(c, button, YT_PLAY, 0, 8, 9, 'rgba(255,255,255,0.45)');
  innerGlow(c, button, YT_PLAY, 0, -8, 12, 'rgba(100,0,0,0.45)');
  border(c, button, 5, '#ff4a4a');

  c.save();
  c.filter = 'blur(2px)';
  c.translate(35 + 45, 39.5 + 11);
  c.rotate((-11 * Math.PI) / 180);
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.fill(oval(-45, -11, 90, 22));
  c.restore();

  const wedge = new Path2D();
  wedge.moveTo(71, 68);
  wedge.lineTo(136, 110);
  wedge.lineTo(71, 152);
  wedge.closePath();
  cast(c, wedge, 0, 4, 0, 'rgba(170,170,170,1)');
  cast(c, wedge, 0, 7, 5, 'rgba(0,0,0,0.5)');
  fill(c, wedge, '#f8f8f8');
  c.restore();

  /* the bell */
  const swing = loop(YT_SWING, f.t, 1.3, 3);
  c.save();
  c.translate(YT_BELL[0] + 80, YT_BELL[1] + 16);
  c.rotate((swing[0] * Math.PI) / 180);
  c.translate(-(YT_BELL[0] + 80), -(YT_BELL[1] + 16));

  bellWave(c, YT_BELL[0] - 1, YT_BELL[1] + 47.5, true, f.t);
  bellWave(c, YT_BELL[0] + 131, YT_BELL[1] + 47.5, false, f.t);

  c.save();
  c.translate(YT_BELL[0] + 7.5, YT_BELL[1] + 7.5);
  c.scale(145 / 180, 145 / 180);
  const bell = new Path2D(BELL_BODY);
  cast(c, bell, 0, 10, 7, 'rgba(0,0,0,0.4)');
  const metal = c.createLinearGradient(34, 18, 150, 156);
  metal.addColorStop(0, '#ffffff');
  metal.addColorStop(0.55, '#f4f4f4');
  metal.addColorStop(1, '#bdbdbd');
  c.fillStyle = metal;
  c.fill(bell);
  c.lineWidth = 4;
  c.strokeStyle = '#eeeeee';
  c.stroke(bell);

  c.save();
  c.globalAlpha *= 0.8;
  c.lineCap = 'round';
  c.lineWidth = 8;
  c.strokeStyle = '#ffffff';
  c.stroke(new Path2D(BELL_GLINT));
  c.restore();

  c.beginPath();
  c.arc(90, 151, 20, 0, Math.PI * 2);
  const clapper = c.createLinearGradient(70, 131, 70, 171);
  clapper.addColorStop(0, '#ff3030');
  clapper.addColorStop(1, '#c90000');
  c.fillStyle = clapper;
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = '#ff4545';
  c.stroke();
  c.restore();
  c.restore();

  c.restore();
}

/* -------------------------------------------------------- the news plate */

const NEWS_PLATE: Box = [130, 41, 640, 88];
const PLATE_CUT: readonly number[] = [0, 0, 96, 0, 100, 50, 96, 100, 0, 100];

const PLATE_IN: Table = [[0, -70, 0.08, 0], [1, 0, 1, 1]];
const PLATE_OUT: Table = [[0, 0, 1, 1], [0.65, 35, 0.18, 1], [1, 70, 0.04, 0]];

function paintNews(c: SpecialContext, f: SpecialFrame, write: SpecialText): void {
  const leaving = f.out >= 0;

  /* the hairline the plate is built on */
  const guide = leaving
    ? 1 - run(f.out, 0.5, 0.55, EASE)
    : run(f.t, 0.15, 0.8, EASE);
  if (guide > 0.002) {
    c.save();
    c.globalAlpha *= guide;
    c.translate(450, 85);
    c.scale(guide, 1);
    c.fillStyle = linear(c, 90, -380, 0, 760, 2, [
      [0, 'rgba(7,25,47,0)'], [0.333, 'rgba(7,25,47,0.10)'],
      [0.667, 'rgba(7,25,47,0.10)'], [1, 'rgba(7,25,47,0)']
    ]);
    c.fillRect(-380, -1, 760, 2);
    c.restore();
  }

  const at = leaving
    ? sample(PLATE_OUT, run(f.out, 0.28, 0.75, SOFT_LEAVE))
    : sample(PLATE_IN, run(f.t, 0.3, 0.85, SNAP_IN));
  if (at[2] <= 0.002) return;

  const [px, py, pw, ph] = NEWS_PLATE;
  c.save();
  c.globalAlpha *= at[2];
  // The plate stretches from its left edge on the way in and collapses toward
  // its right edge on the way out, which is what the two transform origins say.
  const pivot = leaving ? px + pw : px;
  c.translate(at[0], 0);
  c.translate(pivot, 0);
  c.scale(at[1], 1);
  c.translate(-pivot, 0);

  const plate = shape(px, py, pw, ph, PLATE_CUT);
  cast(c, plate, 0, 16, 30, 'rgba(0,0,0,0.18)');
  fill(c, plate, linear(c, 90, px, py, pw, ph, [
    [0, '#07192f'], [0.35, '#0b2c4e'], [0.65, '#0c365f'], [1, '#07192f']
  ]));

  c.save();
  c.clip(plate);

  /* the red block and its arrow */
  const red = leaving
    ? { shift: -1.15 * 100 * run(f.out, 0.18, 0.5, SOFT_LEAVE), alpha: 1 - run(f.out, 0.18, 0.5, SOFT_LEAVE) }
    : { shift: -100 * (1 - run(f.t, 0.95, 0.55, SNAP_OUT)), alpha: 1 };
  if (red.alpha > 0.002) {
    c.save();
    c.globalAlpha *= red.alpha;
    c.translate(red.shift, 0);
    const tip = new Path2D();
    tip.moveTo(px + 80, py);
    tip.lineTo(px + 110, py + ph / 2);
    tip.lineTo(px + 80, py + ph);
    tip.closePath();
    fill(c, tip, '#d4202f');
    c.fillStyle = linear(c, 135, px, py, 100, ph, [[0, '#e02534'], [1, '#c61223']]);
    c.fillRect(px, py, 100, ph);
    c.restore();
  }

  /* the blue wedge */
  const accent = leaving
    ? 1 - run(f.out, 0.12, 0.45, EASE)
    : run(f.t, 1.05, 0.55, EASE);
  if (accent > 0.002) {
    c.save();
    c.globalAlpha *= accent;
    c.translate(0, py + ph / 2);
    c.scale(1, accent);
    c.translate(0, -(py + ph / 2));
    const wedge = new Path2D();
    wedge.moveTo(px + 116, py + 8);
    wedge.lineTo(px + 132, py + 44);
    wedge.lineTo(px + 116, py + 80);
    wedge.closePath();
    fill(c, wedge, 'rgba(25,91,147,0.98)');
    c.shadowColor = 'rgba(0,0,0,0.18)';
    c.shadowOffsetX = -4;
    c.shadowBlur = 10;
    c.fillStyle = linear(c, 180, px + 58, py + 8, 58, 72, [
      [0, 'rgba(37,118,182,0.98)'], [1, 'rgba(22,83,134,0.98)']
    ]);
    c.fillRect(px + 58, py + 8, 58, 72);
    c.restore();
  }

  const ink = leaving
    ? 1 - run(f.out, 0, 0.35, EASE)
    : run(f.t, 1.28, 0.7, EASE);
  if (ink > 0.002) {
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.25)';
    c.shadowOffsetY = 2;
    c.shadowBlur = 8;
    write(505, 85, 29, 420, ink);
    c.restore();
  }

  if (!leaving && f.t > 1.55) {
    const p = EASE(clamp01((f.t - 1.55) / 1));
    if (p < 1) {
      c.save();
      c.clip(plate);
      c.translate(px - 180 + p * 940 + 60, py);
      c.transform(1, 0, Math.tan((-22 * Math.PI) / 180), 1, 0, 0);
      c.fillStyle = linear(c, 90, -60, 0, 120, ph, [
        [0, 'rgba(255,255,255,0)'], [0.5, 'rgba(255,255,255,0.10)'], [1, 'rgba(255,255,255,0)']
      ]);
      c.fillRect(-60, 0, 120, ph);
      c.restore();
    }
  }

  c.restore();
  c.restore();
}

/* ------------------------------------------------------- the torn paper */

const PAPER_W = 850;
const PAPER_H = 160;

const PAPER_CUT: readonly number[] = [
  0, 11, 2, 6, 5, 10, 8, 4, 12, 9, 16, 5, 20, 11, 25, 5, 29, 9, 34, 4, 39, 10, 44, 6,
  49, 11, 54, 4, 59, 9, 64, 5, 69, 11, 74, 4, 79, 9, 84, 6, 89, 11, 94, 5, 97, 9, 100, 6,
  99, 91, 96, 96, 92, 90, 88, 95, 84, 89, 79, 96, 74, 90, 69, 95, 64, 89, 59, 96, 54, 90,
  49, 95, 44, 89, 39, 96, 34, 90, 29, 95, 24, 88, 19, 96, 14, 90, 10, 95, 6, 89, 3, 95, 0, 90
];

const TORN_CUT: readonly number[] = [
  0, 58, 4, 34, 9, 61, 15, 39, 22, 70, 29, 37, 36, 65, 43, 35, 50, 67, 57, 39,
  64, 65, 71, 34, 78, 63, 85, 38, 92, 68, 100, 42, 100, 100, 0, 100
];

/** The profile of the tear, as the original lists it. */
const RASGO: readonly number[] = [
  0.0, -1.25, 0.85, -0.65, 1.30, -1.05, 0.60, -1.35, 1.05, -0.45, 1.20, -0.90,
  0.55, -1.15, 0.90, -0.60, 1.15, -0.35, 0.70
];

const easeInOutQuint = (t: number) =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;

/**
 * The ragged edge sweeping across the sheet, recomputed every frame exactly as
 * the original recomputes its `clip-path`: a fixed profile, a travelling
 * position, and a wobble whose strength rises and falls with a half sine so the
 * edge is straight at both ends and liveliest in the middle.
 */
function tornTo(progress: number): Path2D {
  const path = new Path2D();
  if (progress >= 0.999) {
    path.rect(0, 0, PAPER_W, PAPER_H);
    return path;
  }

  const p = clamp01(progress);
  const reach = 100 * p;
  const force = Math.sin(Math.PI * p);

  path.moveTo(0, 0);
  for (let i = 0; i < RASGO.length; i++) {
    const y = (i / (RASGO.length - 1)) * PAPER_H;
    const ripple = Math.sin(i * 1.91 + p * 11.5) * 0.22 * force;
    const x = clamp01((reach + (RASGO[i] + ripple) * force) / 100) * PAPER_W;
    path.lineTo(x, y);
  }
  path.lineTo(0, PAPER_H);
  path.closePath();
  return path;
}

let grain: CanvasPattern | null = null;
let grainTried = false;

/**
 * The paper's grain.
 *
 * The original reaches for an SVG `feTurbulence`, which a canvas cannot use, so
 * this is value noise smoothed once into a small tile and multiplied over the
 * surface. It is the one place where the picture is a stand-in rather than a
 * copy, and at this strength it reads the same: paper rather than card.
 */
function paperGrain(c: SpecialContext): CanvasPattern | null {
  if (grainTried) return grain;
  grainTried = true;

  const size = 128;
  let surface: HTMLCanvasElement | OffscreenCanvas | null = null;
  if (typeof OffscreenCanvas !== 'undefined') surface = new OffscreenCanvas(size, size);
  else if (typeof document !== 'undefined') {
    const el = document.createElement('canvas');
    el.width = size;
    el.height = size;
    surface = el;
  }
  if (!surface) return null;

  const ctx = surface.getContext('2d') as SpecialContext | null;
  if (!ctx) return null;

  const image = ctx.createImageData(size, size);
  let seed = 20260904;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < size * size; i++) {
    const v = 236 + Math.round(next() * 19);
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  grain = c.createPattern(surface as CanvasImageSource, 'repeat');
  return grain;
}

/** The two sets of fibres the surface is ruled with. */
function fibres(c: SpecialContext, angle: number, period: number, colour: string): void {
  c.save();
  c.rotate((-angle * Math.PI) / 180);
  c.fillStyle = colour;
  const reach = PAPER_W + PAPER_H;
  for (let y = -reach; y < reach; y += period) c.fillRect(-reach, y, reach * 2, 1);
  c.restore();
}

function paintPaper(c: SpecialContext, f: SpecialFrame, write: SpecialText): void {
  const leaving = f.out >= 0;
  const open = leaving
    ? 1 - easeInCubic(clamp01((f.out - 0.12) / 1.15))
    : easeInOutQuint(clamp01(f.t / 1.75));
  if (open <= 0.001) return;

  c.save();
  c.clip(shape(0, 0, PAPER_W, PAPER_H, PAPER_CUT));

  c.save();
  c.clip(tornTo(open));

  fill(c, rrect(0, 0, PAPER_W, PAPER_H, 0), linear(c, 135, 0, 0, PAPER_W, PAPER_H, [
    [0, '#fffefa'], [1, '#fbf7f1']
  ]));
  c.fillStyle = linear(c, 180, 0, 0, PAPER_W, PAPER_H, [
    [0, 'rgba(255,255,255,0.78)'], [0.34, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,0)']
  ]);
  c.fillRect(0, 0, PAPER_W, PAPER_H);

  const tile = paperGrain(c);
  if (tile) {
    c.save();
    c.globalCompositeOperation = 'multiply';
    c.globalAlpha *= 0.55;
    c.fillStyle = tile;
    c.fillRect(0, 0, PAPER_W, PAPER_H);
    c.restore();
  }

  c.save();
  c.globalCompositeOperation = 'multiply';
  c.globalAlpha *= 0.42;
  fibres(c, 7, 13, 'rgba(81,48,57,0.035)');
  fibres(c, 91, 31, 'rgba(255,255,255,0.19)');
  c.restore();

  // The sheet is meant to sit *in* the surface rather than on it, so the only
  // shading is inside it and only on two sides: a short one down the left and a
  // deeper one along the torn foot.
  c.fillStyle = linear(c, 90, 0, 0, PAPER_W, PAPER_H, [
    [0, 'rgba(72,24,45,0.34)'], [0.009, 'rgba(72,24,45,0.23)'], [0.02, 'rgba(72,24,45,0.12)'],
    [0.034, 'rgba(72,24,45,0.045)'], [0.054, 'rgba(72,24,45,0)'], [1, 'rgba(72,24,45,0)']
  ]);
  c.fillRect(0, 0, PAPER_W, PAPER_H);
  c.fillStyle = linear(c, 0, 0, 0, PAPER_W, PAPER_H, [
    [0, 'rgba(72,24,45,0.38)'], [0.024, 'rgba(72,24,45,0.27)'], [0.052, 'rgba(72,24,45,0.14)'],
    [0.082, 'rgba(72,24,45,0.055)'], [0.125, 'rgba(72,24,45,0)'], [1, 'rgba(72,24,45,0)']
  ]);
  c.fillRect(0, 0, PAPER_W, PAPER_H);

  c.save();
  c.globalAlpha *= 0.58;
  const foot = shape(PAPER_W * 0.012, PAPER_H - 20, PAPER_W * 0.976, 19, TORN_CUT);
  fill(c, foot, linear(c, 0, 0, PAPER_H - 20, PAPER_W, 19, [
    [0, 'rgba(72,24,45,0.30)'], [0.35, 'rgba(72,24,45,0.17)'],
    [0.62, 'rgba(72,24,45,0.065)'], [1, 'rgba(72,24,45,0)']
  ]));
  c.restore();
  c.restore();

  const ink = leaving
    ? 1 - run(f.out, 0, 0.3, EASE_IN)
    : (open > 0.78 ? run(f.t, 1.007, 0.68, GLIDE) : 0);
  if (ink > 0.002) {
    c.save();
    c.shadowColor = 'rgba(255,255,255,0.62)';
    c.shadowOffsetY = 1;
    c.shadowBlur = 0;
    write(PAPER_W / 2, PAPER_H / 2, 43, 720, ink);
    c.restore();
  }

  c.restore();
}

/* -------------------------------------------------------------- the list */

/** New QR ribbons share the social motion, without changing either social painter. */
function paintQrRibbon(c: SpecialContext, f: SpecialFrame, write: SpecialText): void {
  const photo = f.tag.shape === 'qr-photo';
  const barBox = photo ? IG_BAR : YT_BAR;
  const naturalWidth = photo ? 1080 : 1050;
  const naturalHeight = photo ? 230 : 220;
  // Exactly twice the primary social icon: 188 → 376, 185 → 370.
  const badgeSize = (photo ? IG_ICON[2] : YT_PLAY[2]) * 2;
  const badgeX = photo ? IG_ICON[0] : YT_PLAY[0];
  const badgeY = (naturalHeight - badgeSize) / 2;
  const pose = ribbonPose(f, photo ? 0.68 : 0.65);
  if (pose.alpha <= 0.002) return;

  c.save();
  ribbonTransform(c, pose, naturalWidth, naturalHeight);
  c.globalAlpha *= pose.alpha;
  const bar = rrect(...barBox, photo ? 40 : 38);
  const palette: readonly Stop[] = photo ? IG_BAR_STOPS : [[0, '#ff4141'], [0.5, '#ff0000'], [1, '#c90000']];
  cast(c, bar, 0, 16, 24, 'rgba(0,0,0,0.34)');
  fill(c, bar, linear(c, photo ? 120 : 180, ...barBox, palette));
  innerGlow(c, bar, barBox, 0, 7, 9, 'rgba(255,255,255,0.34)');
  innerGlow(c, bar, barBox, 0, -10, 16, 'rgba(70,0,40,0.30)');
  ribbonShine(c, bar, barBox, f.t, 1.3, 3.3, 125, 18, 0.44, 0.9, 0.62, 1.16);

  // Keep the caption on the unchanged ribbon, clear of the larger QR badge.
  const textLeft = badgeX + badgeSize + 28;
  const textRight = barBox[0] + barBox[2] - 30;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.45)';
  c.shadowOffsetY = 5;
  c.shadowBlur = 5;
  write((textLeft + textRight) / 2, naturalHeight / 2, photo ? 61 : 68, textRight - textLeft, 1);
  c.restore();

  const badge = rrect(badgeX, badgeY, badgeSize, badgeSize, 36);
  cast(c, badge, 0, 13, 20, 'rgba(0,0,0,0.30)');
  fill(c, badge, linear(c, 145, badgeX, badgeY, badgeSize, badgeSize, palette));
  border(c, badge, 4, 'rgba(255,255,255,0.50)');
  // Keep the QR still on the floating ribbon and free of shines or icon pulses.
  drawQrTagCode(c, f.tag.qrText ?? '', badgeX + 12, badgeY + 12, badgeSize - 24);
  c.restore();
}

/** Yellow and orange QR ribbons with a caption beside the QR square. */
function paintQrCommerceRibbon(c: SpecialContext, f: SpecialFrame, write: SpecialText): void {
  const orange = f.tag.shape === 'qr-shop-orange';
  const palette: readonly Stop[] = orange
    ? [[0, '#ff7a32'], [0.5, '#f65327'], [1, '#e83e1d']]
    : [[0, '#fff477'], [0.5, '#ffe62e'], [1, '#ffd21a']];
  const pose = ribbonPose(f, 0.68);
  if (pose.alpha <= 0.002) return;

  c.save();
  ribbonTransform(c, pose, 1080, 230);
  c.globalAlpha *= pose.alpha;
  const bar = rrect(...IG_BAR, 40);
  cast(c, bar, 0, 16, 24, 'rgba(0,0,0,0.30)');
  fill(c, bar, linear(c, 120, ...IG_BAR, palette));
  innerGlow(c, bar, IG_BAR, 0, 7, 9, 'rgba(255,255,255,0.40)');
  innerGlow(c, bar, IG_BAR, 0, -8, 12, orange ? 'rgba(120,24,0,0.24)' : 'rgba(135,87,0,0.16)');
  ribbonShine(c, bar, IG_BAR, f.t, 1.3, 3.3, 125, 18, 0.36, 0.8, 0.62, 1.16);

  c.save();
  c.shadowColor = orange ? 'rgba(100,28,0,0.30)' : 'rgba(255,255,255,0.45)';
  c.shadowOffsetY = 2;
  c.shadowBlur = 2;
  write(678.5, 115, 56, 533, 1);
  c.restore();

  // Same 376px QR badge and 870 × 150px ribbon as the gradient QR tag.
  const badge = rrect(8, -73, 376, 376, 36);
  cast(c, badge, 0, 13, 20, 'rgba(0,0,0,0.30)');
  fill(c, badge, linear(c, 145, 8, -73, 376, 376, palette));
  border(c, badge, 4, 'rgba(255,255,255,0.60)');
  drawQrTagCode(c, f.tag.qrText ?? '', 20, -61, 352);
  c.restore();
}

/**
 * Every special design's painter, keyed by the id the catalogue gives it.
 *
 * The renderer looks a tag's shape up here; a shape that is not a special is
 * simply absent, which is the same answer `specialShape` gives from the other
 * side of the wall.
 */
export const SPECIAL_PAINTERS: Readonly<Record<TagSpecial, SpecialPainter>> = {
  'bars-primary': LAYERED_PAINTERS['bars-primary'],
  'bars-pink': LAYERED_PAINTERS['bars-pink'],
  'bars-blue': LAYERED_PAINTERS['bars-blue'],
  'bars-amber': LAYERED_PAINTERS['bars-amber'],
  'bars-wine': LAYERED_PAINTERS['bars-wine'],
  'bars-curved': LAYERED_PAINTERS['bars-curved'],
  'square-pink': LAYERED_PAINTERS['square-pink'],
  'square-red': LAYERED_PAINTERS['square-red'],
  'round-pink': LAYERED_PAINTERS['round-pink'],
  'round-red': LAYERED_PAINTERS['round-red'],
  'petals-blob': paintBlobPetals,
  'petals-wind': paintWindPetals,
  'social-photo': paintInstagram,
  'social-subscribe': paintSubscribe,
  'qr-photo': paintQrRibbon,
  'qr-subscribe': paintQrRibbon,
  'qr-market-yellow': paintQrCommerceRibbon,
  'qr-shop-orange': paintQrCommerceRibbon,
  'news-plate': paintNews,
  'paper-tear': paintPaper
};

export function specialPainter(id: TagSpecial): SpecialPainter {
  return SPECIAL_PAINTERS[id];
}
