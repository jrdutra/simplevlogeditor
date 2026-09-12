/**
 * The animated tag a clip can wear, as data.
 *
 * A tag is a small label that arrives over the picture a moment after the clip
 * starts, sits somewhere in the frame, and either stays until the clip ends or
 * leaves on its own. It is the third thing that can be drawn over footage, after
 * the caption and the automatic zoom, and the only one with a life of its own on
 * the timeline: a caption belongs to the whole clip, a tag has a second it
 * appears at.
 *
 * Everything here is pure — names, catalogues, limits and clamps — because two
 * very different callers need it: the painter, which turns these values into
 * pixels sixty times a second, and the dialog, which turns them into controls.
 * Neither should own the list.
 *
 * ## Why the numbers are shares and not pixels
 *
 * The editor exports at whatever resolution the footage asks for and previews at
 * a fraction of it. Anything measured in pixels would be a different size in the
 * two, which is the one thing the compositor exists to prevent. So the type size
 * is a share of the frame height, the margin is a share of the frame, and every
 * remaining pixel-ish setting — the outline, the thickness of the 3D block, the
 * shadow — is a multiple of the type size, applied through `typeScale`. The
 * numbers a reader sees in the dialog are the ones they would have typed at a
 * 34-pixel type size, which is small enough to be familiar and large enough that
 * a step of one is a visible change.
 */

/** Type size the pixel-ish settings are quoted at. See the note above. */
export const REFERENCE_TYPE = 34;

/** Converts a setting quoted at {@link REFERENCE_TYPE} into this frame's pixels. */
export function typeScale(fontSize: number): number {
  return fontSize / REFERENCE_TYPE;
}

/* ------------------------------------------------------------------ shapes */

/** The shapes a reader builds a badge out of, as opposed to the finished ones. */
export type TagPlainShape =
  | 'pill'
  | 'rounded'
  | 'rect'
  | 'cut'
  | 'pricetag'
  | 'ribbon'
  | 'arrow'
  | 'hexagon'
  | 'bookmark'
  | 'ticket'
  | 'slant'
  | 'bubble'
  | 'circle';

export interface TagShapeDefinition {
  id: TagPlainShape;
  label: string;
}

export const TAG_SHAPES: readonly TagShapeDefinition[] = [
  { id: 'pill', label: 'Pill' },
  { id: 'rounded', label: 'Rounded corners' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'cut', label: 'Cut corners' },
  { id: 'pricetag', label: 'Price tag' },
  { id: 'ribbon', label: 'Ribbon' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'hexagon', label: 'Hexagon' },
  { id: 'bookmark', label: 'Bookmark' },
  { id: 'ticket', label: 'Ticket' },
  { id: 'slant', label: 'Parallelogram' },
  { id: 'bubble', label: 'Speech bubble' },
  { id: 'circle', label: 'Circle' }
];

/* ------------------------------------------------------------ special tags */

/**
 * The tags that are a whole design rather than a shape and a colour.
 *
 * Each of these arrived as a finished page of HTML: its own palette, its own
 * stack of layers, its own choreography. The reader picks one, writes the text,
 * chooses the type and says where it sits; everything else was decided when the
 * design was drawn, which is why picking one switches most of the dialog off.
 * There is nothing to configure because there was never a decision to make.
 *
 * What lives here is only what the dialog and the timeline need to know. The
 * painting is in `tag-renderer` by way of `tag-specials`, keyed by these ids.
 */
export type TagSpecial =
  | 'bars-primary'
  | 'bars-pink'
  | 'bars-blue'
  | 'bars-amber'
  | 'bars-wine'
  | 'bars-curved'
  | 'square-pink'
  | 'square-red'
  | 'round-pink'
  | 'round-red'
  | 'petals-blob'
  | 'petals-wind'
  | 'social-photo'
  | 'social-subscribe'
  | 'qr-photo'
  | 'qr-subscribe'
  | 'qr-market-yellow'
  | 'qr-shop-orange'
  | 'news-plate'
  | 'paper-tear';

export interface TagSpecialDefinition {
  id: TagSpecial;
  label: string;
  /** The heading the shape list files it under. */
  family: string;
  /** The resting bounds in the design's own pixels, which fix its proportion. */
  natural: { width: number; height: number };
  /** Extra space above and below the ribbon for an oversized QR badge. */
  verticalOverflow?: number;
  /** Share of the frame width those bounds take at Size 100 %. */
  fit: number;
  /** The colour the design writes in, and the type it was drawn with. */
  ink: string;
  weight: number;
  /** Letter spacing as a share of the type size, converted from the design's px. */
  tracking: number;
  /**
   * Seconds the designed entrance runs for, and the designed exit.
   *
   * Unlike an ordinary tag these are not the reader's to change: the layers
   * arrive in a sequence somebody timed, and stretching it would break the
   * sequence rather than slow it down. What stays theirs is the hold between
   * the two, which is the only part of the timing that is about the words.
   */
  enter: number;
  leave: number;
  /** When the letters are due, in seconds from the entrance's first frame. */
  textAt: number;
  /** The text animation the design itself used, and what picking it sets. */
  textAnim: TagTextAnim;
}

