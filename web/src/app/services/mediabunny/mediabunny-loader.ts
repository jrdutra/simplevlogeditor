import type * as Mediabunny from 'mediabunny';

export type MediabunnyLib = typeof Mediabunny;

let pending: Promise<MediabunnyLib> | undefined;
let mp3Encoder: Promise<void> | undefined;

/**
 * Loads the media toolkit, in the browser and only once.
 *
 * The library is imported dynamically for two reasons: it must never run during
 * prerendering, where none of the APIs it drives exist, and it is by far the
 * heaviest thing these pages need — keeping it behind a dynamic import means a
 * reader who never opens a media tool never downloads it.
 *
 * The promise is shared across every tool that uses it, so opening the second
 * one costs nothing.
 */
export function loadMediabunny(): Promise<MediabunnyLib> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Media processing is only available in the browser.'));
  }

  pending ??= import('mediabunny');
  return pending;
}

/**
 * Makes MP3 encoding available, if the browser cannot already do it.
 *
 * No browser ships an MP3 *encoder* in WebCodecs — only a decoder — so writing
 * one requires LAME, compiled to WebAssembly. It is a few hundred kilobytes and
 * useless to every other output format, which is why it is fetched on demand
 * and only after the native capability has been ruled out.
 */
export async function ensureMp3Encoder(): Promise<void> {
  const library = await loadMediabunny();
  if (await library.canEncodeAudio('mp3')) return;

  mp3Encoder ??= import('@mediabunny/mp3-encoder').then(({ registerMp3Encoder }) => registerMp3Encoder());
  await mp3Encoder;
}
