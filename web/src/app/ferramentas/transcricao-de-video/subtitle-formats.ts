/** One line of speech, in seconds from the start of the recording. */
export interface Cue {
  start: number;
  end: number;
  text: string;
  /** A participant label supplied by the reviewer, never inferred from a voice. */
  speaker?: string;
}

/**
 * The rules a readable subtitle obeys.
 *
 * Defaults are the ones broadcast subtitling settled on long ago: about two
 * lines of forty-odd characters, on screen for at least a second and at most
 * seven, at a reading speed nobody has to chase.
 */
export interface CueShape {
  /** Characters before a cue is broken onto a second line. */
  lineLength: number;
  /** Lines a single cue may have. Past this it is split into two cues. */
  maxLines: number;
  /** Shortest a cue may stay on screen, however few words it holds. */
  minSeconds: number;
  /** Longest a cue may stay, however long the recogniser thought it ran. */
  maxSeconds: number;
  /**
   * Gap left between one cue and the next, in seconds.
   *
   * Without it two cues that touch can be rendered as one run-on line by a
   * player that rounds timestamps to whole frames.
   */
  gapSeconds: number;
}

export const DEFAULT_SHAPE: CueShape = {
  lineLength: 42,
  maxLines: 2,
  minSeconds: 1,
  maxSeconds: 7,
  gapSeconds: 0.04
};

export const SHAPE_LIMITS = {
  lineLength: { min: 20, max: 90, step: 1 },
  maxLines: { min: 1, max: 3, step: 1 },
  minSeconds: { min: 0.3, max: 4, step: 0.1 },
  maxSeconds: { min: 2, max: 15, step: 0.5 }
} as const;

/** Collapses the whitespace a recogniser leaves around its chunks. */
export function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Breaks one line into as many as it takes to stay inside a width.
 *
 * Words first; a single word longer than the whole line is broken by character,
 * because the alternative is a line that runs off the side of the picture.
 */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(8, Math.round(width));
  const lines: string[] = [];
  let line = '';

  const push = () => {
    if (line) lines.push(line);
    line = '';
  };

  for (const word of tidy(text).split(' ')) {
    if (!word) continue;

    if (word.length > room) {
      push();
      const characters = Array.from(word);
      for (let at = 0; at < characters.length; at += room) lines.push(characters.slice(at, at + room).join(''));
      continue;
    }

    if (!line) line = word;
    else if (line.length + 1 + word.length <= room) line = `${line} ${word}`;
    else {
      push();
      line = word;
    }
  }

  push();
  return lines.length ? lines : [''];
}

/**
 * Turns what the recogniser heard into cues a person can read.
 *
 * Four things happen here, in order, and the order matters:
 *
 * 1. Empty chunks are dropped. A model asked for timestamps will happily return
 *    a chunk holding nothing but a space.
 * 2. A chunk too long to fit the shape is split across as many cues as it needs,
 *    with its seconds shared out in proportion to the characters — an even split
 *    would leave the short half sitting on screen as long as the long one.
 * 3. Minimum display time is applied where the media and next cue allow it.
 * 4. Overlaps are pushed apart, because a recogniser's end and the next chunk's
 *    start are two independent guesses and nothing makes them agree.
 */
