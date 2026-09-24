import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';
import { EditorAgentError } from './editor-agent-api';
import { FrameSource } from './frame-source';
import type { VideoSample } from 'mediabunny';

export const AGENT_MEDIA_TIMEOUT_MS = 5 * 60_000;

/** Bounded, cancellable frame reads; releases late samples after cancellation. */
export async function openAgentFrameDecoder(file: File, signal?: AbortSignal) {
  const library = await loadMediabunny();
  const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
  let sample: VideoSample | null = null;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    sample?.close();
    sample = null;
    input.dispose();
  };
  function bounded<T>(task: Promise<T>, discard?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error, value?: T) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { dispose(); reject(error); } else resolve(value as T);
      };
      const abort = () => finish(new EditorAgentError('Visual inspection was cancelled.', 'cancelled'));
      const timer = setTimeout(() => finish(new EditorAgentError(
        'Timed out after 300s decoding a video frame.', 'media_timeout', { waitedMs: AGENT_MEDIA_TIMEOUT_MS }
      )), AGENT_MEDIA_TIMEOUT_MS);
      task.then(value => { if (finished) discard?.(value); else finish(undefined, value); }, error => finish(error));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  try {
    const track = await bounded(input.getPrimaryVideoTrack());
    if (!track) throw new EditorAgentError('This clip has no video track.', 'media_unavailable');
    const sink = new library.VideoSampleSink(track);
    return {
      dispose,
      async frame(timestamp: number): Promise<FrameSource> {
        if (disposed) throw new EditorAgentError('Frame decoder is closed.', 'cancelled');
        sample?.close();
        sample = null;
        sample = await bounded(sink.getSample(timestamp), late => late?.close());
        if (!sample) throw new EditorAgentError(`No frame could be decoded at ${timestamp.toFixed(2)}s.`, 'decode_failed');
        const current = sample;
        return { width: current.displayWidth, height: current.displayHeight,
          draw: (context, x, y, width, height) => current.draw(context, x, y, width, height) };
      }
    };
  } catch (error) { dispose(); throw error; }
}
