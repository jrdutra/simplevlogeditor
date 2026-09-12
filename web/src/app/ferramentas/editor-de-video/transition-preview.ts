/**
 * Getting one representative frame out of a clip, for the transition dialog.
 *
 * The dialog has to show the reader what a join will actually look like between
 * *their* two shots, which means real pictures rather than two coloured
 * rectangles. It does not, however, need moving ones: an animation between the
 * last frame of one clip and the first of the next is enough to judge every
 * transition in the catalogue, and it costs two seeks instead of two decoders.
 *
 * Everything here fails soft. A frame that cannot be grabbed comes back null and
 * the painter draws black for that side — a preview with one black half is worth
 * more than a dialog that will not open.
 */

import { EditorClip, isMediaClip } from './video-editor.models';
import { imageBitmapForFile, mediaObjectUrl } from '../../shared/desktop/path-backed-file';

/** How far from the edge of a clip to sample, so a black first frame is skipped. */
const EDGE_MARGIN = 0.15;

/** Longer than this and the seek is treated as one that will not finish. */
const SEEK_TIMEOUT = 6000;

export interface PreviewFrame {
  image: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * A frame from the end of a clip, or from its beginning.
 *
 * `edge` says which: `'out'` for the shot being left, `'in'` for the one being
 * arrived at, because those are the two frames a join actually shows.
 */
export async function captureEdgeFrame(clip: EditorClip, edge: 'in' | 'out'): Promise<PreviewFrame | null> {
  if (!isMediaClip(clip)) return null;

  if (clip.summary.kind === 'image') {
    try {
      const bitmap = await imageBitmapForFile(clip.file);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      return null;
    }
  }

  if (!clip.summary.videoUsable || clip.awaitingFile) return null;

  const url = mediaObjectUrl(clip.file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await once(video, 'loadeddata');

    const duration = Number.isFinite(video.duration) ? video.duration : clip.summary.durationSeconds;
    const at =
      edge === 'in'
        ? Math.min(EDGE_MARGIN, duration / 4)
        : Math.max(0, duration - Math.min(EDGE_MARGIN, duration / 4));

    video.currentTime = at;
    await once(video, 'seeked');

    if (!video.videoWidth || !video.videoHeight) return null;

    // Copied off the element rather than held as a reference to it: the element
    // is about to be thrown away, and a `<video>` that has been detached stops
    // being drawable on some browsers without ever saying so.
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0);

    return { image: canvas, width: canvas.width, height: canvas.height, release: () => {} };
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * A stand-in for a text card.
 *
 * Deliberately not the real renderer. Bringing the whole scene builder in here
 * would mean a third copy of it, and what the reader is judging in this dialog
 * is the animation between two pictures — the card's colour and its opening line
 * are enough to tell which side is which.
 */
export function textCardStandIn(clip: EditorClip, width: number, height: number): PreviewFrame | null {
  if (isMediaClip(clip) || clip.kind !== 'text') return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.fillStyle = clip.draft.backgroundColor;
  context.fillRect(0, 0, width, height);

  const line = clip.draft.text.split('\n')[0] || 'Text card';
  context.fillStyle = clip.draft.color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `600 ${Math.round(height * 0.11)}px system-ui, sans-serif`;
  context.fillText(line.slice(0, 28), width / 2, height / 2, width * 0.86);

  return { image: canvas, width, height, release: () => {} };
}

function once(element: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new Error(event));
    };

    // A timeout rather than a promise that can hang: a file the browser will
    // never finish seeking in must not leave the dialog waiting for it forever.
    const timer = window.setTimeout(fail, SEEK_TIMEOUT);
    element.addEventListener(event, finish, { once: true });
    element.addEventListener('error', fail, { once: true });
  });
}
