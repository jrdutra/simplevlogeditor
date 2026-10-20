# Local license plate detector

Enable **Video container settings → Privacy → Blur vehicle license plates**.
The flag is persisted as `clips[].blurLicensePlates` only on video containers,
off by default. It is absent from project settings and presets; older global
flags are ignored when opening a project. Image/audio containers and text cards
do not support this option.

MCP operation in `apply_edit_batch`:
`{ "type": "set_license_plate_blur", "clipId": "clip-1", "enabled": true }`.
Discover metadata via `get_editor_capabilities().licensePlateBlur` and
verify `get_frames` with `composited: true` (`licensePlateBlurApplied: true`).
Failures report `plate_detection_failed`; never disable protection to bypass one.
AI clients first inspect original source frames with their generative vision:
enable only videos with a visible car and exposed plate, respecting explicit
opt-outs. Uninspected or inconclusive videos stay off. The local model then
detects and blurs plates over time inside the selected containers.

- Model: Open LPR, `plate_yolox_tiny_640.onnx` (20,183,226 bytes), renamed `detector.onnx` without changing weights.
- Pinned source: https://huggingface.co/faisalthaheem/open-lpr-models/resolve/aed0df35ec2891c5a90437041ebeadb592cc516b/onnx/plate_yolox_tiny_640.onnx
- SHA-256: `e5350bb2152eb44fa129b2438d1e39bbbf3c27accfe51cd893ce6e17d028d0b9`.
- License: Apache-2.0; upstream `LICENSE` and `NOTICE` are included. Only the detector is bundled, not OCR weights/dictionaries.
- Provenance and per-artifact license: https://huggingface.co/faisalthaheem/open-lpr-models/blob/aed0df35ec2891c5a90437041ebeadb592cc516b/manifest.json
- Architecture: YOLOX-tiny, COCO initialization, plate fine-tuning by Open LPR contributors; https://github.com/faisalthaheem/open-lpr.

The unmodified ONNX weights are bundled with the web/desktop/Android assets.
Inference runs in a local WASM worker using the project's ONNX Runtime. No images,
plate text or video bytes are sent to a remote inference service. Detection uses
visual localization, not country-specific OCR or plate-number patterns.

Input is RGB float32 NCHW `[1,3,640,640]`, raw values 0–255, with aspect-preserving
letterboxing and RGB 114 padding. Output `[1,8400,6]` rows are
`[cx,cy,width,height,objectness,plateProbability]`, with decoded pixel coordinates.
The editor uses objectness × plate probability >= 0.20, IoU NMS 0.45,
enlarged boxes, coarse pixel reduction plus blur,
and a short bounded detection hold. Export processes enabled video frames and
stops on inference failures. Transitions redact each enabled source independently
before mixing/moving the pictures, leaving unchecked neighbours unaltered.
Preview shows only completed
redacted frames, holding/blanking while analysis catches up.
Detection runs before the final fade darkens the composed picture, and that
fade is applied after redaction so low brightness does not hide a plate from
the detector. Composed MCP frames follow the same order.

Automatic detection can miss tiny, occluded, distant, highly angled or motion-blurred
plates, including unfamiliar country formats. This is not a guarantee that every
plate is found. Review the finished output, particularly traffic and distant cars.
