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
- `get_waveform_page`: request later waveform buckets without producing an oversized MCP response.
- `get_contact_sheet`: broad visual sampling of one source interval.
- `get_frames`: exact source frames returned as MCP image content.

Iterate over all distinct assets. Start with contact sheets, then request exact frames at speech boundaries and uncertain moments rather than sampling hundreds of redundant images.

## Timeline operations

`apply_edit_batch` accepts atomic operation groups for:

- removing, moving, and duplicating clips;
- adding and updating text cards and their image backgrounds;
- adding and updating transitions;
- splitting, trimming, clearing trims, deleting source ranges, and restoring ranges;
- enabling or disabling detected silence ranges;
- setting image duration, speed, volume, audio mode, fades, silence behavior, denoise-related edit settings, and automatic zoom settings;
- attaching or detaching project or per-clip audio;
- adding, updating, and removing captions;
- adding, updating, and removing ordinary, social, Subscribe, and QR Code tags;
- adding, updating, and removing manual dynamic push-ins;
- changing aspect ratio, reframe mode, resolution, output formats, loudness, soundtrack fades, and project defaults.

Use `undo` and `redo` for whole batches. Use `preview` to open, seek, play, pause, or close the shared visual preview. Use `save_project`, `open_project`, and `export` only with paths admitted by the Electron MCP bridge.

Music defaults to the project, not a clip. For a generic request such as “add background music,” call `set_project_soundtrack` early. This explicit project setting supplies silent clips, timelapses, images, and text cards. `attach_audio` without `clipId` remains compatible inside a batch; supply `clipId` only for an explicitly named section.

Before importing media, prefer an existing `simplevlogeditor-recovery.sve.json` or other saved `.sve.json` in the working media directory. Open it and inspect `recoveryReport`; import only missing/new sources. After every open, recovery, or restart, call `get_project` and discard all prior revisions/request ids.

Text cards should have fade-in and fade-out treatment. Fade out the preceding video and fade in the following one around the card. Use a transition for adjacent clips that continue the same topic; prefer a fade-out/fade-in break when the subject changes.

## Push-in example

```json
{
  "expectedRevision": 12,
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