export const TAG_SPECIALS: readonly TagSpecialDefinition[] = [
  { id: 'bars-primary', label: 'Bars \u2014 primary colours', family: 'Layered', natural: { width: 870, height: 168 }, fit: 0.66, ink: '#ffffff', weight: 700, tracking: 1 / 44, enter: 2.57, leave: 1.13, textAt: 1.22, textAnim: 'letters' },
  { id: 'bars-pink', label: 'Bars \u2014 pink', family: 'Layered', natural: { width: 930, height: 228 }, fit: 0.7, ink: '#fff6fa', weight: 700, tracking: 1 / 44, enter: 2.57, leave: 1.13, textAt: 1.22, textAnim: 'letters' },
  { id: 'bars-blue', label: 'Bars \u2014 blue', family: 'Layered', natural: { width: 930, height: 228 }, fit: 0.7, ink: '#f4f8fb', weight: 700, tracking: 1 / 44, enter: 2.57, leave: 1.13, textAt: 1.22, textAnim: 'letters' },
  { id: 'bars-amber', label: 'Bars \u2014 amber', family: 'Layered', natural: { width: 930, height: 228 }, fit: 0.7, ink: '#fffaf0', weight: 700, tracking: 1 / 44, enter: 2.57, leave: 1.13, textAt: 1.22, textAnim: 'letters' },
  { id: 'bars-wine', label: 'Bars \u2014 wine', family: 'Layered', natural: { width: 930, height: 228 }, fit: 0.7, ink: '#fff7f7', weight: 700, tracking: 1 / 44, enter: 2.57, leave: 1.13, textAt: 1.22, textAnim: 'letters' },
  { id: 'bars-curved', label: 'Bars \u2014 pink, curved flight', family: 'Layered', natural: { width: 930, height: 228 }, fit: 0.7, ink: '#fff6fa', weight: 700, tracking: 1 / 44, enter: 2.57, leave: 1.28, textAt: 1.22, textAnim: 'letters' },
  { id: 'square-pink', label: 'Squares \u2014 pink', family: 'Layered', natural: { width: 360, height: 360 }, fit: 0.3, ink: '#fff6fa', weight: 700, tracking: 1 / 36, enter: 2.57, leave: 1.28, textAt: 1.22, textAnim: 'letters' },
  { id: 'square-red', label: 'Squares \u2014 red', family: 'Layered', natural: { width: 360, height: 360 }, fit: 0.3, ink: '#fff7f7', weight: 700, tracking: 1 / 36, enter: 2.57, leave: 1.28, textAt: 1.22, textAnim: 'letters' },
  { id: 'round-pink', label: 'Circles \u2014 pink', family: 'Layered', natural: { width: 360, height: 360 }, fit: 0.3, ink: '#fff8fc', weight: 700, tracking: 1 / 36, enter: 2.57, leave: 1.28, textAt: 1.22, textAnim: 'letters' },
  { id: 'round-red', label: 'Circles \u2014 red', family: 'Layered', natural: { width: 360, height: 360 }, fit: 0.3, ink: '#fff7f7', weight: 700, tracking: 1 / 36, enter: 2.57, leave: 1.28, textAt: 1.22, textAnim: 'letters' },
  { id: 'petals-blob', label: 'Petals \u2014 falling', family: 'Petals', natural: { width: 407, height: 291 }, fit: 0.32, ink: '#fff8fc', weight: 700, tracking: 1 / 36, enter: 3.06, leave: 1.76, textAt: 1.57, textAnim: 'letters' },
  { id: 'petals-wind', label: 'Petals \u2014 on the wind', family: 'Petals', natural: { width: 424, height: 303 }, fit: 0.33, ink: '#fff9fc', weight: 700, tracking: 0.8 / 36, enter: 3.25, leave: 1.85, textAt: 1.81, textAnim: 'fade' },
  { id: 'social-photo', label: 'Social \u2014 photo handle', family: 'Social', natural: { width: 1080, height: 230 }, fit: 0.7, ink: '#ffffff', weight: 800, tracking: -1.8 / 61, enter: 1.1, leave: 0.65, textAt: 0, textAnim: 'none' },
  { id: 'social-subscribe', label: 'Social \u2014 subscribe', family: 'Social', natural: { width: 1050, height: 220 }, fit: 0.35, ink: '#ffffff', weight: 900, tracking: -3 / 68, enter: 1.1, leave: 0.65, textAt: 0, textAnim: 'none' },
  { id: 'news-plate', label: 'Broadcast \u2014 lower third', family: 'Broadcast', natural: { width: 900, height: 170 }, fit: 0.8, ink: '#ffffff', weight: 500, tracking: 1.6 / 29, enter: 2.55, leave: 1.05, textAt: 1.28, textAnim: 'letters' },
  { id: 'paper-tear', label: 'Paper \u2014 torn open', family: 'Paper', natural: { width: 850, height: 160 }, fit: 0.58, ink: '#5a2140', weight: 700, tracking: 0.7 / 43, enter: 1.75, leave: 1.27, textAt: 1.007, textAnim: 'fade' },
  { id: 'qr-photo', label: 'QR Code — social gradient', family: 'QR Code', natural: { width: 1080, height: 230 }, verticalOverflow: 73, fit: 0.7, ink: '#ffffff', weight: 800, tracking: -1.8 / 61, enter: 1.1, leave: 0.65, textAt: 0, textAnim: 'none' },
  { id: 'qr-subscribe', label: 'QR Code — social red', family: 'QR Code', natural: { width: 1050, height: 220 }, verticalOverflow: 75, fit: 0.35, ink: '#ffffff', weight: 900, tracking: -3 / 68, enter: 1.1, leave: 0.65, textAt: 0, textAnim: 'none' },
  { id: 'qr-market-yellow', label: 'QR Code — yellow marketplace', family: 'QR Code', natural: { width: 1080, height: 230 }, verticalOverflow: 73, fit: 0.7, ink: '#25315a', weight: 700, tracking: -0.02, enter: 1.1, leave: 0.65, textAt: 0, textAnim: 'none' },
  { id: 'qr-shop-orange', label: 'QR Code — orange shopping', family: 'QR Code', natural: { width: 1080, height: 230 }, verticalOverflow: 73, fit: 0.7, ink: '#ffffff', weight: 700, tracking: -0.02, enter: 1.1, leave: 0.65, textAt: 0, textAnim: 'none' }
];

