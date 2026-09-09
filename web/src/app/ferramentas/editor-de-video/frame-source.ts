/**
 * What "a picture" means to everything that draws the timeline.
 *
 * Split out of `frame-compositor` so that the transition engine can speak about
 * pictures without importing the compositor, and the compositor can call the
 * transition engine. Two modules that both need the same noun and each need the
 * other's verbs is exactly the shape that turns into an import cycle, and the
 * cure is to give the noun a home of its own.
 */

export type FrameContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * The picture to put on the frame, and how big it is.
 *
 * A callback rather than an image because the sources — a decoded video sample,
 * an HTML video element, a canvas holding a text card, a still bitmap — have
 * nothing in common except that each of them can be drawn into a rectangle.
 */
export interface FrameSource {
  /**
   * Draws the picture into a rectangle of the given context.
   *
   * The context is a parameter rather than something the closure captured,
   * which matters exactly once: a transition masks the incoming shot, and
   * masking means drawing it onto a scratch canvas that can afford to have most
   * of itself thrown away. A source that could only ever draw onto the canvas it
   * was built for would silently paint onto the wrong one.
   */
  draw: (context: FrameContext, x: number, y: number, width: number, height: number) => void;
  width: number;
  height: number;
}

/** A canvas of the given size: offscreen where that exists, detached otherwise. */
export function canvasOfSize(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Resizes a scratch canvas in place, which is cheaper than making a new one. */
export function sizeCanvas(canvas: OffscreenCanvas | HTMLCanvasElement, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
