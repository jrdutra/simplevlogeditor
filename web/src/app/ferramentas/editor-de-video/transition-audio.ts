/**
 * The sound of a transition: both shots heard at once.
 *
 * A transition lays the next shot over the end of the one before, and its sound
 * goes with it — the outgoing sound fades out while the incoming one fades in,
 * over exactly the length of the join. The encoder writes one clip's sound after
 * the other's, never two at once, so the two halves of the join are caught on
 * their way to the encoder, held here, and written once as a single crossfade.
 *
 * Only the overlap is held — a second or two of sound — never a whole clip.
 */

import type { AudioSample, AudioSampleSource } from 'mediabunny';

import type { MediabunnyLib } from '../../services/mediabunny/mediabunny-loader';

/** Seconds of sound handed to the encoder per sample when the mix is written. */
const MIX_CHUNK_SECONDS = 0.5;

/** One join's two sounds, on the output clock. */
export class JoinSoundMix {
  readonly frames: number;
  private readonly outgoing: Float32Array[];
  private readonly incoming: Float32Array[];
  flushed = false;

  constructor(
    readonly start: number,
    readonly end: number,
    readonly sampleRate: number,
    readonly channels: number
  ) {
    this.frames = Math.max(1, Math.round((end - start) * sampleRate));
    this.outgoing = Array.from({ length: channels }, () => new Float32Array(this.frames));
    this.incoming = Array.from({ length: channels }, () => new Float32Array(this.frames));
  }

  /**
   * Holds frames `[from, to)` of a sample as one side of the join. The sample may
   * have its own rate and channel count; it is placed by time and conformed here.
   */
  capture(side: 'outgoing' | 'incoming', sample: AudioSample, from: number, to: number): void {
    if (to <= from) return;
    const target = side === 'outgoing' ? this.outgoing : this.incoming;
    const count = to - from;
    const sourceChannels = Math.max(1, sample.numberOfChannels);
    const planes: Float32Array[] = [];
    for (let channel = 0; channel < sourceChannels; channel++) {
      const plane = new Float32Array(count);
      sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar', frameOffset: from, frameCount: count });
      planes.push(plane);
    }

    const sourceRate = sample.sampleRate;
    const firstTime = sample.timestamp + from / sourceRate;
    const valueAt = (channel: number, position: number): number => {
      const pick = (plane: Float32Array) => {
        const index = Math.floor(position);
        const fraction = position - index;
        const a = plane[Math.max(0, Math.min(count - 1, index))];
        const b = plane[Math.max(0, Math.min(count - 1, index + 1))];
        return a + (b - a) * fraction;
      };
      if (this.channels === 1 && sourceChannels > 1) {
        let sum = 0;
        for (const plane of planes) sum += pick(plane);
        return sum / sourceChannels;
      }
      return pick(planes[Math.min(channel, sourceChannels - 1)]);
    };

    const firstIndex = Math.max(0, Math.round((firstTime - this.start) * this.sampleRate));
    const lastIndex = Math.min(this.frames, Math.round((firstTime + count / sourceRate - this.start) * this.sampleRate));
    for (let index = firstIndex; index < lastIndex; index++) {
      const position = (this.start + index / this.sampleRate - firstTime) * sourceRate;
      for (let channel = 0; channel < this.channels; channel++) {
        target[channel][index] = valueAt(channel, position);
      }
    }
  }

  /**
   * The join as one sound, interleaved: an equal-power crossfade, so the level
   * neither dips nor swells in the middle of the join.
   */
  mixed(): Float32Array {
    const out = new Float32Array(this.frames * this.channels);
    for (let index = 0; index < this.frames; index++) {
      const progress = (index + 0.5) / this.frames;
      const fadeOut = Math.cos((progress * Math.PI) / 2);
      const fadeIn = Math.sin((progress * Math.PI) / 2);
      for (let channel = 0; channel < this.channels; channel++) {
        const value = this.outgoing[channel][index] * fadeOut + this.incoming[channel][index] * fadeIn;
        out[index * this.channels + channel] = Math.max(-1, Math.min(1, value));
      }
    }
    return out;
  }
}

