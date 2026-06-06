import json
import os
from pathlib import Path

from dotenv import load_dotenv


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

OUTPUT_DIR = Path(
    os.getenv("SURYA_BBOX_OUTPUT_DIR", str(SCRIPT_DIR / "outputs_surya_bbox"))
)
DATASET_DIR = Path(
    os.getenv("SURYA_BBOX_DATASET_DIR", str(SCRIPT_DIR / "surya_bbox_dataset"))
)
FINAL_DIR = OUTPUT_DIR / "final_merged"
HF_REPO = os.getenv("HF_REPO", "Remidesbois/surya-ocr-2-poneglyph-bbox")
BASE_MODEL = os.getenv("SURYA_BBOX_MODEL_ID", "datalab-to/surya-ocr-2")
LIGHTON_MODEL = os.getenv(
    "SURYA_BBOX_LIGHTON_BASELINE_MODEL_ID",
    "Remidesbois/LightonOCR-2-1b-poneglyph-bbox",
)
PROMPT = os.getenv(
    "SURYA_BBOX_USER_PROMPT",
    "Extrais le texte des bulles de cette page de manga dans l'ordre de lecture japonais, "
    "avec leurs bbox normalisees entre 0 et 1000. Format strict: Texte [x1,y1,x2,y2].",
)


def load_json(path: Path):
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def metrics_from_benchmark(path: Path):
    payload = load_json(path)
    if not payload:
        return None
    return payload.get("metrics")


def fmt_percent(metrics, key, inverse=False):
    if not metrics or key not in metrics:
        return "pending"
    value = metrics[key]
    if inverse:
        value = 1 - value
    return f"{value * 100:.2f}%"


def fmt_float(metrics, key, digits=3):
    if not metrics or key not in metrics:
        return "pending"
    return f"{metrics[key]:.{digits}f}"


def fmt_seconds(metrics, key):
    if not metrics or key not in metrics:
        return "pending"
    return f"{metrics[key]:.2f}s/page"


def winner_for(key, lower_better=False, surya=None, lighton=None):
    if not surya or not lighton or key not in surya or key not in lighton:
        return "pending"
    sv = surya[key]
    lv = lighton[key]
    if sv == lv:
        return "tie"
    if lower_better:
        return "Surya" if sv < lv else "LightOn"
    return "Surya" if sv > lv else "LightOn"


def comparison_table(surya, lighton):
    rows = [
        ("CER", "cer", True, fmt_percent),
        ("WER", "wer", True, fmt_percent),
        ("Mean IoU", "mean_iou", False, fmt_percent),
        ("Median IoU", "median_iou", False, fmt_percent),
        ("F1 @ IoU=0.5", "f1@0_5", False, fmt_percent),
        ("Precision @ 0.5", "precision@0_5", False, fmt_percent),
        ("Recall @ 0.5", "recall@0_5", False, fmt_percent),
        ("Detection Rate", "avg_detection_rate", False, fmt_percent),
        ("Combined Score", "combined_score", False, fmt_float),
        ("Avg Inference", "avg_inference_time", True, fmt_seconds),
    ]
    lines = [
        "| Metric | Surya OCR 2 fine-tuned | LightOn bbox Poneglyph | Winner |",
        "|:---|:---:|:---:|:---:|",
    ]
    for label, key, lower_better, formatter in rows:
        surya_value = formatter(surya, key)
        lighton_value = formatter(lighton, key)
        winner = winner_for(key, lower_better=lower_better, surya=surya, lighton=lighton)
        lines.append(f"| {label} | {surya_value} | {lighton_value} | {winner} |")
    return "\n".join(lines)


def dataset_table(report):
    if not report:
        return "| Split | Pages | Bubbles |\n|:---:|---:|---:|\n| train | pending | pending |\n| val | pending | pending |\n| test | pending | pending |"
    lines = ["| Split | Pages | Bubbles |", "|:---:|---:|---:|"]
    for split in ("train", "val", "test"):
        data = (report.get("splits") or {}).get(split, {})
        lines.append(f"| {split} | {data.get('pages', 'pending')} | {data.get('bubbles', 'pending')} |")
    return "\n".join(lines)


