'use strict';

/**
 * Short Editor commands that run in the application window rather than in the
 * main process: person detection and speech recognition both run on this
 * computer, in the browser engine, exactly as the window's own buttons do.
 */
const requestId = { type: 'string', description: 'Unique mutation id. Reuse only when retrying the identical request.' };
const tool = (name, description, properties, required = []) => ({
  name, description,
  inputSchema: { type: 'object', properties: { ...properties, requestId }, required: [...required, 'requestId'], additionalProperties: false }
});

module.exports = [
  tool('short_track_person', 'Follow the person in every cut of a short (or of the draft selection when id is omitted), the window\'s "Follow the person" option: detection runs on this computer and keeps the person in the horizontal centre of the vertical frame — a face first, then whoever is speaking, then a body. Where nobody is visible the frame returns to restX. Stores cropTrack and follow on each cut and invalidates the short\'s render. Can take a while on long cuts; returns how much of each cut showed a person.', {
    id: { type: 'string', description: 'Short to track. Omit for the draft selection.' },
    cutIndex: { type: 'integer', minimum: 0, description: 'Only this cut (zero-based). Omit for every cut.' },
    restX: { type: 'number', minimum: 0, maximum: 1, description: 'Framing where nobody is visible: 0 left, 0.5 centre, 1 right. Default: the cut\'s cropX, else the short\'s cropX.' },
    follow: { type: 'object', description: 'Waits before changing person and smoothness of the movement.', properties: {
      delays: { type: 'boolean' }, startDelayMs: { type: 'number', minimum: 0, maximum: 5000 }, holdDelayMs: { type: 'number', minimum: 0, maximum: 5000 },
      smoothness: { enum: ['abrupt', 'slight', 'smooth', 'very'] }
    }, additionalProperties: false }
  }),
  tool('short_generate_captions', 'Transcribe the loaded source video on this computer and turn its words into captions with the spoken word highlighted (the window\'s "Analyze video"). The words apply to the draft settings and to every short that is not rendering; new shorts inherit them. Returns the transcript as timed lines (source seconds) for choosing moments. The model (~82 MB) downloads on first use. A video without sound returns noAudio.', {
    language: { type: 'string', description: 'auto (default), or a language code such as pt, en, es.' },
    enabled: { type: 'boolean', description: 'Turn the captions on (default true).' },
    preset: { enum: ['Classic', 'Neon', 'Impact', 'Minimal', 'Editorial'], description: 'Style to use. Omit to keep the current style (Classic by default).' }
  })
];