/** Anything a tag can be cut to: a shape somebody builds, or a finished design. */
export type TagShape = TagPlainShape | TagSpecial;

export function shapeIsQr(shape: TagShape): boolean {
  return shape === 'qr-photo' || shape === 'qr-subscribe' ||
    shape === 'qr-market-yellow' || shape === 'qr-shop-orange';
}

const SPECIAL_BY_ID = new Map(TAG_SPECIALS.map((item) => [item.id, item] as const));

/** The design behind a shape, or `null` when the shape is one of the plain ones. */
export function specialShape(shape: TagShape): TagSpecialDefinition | null {
  return SPECIAL_BY_ID.get(shape as TagSpecial) ?? null;
}

export function shapeIsSpecial(shape: TagShape): shape is TagSpecial {
  return SPECIAL_BY_ID.has(shape as TagSpecial);
}

/** The families, in order, for the groups the shape list is split into. */
export const TAG_SPECIAL_FAMILIES: readonly string[] =
  TAG_SPECIALS.reduce<string[]>((into, item) => {
    if (!into.includes(item.family)) into.push(item.family);
    return into;
  }, []);

export function specialsOf(family: string): readonly TagSpecialDefinition[] {
  return TAG_SPECIALS.filter((item) => item.family === family);
}

/* ---------------------------------------------------------------- finishes */

export type TagFinish =
  | 'flat'
  | 'bevel'
  | 'emboss'
  | 'deboss'
  | 'cylinder'
  | 'gloss'
  | 'glass'
  | 'metal'
  | 'neon'
  | 'sticker'
  | 'hollow'
  | 'hatched'
  | 'double';

export interface TagFinishDefinition {
  id: TagFinish;
  label: string;
  /**
   * True when the face lets the picture through.
   *
   * The cast shadow is a solid silhouette of the tag drawn behind it, which
   * would show through a face you can see past and read as a dark blob. These
   * two go without one.
   */
  seeThrough?: boolean;
}

export const TAG_FINISHES: readonly TagFinishDefinition[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'bevel', label: 'Bevel' },
  { id: 'emboss', label: 'Emboss' },
  { id: 'deboss', label: 'Deboss' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'gloss', label: 'Gloss' },
  { id: 'glass', label: 'Glass', seeThrough: true },
  { id: 'metal', label: 'Brushed metal' },
  { id: 'neon', label: 'Neon' },
  { id: 'sticker', label: 'Sticker' },
  { id: 'hollow', label: 'Hollow', seeThrough: true },
  { id: 'hatched', label: 'Hatched' },
  { id: 'double', label: 'Double border' }
];

