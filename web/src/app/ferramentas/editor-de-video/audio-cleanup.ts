/**
 * Cleaning up a piece of sound before it is used as a soundtrack.
 *
 * Two jobs, both of which a person recording narration at a desk needs and
 * neither of which a video editor usually offers: take the room out of the
 * recording, and take the pauses out of the delivery.
 *
 * The result is written back out as a real WAV file rather than kept as a buffer
 * with a note attached. That is the whole design decision here. Everything
 * downstream — the probe that measures a supplied sound, the timeline planner
 * that reads it at an offset, the renderer, the preview player — already knows
 * how to handle a file, and none of them would work correctly against a file
 * plus a list of ranges to skip. A processed sound really is a shorter, quieter
 * file, so that is what it becomes.
 *
 * The cost is that the whole thing is decoded into memory. That is fine for
 * narration, which is what this exists for, and {@link CLEANUP_LIMIT_SECONDS}
 * refuses politely rather than letting a two-hour lecture take the tab down.
 */

import { settingsForPreset } from '../cortador-de-silencio/silence-cutter-presets';
import type { SilenceSettings, TimeRange } from '../cortador-de-silencio/silence-cutter.models';
import type { PresetId } from '../cortador-de-silencio/silence-cutter-presets';
import { detectSilence } from '../cortador-de-silencio/silence-detector';
import type { WindowStatistics } from '../cortador-de-silencio/silence-detector';
import { Fft, hannWindow } from '../../shared/media/fft';
import { encodeWav } from '../../shared/media/wav';

/**
 * How much audio this is willing to hold in memory at once.
 *
 * Decoded stereo costs about 23 MB a minute, and at the worst moment three of
 * those exist at once — what was decoded, what the noise remover wrote, and what
 * the silence cut wrote — plus the packed WAV and the blob copied out of it.
 * Call it five times the decoded size. Ten minutes is therefore about a
 * gigabyte at peak, which a tab can hold; the half hour this first said was a
 * number picked from the length of a recording rather than from the cost of one,
 * and it would have crashed the tab after the reader had already waited out the
 * whole cleanup.
 */
export const CLEANUP_LIMIT_SECONDS = 10 * 60;

/** Sample rate everything is decoded to, matching what the editor exports at. */
const WORKING_SAMPLE_RATE = 48000;

/**
 * Largest file worth opening at all.
 *
 * Generous on purpose — it is a backstop against the file that would exhaust
 * memory during `decodeAudioData`, not a second opinion about the length limit.
 * Ten minutes is about 100 MB even as uncompressed stereo WAV, so anything past
 * this cannot be under {@link CLEANUP_LIMIT_SECONDS} whatever its codec.
 */
const MAX_INPUT_BYTES = 400 * 1024 * 1024;

/** What the reader asked to have done to the sound. */
export interface CleanupSettings {
  /** Subtract the steady background — fans, hiss, room tone. */
  removeNoise: boolean;
  /** Cut the pauses out, using the same detector as the silence cutter tool. */
  cutSilence: boolean;
  /** Which silence preset drives the cut. Ignored unless `cutSilence`. */
  preset: Exclude<PresetId, 'custom'>;
}

/** Nothing done to it: what the dialog starts an uploaded file at. */
export const NO_CLEANUP: CleanupSettings = { removeNoise: false, cutSilence: false, preset: 'aggressive' };

/** What came back, and what it cost — enough for the dialog to say what happened. */
export interface CleanupReport {
  file: File;
  sampleRate: number;
  channelCount: number;
  originalDuration: number;
  duration: number;
  removedDuration: number;
  noiseRemoved: boolean;
  /** Level the steady background sat at, in dBFS. `null` when noise was left alone. */
  noiseFloorDb: number | null;
}

/** Thrown for the cases worth explaining rather than logging. */
export class AudioCleanupError extends Error {
  constructor(
    message: string,
    readonly hint = ''
  ) {
    super(message);
    this.name = 'AudioCleanupError';
  }
}

