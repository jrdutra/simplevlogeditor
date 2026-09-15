# Simple Vlog Editor Codex plugin

This plugin gives Codex the editor's local MCP tools and a specialized video-editing workflow. It opens the real Electron editor when a tool is first used; timeline changes and concise English activity messages remain visible to the user.

While connected, the editor is raised to the foreground and displays a blue Codex control modal with highlighted activity logs. A session driven by the Claude Code plugin shows the same window in orange with its own mark, so the controller is obvious at a glance. Mutating commands, successful media imports, and manual user changes automatically save the complete edit as `simplevlogeditor-recovery.sve.json` in the task's working directory. The MCP tools can inspect or force that checkpoint and can safely close or restart the editor. A restart restores the checkpoint whenever the newly opened timeline is empty. Mutating MCP calls require unique request IDs, so a connection retry cannot apply the same edit twice.

Unscoped music is always attached as the project default soundtrack. A per-clip soundtrack is used only when the request explicitly identifies that clip or section.

Noise handling is also per clip, but diagnosis and removal remain separate.
The plugin may inspect all audible videos with `analyze_noise`; it only applies
or schedules suppression after the user explicitly asks to remove noise.

Caption presets are grouped as Classic captions and Background captions. The
background group offers upper-left, upper-center, upper-right, center-left,
center, and center-right designs. It also combines four additional letterforms
with still, subtle zoom-in/zoom-out, and slow four-direction scroll variants.
The editor isolates a moving presenter locally and composites the person above
the lettering in preview and export. The legacy `behind-subject` preset remains
available as upper-center. When no subject is found, the selected style and
motion are preserved and the text remains visible without occlusion.

Pictures can be placed over a stretch of a container with `add_image`, `update_image` and
`remove_image`: an absolute path inside the allowed roots, a start and duration on the container's
own source clock, a fade, full control of centre, size, rotation and opacity, and a choice of
layer — on top of everything, or in the middle layer behind the person like a background caption.
Placements are per container and, unlike effect sections, may freely overlap each other. The plugin
reads every image in the working directory before planning the edit, places one when the speech
refers to a picture, and checks each placement with `get_frames composited: true`, which returns the
frame as the export will write it rather than the untouched source frame.

The editor allows your own media folders out of the box — Videos, Pictures, Music, Downloads, Desktop
and Documents, plus its own project folder — so no configuration is needed and it no longer matters
which folder the task was started in. Choosing or dropping a file in the editor window allows the
folder it came from, and when the agent needs a folder that is not allowed the editor asks through
your system's folder picker rather than failing; declining returns `path_consent_denied`. Everything
allowed is listed, with its origin, under **Allowed folders** in the editor's project settings, and is
remembered across restarts.

`--root` still pins folders for one task, and `SVE_MCP_ROOTS` is inherited from the environment when
no `--root` is given, so one user-scope setting covers Codex and Claude Code alike:

```powershell
[Environment]::SetEnvironmentVariable('SVE_MCP_ROOTS','C:\Users\you\Videos;C:\path\to\simplevlogeditor','User')
```

Windows separates the paths with `;`. Setting it makes the default media folders stand down, which is
the point of an override; folders allowed in the editor still apply. Operating-system locations —
Windows itself, Program Files, other applications' data, bare drive roots — are refused whatever asks
for them, this variable included.

The plugin launcher does not contain a user-specific installation path. It discovers the editor from the current project or from the location registered by Electron and the doctor. If the repository is moved before either can register it, set `SVE_EDITOR_PROJECT_ROOT` to the folder containing `electron` and `web`, then run the doctor once.

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
