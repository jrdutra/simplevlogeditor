import { WindowReduction } from './window-reducer';

/**
 * Messages exchanged with the analysis worker.
 *
 * They live in their own file, away from the worker itself, for one practical
 * reason: the worker declares `/// <reference lib="webworker" />`, and importing
 * anything from it — even a type — would pull that library into the
 * application's compilation, where `self`, `postMessage` and friends mean
 * something else. The protocol is shared; the worker's environment is not.
 */

export interface AnalysisInitMessage {
  type: 'init';
  channelCount: number;
  samplesPerWindow: number;
  windowCount: number;
}

export interface AnalysisChunkMessage {
  type: 'chunk';
  startFrame: number;
  /** One planar Float32Array per channel, transferred rather than copied. */
  channels: Float32Array[];
}

export interface AnalysisFinishMessage {
  type: 'finish';
}

export type AnalysisWorkerRequest = AnalysisInitMessage | AnalysisChunkMessage | AnalysisFinishMessage;

export interface AnalysisWorkerResult extends WindowReduction {
  type: 'result';
}
