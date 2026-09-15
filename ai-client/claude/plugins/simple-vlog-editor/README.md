# Simple Vlog Editor plugin for Claude Code

This plugin gives Claude Code the editor's local MCP tools and a specialized video-editing
skill. It opens the real Electron editor when a tool is first used; timeline changes and
concise English activity messages remain visible to the user.

While connected, the editor is raised to the foreground and displays a control modal with
highlighted activity logs, in orange and carrying the Claude Code mark so it is obvious at a
glance which client has the wheel — a Codex session shows the same window in blue. Mutating commands, successful media imports, and manual user changes
automatically save the complete edit as `simplevlogeditor-recovery.sve.json` in the session's
working directory. The MCP tools can inspect or force that checkpoint and can safely close or
restart the editor. A restart restores the checkpoint whenever the newly opened timeline is
empty. Mutating MCP calls require unique request IDs, so a connection retry cannot apply the
same edit twice.

Unscoped music is always attached as the project default soundtrack. A per-clip soundtrack is
used only when the request explicitly identifies that clip or section.

Noise handling is per clip, and diagnosis and removal remain separate. The plugin may inspect
all audible videos with `analyze_noise`; it only applies or schedules suppression after the user
explicitly asks to remove noise.

Caption presets are grouped as Classic captions and Background captions. The background group
offers upper-left, upper-center, upper-right, center-left, center, and center-right designs, and
combines four additional letterforms with still, subtle zoom-in/zoom-out, and slow four-direction
scroll variants. The editor isolates a moving presenter locally and composites the person above
the lettering in preview and export. The legacy `behind-subject` preset remains available as
upper-center. When no subject is found, the selected style and motion are preserved and the text
remains visible without occlusion.

Video effects are per container and per section. `add_video_effect`, `update_video_effect` and
`remove_video_effect` place an effect over an explicit time range of one clip, with an intensity
and a `fadeSeconds` edge: `0` is an abrupt cut into the effect, and a positive value ramps the
effect in and out over that many seconds at each side. Sections of the same clip may not overlap;
an attempt returns `video_effect_overlap` with the free room that is actually available. Effects
never become a project-wide default and are never inherited by other containers.

Pictures are placed the same way, with `add_image`, `update_image` and `remove_image`: an absolute
path inside the allowed roots, a start and duration on the container's own source clock, a fade,
full control of centre, size, rotation and opacity, and a choice of layer — on top of everything,
or in the middle layer behind the person like a background caption. Placements are per container
and, unlike effect sections, may freely overlap each other. The plugin reads every image in the
working directory before planning the edit, places one when the speech refers to a picture, and
checks each placement with `get_frames composited: true`, which returns the frame as the export
will write it rather than the untouched source frame.

## Where the editor is found

Claude Code **copies** this plugin into `~/.claude/plugins/cache` when it
installs it, so the installed copy cannot reach the repository by walking up
from its own folder. It finds the editor in this order:

1. the `SVE_EDITOR_PROJECT_ROOT` environment variable;
2. the location recorded under `%LOCALAPPDATA%\SimpleVlogEditor\editor-location.json`
   by the doctor, or by any previous launch of the editor;
3. the folder Claude Code was started in, and its parents;
4. the plugin's own folder and its parents.

This is why the install runs the doctor before installing: it is what writes
(2). There is no user-specific path anywhere in this plugin.

## Validate

```powershell
node .\scripts\doctor.mjs
```

It checks the manifest, the launcher, the skill, the Electron host and its
dependencies, the web bundle and the MCP protocol tests, and prints the exact
command for anything missing. `--skip-tests` skips the protocol tests.

## Install

Use the installer one directory up, which does the whole sequence in order:

```powershell
..\..\install.ps1
```

See `ai-client\claude\README.md` for what it does and for the manual
equivalent.

## After changing the editor

The plugin runs the built bundle, not the sources: rebuild with
`npm run build:site` in `web`. Reinstall the plugin only when something inside
`ai-client\claude` changes — the skill, the scripts or the manifest — since
that is the part Claude Code copied.
