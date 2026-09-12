# Simple Vlog Editor Codex plugin

This plugin gives Codex the editor's local MCP tools and a specialized video-editing workflow. It opens the real Electron editor when a tool is first used; timeline changes and concise English activity messages remain visible to the user.

While connected, the editor is raised to the foreground and displays a blue Codex control modal with highlighted activity logs. Mutating commands and successful media imports automatically save the complete edit as `simplevlogeditor-recovery.sve.json` in the task's working directory. The MCP tools can inspect or force that checkpoint and can safely close or restart the editor. A restart restores the checkpoint whenever the newly opened timeline is empty.

Unscoped music is always attached as the project default soundtrack. A per-clip soundtrack is used only when the request explicitly identifies that clip or section.

The MCP server defaults filesystem access to the Codex task's working directory. Start the task in the folder containing the source videos and intended exports, or configure `SVE_MCP_ROOTS` in `.mcp.json` with Windows paths separated by `;`.

## Validate

```powershell
node .\plugins\simple-vlog-editor\scripts\doctor.mjs
```

## Install this local marketplace

From `ai-client\codex`:

```powershell
codex plugin marketplace add .
codex plugin add simple-vlog-editor@personal
```

Open a new Codex task after installation so its tools and skill are loaded. The existing standalone launcher remains available through `npm start` and does not require installing the plugin.
