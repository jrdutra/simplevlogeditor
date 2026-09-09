/**
 * Per-window statistics — the single contract shared by every analysis engine.
 *
 * Whichever engine ran, the detector and the waveform receive exactly this, so
 * a machine with a GPU and a machine without one produce the same cuts.
 */
export interface WindowReduction {
  /** RMS per window and channel, indexed as `window * channelCount + channel`. */
  rms: Float32Array;
  /** Lowest sample value seen in each window, across all channels. */
  min: Float32Array;
  /** Highest sample value seen in each window, across all channels. */
  max: Float32Array;
}

/**
 * Accumulates decoded audio into per-window loudness, on the CPU.
 *
 * It owns its accumulators, which is what makes chunk boundaries a non-issue:
 * every frame is mapped to its window by absolute frame index, so a window
 * split across two decoded chunks lands in the same slot with no carry buffer
 * anywhere. That also means chunks may arrive in any size the decoder happens
 * to produce.
 *
 * This class is used from the Web Worker and, when workers are unavailable,
 * directly on the main thread in small slices.
 */
export class CpuWindowReducer {
  private readonly sumSquares: Float32Array;
  private readonly counts: Uint32Array;
  private readonly min: Float32Array;
  private readonly max: Float32Array;

  constructor(
    private readonly channelCount: number,
    private readonly samplesPerWindow: number,
    private readonly windowCount: number
  ) {
    this.sumSquares = new Float32Array(windowCount * channelCount);
    this.counts = new Uint32Array(windowCount);
    this.min = new Float32Array(windowCount);
    this.max = new Float32Array(windowCount);
  }

  /** Folds one decoded chunk into the accumulators. */
  push(startFrame: number, channels: Float32Array[]): void {
    const frames = channels[0]?.length ?? 0;
    if (!frames) return;

    const { channelCount, samplesPerWindow, windowCount, sumSquares, counts, min, max } = this;

    for (let c = 0; c < channelCount; c++) {
      const data = channels[c] ?? channels[0];
      if (!data) continue;
      const countsFrames = c === 0;

      let index = 0;
      while (index < frames) {
        const absolute = startFrame + index;
        const window = (absolute / samplesPerWindow) | 0;
        if (window >= windowCount) break;

        // Walk to the end of this window or of this chunk, whichever comes
        // first: the window index is resolved once per run, not per sample.
        const runLength = Math.min((window + 1) * samplesPerWindow - absolute, frames - index);
        const slot = window * channelCount + c;

        let sum = 0;
        let low = min[window];
        let high = max[window];

        for (let i = index; i < index + runLength; i++) {
          const value = data[i];
          sum += value * value;
          if (value < low) low = value;
          if (value > high) high = value;
        }

        sumSquares[slot] += sum;
        min[window] = low;
        max[window] = high;
        if (countsFrames) counts[window] += runLength;

        index += runLength;
      }
    }
  }

  /** Turns the accumulated sums into the final per-window statistics. */
  finish(): WindowReduction {
    const { channelCount, windowCount, sumSquares, counts, min, max } = this;
    const rms = new Float32Array(windowCount * channelCount);

    for (let w = 0; w < windowCount; w++) {
      const frames = counts[w];
      if (!frames) continue;
      for (let c = 0; c < channelCount; c++) {
        const index = w * channelCount + c;
        rms[index] = Math.sqrt(sumSquares[index] / frames);
      }
    }

    return { rms, min, max };
  }
}
