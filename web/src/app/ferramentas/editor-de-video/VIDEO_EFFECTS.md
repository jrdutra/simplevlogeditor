# Video Effects

Each visual `MediaClip` owns an optional `videoEffect: { id, intensity }`. Missing/unknown IDs resolve to Original. Nothing is added to `ProjectSettings` or inheritable `ClipEdits`. The editor's existing `touch`, snapshots, signature, serializer and recovery checkpoint carry selection and intensity. Duplicate/split operations copy settings independently.

The gallery lives directly after Animated tag. It initially displays eight thumbnails from the container image and caches JPEG results. More/category controls render further items on demand. Classical thumbnails render first; AI thumbnail analysis starts only after selecting a portrait effect or clicking Prepare AI previews, and reuses one subject matte. The container source player also renders through the effect engine. Intensity blends Original with the full preset, so zero is an exact bypass.

`video-effects.ts` is the catalogue. `video-effect-shader.ts` owns the WebGL color/spatial pass: restrained split toning, saturation, faded blacks, highlight bloom, grain, vignette, RGB displacement, animated tape/glitch and light leaks. `video-effect-engine.ts` composes subject/background operations and mixes intensity. Spatial/time parameters are normalized; animations depend on timeline time rather than wall-clock or random history. No full-frame pixel loop runs on the UI thread for grading.

The shared frame compositor processes the framed image before captions/tags. The existing crop/push-in geometry is retained; masks use that exact geometry. The effected foreground is also used when repainting a person over Behind Subject captions. Transitions receive independently effected outgoing/incoming sources. Export's pass-through path explicitly checks container effects. GPU failure is reported rather than silently producing a different export.

AI playback uses `SubjectEffectPreview` to retain an exact frozen image/matte pair while the next frame is analyzed. There is at most one pending and one completed image per lane. Visual refresh cadence and latency depend on local inference speed; audio and timeline controls remain responsive. Seeks, source replacement and aspect changes invalidate pending results. Export still awaits the matte for every output frame at full output size. The source player's native fullscreen/PiP buttons are disabled because they would bypass the canvas; the timeline's composited fullscreen preview remains available.

`SubjectSegmentationClient` remains the vision resource/cache layer. Clients lease one lazy Worker/model across surfaces; mask inference is shared between caption and effect for a frame. MODNet already existed; no new model dependency was added. The Worker uses WebGPU or WASM, mask memory is bounded, confidence fluctuations are smoothed without blending displaced hair edges, and the model is released after the last consumer. Caches never enter project JSON. No subject is a supported Original fallback; model failure stops an affected export with an actionable error.

The catalogue declares capabilities (`subject`, `face`, `pose`, `depth`). Only `subject` currently has a provider. A future provider should use the same lease/cache/lifecycle contract, key results by source identity, source timestamp and geometry, and pass results to the engine. No pseudo depth blur or whole-frame skin blur is exposed. Background replacement can use the same subject/background composition when an asset picker is designed. Favorites can store stable preset IDs separately from clip settings.

Current set: Original + 22 effects, including all first-priority presets and Neon Outline. Face Spotlight, Soft Skin, Pose Aura, Motion Trail and depth/parallax effects remain unexposed until a suitable local model and temporal quality validation are available.

Verification includes GPU pixel comparisons, color/orientation checks, deterministic animation, subject-mask composition, per-container isolation, transitions, overlay legibility, 720p/1080p/4K and portrait/square canvases, JSON round-trip, duplicate independence and undo/redo. Synthetic masks verify composition; they do not substitute for evaluating MODNet on real hair, multiple people and complex motion.

## Background Captions, spatial effects and the occlusion matte

Background Captions and subject effects ask the same question about the same
frame, so preview answers it once. Both take the frozen picture/matte pair from
`SubjectEffectPreview`: the caption is composited against the exact image the
matte was measured on, never against a later decoder frame. A pair is dropped
when the clip, its file identity, the output size or the fill mode changes, on
seek, and whenever playback time jumps more than 0.25s — which is what a deleted
source range looks like from the player, including a short one.

Glitch, VHS and RGB Split move pixels sideways. The matte measured on the
undisplaced frame therefore no longer describes the person in the finished
picture, so `VideoEffectEngine.occlusionMask` sends it through the same shader
pass with the identical `time`, `mode` and `split` the picture was rendered
with, and blends it by the same intensity: the displayed frame is
`mix(original, processed, intensity)`, so the silhouette that hides the caption
is the same mix of the undisplaced and displaced silhouettes. Zero intensity is
an exact bypass and full intensity uses the displaced matte alone. Channel split
is unioned across its three sample points, so no channel of the subject leaves
the caption showing through. Presets that only regrade colour reuse the plain
matte and pay nothing. A GPU failure falls back to the undisplaced matte and
reports a warning rather than dropping the occlusion.

