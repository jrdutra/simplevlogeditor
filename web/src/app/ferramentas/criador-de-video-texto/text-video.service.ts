import { Injectable } from '@angular/core';
import type { Output, OutputFormat, Target } from 'mediabunny';

import { ensureMp3Encoder, loadMediabunny, MediabunnyLib } from '../../services/mediabunny/mediabunny-loader';
import { drawFrame, fadeGainAt, SceneContext } from './text-scene-renderer';
import {
  ImageFormatOption,
  RenderCanceledError,
  RenderError,
  RenderProgress,
  RenderResult,
  TextScene,
  VideoFormatOption,
  sceneDuration,
  stillTime
} from './text-video.models';

export interface VideoRenderOptions {
  scene: TextScene;
  format: VideoFormatOption;
  frameRate: number;
  /** Sound laid under the whole clip, trimmed or padded to its length. */
  audio: File | null;
  /** Moving picture behind the text, decoded frame by frame as the clip runs. */
  backgroundVideo: File | null;
  signal: AbortSignal;
  onProgress: (report: RenderProgress) => void;
}

export interface ImageRenderOptions {
  scene: TextScene;
  /** When the background is a video, the still is taken from it too. */
  backgroundVideo?: File | null;
  format: ImageFormatOption;
  /** 0..1, ignored by PNG. */
  quality: number;
  /** Painted under the frame when the format cannot carry transparency. */
  matte: string;
}

/** Seconds of silence written at a time when the sound runs out early. */
const SILENCE_CHUNK = 0.5;

/**
 * Turns a scene into a file.
 *
 * The service draws nothing itself: every frame comes from the same renderer
 * the preview uses, which is the whole reason the preview can be trusted. What
 * lives here is the part the preview has no equivalent of — pacing the frames
 * into an encoder, laying the soundtrack underneath, and choosing a container
 * that will actually accept both.
 */
@Injectable({ providedIn: 'root' })
export class TextVideoService {
  /**
   * Renders the clip.
   *
   * Frames are drawn and handed over one at a time, and each `add` is awaited:
   * that await is the backpressure. Without it a four-minute 4K clip would
   * queue thousands of frames into the encoder before the first one was
   * written, and the tab would run out of memory long before the file existed.
   */
  async renderVideo(options: VideoRenderOptions): Promise<RenderResult> {
    const { scene, format, frameRate, audio, signal, onProgress } = options;
    const library = await loadMediabunny();

    onProgress({ stage: 'preparing', ratio: 0 });

    if (format.audioCodec === 'mp3') await ensureMp3Encoder();

    const duration = sceneDuration(scene);
    const canvas = this.canvasOfSize(scene.width, scene.height);
    const context = canvas.getContext('2d', { alpha: false }) as SceneContext | null;
    if (!context) throw new RenderError('This browser could not create the drawing surface for the video.');

    if (!(await library.canEncodeVideo(format.videoCodec, { width: scene.width, height: scene.height }))) {
      throw new RenderError(
        `Your browser cannot encode ${format.label} at ${scene.width} × ${scene.height}.`,
        'Choose a smaller resolution or another output format.'
      );
    }

    const output = new library.Output({
      format: this.containerFor(library, format),
      target: new library.BufferTarget()
    }) as Output<OutputFormat, Target>;

    let finalized = false;

    try {
      const videoSource = new library.CanvasSource(canvas, {
        codec: format.videoCodec,
        quality: new library.Quality('high'),
        keyFrameInterval: 2
      });
      output.addVideoTrack(videoSource);

      // A track is added only when there is sound for it. A generated clip with
      // an empty audio track is larger for no reason, and some editors treat
      // one as a fault in the file.
      const audioSource = audio ? await this.buildAudioSource(library, format, scene) : null;
      if (audioSource) output.addAudioTrack(audioSource.source);

      await output.start();

      const frames = Math.max(1, Math.ceil(duration * frameRate));
      const step = 1 / frameRate;

      // A moving background is the one thing the preview does with a media
      // element and the export cannot: seeking a `<video>` per frame is neither
      // exact nor fast. The decoder is driven directly instead, and the frame it
      // yields is handed to the same renderer through the same field a still
      // photograph would have used.
      const backdrop = options.backgroundVideo
        ? await this.openBackdrop(library, options.backgroundVideo, duration)
        : null;
      // Mutated per frame, so the caller's scene is never touched.
      const working: TextScene = { ...scene };

      try {
        for (let frame = 0; frame < frames; frame++) {
          if (signal.aborted) throw new RenderCanceledError();

          const timestamp = frame * step;
          if (backdrop) await backdrop.frameAt(timestamp, working);
          drawFrame(context, working, timestamp);
          await videoSource.add(timestamp, step);

          onProgress({ stage: 'drawing', ratio: (frame + 1) / frames });
        }
      } finally {
        backdrop?.dispose();
      }

      if (audio && audioSource) {
        onProgress({ stage: 'audio', ratio: null });
        await this.writeAudio(library, audioSource, audio, scene, duration, signal);
      }

      onProgress({ stage: 'muxing', ratio: 1 });
      await output.finalize();
      finalized = true;

      const buffer = (output.target as import('mediabunny').BufferTarget).buffer;
      if (!buffer) throw new RenderError('The video could not be assembled.');

      onProgress({ stage: 'finishing', ratio: 1 });

      return {
        blob: new Blob([buffer], { type: format.mimeType }),
        fileName: `text-video.${format.extension}`,
        kind: 'video',
        width: scene.width,
        height: scene.height,
        durationSeconds: duration
      };
    } catch (error) {
      if (!finalized) await output.cancel().catch(() => undefined);
      throw this.describe(error);
    }
  }

