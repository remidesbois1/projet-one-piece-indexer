# Upstream model

Falcon-OCR is published by Technology Innovation Institute under Apache-2.0:
https://huggingface.co/tiiuae/Falcon-OCR
https://github.com/tiiuae/Falcon-Perception

This pipeline downloads the model's Python implementation and weights at the
explicit revision in config.py. It preserves their attribution and architecture.
The differentiable attention/MLP training path is implemented separately; no
downloaded inference kernel is assumed to support backward.

Source manga images and annotations are not relicensed by the model's license.
