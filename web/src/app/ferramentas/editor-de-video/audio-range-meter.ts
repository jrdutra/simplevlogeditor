/** Source PCM measurement. Never averages channels before measuring their energy. */
export interface AudioChunk {
  timestamp: number;
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
}

interface Energy { squares: number; peak: number; count: number }
const energy = (): Energy => ({ squares: 0, peak: 0, count: 0 });
const levels = (value: Energy) => {
  const rms = value.count ? Math.sqrt(value.squares / value.count) : null;
  const peak = value.count ? value.peak : null;
  return { rms, peak, rmsDbfs: rms && rms > 0 ? 20 * Math.log10(rms) : null,
    peakDbfs: peak && peak > 0 ? 20 * Math.log10(peak) : null, sampleCount: value.count };
};

export class SourceAudioMeter {
  private buckets: Energy[][] = [];
  private totals: Energy[] = [];
  private sampleRate = 0;
  private channels = 0;
  private coveredUntil = -Infinity;
  private pcm: Int16Array | null = null;

  constructor(readonly start: number, readonly end: number, readonly interval: number, readonly includeAudio = false) {
    if (![start, end, interval].every(Number.isFinite) || start < 0 || end <= start || end - start > 120
      || interval < .05 || interval > 1 || (includeAudio && end - start > 12)) {
      throw new Error('Use a positive source range of at most 120s, interval 0.05–1s, and at most 12s for an audio preview.');
    }
  }

  add(chunk: AudioChunk, interleaved: Float32Array): void {
    const { sampleRate, numberOfChannels: channels, numberOfFrames: frames, timestamp } = chunk;
    if (!Number.isFinite(timestamp) || !Number.isInteger(sampleRate) || sampleRate <= 0
      || !Number.isInteger(channels) || channels < 1 || frames * channels !== interleaved.length) {
      throw new Error('Invalid decoded audio format.');
    }
    if (!this.sampleRate) {
      this.sampleRate = sampleRate;
      this.channels = channels;
      this.totals = Array.from({ length: channels }, energy);
      this.buckets = Array.from({ length: Math.ceil((this.end - this.start) / this.interval - 1e-9) },
        () => Array.from({ length: channels }, energy));
      if (this.includeAudio) {
        const length = Math.ceil((this.end - this.start) * sampleRate) * channels;
        if (length * 2 > 8 * 1024 * 1024) throw new Error('Audio preview exceeds 8 MiB. Request a shorter range.');
        this.pcm = new Int16Array(length);
      }
    }
    if (this.sampleRate !== sampleRate || this.channels !== channels) throw new Error('Audio format changed inside the requested range.');
    // Seek reads may return a packet preceding start. Clip it sample by sample;
    // also ignore overlapping packets rather than double-counting their energy.
    const from = Math.max(0, Math.ceil((Math.max(this.start, this.coveredUntil) - timestamp) * sampleRate - 1e-7));
    const to = Math.min(frames, Math.ceil((this.end - timestamp) * sampleRate - 1e-7));
    for (let frame = from; frame < to; frame++) {
      const time = timestamp + frame / sampleRate;
      const bucket = Math.min(this.buckets.length - 1, Math.floor((time - this.start) / this.interval + 1e-9));
      const targetFrame = Math.round((time - this.start) * sampleRate);
      for (let channel = 0; channel < channels; channel++) {
        const value = interleaved[frame * channels + channel];
        if (!Number.isFinite(value)) throw new Error('Decoded audio contains non-finite samples.');
        const stats = this.buckets[bucket][channel];
        const total = this.totals[channel];
        stats.squares += value * value; total.squares += value * value;
        stats.peak = Math.max(stats.peak, Math.abs(value)); total.peak = Math.max(total.peak, Math.abs(value));
        stats.count++; total.count++;
        if (this.pcm && targetFrame >= 0 && targetFrame * channels + channel < this.pcm.length) {
          this.pcm[targetFrame * channels + channel] = Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
        }
      }
    }
    if (to > from) this.coveredUntil = Math.max(this.coveredUntil, timestamp + to / sampleRate);
  }

  result() {
    const combine = (channels: Energy[]) => levels(channels.reduce((a, b) => ({
      squares: a.squares + b.squares, peak: Math.max(a.peak, b.peak), count: a.count + b.count
    }), energy()));
    return { start: this.start, end: this.end, interval: this.interval, sampleRate: this.sampleRate,
      channelCount: this.channels, summary: combine(this.totals),
      buckets: this.buckets.map((channels, index) => {
        const start = this.start + index * this.interval;
        const end = Math.min(this.end, start + this.interval);
        const decodedSeconds = this.sampleRate ? (channels[0]?.count ?? 0) / this.sampleRate : 0;
        return { start, end, decodedSeconds, coverage: Math.min(1, decodedSeconds / (end - start)),
          ...combine(channels), channels: channels.map(levels) };
      }),
      note: 'Original source audio before volume, speed, cuts, denoise or soundtrack. RMS/peak are energy evidence, not speech or sound-event recognition. Null dBFS means zero energy or missing PCM; use sampleCount/coverage to distinguish them.'
    };
  }

  wav(): Uint8Array | null {
    if (!this.pcm) return null;
    const bytes = new Uint8Array(44 + this.pcm.byteLength);
    const view = new DataView(bytes.buffer);
    const text = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, this.channels, true);
    view.setUint32(24, this.sampleRate, true); view.setUint32(28, this.sampleRate * this.channels * 2, true);
    view.setUint16(32, this.channels * 2, true); view.setUint16(34, 16, true); text(36, 'data');
    view.setUint32(40, this.pcm.byteLength, true);
    for (let index = 0; index < this.pcm.length; index++) view.setInt16(44 + index * 2, this.pcm[index], true);
    return bytes;
  }
}
