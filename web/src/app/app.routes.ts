import { Routes } from '@angular/router';

import { HomeComponent } from './home/home.component';
import { SeoData } from './seo.service';
import { TOOL_BY_ROUTE, TOOL_ITEMS } from './tools.data';

/**
 * The description a tool page carries into its `<head>`.
 *
 * Built from the catalogue rather than written out again here, so a tool that
 * is renamed or re-described on its card is renamed and re-described in search
 * results too. A route naming a tool that does not exist is a build error, not
 * a page that quietly ships with no title.
 */
function toolSeo(rota: string, title: string, keywords: string): SeoData {
  const tool = TOOL_BY_ROUTE.get(rota);
  if (!tool) throw new Error(`No catalogue entry for the route "${rota}".`);

  return {
    title,
    description: `${tool.resumo} Free, in your browser — nothing is uploaded.`,
    keywords,
    canonicalPath: `/${rota}`,
    imagePath: tool.image,
    imageAlt: tool.imageAlt,
    imageWidth: tool.imageWidth,
    imageHeight: tool.imageHeight,
    application: { name: `${tool.titulo} — ${'SimpleVlogEditor'}`, description: tool.resumo }
  };
}

const seo = {
  home: {
    title: 'Free Video & Audio Tools for Vloggers',
    description:
      'Six free browser tools for vlogs: edit video, cut silence, merge clips, remove background noise, transcribe to subtitles and turn text into video. No sign-up, no upload, no watermark.',
    keywords:
      'free video editor online, cut silence from video, merge video and audio, remove background noise from video, video to subtitles, srt generator, text to video, browser video editor, no upload video editor, vlog editing tools',
    canonicalPath: '/',
    imagePath: '/assets/tools/video-editor-cover.jpg',
    imageAlt: 'SimpleVlogEditor — free browser-based video and audio tools for vloggers',
    imageWidth: 1200,
    imageHeight: 629,
    toolItems: TOOL_ITEMS
  } satisfies SeoData,

  videoEditor: toolSeo(
    'video-editor',
    'Free Online Video Editor — No Upload, No Watermark',
    'free online video editor, browser video editor, cut video online, add captions to video, zoom video editor, no watermark video editor'
  ),
  silenceCutter: toolSeo(
    'free-silence-cutter',
    'Free Silence Cutter — Remove Dead Air from Video & Audio',
    'silence cutter, remove silence from video, cut dead air, jump cut editor, auto silence removal, podcast silence remover'
  ),
  mediaMerger: toolSeo(
    'media-merger',
    'Video & Audio Merger — Join Clips Into One File',
    'merge videos online, join video and audio, combine clips, video joiner, concatenate mp4, add music to video'
  ),
  noiseRemover: toolSeo(
    'background-noise-remover',
    'Background Noise Remover — Keeps the Voice',
    'remove background noise from video, noise removal online, clean up audio, denoise voice recording, remove fan noise, ai noise suppression'
  ),
  videoTranscription: toolSeo(
    'video-transcription',
    'Video Transcription — Free SRT, VTT & SBV Subtitle Generator',
    'video transcription, generate subtitles, srt generator, vtt subtitles, transcribe audio free, automatic captions'
  ),
  textVideoMaker: toolSeo(
    'text-video-maker',
    'Text Video Maker — Animate Text Over a Photo',
    'text to video, animated text video, title card maker, intro maker, text over image video, quote video maker'
  )
};

export const routes: Routes = [
  { path: '', component: HomeComponent, pathMatch: 'full', data: { seo: seo.home } },
  {
    path: 'video-editor',
    loadComponent: () =>
      import('./ferramentas/editor-de-video/editor-de-video.component').then((m) => m.EditorDeVideoComponent),
    data: { seo: seo.videoEditor }
  },
  {
    path: 'free-silence-cutter',
    loadComponent: () =>
      import('./ferramentas/cortador-de-silencio/cortador-de-silencio.component').then(
        (m) => m.CortadorDeSilencioComponent
      ),
    data: { seo: seo.silenceCutter }
  },
  {
    path: 'media-merger',
    loadComponent: () =>
      import('./ferramentas/juntador-de-midias/juntador-de-midias.component').then((m) => m.JuntadorDeMidiasComponent),
    data: { seo: seo.mediaMerger }
  },
  {
    path: 'background-noise-remover',
    loadComponent: () =>
      import('./ferramentas/supressao-de-ruido/supressao-de-ruido.component').then((m) => m.SupressaoDeRuidoComponent),
    data: { seo: seo.noiseRemover }
  },
  {
    path: 'video-transcription',
    loadComponent: () =>
      import('./ferramentas/transcricao-de-video/transcricao-de-video.component').then(
        (m) => m.TranscricaoDeVideoComponent
      ),
    data: { seo: seo.videoTranscription }
  },
  {
    path: 'text-video-maker',
    loadComponent: () =>
      import('./ferramentas/criador-de-video-texto/criador-de-video-texto.component').then(
        (m) => m.CriadorDeVideoTextoComponent
      ),
    data: { seo: seo.textVideoMaker }
  },
  { path: '**', redirectTo: '' }
];
