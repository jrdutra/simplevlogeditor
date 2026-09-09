# Background noise remover

The `/background-noise-remover` tool takes the background noise out of a video or
audio recording and leaves the voice. It does not remove echo, separate two
people talking at once, or improve a voice that was already clean.

## Background diagnosis

`Analyse background` examines the original audio without suppressing it. Defaults
are speech (one or multiple speakers), balanced sensitivity and automatic pause
selection. Optional background-only and clean-voice references use seconds from
the original timeline; invalid or overlapping references are rejected. Reports
remain visible on cancellation and are cleared when the file changes. Changing
settings marks a report as outdated until the user analyses again.

The separate CPU worker runs Silero VAD (512 samples plus 64 samples of context
at 16 kHz) and non-personalized DNSMOS P.835. VAD needs 250 ms of speech; 160 ms
margins protect pause measurements from speech edges. Background energy uses
frames with VAD probability below 0.2 outside those margins, or the user's
reference. A minimum of 0.5 seconds is required for this measurement. Analysis
uses a mono mix with the existing cancellation safeguard; channel-specific
problems can be less apparent in the mix.

DNSMOS processes 9.01-second windows with 4.5-second strides and an explicit final
window. Short clips are repeated as in the reference implementation and flagged.
The report shows calibrated speech/background/overall quality estimates (1–5),
averaged over windows with at least 0.5 seconds of detected speech. Suspect
intervals remain available separately. These are not noise probabilities or an
official DNS benchmark; the voice/background energy gap is not true SNR.

Balanced thresholds use background quality below 3.5 for probable noise and below
2.5 for relevant noise, considering the worst speech-containing window. High/low
sensitivity shifts both by +0.3/-0.3. These are application heuristics. Clips
under 3 seconds, insufficient speech, contaminated references, intentional music
and contradictory energy/model evidence can yield Inconclusive. Low background
does not guarantee a clean recording or exclude isolated sounds between windows.

Models are local static assets (~3.5 MB combined), downloaded only when requested.
Attribution, licences and SHA-256 hashes are in `assets/models/noise-analysis/`.
`noise-analysis.spec.ts` covers decision boundaries, references, actual model
loading and cancellation. `noise-analysis.smoke.ts` uses public speech plus seeded
0 dB white noise as a limited quality sanity check, not a general accuracy benchmark.

## Suppression execution

Voice model offers CPU (default) and WebGPU. CPU imports `onnxruntime-web/wasm`
and uses `ort-wasm-simd-threaded.wasm`; WebGPU imports `onnxruntime-web/webgpu`
and uses `ort-wasm-simd-threaded.asyncify.wasm`. Only the selected driver and binary
are loaded. In this installed version the binaries are 12,942,611 and
23,567,050 bytes respectively (approximately 13 MB and 23.6 MB, before transport
compression). This pinned 1.26 development build uses the native WebGPU asyncify
loader, unlike the JSEP loader documented for other releases. Always inspect
the pinned `ort.webgpu.bundle.min.mjs` before changing binary names.
Both use the same small `gtcrn.onnx` model.

WebGPU requires a compatible adapter and secure context. Unsupported browsers
keep CPU available; adapter/runtime failures are surfaced rather than silently
claiming GPU execution. Some operators can execute on CPU within a WebGPU
session. This small streaming model is not guaranteed to be faster on GPU.
See the [ORT deployment guide](https://onnxruntime.ai/docs/tutorials/web/deploy.html).

Analysis caching is capped at 32 MiB and buffers are transferred, not cloned,
between the page and worker. Switching engine or device invalidates the cache.
Cancelling a rerun keeps the previous completed audio and preview. The signed
quiet-region measurement describes suppression before volume levelling, not
ground-truth noise reduction or speech quality.

For GPU integration validation run the tool specs with
`--karma-config=karma.noise-webgpu.cjs`. This launcher requires a WebGPU adapter
and uses Chromium's software adapter; it is not a hardware benchmark.

- Everything is in the browser. The recording is decoded with mediabunny, the
  suppression runs in a worker, and the file is muxed back in this tab. Nothing
  is uploaded and no request carries audio.
- Two engines. **GTCRN** (ICASSP 2024, MIT, 48.2 K parameters) is the default and
  is served from `assets/models/gtcrn.onnx`; the ONNX runtime it needs is copied
  out of `node_modules` into `assets/onnxruntime/` by `angular.json`, the same
  way Tesseract's worker is. **RNNoise** (Xiph, 2018, Apache-2.0 via the Jitsi
  build) is inlined into its own lazy chunk, so it needs nothing at run time.
- One job per worker. The runtime holds tens of megabytes once loaded, and the
  worker is terminated on completion, failure or Stop, which releases it.

## How the voice keeps its bandwidth

Both engines work at a fixed rate — 16 kHz for the model, 48 kHz for RNNoise —
and neither's audio is used. What leaves an engine is the *ratio* between the
magnitude it was handed and the magnitude it returned: a gain per band per
frame. `spectral-gain` applies that field to the recording at its own sample
rate, so the output keeps the original phase and the original bandwidth, and a
passage the engine left alone comes back unchanged.

The field is read at the time and frequency each output bin actually sits at, so
no rate has to match any other. Above the engine's reach the gain follows the
mean of the top kilohertz it can see, which is where breath and sibilance are.
The strength control is the floor under that gain, in decibels: a limit rather
than a gate, because a gate that shuts completely is audible as a gate.

