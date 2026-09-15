# SimpleVlogEditor MCP server

The desktop application can be launched as a local MCP stdio server. It opens
the real editor window and every MCP mutation goes through the same Angular
timeline and renderer used by the buttons on screen.

## Development configuration

Build the web application first, then point the MCP client at Electron itself:

```json
{
  "mcpServers": {
    "simple-vlog-editor": {
      "command": "node",
      "args": [
        "C:\\path\\to\\simplevlogeditor\\electron\\src\\mcp-host.js"
      ],
      "env": {
        "SVE_MCP_ROOTS": "D:\\Videos;D:\\Exports"
      }
    }
  }
}
```

That `env` block is optional and is an **advanced override**. With no
configuration at all, the editor allows the user's own media folders — Videos,
Pictures, Music, Downloads, Desktop and Documents, asked of Electron rather than
guessed — plus its own project folder. The working directory is never consulted:
a graphical application inherits whatever its launcher had, `C:\WINDOWS\System32`
when started from the Start menu, and rooting file access there refuses every
real media path while reading like a broken permission.

Folders are added at runtime, by the user, in two ways. Choosing or dropping a
file in the editor window allows the folder it came from. A path an agent asks
for that is not yet allowed raises a request in the window, which opens the
native folder picker; the folder picked there is the grant, a pick that does not
contain the requested path is refused and explained, and cancelling fails the
call with `path_consent_denied`. Both are stored in
`%LOCALAPPDATA%\SimpleVlogEditor\roots.json` and survive a restart. **Allowed
folders**, in the editor's project settings, lists every root with its origin and
adds or removes one with immediate effect.

If the MCP client declares the `roots` capability, the server calls `roots/list`
after `notifications/initialized` and follows `notifications/roots/list_changed`;
those folders form their own layer for the life of the session. A client that
does not offer roots, or does not answer, changes nothing.

Precedence, strongest first: `SVE_MCP_ROOTS` > MCP client session > folders the
user allowed > defaults. Setting the variable makes the defaults stand down, so
a pinned list is exactly what it says; consent still applies on top, because a
user who allowed a folder in this application must be obeyed. Above all four
sits a denylist no layer can override, the variable included: Windows itself,
Program Files, ProgramData, other applications' data and bare drive roots. The
editor's own application data is re-admitted explicitly, since the recovery
checkpoint and roots.json live there.

On Windows, separate multiple roots with `;`; on macOS and Linux use `:`.

The Node adapter owns stdio and connects to a stable per-user named pipe owned by
the single Electron process. If the endpoint is absent it starts the editor once;
concurrent callers share the same startup promise. A dropped window or pipe does
not close MCP stdio: calls receive a recoverable error and the adapter reconnects.
This is required on Windows, where GUI executables do not reliably inherit an MCP
client's stdin/stdout pipes. From this directory the
equivalent manual command is:

```bash
npm run mcp
```

For a live Angular development server at `http://localhost:4200`:

```bash
npm run mcp:dev
```

The packaged Electron site also uses a remembered loopback port. This keeps its
origin stable between launches, so the browser-local project and durable file
handles remain available after Electron restarts. If that port is occupied, the
app selects and remembers a safe replacement rather than failing to open.

Every desktop start also records the current executable and, when available,
the source MCP host in `%LOCALAPPDATA%\SimpleVlogEditor\editor-location.json`.
The Codex plugin uses this record through its portable launcher instead of
embedding a user-specific repository path. The supported override is
`SVE_EDITOR_PROJECT_ROOT`, pointing at the folder that contains `electron` and
`web`.

## Editing workflow

The intended agent workflow is:

1. Add local media with `queue_media_import` (or the versioned `add_media`
   compatibility entry point), then poll `get_import_status` until the job is
   `completed`, `partial`, `failed`, or `cancelled`.
2. `list_assets` and `get_timeline` to inventory the project.
   Call `get_editor_capabilities` first when choosing a tag, transition, text
   animation or output format.
3. `transcribe` for every distinct source with audio. Times are source times;
   both word-level and grouped phrase timing are returned.
