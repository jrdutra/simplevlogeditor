import { GainField } from './spectral-gain';

export const MAX_ANALYSIS_CACHE_BYTES = 32 * 1024 * 1024;

/** Retain short analyses for reruns without holding unbounded recording data. */
export function cacheableField(field: GainField): GainField | undefined {
  let bytes = 0;
  for (const frame of field.frames) {
    bytes += frame.byteLength;
    if (bytes > MAX_ANALYSIS_CACHE_BYTES) return undefined;
  }
  return field;
}