/**
 * Runs the requested cleanup and returns the result as a file.
 *
 * With nothing switched on this still decodes and re-encodes, which is
 * deliberate: it is what makes the dialog able to show a duration and a preview
 * for a recording that has no container metadata yet, and it costs a second.
 */
export async function cleanUpAudio(
  input: Blob,
  name: string,
  settings: CleanupSettings,
  onProgress: (ratio: number) => void = () => {}
): Promise<CleanupReport> {
  const decoded = await decode(input);

  const originalDuration = decoded.duration;
  let channels = decoded.channels;
  let noiseFloorDb: number | null = null;

  if (settings.removeNoise) {
    const cleaned: Float32Array[] = [];
    let floorSum = 0;

    for (let index = 0; index < channels.length; index++) {
      const result = await removeNoise(channels[index], (ratio) =>
        onProgress(((index + ratio) / channels.length) * (settings.cutSilence ? 0.7 : 1))
      );
      cleaned.push(result.samples);
      floorSum += result.noiseFloorDb;
    }

    channels = cleaned;
    noiseFloorDb = floorSum / channels.length;
  }

  if (settings.cutSilence) {
    channels = cutSilences(channels, decoded.sampleRate, settingsForPreset(settings.preset));
  }

  onProgress(1);

  const frames = channels.length ? channels[0].length : 0;
  const file = new File([encodeWav(channels, decoded.sampleRate)], cleanName(name), { type: 'audio/wav' });

  return {
    file,
    sampleRate: decoded.sampleRate,
    channelCount: channels.length,
    originalDuration,
    duration: frames / decoded.sampleRate,
    removedDuration: Math.max(0, originalDuration - frames / decoded.sampleRate),
    noiseRemoved: settings.removeNoise,
    noiseFloorDb
  };
}

/** `narration.webm` becomes `narration.wav`; a name without a suffix gains one. */
export function cleanName(name: string): string {
  const trimmed = name.trim() || 'narration';
  const dot = trimmed.lastIndexOf('.');
  return `${dot > 0 ? trimmed.slice(0, dot) : trimmed}.wav`;
}

// ---------------------------------------------------------------- decoding --

interface Decoded {
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
}

async function decode(input: Blob): Promise<Decoded> {
  const Context: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!Context) {
    throw new AudioCleanupError(
      'This browser cannot decode audio here.',
      'Recording and cleaning up sound needs the Web Audio API.'
    );
  }

  // A fixed rate rather than the hardware's: `decodeAudioData` resamples to the
  // context either way, so choosing the rate the editor exports at means the
  // sound is resampled once here instead of twice, here and at export.
  // Checked before a byte is decoded. The real limit is on the *duration*, and
  // that cannot be known until the file is open — but decoding is what allocates,
  // so a file too large to be under the limit under any codec is refused here
  // rather than after the allocation that would have taken the tab down.
  if (input.size > MAX_INPUT_BYTES) {
    throw new AudioCleanupError(
      'That file is too large to clean up here.',
      `Cleaning up sound works on the whole file in memory, so it is limited to about ${CLEANUP_LIMIT_SECONDS / 60} minutes of audio.`
    );
  }

  const context = new Context({ sampleRate: WORKING_SAMPLE_RATE });

  try {
    const buffer = await context.decodeAudioData(await input.arrayBuffer());

    if (buffer.duration > CLEANUP_LIMIT_SECONDS) {
      // `ceil`, not `round`: at ten minutes and ten seconds, rounding produces
      // "that is 10 minutes long — anything up to 10 minutes is fine", which
      // reads as the tool contradicting itself rather than as a limit.
      throw new AudioCleanupError(
        `That is ${Math.ceil(buffer.duration / 60)} minutes long, and cleaning up sound here works on the whole file at once.`,
        `Anything up to ${CLEANUP_LIMIT_SECONDS / 60} minutes is fine. Longer than that, use the Silence Cutter tool on it first and bring the result back.`
      );
    }

    const channels: Float32Array[] = [];
    for (let index = 0; index < buffer.numberOfChannels; index++) {
      // Copied out: the buffer is released with the context below, and holding
      // a view into a closed context's memory is asking for trouble.
      channels.push(new Float32Array(buffer.getChannelData(index)));
    }

    return { channels, sampleRate: buffer.sampleRate, duration: buffer.duration };
  } catch (error) {
    if (error instanceof AudioCleanupError) throw error;
    throw new AudioCleanupError(
      'That sound could not be decoded.',
      'Try WAV, MP3, M4A, OGG or WebM.'
    );
  } finally {
    void context.close();
  }
}

