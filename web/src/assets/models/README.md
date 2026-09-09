# Speech models served with this site

## gtcrn.onnx

The streaming export of **GTCRN**, from *GTCRN: A Speech Enhancement Model
Requiring Ultralow Computational Resources* (Rong Xiaobin et al., ICASSP 2024).

- Source: https://github.com/Xiaobin-Rong/gtcrn — `stream/onnx_models/gtcrn_simple.onnx`
- Licence: MIT, Copyright (c) 2024 Rong Xiaobin
- 48.2 K parameters, 33 MMACs per second, trained at 16 kHz on the DNS3 set.

Used by the Background Noise Remover. It is committed here rather than fetched
at run time because half a megabyte is smaller than the request that would go
and get it, and because a tool that promises to work without sending anything
anywhere should not need the network to start.
