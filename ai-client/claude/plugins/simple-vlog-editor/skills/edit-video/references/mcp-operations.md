# SimpleVlogEditor MCP operations

Always call `get_editor_capabilities` because the running editor is the final authority. This reference explains the intended workflow and the stable operation families.

## Understanding tools

- `queue_media_import`: enqueue absolute local paths without transferring bytes; use a stable `requestId`.
- `get_import_status`: progress, revision, imported asset IDs, and per-file outcomes.
- `cancel_import` / `resume_import`: stop or continue only the unfinished portion of a job.
- `health_check` / `get_diagnostics`: connection, process, window, queue and external-tool health.
- `get_recovery_state` / `checkpoint_project`: inspect or force the complete JSON recovery checkpoint.
- `restart_editor` / `close_editor`: save state and restart or close the visible Electron process without losing the edit.
- `get_operation_status` / `cancel_operation`: priority-channel progress and cooperative cancellation, even while the edit queue is busy.
- `finish_editing`: show the final Preview/Render choice in the visible editor.
- `get_project`: complete serialized edit and revision.
- `list_assets`: unique sources, media metadata, availability, and clip usage.
- `get_timeline`: source/output timing, cuts, captions, tags, transitions, audio, zooms, and push-in IDs.
- `transcribe`: word timestamps, grouped phrase timestamps, quality guidance, and words remapped through the current edit. Use Small Quality by default; use `auto` for spoken-language detection and Turbo when quality needs review. Voice/GTCRN + Balanced is the default denoise setup. Friendly aliases such as `base`, `small`, `turbo`, `pt`, `pt-BR`, and `en` are accepted. `timeoutMs` bounds the whole call; `stageTimeoutMs` is a separate watchdog reset at each decode, denoise, model-load, and recognition stage.
- `analyze_silence`: detected ranges and bounded waveform metadata. Set `includeWaveform` for the first bounded page only.
- `analyze_noise`: DNSMOS/VAD-backed background diagnosis for one clip or all audible media. Returns status, levels, quality, intervals and evidence. It never enables or applies suppression.
- `suppress_noise`: explicit per-clip removal, audible preview cache and export scheduling. Use only after an explicit user request to remove noise; default to `gtcrn` + `balanced` unless evidence says otherwise.
- `get_waveform_page`: request later waveform buckets without producing an oversized MCP response.
- `get_contact_sheet`: broad visual sampling of one source interval; include a unique `requestId` when progress/cancellation may be needed.
- `get_frames`: exact source frames returned as MCP image content; include a unique `requestId` when progress/cancellation may be needed.
- `export`: render to an admitted local path. Give it a unique `requestId`, poll `get_operation_status` for stage/percentage, and use `cancel_operation` to remove partial output when the user stops it.

Renderer-facing work is ordered so a read never observes half of an atomic batch and browser decoders are not exhausted. Priority health, import/operation status, diagnostics, cancellation, close, and restart remain responsive. Iterate over all distinct assets. Start with contact sheets, then request exact frames at speech boundaries and uncertain moments rather than sampling hundreds of redundant images.

Project-changing calls require a non-empty `requestId`: `add_media`,
`queue_media_import`, `open_project`, `set_project_soundtrack`,
`analyze_silence`, `analyze_noise`, `suppress_noise`, committed `apply_edit_batch`, `undo`, and `redo`. Generate a
new id for a new intended mutation. If the connection drops before the result is
known, retry the exact payload with the exact same id; Electron returns the
original in-flight/completed result. A reused id with different content fails
with `idempotency_conflict`. After an Electron restart, re-read the project and
use fresh ids and the current revision.

## Timeline operations

`apply_edit_batch` accepts atomic operation groups for:

- removing, moving, and duplicating clips;
- adding and updating text cards and their image backgrounds;
- adding and updating transitions;
- splitting, trimming, clearing trims, deleting source ranges, and restoring ranges;
- enabling or disabling detected silence ranges;
- setting image duration, speed, volume, audio mode, fades, silence behavior, denoise-related edit settings, and automatic zoom settings;
- scheduling per-clip noise removal with `set_noise_suppression` (checkbox semantics only; it does not process immediately);
- attaching or detaching project or per-clip audio;
- adding, updating, and removing captions;
- adding, updating, and removing ordinary, social, Subscribe, and QR Code tags;
- adding, updating, and removing manual dynamic push-ins;
- changing aspect ratio, reframe mode, resolution, output formats, loudness, soundtrack fades, and project defaults.

