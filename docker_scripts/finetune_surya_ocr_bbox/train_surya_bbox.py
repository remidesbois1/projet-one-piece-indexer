import argparse
import gc
import glob
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import jiwer
import numpy as np
import torch
from datasets import load_dataset
from dotenv import load_dotenv
from Levenshtein import distance as levenshtein_distance
from PIL import Image
from transformers import (
    AutoModelForImageTextToText,
    AutoProcessor,
    EarlyStoppingCallback,
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    TrainerCallback,
)


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent
sys.path.insert(0, str(DOCKER_SCRIPTS_DIR))
from common_training.prompts import get_prompt

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

MODEL_ID = os.getenv("SURYA_BBOX_MODEL_ID", "datalab-to/surya-ocr-2")
LIGHTON_BASELINE_MODEL_ID = os.getenv(
    "SURYA_BBOX_LIGHTON_BASELINE_MODEL_ID",
    "Remidesbois/LightonOCR-2-1b-poneglyph-bbox",
)
DATASET_DIR = Path(
    os.getenv("SURYA_BBOX_DATASET_DIR", str(SCRIPT_DIR / "surya_bbox_dataset"))
)
OUTPUT_DIR = Path(
    os.getenv("SURYA_BBOX_OUTPUT_DIR", str(SCRIPT_DIR / "outputs_surya_bbox"))
)
FINAL_DIR = OUTPUT_DIR / "final_merged"
TRAIN_FILE = DATASET_DIR / "train" / "metadata.jsonl"
VAL_FILE = DATASET_DIR / "val" / "metadata.jsonl"
TEST_FILE = DATASET_DIR / "test" / "metadata.jsonl"
SPLITS = ("train", "val", "test")

USER_PROMPT = get_prompt("ocr_page_bbox", "SURYA_BBOX_USER_PROMPT")
BBOX_NORM_SCALE = int(os.getenv("SURYA_BBOX_NORM_SCALE", "1000"))
MAX_NEW_TOKENS = int(os.getenv("SURYA_BBOX_MAX_NEW_TOKENS", "2048"))
GEN_EVAL_MAX_SAMPLES = int(os.getenv("SURYA_BBOX_GEN_EVAL_MAX_SAMPLES", "48"))
FINAL_TEST_MAX_SAMPLES = int(os.getenv("SURYA_BBOX_FINAL_TEST_MAX_SAMPLES", "0"))
RANDOM_SEED = int(os.getenv("SURYA_BBOX_RANDOM_SEED", "42"))
IOU_THRESHOLDS = (0.3, 0.5, 0.75, 0.9)
BBOX_PATTERN = re.compile(r"(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]")


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Fine-tune Surya OCR 2 for Poneglyph full-page text+bbox extraction."
    )
    parser.add_argument("--merge-only", action="store_true", help="Merge the best LoRA checkpoint and exit.")
    parser.add_argument("--benchmark-only", action="store_true", help="Benchmark an existing merged model.")
    parser.add_argument("--model-path", default=None, help="Model path for merge-only or benchmark-only.")
    parser.add_argument("--skip-lighton-comparison", action="store_true", help="Skip the LightOn bbox baseline benchmark.")
    return parser.parse_args()


def configure_torch_runtime() -> None:
    torch.set_num_threads(int(os.getenv("SURYA_BBOX_TORCH_THREADS", "8")))
    if torch.cuda.is_available():
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        try:
            torch.set_float32_matmul_precision("high")
        except Exception:
            pass
    if hasattr(torch, "_dynamo"):
        torch._dynamo.config.suppress_errors = True


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def prepare_dataset(file_path: Path, split_name: str):
    if not file_path.exists():
        raise FileNotFoundError(f"Missing dataset file: {file_path}")
    print(f"Loading {split_name} dataset from {file_path}", flush=True)
    dataset = load_dataset("json", data_files=str(file_path), split="train")
    if "split" not in dataset.column_names:
        dataset = dataset.map(lambda _: {"split": split_name})
    print(f"  {split_name}: {len(dataset)} samples", flush=True)
    return dataset


def resolve_image_path(entry, preferred_split=None):
    image_file = entry.get("image_file")
    if not image_file:
        messages = entry.get("messages") or []
        if messages and messages[0].get("content"):
            image_file = messages[0]["content"][0].get("image")
    if not image_file:
        return None

    candidate_splits = []
    if preferred_split:
        candidate_splits.append(preferred_split)
    candidate_splits.extend(split for split in SPLITS if split not in candidate_splits)

    for split_name in candidate_splits:
        candidate = DATASET_DIR / split_name / image_file
        if candidate.exists():
            return candidate
    return None


def extract_reference_text(entry) -> str:
    if entry.get("assistant_text") is not None:
        return str(entry.get("assistant_text", "")).strip()
    for message in entry.get("messages") or []:
        if message.get("role") != "assistant":
            continue
        for content in message.get("content") or []:
            if "text" in content:
                return str(content["text"]).strip()
    return ""


def messages_for_entry(image_path: Path, reference_text: str = None):
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": str(image_path)},
                {"type": "text", "text": USER_PROMPT},
            ],
        }
    ]
    if reference_text is not None:
        messages.append(
            {
                "role": "assistant",
                "content": [{"type": "text", "text": reference_text}],
            }
        )
    return messages


def lighton_messages_for_entry():
    return [{"role": "user", "content": [{"type": "image"}]}]