export function finishIsSeeThrough(finish: TagFinish): boolean {
  return TAG_FINISHES.find((item) => item.id === finish)?.seeThrough === true;
}

/* -------------------------------------------------------------- animations */

export type TagAnim =
  | 'none'
  | 'fade'
  | 'rise'
  | 'slide'
  | 'zoom'
  | 'pop'
  | 'drop'
  | 'unroll'
  | 'unblur'
  | 'pulse'
  | 'float'
  | 'sway'
  | 'shake'
  | 'heartbeat'
  | 'swing'
  | 'shine'
  | 'sweep'
  | 'flip-x'
  | 'flip-y'
  | 'propeller'
  | 'corner'
  | 'cube'
  | 'coin'
  | 'spin'
  | 'gyro'
  | 'pendulum'
  | 'pushpull';

export type TagAnimGroup = 'Entrance' | 'Emphasis' | '3D';

export interface TagAnimDefinition {
  id: TagAnim;
  label: string;
  group: TagAnimGroup;
  /**
   * True when the animation never settles.
   *
   * These run for as long as the tag is on screen instead of finishing within
   * the entrance's seconds, so the painter drives them from the tag's own clock
   * rather than from the entrance's progress.
   */
  looping?: boolean;
}

export const TAG_ANIMS: readonly TagAnimDefinition[] = [
  { id: 'fade', label: 'Fade in', group: 'Entrance' },
  { id: 'rise', label: 'Rise', group: 'Entrance' },
  { id: 'slide', label: 'Slide in', group: 'Entrance' },
  { id: 'zoom', label: 'Zoom in', group: 'Entrance' },
  { id: 'pop', label: 'Pop', group: 'Entrance' },
  { id: 'drop', label: 'Drop and bounce', group: 'Entrance' },
  { id: 'unroll', label: 'Unroll', group: 'Entrance' },
  { id: 'unblur', label: 'Out of focus', group: 'Entrance' },

  { id: 'pulse', label: 'Pulse', group: 'Emphasis', looping: true },
  { id: 'float', label: 'Float', group: 'Emphasis', looping: true },
  { id: 'sway', label: 'Sway', group: 'Emphasis', looping: true },
  { id: 'shake', label: 'Shake', group: 'Emphasis', looping: true },
  { id: 'heartbeat', label: 'Heartbeat', group: 'Emphasis', looping: true },
  { id: 'swing', label: 'Swing from a hook', group: 'Emphasis', looping: true },
  { id: 'shine', label: 'Glow pulse', group: 'Emphasis', looping: true },
  { id: 'sweep', label: 'Light sweep', group: 'Emphasis', looping: true },

  { id: 'flip-x', label: 'Flip on X', group: '3D' },
  { id: 'flip-y', label: 'Flip on Y', group: '3D' },
  { id: 'propeller', label: 'Propeller', group: '3D' },
  { id: 'corner', label: 'Topple from a corner', group: '3D' },
  { id: 'cube', label: 'Cube face', group: '3D' },
  { id: 'coin', label: 'Coin spin', group: '3D' },
  { id: 'spin', label: 'Endless spin', group: '3D', looping: true },
  { id: 'gyro', label: 'Gyroscope', group: '3D', looping: true },
  { id: 'pendulum', label: '3D pendulum', group: '3D', looping: true },
  { id: 'pushpull', label: 'Push and pull', group: '3D', looping: true }
];

export function animIsLooping(anim: TagAnim): boolean {
  return TAG_ANIMS.find((item) => item.id === anim)?.looping === true;
}

export type TagExit =
  | 'none'
  | 'fade'
  | 'shrink'
  | 'blur'
  | 'rollup'
  | 'pop'
  | 'fall'
  | 'rise'
  | 'left'
  | 'right'
  | 'tumble'
  | 'flip-x'
  | 'flip-y'
  | 'propeller'
  | 'coin'
  | 'topple'
  | 'recede';

export type TagExitGroup = 'Simple' | 'Movement' | '3D';

export interface TagExitDefinition {
  id: TagExit;
  label: string;
  group: TagExitGroup;
}