export function shapeCues(chunks: readonly Cue[], shape: CueShape = DEFAULT_SHAPE, duration = Infinity): Cue[] {
  duration = duration === Infinity ? Infinity : Math.floor(Math.max(0, duration) * 1000) / 1000;
  shape = { ...DEFAULT_SHAPE, ...shape };
  for (const field of Object.keys(SHAPE_LIMITS) as (keyof typeof SHAPE_LIMITS)[]) {
    const limit = SHAPE_LIMITS[field];
    shape[field] = Math.min(limit.max, Math.max(limit.min, Number.isFinite(shape[field]) ? shape[field] : DEFAULT_SHAPE[field]));
  }
  shape.maxLines = Math.round(shape.maxLines);
  shape.minSeconds = Math.min(shape.minSeconds, shape.maxSeconds);
  shape.gapSeconds = Number.isFinite(shape.gapSeconds) ? Math.max(0, shape.gapSeconds) : DEFAULT_SHAPE.gapSeconds;
  const out: Cue[] = [];

  for (const chunk of [...chunks].filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start < duration).sort((a, b) => a.start - b.start)) {
    const text = tidy(chunk.text);
    if (!text) continue;

    const start = Math.max(0, chunk.start);
    const end = Math.min(duration, Math.max(start + 0.001, chunk.end));
    const lines = wrap(text, shape.lineLength);

    if (lines.length <= shape.maxLines) {
      out.push({ ...chunk, start, end, text: lines.join('\n') });
      continue;
    }

    // Too long for one cue. Split into runs of at most `maxLines` lines and
    // hand each run the share of the seconds its characters deserve.
    const runs: string[] = [];
    for (let at = 0; at < lines.length; at += shape.maxLines) {
      runs.push(lines.slice(at, at + shape.maxLines).join('\n'));
    }

    const weight = runs.reduce((total, run) => total + Math.max(1, run.length), 0);
    let cursor = start;
    for (const [index, run] of runs.entries()) {
      const share = ((end - start) * Math.max(1, run.length)) / weight;
      const stop = index === runs.length - 1 ? end : cursor + share;
      out.push({ ...chunk, start: cursor, end: stop, text: run });
      cursor = stop;
    }
  }

  for (const cue of out) {
    cue.start = Math.floor(cue.start * 1000) / 1000;
    cue.end = Math.min(duration, Math.round(cue.end * 1000) / 1000);
  }
  out.sort((a, b) => a.start - b.start);
  // Co-located chunks cannot be separate positive-duration captions.
  for (let index = out.length - 2; index >= 0; index--) {
    if (out[index + 1].start - out[index].start < 0.001) {
      out[index].text += '\n' + out[index + 1].text;
      out[index].end = Math.max(out[index].end, out[index + 1].end);
      out.splice(index + 1, 1);
    }
  }
  for (const [index, cue] of out.entries()) {
    // Never hide recognized speech just to satisfy a maximum hold preference.
    // Word-level grouping splits at real word boundaries before this stage.
    cue.end = Math.min(duration, Math.max(cue.end, cue.start + shape.minSeconds));
    const next = out[index + 1];
    if (next) {
      const gap = Math.min(shape.gapSeconds, Math.max(0, next.start - cue.start - 0.001));
      cue.end = Math.min(cue.end, next.start - gap);
    }
    cue.start = Math.round(cue.start * 1000) / 1000;
    cue.end = Math.min(duration, Math.max(cue.start + 0.001, Math.round(cue.end * 1000) / 1000));
  }

  return out;
}

/* ------------------------------------------------------------------ clocks */

function parts(seconds: number): { h: number; m: number; s: number; ms: number } {
  const total = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000);
  const whole = Math.floor(total / 1000);
  return {
    h: Math.floor(whole / 3600),
    m: Math.floor((whole % 3600) / 60),
    s: whole % 60,
    ms: total % 1000
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `00:01:23,456` — SubRip, comma before the milliseconds. */
export function srtTime(seconds: number): string {
  const { h, m, s, ms } = parts(seconds);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** `0:00:01.456` — SubViewer, no padding on the hour and three decimals. */
export function sbvTime(seconds: number): string {
  const { h, m, s, ms } = parts(seconds);
  return `${h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * `1:23` — the clock a person reads, and the one YouTube's transcript panel
 * shows. Hours only appear once there are any, because `0:01:23` on a two
 * minute video reads as a machine talking.
 */
export function readableTime(seconds: number): string {
  const { h, m, s } = parts(seconds);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* ----------------------------------------------------------------- writers */

export type SubtitleFormat = 'srt' | 'sbv' | 'vtt' | 'txt-timed' | 'txt-plain';

export interface FormatDefinition {
  id: SubtitleFormat;
  label: string;
  extension: string;
  mimeType: string;
  /** One line saying what it is for, shown beside the download button. */
  note: string;
  /** True for the two YouTube reads as captions. */
  captions: boolean;
}

export const SUBTITLE_FORMATS: readonly FormatDefinition[] = [
  { id: 'vtt', label: 'WebVTT', extension: 'vtt', mimeType: 'text/vtt', captions: true,
    note: 'Timed captions for HTML video players and platforms that accept WebVTT.' },
  {
    id: 'srt',
    label: 'SubRip',
    extension: 'srt',
    mimeType: 'text/plain',
    note: 'Upload this one. YouTube lists it first and every other player reads it too.',
    captions: true
  },
  {
    id: 'sbv',
    label: 'SubViewer',
    extension: 'sbv',
    mimeType: 'text/plain',
    note: "YouTube's own caption format. Plainer than SubRip and accepted the same way.",
    captions: true
  },
  {
    id: 'txt-timed',
    label: 'Text with timings',
    extension: 'txt',
    mimeType: 'text/plain',
    note: 'For people, not for the caption uploader: a description, a chapter list, a transcript to read.',
    captions: false
  },
  {
    id: 'txt-plain',
    label: 'Text only',
    extension: 'txt',
    mimeType: 'text/plain',
    note: 'The words with no timings, for YouTube’s "transcribe and auto-sync" box.',
    captions: false
  }
];

/**
 * SubRip. A number, a timing line with an arrow, the text, a blank line.
 *
 * Numbered from one and counting up without a gap: some parsers use the number
 * to order the file rather than trusting the timings.
 */
export function toSrt(cues: readonly Cue[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${captionText(cue)}\n`)
    .join('\n');
}

export function captionText(cue: Cue): string {
  const speaker = tidy(cue.speaker ?? '');
  return speaker ? `${speaker}: ${cue.text}` : cue.text;
}

export function toVtt(cues: readonly Cue[]): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return 'WEBVTT\n\n' + cues.map(cue =>
    `${srtTime(cue.start).replace(',', '.')} --> ${srtTime(cue.end).replace(',', '.')}\n${escape(captionText(cue))}\n`
  ).join('\n');
}