4. `get_contact_sheet` for broad visual coverage, followed by `get_frames` at
   speech boundaries, scene changes or uncertain moments.
5. `analyze_silence` where waveform and pause evidence helps the decision.
6. `analyze_noise` when the user asks for a diagnosis. It reports evidence for one
   clip or every audible clip and never changes the audio.
7. Only when the user explicitly asks to remove noise, call `suppress_noise` for
   an immediate audible preview or schedule it with `set_noise_suppression`.
8. `apply_edit_batch` with `dryRun: true` and the current project revision.
9. Apply the same batch after inspecting its duration diff.
10. Read the timeline again, inspect frames around cuts and `export`.

## Path-only asynchronous imports (API v2)

`add_media` no longer waits for an entire batch. It accepts only absolute local
paths and returns `{ jobId, requestId, async: true }`. This is the intentional API
v2 migration: clients that previously expected an immediate `added` array must
poll `get_import_status` instead. `queue_media_import` has the same behavior and
is preferred for new clients.

The request accepts `paths`, `atIndex`, `skipDuplicates`, `maxConcurrency` (1 or
2), `requestId`, and `expectedRevision`. Repeating a `requestId` returns the same
job. Each result is one of `imported`, `already_present`, `unsupported`, `missing`,
`failed`, or `cancelled`. Use `cancel_import` and `resume_import` for long jobs.

Only path, size, timestamps, metadata and private range URLs cross IPC. FFprobe
runs in isolated subprocesses, no more than two files are probed at once, commits
preserve input order, and each valid asset is inserted atomically. The renderer
reads byte ranges from disk only when preview/analysis/export asks for them.

`health_check` exposes renderer/import/operation activity and the current connection state. `get_diagnostics` includes
both MCP and Electron PIDs, window count, connection state, active jobs, memory,
recent operations with their terminal errors, last error, roots and FFmpeg/FFprobe availability. Alongside
`roots` it reports `rootSource` — `env` when `SVE_MCP_ROOTS` supplied them, `cwd` when the working
directory did, `project` when a system working directory was refused and the editor's own folder was
used instead, `none` when nothing is reachable — and `rootNotice`, the one-sentence explanation the log
carries. Read those before concluding that a refused media path is a fault rather than a setting. The
same fields appear under `host` for the stdio adapter, which is the process whose environment actually
decides the answer. Structured logs are written to
stderr; set `SVE_MCP_LOG_FILE` for a rotating 5 MB JSONL log.

Renderer-facing commands share an ordered lane, so `get_project` cannot observe
half of an atomic batch and multiple visual decoders cannot exhaust the window.
The priority lane remains available for health, import/operation status,
cancellation, diagnostics, close and restart. Frame extraction and export report
operation progress. Exports and project saves are written to a protected sibling
temporary file and published only after success; cancellation removes the partial
file while preserving any older destination.

## Root cause and correction

Before API v2, `agent:read-files` used `Promise.all(fs.readFile(...))` and sent an
`ArrayBuffer` for every selected video to the renderer. A 5.5 GB batch therefore
allocated and serialized gigabytes across IPC, which could terminate Electron and
permanently close the MCP transport. The `--mcp` launch also bypassed Electron's
single-instance lock, so reconnect attempts created more windows.

The integration now sends descriptors only, streams ranges, queues FFprobe work,
owns one stable IPC endpoint in Electron, applies the single-instance lock in all
modes, and leaves the MCP stdio adapter alive across editor failures.

`preview` can open, play, pause, seek or close the same on-screen preview the
user controls. `save_project` and `open_project` expose the editor's portable
project/settings documents without bypassing the configured filesystem roots.

Every mutating batch is atomic and becomes one undo step. `expectedRevision`
prevents an agent from applying an old plan after the user changes the edit.
Every project mutation (`add_media`, `queue_media_import`, `open_project`,
`set_project_soundtrack`, `analyze_silence`, `analyze_noise`, `suppress_noise`,
committed `apply_edit_batch`, `undo`, and `redo`) requires a non-empty `requestId`. Within the current editor
session, retrying the same payload with the same id returns the original result
without applying it twice, including concurrent retries. Reusing an id for a
different payload returns `idempotency_conflict`; failed attempts are safe to
retry. After an Electron restart, read the restored project and create new ids.

