import { encodeWav } from './wav';

/** Reads the little-endian header back out of an encoded blob. */
async function headerOf(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer());
  const ascii = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((offset) => view.getUint8(at + offset)));

  return {
    riff: ascii(0),
    wave: ascii(8),
    fmt: ascii(12),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: ascii(36),
    dataBytes: view.getUint32(40, true),
    totalBytes: view.byteLength,
    sampleAt: (frame: number, channel: number) =>
      view.getInt16(44 + (frame * view.getUint16(22, true) + channel) * 2, true)
  };
}

describe('the WAV encoder', () => {
  it('writes a header a decoder will accept', async () => {
    const header = await headerOf(encodeWav([new Float32Array(10), new Float32Array(10)], 48000));

    expect(header.riff).toBe('RIFF');
    expect(header.wave).toBe('WAVE');
    expect(header.fmt).toBe('fmt ');
    expect(header.data).toBe('data');
    expect(header.format).toBe(1);
    expect(header.channels).toBe(2);
    expect(header.sampleRate).toBe(48000);
    expect(header.bits).toBe(16);
    expect(header.blockAlign).toBe(4);
    expect(header.byteRate).toBe(48000 * 4);
    expect(header.dataBytes).toBe(10 * 2 * 2);
    expect(header.totalBytes).toBe(44 + 10 * 2 * 2);
  });

  it('interleaves the channels', async () => {
    const left = Float32Array.from([1, 0, 0]);
    const right = Float32Array.from([0, 1, 0]);
    const header = await headerOf(encodeWav([left, right], 8000));

    expect(header.sampleAt(0, 0)).toBe(32767);
    expect(header.sampleAt(0, 1)).toBe(0);
    expect(header.sampleAt(1, 0)).toBe(0);
    expect(header.sampleAt(1, 1)).toBe(32767);
  });

  /**
   * The failure this exists for: a sample past full scale that wraps does not
   * sound like distortion, it sounds like a gunshot, and floating point audio
   * overshoots often enough that it would eventually happen.
   */
  it('clamps instead of wrapping', async () => {
    const header = await headerOf(encodeWav([Float32Array.from([4, -4])], 8000));

    expect(header.sampleAt(0, 0)).toBe(32767);
    expect(header.sampleAt(1, 0)).toBe(-32767);
  });
});
