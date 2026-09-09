import { Cue, tidy, wrap } from './subtitle-formats';

export interface RecognitionWindow {
  from: number;
  to: number;
  keepFrom: number;
  keepTo: number;
}

/** Each 24-second core has up to 3 seconds of context on either side. */
export function recognitionWindows(length: number, rate: number): RecognitionWindow[] {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid sample rate.');
  const core = Math.max(1, Math.round(24 * rate));
  const context = Math.round(3 * rate);
  const windows: RecognitionWindow[] = [];
  for (let at = 0; at < length; at += core) {
    windows.push({ from: Math.max(0, at - context), to: Math.min(length, at + core + context),
      keepFrom: at, keepTo: Math.min(length, at + core) });
  }
  return windows;
}

export interface RawChunk {
  timestamp?: [number | null, number | null];
  text?: string;
}

/** Null timestamps mean unknown, never zero. All output remains on the media timeline. */
export function normalizeChunks(chunks: readonly RawChunk[], offset: number, duration: number): Cue[] {
  let cursor = 0;
  return chunks.flatMap((chunk, index) => {
    const text = tidy(String(chunk.text ?? ''));
    if (!text) return [];
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
    const rawStart = chunk.timestamp?.[0];
    const rawEnd = chunk.timestamp?.[1];
    const nextStart = chunks[index + 1]?.timestamp?.[0];
    const start = Math.min(duration, Math.max(0, valid(rawStart) ? rawStart : cursor));
    const stop = valid(rawEnd) && rawEnd > start ? rawEnd : valid(nextStart) && nextStart > start ? nextStart :
      valid(rawEnd) ? start + 0.02 : duration;
    const end = Math.min(duration, Math.max(start, stop));
    cursor = end;
    return end > start ? [{ start: offset + start, end: offset + end, text }] : [];
  });
}

/** Midpoint ownership avoids transcribing the context twice. Never deduplicate by text:
 * repeated words can be intentional. Word alignment remains a model estimate. */
export function ownedWords(words: readonly Cue[], window: RecognitionWindow, rate: number): Cue[] {
  return words.filter(word => {
    const midpoint = (word.start + word.end) * rate / 2;
    return midpoint >= window.keepFrom && midpoint < window.keepTo;
  });
}

/** Only bypass digital silence. An amplitude threshold could erase quiet speech. */
export function isDigitalSilence(samples: Float32Array): boolean {
  return samples.every(value => value === 0);
}

/** Group aligned words at punctuation and pauses without proportional timing guesses. */
export function groupWords(words: readonly Cue[], width = 42, lines = 2, maxSeconds = 7): Cue[] {
  const out: Cue[] = [];
  let current: Cue | undefined;
  for (const word of words) {
    const candidate = current ? `${current.text} ${word.text}` : word.text;
    if (current && (word.start - current.end > 0.7 || word.end - current.start > maxSeconds ||
      wrap(candidate, width).length > lines || /[.!?。！？]$/.test(current.text))) {
      out.push(current);
      current = undefined;
    }
    current = current ? { ...current, end: Math.max(current.end, word.end), text: `${current.text} ${word.text}` }
      : { ...word };
  }
  if (current) out.push(current);
  return out;
}