  /**
   * Exports the finished frame as a still.
   *
   * Taken at the instant the text has just finished arriving: any earlier and
   * the picture would be half-written, any later and a fade-out would have
   * started dimming it.
   */
  async renderImage(options: ImageRenderOptions): Promise<RenderResult> {
    const { scene, format, quality, matte } = options;

    const canvas = this.canvasOfSize(scene.width, scene.height);
    const context = canvas.getContext('2d') as SceneContext | null;
    if (!context) throw new RenderError('This browser could not create the drawing surface for the image.');

    const working: TextScene = { ...scene, fadeIn: false, fadeOut: false };

    // A still taken from a moving background is the frame that was on screen at
    // the instant the text finished arriving — the same instant the still has
    // always been taken at.
    if (options.backgroundVideo) {
      const library = await loadMediabunny();
      const backdrop = await this.openBackdrop(library, options.backgroundVideo, sceneDuration(scene));
      try {
        await backdrop.frameAt(stillTime(scene), working);
      } finally {
        backdrop.dispose();
      }
    }

    // A format without an alpha channel writes transparency as black unless
    // something is put behind it; the renderer paints it, because it clears the
    // surface before drawing anything of its own.
    drawFrame(context, working, stillTime(scene), format.keepsAlpha ? undefined : matte);

    const blob = await this.toBlob(canvas, format.mimeType, quality);
    if (!blob) {
      throw new RenderError(
        `Your browser could not write a ${format.label} file.`,
        'Try PNG, which every browser supports.'
      );
    }

    return {
      blob,
      fileName: `text-image.${format.extension}`,
      kind: 'image',
      width: scene.width,
      height: scene.height,
      durationSeconds: 0
    };
  }

  // ----------------------------------------------------------- background

