'use strict';
function validateCaptions(c) {
  if (c === undefined) return undefined;
  const colors = ['color', 'highlight', 'shadow', 'outline'];
  if (!c || typeof c.enabled !== 'boolean' || !Array.isArray(c.words) || c.words.length > 100000 || !c.style) throw new Error('Invalid captions.');
  const s = c.style;
  if (colors.some(k => !/^#[\da-f]{6}$/i.test(s[k])) || !['Arial', 'Verdana', 'Georgia', 'Impact', 'Comic Sans MS', 'Trebuchet MS', 'Tahoma', 'Times New Roman', 'Courier New'].includes(s.font) || !Number.isFinite(s.fontSize) || s.fontSize < 32 || s.fontSize > 200 || !Number.isFinite(s.outlineWidth) || s.outlineWidth < 0 || s.outlineWidth > 8 || !Number.isFinite(s.highlightScale) || s.highlightScale < 1 || s.highlightScale > 1.4) throw new Error('Invalid caption style.');
  if (s.lineHeight !== undefined && (!Number.isFinite(s.lineHeight) || s.lineHeight < 1 || s.lineHeight > 2.5)) throw new Error('Invalid caption line spacing.');
  if (s.positionY !== undefined && (!Number.isFinite(s.positionY) || s.positionY < 10 || s.positionY > 90)) throw new Error('Invalid caption position.');
  if (s.charsPerCaption !== undefined && (!Number.isInteger(s.charsPerCaption) || s.charsPerCaption < 10 || s.charsPerCaption > 120)) throw new Error('Invalid caption character target.');
  if (s.bold !== undefined && typeof s.bold !== 'boolean') throw new Error('Invalid caption font weight.');
  let previous = -1;
  const words = c.words.map(w => {
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < previous || w.start < 0 || w.end <= w.start || typeof w.text !== 'string' || w.text.length > 200 || /[\r\n]/.test(w.text)) throw new Error('Invalid caption words.');
    previous = w.end; return {start:w.start,end:w.end,text:w.text};
  });
  return {enabled:c.enabled, words, style: {...s}};
}
const color = value => '&H00' + value.slice(5,7) + value.slice(3,5) + value.slice(1,3);
const time = n => { const cs = Math.max(0, Math.round(n*100)); return Math.floor(cs/360000)+':'+String(Math.floor(cs/6000)%60).padStart(2,'0')+':'+String(Math.floor(cs/100)%60).padStart(2,'0')+'.'+String(cs%100).padStart(2,'0'); };
const escape = text => text.split(String.fromCharCode(92)).join('').replace(/[{}]/g,'');
function captionLines(words, fontSize = 64) {
  const lines = []; let line = [], length = 0;
  const limit = Math.floor(950 / (fontSize * .6));
  for (const word of words) {
    if (line.length && (line.length >= 3 || length + word.text.length + 1 > limit)) { lines.push(line); line = []; length = 0; }
    line.push(word); length += word.text.length + 1;
  }
  if (line.length) lines.push(line);
  return lines;
}

function captionGroups(words, style) {
    const groups = [];
    let current = [];
    const target = style?.charsPerCaption ?? 30;
    const fontSize = style?.fontSize ?? 64;
    const maxLines = Math.max(1, Math.floor((1728 - fontSize * (style?.highlightScale ?? 1)) / (fontSize * (style?.lineHeight ?? 1))) + 1);
    for (const word of words) {
        const previous = current[current.length - 1];
        const length = current.map(w => w.text).join(' ').length, nextLength = length + 1 + word.text.length;
        const atTarget = nextLength > target && Math.abs(length - target) <= Math.abs(nextLength - target);
        const tooTall = captionLines([...current, word], fontSize).length > maxLines;
        if (previous && (atTarget || tooTall || word.start - previous.end >= .5 || /[.!?]$/.test(previous.text))) {
            groups.push(current);
            current = [];
        }
        current.push(word);
    }
    if (current.length)
        groups.push(current);
    return groups;
}
exports.captionGroups = captionGroups;

function captionCenter(style, lineCount) {
  const half = ((lineCount - 1) * style.fontSize * (style.lineHeight ?? 1) + style.fontSize * style.highlightScale) / 2;
  const margin = 96 + style.outlineWidth;
  return Math.max(margin + half, Math.min(1920 - margin - half, 1920 * (style.positionY ?? 70) / 100));
}
function captionLineScale(words, style) {
    const units = [...words.map(w => w.text).join(' ')].reduce((sum, ch) => sum + (/\s/.test(ch) ? .35 : /[ilIjt.,!|]/.test(ch) ? .38 : /[MWmw@]/.test(ch) ? 1.05 : .72), 0);
    return Math.min(1, 950 / Math.max(1, units * style.fontSize * style.highlightScale));
}
exports.captionLineScale = captionLineScale;

function captionAss(short) {
  const c = validateCaptions(short.settings.captions); if (!c?.enabled) return '';
  if (!c.words.length) throw new Error('Generate the transcription before rendering.');
  const s = c.style;
  let result = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n';
  result += 'Style: Default,'+[s.font,s.fontSize,color(s.color),color(s.color),color(s.outline),color(s.shadow),s.font !== 'Impact' || s.bold ? -1 : 0,0,0,0,100,100,0,0,1,s.outlineWidth,3,2,65,65,350,1].join(',')+'\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  let cursor = 0;
  const segments = short.ranges.map((cut,i) => {
    const previous = short.ranges[i-1];
    const overlap = previous && short.settings.transition !== 'cut' ? Math.min(short.settings.transitionSeconds,(previous.end-previous.start)/2,(cut.end-cut.start)/2) : 0;
    const begin = cursor - overlap; cursor = begin + cut.end - cut.start;
    return {cut, begin, end:cursor, overlap};
  });
  segments.forEach((segment,i) => {
    const { cut, begin, overlap } = segment, next = segments[i+1];
    // A transition has one caption owner, switching with the dominant image at its midpoint.
    const from = cut.start + overlap / 2, to = cut.end - (next?.overlap ?? 0) / 2;
    const words = c.words.filter(w => w.end > from && w.start < to)
      .map(w => ({...w, start:Math.max(w.start,from), end:Math.min(w.end,to)}));
    const slash = String.fromCharCode(92);
    for (const group of captionGroups(words, s)) {
      const lines = captionLines(group, s.fontSize);
      const emit = (start, stop, active) => {
        const outputStart = time(begin + start - cut.start), outputEnd = time(begin + stop - cut.start);
        if (outputStart === outputEnd || stop <= start) return;
        lines.forEach((line,lineIndex) => {
          const y = captionCenter(s, lines.length) + (lineIndex - (lines.length - 1) / 2) * s.fontSize * (s.lineHeight ?? 1);
          const scale = Math.round(captionLineScale(line, s) * 10000) / 100;
          const position = '{'+slash+'an5'+slash+'q2'+slash+'fscx'+scale+slash+'fscy'+scale+slash+'pos(540,'+Math.round(y)+')}';
          // Reset only the highlight; a style reset would also reset line alignment.
          const reset = '{'+slash+'c'+color(s.color)+slash+'fscx'+scale+slash+'fscy'+scale+'}';
          const text=line.map(w => w === active ? '{'+slash+'c'+color(s.highlight)+slash+'fscx'+s.highlightScale*scale+slash+'fscy'+s.highlightScale*scale+'}'+escape(w.text)+reset : escape(w.text)).join(' ');
          result+='Dialogue: 0,'+outputStart+','+outputEnd+',Default,,0,0,0,,'+position+text+'\n';
        });
      };
      group.forEach((word,index) => {
        emit(word.start,word.end,word);
        const nextWord = group[index+1];
        if (nextWord && nextWord.start > word.end) emit(word.end,nextWord.start,null);
      });
    }
  }); return result;
}
const CAPTION_FONTS = ['Arial', 'Verdana', 'Georgia', 'Impact', 'Comic Sans MS', 'Trebuchet MS', 'Tahoma', 'Times New Roman', 'Courier New'];
/** The Classic style the Short Editor starts with. Kept equal to `captionStyle()` in the web short-captions.ts. */
const defaultCaptionStyle = () => ({ color: '#ffffff', highlight: '#ffe600', shadow: '#000000', outline: '#000000', outlineWidth: 2, font: 'Verdana', fontSize: 99, highlightScale: 1.2, bold: true, lineHeight: 1, positionY: 70, charsPerCaption: 30 });
/** Kept equal to `captionPresets` in the web short-captions.ts. */
const CAPTION_PRESETS = [
  { name: 'Classic', description: 'White and yellow for clear reading', style: defaultCaptionStyle() },
  { name: 'Neon', description: 'Mint with a subtle outline', style: { ...defaultCaptionStyle(), fontSize: 88, highlight: '#6ee7b7', outline: '#142b2a', shadow: '#071916', outlineWidth: 2, highlightScale: 1.05 } },
  { name: 'Impact', description: 'Strong type with an amber highlight', style: { ...defaultCaptionStyle(), font: 'Impact', bold: false, fontSize: 104, color: '#fffaf2', highlight: '#ffb454', outline: '#241b13', outlineWidth: 2, highlightScale: 1.1, charsPerCaption: 24 } },
  { name: 'Minimal', description: 'Light text with soft blue accents', style: { ...defaultCaptionStyle(), font: 'Arial', fontSize: 82, color: '#f8fafc', highlight: '#93c5fd', outline: '#172033', shadow: '#0f172a', outlineWidth: 1, highlightScale: 1 } },
  { name: 'Editorial', description: 'Serif type in warm tones', style: { ...defaultCaptionStyle(), font: 'Georgia', fontSize: 88, color: '#fff7ed', highlight: '#f2c078', outline: '#292119', shadow: '#17130f', outlineWidth: 1, highlightScale: 1.05 } }
];

/**
 * Captions as an assistant sends them: only what changes. `preset` picks one of
 * the named styles, `style` overrides single fields, and words already
 * transcribed are kept when none are sent. A complete object (what the window
 * sends) comes out exactly as it went in.
 */
function mergeCaptions(current, incoming) {
  if (incoming === undefined) return current;
  if (incoming === null || typeof incoming !== 'object') throw new Error('Invalid captions.');
  let preset = null;
  if (incoming.preset !== undefined) {
    preset = CAPTION_PRESETS.find(item => item.name.toLowerCase() === String(incoming.preset).toLowerCase());
    if (!preset) throw new Error(`Unknown caption preset. Choose one of ${CAPTION_PRESETS.map(item => item.name).join(', ')}.`);
  }
  const base = current || { enabled: false, words: [], style: defaultCaptionStyle() };
  return {
    enabled: incoming.enabled ?? base.enabled ?? false,
    words: incoming.words ?? base.words ?? [],
    style: { ...defaultCaptionStyle(), ...(base.style || {}), ...(preset ? preset.style : {}), ...(incoming.style || {}) }
  };
}

/** What was said, in readable lines with their source times, for choosing moments. */
function transcriptSegments(words, from = -Infinity, to = Infinity) {
  const segments = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    segments.push({ start: Math.round(current[0].start * 100) / 100, end: Math.round(current[current.length - 1].end * 100) / 100, text: current.map(w => w.text.trim()).join(' ') });
    current = [];
  };
  for (const word of words || []) {
    if (word.end <= from || word.start >= to) continue;
    const previous = current[current.length - 1];
    if (previous && (word.start - previous.end >= 0.7 || /[.!?]$/.test(previous.text.trim()) || current.length >= 25)) flush();
    current.push(word);
  }
  flush();
  return segments;
}

module.exports={validateCaptions,captionAss,captionGroups,mergeCaptions,transcriptSegments,defaultCaptionStyle,CAPTION_PRESETS,CAPTION_FONTS};
