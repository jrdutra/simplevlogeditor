export interface TimeRange { start: number; end: number; }
export interface AnalysisSettings {
  content: 'speech' | 'speech-music';
  sensitivity: 'low' | 'balanced' | 'high';
  background: TimeRange | null;
  cleanVoice: TimeRange | null;
}
export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  content: 'speech', sensitivity: 'balanced', background: null, cleanVoice: null
};
export interface QualityWindow extends TimeRange { speech: number; background: number; overall: number; }
export interface NoiseReport {
  status: 'Low background' | 'Probable noise' | 'Relevant noise' | 'Inconclusive';
  settings: AnalysisSettings;
  seconds: number;
  speechSeconds: number;
  pauseSeconds: number;
  backgroundDb: number | null;
  voiceBackgroundGapDb: number | null;
  quality: { speech: number; background: number; overall: number } | null;
  intervals: QualityWindow[];
  evidence: string[];
  warnings: string[];
}
export const ANALYSIS_RATE = 16000;
export const VAD_FRAME = 512;
export const QUALITY_SAMPLES = 144160; // DNSMOS P.835: 9.01 s at 16 kHz.

export function validateAnalysis(settings: AnalysisSettings, seconds: number): void {
  if (!['speech', 'speech-music'].includes(settings.content) || !['low', 'balanced', 'high'].includes(settings.sensitivity)) {
    throw new Error('Invalid analysis settings.');
  }
  for (const [name, range] of [['Background', settings.background], ['Clean voice', settings.cleanVoice]] as const) {
    if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0
      || range.end > seconds || range.end - range.start < 0.5)) {
      throw new Error(`${name} reference must be at least 0.5 seconds and lie inside the recording.`);
    }
  }
  if (settings.background && settings.cleanVoice
    && Math.max(settings.background.start, settings.cleanVoice.start) < Math.min(settings.background.end, settings.cleanVoice.end)) {
    throw new Error('Background and clean voice references must not overlap.');
  }
}

/** Official non-personalized P.835 calibration; higher scores mean better quality. */
export function calibrateQuality(raw: ArrayLike<number>): Omit<QualityWindow, 'start' | 'end'> {
  if (raw.length < 3 || [raw[0], raw[1], raw[2]].some(value => !Number.isFinite(value))) throw new Error('Invalid quality model output.');
  const poly = (x: number, a: number, b: number, c: number) => Math.max(1, Math.min(5, (a * x + b) * x + c));
  return {
    speech: poly(raw[0], -0.08397278, 1.22083953, 0.0052439),
    background: poly(raw[1], -0.13166888, 1.60915514, -0.39604546),
    overall: poly(raw[2], -0.06766283, 1.11546468, 0.04602535)
  };
}

/** Full temporal coverage, including the final partial window; no random sampling. */
export function qualityStarts(length: number): number[] {
  if (length <= QUALITY_SAMPLES) return [0];
  const last = length - QUALITY_SAMPLES;
  const starts: number[] = [];
  for (let at = 0; at < last; at += 72000) starts.push(at);
  starts.push(last);
  return starts;
}

/** Require 250 ms of speech, then exclude its 160 ms margins from pause measurements. */
export function speechMask(probabilities: Float32Array): Uint8Array {
  const mask = new Uint8Array(probabilities.length);
  for (let at = 0; at < probabilities.length;) {
    if (probabilities[at] < 0.5) { at++; continue; }
    const start = at++;
    while (at < probabilities.length && probabilities[at] >= 0.35) at++;
    if (at - start >= 8) mask.fill(1, Math.max(0, start - 5), Math.min(mask.length, at + 5));
  }
  return mask;
}

