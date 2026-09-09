/**
 * What the transcription tool works with.
 *
 * Small on purpose. The tool has one input, one long-running job and four
 * possible outputs, and everything else is a setting the reader can see.
 */

/** Whisper is trained on 16 kHz mono and resamples nothing for you. */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * A model the reader can choose, and what choosing it costs them.
 *
 * The sizes are what the browser actually downloads at the quantisation used —
 * quoted because this is the one decision in the tool with a price attached,
 * and hiding it would mean somebody on a phone connection picks the large one
 * and thinks the page is broken.
 */
export interface SpeechModel {
  id: string;
  label: string;
  /** Roughly what is fetched the first time, in megabytes. */
  megabytes: number;
  /** English only, or every language Whisper knows. */
  multilingual: boolean;
  note: string;
}

export const SPEECH_MODELS: readonly SpeechModel[] = [
  { id: 'onnx-community/whisper-small_timestamped', label: 'Small · quality', megabytes: 250,
    multilingual: true, note: 'Recommended for accuracy. Slower and more memory-intensive than Base or Tiny.' },
  { id: 'onnx-community/whisper-base_timestamped', label: 'Base · balanced', megabytes: 82,
    multilingual: true, note: 'A smaller download and faster processing. Review names, numbers and technical terms.' },
  { id: 'onnx-community/whisper-tiny_timestamped', label: 'Tiny · fast draft', megabytes: 42,
    multilingual: true, note: 'For quick drafts on lighter devices. Expect more recognition errors.' },
  { id: 'onnx-community/whisper-large-v3-turbo_timestamped', label: 'Large v3 Turbo · advanced', megabytes: 1085,
    multilingual: true, note: 'Large multilingual model. Needs substantial free memory; CPU processing may be very slow.' }
];

/**
 * The languages offered, by the code Whisper expects.
 *
 * Not the full list of ninety-nine: these are the ones this site's readers
 * actually record in, plus "detect it", which is what the model does anyway
 * when nobody says. Naming the language when you know it is worth doing — the
 * model stops spending its first seconds deciding.
 */
export const SPEECH_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: '', label: 'Detect it' },
  { code: 'portuguese', label: 'Portuguese' },
  { code: 'english', label: 'English' },
  { code: 'spanish', label: 'Spanish' },
  { code: 'french', label: 'French' },
  { code: 'german', label: 'German' },
  { code: 'italian', label: 'Italian' },
  { code: 'japanese', label: 'Japanese' }
];

/** Where the job is, for the progress bar and the line above it. */
export type TranscriptionStage = 'reading' | 'downloading' | 'listening' | 'done';

export interface TranscriptionProgress {
  stage: TranscriptionStage;
  /** 0..1, or null while the stage genuinely cannot be measured. */
  ratio: number | null;
  /** The file being fetched, or the stretch being listened to. */
  detail: string;
}
