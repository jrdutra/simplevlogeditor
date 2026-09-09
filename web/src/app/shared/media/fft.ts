/**
 * A small radix-2 FFT, written here rather than installed.
 *
 * The only thing in this app that needs a Fourier transform is the noise
 * remover, which wants one size, real input and a well-understood inverse. That
 * is about sixty lines. A dependency for it would add a package to the bundle of
 * every reader who never records anything, and this file can be read start to
 * finish in less time than it takes to check what the package does.
 *
 * Everything is in-place on a pair of arrays — real and imaginary parts kept
 * separately rather than interleaved — because the caller reuses the same two
 * buffers for thousands of frames and allocation is the whole cost here.
 */
export class Fft {
  /** Bit-reversed index of each position, precomputed once per size. */
  private readonly reversed: Uint32Array;
  /** cos and sin of the twiddle angles, likewise. */
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;

  /** @param size number of points; must be a power of two. */
  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }

    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let index = 0; index < size; index++) {
      let value = 0;
      for (let bit = 0; bit < bits; bit++) {
        value = (value << 1) | ((index >> bit) & 1);
      }
      this.reversed[index] = value;
    }

    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let index = 0; index < size / 2; index++) {
      this.cos[index] = Math.cos((-2 * Math.PI * index) / size);
      this.sin[index] = Math.sin((-2 * Math.PI * index) / size);
    }
  }

  /** Transforms in place. `real` and `imag` must both be `size` long. */
  forward(real: Float32Array, imag: Float32Array): void {
    this.transform(real, imag);
  }

  /**
   * The inverse, in place and correctly scaled.
   *
   * Uses the conjugate trick — swap the roles of real and imaginary, run the
   * forward transform, swap back, divide by N — so there is exactly one
   * butterfly loop in this file to get wrong.
   */
  inverse(real: Float32Array, imag: Float32Array): void {
    this.transform(imag, real);

    const scale = 1 / this.size;
    for (let index = 0; index < this.size; index++) {
      real[index] *= scale;
      imag[index] *= scale;
    }
  }

  private transform(real: Float32Array, imag: Float32Array): void {
    const size = this.size;

    for (let index = 0; index < size; index++) {
      const target = this.reversed[index];
      if (target <= index) continue;
      const tempReal = real[index];
      const tempImag = imag[index];
      real[index] = real[target];
      imag[index] = imag[target];
      real[target] = tempReal;
      imag[target] = tempImag;
    }

    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1;
      const step = size / span;

      for (let start = 0; start < size; start += span) {
        for (let offset = 0; offset < half; offset++) {
          const twiddle = offset * step;
          const wReal = this.cos[twiddle];
          const wImag = this.sin[twiddle];

          const a = start + offset;
          const b = a + half;

          const productReal = real[b] * wReal - imag[b] * wImag;
          const productImag = real[b] * wImag + imag[b] * wReal;

          real[b] = real[a] - productReal;
          imag[b] = imag[a] - productImag;
          real[a] += productReal;
          imag[a] += productImag;
        }
      }
    }
  }
}

/** A Hann window of `size` points, the usual choice for overlap-add analysis. */
export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
  }
  return window;
}
