# Plate detector regression fixture

`license-plate-sample.png` is the unmodified test image from FastALPR:
https://github.com/ankandrew/fast-alpr/blob/master/assets/test_image.png

FastALPR is Copyright (c) 2024 ankandrew, MIT-licensed:
https://github.com/ankandrew/fast-alpr/blob/master/LICENSE

The fixture is served only by the browser test target, not shipped in the app.
It exercises actual local ONNX detection and pixel redaction. This is a smoke
test on one visible European plate, not a multi-country accuracy benchmark.
