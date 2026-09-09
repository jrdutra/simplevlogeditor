/**
 * What the noise suppressor works with.
 *
 * Two engines, one strength control and one decision about what comes out the
 * other end. Everything else is derived.
 */

/** The rate every speech model here is trained at. */
export const MODEL_RATE = 16000;

/** The rate RNNoise is fixed at, and the size of the frame it wants. */
export const RNNOISE_RATE = 48000;
export const RNNOISE_FRAME = 480;

export type EngineId = 'gtcrn' | 'rnnoise';
export type ProcessingDevice = 'cpu' | 'webgpu';

export interface Engine {
  id: EngineId;
  label: string;
  /** One line under the choice, saying what it is good and bad at. */
  note: string;
  /** What the browser has to fetch the first time, in megabytes. */
  megabytes: number;
}

/**
 * The two engines, in the order they are offered.
 *
 * GTCRN is first because it is better at the noise people actually complain
 * about — a second conversation, a keyboard, a café — and because it is 48
 * thousand parameters, so being better costs almost nothing at run time. The
 * megabytes are the ONNX runtime, not the model: the model itself is half a
 * megabyte and is served with the page.
 */
export const ENGINES: readonly Engine[] = [
  {
    id: 'gtcrn',
    label: 'Voice model',
    note: 'A speech model that decides band by band what is a voice. Handles keyboards, traffic and other people talking.',
    megabytes: 13
  },
  {
    id: 'rnnoise',
    label: 'Classic',
    note: 'Small, quick and already inside the page. Good with constant noise — fans, hiss, hum — and weaker on everything else.',
    megabytes: 0
  }
];

/** How hard to push, as the most any band may be turned down. */
export interface Strength {
  label: string;
  attenuationDb: number;
  note: string;
}

export const STRENGTHS: readonly Strength[] = [
  { label: 'Gentle', attenuationDb: 12, note: 'Lowers the background and leaves the room audible. Safest on quiet recordings.' },
  { label: 'Balanced', attenuationDb: 24, note: 'The default. Removes most of the background without the voice sounding processed.' },
  { label: 'Maximum', attenuationDb: 40, note: 'Near silence between words. Use on loud, difficult recordings and listen to the result.' }
];

export type SuppressionStage = 'reading' | 'loading' | 'listening' | 'writing' | 'levelling' | 'analysing' | 'done';

export interface SuppressionProgress {
  stage: SuppressionStage;
  /** 0..1, or null while the stage cannot be measured. */
  ratio: number | null;
  detail: string;
}

/** What the reader gets at the end. */
export type OutputKind = 'media' | 'audio';

export interface AudioFormat {
  id: string;
  label: string;
  extension: string;
  container: 'wav' | 'mp4' | 'mp3' | 'webm' | 'ogg';
  codec: 'pcm-s16' | 'aac' | 'opus' | 'mp3';
  note: string;
}

export const AUDIO_FORMATS: readonly AudioFormat[] = [
  { id: 'wav', label: 'WAV', extension: 'wav', container: 'wav', codec: 'pcm-s16',
    note: 'Uncompressed. The one to pick if the file is going back into an editor.' },
  { id: 'm4a', label: 'M4A · AAC', extension: 'm4a', container: 'mp4', codec: 'aac',
    note: 'Small and played by everything.' },
  { id: 'mp3', label: 'MP3', extension: 'mp3', container: 'mp3', codec: 'mp3',
    note: 'The most compatible lossy format there is.' },
  { id: 'opus', label: 'OGG · Opus', extension: 'ogg', container: 'ogg', codec: 'opus',
    note: 'The best quality per byte, and refused by some older players.' }
];

/** The longest recording accepted, in minutes. */
export const MAX_MINUTES = 20;
