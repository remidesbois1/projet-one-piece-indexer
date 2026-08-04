## Projet Poneglyph benchmark (2026-08-01)

Registry ID: `lighton-bubble`
Pinned revision: `3d5181ce138e7d92132a741f1e54c3a9e602e129`

| Metric | Value |
|---|---:|
| CER | 0,424 % |
| WER | 1,405 % |
| Exact match | 92,55 % |

- Dataset: Poneglyph validated single-bubble crops
- Split: test held-out by page
- Date: 2026-07-01
- Samples: 1128
- Hardware: Modal NVIDIA H100
- Protocol: Strict full-generation transcription with the published prompt; whitespace-normalized CER and WER, exact match, blank-rate and multiline-rate over every held-out sample.
- Evidence: https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/blob/3d5181ce138e7d92132a741f1e54c3a9e602e129/benchmark_test.json

> Generated from `shared/model-registry.json`; update the registry and rerun `node scripts/render-model-registry.mjs`.
