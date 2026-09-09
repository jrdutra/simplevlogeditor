import { Fft, hannWindow } from './fft';

/**
 * A hand-written transform is worth exactly as much as the checks on it, and
 * these are the two that catch every mistake worth making: does it come back,
 * and does it put a known tone where the maths says it should be. Bit-reversal
 * errors, twiddle sign errors and scaling errors all fail one or both.
 */
describe('the FFT', () => {
  it('returns what went in', () => {
    const size = 64;
    const fft = new Fft(size);
    const real = new Float32Array(size);
    const imag = new Float32Array(size);

    for (let index = 0; index < size; index++) {
      real[index] = Math.sin(index) * 0.5 + Math.cos(index * 3) * 0.25;
    }
    const original = real.slice();

    fft.forward(real, imag);
    fft.inverse(real, imag);

    for (let index = 0; index < size; index++) {
      expect(real[index]).toBeCloseTo(original[index], 4);
      expect(imag[index]).toBeCloseTo(0, 4);
    }
  });

  it('puts a pure tone in the bin it belongs to', () => {
    const size = 128;
    const bin = 9;
    const fft = new Fft(size);
    const real = new Float32Array(size);
    const imag = new Float32Array(size);

    for (let index = 0; index < size; index++) {
      real[index] = Math.cos((2 * Math.PI * bin * index) / size);
    }

    fft.forward(real, imag);

    const magnitudes = Array.from({ length: size / 2 + 1 }, (_, index) => Math.hypot(real[index], imag[index]));
    const loudest = magnitudes.indexOf(Math.max(...magnitudes));

    expect(loudest).toBe(bin);
    // A cosine of amplitude one splits its energy between the bin and its
    // mirror, so the half we look at holds N/2.
    expect(magnitudes[bin]).toBeCloseTo(size / 2, 2);
  });

  it('refuses a size that is not a power of two', () => {
    expect(() => new Fft(100)).toThrow();
  });
});

describe('the Hann window', () => {
  /**
   * The property the noise remover actually depends on: at three quarters
   * overlap the squared windows sum to a constant, which is what lets frames be
   * added back together without the seams being audible.
   */
  it('sums flat at three quarters overlap', () => {
    const size = 64;
    const hop = size / 4;
    const curve = hannWindow(size);

    for (let position = size; position < size * 3; position++) {
      let sum = 0;
      // Every frame start, taking only the ones still overlapping this sample.
      for (let start = 0; start <= position; start += hop) {
        const index = position - start;
        if (index < size) sum += curve[index] * curve[index];
      }
      expect(sum).toBeCloseTo(1.5, 4);
    }
  });
});
