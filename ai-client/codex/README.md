# Codex client for SimpleVlogEditor

> A native Codex plugin is also available in `plugins/simple-vlog-editor`. Install it from the local marketplace with `codex plugin marketplace add .` followed by `codex plugin add simple-vlog-editor@personal`.

This launcher opens Codex with the local `simple-vlog-editor` MCP server available only for that session. Electron opens the real editor window, and every MCP operation appears in its **MCP editing activity** panel while the timeline changes.

It does not modify the user's global Codex configuration. Codex itself runs with a read-only filesystem sandbox; importing, editing, saving, and exporting happen through the editor's restricted MCP tools.

## Requirements

- Node.js 18 or newer.
- Codex CLI installed (`codex --version`) and signed in (`codex login`).
- Dependencies installed in `electron`.
- The WEB bundle built in `web/dist`.

From this directory, check everything with:

```powershell
npm run doctor -- --root "D:\Videos" --root "D:\Exports"
```

Each `--root` is a directory the MCP server may read or write. Use separate media and export roots if desired. Paths outside them are rejected by Electron.

## Interactive editing

```powershell
npm start -- --root "D:\Videos" --root "D:\Exports" -- "Edit my vlog, remove repeated takes and long accidental pauses, then add restrained push-ins to the most important conclusions."
```

Codex remains open for follow-up instructions. If no briefing is supplied, it inspects the editor and waits for one:

```powershell
npm start -- --root "D:\Videos" --root "D:\Exports"
```

## One-shot editing

```powershell
npm start -- --exec --root "D:\Videos" --root "D:\Exports" -- "Create a clean rough cut and save the project as D:\Exports\rough-cut.sve.json"
```

`--exec` requires a briefing and exits when Codex finishes. It is useful for scripts, but interactive mode is better when editorial choices need discussion.

## Options

```text
--root, -r       Allowed media/output directory; repeatable
--workdir, -C    Codex working directory; also admitted by MCP
--model, -m      Optional model override; otherwise uses the configured default
--exec           Non-interactive one-shot run
--dev            Connect Electron to the Angular dev server on port 4200
--doctor         Validate the installation and generated MCP configuration
--dry-config     Show the session configuration without starting Codex
```

The editing protocol in `EDITOR_AGENT.md` requires Codex to inventory the whole working directory before the first edit, transcribe every audio source, inspect frames from every visual source, dry-run subjective batches, preserve revisions, and validate the result through the same preview/export pipeline used by the editor.

Video and music files are known by name only until the edit needs their content; **image files are read and understood up front**, because a picture whose content Codex has not seen cannot be placed intelligently. Nothing obliges it to use them — it says which ones it left out and why.

Beyond cutting, captions, tags, transitions and audio, the editor exposes:

- **Timed video effects** — `add_video_effect`, `update_video_effect` and `remove_video_effect` place a look over an explicit stretch of one container, with an intensity and a `fadeSeconds` edge (0 is a hard cut, above 0 eases the effect in and out).
- **Placed images** — `add_image`, `update_image` and `remove_image` put a picture over a stretch of one container, with full control of centre, size, rotation, opacity and fade, and a choice of layer: over everything, or in the middle layer behind the person. Codex places one when the speech refers to a picture, and keeps rotation within ±20 degrees unless asked for more.
- **Composed frames** — `get_frames` with `composited: true` returns the frame as the export will write it rather than the untouched source frame, which is how a placement is actually verified.

`get_editor_capabilities` remains the authority for every id, limit and preset.

Noise diagnosis and removal are separate by design. Codex may call
`analyze_noise` to report which clips contain probable or relevant background
noise, but it only calls `suppress_noise` or enables `set_noise_suppression`
after the user explicitly asks for noise removal. Suppression belongs to each
media container and never becomes a project-wide default.
