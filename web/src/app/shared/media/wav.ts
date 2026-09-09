/**
 * Writing decoded audio back out as a file the rest of the app can read.
 *
 * Everything downstream of a chosen sound — the probe, the timeline planner, the
 * renderer, the preview player — takes a `File` and decodes it. So when audio is
 * cleaned up in the browser (noise removed, pauses cut) the honest way to hand
 * the result on is as a real file, not as a buffer with a note attached. Nothing
 * else then has to know that this particular sound was processed: it is simply a
 * shorter, quieter file than the one that went in.
 *
 * WAV rather than a compressed format because the browser can only *decode*
 * MP3 and AAC, never encode them, and because a re-encode would add a
 * generation of loss to audio that is about to be encoded again on export.
 */

/** Bytes per sample. 16-bit is what every decoder on earth reads without fuss. */
const BYTES_PER_SAMPLE = 2;

/**
 * Packs channels of `[-1, 1]` samples into a 16-bit PCM WAV blob.
 *
 * Channels are interleaved, which is what the format wants and also what makes
 * this cheap: one pass, no intermediate copy per channel.
 *
 * Samples outside `[-1, 1]` are clamped rather than allowed to wrap. A sample
 * that wraps does not sound like distortion, it sounds like a gunshot, and
 * arithmetic on floating point audio overshoots often enough that leaving this
 * to chance would eventually produce one.
 */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Blob {
  const channelCount = Math.max(1, channels.length);
  const frames = channels.length ? channels[0].length : 0;
  const dataBytes = frames * channelCount * BYTES_PER_SAMPLE;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // size of this chunk
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, channelCount * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = channels[channel]?.[frame] ?? 0;
      const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
      // Asymmetric on purpose: 16-bit signed runs from -32768 to 32767, so the
      // positive side has one step less. Scaling both by 32767 keeps full scale
      // reachable in both directions without ever landing on -32769.
      view.setInt16(offset, Math.round(clamped * 32767), true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
