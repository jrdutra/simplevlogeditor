import { drawZoomed } from '../../shared/media/auto-zoom';
import { canvasOfSize, sizeCanvas, FrameContext, FrameSource } from './frame-source';
import { SubjectMask } from './subject-segmentation';
import { effectDefinition, effectDisplacesPixels, normalizeVideoEffect, VideoEffect, VideoEffectDefinition } from './video-effects';
import { VideoEffectShader } from './video-effect-shader';

type Surface = OffscreenCanvas | HTMLCanvasElement;
type SubjectKind = NonNullable<VideoEffectDefinition['subject']>;
/** Compass points a matte is grown along; the centre is drawn separately. */
const DILATION: readonly (readonly [number, number])[] =
  [[-1,0],[1,0],[0,-1],[0,1],[-0.7,-0.7],[0.7,-0.7],[-0.7,0.7],[0.7,0.7]];

/**
 * What the background of a shot gets, for each Creator preset.
 *
 * One place, because it is applied twice: to the background behind a person,
 * and to the whole frame when there is no person in it.
 */
export function backgroundFilter(kind: SubjectKind, height: number): string {
  if (kind === 'blur') return `blur(${height * 0.016}px)`;
  if (kind === 'pop') return `blur(${height * 0.004}px) brightness(0.90) saturate(0.90)`;
  if (kind === 'darken') return 'brightness(0.58)';
  if (kind === 'selective') return 'grayscale(1)';
  return 'none';
}
/** One reusable engine per composition lane; no temporal pixels can leak between clips. */
export class VideoEffectEngine {
  private surfaces: Surface[] = [];
  private shader: VideoEffectShader | null = null;
  /** Exactly what the last frame was rendered with, so the occlusion matte
   * cannot drift from the picture by recomputing a parameter of its own. */
  private last: { definition: VideoEffectDefinition; intensity: number; time: number; width: number; height: number } | null = null;
  warning = '';
  private surface(index: number, width: number, height: number): Surface {
    const canvas = this.surfaces[index] ??= canvasOfSize(width, height);
    sizeCanvas(canvas, width, height);
    return canvas;
  }
  render(source: FrameSource, settings: VideoEffect, width: number, height: number,
    time: number, scale = 1, fill = false, mask: SubjectMask | null = null): FrameSource {
    this.warning = '';
    const effect = normalizeVideoEffect(settings), definition = effectDefinition(effect.id)!;
    if (effect.id === 'none' || effect.intensity === 0) { this.last = null; return source; }
    this.last = { definition, intensity: effect.intensity, time, width, height };
    const original = this.surface(0, width, height), processed = this.surface(1, width, height);
    const originalContext = original.getContext('2d') as FrameContext;
    reset(originalContext, width, height);
    originalContext.fillStyle = '#000'; originalContext.fillRect(0, 0, width, height);
    drawZoomed((x,y,w,h) => source.draw(originalContext,x,y,w,h), source.width, source.height, width, height, scale, fill);
    const context = processed.getContext('2d') as FrameContext;
    reset(context, width, height);
    if (definition.subject) {
      context.drawImage(original, 0, 0);
      if (!mask) {
        // Everything that is not a person is background, so a frame with nobody
        // in it is a frame that is entirely background and is treated as one.
        // Glow and Outline put light around a subject and have nothing to add
        // to a picture without one.
        const filter = backgroundFilter(definition.subject, height);
        if (filter !== 'none') {
          context.filter = filter;
          context.drawImage(original, 0, 0);
          context.filter = 'none';
        }
      }
      if (mask) {
        const subject = this.surface(2, width, height), subjectContext = subject.getContext('2d') as FrameContext;
        reset(subjectContext, width, height);
        subjectContext.drawImage(original, 0, 0);
        subjectContext.globalCompositeOperation = 'destination-in';
        subjectContext.drawImage(subjectMaskCanvas(mask), 0, 0, width, height);
        subjectContext.globalCompositeOperation = 'source-over';
        const kind = definition.subject;
        const blurs = kind === 'blur' || kind === 'pop';
        context.filter = backgroundFilter(kind, height);
        // Blurring the whole frame smears the person outwards, and the sharp
        // cut-out put back on top does not cover that smear: what is left is a
        // halo of her own colours hugging hair and shoulders. So the blur is
        // given a plate the person has been removed from and the hole filled
        // with the background around it. Brightness and grayscale move no
        // pixels sideways and need no plate.
        context.drawImage(blurs ? this.backgroundPlate(original, mask, width, height) : original, 0, 0);
        context.filter = 'none';
        if (kind === 'glow' || kind === 'outline') {
          const halo = this.surface(3, width, height), haloContext = halo.getContext('2d') as FrameContext;
          reset(haloContext, width, height);
          haloContext.drawImage(subjectMaskCanvas(mask), 0, 0, width, height);
          haloContext.globalCompositeOperation = 'source-in';
          const gradient = haloContext.createLinearGradient(0, 0, width, height);
          gradient.addColorStop(0, kind === 'outline' ? '#26eaff' : '#fff0cf');
          gradient.addColorStop(1, kind === 'outline' ? '#d66cff' : '#addfff');
          haloContext.fillStyle = gradient; haloContext.fillRect(0, 0, width, height);
          haloContext.globalCompositeOperation = 'source-over';
          context.globalCompositeOperation = 'screen';
          context.filter = `blur(${height * 0.028}px)`; context.globalAlpha = 0.8;
          context.drawImage(halo, -width*0.006, -height*0.006, width*1.012, height*1.012);
          if (kind === 'outline') { context.filter = `blur(${height*0.004}px)`; context.globalAlpha = 0.7; context.drawImage(halo, -width*0.003, -height*0.003, width*1.006, height*1.006); }
          context.filter = 'none'; context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
        }
        if (kind === 'pop') context.filter = 'brightness(1.06) contrast(1.04) saturate(1.03)';
        context.drawImage(subject, 0, 0); context.filter = 'none';
      }
    } else {
      this.shader ??= new VideoEffectShader();
      const rendered = this.shader.render(original, definition, time);
      if (!rendered) this.warning = this.shader.error || 'Video effect is unavailable. Original video is shown.';
      context.drawImage(rendered ?? original, 0, 0);
    }
    const result = this.surface(4, width, height), resultContext = result.getContext('2d') as FrameContext;
    reset(resultContext, width, height);
    resultContext.drawImage(original, 0, 0);
    resultContext.globalAlpha = effect.intensity;
    resultContext.drawImage(processed, 0, 0);
    resultContext.globalAlpha = 1;
    return { width, height, draw: (target,x,y,w,h) => target.drawImage(result,x,y,w,h) };
  }
  /**
   * The silhouette to cut the subject out with, in the geometry of the picture
   * this engine last produced.
   *
   * For a preset that only regrades colour the matte is unchanged, and this
   * costs nothing. For one that moves pixels the matte is sent through the same
   * shader pass so the person that covers the caption is the person that is on
   * screen. A GPU failure falls back to the undisplaced matte rather than
   * dropping the occlusion entirely, and the caller reports the warning.
   */
  occlusionMask(mask: SubjectMask): Surface {
    const plain = subjectMaskCanvas(mask);
    const last = this.last;
    if (!last || !effectDisplacesPixels(last.definition) || !this.shader) return plain;
    const { width, height } = last;
    const flattened = this.surface(5, width, height), flatContext = flattened.getContext('2d') as FrameContext;
    reset(flatContext, width, height);
    // Black behind the matte: the shader samples its red channel as coverage.
    flatContext.fillStyle = '#000'; flatContext.fillRect(0, 0, width, height);
    flatContext.drawImage(plain as CanvasImageSource, 0, 0, width, height);
    const displaced = this.shader.renderMask(flattened, last.definition, last.time, last.intensity);
    if (!displaced) {
      this.warning = this.shader.error || 'Video effect is unavailable. Original video is shown.';
      return plain;
    }
    const result = this.surface(6, width, height), resultContext = result.getContext('2d') as FrameContext;
    reset(resultContext, width, height);
    resultContext.drawImage(displaced as CanvasImageSource, 0, 0, width, height);
    return result;
  }