export const TAG_EXITS: readonly TagExitDefinition[] = [
  { id: 'fade', label: 'Fade out', group: 'Simple' },
  { id: 'shrink', label: 'Shrink', group: 'Simple' },
  { id: 'blur', label: 'Blur away', group: 'Simple' },
  { id: 'rollup', label: 'Roll up', group: 'Simple' },
  { id: 'pop', label: 'Pop and vanish', group: 'Simple' },

  { id: 'fall', label: 'Fall', group: 'Movement' },
  { id: 'rise', label: 'Rise away', group: 'Movement' },
  { id: 'left', label: 'Exit left', group: 'Movement' },
  { id: 'right', label: 'Exit right', group: 'Movement' },
  { id: 'tumble', label: 'Tumble', group: 'Movement' },

  { id: 'flip-x', label: 'Flip on X', group: '3D' },
  { id: 'flip-y', label: 'Flip on Y', group: '3D' },
  { id: 'propeller', label: 'Propeller', group: '3D' },
  { id: 'coin', label: 'Coin spin', group: '3D' },
  { id: 'topple', label: 'Topple from a corner', group: '3D' },
  { id: 'recede', label: 'Sink away', group: '3D' }
];

export type TagTextAnim =
  | 'none'
  | 'fade'
  | 'letters'
  | 'slide'
  | 'grow'
  | 'cascade'
  | 'focus'
  | 'flip'
  | 'wave'
  | 'bounce'
  | 'typewriter'
  | 'reveal'
  | 'gradient'
  | 'neon'
  | 'glitch'
  | 'carved'
  | 'extruded';

export type TagTextAnimGroup = 'Letter by letter' | 'Whole line' | 'Relief';

export interface TagTextAnimDefinition {
  id: TagTextAnim;
  label: string;
  group: TagTextAnimGroup;
  /** True when the animation keeps moving instead of settling. */
  looping?: boolean;
  /** True when it paints the letters itself and the text colour stops mattering. */
  selfPainting?: boolean;
}

export const TAG_TEXT_ANIMS: readonly TagTextAnimDefinition[] = [
  { id: 'fade', label: 'Fade', group: 'Letter by letter' },
  { id: 'letters', label: 'Rise letter by letter', group: 'Letter by letter' },
  { id: 'slide', label: 'Slide letter by letter', group: 'Letter by letter' },
  { id: 'grow', label: 'Grow letter by letter', group: 'Letter by letter' },
  { id: 'cascade', label: 'Cascade', group: 'Letter by letter' },
  { id: 'focus', label: 'Into focus', group: 'Letter by letter' },
  { id: 'flip', label: 'Flip letter by letter', group: 'Letter by letter' },
  { id: 'wave', label: 'Wave', group: 'Letter by letter', looping: true },
  { id: 'bounce', label: 'Bounce', group: 'Letter by letter', looping: true },

  { id: 'typewriter', label: 'Typewriter', group: 'Whole line' },
  { id: 'reveal', label: 'Mask reveal', group: 'Whole line' },
  { id: 'gradient', label: 'Running gradient', group: 'Whole line', looping: true, selfPainting: true },
  { id: 'neon', label: 'Neon flicker', group: 'Whole line', looping: true },
  { id: 'glitch', label: 'Glitch', group: 'Whole line', looping: true },

  { id: 'carved', label: 'Carved text', group: 'Relief' },
  { id: 'extruded', label: 'Extruded text', group: 'Relief' }
];

export function textAnimIsSelfPainting(anim: TagTextAnim): boolean {
  return TAG_TEXT_ANIMS.find((item) => item.id === anim)?.selfPainting === true;
}

/* --------------------------------------------------------------- positions */

/**
 * The nine places a tag can sit, named the way the grid reads.
 *
 * A grid rather than two coordinates, because that is the decision people
 * actually make about an overlay: it goes in a corner, or along an edge, or in
 * the middle. Free placement would be more expressive and much harder to get
 * right at two resolutions, and nobody drags a badge to 37% of the width on
 * purpose.
 */
export type TagPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/** In reading order, which is also the order of the 3x3 grid in the dialog. */
export const TAG_POSITIONS: readonly TagPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
];

export const TAG_POSITION_LABELS: Readonly<Record<TagPosition, string>> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'middle-left': 'Middle left',
  center: 'Centre',
  'middle-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right'
};

/**
 * Where the tag's box is anchored, as shares of the frame, before the margin.
 *
 * Zero and one mean "against that edge" and a half means "centred on that axis";
 * the painter turns the pair into a point by moving the box in from whichever
 * edge it is against.
 */
export function positionAnchor(position: TagPosition): { x: number; y: number } {
  if (position === 'center') return { x: 0.5, y: 0.5 };
  const [row, column] = position.split('-');
  return {
    x: column === 'left' ? 0 : column === 'right' ? 1 : 0.5,
    y: row === 'top' ? 0 : row === 'bottom' ? 1 : 0.5
  };
}

/* ------------------------------------------------------------------- fonts */

export interface TagFontDefinition {
  id: string;
  label: string;
  stack: string;
}

/**
 * Stacks the browser already has.
 *
 * Same reasoning as the caption: a face fetched late would draw the first frames
 * in a fallback and the rest in the real thing, and in an export nobody is
 * watching that mistake is baked into the file.
 */
