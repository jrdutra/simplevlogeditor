import { ImageFormatOption, TextAnimation, VideoFormatOption } from './text-video.models';

/**
 * The containers the video can be written to.
 *
 * Each entry pairs a container with codecs that container actually accepts —
 * the pairing is a constraint of the format, not a preference, and getting it
 * wrong fails when the encoder starts rather than when the reader picks.
 */
export const VIDEO_FORMATS: readonly VideoFormatOption[] = [
  {
    id: 'mp4',
    label: 'MP4 · H.264 + AAC',
    extension: 'mp4',
    mimeType: 'video/mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    note: 'Plays everywhere — phones, TVs, editors and every social network. Pick this unless you need something else.'
  },
  {
    id: 'webm',
    label: 'WebM · VP9 + Opus',
    extension: 'webm',
    mimeType: 'video/webm',
    videoCodec: 'vp9',
    audioCodec: 'opus',
    note: 'Smaller at the same quality and royalty-free, but older players and some editors refuse it.'
  },
  {
    id: 'mkv',
    label: 'MKV · H.264 + AAC',
    extension: 'mkv',
    mimeType: 'video/x-matroska',
    videoCodec: 'avc',
    audioCodec: 'aac',
    note: 'A flexible archival container. Desktop players open it; browsers and phones often do not.'
  },
  {
    id: 'mov',
    label: 'MOV · H.264 + AAC',
    extension: 'mov',
    mimeType: 'video/quicktime',
    videoCodec: 'avc',
    audioCodec: 'aac',
    note: 'QuickTime. What Final Cut and Premiere expect on macOS.'
  }
] as const;

export const IMAGE_FORMATS: readonly ImageFormatOption[] = [
  {
    id: 'png',
    label: 'PNG',
    extension: 'png',
    mimeType: 'image/png',
    keepsAlpha: true,
    note: 'Lossless and the only one here that keeps transparency. The default for artwork with text on it.'
  },
  {
    id: 'jpeg',
    label: 'JPEG',
    extension: 'jpg',
    mimeType: 'image/jpeg',
    keepsAlpha: false,
    note: 'Much smaller and universally accepted, but no transparency and slight artefacts around sharp letters.'
  },
  {
    id: 'webp',
    label: 'WebP',
    extension: 'webp',
    mimeType: 'image/webp',
    keepsAlpha: true,
    note: 'Smaller than both at the same quality, with transparency. Every current browser reads it; some old software does not.'
  }
] as const;

/** Output sizes, from the shapes people actually publish. */
export const RESOLUTIONS = [
  { id: '1920x1080', label: '1080p landscape · 16:9', width: 1920, height: 1080 },
  { id: '1280x720', label: '720p landscape · 16:9', width: 1280, height: 720 },
  { id: '3840x2160', label: '4K landscape · 16:9', width: 3840, height: 2160 },
  { id: '1080x1920', label: '1080p vertical · 9:16', width: 1080, height: 1920 },
  { id: '1080x1350', label: 'Portrait · 4:5', width: 1080, height: 1350 },
  { id: '1080x1080', label: 'Square · 1:1', width: 1080, height: 1080 }
] as const;

export type ResolutionId = typeof RESOLUTIONS[number]['id'];

export const FRAME_RATES = [24, 30, 60] as const;

/**
 * Type families offered.
 *
 * Only stacks the browser can satisfy without downloading anything: a font that
 * has to be fetched would render one way in the preview and another in the
 * encoder if it arrived late, which is the one failure this tool cannot show
 * the reader.
 */