def readme_text():
    surya_metrics = metrics_from_benchmark(FINAL_DIR / "benchmark_surya_bbox.json")
    lighton_metrics = metrics_from_benchmark(FINAL_DIR / "benchmark_lighton_bbox.json")
    comparison = load_json(FINAL_DIR / "comparison_lighton_bbox.json")
    dataset_report = load_json(DATASET_DIR / "dataset_report.json")
    comparison_error = comparison.get("error") if comparison else None

    return f"""---
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
base_model: {BASE_MODEL}
pipeline_tag: image-text-to-text
---

<div align="center">

# {HF_REPO.split("/")[-1]}

**Surya OCR 2 fine-tuned for One Piece manga bubble text plus bounding boxes**

This model reads a full manga page and emits one line per dialogue bubble:

```text
Text content [x1,y1,x2,y2]
```

Coordinates are normalized to `[0, 1000]` on the resized page image.

</div>

---

## Why Surya For BBox

The upstream Surya OCR 2 card documents bbox-capable outputs in three relevant
paths:

- OCR output includes per-block `polygon`, axis-aligned `bbox`, confidence, and reading order.
- `surya_detect` returns text-line bboxes and polygons.
- `surya_layout` returns layout boxes, labels, reading order, and bbox values.

This fine-tune uses the Hugging Face `image-text-to-text` Surya OCR 2 model and
teaches the generated text stream to match the existing Poneglyph bbox contract.

---

## Benchmark: Surya vs LightOn BBox Poneglyph

{comparison_table(surya_metrics, lighton_metrics)}

{f"> LightOn comparison could not be completed during the last run: `{comparison_error}`" if comparison_error else ""}

---

## Surya Fine-Tuned Snapshot

| Metric | Score |
|:---|:---:|
| CER | {fmt_percent(surya_metrics, "cer")} |
| WER | {fmt_percent(surya_metrics, "wer")} |
| Mean IoU | {fmt_percent(surya_metrics, "mean_iou")} |
| Median IoU | {fmt_percent(surya_metrics, "median_iou")} |
| F1 @ IoU=0.3 | {fmt_percent(surya_metrics, "f1@0_3")} |
| F1 @ IoU=0.5 | {fmt_percent(surya_metrics, "f1@0_5")} |
| F1 @ IoU=0.75 | {fmt_percent(surya_metrics, "f1@0_75")} |
| Detection Rate | {fmt_percent(surya_metrics, "avg_detection_rate")} |
| Combined Score | {fmt_float(surya_metrics, "combined_score")} |
| Avg Inference | {fmt_seconds(surya_metrics, "avg_inference_time")} |

Combined score:

```text
0.4 * (1 - CER) + 0.3 * F1@0.5 + 0.2 * MeanIoU + 0.1 * DetectionRate
```

---

## Dataset

Source data comes from the Poneglyph Supabase `bulles` table, filtered to
validated annotations, grouped at page level, and split by `id_page` to prevent
page leakage.

{dataset_table(dataset_report)}

Preprocessing:

- Full page image resized to 1540px longest side.
- JPEG quality 95.
- Bubble boxes normalized to `[0, 1000]`.
- Target order follows the stored manga reading order.
- Target text uses one strict line per bubble.

---

## How To Use

```bash
pip install torch pillow transformers accelerate
```

```python
import re
import torch
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor

MODEL_ID = "{HF_REPO}"
PROMPT = {PROMPT!r}

processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL_ID,
    torch_dtype=torch.bfloat16,
    device_map="auto",
    trust_remote_code=True,
).eval()

image = Image.open("page.jpg").convert("RGB")
image.thumbnail((1540, 1540), Image.Resampling.LANCZOS)

messages = [
    {{
        "role": "user",
        "content": [
            {{"type": "image", "image": "page.jpg"}},
            {{"type": "text", "text": PROMPT}},
        ],
    }}
]

prompt = processor.apply_chat_template(
    messages,
    add_generation_prompt=True,
    tokenize=False,
)
inputs = processor(text=[prompt], images=[image], return_tensors="pt")
inputs = {{
    k: v.to(model.device, dtype=torch.bfloat16) if v.is_floating_point() else v.to(model.device)
    for k, v in inputs.items()
}}

with torch.inference_mode():
    output_ids = model.generate(**inputs, max_new_tokens=2048, do_sample=False)

generated = output_ids[0, inputs["input_ids"].shape[1]:]
text = processor.decode(generated, skip_special_tokens=True).strip()
print(text)

pattern = re.compile(r"(.+?)\\s*\\[(\\d+),(\\d+),(\\d+),(\\d+)\\]")
bubbles = [
    {{"text": m.group(1).strip(), "bbox": [int(m.group(i)) for i in range(2, 6)]}}
    for line in text.splitlines()
    if (m := pattern.match(line.strip()))
]
```

---

## Training

The training package used for this model lives in:

```text
docker_scripts/finetune_surya_ocr_bbox
```

Pipeline:

```bash
python run_pipeline.py --dry-run --check-remote
python run_pipeline.py
```

The run exports the dataset, fine-tunes Surya OCR 2 with LoRA/DoRA, benchmarks
the held-out test split, benchmarks `{LIGHTON_MODEL}` on the same pages, writes
this README, and uploads the final merged model when `HF_TOKEN` is available.

---

## Limitations

- Domain-specific: trained for One Piece manga pages.
- Text language: French annotations.
- Output is a generated text contract, so malformed lines are possible and should be parsed defensively.
- The model returns normalized bbox coordinates, not pixel coordinates.
- The LightOn comparison is only valid when both models are evaluated on the same exported test split.

---

## Base Model

Fine-tuned from [`{BASE_MODEL}`](https://huggingface.co/{BASE_MODEL}).
The base model uses Surya OCR 2 / Qwen3.5 image-text-to-text architecture.

---

*Fine-tuned by [Remidesbois](https://huggingface.co/Remidesbois).*
"""


def main():
    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    out_path = FINAL_DIR / "README.md"
    out_path.write_text(readme_text(), encoding="utf-8")
    print(f"Hugging Face README written to {out_path}", flush=True)


if __name__ == "__main__":
    main()
