export const TRANSCRIPTION_MODEL_ALIASES: Readonly<Record<string, string>> = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  fast: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
  balanced: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
  quality: 'onnx-community/whisper-small_timestamped',
  'small-quality': 'onnx-community/whisper-small_timestamped',
  turbo: 'onnx-community/whisper-large-v3-turbo_timestamped',
  large: 'onnx-community/whisper-large-v3-turbo_timestamped',
  'large-v3-turbo': 'onnx-community/whisper-large-v3-turbo_timestamped'
};

export const TRANSCRIPTION_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  auto: '',
  pt: 'portuguese',
  'pt-br': 'portuguese',
  'português': 'portuguese',
  portugues: 'portuguese',
  en: 'english',
  'en-us': 'english',
  es: 'spanish',
  fr: 'french',
  de: 'german',
  it: 'italian',
  ja: 'japanese'
};

export function resolveTranscriptionModel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return TRANSCRIPTION_MODEL_ALIASES[normalized] ?? value.trim();
}

export function resolveTranscriptionLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  return TRANSCRIPTION_LANGUAGE_ALIASES[normalized] ?? normalized;
}
