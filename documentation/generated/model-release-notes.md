# Model benchmark release notes

Generated from model registry v1 on 2026-08-01.

## PP-OCRv6 Bubble Line

- Registry ID: `ppocrv6-line`
- Published version: `Remidesbois/pp-ocrv6-one-piece-bubble-line-rec@10b932d4aadca2830850ccf5951116597404bef8`
- Result: CER 1,451 % · Exact match 75,96 %
- Evaluation: Poneglyph validated bubbles reconstructed from detected text lines, test held-out by page, 1219 samples, 2026-06-29
- Hardware: Not recorded; offline scoring over pinned predictions
- Protocol and evidence: YOLO26n line detection, horizontal line stitching, PP-OCRv6 CTC decoding, then spacing and case rules learned only from the training split. https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec/blob/10b932d4aadca2830850ccf5951116597404bef8/postprocess_official_metrics.json

## LightOnOCR Poneglyph

- Registry ID: `lighton-bubble`
- Published version: `Remidesbois/LightonOCR-2-1b-poneglyph@3d5181ce138e7d92132a741f1e54c3a9e602e129`
- Result: CER 0,424 % · WER 1,405 % · Exact match 92,55 %
- Evaluation: Poneglyph validated single-bubble crops, test held-out by page, 1128 samples, 2026-07-01
- Hardware: Modal NVIDIA H100
- Protocol and evidence: Strict full-generation transcription with the published prompt; whitespace-normalized CER and WER, exact match, blank-rate and multiline-rate over every held-out sample. https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/blob/3d5181ce138e7d92132a741f1e54c3a9e602e129/benchmark_test.json

## Surya OCR 2 Poneglyph

- Registry ID: `surya-bubble`
- Published version: `Remidesbois/surya-bubble-ocr-poneglyph@7d7b358c545cfe757329f780da6ed4100bb5909f`
- Result: CER 0,451 % · WER 1,656 % · Exact match 90,65 % · Token limit 0,00 %
- Evaluation: Poneglyph validated single-bubble crops, test held-out by page, 1423 samples, 2026-07-30
- Hardware: NVIDIA RTX 3090 24 GB
- Protocol and evidence: Exhaustive generative evaluation with a 256-token budget, collapsed whitespace and explicit blank, hallucination and token-limit accounting. https://huggingface.co/Remidesbois/surya-bubble-ocr-poneglyph/blob/7d7b358c545cfe757329f780da6ed4100bb5909f/benchmark_test.json

## YoloPiece Panel Detector

- Registry ID: `one-shot-panel-detector`
- Published version: `Remidesbois/YoloPiece_OneShot_Models@c4d5393095fadacfedc49d81acb2a8ac29d23aad`
- Result: mAP50 99,40 % · mAP50-95 98,61 %
- Evaluation: Poneglyph panel annotation dataset, test held-out by page, 31 samples, 2026-07-02
- Hardware: CUDA device 0; exact GPU model not recorded in the artifact
- Protocol and evidence: Ultralytics YOLO test-split evaluation at 800 px; confidence-ranked detections scored with standard mAP50 and mAP50-95. https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/c4d5393095fadacfedc49d81acb2a8ac29d23aad/metrics/panel_detector_metrics.json

## YoloPiece One-Shot Reading Order

- Registry ID: `one-shot-reading-order`
- Published version: `Remidesbois/YoloPiece_OneShot_Models@c4d5393095fadacfedc49d81acb2a8ac29d23aad`
- Result: Exact page 96,77 % · Bubble position accuracy 99,32 % · Global pairwise accuracy 99,93 %
- Evaluation: Poneglyph panel and bubble reading-order annotations, test held-out by page, 31 samples, 2026-07-02
- Hardware: CPU offline scoring; exact processor not recorded in the artifact
- Protocol and evidence: Global pairwise logistic reranker selected on validation only, reconstructed with Borda plus vertical repair, then evaluated once on the test pages. https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/c4d5393095fadacfedc49d81acb2a8ac29d23aad/metrics/reading_order_benchmark.json
