import { Cue } from '../transcricao-de-video/subtitle-formats';
import { EditableRange, TimeRange } from './video-editor.models';

export const MAX_ANALYSIS_SECONDS = 300;

export interface AnalysisBlock extends TimeRange {
  index: number;
  text: string;
  boundary: 'sentence' | 'pause' | 'word' | 'duration' | 'end';
}

/** Sentence/pause boundaries are suggestions: the AI still decides topic continuity. */
export function analysisBlocks(words: readonly Cue[], bounds: TimeRange): AnalysisBlock[] {
  if (!Number.isFinite(bounds.start) || !Number.isFinite(bounds.end) || bounds.end <= bounds.start) return [];
  const valid = words.filter(word => Number.isFinite(word.start) && Number.isFinite(word.end) &&
    word.end > word.start && word.end > bounds.start && word.start < bounds.end)
    .slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const blocks: AnalysisBlock[] = [];
  let start = bounds.start;
  while (start < bounds.end) {
    const limit = Math.min(bounds.end, start + MAX_ANALYSIS_SECONDS);
    let end = limit;
    let boundary: AnalysisBlock['boundary'] = limit === bounds.end ? 'end' : 'duration';
    if (limit < bounds.end) {
      const candidates = valid.flatMap((word, index) => {
        const next = valid[index + 1];
        if (word.end <= start || word.end > limit || (next && next.start < word.end)) return [];
        const gap = next ? Math.max(0, next.start - word.end) : 0;
        const at = Math.min(limit, word.end + Math.min(gap / 2, 1));
        if (at < start + MAX_ANALYSIS_SECONDS * .6) return [];
        const sentence = /[.!?…]["'”’)]*\s*$/.test(word.text);
        const kind: AnalysisBlock['boundary'] = sentence ? 'sentence' : gap >= .6 ? 'pause' : 'word';
        return [{ at, kind, score: (sentence ? 60 : gap >= .6 ? 40 : 0) + (at - start) / 10 }];
      });
      const best = candidates.sort((a, b) => b.score - a.score)[0];
      if (best) { end = best.at; boundary = best.kind; }
      // split_clip requires 0.2s on both sides; do not propose a tiny final tail.
      if (bounds.end - end < .25) end = bounds.end - .25;
      // Never put a proposed boundary through a word, even with overlapping ASR cues.
      let crossing = valid.find(word => word.start < end && word.end > end);
      while (crossing && crossing.start > start) {
        end = crossing.start;
        boundary = 'word';
        crossing = valid.find(word => word.start < end && word.end > end);
      }
    }
    const text = valid.filter(word => (word.start + word.end) / 2 >= start &&
      (word.start + word.end) / 2 < end).map(word => word.text.trim()).join(' ');
    blocks.push({ index: blocks.length, start, end, text, boundary });
    start = end;
  }
  return blocks;
}

/** Keep original detector indices so decisions can be sent to set_detected_range. */
export function silenceInBounds(ranges: readonly EditableRange[], bounds: TimeRange) {
  return ranges.flatMap((range, rangeIndex) => {
    const start = Math.max(bounds.start, range.start);
    const end = Math.min(bounds.end, range.end);
    return end > start ? [{ ...range, start, end, rangeIndex }] : [];
  });
}

export function silenceSummary(ranges: readonly TimeRange[]) {
  const durations = ranges.map(range => range.end - range.start).filter(seconds => seconds > 0);
  const total = durations.reduce((sum, seconds) => sum + seconds, 0);
  return { count: durations.length, totalSeconds: total, minSeconds: durations.length ? Math.min(...durations) : 0,
    maxSeconds: durations.length ? Math.max(...durations) : 0, meanSeconds: durations.length ? total / durations.length : 0 };
}

/** Transition handles can restore part of a detected pause; count only absent samples. */
export function appliedSilenceSeconds(ranges: readonly EditableRange[], kept: readonly TimeRange[]): number {
  return ranges.filter(range => range.enabled).reduce((total, range) => total + Math.max(0,
    range.end - range.start - kept.reduce((seconds, keep) => seconds + Math.max(0,
      Math.min(range.end, keep.end) - Math.max(range.start, keep.start)), 0)), 0);
}
