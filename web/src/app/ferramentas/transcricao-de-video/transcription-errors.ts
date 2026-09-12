/** Refusals worth making by name, so the page can say what to do instead. */
export class TranscriptionError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly details?: unknown;
  readonly recoverable: boolean;

  constructor(message: string, readonly hint = '', options: {
    code?: string;
    stage?: string;
    details?: unknown;
    cause?: unknown;
    recoverable?: boolean;
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TranscriptionError';
    this.code = options.code ?? 'transcription_failed';
    this.stage = options.stage ?? 'unknown';
    this.details = options.details;
    this.recoverable = options.recoverable ?? true;
  }
}

export class TranscriptionCanceled extends Error {
  readonly code = 'cancelled';
  readonly stage = 'cancelled';
  constructor() {
    super('The transcription was stopped.');
    this.name = 'TranscriptionCanceled';
  }
}