export const TAG_FONTS: readonly TagFontDefinition[] = [
  { id: 'sans', label: 'Sans', stack: '"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Mono', stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: 'condensed', label: 'Condensed', stack: '"Arial Narrow", "Helvetica Neue", Impact, sans-serif' }
];

export function tagFontStack(id: string): string {
  return (TAG_FONTS.find((font) => font.id === id) ?? TAG_FONTS[0]).stack;
}

/* ------------------------------------------------------------------ limits */

export interface TagLimit {
  min: number;
  max: number;
  step: number;
  default: number;
}

/**
 * Bounds for everything the dialog can move.
 *
 * A record of plain numbers rather than `as const`: the literal types the latter
 * produces would make every field holding one of these fail to compile the first
 * time it was set to anything else, which is the wrong kind of red. The
 * transition catalogue learnt that one the hard way.
 */
export const TAG_LIMITS: Readonly<Record<string, TagLimit>> = {
  /** When the tag arrives, in seconds from the start of the clip. */
  startSeconds: { min: 0, max: 3600, step: 0.1, default: 1 },
  /** How long it stays after arriving, before any exit. */
  holdSeconds: { min: 0, max: 600, step: 0.1, default: 2 },
  animSeconds: { min: 0.1, max: 6, step: 0.05, default: 0.7 },
  exitSeconds: { min: 0.1, max: 6, step: 0.05, default: 0.6 },
  stagger: { min: 0, max: 0.3, step: 0.005, default: 0.045 },
  /** Type size, as a share of the frame height. */
  fontScale: { min: 0.02, max: 0.16, step: 0.002, default: 0.055 },
  /** Gap kept from the frame edges, as a share of the frame's shorter side. */
  margin: { min: 0, max: 0.3, step: 0.005, default: 0.05 },
  tracking: { min: -0.06, max: 0.3, step: 0.005, default: 0.01 },
  /**
   * Where the text sits inside the tag, as a percentage of the tag's own
   * width and height away from dead centre. Zero is centred, which is what a
   * tag looks like everywhere else in this catalogue; the range stops at half
   * the box because past that the letters have left the shape behind.
   */
  textX: { min: -50, max: 50, step: 1, default: 0 },
  textY: { min: -50, max: 50, step: 1, default: 0 },
  /**
   * How large a special tag is drawn, as a percentage of its designed size.
   *
   * The finished designs have a proportion of their own, so there is nothing
   * to set width and height separately for: one number scales the whole piece
   * and the picture stays the picture. It does nothing to the plain shapes,
   * which take their size from their text.
   */
  scale: { min: 25, max: 250, step: 5, default: 100 },
  padX: { min: 6, max: 76, step: 1, default: 26 },
  padY: { min: 3, max: 52, step: 1, default: 13 },
  depth: { min: 0, max: 30, step: 1, default: 0 },
  lightAngle: { min: 0, max: 359, step: 1, default: 45 },
  darken: { min: 0, max: 100, step: 1, default: 55 },
  sheen: { min: 0, max: 200, step: 5, default: 100 },
  ring: { min: 0, max: 12, step: 1, default: 0 },
  strokeIn: { min: 0, max: 14, step: 1, default: 0 },
  shadow: { min: 0, max: 46, step: 1, default: 10 },
  tiltX: { min: -70, max: 70, step: 1, default: 0 },
  tiltY: { min: -70, max: 70, step: 1, default: 0 },
  weight: { min: 400, max: 900, step: 100, default: 600 }
};

/**
 * Reading time at eleven characters a second, with a floor.
 *
 * The same rate the text card uses, and for the same reason: a tag is on screen
 * to be read, and how long that takes depends entirely on how much there is.
 * The floor exists because below about a second nobody gets through even one
 * short word, however short it is.
 */
export function holdFromText(text: string): number {
  return Math.max(1.2, Math.round((text.length / 11 + 0.6) * 10) / 10);
}

function clampNumber(value: number, limit: TagLimit): number {
  if (!Number.isFinite(value)) return limit.default;
  return Math.min(limit.max, Math.max(limit.min, value));
}

/** Clamps one numeric field by name, falling back to its default. */
export function clampTagNumber(key: string, value: number): number {
  const limit = TAG_LIMITS[key];
  return limit ? clampNumber(value, limit) : value;
}

const HEX = /^#[0-9a-f]{6}$/i;

