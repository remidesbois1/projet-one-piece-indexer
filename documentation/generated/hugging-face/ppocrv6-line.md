## Projet Poneglyph benchmark (2026-08-01)

Registry ID: `ppocrv6-line`
Pinned revision: `10b932d4aadca2830850ccf5951116597404bef8`

| Metric | Value |
|---|---:|
| CER | 1,451 % |
| Exact match | 75,96 % |

- Dataset: Poneglyph validated bubbles reconstructed from detected text lines
- Split: test held-out by page
- Date: 2026-06-29
- Samples: 1219
- Hardware: Not recorded; offline scoring over pinned predictions
- Protocol: YOLO26n line detection, horizontal line stitching, PP-OCRv6 CTC decoding, then spacing and case rules learned only from the training split.
- Evidence: https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec/blob/10b932d4aadca2830850ccf5951116597404bef8/postprocess_official_metrics.json

> Generated from `shared/model-registry.json`; update the registry and rerun `node scripts/render-model-registry.mjs`.