  /**
   * Opens a video to be used as the background, one frame at a time.
   *
   * Both loops — the output's frames and the source's — run forward and never
   * go back, so they are merged rather than searched: the decoder is advanced
   * until it is level with the instant being drawn, and whatever it last handed
   * over is what gets painted. That keeps the whole thing to one pass over the
   * file, at the cost of nothing but a canvas to hold the current frame.
   *
   * A background shorter than the clip holds on its last frame. Looping it
   * would need a second pass over the file and would be a decision the reader
   * did not ask for; a freeze is at least visibly a freeze.
   */
  private async openBackdrop(
    library: MediabunnyLib,
    file: File,
    duration: number
  ): Promise<{ frameAt: (time: number, scene: TextScene) => Promise<void>; dispose: () => void }> {
    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();

    if (!track) {
      input.dispose();
      throw new RenderError(
        'That file has no picture this browser can decode.',
        'Choose a video in MP4, WebM or MOV, or use a still image instead.'
      );
    }

    const sink = new library.VideoSampleSink(track);
    const iterator = sink.samples(0, duration)[Symbol.asyncIterator]();

    let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    let context: SceneContext | null = null;
    let pending = await iterator.next();
    let painted = false;

    const paint = (sample: import('mediabunny').VideoSample) => {
      if (!canvas || !context) {
        canvas = this.canvasOfSize(sample.displayWidth, sample.displayHeight);
        context = canvas.getContext('2d') as SceneContext | null;
        if (!context) throw new RenderError('This browser could not draw the background video.');
      }
      sample.draw(context, 0, 0, canvas.width, canvas.height);
      painted = true;
    };

    return {
      frameAt: async (time, scene) => {
        while (!pending.done && pending.value.timestamp <= time) {
          // A decoded frame holds a real GPU or system buffer, so it is closed
          // as soon as it has been copied onto the canvas.
          try {
            paint(pending.value);
          } finally {
            pending.value.close();
          }
          pending = await iterator.next();
        }

        // Before the first frame arrives there is nothing to show, so the
        // scene keeps whatever background it already had.
        if (!painted || !canvas) return;
        scene.background = { kind: 'image', image: canvas, width: canvas.width, height: canvas.height };
      },
      dispose: () => {
        if (!pending.done) pending.value.close();
        void iterator.return?.();
        input.dispose();
      }
    };
  }

  // ---------------------------------------------------------------- audio

  /**
   * Prepares the soundtrack, with the same fades the picture gets.
   *
   * The ramp is computed per audio frame from the very function the renderer
   * uses for the black overlay, so the sound and the picture reach silence and
   * black on exactly the same instant rather than approximately together.
   */
  private async buildAudioSource(
    library: MediabunnyLib,
    format: VideoFormatOption,
    scene: TextScene
  ): Promise<{ source: import('mediabunny').AudioSampleSource; sampleRate: number; channels: number }> {
    // 48 kHz stereo throughout: it is the only rate Opus accepts, every other
    // codec here takes it, and the resampler in the source handles the rest.
    const sampleRate = 48000;
    const channels = 2;

    if (!(await library.canEncodeAudio(format.audioCodec, { numberOfChannels: channels, sampleRate }))) {
      throw new RenderError(
        `Your browser cannot encode ${format.label} audio.`,
        'Pick another output format, or remove the background sound.'
      );
    }

    const faded = scene.fadeIn || scene.fadeOut;

    const source = new library.AudioSampleSource({
      codec: format.audioCodec,
      quality: new library.Quality('high'),
      transform: {
        numberOfChannels: channels,
        sampleRate,
        ...(faded
          ? {
              process: (sample: import('mediabunny').AudioSample) => {
                const frames = sample.numberOfFrames;
                const data = new Float32Array(frames * sample.numberOfChannels);
                sample.copyTo(data, { planeIndex: 0, format: 'f32' });

                let touched = false;
                for (let frame = 0; frame < frames; frame++) {
                  const gain = fadeGainAt(scene, sample.timestamp + frame / sample.sampleRate);
                  if (gain >= 1) continue;

                  touched = true;
                  const offset = frame * sample.numberOfChannels;
                  for (let channel = 0; channel < sample.numberOfChannels; channel++) {
                    data[offset + channel] *= gain;
                  }
                }

                if (!touched) return sample;

                return new library.AudioSample({
                  data,
                  format: 'f32',
                  numberOfChannels: sample.numberOfChannels,
                  sampleRate: sample.sampleRate,
                  timestamp: sample.timestamp
                });
              }
            }
          : {})
      }
    });

    return { source, sampleRate, channels };
  }

