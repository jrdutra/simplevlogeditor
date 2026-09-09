/**
 * Where the sound in a file actually starts.
 *
 * Music exported from a DAW, a voice note, a stock track downloaded from a
 * library: they routinely open with anything from a few frames to several
 * seconds of digital silence. Laid under a title that silence is not a property
 * of the file the reader notices — it is an editor that appears not to have
 * played anything, and the usual response is to assume the tool is broken.
 *
 * So the head of every attached file is measured once, when it is attached, and
 * every offset into that file is taken from the first real sound instead of
 * from zero. It is deliberately a *measurement* and not a trim: the file is
 * never rewritten, the number is stored beside it, and a reader who wants the
 * silence back has a checkbox rather than a lost original.
 */

import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';

/** Below this a sample is silence rather than a quiet beginning. Roughly -60 dBFS. */
const SILENCE_FLOOR = 0.001;

/**
 * How far in to look before giving up.
 *
 * A file that is quiet for its first half minute is not a soundtrack with a
 * long intro, it is a recording of a room — and decoding further to prove it
 * would cost more than the answer is worth.
 */
const SEARCH_LIMIT_SECONDS = 30;

/** Kept back from the first audible sample, so an attack is never clipped. */
const LEAD_IN = 0.02;

/**
 * Measures the silence at the head of an audio file, in seconds.
 *
 * Returns zero for anything it cannot read: a file that will not decode here
 * will be reported properly by the probe or by the export, and a failed
 * measurement must never be the thing that stops a soundtrack being used.
 */
export async function measureLeadingSilence(file: File): Promise<number> {
  try {
    const library = await loadMediabunny();
    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });

    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) return 0;

      const sink = new library.AudioSampleSink(track);

      for await (const sample of sink.samples(0, SEARCH_LIMIT_SECONDS)) {
        try {
          const frames = sample.numberOfFrames;
          const channels = sample.numberOfChannels;
          const data = new Float32Array(frames * channels);
          sample.copyTo(data, { planeIndex: 0, format: 'f32' });

          for (let index = 0; index < data.length; index++) {
            if (Math.abs(data[index]) <= SILENCE_FLOOR) continue;

            // The exact frame the sound begins, less a hair, so the attack of
            // the first note is not shaved off by the very fix meant to find it.
            const frame = Math.floor(index / channels);
            return Math.max(0, sample.timestamp + frame / sample.sampleRate - LEAD_IN);
          }
        } finally {
          sample.close();
        }
      }
    } finally {
      input.dispose();
    }
  } catch {
    /* Unreadable here is not unusable later; the export will say so properly. */
  }

  return 0;
}
