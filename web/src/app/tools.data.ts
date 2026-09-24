/**
 * The catalogue of tools, and the single place that knows what each one is.
 *
 * The home grid renders it, the router builds its ItemList structured data from
 * it, and every tool page takes its title and description from the same entry —
 * so what a visitor reads on a card and what a search engine is told about the
 * page behind it cannot drift apart.
 */

export interface Tool {
  /** Card title, and the name used in structured data. */
  titulo: string;
  /** One line for the card. */
  descricao: string;
  /** Longer line for the tool page and its meta description. */
  resumo: string;
  /** Material icon drawn on the card's sprite badge. */
  icone: string;
  /** Route, without a leading slash. */
  rota: string;
  image: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
  novo: boolean;
}

export const TOOLS: readonly Tool[] = [
  {
    titulo: 'Video Editor',
    descricao: 'Cut silence, zoom, retime, caption and export.',
    resumo:
      'Cut silence, zoom after long pauses, change the speed, replace or level the sound, add captions and text cards, and export as video or audio.',
    icone: 'movie_edit',
    rota: 'video-editor',
    image: '/assets/tools/video-editor-card.jpg',
    imageAlt:
      'Neon illustration of a complete video editing workspace with timeline, media library and Claude and Codex AI integrations',
    imageWidth: 1200,
    imageHeight: 675,
    novo: true
  },
  {
    titulo: 'Silence Cutter',
    descricao: 'Remove the dead air from a take, automatically.',
    resumo:
      'Remove silent sections from video and audio directly in your browser, with the threshold and the padding under your control.',
    icone: 'content_cut',
    rota: 'free-silence-cutter',
    image: '/assets/tools/free-silence-cutter-card.jpg',
    imageAlt:
      'Neon audio waveform on a dark stage, with hatched blocks marking the silent sections to be cut, a playhead and a timeline below',
    imageWidth: 1200,
    imageHeight: 675,
    novo: true
  },
  {
    titulo: 'Media Merger',
    descricao: 'Join clips, music and stills into one file.',
    resumo:
      'Join videos, audio and images into one file, in the order you choose, with fades, and download as video or audio.',
    icone: 'video_library',
    rota: 'media-merger',
    image: '/assets/tools/media-merger-card.jpg',
    imageAlt:
      'Neon illustration of multiple video clips flowing into an editor and merging into one finished video',
    imageWidth: 1200,
    imageHeight: 675,
    novo: true
  },
  {
    titulo: 'Noise Remover',
    descricao: 'Strip the room, the fan and the street. Keep the voice.',
    resumo:
      'Remove background noise from video and audio in your browser and keep the voice, with the picture untouched.',
    icone: 'noise_control_off',
    rota: 'background-noise-remover',
    image: '/assets/tools/background-noise-remover-card.jpg',
    imageAlt:
      'Neon illustration comparing noisy input media with clean video and audio after AI noise removal',
    imageWidth: 1200,
    imageHeight: 675,
    novo: true
  },
  {
    titulo: 'Video Transcription',
    descricao: 'Subtitles from speech, corrected on screen.',
    resumo:
      'Transcribe video, audio or a recorded meeting in your browser, correct the captions on screen and export SRT, SBV, WebVTT or plain text.',
    icone: 'subtitles',
    rota: 'video-transcription',
    image: '/assets/tools/video-transcription-card.jpg',
    imageAlt:
      'Neon illustration of a video passing through AI speech recognition and becoming a timestamped text transcript',
    imageWidth: 1200,
    imageHeight: 675,
    novo: true
  },
  {
    titulo: 'Text Video Maker',
    descricao: 'Animate text over a photo and export a clip.',
    resumo:
      'Animate text over a photo or colour and export it as a video or a still image, with fades and background sound.',
    icone: 'text_fields',
    rota: 'text-video-maker',
    image: '/assets/tools/text-video-maker-card.jpg',
    imageAlt:
      'Neon illustration of a text document flowing into a video editor and becoming a finished vertical video',
    imageWidth: 1200,
    imageHeight: 675,
    novo: true
  },
  {
    titulo: 'Video Packaging',
    descricao: 'Create thumbnails and title ideas for horizontal videos.',
    resumo:
      'Generate thumbnails and title ideas designed for horizontal long-form videos.',
    icone: 'image_search',
    rota: 'video-packaging',
    image: '/assets/tools/video-packaging-card.jpg',
    imageAlt:
      'Neon illustration of an AI workspace generating three video thumbnails, title ideas and a description',
    imageWidth: 1200,
    imageHeight: 675,
    novo: true
  },
  {
    titulo: 'Shorts Generator',
    descricao: 'Turn horizontal videos into vertical short-form clips.',
    resumo:
      'Transform horizontal long-form videos into vertical shorts with reframing, captions and highlight extraction.',
    icone: 'view_day',
    rota: 'shorts-generator',
    image: '/assets/tools/shorts-generator-card.jpg',
    imageAlt:
      'Neon illustration of a horizontal video being reframed by AI into three vertical short-form videos',
    imageWidth: 1200,
    imageHeight: 675,
    novo: true
  }
];

/** Looked up by the tool pages to draw their own header. */
export const TOOL_BY_ROUTE = new Map(TOOLS.map((tool) => [tool.rota, tool]));

/** Flat list used to build the ItemList structured data of the home page. */
export const TOOL_ITEMS = TOOLS.map((tool) => ({
  name: tool.titulo,
  description: tool.resumo,
  path: `/${tool.rota}`
}));
