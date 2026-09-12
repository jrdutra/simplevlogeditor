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

The editing protocol in `EDITOR_AGENT.md` requires Codex to inventory the timeline, transcribe every audio source, inspect frames from every visual source, dry-run subjective batches, preserve revisions, and validate the result through the same preview/export pipeline used by the editor.
