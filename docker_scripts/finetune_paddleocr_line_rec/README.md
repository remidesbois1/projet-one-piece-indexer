# PP-OCRv6 Bubble Line Recognition

This package prepares and launches a bubble-as-single-line recognition fine-tune
path for:

`PaddlePaddle/PP-OCRv6_medium_rec_safetensors`

It uses the YOLO26n bubble-line detector trained in:

`docker_scripts/train_bubble_line_detector/runs/yolo26n_bubble_line/weights/best.pt`

## Pipeline

1. Fetch validated bubbles from Supabase, using the same source fields as the
   Surya bubble OCR pipeline: `bulles(id, x, y, w, h, texte_propose, id_page,
   pages(url_image))`.
2. Split at page level into train/val/test to avoid page leakage.
3. Download source pages and crop each validated bubble.
4. Run the trained YOLO line detector inside each bubble crop.
5. Deduplicate overlapping line boxes, then sort them in reading order.
6. Crop the visual lines and stitch them left-to-right into one single-line
   image per bubble.
7. Use the full bubble transcript as the label for that stitched image.
8. Write a PaddleOCR-style recognition dataset:
   - `bubble_single_line_rec_dataset/images/train/*.png`
   - `bubble_single_line_rec_dataset/images/val/*.png`
   - `bubble_single_line_rec_dataset/images/test/*.png`
   - `bubble_single_line_rec_dataset/rec_gt_train.txt`
   - `bubble_single_line_rec_dataset/rec_gt_val.txt`
   - `bubble_single_line_rec_dataset/rec_gt_test.txt`
   - `bubble_single_line_rec_dataset/line_manifest.jsonl`
   - `bubble_single_line_rec_dataset/dataset_stats.json`

The generated label files use the PaddleOCR SimpleDataSet format:

```text
images/train/114.png<TAB>full bubble text
```

## Commands

Build:

```bat
build_image.bat
```

Create the Supabase-backed stitched-bubble recognition dataset only:

```bat
run_pipeline.bat
```

The Supabase bubble status defaults to `Valid\u00e9`. Override it with
`--status-value ...` or `PPOCR_BUBBLE_STATUS` only if the database enum changes.

Smoke test from the already-present local debug source and check the PP-OCRv6
model loader:

```bat
run_pipeline.bat --source-mode source_dir --limit 8 --dry-run-train --allow-training-blocked
```

Attempt the training launcher after dataset export:

```bat
run_pipeline.bat --skip-dataset --train --epochs 5
```

The default training profile is conservative for a 24 GB GPU:
`--batch-size 2 --grad-accum-steps 8 --image-width 640`, CUDA AMP enabled,
backbone frozen, and DataLoader workers/pinned memory off. Use
`--train-backbone`, larger `--batch-size`, or larger `--image-width` only when
you have headroom.

To push short sound effects, keep the corrected dataset and run:

```bat
run_pipeline.bat --skip-dataset --train --epochs 8 --short-oversample 4 --short-loss-weight 3
```

To push dialogue CER lower, use a wider input and unfreeze the backbone with a
small backbone learning rate:

```bat
run_pipeline.bat --skip-dataset --train --epochs 10 --batch-size 1 --grad-accum-steps 16 --image-width 960 --train-backbone --learning-rate 2e-5 --backbone-learning-rate 2e-6
```

For a second-stage polish after a good run, continue from the best checkpoint
with lower learning rates and cosine decay:

```bat
run_pipeline.bat --skip-dataset --train --auto-resume-best --epochs 6 --batch-size 1 --grad-accum-steps 16 --image-width 960 --train-backbone --learning-rate 8e-6 --backbone-learning-rate 8e-7 --lr-scheduler cosine --warmup-ratio 0.05 --short-oversample 2 --short-loss-weight 2
```

Training metrics include global CER plus `val_short_cer`, `val_medium_cer`,
and `val_dialogue_cer`.

Analyze validation errors after a run:

```bat
docker run --rm --gpus all --shm-size=4g --entrypoint python ^
  -v "%cd%\outputs:/workspace/outputs_paddleocr_line_rec" ^
  paddleocr-line-rec-finetune /app/analyze_val_errors.py --batch-size 1
```

This writes `outputs/val_error_analysis/summary.json`,
`outputs/val_error_analysis/predictions.csv`, and
`outputs/val_error_analysis/worst.html`.

## Training Outputs

The training script uses the Transformers
`PPOCRV6SmallRecForTextRecognition` class directly, optimizes CTC loss, and
writes:

- `training_metrics.json`
- `ppocrv6_medium_rec_line_finetune_best/`

Metrics include train loss, validation loss, validation CER, exact match, and
the number of samples filtered because their label is longer than the CTC output
sequence. Increase `--image-width` if too many stitched bubbles are filtered.

## ONNX Web Export

Export the best recognizer checkpoint for ONNX Runtime Web:

```bat
docker run --rm --entrypoint bash ^
  -v "%cd%:/app" ^
  paddleocr-line-rec-finetune:latest ^
  -lc "python /app/export_ppocrv6_onnx.py --model-dir /app/outputs/ppocrv6_medium_rec_line_finetune_best --output-dir /app/outputs/onnx_web_release --sample-image /app/outputs/bubble_single_line_rec_dataset/images/val --max-samples 8"
```

The browser package is published under:

`https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec/tree/main/onnx`

It contains:

- `bubble_line_detector_yolo26n.onnx`
- `ppocrv6_bubble_line_rec.onnx`
- `browser_manifest.json`
- `pipeline_manifest.json`

The frontend model key is `ppocrv6Line`. It runs entirely in the browser with
ONNX Runtime Web WASM: YOLO detects text lines inside the selected bubble, the
lines are stitched left-to-right, then PP-OCRv6 decodes the stitched image with
CTC.
