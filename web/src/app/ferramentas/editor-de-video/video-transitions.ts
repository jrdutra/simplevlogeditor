/**
 * The animations that carry one shot into the next.
 *
 * Everything here is a pure function of two pictures and a number between zero
 * and one. That is the whole design: the encoder asks for frame 14 of 21 and
 * the preview asks for whatever instant the playhead is at, and because neither
 * of them can tell the painter anything about itself, the transition the reader
 * chose in the dialog is bit-for-bit the transition that lands in the file.
 *
 * The drawn transitions — the ones that look like a brush loaded with paint
 * going across the screen — work in two halves, because that is what the effect
 * actually is. First the paint covers the outgoing shot; then the paint is
 * lifted, and what is underneath is the incoming one. Nothing dissolves. It is
 * the difference between a transition that looks like an effect and one that
 * looks like someone did it by hand, and it costs one extra mask.
 *
 * Every drawn shape is one colour, by rule. Texture comes from bristles and
 * from the ragged edge of a loaded brush, never from a second hue — a two-tone
 * "ink" stroke stops reading as ink and starts reading as a gradient.
 */

import { drawZoomed } from '../../shared/media/auto-zoom';
import { FrameContext, FrameSource, canvasOfSize, sizeCanvas } from './frame-source';

/** Every animation on offer, in the order the dialog lists them. */
export type TransitionKind =
  | 'dissolve'
  | 'fade-through-black'
  | 'fade-through-colour'
  | 'zoom-in'
  | 'zoom-out'
  | 'blur'
  | 'blur-dissolve'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'push-left'
  | 'push-up'
  | 'wipe-left'
  | 'wipe-up'
  | 'clock-wipe'
  | 'iris'
  | 'whip-pan'
  | 'ink-brush-down'
  | 'ink-sweep-across'
  | 'ink-scribble'
  | 'ink-spiral'
  | 'ink-blot'
  | 'ink-cross'
  | 'ink-reveal-brush';

/** How the dialog groups the list, so twenty-five names stay findable. */
export type TransitionGroup = 'Dissolves' | 'Camera' | 'Movement' | 'Shapes' | 'Drawn';

export interface TransitionDefinition {
  id: TransitionKind;
  label: string;
  description: string;
  group: TransitionGroup;
  /** True when the reader's colour is actually used, so the picker can hide. */
  usesColour: boolean;
}

