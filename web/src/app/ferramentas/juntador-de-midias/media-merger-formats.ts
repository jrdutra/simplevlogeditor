import { OutputFormatOption, ResolutionPreset } from './media-merger.models';

/**
 * The containers the merged result can be written to.
 *
 * Every entry pairs a container with the codecs that container actually
 * accepts — the pairing is not a preference, it is a constraint of the format,
 * and getting it wrong fails at `output.start()` rather than at the picker.
 * The order is the order of the selector, and the first entry is the default.
 */
export const VIDEO_FORMATS: readonly OutputFormatOption[] = [
  {
    id: 'mp4',
    label: 'MP4 · H.264 + AAC',
    extension: 'mp4',
    mimeType: 'video/mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    note: 'Plays everywhere: phones, TVs, editors and every browser. Pick this unless you need something else.'
  },
  {
    id: 'webm',
    label: 'WebM · VP9 + Opus',
    extension: 'webm',
    mimeType: 'video/webm',
    videoCodec: 'vp9',
    audioCodec: 'opus',
    note: 'Smaller files at the same quality and royalty-free, but older players and some editors refuse it.'
  },
  {
    id: 'mkv',
    label: 'MKV · H.264 + AAC',
    extension: 'mkv',
    mimeType: 'video/x-matroska',
    videoCodec: 'avc',
    audioCodec: 'aac',
    note: 'A flexible archival container. VLC and most desktop players open it; browsers and phones often do not.'
  },
  {
    id: 'mov',
    label: 'MOV · H.264 + AAC',
    extension: 'mov',
    mimeType: 'video/quicktime',
    videoCodec: 'avc',
    audioCodec: 'aac',
    note: 'QuickTime. The format Final Cut and Premiere expect on macOS.'
  }
] as const;

export const AUDIO_FORMATS: readonly OutputFormatOption[] = [
  {
    id: 'm4a',
    label: 'M4A · AAC',
    extension: 'm4a',
    mimeType: 'audio/mp4',
    videoCodec: null,
    audioCodec: 'aac',
    note: 'Compressed, small and universal — the audio half of MP4.'
  },
  {
    id: 'mp3',
    label: 'MP3',
    extension: 'mp3',
    mimeType: 'audio/mpeg',
    videoCodec: null,
    audioCodec: 'mp3',
    note: 'The most portable audio format there is. Encoding it downloads a small extra component the first time.'
  },
  {
    id: 'ogg',
    label: 'OGG · Opus',
    extension: 'ogg',
    mimeType: 'audio/ogg',
    videoCodec: null,
    audioCodec: 'opus',
    note: 'The best quality per kilobyte, especially for speech. Older players may not open it.'
  },
  {
    id: 'wav',
    label: 'WAV · PCM 16-bit',
    extension: 'wav',
    mimeType: 'audio/wav',
    videoCodec: null,
    audioCodec: 'pcm-s16',
    note: 'Uncompressed, so nothing is lost and nothing is small: expect about 10 MB per minute.'
  }
] as const;

/** The picture sizes offered, in the order of the selector. */
export const RESOLUTIONS: readonly { value: ResolutionPreset; label: string; hint: string }[] = [
  { value: 'auto', label: 'Match the largest clip', hint: 'Uses the biggest picture in the queue, so nothing is ever scaled up.' },
  { value: '3840x2160', label: '2160p (4K UHD)', hint: '3840 × 2160' },
  { value: '1920x1080', label: '1080p (Full HD)', hint: '1920 × 1080' },
  { value: '1280x720', label: '720p (HD)', hint: '1280 × 720' },
  { value: '854x480', label: '480p (SD)', hint: '854 × 480' }
] as const;

/** How long a still image stays on screen when nothing else decides for it. */
export const IMAGE_SECONDS = { default: 5, min: 0.1, max: 3600, step: 0.5 } as const;

/** How long each fade lasts by default, and how far it can be pushed. */
export const FADE_SECONDS = { default: 1, min: 0.1, max: 10, step: 0.1 } as const;

/** The pixel size of a preset, or `null` for the automatic one. */
export function resolutionSize(preset: ResolutionPreset): { width: number; height: number } | null {
  if (preset === 'auto') return null;
  const [width, height] = preset.split('x').map(Number);
  return { width, height };
}

export function videoFormat(id: string): OutputFormatOption {
  return VIDEO_FORMATS.find((format) => format.id === id) ?? VIDEO_FORMATS[0];
}

export function audioFormat(id: string): OutputFormatOption {
  return AUDIO_FORMATS.find((format) => format.id === id) ?? AUDIO_FORMATS[0];
}