The recovery file is no longer limited to MCP actions. Every debounced manual
timeline/settings change is serialized through Electron to the same atomic
checkpoint, and clearing the timeline clears that checkpoint. Electron also
serializes manual and MCP writes and ignores an older revision that arrives
after a newer one.

## Time spaces

- Source time is measured in the original file. Splits, trims and deleted
  ranges use source time.
- Output time is measured in the finished timeline. `get_timeline` returns
  `outputStart` and `outputDuration` beside every playable clip.
- Transcription returns original source words and `outputWords`, which are
  filtered and retimed through the current edit.

## Batch operations

`apply_edit_batch` accepts up to 500 operations:

- `remove_clip`
- `move_clip`
- `duplicate_clip`
- `split_clip`
- `trim_clip`
- `clear_trim`
- `set_image_duration`
- `delete_source_range`
- `restore_source_ranges`
- `set_detected_range`
- `set_speed`
- `set_volume`
- `set_audio_mode`
- `set_noise_suppression` (per media clip; schedules export processing without
  producing the preview immediately)
- `add_caption`
- `remove_caption`
- `update_caption`
- `add_text_clip` / `update_text_clip` / `set_text_background`
- `add_transition` / `update_transition`
- `set_tag` / `remove_tag` (including animated social and QR Code designs)
- `add_push_in` / `update_push_in` / `remove_push_in`
  (`add_zoom` / `update_zoom` / `remove_zoom` remain compatible aliases)
- `add_video_effect` / `update_video_effect` / `remove_video_effect`
- `add_image` / `update_image` / `remove_image`
- `set_clip_edits` / `clear_clip_overrides`
- `attach_audio` / `detach_audio`
- `set_project_settings`

`add_caption` accepts an optional `caption` style object. Read
`get_capabilities.captions.presetGroups` to distinguish `classic` presets from
`background` presets. Background captions are large, fixed text composited
below a locally segmented presenter, with ready-made upper-left, upper-center,
upper-right, center-left, center, and center-right designs. Additional presets
use display, geometric, slab-serif, and handwritten letterforms with subtle
`zoom-in`, `zoom-out`, and four-direction `scroll-*` motion. Read the advertised
`fonts` and `animations` arrays before setting these fields manually. `positionX`
and `positionY` are normalized frame coordinates and `fontScale` normally ranges
from 0.20 to 0.40 for this style. The legacy `behind-subject` ID remains the
upper-center preset. Motion follows the caption's own duration identically in
preview and export. The same worker-backed mask cache feeds both; when no person
can be isolated, the renderer keeps the saved style and displays the text
without occlusion.

## Per-clip noise diagnosis and removal

`analyze_noise` uses the editor's VAD and DNSMOS-based analysis to return a
status, measured levels, quality windows, evidence, and warnings. It accepts a
single `clipId` or analyzes all audible media clips when no id is supplied. A
diagnosis is read-only with respect to the sound: it must never be interpreted
as consent to alter the clip.

`suppress_noise` is the explicit removal command. It processes one clip with
`gtcrn` or `rnnoise`, stores a session preview, enables the matching per-clip
export setting, and returns the latest analysis. The default is `gtcrn` with
`balanced` strength. There is deliberately no project-wide noise setting.

Every command appears immediately in the **MCP editing activity** console in
the editor. Committed batch operations yield between steps so the timeline,
preview and log visibly advance while the MCP client is editing.

### Dynamic push-in for emphasis

Push-in times use the original source clock, so the client can place one from
the transcript's word timestamps. It is translated through cuts and playback
speed into the final timeline, and the same zoom plan drives preview and export.

```json
{
  "label": "Emphasize the main conclusion",
  "operations": [
    {
      "type": "add_push_in",
      "clipId": "clip-3",
      "start": 42.1,
      "end": 47.4,
      "scalePercent": 16,
      "rampSeconds": 0.45,
      "easeOut": true
    }
  ]
}
```