def apply_template(processor, messages, add_generation_prompt):
    return processor.apply_chat_template(
        messages,
        add_generation_prompt=add_generation_prompt,
        tokenize=False,
    )


def process_batch(examples, processor):
    batch_texts = []
    batch_images = []
    prompt_texts = []
    per_example_images = []

    image_files = examples["image_file"]
    split_names = examples.get("split", [None] * len(image_files))
    references = examples.get("assistant_text", [""] * len(image_files))
    page_ids = examples.get("page_id", [None] * len(image_files))

    for image_file, split_name, reference, page_id in zip(
        image_files, split_names, references, page_ids
    ):
        entry = {"image_file": image_file, "split": split_name, "page_id": page_id}
        image_path = resolve_image_path(entry, split_name)
        if image_path is None:
            raise FileNotFoundError(f"Missing image for page {page_id}: {image_file}")

        with Image.open(image_path) as img:
            image = img.convert("RGB")

        full_messages = messages_for_entry(image_path, str(reference))
        prompt_messages = messages_for_entry(image_path, None)
        batch_texts.append(apply_template(processor, full_messages, add_generation_prompt=False))
        prompt_texts.append(apply_template(processor, prompt_messages, add_generation_prompt=True))
        batch_images.append(image)
        per_example_images.append(image)

    model_inputs = processor(
        text=batch_texts,
        images=batch_images,
        padding=True,
        return_tensors="pt",
    )

    labels = model_inputs["input_ids"].clone()
    tokenizer = getattr(processor, "tokenizer", None)
    pad_token_id = getattr(tokenizer, "pad_token_id", None)
    padding_side = getattr(tokenizer, "padding_side", "right")

    for idx, (full_text, prompt_text, image) in enumerate(
        zip(batch_texts, prompt_texts, per_example_images)
    ):
        prompt_inputs = processor(text=[prompt_text], images=[image], return_tensors="pt")
        full_inputs = processor(text=[full_text], images=[image], return_tensors="pt")
        prompt_len = prompt_inputs["input_ids"].shape[1]
        full_len = full_inputs["input_ids"].shape[1]
        assistant_len = max(full_len - prompt_len, 0)

        if padding_side == "left":
            mask_until = labels.shape[1] - assistant_len
            labels[idx, :mask_until] = -100
        else:
            labels[idx, :prompt_len] = -100

        if pad_token_id is not None:
            labels[idx, model_inputs["input_ids"][idx] == pad_token_id] = -100

    model_inputs["labels"] = labels
    return model_inputs


class SuryaBBoxCollator:
    def __init__(self, processor):
        self.processor = processor

    def __call__(self, features):
        keys = ("page_id", "image_file", "split", "assistant_text")
        examples = {key: [feature.get(key) for feature in features] for key in keys}
        return process_batch(examples, self.processor)


def parse_bbox_output(text: str):
    results = []
    for line in str(text or "").strip().splitlines():
        line = line.strip()
        if not line:
            continue
        match = BBOX_PATTERN.match(line)
        if not match:
            continue
        bbox = [int(match.group(i)) for i in range(2, 6)]
        if any(coord < 0 or coord > BBOX_NORM_SCALE for coord in bbox):
            continue
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            continue
        results.append({"text": match.group(1).strip(), "bbox": bbox})
    return results


def normalize_prediction_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def compute_iou(box_a, box_b):
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])
    inter_w = max(0, x2 - x1)
    inter_h = max(0, y2 - y1)
    inter_area = inter_w * inter_h
    area_a = max(0, (box_a[2] - box_a[0]) * (box_a[3] - box_a[1]))
    area_b = max(0, (box_b[2] - box_b[0]) * (box_b[3] - box_b[1]))
    union_area = area_a + area_b - inter_area
    if union_area <= 0:
        return 0.0
    return inter_area / union_area


def compute_giou(box_a, box_b):
    iou = compute_iou(box_a, box_b)
    enc_x1 = min(box_a[0], box_b[0])
    enc_y1 = min(box_a[1], box_b[1])
    enc_x2 = max(box_a[2], box_b[2])
    enc_y2 = max(box_a[3], box_b[3])
    enc_area = max(0, (enc_x2 - enc_x1) * (enc_y2 - enc_y1))
    if enc_area <= 0:
        return iou
    area_a = max(0, (box_a[2] - box_a[0]) * (box_a[3] - box_a[1]))
    area_b = max(0, (box_b[2] - box_b[0]) * (box_b[3] - box_b[1]))
    inter_w = max(0, min(box_a[2], box_b[2]) - max(box_a[0], box_b[0]))
    inter_h = max(0, min(box_a[3], box_b[3]) - max(box_a[1], box_b[1]))
    inter_area = inter_w * inter_h
    return iou - (enc_area - area_a - area_b + inter_area) / enc_area


