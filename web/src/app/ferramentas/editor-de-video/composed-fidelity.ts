import { clampSpeed } from './video-editor-defaults';
import { isMediaClip, ProjectPlan } from './video-editor.models';
import { sourceTimeAt } from './video-editor-timeline';

/**
 * Whether a composed frame can be trusted to be the frame the export writes.
 *
 * `composeFrame` draws whatever it is handed at whatever instant it is asked
 * for. Two things can still make the result a picture that never appears in the
 * finished file, and both are decided here rather than discovered by looking:
 *
 * - the source instant lies inside a stretch that was cut away, so the frame
 *   decoded from the file is one the timeline never shows;
 * - the instant lies inside a join, where the export blends two shots and a
 *   single-source capture would show only one of them.
 *
 * Kept free of the component so it can be tested with nothing but a plan.
 */
export type ComposedFidelityReason = 'removed' | 'transition' | 'not-on-timeline';

export interface ComposedFidelity {
  /** Where this source instant lands in the finished video, in seconds. */
  outputTime: number;
  faithful: boolean;
  reason: ComposedFidelityReason | null;
  /** A nearby source instant that would be faithful, when one exists. */
  suggestedSourceTime: number | null;
  /** The stretch of the finished video to avoid, when the problem is a join. */
  avoidOutputRange: readonly [number, number] | null;
}

const EPSILON = 1e-3;
/** How far inside a kept stretch or outside a join a suggestion lands. */
const NUDGE = 0.1;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function composedFidelity(plan: ProjectPlan, clipIndex: number, sourceTime: number): ComposedFidelity {
  const entry = plan.clips[clipIndex];
  if (!entry) {
    return { outputTime: 0, faithful: false, reason: 'not-on-timeline', suggestedSourceTime: null, avoidOutputRange: null };
  }
  const speed = clampSpeed(entry.edits.speed);
  const ranges = entry.keepRanges;

  // Where on the finished timeline the instant falls, if it is kept at all.
  let consumed = 0;
  let kept = false;
  let offset = 0;
  for (const range of ranges) {
    const length = Math.max(0, range.end - range.start);
    if (sourceTime >= range.start - EPSILON && sourceTime <= range.end + EPSILON) {
      kept = true;
      offset = consumed + Math.max(0, Math.min(length, sourceTime - range.start));
      break;
    }
    consumed += length;
  }

  if (!kept) {
    // The nearest instant that is on screen, a little inside its stretch.
    let best: number | null = null;
    for (const range of ranges) {
      if (range.end - range.start <= EPSILON) continue;
      const inside = Math.max(range.start + Math.min(NUDGE, (range.end - range.start) / 2),
        Math.min(range.end - Math.min(NUDGE, (range.end - range.start) / 2), sourceTime));
      // Ties go to the earlier stretch; the tolerance keeps float noise from deciding.
      if (best === null || Math.abs(inside - sourceTime) < Math.abs(best - sourceTime) - 1e-6) best = inside;
    }
    const nearestOutput = best === null ? 0 : composedFidelity(plan, clipIndex, best).outputTime;
    return {
      outputTime: round(nearestOutput),
      faithful: false,
      reason: 'removed',
      suggestedSourceTime: best === null ? null : round(best),
      avoidOutputRange: null
    };
  }

  const outputTime = entry.outputStart + offset / speed;
  const join = plan.transitions.find(transition =>
    (transition.fromIndex === clipIndex || transition.toIndex === clipIndex) &&
    transition.end - transition.start > EPSILON &&
    outputTime >= transition.start - EPSILON && outputTime <= transition.end + EPSILON
  );
  if (join) {
    // Step out of the join on this clip's own side of it.
    const target = join.fromIndex === clipIndex ? join.start - NUDGE : join.end + NUDGE;
    const clampedTarget = Math.max(entry.outputStart, Math.min(entry.outputStart + entry.outputDuration - EPSILON, target));
    const outsideJoin = clampedTarget < join.start - EPSILON || clampedTarget > join.end + EPSILON;
    return {
      outputTime: round(outputTime),
      faithful: false,
      reason: 'transition',
      suggestedSourceTime: outsideJoin ? round(sourceTimeAt(entry, clampedTarget).sourceTime) : null,
      avoidOutputRange: [round(join.start), round(join.end)]
    };
  }

  return { outputTime: round(outputTime), faithful: true, reason: null, suggestedSourceTime: null, avoidOutputRange: null };
}

/** Plain English for an agent, one sentence per reason. */
export function describeFidelity(fidelity: ComposedFidelity, sourceTime: number): string {
  switch (fidelity.reason) {
    case 'removed':
      return `Source ${round(sourceTime)}s was cut out of the edit, so it never appears in the finished video.` +
        (fidelity.suggestedSourceTime === null ? '' : ` The nearest kept instant is ${fidelity.suggestedSourceTime}s.`);
    case 'transition':
      return `Source ${round(sourceTime)}s falls inside a transition (${fidelity.avoidOutputRange?.[0]}s–${fidelity.avoidOutputRange?.[1]}s of the finished video), where two shots are blended.` +
        (fidelity.suggestedSourceTime === null ? '' : ` Try ${fidelity.suggestedSourceTime}s instead.`);
    case 'not-on-timeline':
      return 'This clip contributes nothing to the finished timeline.';
    default:
      return '';
  }
}

// --------------------------------------------------------------------------

/**
 * A short, stable name for "the edit as it is now".
 *
 * Built from the plan — the one thing both the preview and the encoder draw
 * from — so it changes exactly when the finished picture can change: a cut, a
 * speed, a zoom, a caption, a placed picture, an effect, a tag, a join. It does
 * not change when a transcript arrives or a thumbnail is cached, which bump the
 * project revision without touching a single exported frame. That difference is
 * the whole reason this exists instead of comparing revisions.
 */
export function editFingerprint(plan: ProjectPlan): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value === 'function') return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    if (value && typeof value === 'object') {
      if (!Array.isArray(value)) {
        const prototype = Object.getPrototypeOf(value);
        // Files, bitmaps, elements and workers say nothing about the picture
        // that their plain description next to them does not already say.
        if (prototype !== Object.prototype && prototype !== null) return undefined;
      }
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  };

  const shape = {
    frame: [plan.width, plan.height, plan.frameRate, plan.fillFrame],
    clips: plan.clips.map(entry => ({
      id: entry.clip.id,
      keep: entry.keepRanges,
      start: entry.outputStart,
      duration: entry.outputDuration,
      edits: entry.edits,
      // A text card is its own picture; a media clip's picture is its file,
      // which the id and the kept ranges already pin down.
      content: isMediaClip(entry.clip) ? undefined : entry.clip
    })),
    fades: plan.fades,
    zooms: plan.zooms,
    captions: plan.captions,
    images: plan.images ?? [],
    effects: plan.videoEffects,
    tags: plan.tags,
    transitions: plan.transitions.map(transition => ({
      from: transition.fromIndex,
      to: transition.toIndex,
      start: transition.start,
      end: transition.end,
      settings: transition.settings
    }))
  };
  return fingerprintOf(JSON.stringify(shape, replacer) ?? '');
}

/** Two independent 32-bit FNV-1a passes: 64 bits is plenty to tell edits apart. */
export function fingerprintOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a ^= code;
    a = Math.imul(a, 0x01000193);
    b ^= code + index;
    b = Math.imul(b, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return `edit-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