// ------------------------------------------------------------ noise removal --

/** Analysis window. About 43 ms at 48 kHz — long enough to resolve a voice. */
const FRAME = 2048;
/** Three quarters overlap, which is what makes the Hann windows sum flat. */
const HOP = FRAME / 4;
/** Sum of the squared analysis+synthesis Hann windows at 75% overlap. */
const OVERLAP_GAIN = 1.5;

/** How much of the estimated noise to subtract. Above one, to cover the estimate's own error. */
const OVERSUBTRACT = 2.2;
/** Quietest a bin is allowed to become: -26 dB. Silence that is *too* clean sounds dead. */
const GAIN_FLOOR = 0.05;
/** How fast a bin closes again once the sound in it stops. One hop is about 10 ms. */
const RELEASE = 0.55;
/** Bins either side included in the smoothing of the gain curve. */
const SMOOTH_RADIUS = 2;

/**
 * Takes the steady background out of one channel.
 *
 * The method is spectral subtraction with a minimum-statistics noise estimate,
 * which is the standard answer and, more usefully, the one whose failure mode is
 * understood: subtract too eagerly and the residue turns into "musical noise",
 * little tones flickering in the gaps. Three things hold that off — a gain floor
 * so a bin is never fully closed, smoothing across neighbouring bins so a single
 * outlier cannot ring on its own, and a release so a bin that has just been open
 * closes gradually rather than between one frame and the next.
 *
 * Two passes over the audio rather than one, because the alternative is holding
 * the entire spectrogram: at 48 kHz that is around 23 MB a minute per channel,
 * and recomputing the transforms is the cheaper half of that trade.
 */