def match_predictions_to_gt(pred_items, gt_items, iou_threshold=0.5):
    if not pred_items or not gt_items:
        return [], list(range(len(gt_items))), list(range(len(pred_items)))

    iou_matrix = np.zeros((len(pred_items), len(gt_items)))
    for i, pred in enumerate(pred_items):
        for j, gt in enumerate(gt_items):
            iou_matrix[i, j] = compute_iou(pred["bbox"], gt["bbox"])

    matched_pairs = []
    used_preds = set()
    used_gts = set()
    while True:
        if iou_matrix.size == 0:
            break
        max_idx = np.unravel_index(np.argmax(iou_matrix), iou_matrix.shape)
        max_iou = iou_matrix[max_idx]
        if max_iou < iou_threshold:
            break
        pred_idx, gt_idx = max_idx
        if pred_idx in used_preds or gt_idx in used_gts:
            iou_matrix[pred_idx, gt_idx] = 0
            continue
        matched_pairs.append((pred_idx, gt_idx, float(max_iou)))
        used_preds.add(pred_idx)
        used_gts.add(gt_idx)
        iou_matrix[pred_idx, :] = 0
        iou_matrix[:, gt_idx] = 0

    unmatched_gts = [idx for idx in range(len(gt_items)) if idx not in used_gts]
    unmatched_preds = [idx for idx in range(len(pred_items)) if idx not in used_preds]
    return matched_pairs, unmatched_gts, unmatched_preds


def safe_wer(reference: str, prediction: str):
    if not reference:
        return 0.0 if not prediction else 1.0
    try:
        return jiwer.wer(reference, prediction)
    except Exception:
        return 1.0


def compute_metrics_from_results(results):
    metrics = {
        "num_samples": len(results),
        "total_gt_bubbles": 0,
        "total_pred_bubbles": 0,
    }
    all_sample_cer = []
    all_sample_wer = []
    all_matched_iou = []
    all_matched_giou = []
    all_bbox_area_error = []
    detection_rates = []
    inference_times = []
    exact_matches = 0
    precision_by_threshold = {threshold: [] for threshold in IOU_THRESHOLDS}
    recall_by_threshold = {threshold: [] for threshold in IOU_THRESHOLDS}
    f1_by_threshold = {threshold: [] for threshold in IOU_THRESHOLDS}
    per_sample = []

    for result in results:
        gt_items = result["gt_items"]
        pred_items = result["pred_items"]
        n_gt = len(gt_items)
        n_pred = len(pred_items)
        metrics["total_gt_bubbles"] += n_gt
        metrics["total_pred_bubbles"] += n_pred
        inference_times.append(result.get("inference_time", 0.0))

        if n_gt == 0 and n_pred == 0:
            exact_matches += 1
            detection_rates.append(1.0)
            per_sample.append(
                {
                    "page_id": result.get("page_id"),
                    "cer": 0.0,
                    "wer": 0.0,
                    "mean_iou": 1.0,
                    "num_gt": 0,
                    "num_pred": 0,
                    "detection_rate": 1.0,
                    "precision@0_5": 1.0,
                    "recall@0_5": 1.0,
                    "f1@0_5": 1.0,
                }
            )
            continue

        detection_rate = min(n_pred, n_gt) / max(n_gt, 1)
        detection_rates.append(detection_rate)
        if n_gt == n_pred and normalize_prediction_text(result["pred_text"]) == normalize_prediction_text(result["gt_text"]):
            exact_matches += 1

        sample_cers = []
        sample_wers = []
        sample_ious = []
        sample_pr = {}

        for threshold in IOU_THRESHOLDS:
            matched, unmatched_gt, unmatched_pred = match_predictions_to_gt(
                pred_items, gt_items, iou_threshold=threshold
            )
            tp = len(matched)
            fp = len(unmatched_pred)
            fn = len(unmatched_gt)
            precision = tp / max(tp + fp, 1)
            recall = tp / max(tp + fn, 1)
            f1 = 2 * precision * recall / max(precision + recall, 1e-12)
            precision_by_threshold[threshold].append(precision)
            recall_by_threshold[threshold].append(recall)
            f1_by_threshold[threshold].append(f1)
            sample_pr[threshold] = (precision, recall, f1)

            if threshold == 0.5:
                for pred_idx, gt_idx, iou_value in matched:
                    pred_text = normalize_prediction_text(pred_items[pred_idx]["text"])
                    gt_text = normalize_prediction_text(gt_items[gt_idx]["text"])
                    sample_cers.append(
                        levenshtein_distance(pred_text, gt_text) / max(len(gt_text), 1)
                    )
                    sample_wers.append(safe_wer(gt_text, pred_text))
                    sample_ious.append(iou_value)
                    all_matched_iou.append(iou_value)
                    all_matched_giou.append(
                        compute_giou(pred_items[pred_idx]["bbox"], gt_items[gt_idx]["bbox"])
                    )
                    gt_area = max(
                        0,
                        (gt_items[gt_idx]["bbox"][2] - gt_items[gt_idx]["bbox"][0])
                        * (gt_items[gt_idx]["bbox"][3] - gt_items[gt_idx]["bbox"][1]),
                    )
                    pred_area = max(
                        0,
                        (pred_items[pred_idx]["bbox"][2] - pred_items[pred_idx]["bbox"][0])
                        * (pred_items[pred_idx]["bbox"][3] - pred_items[pred_idx]["bbox"][1]),
                    )
                    if gt_area > 0:
                        all_bbox_area_error.append(abs(pred_area - gt_area) / gt_area)

        sample_cer = float(np.mean(sample_cers)) if sample_cers else 1.0
        sample_wer = float(np.mean(sample_wers)) if sample_wers else 1.0
        sample_iou = float(np.mean(sample_ious)) if sample_ious else 0.0
        all_sample_cer.append(sample_cer)
        all_sample_wer.append(sample_wer)

        p50, r50, f50 = sample_pr.get(0.5, (0.0, 0.0, 0.0))
        per_sample.append(
            {
                "page_id": result.get("page_id"),
                "cer": sample_cer,
                "wer": sample_wer,
                "mean_iou": sample_iou,
                "num_gt": n_gt,
                "num_pred": n_pred,
                "detection_rate": detection_rate,
                "precision@0_5": p50,
                "recall@0_5": r50,
                "f1@0_5": f50,
            }
        )

    metrics["cer"] = float(np.mean(all_sample_cer)) if all_sample_cer else 1.0
    metrics["wer"] = float(np.mean(all_sample_wer)) if all_sample_wer else 1.0
    metrics["exact_match_rate"] = exact_matches / max(len(results), 1)
    metrics["mean_iou"] = float(np.mean(all_matched_iou)) if all_matched_iou else 0.0
    metrics["median_iou"] = float(np.median(all_matched_iou)) if all_matched_iou else 0.0
    metrics["mean_giou"] = float(np.mean(all_matched_giou)) if all_matched_giou else 0.0
    metrics["mean_bbox_area_error"] = (
        float(np.mean(all_bbox_area_error)) if all_bbox_area_error else 0.0
    )
    metrics["avg_detection_rate"] = float(np.mean(detection_rates)) if detection_rates else 0.0
    metrics["avg_inference_time"] = float(np.mean(inference_times)) if inference_times else 0.0

    for threshold in IOU_THRESHOLDS:
        suffix = str(threshold).replace(".", "_")
        metrics[f"precision@{suffix}"] = (
            float(np.mean(precision_by_threshold[threshold]))
            if precision_by_threshold[threshold]
            else 0.0
        )
        metrics[f"recall@{suffix}"] = (
            float(np.mean(recall_by_threshold[threshold]))
            if recall_by_threshold[threshold]
            else 0.0
        )
        metrics[f"f1@{suffix}"] = (
            float(np.mean(f1_by_threshold[threshold]))
            if f1_by_threshold[threshold]
            else 0.0
        )

    metrics["iou_distribution"] = [float(value) for value in all_matched_iou]
    metrics["cer_distribution"] = [float(value) for value in all_sample_cer]
    metrics["bbox_area_error_distribution"] = [float(value) for value in all_bbox_area_error]
    metrics["per_sample"] = per_sample

    ious = metrics["iou_distribution"]
    metrics["iou_p25"] = float(np.percentile(ious, 25)) if ious else 0.0
    metrics["iou_p75"] = float(np.percentile(ious, 75)) if ious else 0.0
    metrics["iou_p90"] = float(np.percentile(ious, 90)) if ious else 0.0
    metrics["iou_p95"] = float(np.percentile(ious, 95)) if ious else 0.0
    metrics["cer_median"] = float(np.median(metrics["cer_distribution"])) if metrics["cer_distribution"] else 1.0
    metrics["combined_score"] = (
        (1 - metrics["cer"]) * 0.4
        + metrics["f1@0_5"] * 0.3
        + metrics["mean_iou"] * 0.2
        + metrics["avg_detection_rate"] * 0.1
    )
    return metrics