Export distinguishes a model that found no person from a model that could not
run. `no-subject` is the designed visual fallback and exports as ordinary text;
`unavailable` now stops the export for a Background Caption exactly as it
already did for an AI effect, instead of silently writing a file with the text
in front of the subject.

### People are the subject; everything else is background

Three things used to leak through. The matte returns speckle and the occasional
fragment of something held or passing, and those fragments were exactly what
stayed in focus while the rest of the picture blurred — and what flickered,
because a fragment appears and disappears between frames.
`keepPrincipalRegions` finds the regions of the matte on a coarse grid and drops
the ones that are small both in absolute terms and beside the largest, so one
person or several survive untouched and the fragments do not. It runs once,
centrally, so the Background Caption's occlusion and every Creator preset see
the same person-only silhouette.

Be clear about what that is: it removes fragments from a portrait matte. It does
not detect people. A chair the model has confidently included in one blob with
the person sitting on it stays, because from here it is the person.

With nobody in the frame, the frame is entirely background and is treated as
one: Background Blur, Portrait Pop, Background Darken and Selective Color now
apply to the whole picture instead of leaving it untouched. Subject Glow and
Neon Outline put light around a subject and have nothing to add without one, so
they leave the picture alone.

That rule has a sharp edge, and it is guarded. A matting model blinks, and a
blink must not throw the whole picture out of focus for two frames and back
again. A lost silhouette is held for a quarter of a second before the frame is
conceded to the background.

### Why the background shimmered when the camera moved

The hole cut in the background plate is now cut with a *grown* matte, not the
exact one. A silhouette a few pixels wider costs nothing — the sharp person is
painted back over it afterwards — and it keeps the jittering boundary, and every
colour near it, out of the plate the blur samples. Without that, a camera move
changes which pixels near her edge are background from frame to frame, the fill
changes with them, and the blur around her shifts colour: the flicker.

The adaptive analysis size gained hysteresis for the same reason. Stepping
between 1024px and 320px whenever the rolling average crossed the budget was
itself a flicker — the silhouette gained and lost detail in step with it. It now
takes three readings in one direction to move and a cooldown afterwards.

### Layer order

Background Captions sit between the background and the person, and that is the
order the compositor draws: picture, then caption, then the isolated subject
over both. The subject layer uses the same person-only matte, so an object the
model picked up no longer sits in front of the lettering. With no person in the
frame there is no front layer, and the caption reads as ordinary text over the
picture — which is the designed fallback, not a failure.

### Known limitations

Segmentation quality is MODNet's. Loose hair against a busy background, motion
blur and more than one person are the cases where the matte is weakest, and no
amount of compositing here fixes a matte that is wrong at the source. The
displaced matte corrects alignment, not segmentation quality.

## Two clocks, named

Animated presets read a clock, and there are two of them on purpose.

The **edited clock** is clip-local output time, `time - clip.outputStart`, after
trims, deleted ranges and speed. The timeline preview and the encoder both pass
it into `composeFrame`, which is why the same edited instant produces the same
phase of tape wobble, glitch burst, grain and light leak in the preview and in
the exported file.

The **source clock** belongs to the container's own player, which previews the
original file rather than the edit. It is not converted into the edited clock,
because scrubbing the source is a different question from watching the cut; the
surface says so in a caption under the picture instead of implying the two
agree. A still image has no clock in either space, so the source player runs a
looping playhead across the container's output duration — an animated preset
can now be judged there instead of sitting frozen at zero.

The source player cannot be escaped into an un-effected picture: native
fullscreen and picture-in-picture are disabled on that element
(`controlsList="nofullscreen"`, `disablePictureInPicture`) because both would
show the raw `<video>` underneath the composited canvas. The timeline's own
composited fullscreen preview remains available. A newly bound `src` also
parks the surface until that file has actually loaded, so a frame left decoded
from the previous container is never composited, and never analysed, as if it
belonged to the new one.

## Failure states, and what each one means

`SubjectSegmentationClient` separates a result from a failure. Finding no person
is a result: state `no-subject`, no `failure`, and the designed visual fallback
(ordinary text, original picture) in preview and export alike. Everything else
is a `SubjectSegmentationFailure` carrying a `kind`:

