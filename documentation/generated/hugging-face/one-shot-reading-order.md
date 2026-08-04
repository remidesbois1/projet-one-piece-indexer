## Projet Poneglyph benchmark (2026-08-01)

Registry ID: `one-shot-reading-order`
Pinned revision: `c4d5393095fadacfedc49d81acb2a8ac29d23aad`

| Metric | Value |
|---|---:|
| Exact page | 96,77 % |
| Bubble position accuracy | 99,32 % |
| Global pairwise accuracy | 99,93 % |

- Dataset: Poneglyph panel and bubble reading-order annotations
- Split: test held-out by page
- Date: 2026-07-02
- Samples: 31
- Hardware: CPU offline scoring; exact processor not recorded in the artifact
- Protocol: Global pairwise logistic reranker selected on validation only, reconstructed with Borda plus vertical repair, then evaluated once on the test pages.
- Evidence: https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/c4d5393095fadacfedc49d81acb2a8ac29d23aad/metrics/reading_order_benchmark.json

> Generated from `shared/model-registry.json`; update the registry and rerun `node scripts/render-model-registry.mjs`.
