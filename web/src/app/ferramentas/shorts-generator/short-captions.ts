export const captionFonts: readonly string[] = ['Arial', 'Verdana', 'Georgia', 'Impact', 'Comic Sans MS', 'Trebuchet MS', 'Tahoma', 'Times New Roman', 'Courier New'];
export interface CaptionWord { start: number; end: number; text: string; }
export interface CaptionStyle { color: string; highlight: string; shadow: string; outline: string; outlineWidth: number; font: string; fontSize: number; highlightScale: number; lineHeight?: number; positionY?: number; charsPerCaption?: number; bold?: boolean; }
export interface ShortCaptions { enabled: boolean; words: CaptionWord[]; style: CaptionStyle; }
export const captionStyle = (): CaptionStyle => ({ color: '#ffffff', highlight: '#ffe600', shadow: '#000000', outline: '#000000', outlineWidth: 2, font: 'Verdana', fontSize: 99, highlightScale: 1.2, bold: true, lineHeight: 1, positionY: 70, charsPerCaption: 30 });
export const captionPresets = [
  { name: 'Classic', description: 'White and yellow for clear reading', style: captionStyle() },
  { name: 'Neon', description: 'Mint with a subtle outline', style: { ...captionStyle(), fontSize: 88, highlight: '#6ee7b7', outline: '#142b2a', shadow: '#071916', outlineWidth: 2, highlightScale: 1.05 } },
  { name: 'Impact', description: 'Strong type with an amber highlight', style: { ...captionStyle(), font: 'Impact', bold: false, fontSize: 104, color: '#fffaf2', highlight: '#ffb454', outline: '#241b13', outlineWidth: 2, highlightScale: 1.1, charsPerCaption: 24 } },
  { name: 'Minimal', description: 'Light text with soft blue accents', style: { ...captionStyle(), font: 'Arial', fontSize: 82, color: '#f8fafc', highlight: '#93c5fd', outline: '#172033', shadow: '#0f172a', outlineWidth: 1, highlightScale: 1 } },
  { name: 'Editorial', description: 'Serif type in warm tones', style: { ...captionStyle(), font: 'Georgia', fontSize: 88, color: '#fff7ed', highlight: '#f2c078', outline: '#292119', shadow: '#17130f', outlineWidth: 1, highlightScale: 1.05 } }
];
/** Clip at edit boundaries before grouping: removed words must not appear in a phrase. */
export function captionWordsInRange(words: CaptionWord[], range?: { start: number; end: number }): CaptionWord[] {
  return range ? words.filter(w => w.end > range.start && w.start < range.end)
    .map(w => ({ ...w, start: Math.max(w.start, range.start), end: Math.min(w.end, range.end) })) : words;
}
export function captionGroups(words: CaptionWord[], style?: CaptionStyle): CaptionWord[][] {
  const groups: CaptionWord[][] = []; let current: CaptionWord[] = [];
  const target = style?.charsPerCaption ?? 30;
  const fontSize = style?.fontSize ?? 64;
  const maxLines = Math.max(1, Math.floor((1728 - fontSize * (style?.highlightScale ?? 1)) / (fontSize * (style?.lineHeight ?? 1))) + 1);
  for (const word of words) {
    const previous = current[current.length - 1];
    const length = current.map(w => w.text).join(' ').length, nextLength = length + 1 + word.text.length;
    const atTarget = nextLength > target && Math.abs(length - target) <= Math.abs(nextLength - target);
    const tooTall = captionLines([...current, word], fontSize).length > maxLines;
    if (previous && (atTarget || tooTall || word.start - previous.end >= .5 || /[.!?]$/.test(previous.text))) {
      groups.push(current); current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}
export function captionAt(words: CaptionWord[], time: number, style?: CaptionStyle) {
  // Keep the phrase visible through short pauses, with no highlighted word in a gap.
  const group = captionGroups(words, style).find(g => time >= g[0].start && time < g[g.length - 1].end);
  return group ? group.map(word => ({ ...word, active: time >= word.start && time < word.end })) : [];
}
/** Keep a tall block inside the short, even with a large font near the bottom edge. */
export function captionCenter(style: CaptionStyle, lineCount: number): number {
  const half = ((lineCount - 1) * style.fontSize * (style.lineHeight ?? 1) + style.fontSize * style.highlightScale) / 2;
  const margin = 96 + style.outlineWidth;
  return Math.max(margin + half, Math.min(1920 - margin - half, 1920 * (style.positionY ?? 70) / 100));
}
/** The same small lines in the preview and both exporters. */
export function captionLines<T extends { text: string }>(words: T[], fontSize = 64): T[][] {
  const lines: T[][] = []; let line: T[] = [], length = 0;
  const limit = Math.floor(950 / (fontSize * .6));
  for (const word of words) {
    if (line.length && (line.length >= 3 || length + word.text.length + 1 > limit)) { lines.push(line); line = []; length = 0; }
    line.push(word); length += word.text.length + 1;
  }
  if (line.length) lines.push(line);
  return lines;
}
/** Reserve enough width for the enlarged word, so long words remain inside the frame. */
export function captionLineScale(words: { text: string }[], style: CaptionStyle): number {
  const units = [...words.map(w => w.text).join(' ')].reduce((sum, ch) => sum + (/\s/.test(ch) ? .35 : /[ilIjt.,!|]/.test(ch) ? .38 : /[MWmw@]/.test(ch) ? 1.05 : .72), 0);
  return Math.min(1, 950 / Math.max(1, units * style.fontSize * style.highlightScale));
}
export function drawCaptions(ctx: CanvasRenderingContext2D, captions: ShortCaptions | undefined, time: number, width: number, height: number) {
  if (!captions?.enabled) return;
  const words = captionAt(captions.words, time, captions.style); if (!words.length) return;
  const s = captions.style, scale = width / 1080, lines = captionLines(words, s.fontSize);
  ctx.save();
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.shadowColor = s.shadow; ctx.shadowBlur = 6 * scale; ctx.shadowOffsetY = 3 * scale;
  lines.forEach((line, lineIndex) => {
    let sizes = line.map(w => { ctx.font = (s.font !== 'Impact' || s.bold ? 'bold ' : 'normal ') + s.fontSize * scale * (w.active ? s.highlightScale : 1) + 'px "' + s.font + '"'; return ctx.measureText(w.text + ' ').width; });
    const fit = Math.min(captionLineScale(line, s), width * .88 / sizes.reduce((a,b) => a+b,0));
    sizes = sizes.map(n => n * fit); let x = (width - sizes.reduce((a,b) => a+b,0)) / 2;
    const y = height * captionCenter(s, lines.length) / 1920 + (lineIndex - (lines.length - 1) / 2) * s.fontSize * scale * (s.lineHeight ?? 1);
    line.forEach((word, i) => {
      ctx.font = (s.font !== 'Impact' || s.bold ? 'bold ' : 'normal ') + s.fontSize * scale * fit * (word.active ? s.highlightScale : 1) + 'px "' + s.font + '"';
      ctx.lineWidth = s.outlineWidth * scale * 2; ctx.strokeStyle = s.outline;
      if (s.outlineWidth) ctx.strokeText(word.text, x, y);
      ctx.fillStyle = word.active ? s.highlight : s.color; ctx.fillText(word.text, x, y); x += sizes[i];
    });
  }); ctx.restore();
}

/** Keep aligned starts; clip overlapping model estimates so only one word can be active. */
export function alignedCaptionWords(words: CaptionWord[]): CaptionWord[] {
  const sorted = words.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start && w.text.trim()).sort((a,b) => a.start-b.start);
  const unique: CaptionWord[] = [];
  for (const word of sorted) {
    // Only merge the same recognition token at virtually the same time. Spoken repetitions at
    // different times remain intact ("não, não", for example).
    const duplicate = unique.slice(-12).find(w => w.text.trim().toLocaleLowerCase() === word.text.trim().toLocaleLowerCase()
      && Math.abs(w.start - word.start) <= .1
      && Math.min(w.end, word.end) - Math.max(w.start, word.start) >= .8 * Math.min(w.end - w.start, word.end - word.start));
    if (duplicate) duplicate.end = Math.max(duplicate.end, word.end);
    else unique.push({ ...word });
  }
  return unique.map((w,i) => ({start:w.start, end:Math.min(w.end, unique[i+1]?.start ?? w.end), text:w.text.trim()})).filter(w => w.end>w.start);
}
export function validateCaptions(c: ShortCaptions | undefined): void {
  if (c === undefined) return;
  if (!c || typeof c.enabled !== 'boolean' || !Array.isArray(c.words) || c.words.length > 100000 || !c.style) throw new Error('Invalid captions.');
  const s = c.style;
  if ([s.color,s.highlight,s.shadow,s.outline].some(color => !/^#[0-9a-f]{6}$/i.test(color)) || !captionFonts.includes(s.font) || !Number.isFinite(s.fontSize) || s.fontSize < 32 || s.fontSize > 200 || !Number.isFinite(s.outlineWidth) || s.outlineWidth < 0 || s.outlineWidth > 8 || !Number.isFinite(s.highlightScale) || s.highlightScale < 1 || s.highlightScale > 1.4) throw new Error('Invalid caption style.');
  if (s.lineHeight !== undefined && (!Number.isFinite(s.lineHeight) || s.lineHeight < 1 || s.lineHeight > 2.5)) throw new Error('Invalid caption line spacing.');
  if (s.positionY !== undefined && (!Number.isFinite(s.positionY) || s.positionY < 10 || s.positionY > 90)) throw new Error('Invalid caption position.');
  if (s.charsPerCaption !== undefined && (!Number.isInteger(s.charsPerCaption) || s.charsPerCaption < 10 || s.charsPerCaption > 120)) throw new Error('Invalid caption character target.');
  if (s.bold !== undefined && typeof s.bold !== 'boolean') throw new Error('Invalid caption font weight.');
  let previous = -1;
  for (const w of c.words) {
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < previous || w.start < 0 || w.end <= w.start || typeof w.text !== 'string' || w.text.length > 200 || /[\r\n]/.test(w.text)) throw new Error('Invalid caption words.');
    previous = w.end;
  }
}
