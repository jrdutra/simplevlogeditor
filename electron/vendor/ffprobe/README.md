# FFprobe packed with the editor (optional)

The MCP import path (`queue_media_import` / `add_media`) reads media metadata with
FFprobe in an isolated subprocess. The editor looks for it in this order:

1. `SVE_FFPROBE` — an explicit path;
2. `resources/bin/ffprobe.exe` — a copy packed with the application;
3. `ffprobe` on `PATH`.

Nothing is downloaded by the build. To make the installer, the portable zip and the
plugins **with the embedded editor** import media on a machine that has never had
FFmpeg installed, place a Windows x64 `ffprobe.exe` (and its `LICENSE` file) in:

```
electron/vendor/ffprobe/win32-x64/ffprobe.exe
electron/vendor/ffprobe/win32-x64/LICENSE.txt
```

`electron-builder` copies **everything** in this folder (except `README` and `.gitkeep`)
into `resources/bin/` on the next `build.bat`: `ffprobe.exe`, `ffmpeg.exe`, `ffplay.exe`,
the DLLs of a *shared* build and the licence. The editor uses `resources/bin/ffprobe.exe`
for imports and reports `resources/bin/ffmpeg.exe` in `get_diagnostics`
(`SVE_FFPROBE` / `SVE_FFMPEG` still override both). The plugin doctor runs `-version` on each
embedded tool to prove it starts. Check the
licence of the build you choose (most FFmpeg Windows builds are GPL or LGPL) before
redistributing it. Without the file the behaviour is exactly the previous one: FFprobe
must be on `PATH`, and `get_diagnostics.externalTools.ffprobe` says whether it is.
