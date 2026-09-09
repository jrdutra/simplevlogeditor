# Video transcription

The `/video-transcription` tool transcribes audio and generates editable captions.
It does not summarize the visual content of a video or identify speakers.

## Recognition and timing

- The track's decodability is checked before anything is read, so a codec the
  browser has no decoder for (AAC in some Firefox builds, for instance) is
  named instead of failing inside the decode loop.
- Mediabunny decodes audio with its presentation timestamps. Ten-second resampling
  blocks include 50 ms of filter context. Gaps and initial delays remain on the
  original media timeline. One hour of 16 kHz mono floats needs approximately
  230 MB, plus model and runtime memory.
- Channels are averaged, with an energy-based fallback to the strongest channel
  when destructive interference would otherwise cancel the signal. No generic
  denoising, compression or quiet-speech threshold is applied.
- A dedicated worker runs Transformers.js/Whisper. Each 24-second core has up to
  3 seconds of context on each side, staying within Whisper's 30-second input.
  Word timestamps use the model's cross-attention alignment. Midpoint ownership
  selects words from the overlapping windows. This reduces edge truncation but
  does not guarantee identical recognition or alignment across seams.
- Digital silence is skipped. Music and noise can still produce hallucinations;
  amplitude alone cannot reliably distinguish them from speech.
- Small is the default. Tiny and Base trade accuracy for resources; Large v3 Turbo
  is available for machines with sufficient memory. Files come from the official
  `onnx-community/*_timestamped` repositories. Model download sizes are approximate.
- Transformers.js is pinned to 4.2.0. Its ONNX Runtime 1.26 development build fails
  during extended QDQ graph optimization on the quantized decoder embeddings.
  `graphOptimizationLevel: 'basic'` avoids that rewrite. Keep the real-model smoke
  test when upgrading; compilation alone did not catch this failure.
- Abort terminates the worker, including during loading or inference. Completed
  windows remain reviewable. Model sessions are released after every job; the
  browser can retain downloaded files in its cache.

## Meeting capture

- `getDisplayMedia` is requested with a video track so the browser keeps its own
  source picker and sharing indicator; only the audio is recorded. The shared
  audio and, optionally, the microphone are mixed at 1/n gain into one
  `MediaRecorder` stream and never routed back to the speakers.
- Whether a desktop meeting app can be captured at all is decided by the browser
  and the operating system, not by this page. Where it cannot, the recording
  exported by the meeting app can be imported instead.
- Recording ends on the stop button, when the shared track ends, after
  `MAX_MINUTES`, or at 128 MB of encoded audio. The result becomes the current
  file and transcription starts on its own. This is not live captioning.
- Recording other people is the user's responsibility, not the tool's.

## Captions and review

Word timestamps drive grouping at punctuation, pauses, width and duration limits.
When manually edited captions need further splitting, timing is proportional to
their text; review those boundaries. Media bounds and non-overlap take priority
over minimum display duration. Long uncertain segments are flagged instead of
hiding recognized speech. The 20 characters/second notice is a reading-speed
heuristic, not a confidence estimate. Review names, numbers and overlapping speech.

SRT, basic YouTube SBV and WebVTT use millisecond clocks with correct rounding
carry. SBV retains real newlines, following [YouTube's examples](https://support.google.com/youtube/answer/2734698?hl=en).
WebVTT escapes text markup. Plain and timed text exports include manual edits.

## Validation

```sh
ng test --watch=false --browsers=ChromeHeadless --include=src/app/ferramentas/transcricao-de-video/*.spec.ts
ng test --watch=false --karma-config=karma.transcription-smoke.cjs --ts-config=tsconfig.transcription-smoke.json --include=src/app/ferramentas/transcricao-de-video/*.smoke.ts
npm run build
```

The optional smoke suite uses a public JFK WAV and downloads Tiny and Small
(approximately 300 MB total). It tests actual browser worker recognition,
cancellation, and repeated speech across window boundaries. Its Levenshtein word
error rate is measured on that specific English fixture only. It is not a
representative benchmark against commercial services. A competitive assessment
needs a held-out corpus covering Portuguese, accents, noise, names, numbers,
multiple speakers, and human-checked word timestamps.