export const FONTS = [
  { id: 'sans', label: 'Sans · Inter, Segoe, Helvetica', stack: '"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { id: 'serif', label: 'Serif · Georgia, Times', stack: 'Georgia, "Times New Roman", Times, serif' },
  { id: 'mono', label: 'Monospace · Consolas, Menlo', stack: '"Cascadia Code", Consolas, Menlo, "Courier New", monospace' },
  { id: 'condensed', label: 'Condensed · Impact, Haettenschweiler', stack: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif' },
  { id: 'rounded', label: 'Rounded · Trebuchet, Verdana', stack: '"Trebuchet MS", Verdana, Geneva, sans-serif' }
] as const;

export type FontId = typeof FONTS[number]['id'];

export const ANIMATIONS: readonly { id: TextAnimation; label: string; note: string }[] = [
  { id: 'none', label: 'None', note: 'The text is simply there from the first frame.' },
  {
    id: 'fade',
    label: 'Fade in',
    note: 'The whole block appears together, from nothing to solid. The quietest of them.'
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    note: 'One letter at a time, with a cursor that blinks until the line is finished.'
  },
  {
    id: 'rise',
    label: 'Rising letters',
    note: 'Each letter floats up into place and fades in, one just after the other.'
  },
  {
    id: 'blur-words',
    label: 'Words out of focus',
    note: 'Each word arrives slightly large and out of focus, then settles. Reads like an opening title.'
  },
  {
    id: 'mask-zoom',
    label: 'Wipe reveal with slow zoom',
    note: 'A band sweeps across each line to uncover it while the background drifts closer. The cinematic one.'
  },
  {
    id: 'scale-up',
    label: 'Scale up',
    note: 'The block grows into place from slightly small, overshooting a little before it settles.'
  },
  {
    id: 'slide-lines',
    label: 'Lines from the sides',
    note: 'Each line slides in from alternating edges, one just after the other.'
  },
  {
    id: 'word-drop',
    label: 'Words drop in',
    note: 'Words fall from above and bounce once, in the order they are read.'
  },
  {
    id: 'tracking-in',
    label: 'Letters draw together',
    note: 'The letters start spread far apart and close on their real spacing as they fade in.'
  },
  {
    id: 'line-reveal',
    label: 'Uncovered from below',
    note: 'Each line is wiped upward into view, as if rising from behind an edge.'
  },
  {
    id: 'glitch',
    label: 'Glitch',
    note: 'The letters arrive split into colour channels and jittering, then snap into register.'
  }
];

export const WEIGHTS = [
  { value: 400, label: 'Regular' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 900, label: 'Black' }
] as const;

export const LEGIBILITY_OPTIONS = [
  { id: 'none', label: 'None', note: 'Nothing behind the letters.' },
  { id: 'shadow', label: 'Drop shadow', note: 'A soft dark shadow. The gentlest way to hold text over a photo.' },
  { id: 'outline', label: 'Outline', note: 'A dark edge drawn around each letter. Survives the busiest backgrounds.' },
  { id: 'band', label: 'Band behind text', note: 'A translucent panel behind the block. Guarantees contrast anywhere.' }
] as const;

/** Bounds and starting points for every number the reader can set. */
export const LIMITS = {
  fontScale: { min: 0.02, max: 0.3, step: 0.005, default: 0.09 },
  margin: { min: 0, max: 0.25, step: 0.005, default: 0.07 },
  lineHeight: { min: 0.9, max: 2.5, step: 0.05, default: 1.25 },
  letterSpacing: { min: -0.05, max: 0.5, step: 0.01, default: 0 },
  reveal: { min: 0.2, max: 60, step: 0.1, default: 2.5 },
  hold: { min: 0, max: 60, step: 0.1, default: 2 },
  fade: { min: 0.1, max: 10, step: 0.1, default: 1 },
  quality: { min: 0.5, max: 1, step: 0.05, default: 0.92 }
} as const;

/** Seconds of reveal per character, used to propose a reveal time. */
const SECONDS_PER_CHARACTER = 0.055;

/**
 * A reveal time that suits the amount of text.
 *
 * Proposed rather than imposed: the field stays editable, but a headline and a
 * paragraph should not default to the same two and a half seconds.
 */
export function suggestedReveal(text: string, animation: TextAnimation): number {
  const characters = text.replace(/\s+/g, ' ').trim().length;
  if (!characters || animation === 'none') return LIMITS.reveal.default;

  const seconds = characters * SECONDS_PER_CHARACTER;
  return Math.min(LIMITS.reveal.max, Math.max(1, Math.round(seconds * 10) / 10));
}

export function videoFormat(id: string): VideoFormatOption {
  return VIDEO_FORMATS.find((format) => format.id === id) ?? VIDEO_FORMATS[0];
}

export function imageFormat(id: string): ImageFormatOption {
  return IMAGE_FORMATS.find((format) => format.id === id) ?? IMAGE_FORMATS[0];
}

export function resolution(id: string): typeof RESOLUTIONS[number] {
  return RESOLUTIONS.find((option) => option.id === id) ?? RESOLUTIONS[0];
}

export function fontStack(id: string): string {
  return (FONTS.find((font) => font.id === id) ?? FONTS[0]).stack;
}
