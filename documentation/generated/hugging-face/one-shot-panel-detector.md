## Projet Poneglyph benchmark (2026-08-01)

Registry ID: `one-shot-panel-detector`
Pinned revision: `c4d5393095fadacfedc49d81acb2a8ac29d23aad`

| Metric | Value |
|---|---:|
| mAP50 | 99,40 % |
| mAP50-95 | 98,61 % |

- Dataset: Poneglyph panel annotation dataset
- Split: test held-out by page
- Date: 2026-07-02
- Samples: 31
- Hardware: CUDA device 0; exact GPU model not recorded in the artifact
- Protocol: Ultralytics YOLO test-split evaluation at 800 px; confidence-ranked detections scored with standard mAP50 and mAP50-95.
- Evidence: https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/c4d5393095fadacfedc49d81acb2a8ac29d23aad/metrics/panel_detector_metrics.json

> Generated from `shared/model-registry.json`; update the registry and rerun `node scripts/render-model-registry.mjs`.
