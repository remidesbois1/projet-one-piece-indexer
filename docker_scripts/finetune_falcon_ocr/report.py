"""Corpus OCR scores, page bootstrap and shareable, source-free analysis artifacts."""

import csv
import random
import textwrap
from collections import defaultdict
from pathlib import Path

from data import normalize, write_json


def edit_distance(a, b):
    try:
        from rapidfuzz.distance import Levenshtein

        return Levenshtein.distance(a, b)
    except ImportError:
        previous = list(range(len(b) + 1))
        for i, x in enumerate(a, 1):
            current = [i]
            for j, y in enumerate(b, 1):
                current.append(
                    min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (x != y))
                )
            previous = current
        return previous[-1]


def score_sample(row, prediction):
    reference, predicted = normalize(row["text"]), normalize(prediction["prediction"])
    return {
        "id": row["id"],
        "page_id": row["page_id"],
        "reference": row["text"],
        **prediction,
        "char_errors": edit_distance(reference, predicted),
        "chars": len(reference),
        "word_errors": edit_distance(reference.split(), predicted.split()),
        "words": len(reference.split()),
        "strict_char_errors": edit_distance(row["text"], prediction["prediction"]),
        "strict_chars": len(row["text"]),
        "exact": reference == predicted,
        "empty": not predicted,
        "width": row["width"],
        "height": row["height"],
    }


def aggregate(samples):
    if not samples:
        raise ValueError("Cannot score an empty evaluation")
    return {
        "samples": len(samples),
        "pages": len({s["page_id"] for s in samples}),
        "cer": sum(s["char_errors"] for s in samples)
        / max(1, sum(s["chars"] for s in samples)),
        "wer": sum(s["word_errors"] for s in samples)
        / max(1, sum(s["words"] for s in samples)),
        "strict_cer": sum(s["strict_char_errors"] for s in samples)
        / max(1, sum(s["strict_chars"] for s in samples)),
        "exact_match": sum(s["exact"] for s in samples) / len(samples),
        "empty_rate": sum(s["empty"] for s in samples) / len(samples),
        "token_limit_rate": sum(s["token_limit"] for s in samples) / len(samples),
    }


def page_bootstrap(samples, seed=42, iterations=1000):
    groups = defaultdict(lambda: [0, 0])
    for s in samples:
        groups[s["page_id"]][0] += s["char_errors"]
        groups[s["page_id"]][1] += s["chars"]
    values = list(groups.values())
    rng, draws = random.Random(seed), []
    for _ in range(iterations):
        sampled = rng.choices(values, k=len(values))
        draws.append(sum(x[0] for x in sampled) / max(1, sum(x[1] for x in sampled)))
    draws.sort()
    return {
        "low": draws[int(0.025 * iterations)],
        "high": draws[int(0.975 * iterations)],
        "unit": "page",
        "iterations": iterations,
    }


def write_benchmark(path, samples, model_label, elapsed):
    slices = {}
    for label, subset in {
        "1-8 characters": [s for s in samples if s["chars"] <= 8],
        "9-40 characters": [s for s in samples if 8 < s["chars"] <= 40],
        "41+ characters": [s for s in samples if s["chars"] > 40],
        "narrow/tall": [s for s in samples if s["height"] > 2 * s["width"]],
    }.items():
        if subset:
            slices[label] = aggregate(subset)
    report = {
        "model": model_label,
        "metrics": aggregate(samples),
        "cer_ci95": page_bootstrap(samples),
        "slices": slices,
        "seconds_including_preprocessing": elapsed,
        "images_per_second": len(samples) / max(elapsed, 1e-9),
        "normalization": "NFC + whitespace collapse; case, punctuation and accents retained",
        "samples": samples,
    }
    write_json(path, report)
    return report


