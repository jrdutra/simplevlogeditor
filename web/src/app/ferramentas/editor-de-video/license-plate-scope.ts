import { EditorClip, isMediaClip, ProjectPlan } from './video-editor.models';
import { clipIndexAt, transitionAt } from './video-editor-timeline';

/** Stored on the video itself, independently of global defaults and clip overrides. */
export function clipBlursLicensePlates(clip: EditorClip | undefined): boolean {
  return !!clip && isMediaClip(clip) && clip.summary?.kind === 'video' && clip.blurLicensePlates === true;
}

export function hasLicensePlateBlur(plan: ProjectPlan): boolean {
  return plan.clips.some(entry => clipBlursLicensePlates(entry.clip));
}

export function licensePlateBlurAt(plan: ProjectPlan, time: number): boolean {
  if (!plan.clips?.length) return false;
  const join = transitionAt(plan, time);
  return join ? [join.fromIndex, join.toIndex].some(index => clipBlursLicensePlates(plan.clips[index]?.clip))
    : clipBlursLicensePlates(plan.clips[clipIndexAt(plan, time)]?.clip);
}
