'use strict';
const ranges = { type: 'array', maxItems: 100, items: { type: 'object', properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 }, cropX: { type: 'number', minimum: 0, maximum: 1, description: 'Optional horizontal framing of this cut only (0 left, 0.5 center, 1 right). Omit to use the short settings cropX.' }, cropTrack: { type: 'array', maxItems: 3000, description: 'Optional person tracking: the framing follows these points (t in seconds of the source video, x 0..1), joined by straight lines. Made by the Short Editor\'s "Follow the person" option; replaces cropX while present.', items: { type: 'object', properties: { t: { type: 'number' }, x: { type: 'number', minimum: 0, maximum: 1 } }, required: ['t', 'x'], additionalProperties: false } }, follow: { type: 'object', description: 'How the tracked path was drawn: waits before changing person (ms, used when delays is true) and smoothness. Informational; cropTrack is what renders.', properties: { delays: { type: 'boolean' }, startDelayMs: { type: 'number', minimum: 0, maximum: 5000 }, holdDelayMs: { type: 'number', minimum: 0, maximum: 5000 }, smoothness: { enum: ['abrupt', 'slight', 'smooth', 'very'] } }, required: ['delays', 'startDelayMs', 'holdDelayMs', 'smoothness'], additionalProperties: false } }, required: ['start', 'end'], additionalProperties: false } };
const settings = { type: 'object', properties: {
  audioPath: { type: ['string', 'null'], description: 'Allowed local audio path; null restores original sound. Replacement loops to fill the short.' },
  volume: { type: 'number', minimum: 0, maximum: 2, description: 'Level of the original sound (1 = unchanged). With a replacement audio, 0 replaces the original entirely; above 0 mixes it under the replacement.' },
  musicVolume: { type: 'number', minimum: 0, maximum: 2, description: 'Level of the replacement audio chosen in audioPath (1 = unchanged).' },
  cropX: { type: 'number', minimum: 0, maximum: 1, description: 'Horizontal framing: 0 left, 0.5 center, 1 right. Output is 1080x1920.' },
  transition: { enum: ['cut', 'fade', 'wipeleft', 'slideright'] },
  transitionSeconds: { type: 'number', minimum: 0.05, maximum: 2 },
  audioFadeOut: { type: ['number', 'null'], minimum: 0, maximum: 2, description: 'Seconds the sound of a cut fades out where a transition overlaps it with the next (0 = no fade, full volume to its last frame). null = a crossfade as long as the overlap.' },
  audioFadeIn: { type: ['number', 'null'], minimum: 0, maximum: 2, description: 'Seconds the sound of a cut fades in where a transition overlaps it with the previous (0 = no fade). null = a crossfade as long as the overlap.' }
}, additionalProperties: false };
const id = { type: 'string' }, name = { type: 'string' };
const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: {
  type: 'object',
  properties: name === 'short_get_state' ? properties : { ...properties, requestId: { type: 'string', description: 'Unique mutation id. Reuse only when retrying the identical request.' } },
  required: name === 'short_get_state' ? required : [...required, 'requestId'], additionalProperties: false
} });
module.exports = [
  tool('short_get_state', 'Read the independent Short Editor session, source, visual/audio timeline, selected cuts, settings and render progress. Does not use or change the Video Editor project. Use show_tool with shorts-generator to display it.', {}),
  tool('short_import_video', 'Load one horizontal local video into Short Editor. Existing shorts require explicit replace=true. Generates the filmstrip and waveform.', { path: { type: 'string' }, replace: { type: 'boolean' } }, ['path']),
  tool('short_set_selection', 'Set ordered source-time cuts on both video and audio tracks and optionally the draft audio/transition settings. Empty ranges clears selection.', { ranges, settings }, ['ranges']),
  tool('short_create', 'Create an independent vertical short card from supplied cuts or current selection. Clears selection after creation.', { name, ranges, settings }),
  tool('short_update', 'Update a short name, ordered cuts, replacement audio, volume, vertical framing or transitions. Invalidates its rendered preview.', { id, name, ranges, settings }, ['id']),
  tool('short_set_focus', 'Override the horizontal focus during a source-time interval, for example B-roll or a scene without a visible speaker. The caller chooses the subject/position; this does not infer meaning from speech. Omit id to edit draft selection, or pass a short id. Preserves tracking outside the interval and invalidates a short render. Positions: 0 left, 0.5 center, 1 right. Optional endX pans across the interval; transitionSeconds blends into/out of the previous framing within the interval (default 0.2, capped to half its length). To replace an entire custom path use short_update ranges.cropTrack.', {
    id, cutIndex: { type: 'integer', minimum: 0, description: 'Zero-based index in ordered ranges/selection.' },
    start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 },
    x: { type: 'number', minimum: 0, maximum: 1 }, endX: { type: 'number', minimum: 0, maximum: 1 },
    transitionSeconds: { type: 'number', minimum: 0, maximum: 2 }
  }, ['cutIndex', 'start', 'end', 'x']),
  tool('short_delete', 'Remove a short card. Exported files are preserved.', { id }, ['id']),
  tool('short_render', 'Start rendering one short to a NEW allowed .mp4 path at 1080x1920. Returns immediately; poll short_get_state. Existing files are never overwritten.', { id, outputPath: { type: 'string' } }, ['id', 'outputPath']),
  tool('short_cancel_render', 'Cancel rendering one short and remove its temporary output.', { id }, ['id']),
  tool('short_clear', 'Clear the whole Short Editor session: the source video, the selection and every short card. Stops renders in progress. Exported files are preserved. Same as the Clear all button.', {}),
  tool('short_set_view', 'Set timeline zoom and source playhead. Zoom preserves shared audio/video cut positions and enables horizontal scrolling.', { zoom: { type: 'number', minimum: 1, maximum: 20 }, playhead: { type: 'number', minimum: 0 } })
];