`scalePercent` accepts 2–80 and `rampSeconds` accepts 0–5. With `easeOut: true`
the camera moves smoothly back before `end`; with `false`, the close framing is
held through the selected interval. Multiple push-ins may be added to a clip.

### Subscribe tag and QR Code

```json
{
  "expectedRevision": 12,
  "label": "Add calls to action",
  "operations": [
    {
      "type": "set_tag",
      "clipId": "clip-3",
      "tag": {
        "text": "Subscribe",
        "shape": "social-subscribe",
        "position": "bottom-right",
        "startSeconds": 2
      }
    },
    {
      "type": "set_tag",
      "clipId": "clip-7",
      "tag": {
        "text": "Open the link",
        "shape": "qr-subscribe",
        "qrText": "https://example.com",
        "position": "bottom-left"
      }
    }
  ]
}
```

### Explanatory text card between videos

`atIndex` is the insertion position in the array returned by `get_timeline`.

```json
{
  "label": "Introduce the next section",
  "operations": [
    {
      "type": "add_text_clip",
      "atIndex": 4,
      "text": "Next: setup, recording and the final result",
      "durationSeconds": 5,
      "draft": {
        "animation": "rise",
        "backgroundColor": "#050b18",
        "color": "#ffffff"
      }
    }
  ]
}
```

Example:

```json
{
  "expectedRevision": 12,
  "label": "Remove failed takes and long hesitations",
  "dryRun": true,
  "operations": [
    {
      "type": "delete_source_range",
      "clipId": "clip-3",
      "start": 83.42,
      "end": 88.16,
      "reason": "Interrupted attempt repeated immediately afterwards"
    }
  ]
}
```

## Visual coverage

`get_contact_sheet` samples up to 49 frames from an interval. It is deliberately
bounded: sending every frame of an hour-long recording would create more than
100,000 images and make the client less able to reason, not more. The client can
cover the whole source in a coarse pass and request denser frames for any
interesting interval with `get_frames`.

Frames are returned as native MCP image content blocks with their exact source
timestamps in the accompanying structured result.

## Subject analysis failures

`export` stops rather than writing a file that is missing the look it was asked
for. A model that ran and found no person is not a failure: it keeps its
designed fallback — ordinary caption text, original picture — and the export
completes. A technical failure raises error code `subject_vision_failed` with
structured `details`: `kind` (`model-unavailable`, `inference-failed`, `timeout`
or `cancelled`), `surface` (`effect` or `caption`), `retryable`, `recoverable`
and `terminalState: "failed"`. The partial output is discarded, so an earlier
export at that path survives and the recovery checkpoint is unaffected.

A client that receives `subject_vision_failed` must not report the edit as
finished. When `retryable` is true, retry the export with a new `requestId`
after the editor has had a chance to reload the model; when it is false, tell
the user and offer a Classic caption preset or the Original effect instead.

### Video Effect sections

`set_video_effect` still applies one effect to a whole container and is the
right call when the user asks for a look on the clip. A request about part of a
clip — "grade the intro", "glitch when he drops the box" — is a section:

```json
{
  "type": "add_video_effect",
  "clipId": "clip-1",
  "start": 4.2,
  "duration": 2.5,
  "effectId": "cinematic",
  "intensity": 0.7,
  "fadeSeconds": 0.4
}
```

`start` and `duration` are **original source seconds**, and `fadeSeconds` is how
long the effect takes to arrive and to leave. Zero, the default, is a hard cut;
above zero eases it in and out, clamped to half the section. Sections may touch
exactly but may not overlap: an overlapping request fails with error code
`video_effect_overlap`, whose `details` carry `maximumDuration`, `clipBounds`
and every `occupied` range with its own `videoEffectId`, so the next attempt can
be made without guessing.

`update_video_effect` takes `videoEffectId` and a partial `videoEffect`
(`effectId`, `intensity`, `startSeconds`, `durationSeconds`, `fadeSeconds`).
`remove_video_effect` takes `videoEffectId`. Use `remove_video_effect` rather
than an `effectId` of `none`, which is refused because it would leave a section
that does nothing. `get_timeline` returns each clip's sections with their ids.

### Placed images

A picture placed over a stretch of one visual container, on that container's own
source clock:

