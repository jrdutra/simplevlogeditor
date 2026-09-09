# SimpleVlogEditor

Six browser-based video and audio tools for vloggers, at
[simplevlogeditor.com](https://simplevlogeditor.com). Angular 17 with SSR and
prerendering. Every tool runs entirely in the visitor's browser — WebCodecs for
decoding and encoding, WebAssembly for the speech and noise models — so no file
is ever uploaded and there is no processing backend to run.

## The tools

| Route | Tool | What it does |
| --- | --- | --- |
| `/video-editor` | Video Editor | Timeline editing: cut silence, auto-zoom after pauses, retime, replace or level the sound, captions and text cards |
| `/free-silence-cutter` | Silence Cutter | Detects and removes silent sections from video and audio |
| `/media-merger` | Media Merger | Joins clips, audio and stills into one file, with fades |
| `/background-noise-remover` | Noise Remover | Separates speech from background noise with a GTCRN/RNNoise model |
| `/video-transcription` | Video Transcription | Speech to timed captions; exports SRT, SBV, WebVTT and text |
| `/text-video-maker` | Text Video Maker | Animates text over a photo or colour and exports a clip |

The tool components were brought over from the `ferramentas` project and are
unchanged; what is new here is the shell, the home page, the theme and the SEO.

## Running it

```bash
npm install --ignore-scripts
npm run dev            # http://localhost:4200
```

`--ignore-scripts` matters. `@huggingface/transformers` pulls in
`onnxruntime-node`, whose install script downloads a native binary from
`api.nuget.org`. Nothing in this project uses it — the browser build uses
`onnxruntime-web`, and `onnxruntime-node` is already listed under
`externalDependencies` in `angular.json` — so skipping install scripts avoids a
download that can only fail or waste time.

## Building and serving

```bash
npm run build          # prerenders all 7 routes into dist/
npm start              # node dist/server/server.mjs, port 4000 or $PORT
```

`ng build` inlines the Google Fonts stylesheet at build time, so the build
machine needs to reach `fonts.googleapis.com`. On a machine without it, build
with `--configuration development`, or set
`"optimization": { "fonts": { "inline": false } }` in the production
configuration.

## Two things the server must send

`server.ts` sets both, and any other host has to as well:

- **`Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.** Without them the browser
  withholds `SharedArrayBuffer`, and the threaded ONNX Runtime build the noise
  remover uses falls back to a single thread — several times slower on a long
  recording.
- **Real 404s for missing files.** A single-page host that answers an unknown
  path with `index.html` and a 200 will hand the runtime an HTML page where it
  asked for `ort-wasm-simd-threaded.wasm`, and the error it then reports is
  about a bad WebAssembly magic word rather than about a missing file.

## Layout

```
src/app/
  app.component.*        the chassis: brand, tools menu, window lights, footer
  app.routes.ts          routes and their SEO payloads
  seo.service.ts         title, meta, canonical, Open Graph, JSON-LD per route
  tools.data.ts          the catalogue — the one place a tool is described
  home/                  the title, the grid and the questions
  ferramentas/           the six tools, one folder each
  shared/media/          FFT, loudness, WAV, auto-zoom — shared by several tools
  services/mediabunny/   the lazy loader for the media toolkit
src/assets/
  tools/                 card and cover art, 1200px wide
  sprites/               console parts lifted from the reference panel
  models/                gtcrn.onnx, silero-vad.onnx, dnsmos-p835.onnx
  icons/                 favicons and the web manifest
```

`tools.data.ts` is the single source: the home grid, the tab strip, each tool
page's `<title>` and description, and the site's `ItemList` structured data all
read from it. Adding a tool means adding an entry there and a route.
