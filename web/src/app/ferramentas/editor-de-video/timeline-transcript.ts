/**
 * A transcript of the edit, not of the files behind it.
 *
 * The recogniser hears a clip's source file: it knows nothing about in points,
 * hand-drawn cuts, removed pauses, speed or the order the clips ended up in. So
 * every word it returns is a word on the *source* clock, and everything here
 * exists to move those words onto the clock of the finished video — the one the
 * exported file plays on, and therefore the only one a subtitle file may be
 * written against.
 *
 * The plan already knows the answer. `keepRanges` says which stretches of the
 * source survive, `outputTimeOf` says where a surviving instant lands, and both
 * are the same functions the encoder and the preview use. Reusing them is not
 * tidiness: a transcript timed by a second implementation would drift from the
 * picture the first time somebody changed a clip's speed, and nothing on screen
 * would say why.
 *
 * A word spoken inside a stretch that was cut is not moved somewhere sensible —
 * it is dropped. It is not in the finished video, and a caption for a sentence
 * nobody can hear is worse than a gap.
 */

import { Cue } from '../transcricao-de-video/subtitle-formats';
import { ClipPlan, ProjectPlan, TimeRange, isMediaClip } from './video-editor.models';
import { outputTimeOf } from './video-editor-timeline';

/** Slack for a boundary comparison, in seconds. Below a millisecond nothing is audible. */
const EPSILON = 0.001;

/**
 * Which kept range holds an instant of the source, or -1 when none does.
 *
 * The instant asked about is always a word's midpoint, never its edge: a
 * recogniser's start and end are two estimates either side of a sound, and a
 * word whose first estimate lands a hundredth of a second inside a cut has not
 * been cut — the estimate was simply early.
 */
function rangeAt(ranges: readonly TimeRange[], time: number): number {
  for (const [index, range] of ranges.entries()) {
    if (time >= range.start - EPSILON && time <= range.end + EPSILON) return index;
  }
  return -1;
}

/**
 * Moves words heard in a clip's source onto the finished timeline.
 *
 * `origin` is subtracted at the end, which is the whole difference between the
 * two files this feature writes: nought leaves each word where it falls in the
 * finished video, and the clip's own `outputStart` makes the clip's transcript
 * begin at zero, as a transcript of that clip alone has to.
 */
export function placeWords(words: readonly Cue[], entry: ClipPlan, origin = 0): Cue[] {
  const placed: Cue[] = [];

  for (const word of words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) continue;

    const index = rangeAt(entry.keepRanges, (word.start + word.end) / 2);
    if (index < 0) continue;

    // Clamped into the range that owns it: a word whose tail runs past a cut
    // keeps its beginning and ends where the video does.
    const range = entry.keepRanges[index];
    const from = Math.min(range.end, Math.max(range.start, word.start));
    const to = Math.min(range.end, Math.max(from, word.end));

    const start = Math.max(0, outputTimeOf(entry, index, from) - origin);
    const end = Math.max(start + EPSILON, outputTimeOf(entry, index, to) - origin);
    placed.push({ ...word, start, end });
  }

  return placed;
}

/**
 * The clips of a plan whose own voice is in the finished video.
 *
 * Three things disqualify a clip, and each of them would otherwise produce
 * captions for something the viewer never hears: a file the browser cannot
 * decode the sound of, a project restored from storage whose bytes have not
 * been handed back, and a clip whose sound was muted or replaced with a
 * soundtrack. A clip left with nothing after the cuts is dropped for the same
 * reason.
 */
export function spokenEntries(plan: ProjectPlan): ClipPlan[] {
  return plan.clips.filter((entry) => {
    if (!isMediaClip(entry.clip)) return false;
    if (!entry.clip.summary.audioUsable || entry.clip.awaitingFile) return false;
    if (entry.sound.kind !== 'original') return false;
    return entry.keptDuration > EPSILON;
  });
}

/**
 * The stretch of the source a clip actually reads, as sample offsets.
 *
 * Everything before the in point and after the out point is decoded — the
 * decoder has no way to skip it — but it does not have to be *listened* to, and
 * on a forty-minute take trimmed down to two, not listening to the other
 * thirty-eight is the difference between a transcript and an afternoon.
 */
export function spokenSpan(entry: ClipPlan, rate: number, length: number): { from: number; to: number } {
  if (!entry.keepRanges.length) return { from: 0, to: length };

  const first = entry.keepRanges[0].start;
  const last = entry.keepRanges[entry.keepRanges.length - 1].end;

  // A second either side, because a word is only owned by the range its middle
  // falls in and the model needs the sound around it to recognise the word at
  // all.
  const from = Math.max(0, Math.floor((first - 1) * rate));
  const to = Math.min(length, Math.ceil((last + 1) * rate));
  return from < to ? { from, to } : { from: 0, to: length };
}
