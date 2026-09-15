# Claude Code client for SimpleVlogEditor

This directory is a local Claude Code **plugin marketplace**. It publishes one
plugin, `simple-vlog-editor`, which gives Claude Code the editor's local MCP
tools and the `edit-video` skill that describes how to use them.

Nothing here touches your global Claude Code configuration. The MCP server runs
on demand, opens the real Electron editor window, and every operation appears in
its activity panel — in orange, with the Claude Code mark — while the timeline
changes in front of you.

## Install

From the repository root, in PowerShell:

```powershell
.\ai-client\claude\install.ps1
```

That is the whole thing. It installs the Electron dependencies and builds the
web bundle if they are missing, runs the doctor, adds this marketplace and
installs the plugin, stopping at the first problem with the command that fixes
it. First run takes a few minutes, almost all of it the build.

Then **start a new Claude Code session** — an already-running one will not have
the tools or the skill — **in the folder that holds your videos**. That folder
is what the editor is allowed to read and write.

```powershell
cd D:\Videos
claude
```

And ask for what you want:

> Edit my vlog, cut the repeated takes and place the screenshots where I mention them.

### If you would rather do it by hand

```powershell
cd electron;  npm install;         cd ..
cd web;       npm run build:site;  cd ..
node .\ai-client\claude\plugins\simple-vlog-editor\scripts\doctor.mjs
claude plugin marketplace add .\ai-client\claude
claude plugin install simple-vlog-editor@simplevlogeditor
```

The doctor step is not optional. Claude Code **copies** a plugin into
`~/.claude/plugins/cache` when it installs it, so the installed copy has no way
of knowing where this repository is. The doctor records that location under
`%LOCALAPPDATA%\SimpleVlogEditor\editor-location.json`, and the plugin's
launcher reads it from there.

## Which folders the editor may touch

Out of the box: your own media folders — Videos, Pictures, Music, Downloads,
Desktop and Documents — plus the editor's own project folder. Nothing needs to
be configured, and it no longer matters which folder Claude Code was started
in. A graphical application inherits whatever working directory its launcher
had, which is `C:\WINDOWS\System32` when it is started from the Start menu, so
the working directory is not consulted at all.

Anything else is allowed the moment you say so, in either of two ways:

- **Open a file.** Choosing media in the editor, dropping it on the window, or
  opening a saved project allows the folder it came from. Your choice is the
  consent; there is nothing else to click.
- **Be asked.** When an AI client needs a folder that is not allowed, the
  editor does not fail — it explains what is being asked for and opens your
  system's folder picker. What you pick there is what gets allowed, and you can
  pick the exact folder or a folder above it. Cancelling refuses, and the
  client is told `path_consent_denied`.

Both are remembered in `%LOCALAPPDATA%\SimpleVlogEditor\roots.json` and survive
a restart. **Allowed folders**, in the editor's project settings, lists every
folder with where it came from, adds one through the picker, and removes one —
all effective immediately, with no restart.

If your Claude client supports MCP roots, the folders you connected in that
session are used too, for as long as it lasts.

There is no operating-system prompt beyond the folder picker on Windows and
Linux: the editor runs as you and can already reach what you can reach. The
Allowed folders list is the guarantee that you can see, and revoke, everything
it has accumulated. On macOS the picker is what grants access. Under Flatpak or
snap on Linux, the same picker goes through the desktop portal.

Some locations are refused whatever asks for them, including the environment
variable below: Windows itself, Program Files, ProgramData, other applications'
data, and bare drive roots.

### SVE_MCP_ROOTS (advanced)

An override for a pinned setup, not the normal way to grant a folder. When it
is set, the default media folders stand down and exactly what it lists is used;
folders you allow in the editor still apply on top. Precedence is
`SVE_MCP_ROOTS` > MCP client session > folders you allowed > defaults.

```powershell
[Environment]::SetEnvironmentVariable('SVE_MCP_ROOTS','D:\Videos;D:\Exports','User')
```

Windows separates the paths with `;`. It reaches only processes started
afterwards, so quit Claude Code and the desktop app and reopen them. To undo:

```powershell
[Environment]::SetEnvironmentVariable('SVE_MCP_ROOTS',$null,'User')
```

Do not set this by editing the copy of the plugin under `~/.claude/plugins/`:
Claude Code overwrites that folder whenever the plugin is installed or updated.

## When something is wrong

Run the doctor. It checks each piece and prints the command for whatever is
missing:

```powershell
node .\ai-client\claude\plugins\simple-vlog-editor\scripts\doctor.mjs
```

Add `--skip-tests` to skip the MCP protocol tests when you only want the quick
answer.

| What you see | What it means |
| --- | --- |
| Claude Code has no `simple-vlog-editor` tools | The session was started before the install. Start a new one. |
| "SimpleVlogEditor could not be located" | Run the doctor from inside the repository, or set `SVE_EDITOR_PROJECT_ROOT` to the folder containing `electron` and `web`. |
| The editor opens but is an old version | The web bundle is stale. Run `npm run build:site` in `web`. |
| A path is refused on import or export | It is outside the allowed roots. See the section above. |

## After changing the editor's code

The plugin runs the built bundle, not the sources. Rebuild with
`npm run build:site` in `web`. You only need to reinstall the plugin when you
change something inside `ai-client\claude` itself — the skill, the scripts or
the manifest — because that is the part Claude Code copied.

## What the plugin can do

`get_editor_capabilities` is always the authority. Broadly: import and inventory
media, transcribe, inspect frames, cut silence and repeated takes, captions
including the ones composited behind the presenter, tags, transitions, per-clip
audio and noise removal, dynamic push-ins, timed video effects, and placed
images with full control of layer, position, size, rotation and fade.

`get_frames` with `composited: true` returns the frame as the export will write
it, which is how the plugin checks its own work rather than assuming.

## Relationship to the Codex client

`ai-client\codex` is the equivalent for Codex, plus a standalone `npm start`
launcher. Both talk to the same Electron MCP server and share the same editing
protocol; only the packaging differs. `ai-client\codex\EDITOR_AGENT.md` is the
long-form editorial protocol and applies to Claude Code as well.