| kind | meaning | retryable |
| --- | --- | --- |
| `model-unavailable` | the browser cannot run the model at all | no |
| `inference-failed` | the worker crashed, or a frame could not be read | yes |
| `timeout` | inference did not return in time | yes |
| `cancelled` | the client was disposed mid-request | yes |

`retry()` clears a recoverable failure and lets the next request rebuild the
worker, without reloading the editor; cached mattes survive it because they were
measured before the failure. The preview surfaces offer that retry as a button,
`subjectFailureMessage` phrases the same failure differently for an effect and
for a Background Caption, and export refuses to write a degraded file: it stops
with the classified message, the partial output is discarded rather than
published, and any earlier file at that path and the recovery checkpoint are
left untouched.

## What a gallery card shows

A card is a catalogue entry for one preset, and three things make it honest.

**It is this container's own picture, at a usable size.** The card no longer
renders on `thumbUrl`, the 160×90 JPEG the clip list uses — that thumbnail is
also written into the saved project, so it cannot simply be enlarged. The
gallery decodes its own frame from the container instead (half a second in for
video, so a recording that opens on black is not previewed on black; the full
image for a still) and renders at up to 480px. Grain is drawn on a fixed
1280×720 grid and channel split is a fraction of the frame, so both read very
differently at 160px than they do in an export; at 480px a preset is judged on
something close to what the finished video will look like. A failed decode
falls back to the list thumbnail rather than showing nothing.

**It is rendered at full strength.** `intensity: 1`, not the 0.75 default, so
the difference between one graded preset and the next is actually visible. How
much of the preset is applied to the clip remains the Intensity slider's job,
and the note under the gallery says so.

**It is never the untouched frame in disguise.** A card that has no computed
preview yet shows the source frame dimmed, under a label saying whether it is
still rendering or whether its AI preview has not been prepared; only the
Original card shows the plain picture, which is what Original means. A
segmentation failure leaves the portrait cards in that marked state and offers
Retry, instead of rendering an unprocessed frame that would read as "this
preset does nothing".

Presets that move with time are sampled at several instants and the frame that
departs furthest from the original is the one kept, because one fixed moment
can fall between glitch bursts and produce a card identical to the untouched
picture. The instant is chosen by measuring the rendered result, not by
predicting the shader's noise from the CPU.

## Background Blur and Portrait Pop: blurring the background alone

Both presets used to blur the whole frame and put the sharp cut-out back on
top. The blur had already carried the subject's own colours past her outline,
and the cut-out does not cover that: what remained was a halo hugging hair,
cheeks and shoulders, worst where the contrast between person and background is
highest.

The blur is now given a plate the subject has been removed from. The hole she
leaves is filled **from its own surroundings**: the holed plate is drawn back
under itself at growing blur radii, each pass painting only what is still
transparent, so the colours that close the gap are the background that was
beside her. Only then is the plate blurred. Partial hair alpha therefore
composites against a clean background instead of against a smeared copy of
itself. Brightness and grayscale presets (Background Darken, Selective Color)
move no pixels sideways and are left on the original frame.

The first version of this filled the hole by pushing the whole frame inwards and
closing the remainder with the mean colour of the picture, and that is a shadow
generator: the mean of a frame is almost always darker than the light
immediately behind a lit person, so the ring the grown matte leaves came back
darker than the background around it and read as a drawn outline. Only Subject
Glow and Neon Outline exist to put something around a subject. Every other
preset must leave no edge at all, and the fill now takes its colours only from
the neighbourhood it is closing.

What is still transparent after those passes is deep inside a large silhouette,
where the sharp person is painted over it regardless; it is closed so the plate
is opaque before the blur, with a colour taken from the already-filled plate, so
it can no longer reach the edge.

This does not make the matte better. It removes one specific artefact that the
compositing order was adding on top of the matte. Loose hair against a busy
background, motion blur and more than one person remain the cases where MODNet
itself is weakest, and no compositing here repairs a silhouette that is wrong at
the source.

## One cache budget, and failures that stay where they happen

Each `SubjectSegmentationClient` used to keep its own 64 MB ceiling, so two
timeline lanes, the effects gallery, the container player and a running export
could reserve five ceilings that only ever added up. There is now one shared
budget for all of them, charged against whoever is holding the most: a client
evicts its own oldest mattes first, and when the shared ceiling is still
exceeded the largest cache is trimmed next.

A request that times out now fails only the client that made it. It used to
terminate the shared worker and mark every surface `unavailable`, so one slow
inference in the gallery could black out the timeline preview's occlusion. A
worker that genuinely crashes still fails everyone, because it genuinely is
gone.