def create_artifacts(directory, history, baseline, test, rows):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from PIL import Image

    directory = Path(directory)
    assets = directory / "analysis"
    assets.mkdir(exist_ok=True)
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "axes.spines.top": False,
            "axes.spines.right": False,
            "figure.facecolor": "#f7f8fc",
            "axes.facecolor": "#f7f8fc",
            "axes.titleweight": "bold",
        }
    )
    epochs = [h for h in history if "val_cer" in h]
    fig, axes = plt.subplots(1, 2, figsize=(12, 4), layout="constrained")
    axes[0].plot(
        [h["epoch"] for h in epochs], [h["loss"] for h in epochs], "o-", color="#5856d6"
    )
    axes[0].set(
        title="Training loss", xlabel="Epoch", ylabel="Mean cross entropy per bubble"
    )
    axes[1].plot(
        [h["epoch"] for h in epochs],
        [h["val_cer"] * 100 for h in epochs],
        "o-",
        color="#009c8c",
    )
    axes[1].set(title="Validation · generated text", xlabel="Epoch", ylabel="CER (%)")
    fig.savefig(assets / "training_curves.png", dpi=170)
    plt.close(fig)
    fig, axes = plt.subplots(1, 3, figsize=(13, 4), layout="constrained")
    for ax, metric, title in zip(
        axes, ["cer", "wer", "exact_match"], ["CER ↓", "WER ↓", "Exact match ↑"]
    ):
        ax.bar(
            ["Base", "Selected"],
            [baseline["metrics"][metric] * 100, test["metrics"][metric] * 100],
            color=["#aaaec4", "#5856d6"],
        )
        ax.set(title=title, ylabel="% · same held-out test")
    fig.savefig(assets / "test_comparison.png", dpi=170)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(9, 4), layout="constrained")
    ax.hist(
        [s["char_errors"] / max(1, s["chars"]) * 100 for s in test["samples"]],
        bins=30,
        color="#009c8c",
    )
    ax.set(
        title="Selected checkpoint · errors per bubble",
        xlabel="Sample CER (%)",
        ylabel="Bubbles",
    )
    fig.savefig(assets / "error_distribution.png", dpi=170)
    plt.close(fig)
    by_id = {row["id"]: row for row in rows}
    ranked = sorted(test["samples"], key=lambda s: (-s["char_errors"], s["id"]))
    examples = (
        ranked[:6]
        + sorted([s for s in ranked if s["exact"]], key=lambda s: s["id"])[:2]
    )
    for index, sample in enumerate(examples):
        fig, axes = plt.subplots(
            1,
            2,
            figsize=(11, 3.5),
            gridspec_kw={"width_ratios": [1, 2]},
            layout="constrained",
        )
        with Image.open(by_id[sample["id"]]["image_path"]) as image:
            axes[0].imshow(image.convert("RGB"))
        axes[0].axis("off")
        axes[1].axis("off")
        # wrap without truncation; expand figure for unusually long labels
        lines = (
            "REFERENCE\n"
            + textwrap.fill(sample["reference"], 65)
            + "\n\nPREDICTION\n"
            + textwrap.fill(sample["prediction"], 65)
        )
        fig.set_figheight(max(3.5, len(lines.splitlines()) * 0.22 + 0.7))
        axes[1].text(0, 0.98, lines, va="top", fontsize=10, transform=axes[1].transAxes)
        fig.suptitle(f"Selected checkpoint · {sample['char_errors']} character errors")
        fig.savefig(assets / f"example_{index + 1:02d}.png", dpi=160)
        plt.close(fig)
    with (directory / "predictions_test.csv").open(
        "w", encoding="utf-8", newline=""
    ) as stream:
        writer = csv.DictWriter(stream, fieldnames=list(test["samples"][0]))
        writer.writeheader()
        writer.writerows(test["samples"])