/** Review indicators, not confidence scores or probabilities of correctness. */
export function cueWarnings(cue: Cue, shape: CueShape = DEFAULT_SHAPE): string[] {
  const warnings: string[] = [];
  const duration = cue.end - cue.start;
  if (!Number.isFinite(duration) || duration <= 0) return ['Invalid timing'];
  const cps = Array.from(tidy(cue.text)).length / duration;
  if (cps > 20) warnings.push(`Fast reading: ${Math.round(cps)} characters/s`);
  if (duration < shape.minSeconds) warnings.push('Short display time');
  if (duration > shape.maxSeconds + 0.001) warnings.push('Long display time');
  if (cue.text.split('\n').length > shape.maxLines || cue.text.split('\n').some(line => Array.from(line).length > shape.lineLength)) {
    warnings.push('Text exceeds caption shape');
  }
  return warnings;
}

/**
 * SubViewer. The two times on one line separated by a comma, then the text.
 *
 * YouTube’s basic SBV format uses newlines within captions.
 */
export function toSbv(cues: readonly Cue[]): string {
  return cues
    .map((cue) => `${sbvTime(cue.start)},${sbvTime(cue.end)}\n${captionText(cue)}\n`)
    .join('\n');
}

/**
 * The transcript a person reads: the time on its own line, then the words.
 *
 * Line breaks inside a cue are undone here. They exist to fit a subtitle into
 * the width of a picture, and this file is not going into a picture.
 */
export function toTimedText(cues: readonly Cue[]): string {
  return cues.map((cue) => `${readableTime(cue.start)}\n${captionText(cue).replace(/\n/g, ' ')}`).join('\n\n') + '\n';
}

/** Just the words, one cue a line, for the platform to line up itself. */
export function toPlainText(cues: readonly Cue[]): string {
  return cues.map((cue) => captionText(cue).replace(/\n/g, ' ')).join('\n') + '\n';
}

export function writeSubtitles(cues: readonly Cue[], format: SubtitleFormat): string {
  switch (format) {
    case 'srt': return toSrt(cues);
    case 'vtt': return toVtt(cues);
    case 'sbv': return toSbv(cues);
    case 'txt-timed': return toTimedText(cues);
    default: return toPlainText(cues);
  }
}

/** Seconds of speech the cues cover, for the summary line. */
export function spokenSeconds(cues: readonly Cue[]): number {
  let end = 0, total = 0;
  for (const cue of [...cues].filter(c => Number.isFinite(c.start) && Number.isFinite(c.end)).sort((a, b) => a.start - b.start)) {
    total += Math.max(0, cue.end - Math.max(0, end, cue.start));
    end = Math.max(end, cue.end);
  }
  return total;
}

/** Words in the transcript, counted the way a person would. */
export function wordCount(cues: readonly Cue[]): number {
  return cues.reduce((total, cue) => total + tidy(cue.text).split(/\s+/).filter(Boolean).length, 0);
}