A single decision is applied to every channel. Deciding per channel would move
the noise between left and right as each side opened and closed on its own.

## Levelling

Off by default and entirely separate from the suppression. The maths is not
here: it is `shared/media/loudness`, the same module the video editor levels
clips with, so a recording cleaned here and a clip levelled there arrive at the
same level from the same code. This tool contributes `levelling.ts` — the
per-bucket RMS to measure from (a fixed 20 ms bucket, where the editor divides
the clip into 3000) and the per-sample application.

It runs **after** the suppression and is measured on the cleaned audio. Measured
first, a noisy recording reads louder than it is, gets held back, and ends up
quiet once the noise has gone. The reduction figure the page reports is taken
before levelling, which would otherwise move the voice and the noise floor
together and flatter or flatten it depending on the direction.

The peak guard at the end of the worker is load-bearing now: with the limiter
switched off, a boost can push a sample past full scale.

## The runtime's two files, and the one that must not be fetched

ONNX Runtime is a WebAssembly binary plus a small JavaScript module that loads
it. The binary is copied into `assets/onnxruntime/` by `angular.json` and named
explicitly; the loader is **already inside the bundle** and must stay there.

Setting `env.wasm.wasmPaths` to a path *prefix* makes the runtime ignore its own
copy of the loader and fetch that file over the network instead. That fails two
ways: the Angular dev server rewrites module requests (`?import`) and the fetch
never resolves, and any deployment missing that one file fails the same way in
production. Both look identical to the reader — "no available backend found" —
which reads like a server is down, when nothing here has a server at all.

So neither file is left for the runtime to find. `runtime-assets.ts` fetches
both — the binary and the weights — checks the first bytes of each against what
that kind of file starts with, and hands the bytes over: the runtime gets
`env.wasm.wasmBinary` and the session is created from a buffer. There is no path
for a prefix to get wrong and no module for a dev server to rewrite.

Three things are checked before either file is used: the length against the
`Content-Length`, the first bytes against what that kind of file starts with,
and — for the runtime — `WebAssembly.validate`. The last one is not belt and
braces. An interrupted `npm install` leaves a half-written binary in
`node_modules`, the build copies it out without complaint, it has a perfectly
good magic word, and the runtime fails at the far end with `ERROR_CODE: 1,
ERROR_MESSAGE: Unknown Exception`. Validating says "truncated or corrupt,
reinstall it" instead.

The check exists because of the quiet failure. A single-page site answers a
request for a file it does not have with its own `index.html` and a **200**, so
the runtime compiles an HTML page as WebAssembly and reports a bad magic word.
Reading the bytes here turns that into the sentence the reader can act on — the
file was not published — with the URL, the status, the content type, the size
and the first bytes beside it.

## Re-running without re-listening

Only the engine costs real time. Strength, brightness and levelling all act on
the gain field it produced, so pressing the button again after changing one of
them hands the worker its own previous answer as `cachedField` and skips the
model entirely. Changing the engine is the only thing that invalidates it.

The page keeps the settings a result was actually made with, separately from the
controls, so the summary describes the file that exists rather than the controls
as they now stand — and says which of the two kinds of re-run is in front of you.

## Reading the result

`audio-metrics.ts` holds the measurement the page reports. It compares **the
same** quiet blocks on both sides, chosen by their level in the input: an easier
version that picked the quietest blocks of each side separately would compare
two different moments and flatter the result by several decibels. It measures a
level change, not an SNR improvement and not speech preservation.

The same file holds the working-set estimate. Minutes alone do not decide whether
a recording fits in memory — eight channels at 192 kHz is thirty times mono at
48 kHz for the same length — so the estimate is taken from all three and the
refusal happens before a single channel is allocated.

## Timing and memory

The whole soundtrack is held as floats while it is worked on, and again while it
is written, which is what sets `MAX_MINUTES`. The model runs at roughly five
times real time on a current laptop and RNNoise at about fifteen.

## What was measured

On the 48 kHz `noisy_snr0.wav` fixture from the DeepFilterNet repository, at the
Balanced strength, comparing the loudest and quietest half-seconds band by band:

| Band | Pause | Speech |
|---|---|---|
| 100–300 Hz | −18.8 dB | −0.3 dB |
| 300–3400 Hz | −22.0 dB | −0.1 dB |
| 3400–8000 Hz | −23.6 dB | −0.2 dB |
| 8000–16000 Hz | −23.9 dB | −0.8 dB |

The streaming inference was checked against the model author's own reference
output (`enh.wav` in the GTCRN repository, produced by the full PyTorch model):
correlation 1.0000, 71 dB signal to difference. That is the check to repeat if
the STFT convention, the cache handling or the padding is ever touched.

Exporting a video copies its video packets verbatim; the exported picture is
identical to the input's, MD5 for MD5, and a spec asserts packet bytes and
timestamps rather than trusting the container.

Those numbers are per band between the loudest and quietest half-seconds. The
single figure the page shows is smaller — around 10 dB on the same fixture —
because it compares the same moments on both sides rather than the quietest
moments of each.

## Validation

```sh
ng test --watch=false --browsers=ChromeHeadless --include=src/app/ferramentas/supressao-de-ruido/*.spec.ts
npm run build
```

The specs cover the applier, the field arithmetic, the resampler and the
levelling — that the target is reached, that the lift and hold limits hold, that
a stereo pair stays in step, and that silence is never boosted. They do not
run either engine: the model is half a megabyte of weights and the runtime is
twelve, so engine behaviour is checked by hand against the fixtures above.
