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
import { drawClipImage, imageBehindSubject, imagesAt } from './clip-image';
import { drawTag } from './tag-renderer';
import { captionAt, fadeGainAt, tagAt, transitionAt, transitionProgress, videoEffectAt } from './video-editor-timeline';
import { ProjectPlan, TransitionPlan, isMediaClip } from './video-editor.models';
import { clipAt } from './video-editor-timeline';
import { normalizeVideoEffect } from './video-effects';
import { VideoEffectEngine } from './video-effect-engine';
import { TransitionPainter } from './video-transitions';
import { FrameContext, FrameSource, canvasOfSize, sizeCanvas } from './frame-source';
import { SubjectMask } from './subject-segmentation';
import { isBackgroundCaption } from './video-editor-defaults';

export type { FrameContext, FrameSource };
export { canvasOfSize };

/** Below this a zoom is not worth a redraw. */
const NEUTRAL = 1.0001;
const subjectCanvases = new WeakMap<object, OffscreenCanvas | HTMLCanvasElement>();
const effectEngines = new WeakMap<object, VideoEffectEngine[]>();
export function disposeFrameEffects(context: FrameContext): void {
  effectEngines.get(context)?.forEach(engine => engine.dispose());
  effectEngines.delete(context);
  subjectCanvases.delete(context);
}
export function frameEffectWarning(context: FrameContext): string {
  return effectEngines.get(context)?.map(engine => engine.warning).filter(Boolean).join(' ') ?? '';
}
interface EffectedFrame { source: FrameSource | null; engine: VideoEffectEngine | null }
function effectedSource(context: FrameContext, plan: ProjectPlan, source: FrameSource | null, clip: ProjectPlan['clips'][number] | null,
  width: number, height: number, time: number, scale: number, fill: boolean, mask: SubjectMask | null, lane = 0): EffectedFrame {
  const planned = clip ? videoEffectAt(plan.videoEffects ?? [], time, clip.clip.id) : null;
  // The fallback serves hand-built plans from integrations predating timed
  // effects. Every plan produced by buildProjectPlan owns `videoEffects`.
  const effect = normalizeVideoEffect(planned ?? (plan.videoEffects === undefined && clip && isMediaClip(clip.clip)
    ? clip.clip.videoEffect : null));
  if (!source || effect.id === 'none' || effect.intensity === 0) return { source, engine: null };
  let engines = effectEngines.get(context);
  if (!engines) effectEngines.set(context, engines = []);
  const engine = engines[lane] ??= new VideoEffectEngine();
  return {
    source: engine.render(source,effect,width,height,Math.max(0,time-(clip?.outputStart ?? 0)),scale,fill,mask),
    engine
  };
}

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
  outgoingMask?: SubjectMask | null;
  incomingMask?: SubjectMask | null;
}

/**
 * True when this instant needs anything drawn over it.
 *
 * The encoder asks first and hands the sample straight to the codec when the
 * answer is no: a project with two fades in it must not pay to send every frame
 * of every clip through a canvas.
 */
