---
license: apache-2.0
language:
- fr
library_name: transformers
tags:
- lighton_ocr
- vision-language-model
- ocr
- manga
- one-piece
- bbox-detection
- fine-tuned
base_model: lightonai/LightOnOCR-2-1B-bbox-base
pipeline_tag: image-text-to-text
---

<div align="center">

# LightOnOCR-2-1b-poneglyph-bbox

**Fine-tuned Manga Bubble OCR with Bounding Box Detection**

*A 1B parameter Vision-Language Model specialized in extracting dialogue text
and precise bounding boxes from One Piece manga pages.*

[![Model Size](https://img.shields.io/badge/Parameters-1B-blue)]()
[![License](https://img.shields.io/badge/License-Apache%202.0-green)]()
[![Base Model](https://img.shields.io/badge/Base-LightOnOCR--2--1B-orange)]()
[![Language](https://img.shields.io/badge/Language-French-red)]()

</div>

---

## Benchmark: LightOn (fine-tuned) vs Gemma 4 31B (one-shot API)

| Metric | LightOn (1B fine-tuned) | Gemma 4 31B (one-shot) | Winner |
|:---|:---:|:---:|:---:|
| **CER** | **0.34%** | 8.26% | LightOn |
| **WER** | **1.37%** | 12.65% | LightOn |
| **Mean IoU** | **75.98%** | 66.65% | LightOn |
| **Median IoU** | **77.10%** | 65.36% | LightOn |
| **F1 @ IoU=0.5** | **84.07%** | 41.13% | LightOn |
| **Precision @ 0.5** | **84.24%** | 41.84% | LightOn |
| **Recall @ 0.5** | **83.93%** | 40.62% | LightOn |
| **Detection Rate** | **99.32%** | 96.83% | LightOn |
| **Combined Score** | **0.902** | 0.720 | LightOn |
| **Avg Inference** | **6.99s** (local GPU) | **67.41s** (API) | LightOn |

> The 1B fine-tuned LightOnOCR model outperforms Gemma 4 31B on every metric, with 24x lower CER and 2x higher F1@0.5, while running 10x faster on local GPU.

---

## Performance Snapshot (LightOn fine-tuned)

| Metric | Score |
|:---|:---:|
| **Character Error Rate (CER)** | **0.34%** |
| **Word Error Rate (WER)** | **1.37%** |
| **Mean IoU** | **75.98%** |
| **Median IoU** | **77.10%** |
| **F1 @ IoU=0.3** | **93.92%** |
| **F1 @ IoU=0.5** | **84.07%** |
| **F1 @ IoU=0.75** | **47.19%** |
| **Detection Rate** | **99.32%** |
| **Combined Score** | **0.902** |
| **Avg Inference Time** | **6.99s** |

---

## What This Model Does

Given a manga page image, this model extracts:
- **Dialogue text** from each speech bubble
- **Bounding box coordinates** `[x1, y1, x2, y2]` normalized to `[0, 10000]`

**Input:** A manga page image (resized to 1540px longest side)

**Output:** One line per bubble in the format:
```
Text content [x1,y1,x2,y2]
```

---

## Detailed Metrics

### Text Recognition

| Metric | LightOn | Gemma 31B |
|:---|:---:|:---:|
| Character Error Rate (CER) | 0.34% | 8.26% |
| CER Median | 0.00% | 0.00% |
| Word Error Rate (WER) | 1.37% | 12.65% |

### Bounding Box Localization

| Metric | LightOn | Gemma 31B |
|:---|:---:|:---:|
| Mean IoU | 75.98% | 66.65% |
| Median IoU | 77.10% | 65.36% |
| IoU P25 | 68.49% | 57.82% |
| IoU P75 | 84.43% | 74.80% |
| IoU P90 | 89.26% | 81.32% |
| IoU P95 | 91.67% | 85.25% |
| Mean GIoU | 75.18% | 66.11% |
| BBox Area Error | 9.36% | 39.78% |

### Detection Performance

| Metric | LightOn | Gemma 31B |
|:---|:---:|:---:|
| Total GT Bubbles | 1,078 | 1,078 |
| Total Predicted Bubbles | 1,073 | 1,049 |
| Detection Rate | 99.32% | 96.83% |

### Precision / Recall / F1 at IoU Thresholds (LightOn)

| Threshold | Precision | Recall | F1 |
|:---:|:---:|:---:|:---:|
| IoU >= 0.3 | **94.14%** | 93.76% | **93.92%** |
| IoU >= 0.5 | **84.24%** | 83.93% | **84.07%** |
| IoU >= 0.75 | **47.29%** | 47.10% | **47.19%** |
| IoU >= 0.9 | **7.15%** | 7.13% | **7.14%** |

### Combined Score

```
Combined = 0.4 x (1 - CER) + 0.3 x F1@0.5 + 0.2 x Mean_IoU + 0.1 x Detection_Rate
```

**LightOn: 0.902** / 1.0 | **Gemma 31B: 0.720** / 1.0

---

## Benchmark Visualizations

### Performance Overview

![Metrics Overview](test/output/graphs/metrics_overview.png)

### IoU Distribution

![IoU Distribution](test/output/graphs/iou_distribution.png)

### Cumulative IoU

![Cumulative IoU](test/output/graphs/iou_cumulative.png)

### IoU Box Plot

![IoU Boxplot](test/output/graphs/iou_boxplot.png)

### Precision / Recall / F1 at Thresholds

![F1 at Thresholds](test/output/graphs/f1_at_thresholds.png)

### CER Distribution

![CER Distribution](test/output/graphs/cer_distribution.png)

### Per-Sample IoU (Sorted)

![Per-Sample IoU](test/output/graphs/per_sample_iou_sorted.png)

### Bubble Count Accuracy

![Bubble Count](test/output/graphs/bubble_count_scatter.png)

### BBox Area Error

![BBox Area Error](test/output/graphs/bbox_area_error.png)

### Summary Card

![Summary Card](test/output/graphs/summary_card.png)

### Sample Predictions

| LightOn (fine-tuned) | Gemma 4 31B (one-shot) |
|:---:|:---:|
| ![LightOn Sample 0](test/output/samples/sample_0_lighton.png) | ![Gemma Sample 0](test/output/samples/sample_0_gemma.png) |
| ![LightOn Sample 1](test/output/samples/sample_1_lighton.png) | ![Gemma Sample 1](test/output/samples/sample_1_gemma.png) |

---

## Dataset

### Source
Training data sourced from a curated Supabase database of **One Piece manga pages** with human-validated bubble annotations.

### Composition

| Split | Pages | Bubbles |
|:---:|:---:|:---:|
| Train | 430 | ~4,027 |
| Test | 112 | 1,078 |
| **Total** | **542** | **~5,105** |

### Preprocessing
- **Image resize:** Longest side -> 1540px (LANCZOS)
- **Format:** JPEG, quality 95
- **BBox normalization:** Coordinates normalized to `[0, 10000]` range
- **Bubble ordering:** Sorted by manga reading order
- **Split:** 80/20 train/test, seed 42

### Prompt Format
```
User:     "Extrais le texte et les coordonnées des bulles de cette page de manga."
Assistant: "Text bubble 1 [x1,y1,x2,y2]\nText bubble 2 [x1,y1,x2,y2]\n..."
```

---

## Training Details

### Base Model
[**lightonai/LightOnOCR-2-1B-bbox-base**](https://huggingface.co/lightonai/LightOnOCR-2-1B-bbox-base) - A 1B parameter end-to-end multilingual VLM for OCR with bounding box support.

### LoRA Configuration

| Parameter | Value |
|:---|:---|
| LoRA Rank (r) | 32 |
| LoRA Alpha | 64 |
| LoRA Dropout | 0.03 |
| Target Modules | q_proj, v_proj, k_proj, o_proj, gate_proj, up_proj, down_proj |
| Bias | none |
| Task Type | CAUSAL_LM |

### Hyperparameters

| Parameter | Value |
|:---|:---|
| Learning Rate | 5e-5 |
| Scheduler | Cosine |
| Warmup Ratio | 0.10 |
| Weight Decay | 0.01 |
| Optimizer | paged_adamw_8bit |
| Epochs | 25 |
| Batch Size | 1 (grad accum: 8) |
| Precision | BF16 |
| Gradient Checkpointing | Yes |
| Eval Strategy | Steps (every 50) |
| Save Strategy | Steps (every 50, best 3) |
| Best Model Metric | eval_loss |

### Hardware
Trained on a cloud GPU via RunPod, automated with Docker.

---

## How to Use

### Installation

```bash
pip install transformers torch pillow
```

### Inference

```python
import torch
import re
from PIL import Image
from transformers import LightOnOcrProcessor, LightOnOcrForConditionalGeneration

MODEL_ID = "Remidesbois/LightonOCR-2-1b-poneglyph-bbox"

processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
processor.image_processor.default_to_square = False

model = LightOnOcrForConditionalGeneration.from_pretrained(
    MODEL_ID, torch_dtype=torch.bfloat16, device_map="auto"
)

image = Image.open("your_manga_page.jpg").convert("RGB")
image.thumbnail((1540, 1540), Image.Resampling.LANCZOS)

messages = [
    {
        "role": "user",
        "content": [
            {"type": "image", "url": "your_manga_page.jpg"},
            {"type": "text", "text": "Extrais le texte et les coordonnées des bulles de cette page de manga."}
        ]
    }
]

inputs = processor.apply_chat_template(
    messages, add_generation_prompt=True,
    tokenize=True, return_dict=True, return_tensors="pt",
)
inputs = {
    k: v.to(model.device) for k, v in inputs.items()
}

with torch.no_grad():
    output_ids = model.generate(**inputs, max_new_tokens=2048, do_sample=False)

gen_ids = output_ids[0, inputs["input_ids"].shape[1]:]
output = processor.decode(gen_ids, skip_special_tokens=True).strip()

print(output)
# Salut ! [1234,4567,8901,3456]
# Je suis Luffy ! [2345,5678,9012,4321]
```

### Drawing Bounding Boxes

```python
from PIL import ImageDraw

w, h = image.size
draw = ImageDraw.Draw(image)

for line in output.split("\n"):
    match = re.match(r'(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]', line.strip())
    if match:
        text = match.group(1)
        x1 = int(match.group(2)) * w // 10000
        y1 = int(match.group(3)) * h // 10000
        x2 = int(match.group(4)) * w // 10000
        y2 = int(match.group(5)) * h // 10000
        draw.rectangle([x1, y1, x2, y2], outline="red", width=2)

image.save("result.jpg")
```

---

## Architecture

```
+-------------------------------------+
|         Input: Manga Page           |
|         (<= 1540px, RGB)            |
+------------------+------------------+
                   |
          +--------v--------+
          |  LightOnOCR      |
          |  Vision Encoder  |
          +--------+--------+
                   |
          +--------v--------+
          |  Language Model  |
          |  (Mistral 1B)    |
          |  + LoRA Adapters |
          +--------+--------+
                   |
          +--------v------------------+
          |  Output (per line):       |
          |  "Text [x1,y1,x2,y2]"    |
          +---------------------------+
```

---

## Limitations

- **Domain-specific:** Trained exclusively on One Piece manga. Performance on other manga styles may vary.
- **Language:** Fine-tuned on French translations.
- **BBox precision:** F1@0.3 is excellent (94%), but very strict IoU thresholds (>=0.9) remain challenging.
- **Single-page input:** One manga page at a time.

---

## Benchmark Reproducibility

All results are fully reproducible. The benchmark suite is in `test/`:

```
test/
+-- download_dataset.py     # Download test dataset
+-- benchmark.py            # Run evaluation (LightOn + Gemma in parallel)
+-- generate_graphs.py      # Generate charts
+-- run_all.py              # Full pipeline
+-- upload_to_hf.py         # Upload results to HuggingFace
+-- output/
    +-- metrics.json        # LightOn metrics
    +-- metrics_gemma.json  # Gemma metrics
    +-- metrics_comparison.json  # Side-by-side comparison
    +-- graphs/             # PNG charts
    +-- samples/            # Visual predictions (both models)
```

To reproduce:
```bash
cd test
python run_all.py
```

**Requirements:** CUDA GPU (~4GB VRAM), `GEMMA_API_KEY` in `.env` for Gemma comparison, dependencies in `requirements.txt`.

---

## Base Model & Citation

Fine-tuned from **LightOnOCR-2-1B-bbox** by LightOn (Apache 2.0).

```bibtex
@misc{lightonocr2_2026,
  title        = {LightOnOCR: A 1B End-to-End Multilingual Vision-Language Model for State-of-the-Art OCR},
  author       = {Said Taghadouini and Adrien Cavaill\`{e}s and Baptiste Aubertin},
  year         = {2026},
  howpublished = {\url{https://arxiv.org/abs/2601.14251}}
}
```

---

## License

Apache 2.0. The fine-tuned weights inherit the license of the base model [lightonai/LightOnOCR-2-1B-bbox-base](https://huggingface.co/lightonai/LightOnOCR-2-1B-bbox-base).

---

<div align="center">

*Fine-tuned by [Remidesbois](https://huggingface.co/Remidesbois)*

</div>
