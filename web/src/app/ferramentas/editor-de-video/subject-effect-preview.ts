import { drawZoomed } from '../../shared/media/auto-zoom';
import { canvasOfSize, FrameContext, FrameSource } from './frame-source';
import { SubjectMask, SubjectSegmentationClient } from './subject-segmentation';

/** Preview inference has variable latency. Keep the matte and its exact image
 * together, instead of painting an old silhouette over a moving decoder.
 * One pending + one completed frame per lane bounds memory and worker traffic.
 * Export deliberately does not use this reduced-cadence preview path. */
export class SubjectEffectPreview {
  readonly vision = new SubjectSegmentationClient();
  private generation = 0;
  private identity = '';
  private pending = false;
  private disposed = false;
  private lastTime = -1;
  private requested = '';
  private complete: { source: FrameSource; mask: SubjectMask | null } | null = null;

  /**
   * The instant the completed pair belongs to, or -1 when there is none.
   *
   * Inference has variable latency, so during playback the picture on screen
   * can belong to an instant the clock has already passed. The player compares
   * this with the clock to say "the preview is 0.4s behind while the picture is
   * analysed" instead of quietly showing an old frame — which is the whole
   * failure this class exists to avoid.
   */
  completedTime = -1;

  reset(): void {
    ++this.generation; this.identity = ''; this.complete = null; this.requested = '';
    this.lastTime = -1; this.completedTime = -1;
  }

  /**
   * Clears a recoverable failure so the next frame tries again.
   *
   * False when there is nothing to recover from, or when the failure was the
   * kind that will not succeed on a retry — the client decides that, not this.
   */
  retry(): boolean {
    if (this.disposed) return false;
    if (!this.vision.retry()) return false;
    this.reset();
    return true;
  }

  frame(source: FrameSource, width: number, height: number, scale: number, fill: boolean,
    clipId: string, time: number, onReady: () => void): { source: FrameSource; mask: SubjectMask | null } | null {
    if (this.disposed) return null;
    const identity = `${clipId}:${width}x${height}:${fill}`;
    if (identity !== this.identity || time < this.lastTime - .02 || time - this.lastTime > .5) {
      this.reset(); this.identity = identity;
    }
    this.lastTime = time;
    const key = `${time}:${scale}`;
    if (!this.pending && key !== this.requested && this.vision.state !== 'unavailable') {
      this.pending = true; this.requested = key;
      const generation = this.generation;
      const canvas = canvasOfSize(width, height);
      try {
        const ctx = canvas.getContext('2d') as FrameContext;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
        drawZoomed((x,y,w,h) => source.draw(ctx,x,y,w,h),source.width,source.height,width,height,scale,fill);
      } catch (error) {
        this.pending = false; this.vision.state = 'unavailable';
        this.vision.lastError = error instanceof Error ? error.message : String(error);
        return null;
      }
      const frozen: FrameSource = { width,height,draw:(target,x,y,w,h) => target.drawImage(canvas,x,y,w,h) };
      void this.vision.maskFor(frozen,width,height,1,false,`${identity}:${scale}`,time).then(mask => {
        this.pending = false;
        if (this.disposed) return;
        if (generation !== this.generation) { onReady(); return; }
        this.complete = { source:frozen, mask };
        this.completedTime = time;
        onReady();
      });
    }
    return this.vision.state === 'unavailable' ? null : this.complete;
  }

  dispose(): void { this.disposed = true; this.reset(); this.vision.dispose(); }
}