export const TRANSITIONS: readonly TransitionDefinition[] = [
  {
    id: 'dissolve',
    label: 'Dissolve',
    description: 'The first shot fades away as the second fades up through it.',
    group: 'Dissolves',
    usesColour: false
  },
  {
    id: 'fade-through-black',
    label: 'Fade through black',
    description: 'Down to black, then up again. The one that reads as time passing.',
    group: 'Dissolves',
    usesColour: false
  },
  {
    id: 'fade-through-colour',
    label: 'Fade through a colour',
    description: 'As above, but through the colour you choose instead of black.',
    group: 'Dissolves',
    usesColour: true
  },
  {
    id: 'blur-dissolve',
    label: 'Blur dissolve',
    description: 'Both shots go soft at the moment they cross. Hides a mismatched cut.',
    group: 'Dissolves',
    usesColour: false
  },
  {
    id: 'zoom-in',
    label: 'Zoom in',
    description: 'The new shot arrives large and settles back into frame.',
    group: 'Camera',
    usesColour: false
  },
  {
    id: 'zoom-out',
    label: 'Zoom out',
    description: 'The old shot pushes in and away; the new one opens out behind it.',
    group: 'Camera',
    usesColour: false
  },
  {
    id: 'blur',
    label: 'Defocus',
    description: 'Pull focus off the first shot and onto the second.',
    group: 'Camera',
    usesColour: false
  },
  {
    id: 'whip-pan',
    label: 'Whip pan',
    description: 'A fast smeared swing, as though the camera turned to look.',
    group: 'Camera',
    usesColour: false
  },
  {
    id: 'slide-left',
    label: 'Slide in from the right',
    description: 'The new shot slides across on top of the old one.',
    group: 'Movement',
    usesColour: false
  },
  {
    id: 'slide-right',
    label: 'Slide in from the left',
    description: 'The same, the other way round.',
    group: 'Movement',
    usesColour: false
  },
  {
    id: 'slide-up',
    label: 'Slide up from below',
    description: 'The new shot rises over the old one.',
    group: 'Movement',
    usesColour: false
  },
  {
    id: 'slide-down',
    label: 'Slide down from above',
    description: 'The new shot drops over the old one.',
    group: 'Movement',
    usesColour: false
  },
  {
    id: 'push-left',
    label: 'Push sideways',
    description: 'The new shot shoves the old one off the screen rather than covering it.',
    group: 'Movement',
    usesColour: false
  },
  {
    id: 'push-up',
    label: 'Push upwards',
    description: 'The same shove, vertically.',
    group: 'Movement',
    usesColour: false
  },
  {
    id: 'wipe-left',
    label: 'Wipe across',
    description: 'A hard edge travels across, with the new shot already behind it.',
    group: 'Shapes',
    usesColour: false
  },
  {
    id: 'wipe-up',
    label: 'Wipe upwards',
    description: 'The same edge, travelling up the frame.',
    group: 'Shapes',
    usesColour: false
  },
  {
    id: 'clock-wipe',
    label: 'Clock wipe',
    description: 'A hand sweeps round from twelve, uncovering the new shot as it goes.',
    group: 'Shapes',
    usesColour: false
  },
  {
    id: 'iris',
    label: 'Iris',
    description: 'A circle opens from the middle of the frame.',
    group: 'Shapes',
    usesColour: false
  },
  {
    id: 'ink-brush-down',
    label: 'Brush stroke, downwards',
    description: 'A loaded brush paints down the frame, covering the first shot; then it lifts, and the second is underneath.',
    group: 'Drawn',
    usesColour: true
  },
  {
    id: 'ink-sweep-across',
    label: 'Brush stroke, across',
    description: 'The same brush, travelling sideways.',
    group: 'Drawn',
    usesColour: true
  },
  {
    id: 'ink-scribble',
    label: 'Scribble',
    description: 'Scribbled out from top to bottom, then scribbled away again.',
    group: 'Drawn',
    usesColour: true
  },
  {
    id: 'ink-spiral',
    label: 'Spiral',
    description: 'Painted over in a spiral from the centre, then unwound.',
    group: 'Drawn',
    usesColour: true
  },
  {
    id: 'ink-blot',
    label: 'Ink blot',
    description: 'A blot spreads until it fills the frame, then drains away.',
    group: 'Drawn',
    usesColour: true
  },
  {
    id: 'ink-cross',
    label: 'Crossed out',
    description: 'Struck through corner to corner, filled in, then wiped clean.',
    group: 'Drawn',
    usesColour: true
  },
  {
    id: 'ink-reveal-brush',
    label: 'Painted in',
    description: 'The new shot is painted straight onto the old one, inside the brush stroke.',
    group: 'Drawn',
    usesColour: false
  }
];

/** The groups, in order, each with the transitions that belong to it. */
export const TRANSITION_GROUPS: readonly { group: TransitionGroup; items: readonly TransitionDefinition[] }[] = (
  ['Dissolves', 'Camera', 'Movement', 'Shapes', 'Drawn'] as const
).map((group) => ({ group, items: TRANSITIONS.filter((item) => item.group === group) }));

export const DEFAULT_TRANSITION_KIND: TransitionKind = 'dissolve';

/**
 * Ink black rather than a brand colour.
 *
 * A bright stroke over footage reads as a mistake until the reader has decided
 * they want it; near-black is the one choice that looks deliberate over any
 * picture, and the colour well is right there for anyone who disagrees.
 */
export const DEFAULT_TRANSITION_COLOUR = '#0b0f1a';

