# SimpleVlogEditor — desktop

The site, in a window of its own, for Windows.

The window has no frame from the operating system. The site already draws one —
a chassis with a bezel, a bar across the top and three lights at its right end —
so that one is made real: the bar drags the window, the lights close, minimize
and zoom it, a double click on the bar maximizes and restores, and the bezel is
what you grab to resize.

## Running it

```bash
npm install                 # in this folder
npm run build:web           # the site the window shows
npm start
```

`npm run dev` loads `http://localhost:4200` instead, so `ng serve` in `../web`
gives live reload with the desktop chrome in place.

## Building, and the installer the site hands out

There is one build, and it produces both halves:

```bash
npm run dist                # === npm --prefix ../web run build
```

which is:

1. `ng build` — the site, into `web/dist/browser`
2. `electron-builder --win` — two targets, both packed from that site:
   an NSIS **installer** and a **portable zip**
3. `publish-installer.js` — both copied into **both**
   `web/src/assets/download/` and `web/dist/browser/assets/download/`, under
   fixed names so the links never change:

   | Published as | What it is |
   | --- | --- |
   | `SimpleVlogEditor-Setup.exe` | the installer: shortcuts, uninstaller, the usual |
   | `SimpleVlogEditor-Portable.zip` | the same application unpacked — extract anywhere and run `SimpleVlogEditor.exe`; nothing is written outside the folder except the window's position, which lives in `%APPDATA%` |

The third step is what makes one pass enough. The home page's buttons are plain
links to `/assets/download/…`, so the files have to be inside the site before
the site is uploaded — and because the site is built *first*, its output folder
already exists by the time there is anything to put in it. Deploy
`web/dist/browser` and the current builds go with it.

Dropping the `zip` target from `build.win.target` removes the portable download:
`publish-installer.js` publishes what it finds, the manifest then has no
`portable` entry, and the home page stops offering it.

The same three steps run from either side: `npm run build` in `../web` ends by
calling back here. `npm run build:site` there is the site alone, for when you
are working on the site and do not want to wait for an installer.

`assets/download/**` is filtered out of what the installer packs, so the
application does not contain a copy of itself, and the download button is hidden
inside the desktop app in any case.

## How it fits together

```
src/main.js          the window: frameless, minimum size, permissions, links
src/server.js        the site over loopback, with the isolation headers
src/preload.js       the four verbs the page is allowed to have
src/window-state.js  where the window was last time
```

**The site is served, not opened from disk.** `file://` has no origin, and
without an origin there is no `SharedArrayBuffer` — which is what the threaded
ONNX Runtime build in the noise remover needs to be more than several times
slower than it should be. So `server.js` listens on `127.0.0.1` on a port the
operating system picks, and sends the same three things `web/server.ts` sends in
production: `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`, and a real 404 for a file that is
not there rather than the app shell with a 200.

**The page gets a bridge and nothing else.** `contextIsolation` is on, `sandbox`
is on, Node is off. `window.desktop` has minimize, toggleMaximize, close and the
window's state — no file system, no `ipcRenderer`. Its presence is also how the
site knows it is not in a browser tab.

**Links leave.** Anything that is not our own origin opens in the machine's
browser instead of navigating the application away from itself.

**The camera, microphone and screen** are granted to our origin — the narration
recorder and the meeting capture ask for them the way any page does, and there
is no address bar here to answer from. `getDisplayMedia` uses the system picker,
so the source is still chosen by a person.

## The site's side

What `../web` knows about this, all of it inert in a browser:

- `src/app/shared/desktop/desktop.service.ts` — is this a window, and what is it
  doing
- `src/app/shared/desktop/window-controls.component.ts` — the three lights, as
  buttons
- `src/app/app.component.*` — the bar becomes a drag handle, the chassis gains a
  six-pixel bezel to grab for resizing, the decorative lights are replaced by the
  working ones, and the footer says "We never store your files." instead of
  naming a browser that is not there
- `src/app/home/home.component.*` — the home page fits the window without a
  scroll bar, the title becomes a link out to simplevlogeditor.com, and the
  download button is not drawn
- `scripts/build-desktop.js` — the step that calls this project at the end of a
  site build

## Minimum size

960 × 640. Below that the tab strip and the editor's panels start wrapping into
something that cannot be used.

## Known limitation

Fonts and Material Icons are still fetched from Google's servers, so **with no
internet connection the tab icons render as their ligature names**. Self-hosting
the two families in `web/src/assets/fonts` and pointing `web/src/index.html` at
them fixes it, and is the one thing standing between this and an app that is
fully offline.

## MCP automation

The application also contains a local stdio MCP server for multimodal agent
editing. It exposes the media inventory, source/output timeline, word-timed
transcription, silence and waveform analysis, exact frames and contact sheets,
atomic edit batches, undo/redo and direct export. Setup and the complete safety
model are documented in [MCP.md](MCP.md).