def model_dtype(model):
    for param in model.parameters():
        if param.is_floating_point():
            return param.dtype
    return torch.float32


def move_inputs_to_device(inputs, device, dtype):
    moved = {}
    for key, value in inputs.items():
        if not hasattr(value, "to"):
            moved[key] = value
        elif value.is_floating_point():
            moved[key] = value.to(device=device, dtype=dtype)
        else:
            moved[key] = value.to(device=device)
    return moved


def decode_tokens(processor, token_ids):
    if hasattr(processor, "decode"):
        return processor.decode(token_ids, skip_special_tokens=True)
    return processor.tokenizer.decode(token_ids, skip_special_tokens=True)


def generate_surya_prediction(model, processor, entry):
    split_name = entry.get("split") or "test"
    image_path = resolve_image_path(entry, split_name)
    if image_path is None:
        raise FileNotFoundError(f"Missing image for page {entry.get('page_id')}")
    with Image.open(image_path) as img:
        image = img.convert("RGB")

    messages = messages_for_entry(image_path, None)
    prompt = apply_template(processor, messages, add_generation_prompt=True)
    inputs = processor(text=[prompt], images=[image], return_tensors="pt")
    device = next(model.parameters()).device
    dtype = model_dtype(model)
    inputs = move_inputs_to_device(inputs, device, dtype)

    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
        )
    gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    return decode_tokens(processor, gen_ids).strip()


def generate_lighton_prediction(model, processor, entry):
    split_name = entry.get("split") or "test"
    image_path = resolve_image_path(entry, split_name)
    if image_path is None:
        raise FileNotFoundError(f"Missing image for page {entry.get('page_id')}")
    with Image.open(image_path) as img:
        image = img.convert("RGB")

    prompt = processor.apply_chat_template(
        lighton_messages_for_entry(),
        add_generation_prompt=True,
        tokenize=False,
    )
    inputs = processor(text=[prompt], images=[image], return_tensors="pt")
    device = next(model.parameters()).device
    dtype = model_dtype(model)
    inputs = move_inputs_to_device(inputs, device, dtype)

    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
        )
    gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    return processor.tokenizer.decode(gen_ids, skip_special_tokens=True).strip()