  /**
   * The picture with the subject taken out and her outline filled in.
   *
   * Not inpainting: the background is pushed inwards from every side a few
   * times, each pass filling only what is still transparent, until the hole
   * carries the colours that surround it. That is enough for a blur, which only
   * needs plausible neighbours, and it keeps the person's own colours out of
   * them — which is the whole point. Partial hair alpha then composites against
   * a clean background instead of against a smeared copy of itself.
   */
  private backgroundPlate(original: Surface, mask: SubjectMask, width: number, height: number): Surface {
    const plate = this.surface(7, width, height), context = plate.getContext('2d') as FrameContext;
    reset(context, width, height);
    context.drawImage(original, 0, 0);
    context.globalCompositeOperation = 'destination-out';
    // The hole is cut with a grown matte, not the exact one. A silhouette a few
    // pixels wider costs nothing — the sharp person is painted back over it
    // afterwards — and it keeps the jittering boundary, and every colour near
    // it, out of the plate the blur samples. Without it a camera move makes the
    // fill shift from frame to frame and the background shimmers around her.
    context.drawImage(this.dilatedMask(mask, width, height) as CanvasImageSource, 0, 0, width, height);
    context.globalCompositeOperation = 'destination-over';
    // The hole is filled from its own surroundings, at growing radii, each pass
    // painting only what is still transparent.
    //
    // Pushing the whole frame inwards, or closing the gap with the average
    // colour of the picture, both put something into the ring around her that
    // is not the background that was there — and the average of a frame is
    // almost always darker than the light immediately behind a lit person, so
    // what it produced was a shadow drawn around her. Only Subject Glow and
    // Neon Outline are supposed to put anything around a subject; every other
    // preset must leave no outline at all.
    //
    // The copy goes through a scratch surface rather than the plate reading
    // from itself, which keeps the result defined whatever the browser does
    // with a canvas drawn onto its own context.
    const scratch = this.surface(10, width, height), scratchContext = scratch.getContext('2d') as FrameContext;
    for (const radius of [height * 0.02, height * 0.05, height * 0.12, height * 0.3]) {
      reset(scratchContext, width, height);
      scratchContext.drawImage(plate as CanvasImageSource, 0, 0);
      context.filter = `blur(${Math.max(1, Math.round(radius))}px)`;
      context.drawImage(scratch as CanvasImageSource, 0, 0);
    }
    context.filter = 'none';
    // Whatever is still transparent after that is deep inside a large
    // silhouette, where the sharp person is painted over it anyway. It is
    // closed so the plate is opaque before it is blurred, and the colour is
    // taken from the filled plate, so it can no longer reach the edge.
    context.fillStyle = this.averageColour(plate, width, height);
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'source-over';
    return plate;
  }

