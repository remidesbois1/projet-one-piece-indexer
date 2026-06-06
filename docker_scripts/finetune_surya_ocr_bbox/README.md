---
license: openrail
language:
- fr
library_name: transformers
tags:
- surya
- qwen3_5
- vision-language-model
- ocr
- manga
- one-piece
- bbox-detection
- fine-tuned
base_model: datalab-to/surya-ocr-2
pipeline_tag: image-text-to-text
---

# Surya OCR 2 Poneglyph BBox Fine-Tune

This package mirrors the existing `finetune_lighton_ocr_bbox` flow, but swaps
the base model to `datalab-to/surya-ocr-2`.

Surya OCR 2 can return bboxes through its documented OCR, text-line detection,
and layout paths. This fine-tune uses the Hugging Face image-text-to-text model
and trains it to emit the Poneglyph page-level bbox contract:

```text
Bubble text [x1,y1,x2,y2]
```

Coordinates are normalized to `[0, 1000]`, matching the real LightOn bbox
dataset/export and benchmark scripts in this repo.

## What It Builds

- `surya_bbox_dataset/{train,val,test}/metadata.jsonl`
- resized full-page images under each split
- `outputs_surya_bbox/final_merged`
- `benchmark_surya_bbox.json`
- `benchmark_lighton_bbox.json`
- `comparison_lighton_bbox.json`
- HF-ready `README.md` generated into the final model folder

Default output repo:

```text
Remidesbois/surya-ocr-2-poneglyph-bbox
```

Default LightOn comparison repo:

```text
Remidesbois/LightonOCR-2-1b-poneglyph-bbox
```

## Run

```bash
python run_pipeline.py --dry-run --check-remote
python run_pipeline.py
```

Required env:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Optional env:

```text
HF_TOKEN
HF_REPO=Remidesbois/surya-ocr-2-poneglyph-bbox
SURYA_BBOX_TRAIN_BATCH=2
SURYA_BBOX_EVAL_BATCH=2
SURYA_BBOX_GRAD_ACCUM=4
SURYA_BBOX_DATALOADER_WORKERS=4
SURYA_BBOX_REQUIRE_UPLOAD=1
SURYA_BBOX_COMPARE_LIGHTON=1
SURYA_BBOX_REQUIRE_LIGHTON_COMPARISON=1
RUNPOD_API_KEY
RUNPOD_POD_ID
```

## Dataset Contract

The exporter reads Supabase table `bulles`, filters `statut = "Valid\u00e9"` by
default, groups annotations by page, resizes each full page to a 1540px longest
side, normalizes bboxes to `[0, 1000]`, and splits by `id_page`.

Target output example:

```text
Salut Luffy ! [102,85,312,206]
On y va ! [680,410,904,538]
```

## Training Contract

The trainer uses the same Surya/Qwen3.5 image-text path as
`finetune_surya_bubble_ocr`:

- `AutoProcessor`
- `AutoModelForImageTextToText`
- LoRA/DoRA by default
- prompt-only generation checks during validation
- held-out generation benchmark after merge
- EOS/PAD token normalization before generation

Default training knobs are set for a moderately used RTX 5090:

```text
SURYA_BBOX_TRAIN_BATCH=2
SURYA_BBOX_EVAL_BATCH=2
SURYA_BBOX_GRAD_ACCUM=4
SURYA_BBOX_DATALOADER_WORKERS=4
SURYA_BBOX_GEN_EVAL_MAX_SAMPLES=48
```

For a 24GB RTX 3090, use the safer profile:

```text
SURYA_BBOX_TRAIN_BATCH=1
SURYA_BBOX_EVAL_BATCH=1
SURYA_BBOX_GRAD_ACCUM=8
SURYA_BBOX_DATALOADER_WORKERS=2
SURYA_BBOX_GEN_EVAL_MAX_SAMPLES=32
```

## Benchmark Contract

The benchmark computes:

- CER / WER on bubbles matched at IoU 0.5
- mean and median IoU
- GIoU
- bbox area error
- precision / recall / F1 at IoU 0.3, 0.5, 0.75, and 0.9
- detection rate
- combined score
- average inference time

The same held-out pages are then evaluated with
`Remidesbois/LightonOCR-2-1b-poneglyph-bbox`, and the comparison is saved in
`comparison_lighton_bbox.json` for the generated Hugging Face README.

## Local Inference

```bash
python inference_bbox.py path/to/page.jpg --model-id outputs_surya_bbox/final_merged
```

It prints the raw generated contract, parses the bbox lines, and writes a JPEG
with drawn boxes.

## Docker

```bash
docker build -t remidesbois/surya-ocr-bbox-finetune:latest .
docker run --gpus all --env-file ../../.env ^
  -v "%cd%\surya_bbox_dataset:/workspace/surya_bbox_dataset" ^
  -v "%cd%\outputs_surya_bbox:/workspace/outputs_surya_bbox" ^
  remidesbois/surya-ocr-bbox-finetune:latest
```

## Notes

- This is not a crop OCR model. It consumes a full page and returns all bubble
  text plus bboxes.
- The generated text format is strict, but still model-generated. Downstream
  parsers must reject malformed lines.
- The LightOn comparison is only meaningful when both models run on the exact
  same exported test split.