def benchmark_indices(dataset, max_samples):
    total = len(dataset)
    if max_samples is None or max_samples <= 0 or max_samples >= total:
        return list(range(total))
    rng = random.Random(RANDOM_SEED)
    return sorted(rng.sample(range(total), max_samples))


def run_generation_benchmark(
    model,
    processor,
    dataset,
    split_name,
    generator,
    model_label,
    max_samples=None,
    worst_count=20,
):
    was_training = model.training
    old_use_cache = getattr(model.config, "use_cache", None)
    if old_use_cache is not None:
        model.config.use_cache = True
    model.eval()

    indices = benchmark_indices(dataset, max_samples)
    results = []
    print("", flush=True)
    print("=" * 72, flush=True)
    print(f"{model_label} BBOX BENCHMARK [{split_name}] - {len(indices)}/{len(dataset)} pages", flush=True)
    print("=" * 72, flush=True)

    for sample_index, dataset_index in enumerate(indices, 1):
        entry = dataset[dataset_index]
        gt_text = extract_reference_text(entry)
        start = time.time()
        try:
            pred_text = generator(model, processor, entry)
            error = None
        except Exception as exc:
            pred_text = ""
            error = str(exc)
        elapsed = time.time() - start
        gt_items = parse_bbox_output(gt_text)
        pred_items = parse_bbox_output(pred_text)
        results.append(
            {
                "dataset_idx": dataset_index,
                "page_id": entry.get("page_id"),
                "image_file": entry.get("image_file"),
                "gt_text": gt_text,
                "pred_text": pred_text,
                "gt_items": gt_items,
                "pred_items": pred_items,
                "num_gt_bubbles": len(gt_items),
                "num_pred_bubbles": len(pred_items),
                "inference_time": elapsed,
                "error": error,
            }
        )
        if sample_index % 10 == 0 or sample_index == len(indices):
            print(f"  generated {sample_index}/{len(indices)}", flush=True)

    metrics = compute_metrics_from_results(results)
    ranked = sorted(
        metrics["per_sample"],
        key=lambda sample: (sample["f1@0_5"], sample["mean_iou"], -sample["cer"]),
    )
    print("-" * 72, flush=True)
    print(f"CER:             {metrics['cer']:.6f} ({metrics['cer'] * 100:.3f}%)", flush=True)
    print(f"WER:             {metrics['wer']:.6f} ({metrics['wer'] * 100:.3f}%)", flush=True)
    print(f"Mean IoU:        {metrics['mean_iou']:.6f}", flush=True)
    print(f"F1@0.5:          {metrics['f1@0_5']:.6f}", flush=True)
    print(f"Detection rate:  {metrics['avg_detection_rate']:.6f}", flush=True)
    print(f"Combined score:  {metrics['combined_score']:.6f}", flush=True)
    print(f"Avg inference:   {metrics['avg_inference_time']:.3f}s/page", flush=True)
    print("-" * 72, flush=True)
    for rank, sample in enumerate(ranked[: min(worst_count, len(ranked))], 1):
        print(
            f"#{rank} page={sample['page_id']} CER={sample['cer']:.4f} "
            f"IoU={sample['mean_iou']:.4f} F1@0.5={sample['f1@0_5']:.4f} "
            f"GT={sample['num_gt']} PRED={sample['num_pred']}",
            flush=True,
        )
    print("=" * 72, flush=True)

    if old_use_cache is not None:
        model.config.use_cache = old_use_cache
    if was_training:
        model.train()
    return metrics, results


class PromptOnlyEvalTrainer(Seq2SeqTrainer):
    def __init__(self, *args, processor=None, gen_eval_max_samples=32, **kwargs):
        super().__init__(*args, **kwargs)
        self.processor = processor
        self.gen_eval_max_samples = gen_eval_max_samples

    def evaluate(self, eval_dataset=None, ignore_keys=None, metric_key_prefix="eval"):
        metrics = super().evaluate(
            eval_dataset=eval_dataset,
            ignore_keys=ignore_keys,
            metric_key_prefix=metric_key_prefix,
        )
        dataset = eval_dataset if eval_dataset is not None else self.eval_dataset
        if dataset is None or self.gen_eval_max_samples == 0:
            return metrics
        try:
            split_name = dataset[0].get("split") or "val"
        except Exception:
            split_name = "val"
        gen_metrics, _results = run_generation_benchmark(
            self.model,
            self.processor,
            dataset,
            split_name=split_name,
            generator=generate_surya_prediction,
            model_label="SURYA VALIDATION",
            max_samples=self.gen_eval_max_samples,
            worst_count=5,
        )
        prefixed = {
            f"{metric_key_prefix}_{key}": value
            for key, value in gen_metrics.items()
            if isinstance(value, (int, float))
        }
        metrics.update(prefixed)
        self.log(prefixed)
        return metrics