```json
{
  "type": "add_image",
  "clipId": "clip-2",
  "path": "D:\\Videos\\chart.png",
  "start": 31.2,
  "duration": 5,
  "style": "overlay",
  "positionX": 0.72,
  "positionY": 0.3,
  "scale": 0.4,
  "rotationDegrees": 0,
  "opacity": 1,
  "fadeSeconds": 0.4
}
```

`path` is read in the main process and is subject to `SVE_MCP_ROOTS` like every
other file the editor opens. The picture is decoded in the renderer; no picture
bytes leave the machine. The project stores only enough to recognise the file
again, exactly as it does for video and music, so a picture that has been moved
away is reported as missing and the export refuses rather than quietly leaving
it out.

`style` is `overlay` — on top of the finished frame — or `behind-subject`, which
joins the middle layer used by the background captions: in front of the scenery
and behind whoever is talking. With no person found the picture stays visible,
the same fallback the captions take.

`positionX` and `positionY` are the **centre** of the picture as shares of the
frame; `scale` is its width as a share of the frame width, with the aspect ratio
always kept, so it is the whole size control. `rotationDegrees` accepts the full
circle, but an AI client is told to stay within ±20 unless the user asked for
more. `fadeSeconds` 0 is a hard cut, above 0 fades the picture in and out and is
clamped to half the placement.

Across a transition, `overlay` placements from both joined containers keep
drawing; the middle layer stands down for the length of the join, exactly as a
Background Caption does, because two shots mean two mattes and there is no
single silhouette to cut the picture out from.

Placements are per container, never inherited, and — unlike effect sections —
free to overlap each other. `update_image` takes `imageId` and a partial `image`
(including `path`, to swap the picture without restating the placement);
`remove_image` takes `imageId`. `get_timeline` returns each clip's `images` with
their ids, the measured box in frame pixels, `fitsInFrame`, and `covers` — the
captions and tag that placement is drawn over, measured from the same geometry
the renderer draws with rather than left to be spotted in a frame.

### The editor's two clocks

The panel can now show timing on either clock, and the switch sits above the
captions of every container. **This changes nothing over MCP**: `start`,
`duration`, `startSeconds` and `durationSeconds` are original source seconds in
every operation and every `get_timeline` reply, whatever the panel happens to be
displaying. The conversion lives entirely in the fields, so a project edited by
hand on the edited clock and one edited by an agent hold identical values.

### Composed frames

`get_frames` answers with the **source** picture by default — no zoom, caption,
effect or placed picture — which is the right answer for understanding what was
filmed and the wrong one for checking what was made. Pass `composited: true` and
it goes through the same `composeFrame` the preview and the encoder draw with,
at the project's frame ratio, and returns the finished picture together with
`frame`, each frame's `outputTime`, the container's `images` report and
`subjectLayerRendered`. A false `subjectLayerRendered` means the segmentation
model did not run for that frame: position and size are readable from it,
occlusion is not, and a client must say so rather than claim the middle layer
was verified.

## Security boundary

The renderer remains sandboxed with Node disabled. File reads and streaming
writes happen in the Electron main process, are constrained by
`SVE_MCP_ROOTS`, and are reached through narrow IPC methods. There is no generic
JavaScript execution MCP tool and no general filesystem tool.
# Video Effects

`get_capabilities.videoEffects` returns the preset catalogue, normalized intensity range, and supported local vision capabilities. `apply_edit_batch` supports `{ "type": "set_video_effect", "clipId": "clip-1", "effectId": "cinematic", "intensity": 0.75 }`. IDs are validated; unknown effects and non-visual targets are rejected. `none` restores Original. All changes use the existing revision, idempotency, undo, and recovery checkpoint flow. `get_timeline` includes each clip's `videoEffect`.

Video Effects are exclusive to visual media containers and never inherit from project defaults. Preview and export share a GPU effect engine before captions/tags and process transition sides independently. Creator presets reuse local subject masks; no frames are uploaded. If no subject is found, the picture stays original. Model/GPU errors are visible in preview and fail export explicitly. Face, pose, and depth are extension capabilities, not currently available effects.