def model_card(config, summary, test, directory):
    final_scope = (
        "The root model was retrained from the base checkpoint on **100% of the exported corpus**. "
        "It has **no independent held-out score**. All test metrics and analysis images below describe "
        "the separate `evaluated/` checkpoint, before full-data retraining."
        if config.refit_all
        else "The root model is the selected checkpoint, evaluated on unseen test pages."
    )
    metrics = test["metrics"]
    card = f"""---
language:
- fr
license: apache-2.0
base_model: tiiuae/Falcon-OCR
library_name: transformers
pipeline_tag: image-to-text
tags:
- ocr
- manga
- poneglyph
- full-fine-tuning
---
# Falcon-OCR · Poneglyph

Recognition of French manga speech bubbles, fine-tuned on validated Poneglyph transcriptions.
Input: an already cropped bubble. Output: text. No layout detector is trained.

## Which model do the numbers describe?

{final_scope}

Selection uses validation CER only, with early stopping. Test pages are used once
after selection, for both the base model and selected checkpoint. Full-data retraining
uses the selected number of epochs and restarts from the base, with no further test-based selection.
This procedure does not guarantee that full-data retraining beats the evaluated checkpoint.

| Evaluated checkpoint · held-out test | Value |
| --- | ---: |
| CER | {metrics["cer"] * 100:.4f}% |
| Strict CER | {metrics["strict_cer"] * 100:.4f}% |
| WER | {metrics["wer"] * 100:.4f}% |
| Exact match | {metrics["exact_match"] * 100:.2f}% |
| Empty outputs | {metrics["empty_rate"] * 100:.2f}% |
| Generation cap reached | {metrics["token_limit_rate"] * 100:.2f}% |
| Test bubbles | {metrics["samples"]} |

CER is corpus edit distance divided by corpus reference length (not average sample CER).
Normalization is NFC and whitespace collapse; accents, punctuation and case are preserved.
`benchmark_test.json` includes a 95% bootstrap interval resampling whole pages,
length/shape slices, per-bubble predictions, and measured generation time.
The split is by page, with exact duplicate crops/pages grouped to avoid leakage.
Near-duplicate scans and different pages from the same series can remain related;
these results do not measure generalization to completely unseen series.

## Inference

```python
import torch
from PIL import Image
from transformers import AutoModelForCausalLM

model = AutoModelForCausalLM.from_pretrained(
    "{config.repo_id}", trust_remote_code=True,
    torch_dtype=torch.bfloat16,
).to("cuda").eval()
# Use subfolder="evaluated" to load the independently evaluated checkpoint.
texts = model.generate(Image.open("bubble.png").convert("RGB"),
                       category="plain", min_dimension={config.min_dimension},
                       max_dimension={config.max_dimension}, max_new_tokens={config.max_new_tokens})
print(texts[0])
```

The upstream generation method can round the token budget up to a block boundary.
The benchmark uses an exact cap. `inference.py` provides the benchmark-compatible
preprocessing (white padding for pathological aspect ratios), FP32 master weights
with BF16 autocast, and exact-cap decoding. Loading all weights directly in BF16
can introduce additional rounding differences.
Remote code is the pinned upstream revision `{config.revision}`; review it before use.

## Training

RTX 5090 profile: PyTorch 2.11 / CUDA 13, full parameter fine-tuning, FP32 master
weights and AdamW states, BF16 autocast, SDPA with differentiable attention sinks,
gradient checkpointing, cosine schedule, warmup and gradient clipping.
Only target text and its stop token are supervised; images and prompts are masked.
Loss is averaged per bubble. Conservative photometric augmentation applies only in training.
The inference-only Triton MLP is replaced by differentiable PyTorch during training.
Published weights retain the original Falcon architecture and inference code.

Exported corpus: **{summary["exported"]} bubbles**. Selected training duration:
**{summary["best_epoch"]} epochs**. See `run_summary.json`, `run_config.json`,
`dataset_report.json`, `environment.txt`, and `training_code/` for provenance.
Training data are validated annotations; empty references and invalid/missing crops
are listed in the export accounting. Download errors fail the run instead of silently dropping data.
Corpus snapshots and their assignment fingerprints are fixed on resume.

## Analysis of the evaluated checkpoint

![Training curves](analysis/training_curves.png)
![Base versus selected checkpoint on the same test](analysis/test_comparison.png)
![Error distribution](analysis/error_distribution.png)

Representative examples (largest absolute errors, followed by exact matches):

"""
    for path in sorted((Path(directory) / "analysis").glob("example_*.png")):
        card += f"![OCR example](analysis/{path.name})\n\n"
    card += "Model weights derive from [Falcon-OCR](https://huggingface.co/tiiuae/Falcon-OCR).\n"
    card += "Manga examples retain their respective owners' rights; the model license does not license the source images.\n"
    (Path(directory) / "README.md").write_text(card, encoding="utf-8")
