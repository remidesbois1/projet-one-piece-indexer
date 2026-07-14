"""RTX 5090 fine-tuning entrypoint for full-page LightOnOCR bbox OCR.

The optimized crop trainer owns the shared SFT machinery (single-pass collator,
rsLoRA, safe auto-batching, epoch evaluation, hard-example replay and guarded
promotion).  This module configures it for 1500 px pages and replaces the text
benchmark with bbox-aware metrics.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import jiwer
from Levenshtein import distance as levenshtein_distance


SCRIPT_DIR = Path(__file__).resolve().parent
ENGINE_IN_CONTAINER = SCRIPT_DIR / "lighton_crop_engine.py"
ENGINE_IN_REPO = SCRIPT_DIR.parent / "finetune_lighton_ocr" / "train_lighton_ocr.py"


def _load_engine():
    engine_path = ENGINE_IN_CONTAINER if ENGINE_IN_CONTAINER.exists() else ENGINE_IN_REPO
    spec = importlib.util.spec_from_file_location("lighton_bbox_training_engine", engine_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load shared LightOn training engine: {engine_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


engine = _load_engine()
_shared_process_batch = engine.process_batch
_shared_prepare_dataset = engine.prepare_dataset

MODEL_ID = os.getenv("LIGHTON_MODEL_ID", "lightonai/LightOnOCR-2-1B-bbox-base")
BASE_PATH = Path(os.getenv("LIGHTON_BBOX_DATASET_DIR", SCRIPT_DIR / "lighton_bbox_dataset"))
OUTPUT_DIR = Path(os.getenv("LIGHTON_BBOX_OUTPUT_DIR", SCRIPT_DIR / "outputs_lighton_bbox"))
IMAGE_LONGEST_EDGE = 1500
BBOX_PATTERN = re.compile(
    r"^\s*(.*?)\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*$"
)


def process_bbox_batch(examples, processor, image_longest_edge=None):
    """Keep full multimodal context but project logits only for assistant tokens.

    Causal loss at position ``s`` is predicted by the logit at ``s - 1``, hence
    the one-token look-behind. This is mathematically equivalent to the full
    loss because every earlier label is already -100.
    """
    inputs = _shared_process_batch(examples, processor, image_longest_edge)
    if not engine.env_bool("LIGHTON_BBOX_SELECTIVE_LOGITS", True):
        return inputs
    labels = inputs["labels"]
    valid_positions = (labels != -100).nonzero(as_tuple=False)
    if valid_positions.numel() == 0:
        return inputs
    first_assistant = int(valid_positions[:, 1].min().item())
    slice_start = max(0, first_assistant - 1)
    logits_to_keep = labels.shape[1] - slice_start
    inputs["labels"] = labels[:, slice_start:]
    inputs["logits_to_keep"] = logits_to_keep
    return inputs

# Full pages need smaller physical batches than bubble crops.  The RTX 5090
# profile optimizes for throughput: native backward first, then checkpointing
# only as a memory fallback.  ``rtx3090`` remains available for reproducibility.
HARDWARE_PROFILE = os.getenv("LIGHTON_HARDWARE_PROFILE", "rtx5090").strip().lower()
os.environ.setdefault("LIGHTON_IMAGE_LONGEST_EDGE", str(IMAGE_LONGEST_EDGE))
if HARDWARE_PROFILE == "rtx3090":
    os.environ.setdefault("LIGHTON_BATCH_CANDIDATES", "1,2,4")
    os.environ.setdefault("LIGHTON_EFFECTIVE_BATCH", "8")
    os.environ.setdefault("LIGHTON_CALIBRATION_REQUIRE_CHECKPOINTING", "1")
    os.environ.setdefault("LIGHTON_EVAL_BATCH", "1")
    os.environ.setdefault("LIGHTON_GENERATION_BATCH", "1")
    os.environ.setdefault("LIGHTON_PROFILE_FILENAME", "3090_profile.json")
elif HARDWARE_PROFILE == "h200":
    os.environ.setdefault("LIGHTON_BATCH_CANDIDATES", "1,2,4,8,16,32")
    # Keep the same effective batch as 3090/5090 for comparable optimization
    # dynamics; H200 should reach it with one large physical batch.
    os.environ.setdefault("LIGHTON_EFFECTIVE_BATCH", "8")
    os.environ.setdefault("LIGHTON_CALIBRATION_REQUIRE_CHECKPOINTING", "0")
    os.environ.setdefault("LIGHTON_CALIBRATION_MAX_VRAM_RATIO", "0.90")
    os.environ.setdefault("LIGHTON_EVAL_BATCH", "8")
    os.environ.setdefault("LIGHTON_GENERATION_BATCH", "8")
    os.environ.setdefault("LIGHTON_PROFILE_FILENAME", "h200_profile.json")
    os.environ.setdefault("LIGHTON_DATALOADER_WORKERS", "8")
    os.environ.setdefault("LIGHTON_DATALOADER_PREFETCH_FACTOR", "4")
else:
    os.environ.setdefault("LIGHTON_BATCH_CANDIDATES", "1,2,4,8")
    os.environ.setdefault("LIGHTON_EFFECTIVE_BATCH", "8")
    os.environ.setdefault("LIGHTON_CALIBRATION_REQUIRE_CHECKPOINTING", "0")
    os.environ.setdefault("LIGHTON_CALIBRATION_MAX_VRAM_RATIO", "0.90")
    os.environ.setdefault("LIGHTON_EVAL_BATCH", "2")
    os.environ.setdefault("LIGHTON_GENERATION_BATCH", "2")
    os.environ.setdefault("LIGHTON_PROFILE_FILENAME", "5090_profile.json")
os.environ.setdefault("LIGHTON_GEN_EVAL_MAX_SAMPLES", "100")
os.environ.setdefault("LIGHTON_DATALOADER_WORKERS", "4")
os.environ.setdefault("LIGHTON_DATALOADER_PREFETCH_FACTOR", "4")
os.environ.setdefault("LIGHTON_GROUP_BY_LENGTH", "1")
os.environ.setdefault("LIGHTON_LENGTH_COLUMN", "length")
os.environ.setdefault("LIGHTON_TASK_LABEL", f"LightOnOCR bbox OCR ({HARDWARE_PROFILE.upper()})")
os.environ.setdefault("LIGHTON_MAX_NEW_TOKENS", "2048")
os.environ.setdefault("LIGHTON_MAX_SEQUENCE_LENGTH", "4096")
os.environ.setdefault("LIGHTON_EPOCHS", "3")
os.environ.setdefault("LIGHTON_EARLY_STOPPING_PATIENCE", "2")
os.environ.setdefault("LIGHTON_LR", "1e-5")
os.environ.setdefault("LIGHTON_LORA_R", "64")
os.environ.setdefault("LIGHTON_LORA_ALPHA", "128")
os.environ.setdefault("LIGHTON_USE_RSLORA", "1")
os.environ.setdefault("LIGHTON_USE_DORA", "0")
os.environ.setdefault("LIGHTON_LORA_LM_HEAD", "0")


def _page_training_cost(example):
    """Cheap ordering proxy for image tokens plus assistant text tokens."""
    size = example.get("resized_size") or example.get("original_size") or [1500, 1500]
    try:
        width, height = max(1, int(size[0])), max(1, int(size[1]))
    except (TypeError, ValueError, IndexError):
        width, height = 1500, 1500
    text_chars = 0
    for message in example.get("messages") or []:
        if message.get("role") != "assistant":
            continue
        for item in message.get("content") or []:
            text_chars += len(str(item.get("text", "")))
    return max(1, ((width + 15) // 16) * ((height + 15) // 16) + text_chars // 3)


def prepare_bbox_dataset(file_path, split_name):
    dataset = _shared_prepare_dataset(file_path, split_name)
    if "length" not in dataset.column_names:
        dataset = dataset.map(lambda example: {"length": _page_training_cost(example)})
    return dataset


def parse_bbox_output(text):
    items = []
    invalid_lines = 0
    for line in str(text or "").splitlines():
        if not line.strip():
            continue
        match = BBOX_PATTERN.match(line)
        if not match:
            invalid_lines += 1
            continue
        raw_coords = [int(match.group(i)) for i in range(2, 6)]
        coords = [max(0, min(1000, value)) for value in raw_coords]
        if coords != raw_coords:
            invalid_lines += 1
        x1, y1, x2, y2 = coords
        if x2 <= x1 or y2 <= y1:
            invalid_lines += 1
            continue
        items.append({"text": match.group(1).strip(), "bbox": coords})
    return items, invalid_lines


def compute_iou(box_a, box_b):
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])
    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = max(0, box_a[2] - box_a[0]) * max(0, box_a[3] - box_a[1])
    area_b = max(0, box_b[2] - box_b[0]) * max(0, box_b[3] - box_b[1])
    union = area_a + area_b - intersection
    return intersection / union if union else 0.0


def match_predictions(predictions, references, threshold=0.5):
    candidates = []
    for pred_idx, prediction in enumerate(predictions):
        for ref_idx, reference in enumerate(references):
            iou = compute_iou(prediction["bbox"], reference["bbox"])
            if iou >= threshold:
                candidates.append((iou, pred_idx, ref_idx))
    candidates.sort(reverse=True)
    used_predictions = set()
    used_references = set()
    matches = []
    for iou, pred_idx, ref_idx in candidates:
        if pred_idx in used_predictions or ref_idx in used_references:
            continue
        used_predictions.add(pred_idx)
        used_references.add(ref_idx)
        matches.append((pred_idx, ref_idx, iou))
    unmatched_predictions = [i for i in range(len(predictions)) if i not in used_predictions]
    unmatched_references = [i for i in range(len(references)) if i not in used_references]
    return matches, unmatched_predictions, unmatched_references


def _word_count(text):
    return len(str(text).split())


def score_page(prediction_text, reference_text):
    predictions, invalid_lines = parse_bbox_output(prediction_text)
    references, invalid_reference_lines = parse_bbox_output(reference_text)
    matches, unmatched_predictions, unmatched_references = match_predictions(
        predictions, references
    )

    char_edits = 0
    reference_chars = 0
    word_edits = 0
    reference_words = 0
    exact_text_matches = 0
    ious = []
    matched_cers = []
    matched_wers = []
    for pred_idx, ref_idx, iou in matches:
        predicted = predictions[pred_idx]["text"]
        reference = references[ref_idx]["text"]
        char_edits += levenshtein_distance(predicted, reference)
        matched_cers.append(
            levenshtein_distance(predicted, reference) / max(len(reference), 1)
        )
        matched_wers.append(jiwer.wer(reference, predicted))
        reference_chars += len(reference)
        word_edits += int(round(jiwer.wer(reference, predicted) * max(_word_count(reference), 1)))
        reference_words += max(_word_count(reference), 1)
        exact_text_matches += int(predicted == reference)
        ious.append(iou)
    for ref_idx in unmatched_references:
        reference = references[ref_idx]["text"]
        char_edits += len(reference)
        reference_chars += len(reference)
        words = max(_word_count(reference), 1)
        word_edits += words
        reference_words += words
    for pred_idx in unmatched_predictions:
        predicted = predictions[pred_idx]["text"]
        char_edits += len(predicted)
        word_edits += max(_word_count(predicted), 1)

    true_positives = len(matches)
    false_positives = len(unmatched_predictions)
    false_negatives = len(unmatched_references)
    precision = true_positives / max(true_positives + false_positives, 1)
    recall = true_positives / max(true_positives + false_negatives, 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-12)
    cer = char_edits / max(reference_chars, 1)
    page_exact = (
        not unmatched_predictions
        and not unmatched_references
        and invalid_lines == 0
        and invalid_reference_lines == 0
        and exact_text_matches == len(references)
        and len(matches) == len(references)
    )
    return {
        "cer": sum(matched_cers) / len(matched_cers) if matched_cers else 1.0,
        "historical_wer": sum(matched_wers) / len(matched_wers) if matched_wers else 1.0,
        "strict_cer": cer,
        "char_edits": char_edits,
        "reference_chars": reference_chars,
        "word_edits": word_edits,
        "reference_words": reference_words,
        "true_positives": true_positives,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
        "precision_50": precision,
        "recall_50": recall,
        "f1_50": f1,
        "mean_iou": sum(ious) / max(len(ious), 1),
        "matched_iou_sum": sum(ious),
        "matched_text_exact": exact_text_matches,
        "page_exact": page_exact,
        "historical_exact": str(prediction_text).strip() == str(reference_text).strip(),
        "detection_rate": min(len(predictions), len(references)) / max(len(references), 1),
        "invalid_lines": invalid_lines,
        "gt_count": len(references),
        "prediction_count": len(predictions),
    }


def aggregate_samples(samples):
    totals = {
        key: sum(sample.get(key, 0) for sample in samples)
        for key in (
            "char_edits",
            "reference_chars",
            "word_edits",
            "reference_words",
            "true_positives",
            "false_positives",
            "false_negatives",
            "matched_iou_sum",
            "invalid_lines",
        )
    }
    tp = totals["true_positives"]
    fp = totals["false_positives"]
    fn = totals["false_negatives"]
    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-12)
    strict_cer = totals["char_edits"] / max(totals["reference_chars"], 1)
    historical_cer = sum(sample["cer"] for sample in samples) / max(len(samples), 1)
    historical_wer = sum(sample["historical_wer"] for sample in samples) / max(len(samples), 1)
    exact = sum(bool(sample.get("historical_exact")) for sample in samples) / max(len(samples), 1)
    strict_exact = sum(bool(sample.get("page_exact")) for sample in samples) / max(len(samples), 1)
    mean_precision = sum(sample["precision_50"] for sample in samples) / max(len(samples), 1)
    mean_recall = sum(sample["recall_50"] for sample in samples) / max(len(samples), 1)
    mean_f1 = sum(sample["f1_50"] for sample in samples) / max(len(samples), 1)
    detection_rate = sum(sample["detection_rate"] for sample in samples) / max(len(samples), 1)
    metrics = {
        "cer": historical_cer,
        "wer": historical_wer,
        "exact_match": exact,
        "precision_50": mean_precision,
        "recall_50": mean_recall,
        "f1_50": mean_f1,
        "mean_iou": totals["matched_iou_sum"] / max(tp, 1),
        "detection_rate": detection_rate,
        "invalid_line_rate": totals["invalid_lines"] / max(
            sum(sample.get("prediction_count", 0) + sample.get("invalid_lines", 0) for sample in samples),
            1,
        ),
        "combined_score": (
            0.4 * max(0.0, 1.0 - historical_cer)
            + 0.3 * mean_f1
            + 0.2 * (totals["matched_iou_sum"] / max(tp, 1))
            + 0.1 * detection_rate
        ),
        "page_count": len(samples),
        "gt_box_count": tp + fn,
        "pred_box_count": tp + fp,
    }
    metrics["strict"] = {
        "cer": strict_cer,
        "wer": totals["word_edits"] / max(totals["reference_words"], 1),
        "exact_match": strict_exact,
        "precision_50": precision,
        "recall_50": recall,
        "f1_50": f1,
    }
    return metrics


def run_bbox_benchmark(
    model,
    processor,
    dataset,
    split_name,
    max_samples=None,
    title="BBOX GENERATION BENCHMARK",
    worst_count=5,
    batch_size=None,
    image_longest_edge=None,
):
    was_training = model.training
    old_use_cache = getattr(model.config, "use_cache", None)
    if old_use_cache is not None:
        model.config.use_cache = True
    model.eval()
    indices = engine.benchmark_indices(dataset, max_samples)
    samples = []
    generation_seconds = 0.0
    batch_size = batch_size or int(os.getenv("LIGHTON_GENERATION_BATCH", "1"))
    print(f"\n{'=' * 70}\n {title} [{split_name}] - {len(indices)}/{len(dataset)} pages\n{'=' * 70}", flush=True)
    processed = 0
    for page_indices in engine.inference_batches(dataset, indices, batch_size):
        entries = [dataset[index] for index in page_indices]
        predictions, metas, elapsed = engine.generate_predictions(
            model,
            processor,
            entries,
            image_longest_edge=IMAGE_LONGEST_EDGE,
        )
        generation_seconds += elapsed
        for index, entry, prediction, meta in zip(page_indices, entries, predictions, metas):
            reference = engine.extract_reference_text(entry)
            score = score_page(prediction, reference)
            samples.append(
                {
                    "dataset_idx": index,
                    "id": entry.get("id") or entry.get("page_id"),
                    "page_id": entry.get("page_id"),
                    "reference": reference,
                    "prediction": prediction.strip(),
                    "strict_prediction": prediction.strip(),
                    "raw_prediction": prediction,
                    **score,
                    **meta,
                }
            )
        processed += len(page_indices)
        print(f"  generated {processed}/{len(indices)}", flush=True)
    metrics = aggregate_samples(samples)
    metrics["generation_seconds"] = generation_seconds
    metrics["samples_per_second"] = len(samples) / max(generation_seconds, 1e-9)
    ranked = sorted(samples, key=lambda sample: (sample["strict_cer"], -sample["f1_50"]), reverse=True)
    print(
        f" CER={metrics['cer']:.6f} | F1@0.5={metrics['f1_50']:.6f} | "
        f"mIoU={metrics['mean_iou']:.6f} | exact pages={metrics['exact_match']:.6f}",
        flush=True,
    )
    for rank, sample in enumerate(ranked[: min(worst_count, len(ranked))], 1):
        print(
            f"  #{rank} page={sample['page_id']} CER={sample['strict_cer']:.3f} "
            f"F1={sample['f1_50']:.3f} GT={sample['gt_count']} pred={sample['prediction_count']}",
            flush=True,
        )
    if old_use_cache is not None:
        model.config.use_cache = old_use_cache
    if was_training:
        model.train()
    return metrics, samples


def compare_bbox_baseline(samples):
    payload, source = engine.load_baseline_benchmark()
    if not payload:
        return {"available": False, "source": source, "shared_sample_count": 0}
    raw_metrics = payload.get("metrics") or payload
    baseline_metrics = {
        "cer": raw_metrics.get("cer"),
        "wer": raw_metrics.get("wer"),
        "f1_50": raw_metrics.get("f1_50", raw_metrics.get("f1@0_5")),
        "mean_iou": raw_metrics.get("mean_iou"),
        "exact_match": raw_metrics.get(
            "exact_match", raw_metrics.get("exact_match_rate", 0.0)
        ),
        "combined_score": raw_metrics.get("combined_score"),
        "page_count": raw_metrics.get("page_count", raw_metrics.get("num_samples")),
    }
    baseline_by_id = {
        str(sample.get("id") or sample.get("page_id")): sample
        for sample in payload.get("samples", [])
    }
    current_by_id = {str(sample.get("id") or sample.get("page_id")): sample for sample in samples}
    shared = sorted(set(current_by_id) & set(baseline_by_id))
    improvements = []
    for sample_id in shared:
        current = current_by_id[sample_id]
        baseline = baseline_by_id[sample_id]
        if "strict_cer" not in baseline:
            baseline = {**baseline, **score_page(baseline.get("raw_prediction", ""), current["reference"])}
        improvements.append(float(baseline.get("strict_cer", 1.0)) - float(current["strict_cer"]))
    # Deterministic paired page bootstrap. Positive deltas favour the candidate.
    rng = engine.random.Random(engine.RANDOM_SEED)
    means = []
    iterations = int(os.getenv("LIGHTON_BOOTSTRAP_ITERATIONS", "2000"))
    if improvements:
        for _ in range(iterations):
            draw = [improvements[rng.randrange(len(improvements))] for _ in improvements]
            means.append(sum(draw) / len(draw))
        means.sort()
    low = means[int(0.025 * (len(means) - 1))] if means else None
    high = means[int(0.975 * (len(means) - 1))] if means else None
    return {
        "available": bool(shared),
        "source": source,
        "shared_sample_count": len(shared),
        "baseline_metrics": baseline_metrics,
        "published_metrics_available": baseline_metrics["cer"] is not None,
        "paired_cer_improvement_ci95": [low, high] if means else None,
        "statistically_better": bool(means and low > 0),
    }


def bbox_quality_gate(metrics, comparison, training_seconds=None):
    baseline_metrics = comparison.get("baseline_metrics") or {}
    baseline_cer = float(baseline_metrics.get("cer") or 1.0)
    baseline_f1 = float(baseline_metrics.get("f1_50") or 0.0)
    baseline_exact = float(baseline_metrics.get("exact_match") or 0.0)
    baseline_seconds = float(os.getenv("LIGHTON_BASELINE_TRAIN_SECONDS", "0") or 0)
    required_pages = int(os.getenv("LIGHTON_REQUIRED_BASELINE_SAMPLES", "112"))
    quality_pass = (
        comparison.get("available", False)
        and comparison.get("shared_sample_count", 0) >= required_pages
        and comparison.get("statistically_better", False)
        and metrics["cer"] < baseline_cer
        and metrics["f1_50"] >= baseline_f1
        and metrics["exact_match"] >= baseline_exact
    )
    speed_pass = bool(training_seconds is not None and baseline_seconds > 0 and training_seconds < baseline_seconds)
    if engine.env_bool("LIGHTON_ALLOW_MISSING_SPEED_BASELINE", False) and baseline_seconds <= 0:
        speed_pass = True
    return {
        "release_ready": quality_pass and speed_pass,
        "quality_pass": quality_pass,
        "speed_pass": speed_pass,
        "cer": metrics["cer"],
        "f1_50": metrics["f1_50"],
        "mean_iou": metrics["mean_iou"],
        "exact_match": metrics["exact_match"],
        "baseline_cer": baseline_cer if comparison.get("available") else None,
        "baseline_f1_50": baseline_f1 if comparison.get("available") else None,
        "baseline_exact_match": baseline_exact if comparison.get("available") else None,
        "training_seconds": training_seconds,
        "baseline_training_seconds": baseline_seconds or None,
        "comparison": comparison,
    }


def save_bbox_benchmark(path, metrics, samples, training_seconds=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    comparison = compare_bbox_baseline(samples)
    gate = bbox_quality_gate(metrics, comparison, training_seconds)
    payload = {
        "model_id": MODEL_ID,
        "image_longest_edge": IMAGE_LONGEST_EDGE,
        "max_new_tokens": int(os.getenv("LIGHTON_MAX_NEW_TOKENS", "2048")),
        "metrics": metrics,
        "baseline_comparison": comparison,
        "quality_gate": gate,
        "top_20_worst_errors": sorted(
            samples, key=lambda sample: (sample["strict_cer"], -sample["f1_50"]), reverse=True
        )[:20],
        "samples": samples,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (path.parent / "quality_gate.json").write_text(
        json.dumps(gate, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "last_quality_gate.json").write_text(
        json.dumps(gate, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"BBox benchmark saved to {path}", flush=True)
    print(f"Release quality gate: {'PASS' if gate['release_ready'] else 'FAIL'}", flush=True)
    return gate


def configure_engine():
    engine.MODEL_ID = MODEL_ID
    engine.BASE_PATH = BASE_PATH
    engine.TRAIN_FILE = BASE_PATH / "train" / "metadata.jsonl"
    engine.VAL_FILE = BASE_PATH / "val" / "metadata.jsonl"
    engine.TEST_FILE = BASE_PATH / "test" / "metadata.jsonl"
    engine.OUTPUT_DIR = OUTPUT_DIR
    engine.LOGS_DIR = Path(os.getenv("LIGHTON_LOGS_DIR", SCRIPT_DIR / "logs"))
    engine.FINAL_DIR = OUTPUT_DIR / "final_lora_merged"
    engine.CANDIDATE_DIR = OUTPUT_DIR / "candidate_lora_merged"
    engine.PREVIOUS_DIR = OUTPUT_DIR / "previous_lora_merged"
    engine.IMAGE_LONGEST_EDGE = IMAGE_LONGEST_EDGE
    engine.MAX_NEW_TOKENS = int(os.getenv("LIGHTON_MAX_NEW_TOKENS", "2048"))
    engine.MAX_SEQUENCE_LENGTH = int(os.getenv("LIGHTON_MAX_SEQUENCE_LENGTH", "4096"))
    engine.GENERATION_BATCH_SIZE = int(os.getenv("LIGHTON_GENERATION_BATCH", "1"))
    engine.GEN_EVAL_MAX_SAMPLES = int(os.getenv("LIGHTON_GEN_EVAL_MAX_SAMPLES", "128"))
    engine.BASELINE_URL = (
        "https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph-bbox/"
        "resolve/main/test/output/metrics.json"
    )
    engine.run_generation_benchmark = run_bbox_benchmark
    engine.process_batch = process_bbox_batch
    engine.prepare_dataset = prepare_bbox_dataset
    engine.compare_with_baseline = compare_bbox_baseline
    engine.quality_gate = bbox_quality_gate
    engine.save_benchmark = save_bbox_benchmark


if __name__ == "__main__":
    configure_engine()
    engine.main()