async function removeNoise(
  samples: Float32Array,
  onProgress: (ratio: number) => void
): Promise<{ samples: Float32Array; noiseFloorDb: number }> {
  const bins = FRAME / 2 + 1;
  const frames = Math.max(1, Math.ceil(samples.length / HOP));

  if (samples.length < FRAME) return { samples, noiseFloorDb: -100 };

  const fft = new Fft(FRAME);
  const window = hannWindow(FRAME);
  const real = new Float32Array(FRAME);
  const imag = new Float32Array(FRAME);
  const magnitude = new Float32Array(bins);

  // --- pass one: the quietest this bin ever gets, block by block ------------
  //
  // Speech is intermittent and noise is not, so over a second or so of audio
  // the floor of each bin *is* the noise in it. Blocks rather than one global
  // minimum so that a single unusually quiet moment cannot set the estimate for
  // the whole recording; the median across blocks then ignores the outliers at
  // both ends.
  const framesPerBlock = Math.max(1, Math.round(1.5 / (HOP / WORKING_SAMPLE_RATE)));
  const blockCount = Math.max(1, Math.ceil(frames / framesPerBlock));
  const minima = new Float32Array(blockCount * bins).fill(Number.POSITIVE_INFINITY);

  for (let frame = 0; frame < frames; frame++) {
    spectrumOf(samples, frame * HOP, window, fft, real, imag, magnitude);

    const block = Math.min(blockCount - 1, Math.floor(frame / framesPerBlock)) * bins;
    for (let bin = 0; bin < bins; bin++) {
      if (magnitude[bin] < minima[block + bin]) minima[block + bin] = magnitude[bin];
    }

    if ((frame & 127) === 0) {
      onProgress((frame / frames) * 0.5);
      await breathe();
    }
  }

  const noise = new Float32Array(bins);
  const column = new Float32Array(blockCount);
  for (let bin = 0; bin < bins; bin++) {
    for (let block = 0; block < blockCount; block++) column[block] = minima[block * bins + bin];
    noise[bin] = median(column);
  }

  // --- pass two: subtract it, and put the audio back together --------------
  const output = new Float32Array(samples.length);
  const gain = new Float32Array(bins).fill(1);
  const target = new Float32Array(bins);

  for (let frame = 0; frame < frames; frame++) {
    const start = frame * HOP;
    spectrumOf(samples, start, window, fft, real, imag, magnitude);

    for (let bin = 0; bin < bins; bin++) {
      const level = magnitude[bin];
      // Wiener-ish: what is left of this bin once the noise in it is taken out,
      // as a fraction of what was there. Never below the floor.
      const kept = level > 1e-9 ? (level - OVERSUBTRACT * noise[bin]) / level : 0;
      target[bin] = Math.max(GAIN_FLOOR, Math.min(1, kept));
    }

    smooth(target, SMOOTH_RADIUS);

    for (let bin = 0; bin < bins; bin++) {
      // Open immediately, close slowly: a consonant that arrives between frames
      // must not be gated off, and a word that ends must not take its own tail
      // with it.
      gain[bin] = target[bin] > gain[bin] ? target[bin] : target[bin] + (gain[bin] - target[bin]) * RELEASE;
    }

    // Rebuild this frame from the gained spectrum. The upper half of the
    // transform is the mirror of the lower, so it is written from it.
    for (let bin = 0; bin < bins; bin++) {
      real[bin] *= gain[bin];
      imag[bin] *= gain[bin];
      if (bin > 0 && bin < FRAME / 2) {
        real[FRAME - bin] = real[bin];
        imag[FRAME - bin] = -imag[bin];
      }
    }

    fft.inverse(real, imag);

    const limit = Math.min(FRAME, samples.length - start);
    for (let index = 0; index < limit; index++) {
      output[start + index] += (real[index] * window[index]) / OVERLAP_GAIN;
    }

    if ((frame & 127) === 0) {
      onProgress(0.5 + (frame / frames) * 0.5);
      await breathe();
    }
  }

  onProgress(1);

  let floor = 0;
  for (let bin = 0; bin < bins; bin++) floor += noise[bin];
  floor = floor / bins / (FRAME / 4);

  return { samples: output, noiseFloorDb: Math.max(-120, 20 * Math.log10(Math.max(floor, 1e-12))) };
}

/**
 * Hands the thread back for one turn.
 *
 * The transforms are plain synchronous arithmetic, and a few million of them in
 * a row freeze the tab — including the progress bar that exists to say the tab
 * has not frozen. Yielding every hundred-odd frames costs a few milliseconds
 * each time and buys a page that keeps drawing.
 */
function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Windows one frame, transforms it, and leaves the magnitudes in `magnitude`. */
function spectrumOf(
  samples: Float32Array,
  start: number,
  window: Float32Array,
  fft: Fft,
  real: Float32Array,
  imag: Float32Array,
  magnitude: Float32Array
): void {
  for (let index = 0; index < FRAME; index++) {
    const position = start + index;
    real[index] = position < samples.length ? samples[position] * window[index] : 0;
    imag[index] = 0;
  }

  fft.forward(real, imag);

  for (let bin = 0; bin < magnitude.length; bin++) {
    magnitude[bin] = Math.hypot(real[bin], imag[bin]);
  }
}

/** Moving average across neighbouring bins, in place. */
function smooth(values: Float32Array, radius: number): void {
  const copy = values.slice();
  for (let index = 0; index < values.length; index++) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const at = index + offset;
      if (at < 0 || at >= copy.length) continue;
      sum += copy[at];
      count++;
    }
    values[index] = sum / count;
  }
}

function median(values: Float32Array): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Number.isFinite(value) ? value : 0;
}

// ------------------------------------------------------------ silence cuts --

/**
 * Removes the pauses, using the very detector the Silence Cutter tool uses.
 *
 * Sharing it is the point: a reader who has learned what "Aggressive" does to a
 * video has learned what it does to a narration too, and a second implementation
 * would eventually disagree with the first about what counts as a pause.
 */