class LiveMetricsCallback(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        if not logs:
            return
        keys = (
            "loss",
            "learning_rate",
            "eval_loss",
            "eval_cer",
            "eval_wer",
            "eval_mean_iou",
            "eval_f1@0_5",
            "eval_avg_detection_rate",
            "eval_combined_score",
        )
        parts = [f"step={state.global_step}"]
        for key in keys:
            if key in logs:
                value = logs[key]
                parts.append(f"{key}={value:.6f}" if isinstance(value, float) else f"{key}={value}")
        print("[LIVE] " + " | ".join(parts), flush=True)


def find_best_checkpoint(output_dir):
    output_dir = Path(output_dir)
    state_files = [output_dir / "trainer_state.json"]
    state_files.extend(
        Path(path) / "trainer_state.json" for path in glob.glob(str(output_dir / "checkpoint-*"))
    )
    for state_file in sorted(
        state_files,
        key=lambda path: path.stat().st_mtime if path.exists() else 0,
        reverse=True,
    ):
        if not state_file.exists():
            continue
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state = json.load(f)
            best = state.get("best_model_checkpoint")
            if best and Path(best).exists():
                return best
        except Exception:
            continue

    checkpoints = sorted(glob.glob(str(output_dir / "checkpoint-*")), key=os.path.getmtime)
    return checkpoints[-1] if checkpoints else None


def configure_processor(model_id_or_path=MODEL_ID):
    print(f"Loading processor: {model_id_or_path}", flush=True)
    processor = AutoProcessor.from_pretrained(model_id_or_path, trust_remote_code=True)
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is not None:
        tokenizer.padding_side = "left"
        if tokenizer.pad_token_id is None and tokenizer.eos_token is not None:
            tokenizer.pad_token = tokenizer.eos_token
    image_processor = getattr(processor, "image_processor", None)
    if image_processor is not None and hasattr(image_processor, "default_to_square"):
        image_processor.default_to_square = False
    return processor


def valid_token_id(token_id, tokenizer) -> bool:
    if token_id is None or tokenizer is None:
        return False
    try:
        token_count = len(tokenizer)
    except Exception:
        return isinstance(token_id, int)
    if isinstance(token_id, int):
        return 0 <= token_id < token_count
    if isinstance(token_id, (list, tuple)):
        return all(isinstance(item, int) and 0 <= item < token_count for item in token_id)
    return False


def configure_generation(model, processor=None):
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = True
    model.generation_config.do_sample = False
    model.generation_config.max_new_tokens = MAX_NEW_TOKENS
    model.generation_config.temperature = None
    model.generation_config.top_p = None
    model.generation_config.top_k = None
    model.generation_config.max_length = None

    tokenizer = getattr(processor, "tokenizer", None) if processor is not None else None
    if tokenizer is None:
        return
    eos_token_id = getattr(tokenizer, "eos_token_id", None)
    pad_token_id = getattr(tokenizer, "pad_token_id", None)
    if valid_token_id(eos_token_id, tokenizer):
        model.generation_config.eos_token_id = eos_token_id
        if hasattr(model.config, "eos_token_id"):
            model.config.eos_token_id = eos_token_id
    if valid_token_id(pad_token_id, tokenizer):
        model.generation_config.pad_token_id = pad_token_id
        if hasattr(model.config, "pad_token_id"):
            model.config.pad_token_id = pad_token_id


def load_surya_model(model_id_or_path=MODEL_ID):
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading Surya model: {model_id_or_path} ({dtype}, device={device})", flush=True)
    kwargs = {
        "torch_dtype": dtype,
        "trust_remote_code": True,
        "low_cpu_mem_usage": True,
    }
    attn_impl = os.getenv("SURYA_BBOX_ATTN_IMPLEMENTATION", "sdpa").strip()
    if attn_impl:
        kwargs["attn_implementation"] = attn_impl
    if device == "cuda":
        kwargs["device_map"] = {"": "cuda:0"}
    model = AutoModelForImageTextToText.from_pretrained(model_id_or_path, **kwargs)
    if device != "cuda":
        model.to(device)
    return model


def load_lighton_model():
    from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    print(f"Loading LightOn baseline: {LIGHTON_BASELINE_MODEL_ID}", flush=True)
    processor = LightOnOcrProcessor.from_pretrained(LIGHTON_BASELINE_MODEL_ID)
    processor.image_processor.default_to_square = False
    processor.tokenizer.padding_side = "left"
    kwargs = {"torch_dtype": dtype}
    if torch.cuda.is_available():
        kwargs["device_map"] = "auto"
    model = LightOnOcrForConditionalGeneration.from_pretrained(
        LIGHTON_BASELINE_MODEL_ID,
        **kwargs,
    )
    if not torch.cuda.is_available():
        model.to("cpu")
    model.generation_config.do_sample = False
    model.generation_config.max_new_tokens = MAX_NEW_TOKENS
    model.generation_config.temperature = None
    model.generation_config.top_p = None
    model.generation_config.top_k = None
    return model, processor


def build_lora_config():
    from peft import LoraConfig

    lora_r = int(os.getenv("SURYA_BBOX_LORA_R", "64"))
    lora_alpha = int(os.getenv("SURYA_BBOX_LORA_ALPHA", str(lora_r * 2)))
    target_modules = [
        item.strip()
        for item in os.getenv(
            "SURYA_BBOX_LORA_TARGET_MODULES",
            "q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj,lm_head",
        ).split(",")
        if item.strip()
    ]
    return LoraConfig(
        r=lora_r,
        lora_alpha=lora_alpha,
        lora_dropout=float(os.getenv("SURYA_BBOX_LORA_DROPOUT", "0.01")),
        use_dora=env_bool("SURYA_BBOX_USE_DORA", True),
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )


def configure_trainable_model(model):
    train_mode = os.getenv("SURYA_BBOX_TRAIN_MODE", "lora").strip().lower()
    if train_mode == "full":
        print("Training mode: full fine-tuning", flush=True)
        for parameter in model.parameters():
            parameter.requires_grad = True
        return model, "full"

    try:
        from peft import get_peft_model

        print("Training mode: LoRA/DoRA", flush=True)
        model = get_peft_model(model, build_lora_config())
        model.print_trainable_parameters()
        return model, "lora"
    except Exception as exc:
        if not env_bool("SURYA_BBOX_ALLOW_FULL_FALLBACK", True):
            raise
        print(f"LoRA setup failed, falling back to full fine-tuning: {exc}", flush=True)
        for parameter in model.parameters():
            parameter.requires_grad = True
        return model, "full_fallback"


def make_training_args():
    eval_steps = int(os.getenv("SURYA_BBOX_EVAL_STEPS", "100"))
    kwargs = {
        "output_dir": str(OUTPUT_DIR),
        "learning_rate": float(os.getenv("SURYA_BBOX_LR", "5e-5")),
        "num_train_epochs": float(os.getenv("SURYA_BBOX_EPOCHS", "6")),
        "per_device_train_batch_size": int(os.getenv("SURYA_BBOX_TRAIN_BATCH", "2")),
        "per_device_eval_batch_size": int(os.getenv("SURYA_BBOX_EVAL_BATCH", "2")),
        "gradient_accumulation_steps": int(os.getenv("SURYA_BBOX_GRAD_ACCUM", "4")),
        "gradient_checkpointing": env_bool("SURYA_BBOX_GRADIENT_CHECKPOINTING", True),
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "optim": os.getenv(
            "SURYA_BBOX_OPTIM",
            "adamw_torch_fused" if torch.cuda.is_available() else "adamw_torch",
        ),
        "bf16": torch.cuda.is_available(),
        "fp16": False,
        "tf32": torch.cuda.is_available(),
        "logging_steps": int(os.getenv("SURYA_BBOX_LOGGING_STEPS", "10")),
        "eval_strategy": "steps",
        "eval_steps": eval_steps,
        "save_strategy": "steps",
        "save_steps": eval_steps,
        "save_total_limit": int(os.getenv("SURYA_BBOX_SAVE_TOTAL_LIMIT", "3")),
        "load_best_model_at_end": True,
        "metric_for_best_model": "eval_combined_score",
        "greater_is_better": True,
        "remove_unused_columns": False,
        "report_to": os.getenv("SURYA_BBOX_REPORT_TO", "none"),
        "predict_with_generate": False,
        "dataloader_num_workers": int(os.getenv("SURYA_BBOX_DATALOADER_WORKERS", "4")),
        "dataloader_pin_memory": torch.cuda.is_available(),
        "torch_compile": env_bool("SURYA_BBOX_TORCH_COMPILE", False),
        "lr_scheduler_type": os.getenv("SURYA_BBOX_LR_SCHEDULER", "cosine"),
        "warmup_ratio": float(os.getenv("SURYA_BBOX_WARMUP_RATIO", "0.05")),
        "weight_decay": float(os.getenv("SURYA_BBOX_WEIGHT_DECAY", "0.01")),
        "max_grad_norm": float(os.getenv("SURYA_BBOX_MAX_GRAD_NORM", "1.0")),
        "seed": RANDOM_SEED,
        "data_seed": RANDOM_SEED,
    }
    try:
        return Seq2SeqTrainingArguments(**kwargs)
    except TypeError as exc:
        if "eval_strategy" not in str(exc):
            raise
        kwargs["evaluation_strategy"] = kwargs.pop("eval_strategy")
        return Seq2SeqTrainingArguments(**kwargs)


def merge_and_save(model, processor, train_mode: str):
    print("Saving final model...", flush=True)
    if train_mode.startswith("lora"):
        print("Merging LoRA weights into the base model...", flush=True)
        model = model.merge_and_unload()
    configure_generation(model, processor)
    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(FINAL_DIR)
    processor.save_pretrained(FINAL_DIR)
    print(f"Final model saved to {FINAL_DIR}", flush=True)
    return model


def save_benchmark(path, model_id, metrics, results):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model_id": model_id,
        "base_model": MODEL_ID,
        "prompt": USER_PROMPT,
        "bbox_norm_scale": BBOX_NORM_SCALE,
        "max_new_tokens": MAX_NEW_TOKENS,
        "metrics": metrics,
        "results": results,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Benchmark saved to {path}", flush=True)


def metric_subset(metrics):
    return {
        key: value
        for key, value in metrics.items()
        if isinstance(value, (int, float)) and not key.startswith("iou_")
    }


def save_comparison(path, surya_metrics, lighton_metrics=None, error=None):
    payload = {
        "surya_model_id": os.getenv("HF_REPO", "Remidesbois/surya-ocr-2-poneglyph-bbox"),
        "lighton_model_id": LIGHTON_BASELINE_MODEL_ID,
        "bbox_norm_scale": BBOX_NORM_SCALE,
        "surya": metric_subset(surya_metrics),
        "lighton": metric_subset(lighton_metrics) if lighton_metrics else None,
        "error": error,
    }
    if lighton_metrics:
        winners = {}
        higher_better = {
            "mean_iou",
            "median_iou",
            "mean_giou",
            "avg_detection_rate",
            "exact_match_rate",
            "combined_score",
            "precision@0_3",
            "precision@0_5",
            "precision@0_75",
            "precision@0_9",
            "recall@0_3",
            "recall@0_5",
            "recall@0_75",
            "recall@0_9",
            "f1@0_3",
            "f1@0_5",
            "f1@0_75",
            "f1@0_9",
        }
        for key, surya_value in payload["surya"].items():
            lighton_value = payload["lighton"].get(key)
            if lighton_value is None:
                continue
            if key in higher_better:
                winners[key] = "surya" if surya_value > lighton_value else "lighton" if lighton_value > surya_value else "tie"
            else:
                winners[key] = "surya" if surya_value < lighton_value else "lighton" if lighton_value < surya_value else "tie"
        payload["winners"] = winners
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Comparison saved to {path}", flush=True)


def release_model(model):
    try:
        model.to("cpu")
    except Exception:
        pass
    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def run_lighton_comparison(test_dataset, surya_metrics):
    comparison_path = FINAL_DIR / "comparison_lighton_bbox.json"
    lighton_model = None
    try:
        lighton_model, lighton_processor = load_lighton_model()
        lighton_metrics, lighton_results = run_generation_benchmark(
            lighton_model,
            lighton_processor,
            test_dataset,
            split_name="test",
            generator=generate_lighton_prediction,
            model_label="LIGHTON BASELINE",
            max_samples=FINAL_TEST_MAX_SAMPLES or None,
            worst_count=20,
        )
        save_benchmark(
            FINAL_DIR / "benchmark_lighton_bbox.json",
            LIGHTON_BASELINE_MODEL_ID,
            lighton_metrics,
            lighton_results,
        )
        save_comparison(comparison_path, surya_metrics, lighton_metrics=lighton_metrics)
    except Exception as exc:
        message = str(exc)
        save_comparison(comparison_path, surya_metrics, error=message)
        if env_bool("SURYA_BBOX_REQUIRE_LIGHTON_COMPARISON", False):
            raise
        print(f"LightOn comparison failed but was recorded: {message}", flush=True)
    finally:
        if lighton_model is not None:
            release_model(lighton_model)


def run_final_surya_benchmark(model, processor, test_dataset):
    metrics, results = run_generation_benchmark(
        model,
        processor,
        test_dataset,
        split_name="test",
        generator=generate_surya_prediction,
        model_label="SURYA FINAL",
        max_samples=FINAL_TEST_MAX_SAMPLES or None,
        worst_count=20,
    )
    save_benchmark(
        FINAL_DIR / "benchmark_surya_bbox.json",
        os.getenv("HF_REPO", "Remidesbois/surya-ocr-2-poneglyph-bbox"),
        metrics,
        results,
    )
    return metrics, results


def benchmark_existing_model(model_path: str, skip_lighton_comparison=False):
    processor = configure_processor(model_path)
    model = load_surya_model(model_path).eval()
    configure_generation(model, processor)
    test_dataset = prepare_dataset(TEST_FILE, "test")
    metrics, _results = run_final_surya_benchmark(model, processor, test_dataset)
    release_model(model)
    if not skip_lighton_comparison and env_bool("SURYA_BBOX_COMPARE_LIGHTON", True):
        run_lighton_comparison(test_dataset, metrics)


def main():
    args = parse_args()
    configure_torch_runtime()
    set_seed(RANDOM_SEED)

    if args.benchmark_only:
        benchmark_existing_model(
            args.model_path or str(FINAL_DIR),
            skip_lighton_comparison=args.skip_lighton_comparison,
        )
        return

    processor = configure_processor()
    model = load_surya_model()
    configure_generation(model, processor)

    if args.merge_only:
        from peft import PeftModel

        checkpoint = args.model_path or find_best_checkpoint(OUTPUT_DIR)
        if not checkpoint:
            raise RuntimeError("No LoRA checkpoint found to merge.")
        print(f"Loading LoRA checkpoint: {checkpoint}", flush=True)
        model = PeftModel.from_pretrained(model, checkpoint)
        merge_and_save(model, processor, "lora")
        return

    train_dataset = prepare_dataset(TRAIN_FILE, "train")
    val_dataset = prepare_dataset(VAL_FILE, "val")
    test_dataset = prepare_dataset(TEST_FILE, "test")

    model, train_mode = configure_trainable_model(model)
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = False

    callbacks = [LiveMetricsCallback()]
    patience = int(os.getenv("SURYA_BBOX_EARLY_STOPPING_PATIENCE", "0"))
    if patience > 0:
        callbacks.append(EarlyStoppingCallback(early_stopping_patience=patience))

    trainer = PromptOnlyEvalTrainer(
        model=model,
        args=make_training_args(),
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        data_collator=SuryaBBoxCollator(processor),
        callbacks=callbacks,
        processor=processor,
        gen_eval_max_samples=GEN_EVAL_MAX_SAMPLES,
    )

    print("Starting Surya bbox fine-tuning...", flush=True)
    trainer.train()
    print(f"Best checkpoint: {trainer.state.best_model_checkpoint or find_best_checkpoint(OUTPUT_DIR)}", flush=True)

    final_model = merge_and_save(trainer.model, processor, train_mode)
    print("Running held-out Surya bbox benchmark...", flush=True)
    surya_metrics, _results = run_final_surya_benchmark(final_model, processor, test_dataset)

    release_model(final_model)
    final_model = None
    del trainer
    gc.collect()
    if not args.skip_lighton_comparison and env_bool("SURYA_BBOX_COMPARE_LIGHTON", True):
        run_lighton_comparison(test_dataset, surya_metrics)


if __name__ == "__main__":
    main()
