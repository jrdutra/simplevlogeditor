/**
 * Types shared by every layer of the Free Silence Cutter.
 *
 * Time is expressed in **seconds** throughout, as a floating point number, and
 * never mixed with milliseconds: the settings the reader types are in
 * milliseconds, and they are converted exactly once, when the detector runs.
 */

import type { WindowStatistics } from './silence-detector';
import type { AutoZoomSettings } from '../../shared/media/auto-zoom';

/** A half-open interval of the media timeline, in seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/**
 * A detected range that the reader may later be allowed to toggle.
 *
 * Manual editing is not part of this version, but every range already carries
 * its origin and an `enabled` flag so the renderer can keep consuming the same
 * list once it is.
 */
export interface EditableRange extends TimeRange {
  source: 'automatic' | 'manual';
  enabled: boolean;
}

/** Result of one silence detection pass over the whole media. */
export interface SilenceAnalysis {
  silenceRanges: EditableRange[];
  keepRanges: TimeRange[];
  originalDuration: number;
  removedDuration: number;
  outputDuration: number;
  /** Aggregated peaks used to draw the waveform; one entry per bucket. */
  waveform: WaveformData;
  /** Loudest window found, in dBFS. Used to warn about a threshold set too high. */
  peakDb: number;
  /** Engine that actually produced the window statistics. */
  engine: AudioAnalysisMode;
  /**
   * The per-window loudness the detection was run over, kept for a second pass.
   *
   * Decoding is the whole cost of an analysis; detecting from what the decode
   * produced is arithmetic over a few hundred thousand floats. Throwing these
   * away meant that moving the threshold slider by one decibel sent the file
   * back through the decoder — minutes of waiting for a decision that could
   * have been remade in milliseconds.
   *
   * Only the settings that change *how the signal is measured* invalidate it:
   * the window length decides the shape of this array, so a change there really
   * does need the file again. Everything else — the threshold, the margins, the
   * minimum lengths, the channel rule — is applied on top of it by
   * {@link detectSilence}, which is why that function takes these rather than a
   * file.
   *
   * Optional because it is an in-memory convenience and nothing else: it is
   * never written to a project document, so an analysis restored from one
   * simply does not have it.
   */
  stats?: WindowStatistics;
}

/**
 * Compact waveform: one min/max pair per horizontal bucket rather than one
 * entry per audio frame, so hours of media cost kilobytes instead of gigabytes.
 */
export interface WaveformData {
  /** Lowest sample value of each bucket, in [-1, 1]. */
  min: Float32Array;
  /** Highest sample value of each bucket, in [-1, 1]. */
  max: Float32Array;
  /** RMS of each bucket, in [0, 1]. Drawn as the solid core of the waveform. */
  rms: Float32Array;
  /** Seconds covered by each bucket. */
  secondsPerBucket: number;
  duration: number;
}

/** How the analyser collapses a multi-channel signal into one decision. */
export type ChannelMode = 'combined' | 'any' | 'all';

/** Everything the reader can tune. */
export interface SilenceSettings {
  /** Level below which a window may count as silence, in dBFS. */
  thresholdDb: number;
  /** How long the signal must stay below the threshold to count as silence. */
  minimumSilenceMs: number;
  /** Margin preserved before speech resumes (pre-roll). */
  keepBeforeMs: number;
  /** Margin preserved after speech ends (post-roll). */
  keepAfterMs: number;
  /** Kept fragments shorter than this are absorbed by the surrounding silence. */
  minimumKeptSegmentMs: number;
  /** Window size used to measure loudness. */
  detectionWindowMs: number;
  channelMode: ChannelMode;
  /** Fade applied at each cut point. Render-only: it never invalidates analysis. */
  crossfadeMs: number;
  /**
   * Push in on the picture after the pauses that stood out.
   *
   * Render-only, like the crossfade: it is decided from an analysis that has
   * already happened, so changing it never sends the file back through the
   * detector.
   */
  autoZoom: AutoZoomSettings;
}

/**
 * The subset of {@link SilenceSettings} that changes what gets detected.
 *
 * Anything listed here invalidates a finished analysis; anything outside it
 * (`crossfadeMs` and `autoZoom`) is applied at render time and leaves the
 * analysis valid. This constant is the single definition of that rule — the component
 * compares two settings objects through it instead of listing fields again.
 */