/**
 * Stands in for the encoder's sound input while one clip's sound is written.
 *
 * Everything outside the clip's joins goes straight through. The part inside
 * the join at its start is held as that join's incoming side, and the mix is
 * written as soon as the clip's sound moves past it. The part inside the join at
 * its end is held as the next join's outgoing side, for the next clip to finish.
 */
export class JoinSoundRouter {
  constructor(
    private readonly library: MediabunnyLib,
    private readonly real: AudioSampleSource,
    /** The last instant actually handed to the encoder, before this clip. */
    public last: number,
    private readonly fromPrevious: JoinSoundMix | null,
    private readonly intoNext: JoinSoundMix | null
  ) {}

  /** Passed to the clip writers in place of the encoder's input. */
  get source(): AudioSampleSource {
    return this as unknown as AudioSampleSource;
  }

  async add(sample: AudioSample): Promise<void> {
    const frames = sample.numberOfFrames;
    const frameAt = (time: number) =>
      Math.max(0, Math.min(frames, Math.round((time - sample.timestamp) * sample.sampleRate)));
    let cursor = 0;

    const joinIn = this.fromPrevious;
    if (joinIn) {
      // Anything before the join belongs to the previous clip's sound, which
      // has already been written.
      cursor = Math.max(cursor, frameAt(joinIn.start));
      const joinEnd = frameAt(joinIn.end);
      if (joinEnd > cursor) {
        joinIn.capture('incoming', sample, cursor, joinEnd);
        cursor = joinEnd;
      }
      if (cursor >= frames) return;
      await this.flush(joinIn);
    }

    const joinOut = this.intoNext;
    if (joinOut) {
      const joinStart = frameAt(joinOut.start);
      if (joinStart > cursor) {
        await this.pass(sample, cursor, joinStart);
        cursor = joinStart;
      }
      // Up to the join's end; the clip's sound window stops there.
      const joinEnd = frameAt(joinOut.end);
      if (joinEnd > cursor) joinOut.capture('outgoing', sample, cursor, joinEnd);
      return;
    }

    if (cursor < frames) await this.pass(sample, cursor, frames);
  }

  /** Called once the clip's sound is written: a join it never got past is written now. */
  async finish(): Promise<void> {
    if (this.fromPrevious) await this.flush(this.fromPrevious);
  }

  private async pass(sample: AudioSample, from: number, to: number): Promise<void> {
    if (to <= from) return;
    const whole = from === 0 && to === sample.numberOfFrames;
    const part = whole ? sample : sample.trim(from, to);
    try {
      if (part.timestamp <= this.last && this.last > -Infinity) return;
      await this.real.add(part);
      this.last = part.timestamp;
    } finally {
      if (part !== sample) part.close();
    }
  }

  private async flush(mix: JoinSoundMix): Promise<void> {
    if (mix.flushed) return;
    mix.flushed = true;

    const data = mix.mixed();
    const chunk = Math.max(1, Math.round(MIX_CHUNK_SECONDS * mix.sampleRate));
    for (let offset = 0; offset < mix.frames; offset += chunk) {
      const count = Math.min(chunk, mix.frames - offset);
      const timestamp = mix.start + offset / mix.sampleRate;
      if (timestamp <= this.last && this.last > -Infinity) continue;
      const sample = new this.library.AudioSample({
        data: data.slice(offset * mix.channels, (offset + count) * mix.channels),
        format: 'f32',
        numberOfChannels: mix.channels,
        sampleRate: mix.sampleRate,
        timestamp
      });
      try {
        await this.real.add(sample);
      } finally {
        sample.close();
      }
      this.last = timestamp;
    }
  }
}
