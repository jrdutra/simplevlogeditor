/** Refusals worth making by name, so the page can say what to do instead. */
export class TranscriptionError extends Error {
  constructor(message: string, readonly hint = '') {
    super(message);
    this.name = 'TranscriptionError';
  }
}

export class TranscriptionCanceled extends Error {
  constructor() {
    super('The transcription was stopped.');
    this.name = 'TranscriptionCanceled';
  }
}