export const DETECTION_KEYS = [
  'thresholdDb',
  'minimumSilenceMs',
  'keepBeforeMs',
  'keepAfterMs',
  'minimumKeptSegmentMs',
  'detectionWindowMs',
  'channelMode'
] as const satisfies readonly (keyof SilenceSettings)[];

/** True when the two settings differ in any field that affects detection. */
export function detectionSettingsChanged(a: SilenceSettings, b: SilenceSettings): boolean {
  return DETECTION_KEYS.some((key) => a[key] !== b[key]);
}

/** Everything we could safely determine about the selected file. */
export interface MediaInfo {
  fileName: string;
  fileSize: number;
  /** Container as detected from the bytes, not from the extension. */
  containerName: string;
  mimeType: string;
  kind: 'video' | 'audio';
  durationSeconds: number;
  hasAudioTrack: boolean;
  audioCodec: string | null;
  sampleRate: number | null;
  channelCount: number | null;
  videoCodec: string | null;
  /**
   * The track's WebCodecs codec string, such as `avc1.640028`.
   *
   * Distinct from `videoCodec`, which is the family name (`avc`). Only this one
   * can be handed to `VideoDecoder.isConfigSupported`; the family name is
   * rejected outright, which silently turns every support probe into a "no".
   */
  videoCodecString: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
}

/** Stages reported while analysing, in the order they run. */
export type AnalysisStage =
  | 'reading'
  | 'decoding'
  | 'waveform'
  | 'detecting'
  | 'preparing';

/** Stages reported while rendering the output file. */
export type RenderStage =
  | 'preparing'
  | 'decoding'
  | 'cutting'
  | 'encoding'
  | 'muxing'
  | 'saving'
  | 'finishing';

export interface ProgressReport<TStage> {
  stage: TStage;
  /** 0..1, or null when the stage genuinely cannot be measured. */
  ratio: number | null;
}

/** The tool's state machine. Every visible control is derived from it. */
export type SilenceCutterState =
  | 'idle'
  | 'file-selected'
  | 'analyzing'
  | 'analysis-ready'
  | 'analysis-invalid'
  | 'processing'
  | 'completed'
  | 'error';

/** How the video track is written out. */
export type VideoMode =
  | 'stream-copy'
  | 'webcodecs-hardware-preferred'
  | 'webcodecs-software'
  | 'none';

/** Which engine computes the window statistics. */
export type AudioAnalysisMode = 'webgpu' | 'worker' | 'inline';

/** How the waveform is painted. */
export type WaveformMode = 'accelerated-canvas' | 'canvas2d';

/** The pipeline chosen for one particular file. */
export interface ProcessingStrategy {
  videoMode: VideoMode;
  audioAnalysisMode: AudioAnalysisMode;
  waveformMode: WaveformMode;
  /** Codec chosen for the output audio track. */
  audioCodec: string;
  /** Codec chosen for the output video track, when there is one. */
  videoCodec: string | null;
  /** Container the output will be written into. */
  container: string;
  /**
   * Whether the validated encoder configuration asked for hardware
   * acceleration. It is a preference the browser may ignore, so the UI must
   * never present it as proof that a particular GPU is in use.
   */
  hardwareAccelerationPreferred: boolean;
  /** Plain-language reason for the choice, shown under "Processing details". */
  notes: string[];
}

/** What the reader may force from the advanced panel. */
export type OptimizationPreference = 'automatic' | 'prefer-hardware' | 'compatibility';

/** Result of a finished render. */
export interface RenderResult {
  blob: Blob | null;
  fileName: string;
  /** Set when the file was streamed straight to disk and never held in memory. */
  savedToDisk: boolean;
  outputDuration: number;
  removedDuration: number;
  cutCount: number;
  strategy: ProcessingStrategy;
}

/** Raised when the reader cancels; callers treat it as a normal outcome. */
export class OperationCanceledError extends Error {
  constructor() {
    super('The operation was canceled.');
    this.name = 'OperationCanceledError';
  }
}

/** Raised with a message already written for the reader. */
export class MediaToolError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'MediaToolError';
  }
}
