## Projet Poneglyph benchmark (2026-08-01)

Registry ID: `surya-bubble`
Pinned revision: `7d7b358c545cfe757329f780da6ed4100bb5909f`

| Metric | Value |
|---|---:|
| CER | 0,451 % |
| WER | 1,656 % |
| Exact match | 90,65 % |
| Token limit | 0,00 % |

- Dataset: Poneglyph validated single-bubble crops
- Split: test held-out by page
- Date: 2026-07-30
- Samples: 1423
- Hardware: NVIDIA RTX 3090 24 GB
- Protocol: Exhaustive generative evaluation with a 256-token budget, collapsed whitespace and explicit blank, hallucination and token-limit accounting.
- Evidence: https://huggingface.co/Remidesbois/surya-bubble-ocr-poneglyph/blob/7d7b358c545cfe757329f780da6ed4100bb5909f/benchmark_test.json

> Generated from `shared/model-registry.json`; update the registry and rerun `node scripts/render-model-registry.mjs`.
