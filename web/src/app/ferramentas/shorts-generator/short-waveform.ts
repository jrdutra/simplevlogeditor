import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';
import { WaveformData } from '../cortador-de-silencio/silence-cutter.models';

/** Finest bucket kept, in seconds: fine enough to place a cut on a syllable at full zoom. */
const FINEST_BUCKET = 0.005;
/** Most buckets kept for one file, so a long vlog stays a few megabytes. */
const MOST_BUCKETS = 120_000;

/**
 * The waveform the Short Editor draws, in the silence cutter's format.
 *
 * Every sample is read (not a thumbnail of the sound), so each bucket holds
 * the real lowest and highest value and the loudness of its stretch. A file
 * without sound gets a flat line of the right length, so stretches can still
 * be drawn over it.
 */
export async function shortWaveform(file: File, duration: number, cancelled: () => boolean = () => false): Promise<WaveformData> {
  const buckets = Math.max(1, Math.min(MOST_BUCKETS, Math.ceil(duration / FINEST_BUCKET)));
  const secondsPerBucket = duration / buckets;
  const min = new Float32Array(buckets), max = new Float32Array(buckets), rms = new Float32Array(buckets);
  const squares = new Float64Array(buckets), counts = new Uint32Array(buckets);
  const result: WaveformData = { min, max, rms, secondsPerBucket, duration };

  const library = await loadMediabunny();
  const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !await track.canDecode()) return result;
    let buffer = new Float32Array(0);
    for await (const sample of new library.AudioSampleSink(track).samples()) {
      try {
        if (cancelled()) return result;
        const channels = sample.numberOfChannels, frames = sample.numberOfFrames, rate = sample.sampleRate;
        if (buffer.length < frames * channels) buffer = new Float32Array(frames * channels);
        sample.copyTo(buffer, { planeIndex: 0, format: 'f32' });
        for (let frame = 0; frame < frames; frame++) {
          const bucket = Math.floor((sample.timestamp + frame / rate) / secondsPerBucket);
          if (bucket < 0) continue;
          if (bucket >= buckets) break;
          let low = 0, high = 0, energy = 0;
          for (let channel = 0; channel < channels; channel++) {
            const value = buffer[frame * channels + channel];
            if (value < low) low = value;
            if (value > high) high = value;
            energy += value * value;
          }
          if (low < min[bucket]) min[bucket] = low;
          if (high > max[bucket]) max[bucket] = high;
          squares[bucket] += energy / channels;
          counts[bucket]++;
        }
      } finally { sample.close(); }
    }
    for (let bucket = 0; bucket < buckets; bucket++) {
      if (counts[bucket]) rms[bucket] = Math.min(1, Math.sqrt(squares[bucket] / counts[bucket]));
      if (min[bucket] < -1) min[bucket] = -1;
      if (max[bucket] > 1) max[bucket] = 1;
    }
    return result;
  } finally { input.dispose(); }
}

/** Pictures of the source for the timeline's picture track, taken on demand. */
export interface ShortFrames {
  /** Width over height of the source picture. */
  aspect: number;
  frameAt: (time: number) => Promise<CanvasImageSource | null>;
  dispose: () => void;
}

/** Height the thumbnails are taken at, in pixels: sharp at twice the band's height on a high-density screen. */
const THUMBNAIL_HEIGHT = 108;

/** Opens the source once and hands out the frame shown at any exact second, as a small bitmap. */
export async function shortFrames(file: File): Promise<ShortFrames> {
  const library = await loadMediabunny();
  const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !await track.canDecode()) throw new Error('This browser cannot decode this video.');
    const width = await track.getDisplayWidth(), height = await track.getDisplayHeight();
    const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
    const tileWidth = Math.max(1, Math.round(THUMBNAIL_HEIGHT * aspect));
    const sink = new library.VideoSampleSink(track);
    let disposed = false;
    return {
      aspect,
      dispose: () => { if (!disposed) { disposed = true; input.dispose(); } },
      frameAt: async (time: number) => {
        if (disposed) return null;
        const sample = await sink.getSample(Math.max(0, time));
        if (!sample) return null;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = tileWidth; canvas.height = THUMBNAIL_HEIGHT;
          const context = canvas.getContext('2d');
          if (!context) return null;
          sample.draw(context, 0, 0, tileWidth, THUMBNAIL_HEIGHT);
          return typeof createImageBitmap === 'function' ? await createImageBitmap(canvas) : canvas;
        } finally { sample.close(); }
      }
    };
  } catch (error) { input.dispose(); throw error; }
}
