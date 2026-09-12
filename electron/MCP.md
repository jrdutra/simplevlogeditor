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

On Windows, separate multiple roots with `;`; on macOS and Linux use `:`. The
server refuses every imported or exported path outside these roots. If the
variable is absent, only the process working directory is admitted.

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
6. `apply_edit_batch` with `dryRun: true` and the current project revision.
7. Apply the same batch after inspecting its duration diff.
8. Read the timeline again, inspect frames around cuts and `export`.

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

`health_check` exposes `starting`, `ready`, or `busy`. `get_diagnostics` includes
both MCP and Electron PIDs, window count, connection state, active jobs, memory,
last error, roots and FFmpeg/FFprobe availability. Structured logs are written to
stderr; set `SVE_MCP_LOG_FILE` for a rotating 5 MB JSONL log.

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
- `add_caption`
- `remove_caption`
- `update_caption`
- `add_text_clip` / `update_text_clip` / `set_text_background`
- `add_transition` / `update_transition`
- `set_tag` / `remove_tag` (including animated social and QR Code designs)
- `add_push_in` / `update_push_in` / `remove_push_in`
  (`add_zoom` / `update_zoom` / `remove_zoom` remain compatible aliases)
- `set_clip_edits` / `clear_clip_overrides`
- `attach_audio` / `detach_audio`
- `set_project_settings`

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

## Security boundary

The renderer remains sandboxed with Node disabled. File reads and streaming
writes happen in the Electron main process, are constrained by
`SVE_MCP_ROOTS`, and are reached through narrow IPC methods. There is no generic
JavaScript execution MCP tool and no general filesystem tool.