  /**
   * Lays the sound under the clip, cut or padded to its length.
   *
   * The clip's length is the authority: a soundtrack longer than the video is
   * cut where the video ends, and a shorter one is followed by real silence
   * rather than by a hole in the track, which some players stall on.
   */
  private async writeAudio(
    library: MediabunnyLib,
    audio: { source: import('mediabunny').AudioSampleSource; sampleRate: number; channels: number },
    file: File,
    scene: TextScene,
    duration: number,
    signal: AbortSignal
  ): Promise<void> {
    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });

    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) {
        throw new RenderError(
          'The background sound file has no audio track your browser can read.',
          'Try an MP3, M4A, WAV, OGG or FLAC file.'
        );
      }

      let end = 0;
      for await (const sample of new library.AudioSampleSink(track).samples(0, duration)) {
        try {
          if (signal.aborted) throw new RenderCanceledError();
          await audio.source.add(sample);
          end = Math.max(end, sample.timestamp + sample.duration);
        } finally {
          sample.close();
        }
      }

      await this.padSilence(library, audio, Math.max(0, end), duration, signal);
    } finally {
      input.dispose();
    }
  }

  private async padSilence(
    library: MediabunnyLib,
    audio: { source: import('mediabunny').AudioSampleSource; sampleRate: number; channels: number },
    from: number,
    until: number,
    signal: AbortSignal
  ): Promise<void> {
    let written = from;

    while (until - written > 1 / audio.sampleRate) {
      if (signal.aborted) throw new RenderCanceledError();

      const seconds = Math.min(SILENCE_CHUNK, until - written);
      const frames = Math.max(1, Math.round(seconds * audio.sampleRate));

      const sample = new library.AudioSample({
        data: new Float32Array(frames * audio.channels),
        format: 'f32',
        numberOfChannels: audio.channels,
        sampleRate: audio.sampleRate,
        timestamp: written
      });

      try {
        await audio.source.add(sample);
      } finally {
        sample.close();
      }

      written += frames / audio.sampleRate;
    }
  }

  // -------------------------------------------------------------- helpers

  private canvasOfSize(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  private toBlob(
    canvas: OffscreenCanvas | HTMLCanvasElement,
    type: string,
    quality: number
  ): Promise<Blob | null> {
    if (canvas instanceof HTMLCanvasElement) {
      return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    }
    return canvas.convertToBlob({ type, quality }).catch(() => null);
  }

  private containerFor(library: MediabunnyLib, format: VideoFormatOption): OutputFormat {
    switch (format.id) {
      case 'webm':
        return new library.WebMOutputFormat();
      case 'mkv':
        return new library.MkvOutputFormat();
      case 'mov':
        return new library.MovOutputFormat();
      default:
        return new library.Mp4OutputFormat();
    }
  }

  /** Turns a low-level failure into something worth reading. */
  private describe(error: unknown): Error {
    if (error instanceof RenderCanceledError || error instanceof RenderError) return error;

    const message = String((error as Error)?.message ?? error ?? '').toLowerCase();

    if (message.includes('memory') || message.includes('allocation')) {
      return new RenderError(
        'The browser ran out of memory while rendering.',
        'Choose a smaller resolution or a shorter clip, and close other tabs.'
      );
    }
    if (message.includes('encod')) {
      return new RenderError(
        'Your browser refused to encode this video.',
        'Try another output format, a smaller resolution, or a current desktop browser.'
      );
    }
    if (message.includes('decod') || message.includes('codec')) {
      return new RenderError(
        'Your browser cannot decode the background sound.',
        'Try an MP3, M4A, WAV or OGG file.'
      );
    }

    return new RenderError('The file could not be generated.', 'Check your settings and try again.');
  }
}