  /** The matte, grown by a little under the frame's own scale. */
  private dilatedMask(mask: SubjectMask, width: number, height: number): Surface {
    const radius = Math.max(2, Math.round(height * 0.012));
    const grown = this.surface(9, width, height), context = grown.getContext('2d') as FrameContext;
    reset(context, width, height);
    const source = subjectMaskCanvas(mask) as CanvasImageSource;
    context.drawImage(source, 0, 0, width, height);
    for (const [dx, dy] of DILATION) {
      context.drawImage(source, dx * radius, dy * radius, width, height);
    }
    return grown;
  }

  /** The mean colour of what is left of the frame, with the hole discounted. */
  private averageColour(surface: Surface, width: number, height: number): string {
    const tiny = this.surface(8, 1, 1), context = tiny.getContext('2d') as FrameContext;
    reset(context, 1, 1);
    context.drawImage(surface as CanvasImageSource, 0, 0, width, height, 0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (!alpha) return '#000000';
    // getImageData already returns un-premultiplied channels, so this is the
    // coverage-weighted mean colour of what is present. Scaling it by coverage
    // a second time — which this used to do — pushed it away from the true
    // background and was one more way to tint the ring around the subject.
    return `rgb(${red}, ${green}, ${blue})`;
  }

  dispose(): void {
    this.last = null;
    this.shader?.dispose(); this.shader = null;
    for (const canvas of this.surfaces) if (canvas) canvas.width = canvas.height = 1;
    this.surfaces = [];
  }
}
function reset(context: FrameContext, width: number, height: number): void {
  context.setTransform(1,0,0,1,0,0); context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over'; context.filter = 'none';
  context.clearRect(0,0,width,height);
}
export function subjectMaskCanvas(mask: SubjectMask): Surface {
  if (mask.canvas) return mask.canvas;
  const canvas = canvasOfSize(mask.width, mask.height);
  const context = canvas.getContext('2d') as FrameContext;
  const rgba = new Uint8ClampedArray(mask.alpha.length * 4);
  for (let index=0; index<mask.alpha.length; index++) {
    rgba[index*4] = rgba[index*4+1] = rgba[index*4+2] = 255;
    rgba[index*4+3] = mask.alpha[index];
  }
  context.putImageData(new ImageData(rgba, mask.width, mask.height),0,0);
  return mask.canvas = canvas;
}
