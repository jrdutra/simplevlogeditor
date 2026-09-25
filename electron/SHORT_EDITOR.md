# Short Editor

The desktop tool lives at `/shorts-generator` (the original route is preserved). It accepts one horizontal video and keeps a separate session in `userData/short-editor.json`. It does not read, save or modify the Video Editor project. AI plugins are unchanged.

The source preview is followed by the same timeline as the silence cutter: a picture track ("Video Image", tiled with the frame at the exact second each tile starts, re-taken on every zoom) above a sample-accurate audio waveform, sharing one ruler. Left-drag to add a cut, drag its edges to trim, right-drag to slide, click a cut and use ✕ to remove it, or enter exact seconds. Cut order can be changed with the arrow buttons. Each cut has a settings button that opens its own dialog, where the picture is dragged sideways inside a 9:16 frame to choose that cut's framing. Zoom ranges from 1× to 20×. Create a short to capture the current ordered cuts and draft settings in an independent card. Use **Cuts** to edit a card on the main timeline, or **Settings** for its name, audio (original and chosen audio levels) and transitions, with a preview of the short. A picked cut on the timeline shows an image button that opens its framing dialog; the mouse wheel zooms the timeline. **Clear all** empties the session.

Rendering uses the bundled FFmpeg and exports MP4/H.264/AAC at 1080×1920, 30 fps. The vertical crop can be positioned horizontally. Transitions are direct cuts, dissolve, left wipe or right slide; non-cut transitions overlap by at most half of either neighboring cut. Replacement audio starts at zero and loops to fill the short. Silent sources are supported. Final playback is available in each rendered card; the unrendered card shows its opening frame. Captions are not included.

Exports refuse existing destinations. Work is staged in a uniquely named temporary file, then published only on success. Canceling removes that temporary file. Deleting a card does not delete exported media. Replacing the source requires explicit confirmation when cards exist. Two shorts may render concurrently. Interrupted renders can be restarted after reopening the app.

## MCP

Call `show_tool` with `tool: "shorts-generator"` to display the tool. All editing functions are host-owned and work without activating the Video Editor route. Every mutation requires a unique `requestId`; retrying an identical request with that ID does not duplicate a card or render. Local media/output paths use the existing allowed-folders checks, including real-path validation.

| Command | Purpose |
| --- | --- |
| `short_get_state` | Source metadata, filmstrip/waveform images, ordered selection, settings, cards, render status/progress and view state |
| `short_import_video` | Import `path`; use `replace: true` to discard existing cards |
| `short_set_selection` | Set ordered `ranges: [{start, end, cropX?, cropTrack?}]` in source seconds and optional draft `settings` |
| `short_create` | Create a card from the current selection, or supplied `ranges`, `name` and `settings` |
| `short_update` | Update a card by `id`: `ranges`, `name`, `settings`; invalidates rendered preview |
| `short_set_focus` | Set a fixed focus or pan during one cut's source-time interval; preserves the path outside that interval |
| `short_delete` | Remove a card by `id`, preserving exports |
| `short_render` | Start a render using `id` and a new `outputPath`; poll `short_get_state` |
| `short_cancel_render` | Cancel a render by `id` |
| `short_set_view` | Set `zoom` (1–20) or source `playhead` |

Settings: `audioPath` (null restores source audio), `volume` (0–2, the original sound; with `audioPath`, 0 replaces it and more mixes it under the chosen audio), `musicVolume` (0–2, the chosen audio), `cropX` (0–1, the framing of any cut that has no `cropX` of its own), `transition` (`cut`, `fade`, `wipeleft`, `slideright`), `transitionSeconds` (0.05–2). The chosen transition applies at every junction in that short.

## Verification

`npm run test:shorts` runs validation/contract tests. Set `SVE_SHORT_MEDIA_TEST=1` to also generate synthetic media and test actual imports, all transitions, replacement audio, silent footage, export durations/resolution, cancellation, overwrite protection and recovery. `SVE_FFMPEG` and `SVE_FFPROBE` may point to `vendor/ffprobe/win32-x64` executables when they are not on PATH.