## Preview latency is measured, not guessed

Holding the last analysed picture keeps the matte and the person together, but
it does not make the wait shorter — it makes it invisible, which is worse when
the audio and the timeline run on without the image. The wait is shortened by
analysing fewer pixels, and how many fewer is a property of the machine, so the
client times its own inferences and adjusts.

`ANALYSIS_MAX_EDGE` is now a ceiling rather than a constant. Each preview client
keeps a rolling average of its inference cost; above `PREVIEW_BUDGET_MS` the
analysis edge steps down towards 320px, and when it is comfortably under budget
it steps back up towards 1024. One step at a time in either direction, so a
single slow frame cannot collapse the preview and a single fast one cannot undo
a reduction that was earned. Mattes cached at another resolution stay valid —
they are resampled to the output size when drawn — and temporal smoothing skips
the frame where the resolution changes.

**The export never takes this path.** The encoder constructs its client with
`{ adaptive: false }` and always analyses at the full ceiling: the preview may
trade detail for a clock, the file the reader keeps may not.

The preview also says where it stands instead of just looking stuck.
`status()` reports `reduced` and `analysisEdge`, and `SubjectEffectPreview`
records the instant its completed pair was measured on, so the timeline can tell
the reader the picture is running a given number of seconds behind, and that the
export is unaffected. Queue depth is unchanged and still bounded: one inference
in flight per lane, and a request for a key already asked for is not repeated.

## Animated captions are fitted against their own animation

The fit was computed at rest and the animation applied afterwards. A caption
fitted exactly to its margin was then scaled up to 1.1x about the centre of the
frame, which moves an upper-left or centre-right anchor further out rather than
in: the first or last letters left the picture. `backgroundCaptionEnvelope`
declares the extremes each animation reaches, and the text is fitted against the
worst of them, taking rotation, line count and glyph overhang with it as before.

With no animation the bound reduces to exactly the static fit that was always
used, so no still preset moves by a pixel and no preset's design changes. A
numeric sweep over 9:16 at anchors from 0.08 to 0.92 put the old worst case at
roughly 50px past the margin and the new one at zero.

The layer is also rasterised with headroom: a frame-sized layer drawn at 1.1x
resamples the glyphs upwards and softens them at exactly the moment the caption
is largest. It is now painted at the envelope's peak scale and drawn down, so
the zoom never asks for pixels that were not rendered.

Font stacks gained broader fallbacks — Liberation, DejaVu and URW faces after
the Windows-only primaries — so a machine without Bahnschrift or Segoe Print
degrades to something with similar metrics instead of to the default sans.
Preview and export always agree, because they run in the same browser; it is
between machines that the substitute matters, and this narrows that gap without
fetching a web font that would draw the caption twice.

## Sections, and how an effect arrives

A visual container carries `videoEffects: ClipVideoEffect[]` — sections measured
in **source** seconds, exactly like `ClipCaption`. The legacy whole-clip
`videoEffect` is still read and still written when a clip reduces to a single
full-length section, so a project saved before this feature opens unchanged and
one saved after it still opens in a build that predates it. Sections may not
overlap, the same rule captions follow.

`buildProjectPlan` converts them into `ProjectPlan.videoEffects`, on the output
clock, through the same arithmetic captions use: `cutTimeOf` for the cuts and a
division by the clip's speed. `videoEffectAt(plan.videoEffects, time, clipId)`
resolves the instant, and the `clipId` argument is what keeps the two sides of a
transition apart while both are on screen.

### The edge

`fadeSeconds` decides how the effect arrives and leaves.

Zero — the default, and what every existing project gets — is a cut: the effect
is fully on at the first frame of the section and gone at the first frame after
it. Above zero it eases in over that many seconds and back out at the other end.

The ramp needs no new rendering path anywhere. The engine already mixes the
untouched frame with the processed one by `intensity`, and intensity 0 is an
exact bypass, so `videoEffectAt` simply returns the effect with its intensity
scaled by the ramp: the two ends of a soft section are the original picture by
construction rather than by approximation. The curve is a smoothstep rather than
a straight line, because a linear ramp of a grade has a visible corner where the
rate of change stops.

`fadeSeconds` is written in source seconds and watched in output seconds, so it
is divided by the clip's speed like every other edge. It is clamped to half the
section at both the editor and the plan, so the two ramps can never meet; a
section shorter than twice its fade therefore peaks below the intensity asked
for, which is the honest reading of what was described.