Use `undo` and `redo` for whole batches. Use `preview` to open, seek, play, pause, or close the shared visual preview. Use `save_project`, `open_project`, and `export` only with paths admitted by the Electron MCP bridge.

### Caption groups and Background captions

Read `get_capabilities.captions.presetGroups`, `fonts`, and `animations` instead of inventing IDs. The `classic` group contains ordinary caption designs. The `background` group contains ready-made upper-left, upper-center, upper-right, center-left, center, and center-right designs that use the existing caption timeline. Its expanded presets combine clean, rounded, serif, mono, condensed, display, geometric, slab-serif, and handwritten letterforms with still, subtle zoom, or slow scroll motion. They draw the text, then place a worker-generated portrait matte over it in both preview and export. The legacy `behind-subject` ID is the still upper-center background preset. The first use may download the local ONNX model. If segmentation is unavailable or no person is found, the text remains visible and the selected background preset and motion are preserved.

```json
{
  "type": "add_caption",
  "clipId": "clip-3",
  "start": 12.4,
  "duration": 2.8,
  "text": "2 DIAS",
  "caption": {
    "stylePreset": "behind-subject-zoom-in-display",
    "positionX": 0.5,
    "positionY": 0.5,
    "animation": "zoom-in",
    "fontScale": 0.28
  }
}
```

**Minimum time on screen.** A tag and a background caption both need more than
four seconds. Below that they read as a flicker: a Subscribe badge or QR code
nobody had time to act on is worse than none, and a large title that leaves
before it can be read only competes with the shot. Give every tag, and every
caption from the `background` group, a duration above four seconds — longer when
the wording is long or the shot is busy. Ordinary `classic` subtitles are
exempt; they follow the speech and the suggested reading time already sizes them.

Use source seconds. `positionX` and `positionY` are normalized frame coordinates. Inspect representative frames before choosing placement, keep the coordinates fixed throughout the interval, and use short text so the subject hides only part of the lettering.

Music defaults to the project, not a clip. For a generic request such as “add background music,” call `set_project_soundtrack` early. This explicit project setting supplies silent clips, timelapses, images, and text cards. `attach_audio` without `clipId` remains compatible inside a batch; supply `clipId` only for an explicitly named section.

Before importing media, prefer an existing `simplevlogeditor-recovery.sve.json` or other saved `.sve.json` in the working media directory. Open it and inspect `recoveryReport`; import only missing/new sources. After every open, recovery, or restart, call `get_project` and discard all prior revisions/request ids.

Text cards should have fade-in and fade-out treatment. Fade out the preceding video and fade in the following one around the card. Use a transition for adjacent clips that continue the same topic; prefer a fade-out/fade-in break when the subject changes.

## Push-in example

