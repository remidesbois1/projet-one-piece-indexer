# Benchmarks modèles publiés

Ce document est généré depuis `shared/model-registry.json` (v1, 2026-08-01). Ne pas modifier manuellement.

Les résultats ne sont comparables qu’à protocole et tâche identiques. Un matériel non consigné est indiqué explicitement plutôt que supposé.

## PP-OCRv6 Bubble Line

- Identifiant registre : `ppocrv6-line`
- Tâche : `bubble-line-ocr`
- Version : [`Remidesbois/pp-ocrv6-one-piece-bubble-line-rec@10b932d4aadca2830850ccf5951116597404bef8`](https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec/tree/10b932d4aadca2830850ccf5951116597404bef8)
- Dataset : Poneglyph validated bubbles reconstructed from detected text lines
- Split : test held-out by page
- Date : 2026-06-29
- Échantillons : 1 219
- Matériel : Not recorded; offline scoring over pinned predictions
- Protocole : YOLO26n line detection, horizontal line stitching, PP-OCRv6 CTC decoding, then spacing and case rules learned only from the training split.
- Preuve : [artefact figé](https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec/blob/10b932d4aadca2830850ccf5951116597404bef8/postprocess_official_metrics.json)

| Clé | Valeur | Sens favorable |
|---|---:|---|
| `cer` | CER 1,451 % | plus bas |
| `exact_match` | Exact match 75,96 % | plus haut |

## LightOnOCR Poneglyph

- Identifiant registre : `lighton-bubble`
- Tâche : `bubble-ocr`
- Version : [`Remidesbois/LightonOCR-2-1b-poneglyph@3d5181ce138e7d92132a741f1e54c3a9e602e129`](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/tree/3d5181ce138e7d92132a741f1e54c3a9e602e129)
- Dataset : Poneglyph validated single-bubble crops
- Split : test held-out by page
- Date : 2026-07-01
- Échantillons : 1 128
- Matériel : Modal NVIDIA H100
- Protocole : Strict full-generation transcription with the published prompt; whitespace-normalized CER and WER, exact match, blank-rate and multiline-rate over every held-out sample.
- Preuve : [artefact figé](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/blob/3d5181ce138e7d92132a741f1e54c3a9e602e129/benchmark_test.json)

| Clé | Valeur | Sens favorable |
|---|---:|---|
| `cer` | CER 0,424 % | plus bas |
| `wer` | WER 1,405 % | plus bas |
| `exact_match` | Exact match 92,55 % | plus haut |

## Surya OCR 2 Poneglyph

- Identifiant registre : `surya-bubble`
- Tâche : `bubble-ocr`
- Version : [`Remidesbois/surya-bubble-ocr-poneglyph@7d7b358c545cfe757329f780da6ed4100bb5909f`](https://huggingface.co/Remidesbois/surya-bubble-ocr-poneglyph/tree/7d7b358c545cfe757329f780da6ed4100bb5909f)
- Dataset : Poneglyph validated single-bubble crops
- Split : test held-out by page
- Date : 2026-07-30
- Échantillons : 1 423
- Matériel : NVIDIA RTX 3090 24 GB
- Protocole : Exhaustive generative evaluation with a 256-token budget, collapsed whitespace and explicit blank, hallucination and token-limit accounting.
- Preuve : [artefact figé](https://huggingface.co/Remidesbois/surya-bubble-ocr-poneglyph/blob/7d7b358c545cfe757329f780da6ed4100bb5909f/benchmark_test.json)

| Clé | Valeur | Sens favorable |
|---|---:|---|
| `cer` | CER 0,451 % | plus bas |
| `wer` | WER 1,656 % | plus bas |
| `exact_match` | Exact match 90,65 % | plus haut |
| `token_limit_rate` | Token limit 0,00 % | plus bas |

## YoloPiece Panel Detector

- Identifiant registre : `one-shot-panel-detector`
- Tâche : `panel-detection`
- Version : [`Remidesbois/YoloPiece_OneShot_Models@c4d5393095fadacfedc49d81acb2a8ac29d23aad`](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/tree/c4d5393095fadacfedc49d81acb2a8ac29d23aad)
- Dataset : Poneglyph panel annotation dataset
- Split : test held-out by page
- Date : 2026-07-02
- Échantillons : 31
- Matériel : CUDA device 0; exact GPU model not recorded in the artifact
- Protocole : Ultralytics YOLO test-split evaluation at 800 px; confidence-ranked detections scored with standard mAP50 and mAP50-95.
- Preuve : [artefact figé](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/c4d5393095fadacfedc49d81acb2a8ac29d23aad/metrics/panel_detector_metrics.json)

| Clé | Valeur | Sens favorable |
|---|---:|---|
| `map50` | mAP50 99,40 % | plus haut |
| `map50_95` | mAP50-95 98,61 % | plus haut |

## YoloPiece One-Shot Reading Order

- Identifiant registre : `one-shot-reading-order`
- Tâche : `reading-order`
- Version : [`Remidesbois/YoloPiece_OneShot_Models@c4d5393095fadacfedc49d81acb2a8ac29d23aad`](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/tree/c4d5393095fadacfedc49d81acb2a8ac29d23aad)
- Dataset : Poneglyph panel and bubble reading-order annotations
- Split : test held-out by page
- Date : 2026-07-02
- Échantillons : 31
- Matériel : CPU offline scoring; exact processor not recorded in the artifact
- Protocole : Global pairwise logistic reranker selected on validation only, reconstructed with Borda plus vertical repair, then evaluated once on the test pages.
- Preuve : [artefact figé](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/c4d5393095fadacfedc49d81acb2a8ac29d23aad/metrics/reading_order_benchmark.json)

| Clé | Valeur | Sens favorable |
|---|---:|---|
| `page_exact_match` | Exact page 96,77 % | plus haut |
| `bubble_position_accuracy` | Bubble position accuracy 99,32 % | plus haut |
| `global_pairwise_accuracy` | Global pairwise accuracy 99,93 % | plus haut |
