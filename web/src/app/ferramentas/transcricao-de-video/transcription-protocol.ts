import { Cue } from './subtitle-formats';
import { TranscriptionProgress } from './transcription.models';

export interface TranscribeOptions { model: string; language: string; }
export interface TranscriptionRequest { samples: Float32Array; options: TranscribeOptions; }
export type TranscriptionResponse =
  | { type: 'progress'; progress: TranscriptionProgress }
  | { type: 'partial'; words: Cue[] }
  | { type: 'done'; words: Cue[] }
  | { type: 'error'; error: {
      name: string;
      message: string;
      stack?: string;
      code?: string;
      stage: string;
      model: string;
      language: string;
      recoverable: boolean;
    } };
