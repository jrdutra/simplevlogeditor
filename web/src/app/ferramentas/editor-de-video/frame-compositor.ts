/**
 * Everything that is painted on top of a frame, in one place.
 *
 * Two callers draw the timeline: the encoder, one frame at a time into a file,
 * and the preview, sixty times a second into a canvas on screen. If they each
 * had their own idea of where a zoom lands or how far a caption sits from the
 * bottom, the preview would be a decoration rather than a preview — so both go
 * through this function, and the only thing they disagree about is the size of
 * the canvas.
 *
 * That size is a parameter rather than something read from the plan, which is
 * what lets the preview compose at a fraction of the export's resolution and
 * still show the same picture: everything here is expressed as a share of the
 * frame, never in pixels of a particular output.
 */

import { drawZoomed, zoomScaleAt } from '../../shared/media/auto-zoom';
import { drawCaption } from './caption-renderer';
import { drawTag } from './tag-renderer';
import { captionAt, fadeGainAt, tagAt, transitionAt, transitionProgress } from './video-editor-timeline';
import { ProjectPlan, TransitionPlan } from './video-editor.models';
import { TransitionPainter } from './video-transitions';
import { FrameContext, FrameSource, canvasOfSize } from './frame-source';

export type { FrameContext, FrameSource };
export { canvasOfSize };

/** Below this a zoom is not worth a redraw. */
const NEUTRAL = 1.0001;

/**
 * The second picture, for the instants where two shots are on screen at once.
 *
 * Carried as one object rather than three parameters because it is all-or-
 * nothing: without the join there is nothing to draw, without the painter there
 * is nowhere to draw it, and a caller that has one of the three has all of them.
 */
export interface TransitionFrame {
  entry: TransitionPlan;
  /** The shot being arrived at. Null while its decoder is still catching up. */
  incoming: FrameSource | null;
  painter: TransitionPainter;
}

/**
 * True when this instant needs anything drawn over it.
 *
 * The encoder asks first and hands the sample straight to the codec when the
 * answer is no: a project with two fades in it must not pay to send every frame
 * of every clip through a canvas.
 */
export function needsCompositing(plan: ProjectPlan, time: number): boolean {
  // Transitions are deliberately not on this list. A frame inside a join is
  // composed by the writer that owns the join, fade and all; the encoder checks
  // for that separately and passes such a frame straight through, because asking
  // this question about it would send an already-finished picture round again.
  return (
    // A reframed project crops, and cropping is something only a canvas can do:
    // the encoder's own transform letterboxes and has no other setting. So every
    // frame of such a project is composed, which is the price of the reframe and
    // is paid by nobody who has not asked for one.
    plan.fillFrame ||
    zoomScaleAt(plan.zooms, time) > NEUTRAL ||
    captionAt(plan.captions, time) !== null ||
    tagAt(plan.tags, time) !== null ||
    fadeGainAt(plan.fades, time) < 1
  );
}

/**
 * Draws one instant of the timeline.
 *
 * The order is the whole behaviour. The zoom crops the picture, so a caption
 * applied first would be cropped with it; the fade is a wash over everything,
 * so it comes last and takes the caption down together with the picture.
 *
 * A transition replaces the first of those steps rather than joining it. During
 * a join two shots are on screen and the plan holds one zoom and one caption for
 * the instant, so applying either would mean applying the outgoing shot's
 * framing to the incoming shot as well — a push-in that jumps at the moment the
 * new picture arrives, and a caption that belongs to a clip the reader can
 * barely see any more. Both stand down for the length of the animation; the fade
 * does not, because a fade to black over a transition is a legitimate thing to
 * ask for and reads correctly.
 */
export function composeFrame(
  context: FrameContext,
  plan: ProjectPlan,
  time: number,
  width: number,
  height: number,
  source: FrameSource | null,
  transition: TransitionFrame | null = null
): void {
  const gain = fadeGainAt(plan.fades, time);

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.filter = 'none';
  // Black rather than transparent: a zoom of an odd aspect ratio still
  // letterboxes, and transparent bars encode as black in some formats and as
  // nothing at all in the ones that carry an alpha channel.
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);

  if (transition) {
    transition.painter.draw(context, transition.entry.settings.kind, {
      outgoing: source,
      incoming: transition.incoming,
      width,
      height,
      progress: transitionProgress(transition.entry, time),
      colour: transition.entry.settings.colour,
      fill: plan.fillFrame
    });
  } else {
    const scale = zoomScaleAt(plan.zooms, time);
    const caption = captionAt(plan.captions, time);

    if (source) {
      drawZoomed(
        (x, y, boxWidth, boxHeight) => source.draw(context, x, y, boxWidth, boxHeight),
        source.width,
        source.height,
        width,
        height,
        scale,
        plan.fillFrame
      );
    }

    if (caption) drawCaption(context, caption.caption, width, height, caption.opacity);

    // After the caption, because the two can share a corner and a badge that
    // disappeared under a line of dialogue would be the wrong way round: the
    // caption is the footage talking, the tag is the edit talking over it.
    const tag = tagAt(plan.tags, time);
    if (tag) drawTag(context, tag.tag, width, height, tag.elapsed);
  }

  if (gain < 1) {
    context.globalAlpha = 1 - gain;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;
  }
}