```json
{
  "expectedRevision": 12,
  "requestId": "3ec75fc9-fbdd-49a7-a351-d2c48ed7c60c",
  "label": "Emphasize the conclusion",
  "dryRun": true,
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

Use `get_timeline` after committing to obtain the generated `pushInId` for updates or removal.

## Subscribe and QR example

```json
{
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

Use shape IDs returned by `get_editor_capabilities`; do not assume this example is exhaustive.
# Video Effects (container only)

Discover IDs in `get_capabilities.videoEffects.presets`. Example operation inside a revision-guarded, idempotent `apply_edit_batch`:

```json
{ "type": "set_video_effect", "clipId": "clip-1", "effectId": "background-blur", "intensity": 0.75 }
```

Use `effectId: "none"` to restore Original. No global effect exists. `get_timeline` reports each container's saved `videoEffect`. Effects are composited before captions and tags, including both sides of transitions. Local segmentation is shared with Behind Subject captions. Missing subjects retain the original picture; unavailable GPU/models show an explicit preview warning and prevent silent effect omission during export. Depth/face/pose are not selectable presets yet.

## Video Effect sections

| Operation | Required | Optional |
| --- | --- | --- |
| `set_video_effect` | `clipId`, `effectId` | `intensity` |
| `add_video_effect` | `clipId`, `start`, `effectId` | `duration`, `intensity`, `fadeSeconds` |
| `update_video_effect` | `clipId`, `videoEffectId` | `videoEffect.{effectId,intensity,startSeconds,durationSeconds,fadeSeconds}` |
| `remove_video_effect` | `clipId`, `videoEffectId` | — |

`start`, `duration`, `startSeconds`, `durationSeconds` and `fadeSeconds` are all
in **original source seconds**. A section lasts at least 0.1s. Sections may
touch exactly but never overlap; an overlapping request fails with
`video_effect_overlap` and `details` carrying `maximumDuration`, `clipBounds`
and the `occupied` ranges. `effectId: "none"` is refused — use
`remove_video_effect`. Read `get_editor_capabilities.videoEffects.presets` for
valid ids and `get_timeline` for the `videoEffectId` of an existing section.

`fadeSeconds` 0 is a hard cut into and out of the effect; above 0 eases it in
and out over that many seconds, clamped to half the section.

```json
{
  "expectedRevision": 12,
  "label": "Grade the opening line",
  "operations": [
    { "type": "add_video_effect", "clipId": "clip-1", "start": 0, "duration": 3.5,
      "effectId": "cinematic", "intensity": 0.7, "fadeSeconds": 0.5 }
  ]
}
```

# Placed images

A picture placed over a stretch of one visual container, on that container's own
source clock. Per container, never inherited, and — unlike effect sections —
free to overlap each other: a logo in a corner and a screenshot in the middle is
a normal placement.

| Operation | Required | Optional |
| --- | --- | --- |
| `add_image` | `clipId`, `path`, `start` | `duration`, `style`, `positionX`, `positionY`, `scale`, `rotationDegrees`, `opacity`, `fadeSeconds` |
| `update_image` | `clipId`, `imageId`, `image` | `image.{path,startSeconds,durationSeconds,style,positionX,positionY,scale,rotationDegrees,opacity,fadeSeconds}` |
| `remove_image` | `clipId`, `imageId` | — |

`path` is an absolute path inside the allowed roots. The editor opens and
decodes it locally; no picture bytes leave the machine. The project stores only
enough to find the file again, exactly as it does for video and music, so a
picture that is moved away is reported as missing rather than silently dropped
from the export.

| Field | Meaning |
| --- | --- |
| `style` | `overlay` sits on top of everything. `behind-subject` joins the middle layer — in front of the scenery, behind the person — like a background caption. With no person found it stays visible. |
| `positionX`, `positionY` | The **centre** of the picture, 0–1, as shares of the finished frame. 0.5, 0.5 is the middle. |
| `scale` | Width as a share of the frame width, 0.02–2. The aspect ratio is always kept, so this is the whole size control. |
| `rotationDegrees` | −180 to 180. **Stay within ±20 unless the user asked for more.** |
| `opacity` | 0.05–1, steady, separate from the fades at the two ends. |
| `fadeSeconds` | 0–10. 0 is a hard cut; above 0 fades the picture in and out, clamped to half the placement. |

`start`, `duration`, `startSeconds` and `durationSeconds` are in **original
source seconds**. A placement lasts at least 0.2s.

Across a transition, `overlay` placements from both joined containers keep
drawing, while `behind-subject` ones stand down for the length of the join — the
same thing a Background Caption does, because two shots mean two mattes. Prefer
`overlay` for a picture that has to survive a join.

`get_timeline` returns each placement under the container's `images`, with
`imageId`, `name`, `path`, the natural pixel size, the placement values, the
measured `box` in frame pixels, `fitsInFrame`, and `covers` — the captions and
tag this picture is drawn over, measured by the editor from the same geometry it
draws with. A non-empty `covers` is a placement to fix.

The editor's panel can show the user either the original file clock or the
edited clip clock. That is a display choice in its fields and changes nothing
here: every time in every operation and every reply is original source seconds.
`get_editor_capabilities.timeSpace` says the same.

## Verifying a placement

`get_frames` returns the **source** frame by default: no zoom, no caption, no
effect, no placed picture. Pass `composited: true` to get the frame as the
export will write it, at the project's frame ratio. That is the only way to see
whether a picture lands whole and in the right place.

```json
{ "clipId": "clip-1", "timestamps": [12.4], "width": 720, "composited": true }
```

The result carries `frame` (the export's pixel size), the per-frame `outputTime`,
the container's `images` report, and `subjectLayerRendered`. A false
`subjectLayerRendered` means the segmentation model did not run for that frame:
position and size are still readable, occlusion is not. Report that rather than
claiming the middle layer was checked.

```json
{
  "expectedRevision": 14,
  "label": "Show the chart while it is mentioned",
  "operations": [
    { "type": "add_image", "clipId": "clip-2", "path": "D:\\Videos\\chart.png",
      "start": 31.2, "duration": 5, "style": "overlay",
      "positionX": 0.72, "positionY": 0.3, "scale": 0.4,
      "rotationDegrees": 0, "fadeSeconds": 0.4 }
  ]
}
```