export function summarizeNoise(samples: Float32Array, probabilities: Float32Array,
  windows: QualityWindow[], settings: AnalysisSettings): NoiseReport {
  const seconds = samples.length / ANALYSIS_RATE;
  validateAnalysis(settings, seconds);
  if (!samples.length || probabilities.length !== Math.ceil(samples.length / VAD_FRAME)
    || samples.some(value => !Number.isFinite(value)) || probabilities.some(value => !Number.isFinite(value))) {
    throw new Error('Invalid audio or speech analysis.');
  }
  const mask = speechMask(probabilities);
  let voiceEnergy = 0, voiceCount = 0, noiseEnergy = 0, noiseCount = 0, speechCount = 0, pauseCount = 0;
  let referenceSpeech = 0, referenceCount = 0, cleanSpeech = 0;
  for (let i = 0; i < samples.length; i++) {
    const block = Math.floor(i / VAD_FRAME);
    const speech = mask[block] === 1;
    const pause = !speech && probabilities[block] < 0.2;
    const time = i / ANALYSIS_RATE;
    if (speech) speechCount++;
    if (pause) pauseCount++;
    const inNoise = settings.background ? time >= settings.background.start && time < settings.background.end : pause;
    const inVoice = settings.cleanVoice ? time >= settings.cleanVoice.start && time < settings.cleanVoice.end : speech;
    if (inNoise) {
      noiseCount++; noiseEnergy += samples[i] ** 2;
      if (settings.background) { referenceCount++; if (speech) referenceSpeech++; }
    }
    if (inVoice) { voiceCount++; voiceEnergy += samples[i] ** 2; if (speech) cleanSpeech++; }
  }
  const warnings: string[] = [];
  const evidence: string[] = [];
  let uncertain = false;
  if (seconds < 3) { uncertain = true; warnings.push('At least 3 seconds are needed for a useful diagnosis.'); }
  if (seconds < 9.01) warnings.push('The quality model repeats short audio to fill its 9.01-second input; interpret its scores cautiously.');
  if (speechCount / ANALYSIS_RATE < 0.5) { uncertain = true; warnings.push('Too little speech was detected to judge background alongside a voice.'); }
  if (settings.content === 'speech-music') { uncertain = true; warnings.push('Intentional music cannot reliably be distinguished from unwanted background by this speech-quality model.'); }
  if (referenceCount && referenceSpeech / referenceCount > 0.1) {
    uncertain = true; warnings.push('Speech was detected in the background reference. Choose a section without speech.');
  }
  if (settings.cleanVoice && cleanSpeech / ANALYSIS_RATE < 0.25) {
    uncertain = true; warnings.push('The clean voice reference does not contain enough detected speech.');
  }
  const db = (energy: number, count: number) => 10 * Math.log10(Math.max(1e-12, energy / Math.max(1, count)));
  const backgroundDb = noiseCount >= ANALYSIS_RATE * 0.5 ? db(noiseEnergy, noiseCount) : null;
  const gap = backgroundDb !== null && voiceCount >= ANALYSIS_RATE * 0.25 ? db(voiceEnergy, voiceCount) - backgroundDb : null;
  if (backgroundDb === null) warnings.push('No reliable half-second of background was available. The diagnosis relies on the quality model.');
  else evidence.push(`Background measured at ${backgroundDb.toFixed(1)} dBFS ${settings.background ? 'in your reference' : 'outside detected speech'}.`);
  if (gap !== null) evidence.push(`Voice/background level gap: ${gap.toFixed(1)} dB. This is not a ground-truth signal-to-noise ratio.`);
  const voiced = windows.filter(window => {
    const a = Math.floor(window.start * ANALYSIS_RATE / VAD_FRAME), b = Math.ceil(window.end * ANALYSIS_RATE / VAD_FRAME);
    let total = 0; for (let i = a; i < Math.min(mask.length, b); i++) total += mask[i];
    return total * VAD_FRAME / ANALYSIS_RATE >= 0.5;
  });
  const quality = voiced.length ? {
    speech: voiced.reduce((sum, w) => sum + w.speech, 0) / voiced.length,
    background: voiced.reduce((sum, w) => sum + w.background, 0) / voiced.length,
    overall: voiced.reduce((sum, w) => sum + w.overall, 0) / voiced.length
  } : null;
  if (!quality) { uncertain = true; warnings.push('No speech-containing quality window was available.'); }
  const offset = settings.sensitivity === 'high' ? 0.3 : settings.sensitivity === 'low' ? -0.3 : 0;
  const probable = 3.5 + offset, relevant = 2.5 + offset;
  const intervals = voiced.filter(window => window.background < probable);
  let status: NoiseReport['status'] = 'Inconclusive';
  if (!uncertain && quality) {
    const worst = Math.min(...voiced.map(window => window.background));
    status = worst < relevant ? 'Relevant noise' : worst < probable ? 'Probable noise' : 'Low background';
    // Strong measured background contradicting an optimistic model is not a clean bill of health.
    if (status === 'Low background' && backgroundDb !== null && backgroundDb > -45 && gap !== null && gap < 10) {
      status = 'Inconclusive'; warnings.push('The measured background and the perceptual model disagree. Listen to the recording before deciding.');
    }
    evidence.push('The diagnosis uses the worst speech-containing window, so a short noisy passage is not hidden by an average.');
  }
  return { status, settings, seconds, speechSeconds: speechCount / ANALYSIS_RATE, pauseSeconds: pauseCount / ANALYSIS_RATE,
    backgroundDb, voiceBackgroundGapDb: gap, quality, intervals, evidence, warnings };
}
