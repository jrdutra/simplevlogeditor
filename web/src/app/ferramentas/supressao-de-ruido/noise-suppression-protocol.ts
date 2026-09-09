import { LoudnessSettings } from '../../shared/media/loudness';
import { EngineId, ProcessingDevice, SuppressionProgress } from './noise-suppression.models';
import { GainField } from './spectral-gain';

export interface SuppressionRequest {
  channels: Float32Array[];
  rate: number;
  engine: EngineId;
  device?: ProcessingDevice;
  attenuationDb: number;
  /** Leave the band above the engine's reach exactly as it was. */
  preserveHighs?: boolean;
  /** Levelling, from the shared module. Absent means leave the volume alone. */
  loudness?: LoudnessSettings;
  /**
   * The decision from a previous run over the same audio.
   *
   * Given one, the engine is not run at all. Changing the strength, the
   * brightness or the levelling does not change what the engine heard, and
   * listening to a twenty-minute recording again to answer the same question is
   * a minute of somebody's afternoon for nothing.
   */
  cachedField?: GainField;
}

/** What levelling did, for the line the page shows afterwards. */
export interface LevellingReport {
  /** The speech level found after the noise was removed, in dBFS. */
  measuredDb: number;
  /** The flat part of the correction, in dB. */
  staticGainDb: number;
  /** True once the correction was held back by the boost or cut limit. */
  clipped: boolean;
}

export type SuppressionResponse =
  | { type: 'progress'; progress: SuppressionProgress }
  | {
      type: 'done';
      channels: Float32Array[];
      reduction: number;
      levelling: LevellingReport | null;
      /** What the engine decided, so the next run can skip it. */
      field?: GainField;
    }
  | { type: 'error'; message: string };