/**
 * Seconds a transition may last. The default is about a beat.
 *
 * Plain numbers rather than `as const`: the literal types the latter produces
 * would make every field that holds one of these fail to compile the first time
 * it was set to anything else, which is the wrong kind of red.
 */
export const TRANSITION_SECONDS: { default: number; min: number; max: number; step: number } = {
  default: 0.7,
  min: 0.15,
  max: 4,
  step: 0.05
};

/** True when this animation actually paints with the reader's colour. */
export function usesColour(kind: TransitionKind): boolean {
  return TRANSITIONS.find((item) => item.id === kind)?.usesColour ?? false;
}

/** The catalogue entry, or the dissolve when a stored project names one we lost. */
export function transitionDefinition(kind: TransitionKind): TransitionDefinition {
  return TRANSITIONS.find((item) => item.id === kind) ?? TRANSITIONS[0];
}

/** Everything one frame of a transition needs to know. */
export interface TransitionFrame {
  /** The shot being left. Null draws black, which is what an edge transition wants. */
  outgoing: FrameSource | null;
  /** The shot being arrived at. */
  incoming: FrameSource | null;
  width: number;
  height: number;
  /** Zero at the first frame of the transition, one at the last. */
  progress: number;
  colour: string;
  /**
   * True when the shots are cropped to cover the frame rather than boxed inside it.
   *
   * A reframed project has to reframe here too. A dissolve where both shots sit
   * as small stamps inside black bars, between two clips that fill the screen,
   * would read as the transition being broken rather than as a choice.
   */
  fill?: boolean;
}

/**
 * Draws transitions, holding on to the scratch canvases they need.
 *
 * An object rather than a free function because masking needs two spare canvases
 * of the frame's size, and allocating those per frame would cost more than every
 * transition in this file put together. Each owner — the encoder, the preview,
 * the dialog — keeps its own, so nothing is shared across threads of work that
 * can run at the same time.
 */
export class TransitionPainter {
  private mask: OffscreenCanvas | HTMLCanvasElement | null = null;
  private maskContext: FrameContext | null = null;
  private layer: OffscreenCanvas | HTMLCanvasElement | null = null;
  private layerContext: FrameContext | null = null;