export function needsCompositing(plan: ProjectPlan, time: number): boolean {
  const clip = plan.clips?.length ? clipAt(plan,time)?.clip : null;
  const activeEffect = plan.videoEffects === undefined
    ? normalizeVideoEffect(clip && isMediaClip(clip) ? clip.videoEffect : null)
    : videoEffectAt(plan.videoEffects, time);
  // Transitions are deliberately not on this list. A frame inside a join is
  // composed by the writer that owns the join, fade and all; the encoder checks
  // for that separately and passes such a frame straight through, because asking
  // this question about it would send an already-finished picture round again.
  return (
    // A reframed project crops, and cropping is something only a canvas can do:
    // the encoder's own transform letterboxes and has no other setting. So every
    // frame of such a project is composed, which is the price of the reframe and
    // is paid by nobody who has not asked for one.
    !!activeEffect && activeEffect.intensity > 0 ||
    plan.fillFrame ||
    zoomScaleAt(plan.zooms, time) > NEUTRAL ||
    captionAt(plan.captions, time) !== null ||
    imagesAt(plan.images ?? [], time).length > 0 ||
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
  transition: TransitionFrame | null = null,
  subjectMask: SubjectMask | null = null,
  sourceScale: number | null = null
): void {
  const gain = fadeGainAt(plan.fades, time);
  effectEngines.get(context)?.forEach(engine => engine.warning = '');

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.filter = 'none';
  // Black rather than transparent: a zoom of an odd aspect ratio still
  // letterboxes, and transparent bars encode as black in some formats and as
  // nothing at all in the ones that carry an alpha channel.
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);

  if (transition) {
    // Each side keeps its own engine, its own effect and therefore its own
    // matte: lane 0 for the shot being left, lane 1 for the shot being joined.
    const outgoing = effectedSource(context,plan,source,plan.clips[transition.entry.fromIndex] ?? null,width,height,time,1,plan.fillFrame,transition.outgoingMask ?? null).source;
    const incoming = effectedSource(context,plan,transition.incoming,plan.clips[transition.entry.toIndex] ?? null,width,height,time,1,plan.fillFrame,transition.incomingMask ?? null,1).source;
    transition.painter.draw(context, transition.entry.settings.kind, {
      outgoing,
      incoming,
      width,
      height,
      progress: transitionProgress(transition.entry, time),
      colour: transition.entry.settings.colour,
      fill: plan.fillFrame
    });

    // Overlay placements carry on across a join, because they can: each one
    // names the container it belongs to, and during a join both containers are
    // genuinely on screen. A picture that simply vanished for the length of a
    // crossfade and came back afterwards would read as a fault.
    //
    // The middle layer stands down here, exactly as a background caption does.
    // Two shots means two mattes, and there is no single silhouette to cut a
    // picture out from — drawing it against either one would put the person of
    // one shot in front of a picture belonging to the other.
    for (const side of [transition.entry.fromIndex, transition.entry.toIndex]) {
      const clipId = plan.clips[side]?.clip.id;
      if (!clipId) continue;
      for (const entry of imagesAt(plan.images ?? [], time, clipId)) {
        if (!imageBehindSubject(entry.image)) drawClipImage(context, entry.image, width, height, entry.opacity);
      }
    }
  } else {
    let scale = sourceScale ?? zoomScaleAt(plan.zooms, time);
    const caption = captionAt(plan.captions, time);
    const effected = effectedSource(context,plan,source,plan.clips?.length ? clipAt(plan,time) : null,width,height,time,scale,plan.fillFrame,subjectMask);
    if (effected.source !== source) { source = effected.source; scale = 1; }

    if (source) {
      drawZoomed(
        (x, y, boxWidth, boxHeight) => source!.draw(context, x, y, boxWidth, boxHeight),
        source.width,
        source.height,
        width,
        height,
        scale,
        plan.fillFrame
      );
    }

    // The middle layer, in one pass. A background caption and a picture placed
    // behind the person are the same idea drawn with different material, so they
    // share a layer and, crucially, share the single redraw of the foreground
    // below: cutting the person out twice would composite the silhouette over
    // itself and darken its edge.
    const placed = imagesAt(plan.images ?? [], time);
    const behind = placed.filter((entry) => imageBehindSubject(entry.image));
    if (caption) drawCaption(context, caption.caption, width, height, caption.opacity, caption.progress);
    for (const entry of behind) drawClipImage(context, entry.image, width, height, entry.opacity);

    const middleLayer = (caption !== null && isBehindSubject(caption.caption)) || behind.length > 0;
    if (source && subjectMask && middleLayer) {
      drawSubjectLayer(context, source, subjectMask, width, height, scale, plan.fillFrame, effected.engine);
    }

    // After the caption, because the two can share a corner and a badge that
    // disappeared under a line of dialogue would be the wrong way round: the
    // caption is the footage talking, the tag is the edit talking over it.
    const tag = tagAt(plan.tags, time);
    if (tag) drawTag(context, tag.tag, width, height, tag.elapsed);

    // Last of all, because "over everything" was the choice the reader made
    // when they picked this style over the middle layer. A picture deliberately
    // put on top of a badge is a placement, not an accident.
    for (const entry of placed) {
      if (!imageBehindSubject(entry.image)) drawClipImage(context, entry.image, width, height, entry.opacity);
    }
  }

  if (gain < 1) {
    context.globalAlpha = 1 - gain;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;
  }
}

function isBehindSubject(caption: { style?: string; stylePreset?: string }): boolean {
  return isBackgroundCaption(caption);
}

/** Redraws only the segmented foreground over the caption's middle layer. */
function drawSubjectLayer(
  context: FrameContext,
  source: FrameSource,
  mask: SubjectMask,
  width: number,
  height: number,
  scale: number,
  fill: boolean,
  engine: VideoEffectEngine | null = null
): void {
  let subject = subjectCanvases.get(context as object);
  if (!subject) {
    subject = canvasOfSize(width, height);
    subjectCanvases.set(context as object, subject);
  }
  sizeCanvas(subject, width, height);
  const subjectContext = subject.getContext('2d') as FrameContext | null;
  if (!subjectContext) return;
  subjectContext.setTransform(1, 0, 0, 1, 0, 0);
  subjectContext.globalAlpha = 1;
  subjectContext.globalCompositeOperation = 'source-over';
  subjectContext.filter = 'none';
  subjectContext.clearRect(0, 0, width, height);
  drawZoomed(
    (x, y, boxWidth, boxHeight) => source.draw(subjectContext, x, y, boxWidth, boxHeight),
    source.width, source.height, width, height, scale, fill
  );

  // A spatial effect has already moved the person inside `source`; the engine
  // returns the matte carried through the same displacement so the silhouette
  // that covers the caption is the silhouette on screen.
  const maskCanvas = engine ? engine.occlusionMask(mask) : canvasForMask(mask);
  subjectContext.globalCompositeOperation = 'destination-in';
  // Keep the model's own subpixel edge. Adding a Gaussian blur here spreads
  // the foreground into the background and creates a halo around the person.
  subjectContext.imageSmoothingEnabled = true;
  subjectContext.imageSmoothingQuality = 'high';
  subjectContext.drawImage(maskCanvas as CanvasImageSource, 0, 0, width, height);
  subjectContext.filter = 'none';
  subjectContext.globalCompositeOperation = 'source-over';

  context.save();
  context.globalAlpha = 1;
  context.drawImage(subject as CanvasImageSource, 0, 0, width, height);
  context.restore();
}

function canvasForMask(mask: SubjectMask): OffscreenCanvas | HTMLCanvasElement {
  if (mask.canvas) return mask.canvas;
  const canvas = canvasOfSize(mask.width, mask.height);
  const context = canvas.getContext('2d') as FrameContext | null;
  if (context) {
    const rgba = new Uint8ClampedArray(mask.alpha.length * 4);
    for (let index = 0; index < mask.alpha.length; index++) {
      const offset = index * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 255;
      rgba[offset + 3] = mask.alpha[index];
    }
    context.putImageData(new ImageData(rgba, mask.width, mask.height), 0, 0);
  }
  mask.canvas = canvas;
  return canvas;
}