function colourOr(value: string, fallback: string): string {
  return typeof value === 'string' && HEX.test(value) ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/* ------------------------------------------------------------------- shape */

/** Everything a tag is, on one clip. */
export interface ClipTag {
  text: string;
  /** QR payload, independent of the visible ribbon text. Absent on older tags. */
  qrText?: string;
  /** When it arrives, in seconds from the start of the clip's own footage. */
  startSeconds: number;
  position: TagPosition;

  shape: TagShape;
  finish: TagFinish;
  /** Size of a special tag, in per cent of its design. Unused by the rest. */
  scale: number;

  anim: TagAnim;
  animSeconds: number;
  exit: TagExit;
  exitSeconds: number;
  /** Seconds between arriving and leaving. Ignored when there is no exit. */
  holdSeconds: number;
  /**
   * Whether the hold follows the length of the text.
   *
   * On by default and switched off for good the moment somebody types in the
   * field, exactly like the text card's. A number that quietly rewrites itself
   * is worse than one that needs adjusting.
   */
  holdAuto: boolean;

  textAnim: TagTextAnim;
  stagger: number;

  fontId: string;
  fontScale: number;
  weight: number;
  tracking: number;
  caps: boolean;
  padX: number;
  padY: number;
  margin: number;

  /** The text's offset from the middle of the tag, in per cent of the box. */
  textX: number;
  textY: number;

  color: string;
  textColor: string;
  outlineColor: string;
  ring: number;
  strokeIn: number;
  shadow: number;

  depth: number;
  lightAngle: number;
  darken: number;
  /**
   * The colour of the light the finishes paint with.
   *
   * Every finish that reads as raised or curved does it by laying light and
   * shade over the tag's own colour, and that light was white and fixed — a
   * sheen on the badge that nobody could reach. It is a setting now, because a
   * warm tag lit by pure white looks lit by a different lamp than the rest of
   * the shot, and that is exactly the kind of thing somebody notices without
   * being able to name.
   */
  sheenColor: string;
  /** How strong that light is, as a percentage. Zero puts the finish out. */
  sheen: number;
  tiltX: number;
  tiltY: number;
}

/**
 * What a tag starts as.
 *
 * Red on white, because a tag is an attention mark: it exists to be the one
 * thing in the frame that is not the footage, and the first thing a reader sees
 * should already look like that rather than like a colour they have to fix. It
 * starts flat on the timeline too — thickness at zero — since a bevel already
 * reads as raised and the 3D block is something to reach for, not to arrive in.
 */
export const DEFAULT_TAG: ClipTag = {
  text: '',
  startSeconds: TAG_LIMITS['startSeconds'].default,
  position: 'bottom-left',

  shape: 'pill',
  finish: 'bevel',
  scale: TAG_LIMITS['scale'].default,

  anim: 'pop',
  animSeconds: TAG_LIMITS['animSeconds'].default,
  exit: 'none',
  exitSeconds: TAG_LIMITS['exitSeconds'].default,
  holdSeconds: TAG_LIMITS['holdSeconds'].default,
  holdAuto: true,

  textAnim: 'letters',
  stagger: TAG_LIMITS['stagger'].default,

  fontId: 'sans',
  fontScale: TAG_LIMITS['fontScale'].default,
  weight: TAG_LIMITS['weight'].default,
  tracking: TAG_LIMITS['tracking'].default,
  caps: false,
  padX: TAG_LIMITS['padX'].default,
  padY: TAG_LIMITS['padY'].default,
  margin: TAG_LIMITS['margin'].default,
  textX: TAG_LIMITS['textX'].default,
  textY: TAG_LIMITS['textY'].default,

  color: '#d32f2f',
  textColor: '#ffffff',
  outlineColor: '#101418',
  ring: TAG_LIMITS['ring'].default,
  strokeIn: TAG_LIMITS['strokeIn'].default,
  shadow: TAG_LIMITS['shadow'].default,

  depth: TAG_LIMITS['depth'].default,
  lightAngle: TAG_LIMITS['lightAngle'].default,
  darken: TAG_LIMITS['darken'].default,
  sheenColor: '#ffffff',
  sheen: TAG_LIMITS['sheen'].default,
  tiltX: TAG_LIMITS['tiltX'].default,
  tiltY: TAG_LIMITS['tiltY'].default
};

const SHAPE_IDS: readonly TagPlainShape[] = TAG_SHAPES.map((item) => item.id);
const ALL_SHAPE_IDS: readonly TagShape[] = [...SHAPE_IDS, ...TAG_SPECIALS.map((item) => item.id)];
const FINISH_IDS: readonly TagFinish[] = TAG_FINISHES.map((item) => item.id);
const ANIM_IDS: readonly TagAnim[] = ['none', ...TAG_ANIMS.map((item) => item.id)];
const EXIT_IDS: readonly TagExit[] = ['none', ...TAG_EXITS.map((item) => item.id)];
const TEXT_ANIM_IDS: readonly TagTextAnim[] = ['none', ...TAG_TEXT_ANIMS.map((item) => item.id)];

/**
 * A tag with every field inside what can be drawn.
 *
 * Applied on the way in from storage and on the way out of the dialog, because
 * both are places where a value the painter cannot use could arrive: a document
 * written by an older build, a field somebody emptied, an animation this build
 * no longer has.
 */
export function clampTag(tag: ClipTag): ClipTag {
  return {
    text: typeof tag.text === 'string' ? tag.text.slice(0, 120) : '',
    ...(typeof tag.qrText === 'string' ? { qrText: tag.qrText } : {}),
    startSeconds: clampTagNumber('startSeconds', tag.startSeconds),
    position: oneOf(tag.position, TAG_POSITIONS, DEFAULT_TAG.position),

    shape: oneOf(tag.shape, ALL_SHAPE_IDS, DEFAULT_TAG.shape),
    finish: oneOf(tag.finish, FINISH_IDS, DEFAULT_TAG.finish),
    scale: clampTagNumber('scale', tag.scale),

    anim: oneOf(tag.anim, ANIM_IDS, DEFAULT_TAG.anim),
    animSeconds: clampTagNumber('animSeconds', tag.animSeconds),
    exit: oneOf(tag.exit, EXIT_IDS, DEFAULT_TAG.exit),
    exitSeconds: clampTagNumber('exitSeconds', tag.exitSeconds),
    holdSeconds: clampTagNumber('holdSeconds', tag.holdSeconds),
    holdAuto: tag.holdAuto !== false,

    textAnim: oneOf(tag.textAnim, TEXT_ANIM_IDS, DEFAULT_TAG.textAnim),
    stagger: clampTagNumber('stagger', tag.stagger),

    fontId: TAG_FONTS.some((font) => font.id === tag.fontId) ? tag.fontId : DEFAULT_TAG.fontId,
    fontScale: clampTagNumber('fontScale', tag.fontScale),
    weight: clampTagNumber('weight', tag.weight),
    tracking: clampTagNumber('tracking', tag.tracking),
    caps: tag.caps === true,
    padX: clampTagNumber('padX', tag.padX),
    padY: clampTagNumber('padY', tag.padY),
    margin: clampTagNumber('margin', tag.margin),
    textX: clampTagNumber('textX', tag.textX),
    textY: clampTagNumber('textY', tag.textY),

    color: colourOr(tag.color, DEFAULT_TAG.color),
    textColor: colourOr(tag.textColor, DEFAULT_TAG.textColor),
    outlineColor: colourOr(tag.outlineColor, DEFAULT_TAG.outlineColor),
    ring: clampTagNumber('ring', tag.ring),
    strokeIn: clampTagNumber('strokeIn', tag.strokeIn),
    shadow: clampTagNumber('shadow', tag.shadow),

    depth: clampTagNumber('depth', tag.depth),
    lightAngle: clampTagNumber('lightAngle', tag.lightAngle),
    darken: clampTagNumber('darken', tag.darken),
    sheenColor: colourOr(tag.sheenColor, DEFAULT_TAG.sheenColor),
    sheen: clampTagNumber('sheen', tag.sheen),
    tiltX: clampTagNumber('tiltX', tag.tiltX),
    tiltY: clampTagNumber('tiltY', tag.tiltY)
  };
}

/** The seconds the tag is readable, whether that was typed or worked out. */
export function tagHold(tag: ClipTag): number {
  const automatic = holdFromText(tag.text);
  const subscribe = tag.shape === 'social-subscribe' || tag.shape === 'qr-subscribe';
  return tag.holdAuto ? (subscribe ? automatic * 5 : automatic) : tag.holdSeconds;
}

/**
 * How long the tag is on screen after it arrives, in seconds.
 *
 * Without an exit the answer is "until the clip ends", which only the caller
 * knows — so this returns `Infinity` and the planner clamps it to what is left
 * of the clip. With an exit it is the entrance plus the hold plus the exit: the
 * hold is the time the tag is *readable*, and starting to count it while the
 * letters were still arriving would make the number a lie.
 */
export function tagLifetime(tag: ClipTag): number {
  // A special tag is a piece of choreography with a beginning and an end, so it
  // always has both; there is no "stays until the clip ends" for a design whose
  // last second is part of the design.
  const design = specialShape(tag.shape);
  if (design) return design.enter + tagHold(tag) + design.leave;

  if (tag.exit === 'none') return Number.POSITIVE_INFINITY;
  return tag.animSeconds + tagHold(tag) + tag.exitSeconds;
}

/** True when the tag has nothing worth drawing. */
export function tagIsEmpty(tag: ClipTag | null | undefined): boolean {
  return !tag || tag.text.trim() === '';
}