  /**
   * Paints one instant of a transition over the whole frame.
   *
   * The context is left with its transform reset and its alpha at one, because
   * the caller draws captions and fades over the top of this and would otherwise
   * inherit whatever the last stroke happened to leave behind.
   */
  draw(context: FrameContext, kind: TransitionKind, frame: TransitionFrame): void {
    const progress = clamp01(frame.progress);
    const spec = { ...frame, progress };

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.filter = 'none';

    switch (kind) {
      case 'dissolve':
        this.dissolve(context, spec);
        break;
      case 'fade-through-black':
        this.throughColour(context, spec, '#000000');
        break;
      case 'fade-through-colour':
        this.throughColour(context, spec, spec.colour);
        break;
      case 'blur-dissolve':
        this.blurDissolve(context, spec);
        break;
      case 'zoom-in':
        this.zoomIn(context, spec);
        break;
      case 'zoom-out':
        this.zoomOut(context, spec);
        break;
      case 'blur':
        this.defocus(context, spec);
        break;
      case 'whip-pan':
        this.whipPan(context, spec);
        break;
      case 'slide-left':
        this.slide(context, spec, -1, 0, false);
        break;
      case 'slide-right':
        this.slide(context, spec, 1, 0, false);
        break;
      case 'slide-up':
        this.slide(context, spec, 0, -1, false);
        break;
      case 'slide-down':
        this.slide(context, spec, 0, 1, false);
        break;
      case 'push-left':
        this.slide(context, spec, -1, 0, true);
        break;
      case 'push-up':
        this.slide(context, spec, 0, -1, true);
        break;
      case 'wipe-left':
        this.wipe(context, spec, 'horizontal');
        break;
      case 'wipe-up':
        this.wipe(context, spec, 'vertical');
        break;
      case 'clock-wipe':
        this.clockWipe(context, spec);
        break;
      case 'iris':
        this.iris(context, spec);
        break;
      case 'ink-reveal-brush':
        this.paintedIn(context, spec);
        break;
      default:
        this.painted(context, spec, kind);
        break;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.filter = 'none';
  }

  // ------------------------------------------------------------ dissolves --

  private dissolve(context: FrameContext, frame: TransitionFrame): void {
    this.paint(context, frame.outgoing, frame);
    context.globalAlpha = ease(frame.progress);
    this.paint(context, frame.incoming, frame);
    context.globalAlpha = 1;
  }

  /**
   * Down to a flat colour and back up, with a moment of the colour alone.
   *
   * The hold in the middle is the whole point of this one rather than a
   * dissolve: without it the two shots are still briefly on screen together,
   * and "time passed" turns back into "these two things are related".
   */
  private throughColour(context: FrameContext, frame: TransitionFrame, colour: string): void {
    const half = frame.progress < 0.5;
    this.paint(context, half ? frame.outgoing : frame.incoming, frame);

    const distance = Math.abs(frame.progress - 0.5) * 2;
    context.globalAlpha = clamp01(1 - ease(distance));
    context.fillStyle = colour;
    context.fillRect(0, 0, frame.width, frame.height);
    context.globalAlpha = 1;
  }

  private blurDissolve(context: FrameContext, frame: TransitionFrame): void {
    // Strongest where the two shots cross, so the softness reads as the reason
    // one became the other rather than as an effect laid over the top.
    const strength = Math.sin(Math.PI * frame.progress) * frame.height * 0.03;

    context.filter = blurFilter(strength);
    this.paint(context, frame.outgoing, frame);
    context.globalAlpha = ease(frame.progress);
    this.paint(context, frame.incoming, frame);
    context.globalAlpha = 1;
    context.filter = 'none';
  }

  // --------------------------------------------------------------- camera --

  private zoomIn(context: FrameContext, frame: TransitionFrame): void {
    const t = ease(frame.progress);
    this.paint(context, frame.outgoing, frame);

    // Arrives at a third larger than frame and settles back, which is the size
    // that reads as movement without the edges of the picture ever showing.
    context.globalAlpha = t;
    this.paint(context, frame.incoming, frame, 1.35 - 0.35 * t);
    context.globalAlpha = 1;
  }

  private zoomOut(context: FrameContext, frame: TransitionFrame): void {
    const t = ease(frame.progress);
    this.paint(context, frame.incoming, frame);

    context.globalAlpha = 1 - t;
    this.paint(context, frame.outgoing, frame, 1 + 0.4 * t);
    context.globalAlpha = 1;
  }

  private defocus(context: FrameContext, frame: TransitionFrame): void {
    const t = frame.progress;
    const most = frame.height * 0.05;

    if (t < 0.5) {
      context.filter = blurFilter(most * (t * 2));
      this.paint(context, frame.outgoing, frame, 1 + 0.05 * t);
    } else {
      context.filter = blurFilter(most * ((1 - t) * 2));
      this.paint(context, frame.incoming, frame, 1 + 0.05 * (1 - t));
    }
    context.filter = 'none';
  }

  /**
   * A fast swing, smeared the way a real one is.
   *
   * The smear is several copies offset along the direction of travel rather than
   * a blur, because a motion blur is directional and a Gaussian is not — blurred
   * evenly, a whip pan looks like the lens broke.
   */
  private whipPan(context: FrameContext, frame: TransitionFrame): void {
    const t = frame.progress;
    const swing = ease(t);
    const copies = 6;

    context.fillStyle = '#000000';
    context.fillRect(0, 0, frame.width, frame.height);

    const smear = (source: FrameSource | null, offset: number, alpha: number) => {
      for (let copy = 0; copy < copies; copy++) {
        const slip = (copy / (copies - 1) - 0.5) * frame.width * 0.12 * Math.sin(Math.PI * t);
        context.globalAlpha = alpha / copies;
        context.save();
        context.translate(offset + slip, 0);
        this.paint(context, source, frame);
        context.restore();
      }
      context.globalAlpha = 1;
    };

    smear(frame.outgoing, -frame.width * swing, 1);
    smear(frame.incoming, frame.width * (1 - swing), 1);
  }

  // ------------------------------------------------------------- movement --

  /**
   * @param push when true the outgoing shot is shoved along too, rather than
   *   sitting still while the incoming one covers it.
   */
  private slide(
    context: FrameContext,
    frame: TransitionFrame,
    dx: number,
    dy: number,
    push: boolean
  ): void {
    const t = ease(frame.progress);
    const offsetX = dx * frame.width;
    const offsetY = dy * frame.height;

    context.save();
    if (push) context.translate(offsetX * t, offsetY * t);
    this.paint(context, frame.outgoing, frame);
    context.restore();

    context.save();
    context.translate(-offsetX * (1 - t), -offsetY * (1 - t));
    this.paint(context, frame.incoming, frame);
    context.restore();
  }

  // --------------------------------------------------------------- shapes --

  private wipe(context: FrameContext, frame: TransitionFrame, axis: 'horizontal' | 'vertical'): void {
    const t = ease(frame.progress);
    this.paint(context, frame.outgoing, frame);

    this.masked(context, frame, (mask) => {
      mask.fillStyle = '#ffffff';
      if (axis === 'horizontal') mask.fillRect(0, 0, frame.width * t, frame.height);
      else mask.fillRect(0, frame.height * (1 - t), frame.width, frame.height * t);
    });
  }

  private clockWipe(context: FrameContext, frame: TransitionFrame): void {
    const t = ease(frame.progress);
    this.paint(context, frame.outgoing, frame);

    this.masked(context, frame, (mask) => {
      const radius = Math.hypot(frame.width, frame.height);
      mask.fillStyle = '#ffffff';
      mask.beginPath();
      mask.moveTo(frame.width / 2, frame.height / 2);
      // From twelve o'clock, clockwise, which is the direction a hand goes.
      mask.arc(frame.width / 2, frame.height / 2, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      mask.closePath();
      mask.fill();
    });
  }

  private iris(context: FrameContext, frame: TransitionFrame): void {
    const t = ease(frame.progress);
    this.paint(context, frame.outgoing, frame);

    this.masked(context, frame, (mask) => {
      mask.fillStyle = '#ffffff';
      mask.beginPath();
      mask.arc(frame.width / 2, frame.height / 2, (Math.hypot(frame.width, frame.height) / 2) * t, 0, Math.PI * 2);
      mask.fill();
    });
  }

  // ---------------------------------------------------------------- drawn --

  /**
   * Paint on, then paint off.
   *
   * The first half covers the outgoing shot in the reader's colour; the second
   * lifts that covering, and the incoming shot is what was underneath it all
   * along. Drawn as three layers in this order — outgoing, then paint, then the
   * incoming shot masked to the part that has been lifted — because the lifted
   * region is always inside the painted one, so the last layer simply wins where
   * it applies.
   */
  private painted(context: FrameContext, frame: TransitionFrame, kind: TransitionKind): void {
    const covering = clamp01(frame.progress * 2);
    const lifting = clamp01((frame.progress - 0.5) * 2);

    this.paint(context, frame.outgoing, frame);

    if (covering > 0) {
      const layer = this.strokeLayer(frame, kind, covering);
      if (layer) context.drawImage(layer, 0, 0);
    }

    if (lifting > 0) {
      this.masked(context, frame, (mask) => {
        drawStroke(mask, kind, frame.width, frame.height, lifting, '#ffffff');
      });
    }
  }

  /**
   * The incoming shot painted directly onto the outgoing one.
   *
   * The single-pass cousin of {@link painted}: there is no covering colour at
   * all, the brush itself is the reveal. Quieter, and the one to reach for when
   * the two shots belong together.
   */
  private paintedIn(context: FrameContext, frame: TransitionFrame): void {
    this.paint(context, frame.outgoing, frame);
    this.masked(context, frame, (mask) => {
      drawStroke(mask, 'ink-brush-down', frame.width, frame.height, ease(frame.progress), '#ffffff');
    });
  }

  // -------------------------------------------------------------- helpers --

  /** Draws a source to fill the frame, letterboxed, optionally scaled up. */
  private paint(context: FrameContext, source: FrameSource | null, frame: TransitionFrame, scale = 1): void {
    if (!source) {
      context.fillStyle = '#000000';
      context.fillRect(0, 0, frame.width, frame.height);
      return;
    }

    drawZoomed(
      (x, y, width, height) => source.draw(context, x, y, width, height),
      source.width,
      source.height,
      frame.width,
      frame.height,
      scale,
      frame.fill === true
    );
  }

  /**
   * Draws the incoming shot through a mask the caller paints in white.
   *
   * Two canvases and not one: `destination-in` throws away everything outside
   * the mask, so the picture has to be somewhere it can afford to lose, and that
   * cannot be the frame the outgoing shot is already on.
   */
  private masked(context: FrameContext, frame: TransitionFrame, paintMask: (mask: FrameContext) => void): void {
    const mask = this.maskFor(frame.width, frame.height);
    const layer = this.layerFor(frame.width, frame.height);
    if (!mask || !layer) return;

    mask.setTransform(1, 0, 0, 1, 0, 0);
    mask.globalCompositeOperation = 'source-over';
    mask.globalAlpha = 1;
    mask.clearRect(0, 0, frame.width, frame.height);
    paintMask(mask);

    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = 'source-over';
    layer.globalAlpha = 1;
    layer.filter = 'none';
    layer.clearRect(0, 0, frame.width, frame.height);
    this.paint(layer, frame.incoming, frame);

    layer.globalCompositeOperation = 'destination-in';
    layer.drawImage(this.mask as CanvasImageSource, 0, 0);
    layer.globalCompositeOperation = 'source-over';

    context.drawImage(this.layer as CanvasImageSource, 0, 0);
  }

  /** The covering paint, drawn on the mask canvas in the reader's colour. */
  private strokeLayer(
    frame: TransitionFrame,
    kind: TransitionKind,
    coverage: number
  ): CanvasImageSource | null {
    const mask = this.maskFor(frame.width, frame.height);
    if (!mask) return null;

    mask.setTransform(1, 0, 0, 1, 0, 0);
    mask.globalCompositeOperation = 'source-over';
    mask.globalAlpha = 1;
    mask.clearRect(0, 0, frame.width, frame.height);
    drawStroke(mask, kind, frame.width, frame.height, coverage, frame.colour);

    return this.mask as CanvasImageSource;
  }

  private maskFor(width: number, height: number): FrameContext | null {
    if (!this.mask) {
      this.mask = canvasOfSize(width, height);
      this.maskContext = this.mask.getContext('2d') as FrameContext | null;
    }
    sizeCanvas(this.mask, width, height);
    return this.maskContext;
  }

  private layerFor(width: number, height: number): FrameContext | null {
    if (!this.layer) {
      this.layer = canvasOfSize(width, height);
      this.layerContext = this.layer.getContext('2d') as FrameContext | null;
    }
    sizeCanvas(this.layer, width, height);
    return this.layerContext;
  }
}

// ----------------------------------------------------------- the brushwork --

/**
 * Paints `coverage` of the frame with one of the drawn shapes.
 *
 * Always in the one colour it is handed. The texture that makes a stroke look
 * loaded rather than printed comes from the bristles — parallel passes at
 * slightly different widths and opacities — and from a ragged leading edge, and
 * both of those are still the same hue. A second colour would stop it reading as
 * ink, which is the only thing this is trying to be.
 *
 * Deterministic to the frame: every wobble comes from {@link jitter}, seeded by
 * position, so the same stroke at the same coverage is the same picture. A brush
 * that used `Math.random` would boil, and boiling is what tells the eye it is
 * looking at a computer.
 */
export function drawStroke(
  context: FrameContext,
  kind: TransitionKind,
  width: number,
  height: number,
  coverage: number,
  colour: string
): void {
  const t = clamp01(coverage);
  if (t <= 0) return;

  context.save();
  context.fillStyle = colour;
  context.strokeStyle = colour;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  switch (kind) {
    case 'ink-sweep-across':
      bands(context, width, height, t, colour, 'horizontal');
      break;
    case 'ink-scribble':
      scribble(context, width, height, t);
      break;
    case 'ink-spiral':
      spiral(context, width, height, t);
      break;
    case 'ink-blot':
      blot(context, width, height, t);
      break;
    case 'ink-cross':
      crossOut(context, width, height, t);
      break;
    default:
      bands(context, width, height, t, colour, 'vertical');
      break;
  }

  context.restore();
}

/**
 * Broad brush passes, each one a band across the frame.
 *
 * The bands are laid one after another rather than all growing together, so what
 * the eye follows is a brush being drawn — a single moving tip — instead of a
 * curtain coming down. The last band is the only one still growing at any
 * moment, and it is the one that gets the ragged loaded edge.
 */
function bands(
  context: FrameContext,
  width: number,
  height: number,
  coverage: number,
  colour: string,
  axis: 'vertical' | 'horizontal'
): void {
  const across = axis === 'vertical' ? height : width;
  const along = axis === 'vertical' ? width : height;
  const count = 5;
  const band = across / count;

  for (let index = 0; index < count; index++) {
    // Each band owns a slice of the progress, with a little overlap so the brush
    // never appears to stop between passes.
    const from = index / count;
    const span = 1 / count;
    const local = clamp01((coverage - from) / (span * 1.15));
    if (local <= 0) break;

    const reversed = index % 2 === 1;
    const reach = along * local;
    const start = reversed ? along - reach : 0;

    context.save();
    if (axis === 'horizontal') {
      context.translate(width, 0);
      context.rotate(Math.PI / 2);
      // Rotating swaps the axes, so the band now runs down what was across.
    }

    const top = axis === 'vertical' ? index * band : index * band;
    // A hair of overlap between bands: a seam of untouched picture between two
    // strokes of paint is the one thing that gives the trick away.
    const thickness = band * 1.06;

    context.fillStyle = colour;
    context.beginPath();
    context.rect(start, top, reach, thickness);
    context.fill();

    // The loaded edge: a few blobs of the same colour running off the tip.
    const tip = reversed ? start : start + reach;
    const direction = reversed ? -1 : 1;
    for (let bristle = 0; bristle < 7; bristle++) {
      const y = top + ((bristle + 0.5) / 7) * thickness;
      const run = jitter(index * 31 + bristle) * band * 0.55;
      context.beginPath();
      context.ellipse(
        tip + direction * run * 0.5,
        y,
        Math.max(1, run),
        Math.max(1, thickness / 14),
        0,
        0,
        Math.PI * 2
      );
      context.fill();
    }
    context.restore();
  }
}

/** A back-and-forth scribble, thick enough that its own overlaps fill the frame. */
function scribble(context: FrameContext, width: number, height: number, coverage: number): void {
  const rows = 9;
  const thickness = (height / rows) * 1.5;
  const total = rows;
  const drawn = total * coverage;

  context.lineWidth = thickness;
  context.beginPath();
  context.moveTo(-thickness, thickness / 2);

  for (let row = 0; row < rows; row++) {
    const done = clamp01(drawn - row);
    if (done <= 0) break;

    const y = ((row + 0.5) / rows) * height;
    const next = ((row + 1.5) / rows) * height;
    const leftward = row % 2 === 1;
    const from = leftward ? width + thickness : -thickness;
    const to = leftward ? -thickness : width + thickness;

    context.lineTo(from + (to - from) * done, y + jitter(row) * thickness * 0.3);
    if (done >= 1) context.lineTo(to, next);
  }

  context.stroke();
}

/** Painted over in a spiral out from the middle. */
function spiral(context: FrameContext, width: number, height: number, coverage: number): void {
  const turns = 5;
  const maximum = Math.hypot(width, height) / 2;
  const thickness = (maximum / turns) * 2.3;

  context.lineWidth = thickness;
  context.beginPath();
  context.moveTo(width / 2, height / 2);

  const steps = 220;
  const drawn = Math.ceil(steps * coverage);
  for (let step = 1; step <= drawn; step++) {
    const along = step / steps;
    const angle = along * Math.PI * 2 * turns;
    const radius = along * maximum;
    context.lineTo(width / 2 + Math.cos(angle) * radius, height / 2 + Math.sin(angle) * radius);
  }

  context.stroke();
}

/** A blot spreading from the middle, its edge lumpy rather than circular. */
function blot(context: FrameContext, width: number, height: number, coverage: number): void {
  const maximum = Math.hypot(width, height) / 2;
  // Past the corners at full coverage, and by more than the wobble below can
  // take back: a blot that stops exactly at the corner leaves a sliver of the
  // outgoing shot showing at the moment it is meant to have covered everything.
  const radius = maximum * coverage * 1.35;
  const lobes = 13;

  context.beginPath();
  for (let lobe = 0; lobe <= lobes; lobe++) {
    const angle = (lobe / lobes) * Math.PI * 2;
    const wobble = 1 + jitter(lobe) * 0.22;
    const x = width / 2 + Math.cos(angle) * radius * wobble;
    const y = height / 2 + Math.sin(angle) * radius * wobble;
    if (lobe === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fill();
}

/**
 * Struck through, then filled in.
 *
 * Two diagonals first, because that is what someone crossing something out
 * actually does, and only then the fill — a shape that simply grew would have
 * no reason to be an X at all.
 */
function crossOut(context: FrameContext, width: number, height: number, coverage: number): void {
  const thickness = Math.min(width, height) * 0.16;
  context.lineWidth = thickness;

  const strokes = clamp01(coverage / 0.55);
  const fill = clamp01((coverage - 0.55) / 0.45);

  const line = (x1: number, y1: number, x2: number, y2: number, done: number) => {
    if (done <= 0) return;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x1 + (x2 - x1) * done, y1 + (y2 - y1) * done);
    context.stroke();
  };

  line(-thickness, -thickness, width + thickness, height + thickness, clamp01(strokes * 2));
  line(width + thickness, -thickness, -thickness, height + thickness, clamp01(strokes * 2 - 1));

  if (fill > 0) {
    // Opens out from the middle of the X, so the fill looks like it came from
    // the strokes rather than arriving on top of them.
    const radius = Math.hypot(width, height) * 0.55 * fill;
    context.beginPath();
    context.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
    context.fill();
  }
}

// ------------------------------------------------------------------ maths --

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Smoothstep. Every movement in this file starts and stops rather than jerking. */
function ease(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * A repeatable wobble in `[-1, 1]` for a whole number.
 *
 * Not random: the same index always gives the same number, which is what stops
 * a brush from boiling between frames. The constants are the usual sine-hash —
 * arbitrary, large, and irrational enough that consecutive indices land nowhere
 * near each other.
 */
function jitter(index: number): number {
  const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

/**
 * A blur filter string, or none.
 *
 * Below about a third of a pixel the browser does the work and shows nothing for
 * it, and `filter` is one of the more expensive things a 2D context can be asked
 * for, so the zero case is worth spelling out.
 */
function blurFilter(pixels: number): string {
  return pixels > 0.3 ? `blur(${pixels.toFixed(2)}px)` : 'none';
}
