/** Compare the same quiet input blocks on both sides. This measures level
 * change, not ground-truth noise, SNR improvement, or preservation of speech. */
export function quietLevelChange(before: readonly Float32Array[], after: readonly Float32Array[], rate: number): number {
  const length = before[0]?.length ?? 0;
  const block = Math.max(1, Math.round(rate * 0.05));
  const levels: { before: number; after: number }[] = [];
  for (let at = 0; at < length; at += block) {
    const end = Math.min(length, at + block);
    let input = 0, output = 0;
    for (let c = 0; c < before.length; c++) for (let index = at; index < end; index++) {
      input += before[c][index] ** 2;
      output += after[c][index] ** 2;
    }
    const count = (end - at) * before.length;
    levels.push({ before: input / count, after: output / count });
  }
  levels.sort((a, b) => a.before - b.before);
  const selected = levels.slice(0, Math.max(1, Math.ceil(levels.length * 0.2)));
  const input = selected.reduce((sum, item) => sum + item.before, 0);
  const output = selected.reduce((sum, item) => sum + item.after, 0);
  return 10 * Math.log10((output + 1e-20) / (input + 1e-20));
}

/** Conservative working-set estimate: source, worker, result, preview, STFT,
 * analysis caches and runtime. Reject before allocating decoded channels. */
export function estimatedWorkingBytes(seconds: number, rate: number, channels: number): number {
  return seconds * rate * channels * 4 * 5 + seconds * 300000 + 96 * 1024 * 1024;
}
export const MAX_WORKING_BYTES = 768 * 1024 * 1024;