export function cutSilences(
  channels: readonly Float32Array[],
  sampleRate: number,
  settings: SilenceSettings
): Float32Array[] {
  if (!channels.length || !channels[0].length) return channels.map((channel) => channel);

  const { keepRanges } = detectSilence(windowStatistics(channels, sampleRate, settings.detectionWindowMs), settings);

  return joinRanges(channels, sampleRate, keepRanges, settings.crossfadeMs / 1000);
}

/** Per-window RMS of every channel, in the layout the detector expects. */
export function windowStatistics(
  channels: readonly Float32Array[],
  sampleRate: number,
  detectionWindowMs: number
): WindowStatistics {
  const frames = channels[0].length;
  const windowSeconds = Math.max(0.001, detectionWindowMs / 1000);
  const samplesPerWindow = Math.max(1, Math.round(windowSeconds * sampleRate));
  const windowCount = Math.max(1, Math.ceil(frames / samplesPerWindow));
  const channelCount = channels.length;
  const rms = new Float32Array(windowCount * channelCount);

  for (let channel = 0; channel < channelCount; channel++) {
    const samples = channels[channel];
    for (let window = 0; window < windowCount; window++) {
      const start = window * samplesPerWindow;
      const end = Math.min(frames, start + samplesPerWindow);
      let sum = 0;
      for (let index = start; index < end; index++) sum += samples[index] * samples[index];
      rms[window * channelCount + channel] = end > start ? Math.sqrt(sum / (end - start)) : 0;
    }
  }

  return {
    rms,
    channelCount,
    windowCount,
    windowSeconds: samplesPerWindow / sampleRate,
    duration: frames / sampleRate
  };
}

/**
 * Concatenates the kept ranges, crossfading each join.
 *
 * Without the crossfade every cut is a step in the waveform, and a step is a
 * click — the one artefact that makes an edit sound like a mistake rather than
 * like a decision. The join overlaps by the fade length, so the result is
 * slightly shorter than the sum of its parts, which is correct: the fade is
 * where the two pieces are both playing.
 */
export function joinRanges(
  channels: readonly Float32Array[],
  sampleRate: number,
  keepRanges: readonly TimeRange[],
  crossfadeSeconds: number
): Float32Array[] {
  const total = channels[0].length;
  const segments = keepRanges
    .map((range) => ({
      start: Math.max(0, Math.round(range.start * sampleRate)),
      end: Math.min(total, Math.round(range.end * sampleRate))
    }))
    .filter((range) => range.end > range.start);

  if (!segments.length) return channels.map(() => new Float32Array(0));

  const fade = Math.max(0, Math.round(crossfadeSeconds * sampleRate));

  // How much of the output each join eats, worked out once so the length below
  // and the writes further down can never disagree about it.
  //
  // Never the whole of either piece: a join as long as the segment it opens
  // would leave the write cursor exactly where it started, and the segment after
  // it would then fade into the same stretch of output and paint over it. On an
  // aggressive preset over clipped speech that is a syllable disappearing.
  //
  // Measured against what the previous segment actually *contributed*, not
  // against how long it was: a segment that was itself mostly consumed by its
  // own join has little left to fade out of, and reaching further back would
  // paint over the segment before it a second time.
  const joins: number[] = [];
  let length = 0;
  let previousKept = 0;

  for (let index = 0; index < segments.length; index++) {
    const size = segments[index].end - segments[index].start;
    const join = index === 0 ? 0 : Math.max(0, Math.min(fade, size - 1, previousKept));

    joins.push(join);
    previousKept = size - join;
    length += previousKept;
  }

  return channels.map((samples) => {
    const output = new Float32Array(length);
    let cursor = 0;

    for (let index = 0; index < segments.length; index++) {
      const { start, end } = segments[index];
      const size = end - start;
      const join = joins[index];

      // The overlap: what is already there fades down while this piece fades up.
      for (let offset = 0; offset < join; offset++) {
        const rise = (offset + 1) / (join + 1);
        const at = cursor - join + offset;
        output[at] = output[at] * (1 - rise) + samples[start + offset] * rise;
      }

      for (let offset = join; offset < size; offset++) {
        output[cursor - join + offset] = samples[start + offset];
      }

      cursor += size - join;
    }

    return output;
  });
}
