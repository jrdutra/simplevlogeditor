---
name: edit-video
description: Use when the user wants to inspect, understand, edit, cut, rearrange, caption, style, preview, save, or export videos in SimpleVlogEditor, including removing repetitions or silence, adding text cards, Subscribe or QR tags, transitions, audio changes, and dynamic push-ins.
---

# Edit video in SimpleVlogEditor

Operate the visible Electron editor through the `simple-vlog-editor` MCP tools. Never simulate UI clicks and never rewrite editor project files with shell commands. MCP is the authoritative interface for both reading and changing the edit.

## Start every editing task

1. Call `get_editor_capabilities` to discover the exact current operations, styles, tag shapes, transitions, formats, and value limits.
2. The MCP host opens and focuses the visible Electron editor. Confirm `health_check` if it is not visible; do not continue as a hidden background-only workflow.
3. Before importing, look for a saved `.sve.json` project in the requested media directory, preferring `simplevlogeditor-recovery.sve.json`. When one exists, call `open_project` first and inspect its `recoveryReport`; the editor relinks every stored local media and soundtrack path it can still read. Import only genuinely missing/new assets. Never append every source again to an already restored timeline.
4. For a project that really starts from source media, call `queue_media_import` with absolute paths and a request id unique to this editor session/project/revision. Poll `get_import_status` until terminal; report per-file failures and continue with imported assets. Never send or read file contents yourself.
5. Call `get_project`, `list_assets`, and `get_timeline` after every open, recovery, or restart. Discard revisions and request ids from the prior editor session; only the newly returned `projectRevision` may guard the next mutation.
6. If the user supplied general music/background audio, call `set_project_soundtrack` before editorial batches. This project-wide fallback supplies silent clips, timelapses, images, and text cards. Use per-clip audio only for an explicitly named section.
7. Understand every distinct audiovisual asset before making content-based edits:
   - transcribe every asset with usable audio;
   - request a contact sheet for every asset with usable video or imagery;
   - inspect exact frames around proposed cuts, scene changes, reactions, visual actions, and ambiguous transcript moments;
   - analyze silence when pauses, speech boundaries, noise, or cut margins matter.

For transcription, use `onnx-community/whisper-small_timestamped` by default. Use the language of the user's prompt when it is also likely to be the spoken language (`portuguese`, `english`, etc.); otherwise omit it or use `auto` so Whisper detects speech. The server accepts ISO aliases such as `pt` and friendly model aliases, but prefer canonical values returned by capabilities. If `quality.reviewRecommended` is true or the transcript is visibly incoherent, retry that clip with `onnx-community/whisper-large-v3-turbo_timestamped`. When denoise is useful, default to `noiseEngine: "gtcrn"` (Voice model) and `noiseStrength: "balanced"`.

Do not claim to have watched or understood an asset that was not covered by transcript/audio evidence and frames. If an asset cannot be decoded, report it explicitly and continue safely with the remaining material.

## Edit safely

- Source edits, captions, and push-ins use original source seconds. Output times describe the assembled timeline.
- Use `apply_edit_batch` with `expectedRevision` and `dryRun: true` before subjective or multi-operation changes. Inspect the simulated duration, then commit the same batch against the latest revision.
- A revision conflict is not retryable with the old value. Call `get_project`, rebuild the batch against that current revision, and use a new request id.
- Group related changes into meaningful batches so each group is one undo step.
- Re-read the timeline after every committed batch. Preview important joins and inspect frames around them.
- Preserve natural speech rhythm, intentional pauses, reactions, context, and important visual actions. Remove failed takes, errors, redundant repetitions, accidental long pauses, and off-topic material only when evidence supports the choice.
- Prefer restrained `add_push_in` values with smooth ramps. Use push-ins only for justified emphasis; their source timing remains aligned after cuts and speed changes.
- Add text cards, captions, transitions, Subscribe tags, QR Code tags, replacement audio, and output settings only when requested or editorially useful. Validate QR URLs and avoid covering faces or essential screen content.
- Use `set_project_soundtrack` for general music and call it near the beginning so silent/timelapse clips and text cards are never previewed as unexplained silence.
- Give text cards fade-in and fade-out treatment. At their boundaries, fade out the preceding video and fade in the following video. Use ordinary transitions for clips continuing the same topic; for a clear topic change, prefer a fade-out/fade-in break. Add transitions only where content evidence justifies them.
- Never invent IDs, timing, shapes, transition names, fonts, presets, or output formats. Read them from MCP results.
- Save or export only when requested and only to a path accepted by Electron's configured roots. Do not overwrite an important existing file without explicit direction.
- Treat `editor_reconnecting` and other errors carrying `recoverable: true` as transient. Wait for `retryAfterMs`, call `health_check`, and retry with the same `requestId`.
- The editor automatically writes `simplevlogeditor-recovery.sve.json` in the active project root after mutations and media commits. Use `checkpoint_project` before a risky handoff, `get_recovery_state` to verify it, `restart_editor` to recover a broken editor, and `close_editor` only when the task or user requires the app to close.

The editor's MCP activity console is visible to the user and remains minimized if the user minimizes it. Keep tool calls meaningfully grouped. At the end, save a checkpoint, call `finish_editing` with a concise summary, and let the on-screen modal ask whether to watch the preview or render immediately. Also report subjective decisions, current project revision, and saved/exported paths in chat.

For the complete command and operation catalogue, read [MCP operations](references/mcp-operations.md) when planning a concrete edit.