After building the web app, run `electron scripts/smoke-short-editor.js` for the hidden-window UI smoke test. It uses the real main process and preload, an isolated profile and endpoint, and synthetic footage in a uniquely named `.sve-short-ui-*` workspace directory. Its printed fixture directory may be removed after the process exits. It checks card creation, cut editing, modal settings, zoom overflow, rendering, stable playback during polling and switching back to Video Editor.

## Following a person

The framing dialog of a cut has **Follow the person**. The cut is analysed on the device (Human 3.3.6 with TensorFlow.js, vendored in `web/src/app/vendor/human`, models in `web/src/assets/models/human`; nothing is uploaded): a face first; with several faces, the one whose mouth is moving (the speaker); with no face visible, the person's body. The result is stored on the cut as `cropTrack: [{t, x}]` — `t` in seconds of the source, `x` the framing 0–1 — joined by straight lines, clamped so the 9:16 frame never leaves the picture. Rendering follows it in both the browser and FFmpeg (a piecewise-linear `crop` x expression).

Beside the box, a settings button opens the follow settings: **Wait before changing person** (off by default; when on, *Start following after* and *Keep following for*, 100 ms each by default) and **Smoothness** (abrupt, slightly smooth, smooth, very smooth). They are stored on the cut as `follow: {delays, startDelayMs, holdDelayMs, smoothness}`; changing them redraws `cropTrack` from the analysis already made, without reading the video again.

When nobody can be seen (before the person first appears, or once the tracking loses them for more than about 0.3 s, or for the hold wait when the waits are on), the frame goes back to the cut's own framing, `cropX`, the one chosen by hand before ticking the box, at the chosen smoothness. The move starts at the moment the person is lost, never before, and the frame goes back to the person when they are found again (after the start wait, when the waits are on). Ticking the box again after moving the framing by hand redraws the path for the new position.

Detection runs in an isolated, cancellable worker. Desktop uses local WebAssembly SIMD to avoid depending on the Electron GPU driver; browsers try WebGL and retry with WebAssembly if initialization or inference fails/times out. Initialization and inference have bounded waits. Closing the cut, switching sources or leaving the tool cancels the analysis. Mouth movement is a visual heuristic, not audio-based speaker recognition.

### Assistant-directed focus

Use `short_set_focus` when the assistant decides a scene should show an object, scenery or another subject. It does not automatically decide whether somebody is speaking or understand the transcript. The assistant chooses the interval and position from its own context.

```json
{
  "id": "short-id-from-short_get_state",
  "cutIndex": 0,
  "start": 12,
  "end": 16,
  "x": 0.75,
  "endX": 0.9,
  "transitionSeconds": 0.2,
  "requestId": "focus-scene-1"
}
```

Times are absolute seconds in the original video, inside the selected cut. `cutIndex` starts at zero. Omit `id` to edit the draft selection. `x` is the horizontal crop position: 0 left, 0.5 center, 1 right. Omit `endX` to hold the position; supply it to pan. Entry/exit blends take place inside the interval (default 0.2 seconds, limited to half its length); zero requests a near-instant 1 ms change. The path outside the interval is unchanged. The resulting `cropTrack` is persisted and used by preview and export; rendering must be requested again. Re-running automatic tracking on that cut replaces the custom path. Exported files remain on disk.

Run `electron scripts/smoke-short-tracking.js` after a development build to exercise real desktop range-backed media and bundled detector models in a hidden, isolated application.

Use `--large-media` to generate a larger 1080p video with audio and track a nonzero-time cut while eight read-ahead readers are paused. This reproduces the Electron-only HTTP connection starvation that previously left tracking at 0% until the video-read timeout. Local file streams now finish each bounded 1 MiB response before yielding bytes, so a paused decoder retains buffered data rather than an occupied HTTP connection. Native browser Files keep their existing behavior.
