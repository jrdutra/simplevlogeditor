import { applyGains, fieldFromPair, GainField } from './spectral-gain';
import { resample, toMono } from './resample';
import { quietLevelChange, estimatedWorkingBytes, MAX_WORKING_BYTES } from './audio-metrics';
import { AUDIO_FORMATS } from './noise-suppression.models';
import { readAudio, writeAudio } from './media-audio';
import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';
import { cacheableField, MAX_ANALYSIS_CACHE_BYTES } from './analysis-cache';
import { rnnoiseField } from './rnnoise-engine';

function tone(rate: number, hz: number, seconds = 0.1): Float32Array {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin(2 * Math.PI * hz * i / rate) * 0.25);
}
function rms(input: Float32Array): number { return Math.sqrt(input.reduce((sum, v) => sum + v * v, 0) / input.length); }

describe('noise suppression regression coverage', () => {
  it('flushes RNNoise latency instead of replacing the final frame with zeros', async () => {
    const input = tone(48000, 440, 15360 / 48000);
    const extended = new Float32Array(input.length + 480);
    extended.set(input);
    const short = await rnnoiseField(input, () => {}, () => false);
    const reference = await rnnoiseField(extended, () => {}, () => false);
    // This window ends exactly at the original boundary: extra input silence
    // must not be needed to recover its delayed output.
    const index = input.length / 512 - 1;
    const error = Math.max(...short.frames[index].map((value, bin) => Math.abs(value - reference.frames[index][bin])));
    expect(error).toBeLessThan(1e-6);
  });
  it('retains only analyses within the cache budget', () => {
    const frame = new Float32Array(1024);
    const field: GainField = { frames: [frame], step: 0.01, bandwidth: 1 };
    expect(cacheableField(field)).toBe(field);
    field.frames = Array.from({ length: MAX_ANALYSIS_CACHE_BYTES / frame.byteLength + 1 }, () => frame);
    expect(cacheableField(field)).toBeUndefined();
  });
  it('retains boundaries and duration with unity gain, even for a single sample', () => {
    for (const rate of [16000, 44100, 48000, 96000]) for (const length of [1, 31, 1025, 9999]) {
      const input = Float32Array.from({ length }, (_, i) => Math.cos(i) * 0.2);
      const field: GainField = { frames: [new Float32Array(257).fill(1)], step: 0.016, bandwidth: 31.25 };
      const result = applyGains(input, rate, field, { attenuationDb: 24 });
      expect(result.length).toBe(length);
      expect(Math.max(...result.map((v, i) => Math.abs(v - input[i])))).toBeLessThan(1e-6);
    }
  });
  it('centres recovered gain on time zero and supports sub-frame recordings', () => {
    const input = new Float32Array(100).fill(0.5);
    const field = fieldFromPair(input, Float32Array.from(input, v => v / 2), 48000);
    expect(field.frames.length).toBeGreaterThan(0);
    expect(field.frames[0][0]).toBeCloseTo(0.5, 5);
  });
  it('preserves the high band only when requested', () => {
    const input = tone(48000, 12000);
    const field = { frames: [new Float32Array(257)], step: 0.016, bandwidth: 31.25 };
    expect(rms(applyGains(input, 48000, field, { attenuationDb: 40, preserveHighs: true }))).toBeGreaterThan(rms(input) * 0.98);
    expect(rms(applyGains(input, 48000, field, { attenuationDb: 40 }))).toBeLessThan(rms(input) * 0.02);
  });
  it('rejects aliased high frequency energy when downsampling from 192 kHz', () => {
    const filtered = resample(tone(192000, 19000, 0.2), 192000, 16000);
    expect(rms(filtered.subarray(100, filtered.length - 100))).toBeLessThan(0.001);
    const voice = resample(tone(192000, 1000, 0.2), 192000, 16000);
    expect(rms(voice)).toBeGreaterThan(0.17);
  });
  it('keeps DC level and fractional-rate duration', () => {
    const input = new Float32Array(4410).fill(0.2);
    const result = resample(input, 44100, 16000);
    expect(result.length).toBe(1600);
    expect(Math.max(...result.map(v => Math.abs(v - 0.2)))).toBeLessThan(1e-6);
  });
  it('avoids phase cancellation in analysis and in the level metric', () => {
    const left = tone(48000, 440), right = Float32Array.from(left, v => -v);
    expect(rms(toMono([left, right]))).toBeGreaterThan(0.17);
    const after = [left, right].map(channel => Float32Array.from(channel, v => v / 2));
    expect(quietLevelChange([left, right], after, 48000)).toBeCloseTo(-6.0206, 3);
  });
  it('reports increases with their correct sign and silence as no change', () => {
    const input = tone(16000, 440);
    expect(quietLevelChange([input], [Float32Array.from(input, v => v * 2)], 16000)).toBeCloseTo(6.0206, 3);
    expect(quietLevelChange([new Float32Array(100)], [new Float32Array(100)], 16000)).toBe(0);
  });
  it('bounds multichannel and high-rate memory before decoding', () => {
    expect(estimatedWorkingBytes(1200, 192000, 8)).toBeGreaterThan(MAX_WORKING_BYTES);
    expect(estimatedWorkingBytes(30, 48000, 2)).toBeLessThan(MAX_WORKING_BYTES);
  });
  for (const id of ['wav', 'mp3']) it(`writes a real ${id} container and decodes it again`, async () => {
    const channels = [tone(48000, 440, 0.3), tone(48000, 880, 0.3)];
    const result = await writeAudio({ file: new File([], 'source.wav'), channels, rate: 48000,
      format: AUDIO_FORMATS.find(format => format.id === id)! }, () => {}, new AbortController().signal);
    const library = await loadMediabunny();
    const file = new File([result.blob], `output.${result.extension}`);
    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
    try {
      const format = await input.getFormat();
      expect(format.name.toLowerCase()).toContain(id === 'wav' ? 'wave' : 'mp3');
    } finally { input.dispose(); }
    const decoded = await readAudio(file, () => {}, new AbortController().signal);
    expect(decoded.channels.length).toBe(2);
    expect(decoded.seconds).toBeCloseTo(0.3, 1);
    expect(rms(decoded.channels[0])).toBeGreaterThan(0.1);
  });

  it('copies video packet bytes and timestamps when replacing the soundtrack', async () => {
    const library = await loadMediabunny();
    const output = new library.Output({ format: new library.WebMOutputFormat(), target: new library.BufferTarget() });
    const source = new library.VideoSampleSource({ codec: 'vp8', quality: new library.Quality('high') });
    output.addVideoTrack(source);
    await output.start();
    const canvas = new OffscreenCanvas(32, 32);
    const context = canvas.getContext('2d')!;
    for (let index = 0; index < 3; index++) {
      context.fillStyle = index % 2 ? 'red' : 'blue';
      context.fillRect(0, 0, 32, 32);
      const sample = new library.VideoSample(canvas, { timestamp: index * 0.1, duration: 0.1 });
      try { await source.add(sample); } finally { sample.close(); }
    }
    source.close();
    await output.finalize();
    const file = new File([(output.target as import('mediabunny').BufferTarget).buffer!], 'video.webm');
    const result = await writeAudio({ file, channels: [tone(48000, 440, 0.3)], rate: 48000, format: null }, () => {}, new AbortController().signal);
    const packets = async (blob: Blob) => {
      const input = new library.Input({ source: new library.BlobSource(blob), formats: library.ALL_FORMATS });
      try {
        const track = (await input.getPrimaryVideoTrack())!;
        const out: { time: number; data: number[] }[] = [];
        for await (const packet of new library.EncodedPacketSink(track).packets()) out.push({ time: packet.timestamp, data: [...packet.data] });
        return out;
      } finally { input.dispose(); }
    };
    expect(await packets(result.blob)).toEqual(await packets(file));
    expect(result.extension).toBe('webm');
  });
});
