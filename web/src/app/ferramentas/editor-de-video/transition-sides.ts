/**
 * Getting a picture out of a clip at an arbitrary instant.
 *
 * The rest of the encoder is source-paced: it asks a decoder for everything it
 * has and writes each frame wherever the arithmetic says it belongs. A
 * transition cannot work that way. It needs *the* frame of the outgoing shot and
 * *the* frame of the incoming one for the same instant of the finished video,
 * over and over, and two decoders yielding at unrelated cadences will never hand
 * those over as a pair.
 *
 * So for the length of a join the clock is turned around. The transition writer
 * walks output frames, and each side of the join answers "what were you showing
 * then?" — a forward-only walk through the decoder for footage, a bitmap for a
 * still, a redraw for a text card. Forward-only is the whole trick: output time
 * only ever increases, and `sourceTimeAt` is monotonic within a clip, so a
 * single iterator and two live samples cover a join of any length. Buffering the
 * frames instead would cost eight megabytes each.
 */

import type { Input, VideoSample, VideoSampleSink } from 'mediabunny';

import { drawFrame } from '../criador-de-video-texto/text-scene-renderer';
import type { TextScene } from '../criador-de-video-texto/text-video.models';
import { FrameContext, FrameSource } from './frame-source';
import { sourceTimeAt } from './video-editor-timeline';
import { ClipPlan } from './video-editor.models';

/** One half of a join, asked what it was showing at an instant of the output. */
export interface TransitionSide {
  frameAt(outputTime: number): Promise<FrameSource | null>;
  dispose(): void;
}

/**
 * Footage, walked forward one decoded frame at a time.
 *
 * Two samples are alive at once: the one currently on screen and the one after
 * it, which is what makes "has the picture changed yet?" answerable without
 * seeking. Both are closed as they are passed, because a decoded frame is a real
 * GPU buffer and a join of four seconds would otherwise hold a hundred of them.
 */
export class FootageSide implements TransitionSide {
  private iterator: AsyncIterator<VideoSample> | null;
  private current: VideoSample | null = null;
  /** `undefined` means "not fetched yet"; `null` means the stream has ended. */
  private pending: VideoSample | null | undefined = undefined;

  constructor(
    private readonly input: Input,
    sink: VideoSampleSink,
    private readonly entry: ClipPlan,
    from: number,
    to: number
  ) {
    this.iterator = sink.samples(from, to)[Symbol.asyncIterator]();
  }

  async frameAt(outputTime: number): Promise<FrameSource | null> {
    const { sourceTime } = sourceTimeAt(this.entry, outputTime);
    await this.advanceTo(sourceTime);

    const sample = this.current;
    if (!sample) return null;

    return {
      draw: (context, x, y, width, height) => sample.draw(context, x, y, width, height),
      width: sample.displayWidth,
      height: sample.displayHeight
    };
  }

  dispose(): void {
    this.current?.close();
    this.current = null;
    if (this.pending) this.pending.close();
    this.pending = null;
    this.iterator = null;

    try {
      this.input.dispose();
    } catch {
      /* A decoder that is already gone is not a failure worth reporting. */
    }
  }

  private async advanceTo(sourceTime: number): Promise<void> {
    while (this.iterator) {
      if (this.pending === undefined) {
        const step = await this.iterator.next();
        this.pending = step.done ? null : step.value;
      }

      // Nothing further in the file: whatever is on screen stays there, which is
      // what a decoder running out under a transition should look like.
      if (this.pending === null) return;
      // The next frame has not happened yet at this instant.
      if (this.pending.timestamp > sourceTime) return;

      this.current?.close();
      this.current = this.pending;
      this.pending = undefined;
    }
  }
}

/** A still picture, or a black screen: the same frame at every instant. */
export class StillSide implements TransitionSide {
  constructor(
    private readonly image: CanvasImageSource,
    private readonly width: number,
    private readonly height: number,
    private readonly release: () => void = () => {}
  ) {}

  async frameAt(): Promise<FrameSource | null> {
    return {
      draw: (context, x, y, width, height) => context.drawImage(this.image, x, y, width, height),
      width: this.width,
      height: this.height
    };
  }

  dispose(): void {
    this.release();
  }
}

/**
 * A text card, redrawn at the instant it is asked about.
 *
 * Its animation has to keep running underneath the join — a title that freezes
 * the moment a transition starts is worse than one that never animated — so this
 * redraws rather than holding the last frame, at the card's own speed, exactly
 * as the card's own writer does.
 */
export class SceneSide implements TransitionSide {
  constructor(
    private readonly scene: TextScene,
    private readonly canvas: OffscreenCanvas | HTMLCanvasElement,
    private readonly context: FrameContext,
    private readonly entry: ClipPlan,
    private readonly speed: number,
    private readonly release: () => void
  ) {}

  async frameAt(outputTime: number): Promise<FrameSource | null> {
    drawFrame(this.context, this.scene, Math.max(0, (outputTime - this.entry.outputStart) * this.speed));

    return {
      draw: (context, x, y, width, height) => context.drawImage(this.canvas as CanvasImageSource, x, y, width, height),
      width: this.canvas.width,
      height: this.canvas.height
    };
  }

  dispose(): void {
    this.release();
  }
}

/** Nothing to show. Draws black, which is what the compositor does with null. */
export const EMPTY_SIDE: TransitionSide = {
  async frameAt() {
    return null;
  },
  dispose() {
    /* nothing held */
  }
};
