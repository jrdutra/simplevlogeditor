export interface BackgroundAdjustments {
  exposureStops: number;
  contrast: number;
  saturation: number;
}

/** Pointwise tonal correction: no geometry, reconstruction, sharpening or added grain. */
export function correctPackagingPixels(pixels: Uint8ClampedArray, requested: Partial<BackgroundAdjustments> = {}) {
  const histogram = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    histogram[Math.round(.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2])]++;
    count++;
  }
  let median = 128;
  let sum = 0;
  for (let i = 0; i < histogram.length && count; i++) {
    sum += histogram[i];
    if (sum >= count / 2) { median = i; break; }
  }
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const adjustments: BackgroundAdjustments = {
    exposureStops: requested.exposureStops ?? clamp(Math.log2(110 / Math.max(16, median)) * .45, -.3, .65),
    contrast: requested.contrast ?? 1.06,
    saturation: requested.saturation ?? 1.04
  };
  for (const [key, min, max] of [['exposureStops', -1, 1], ['contrast', .8, 1.2], ['saturation', .8, 1.2]] as const) {
    if (!Number.isFinite(adjustments[key]) || adjustments[key] < min || adjustments[key] > max) {
      throw new Error(`${key} must be between ${min} and ${max}.`);
    }
  }
  const gamma = 2 ** -adjustments.exposureStops;
  const output = new Uint8ClampedArray(pixels);
  const tone = (value: number) => {
    const normalized = (value / 255) ** gamma;
    // A smooth contrast curve preserves black/white endpoints and highlight detail.
    return 255 * clamp(normalized + (adjustments.contrast - 1) *
      (normalized - .5) * 4 * normalized * (1 - normalized), 0, 1);
  };
  for (let i = 0; i < output.length; i += 4) {
    if (!output[i + 3]) continue;
    const r = tone(pixels[i]), g = tone(pixels[i + 1]), b = tone(pixels[i + 2]);
    const luma = .2126 * r + .7152 * g + .0722 * b;
    output[i] = luma + (r - luma) * adjustments.saturation;
    output[i + 1] = luma + (g - luma) * adjustments.saturation;
    output[i + 2] = luma + (b - luma) * adjustments.saturation;
  }
  return { pixels: output, adjustments, medianLuma: median };
}
