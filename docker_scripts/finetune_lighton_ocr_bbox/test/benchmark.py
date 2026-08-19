import os
import sys
import json
import re
import time
import gc
import requests
import traceback
import base64
import io
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import torch
import jiwer
from Levenshtein import distance as levenshtein_distance
from transformers import LightOnOcrProcessor, LightOnOcrForConditionalGeneration
from tqdm import tqdm
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

SCRIPT_DIR = Path(__file__).resolve().parent
FINETUNE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(FINETUNE_DIR.parent.parent))
from common_training.prompts import get_prompt
load_dotenv(FINETUNE_DIR / ".env")
OUTPUT_DIR = SCRIPT_DIR / "output"
GRAPHS_DIR = OUTPUT_DIR / "graphs"
SAMPLES_DIR = OUTPUT_DIR / "samples"

DATASET_DIR = FINETUNE_DIR / "lighton_bbox_dataset"
TEST_JSONL = DATASET_DIR / "test" / "metadata.jsonl"

BBOX_PATTERN = re.compile(r"(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]")
IOU_THRESHOLDS = [0.3, 0.5, 0.75, 0.9]

MODEL_ID = "Remidesbois/LightonOCR-2-1b-poneglyph-bbox"

GEMMA_API_KEY = os.environ.get("GEMMA_API_KEY", "")
if not GEMMA_API_KEY:
    print("ERROR: GEMMA_API_KEY not set. Add it to .env or environment.")
    sys.exit(1)
GEMMA_MODEL = "gemma-4-31b-it"
GEMMA_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMMA_MODEL}:generateContent"
GEMMA_MAX_WORKERS = 2
CACHE_LIGHTON = OUTPUT_DIR / "cache_lighton.json"
CACHE_GEMMA = OUTPUT_DIR / "cache_gemma.json"

GEMMA_PROMPT = get_prompt("ocr_page_bbox")


def parse_bbox_output(text):
    results = []
    for line in text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        match = BBOX_PATTERN.match(line)
        if match:
            bubble_text = match.group(1).strip()
            x1, y1, x2, y2 = (
                int(match.group(2)),
                int(match.group(3)),
                int(match.group(4)),
                int(match.group(5)),
            )
            results.append({"text": bubble_text, "bbox": [x1, y1, x2, y2]})
    return results


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
    if enc_area == 0:
        return iou
    return (
        iou
        - (
            enc_area
            - (max(0, (box_a[2] - box_a[0])) * max(0, (box_a[3] - box_a[1])))
            - (max(0, (box_b[2] - box_b[0])) * max(0, (box_b[3] - box_b[1])))
            + (
                max(0, min(box_a[2], box_b[2]) - max(box_a[0], box_b[0]))
                * max(0, min(box_a[3], box_b[3]) - max(box_a[1], box_b[1]))
            )
        )
        / enc_area
    )


def compute_bbox_center_distance(box_a, box_b):
    cx_a = (box_a[0] + box_a[2]) / 2
    cy_a = (box_a[1] + box_a[3]) / 2
    cx_b = (box_b[0] + box_b[2]) / 2
    cy_b = (box_b[1] + box_b[3]) / 2
    return ((cx_a - cx_b) ** 2 + (cy_a - cy_b) ** 2) ** 0.5


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
        matched_pairs.append((pred_idx, gt_idx, max_iou))
        used_preds.add(pred_idx)
        used_gts.add(gt_idx)
        iou_matrix[pred_idx, :] = 0
        iou_matrix[:, gt_idx] = 0

    unmatched_gts = [j for j in range(len(gt_items)) if j not in used_gts]
    unmatched_preds = [i for i in range(len(pred_items)) if i not in used_preds]
    return matched_pairs, unmatched_gts, unmatched_preds


def compute_cer_single(pred, ref):
    if not ref:
        return 0.0 if not pred else 1.0
    return levenshtein_distance(pred, ref) / max(len(ref), 1)


def compute_wer_single(pred, ref):
    if not ref:
        return 0.0 if not pred else 1.0
    try:
        return jiwer.wer(ref, pred)
    except:
        return 1.0


def load_test_dataset():
    if not TEST_JSONL.exists():
        print(f"Test dataset not found at {TEST_JSONL}")
        sys.exit(1)
    entries = []
    with open(TEST_JSONL, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    print(f"Loaded {len(entries)} test entries.")
    return entries


def load_cache(path):
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(path, cache):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def cache_key(entry):
    return str(entry.get("page_id", entry.get("image_file", "")))


def run_inference(model, processor, entries):
    device = next(model.parameters()).device
    cache = load_cache(CACHE_LIGHTON)
    results = []
    total_time = 0
    skipped = 0

    for idx, entry in enumerate(tqdm(entries, desc="Inference")):
        key = cache_key(entry)

        if key in cache:
            r = cache[key]
            r["idx"] = idx
            r["gt_items"] = parse_bbox_output(r.get("gt_text", ""))
            r["pred_items"] = parse_bbox_output(r.get("pred_text", ""))
            results.append(r)
            skipped += 1
            continue

        gt_text = ""
        for msg in entry["messages"]:
            if msg["role"] == "assistant":
                for c in msg["content"]:
                    if "text" in c:
                        gt_text = c["text"]

        gt_items = parse_bbox_output(gt_text)

        user_msgs = [m for m in entry["messages"] if m["role"] != "assistant"]
        images = []
        clean_user = []
        for msg in user_msgs:
            clean_content = []
            for c in msg["content"]:
                if c["type"] == "image":
                    img_path = c.get("image", "")
                    full_path = DATASET_DIR / "test" / img_path
                    if full_path.exists():
                        images.append(Image.open(full_path).convert("RGB"))
                    clean_content.append({"type": "image"})
                else:
                    clean_content.append(c)
            clean_user.append({"role": msg["role"], "content": clean_content})

        prompt = processor.apply_chat_template(
            clean_user, add_generation_prompt=True, tokenize=False
        )

        try:
            inputs = processor(
                text=[prompt], images=images if images else None, return_tensors="pt"
            )
            inputs = {
                k: v.to(device=device, dtype=torch.bfloat16)
                if v.is_floating_point()
                else v.to(device)
                for k, v in inputs.items()
            }

            start_time = time.time()
            with torch.no_grad():
                output_ids = model.generate(
                    **inputs, max_new_tokens=2048, do_sample=False
                )
            elapsed = time.time() - start_time
            total_time += elapsed

            gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
            pred_text = processor.tokenizer.decode(
                gen_ids, skip_special_tokens=True
            ).strip()
            pred_items = parse_bbox_output(pred_text)

        except Exception as e:
            print(f"  Error on sample {idx}: {e}")
            traceback.print_exc()
            pred_text = ""
            pred_items = []
            elapsed = 0

        r = {
            "idx": idx,
            "page_id": entry.get("page_id", idx),
            "gt_text": gt_text,
            "pred_text": pred_text,
            "gt_items": gt_items,
            "pred_items": pred_items,
            "num_gt_bubbles": len(gt_items),
            "num_pred_bubbles": len(pred_items),
            "inference_time": elapsed,
            "image_file": entry.get("image_file", ""),
            "resized_size": entry.get("resized_size", [0, 0]),
        }
        results.append(r)
        cache[key] = {k: v for k, v in r.items() if k != "idx"}
        if len(cache) % 10 == 0:
            save_cache(CACHE_LIGHTON, cache)

    save_cache(CACHE_LIGHTON, cache)
    avg_time = total_time / max(len(results) - skipped, 1)
    print(f"  Avg inference time: {avg_time:.3f}s/sample, Total: {total_time:.1f}s, Cached: {skipped}/{len(entries)}")
    return results


def call_gemma_single(image_path, api_key, max_retries=5):
    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode("utf-8")

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": GEMMA_PROMPT},
                    {"inlineData": {"mimeType": "image/jpeg", "data": img_b64}},
                ]
            }
        ],
        "generationConfig": {"responseMimeType": "application/json"},
    }

    for attempt in range(max_retries):
        try:
            resp = requests.post(
                f"{GEMMA_API_URL}?key={api_key}",
                json=payload,
                timeout=120,
            )

            if resp.status_code == 429:
                wait = min(60, 5 * (2 ** attempt))
                print(f"    Rate limited, waiting {wait}s...", flush=True)
                time.sleep(wait)
                continue

            resp.raise_for_status()
            data = resp.json()

            candidates = data.get("candidates", [])
            if not candidates:
                return [], ""

            parts = candidates[0].get("content", {}).get("parts", [])
            answer_text = None
            for part in parts:
                if not part.get("thought", False) and "text" in part:
                    answer_text = part["text"]
                    break
            if not answer_text:
                for part in parts:
                    if "text" in part:
                        answer_text = part["text"]
                        break

            if not answer_text:
                return [], ""

            try:
                bubbles = json.loads(answer_text)
            except json.JSONDecodeError:
                json_match = re.search(r"```(?:json)?\s*(.*?)```", answer_text, re.DOTALL)
                if json_match:
                    bubbles = json.loads(json_match.group(1))
                else:
                    return [], answer_text

            if not isinstance(bubbles, list):
                return [], answer_text

            items = []
            for b in bubbles:
                text = b.get("text", b.get("content", ""))
                bbox = b.get("bbox", b.get("pos", []))
                if text and len(bbox) == 4:
                    scaled = [int(round(v * 10)) for v in bbox]
                    items.append(
                        {
                            "text": str(text).strip(),
                            "bbox": scaled,
                        }
                    )

            raw_text = "\n".join(
                f"{it['text']} [{it['bbox'][0]},{it['bbox'][1]},{it['bbox'][2]},{it['bbox'][3]}]"
                for it in items
            )
            return items, raw_text

        except requests.exceptions.RequestException as e:
            if attempt < max_retries - 1:
                wait = 10 * (2 ** attempt)
                print(f"    API error: {e}, retrying in {wait}s...", flush=True)
                time.sleep(wait)
            else:
                print(f"    API error after {max_retries} retries: {e}", flush=True)
                return [], ""

    return [], ""


def run_gemma_inference(entries, api_key):
    cache = load_cache(CACHE_GEMMA)
    results = [None] * len(entries)
    lock = threading.Lock()
    completed = [0]
    total = len(entries)

    to_process = []
    for idx, entry in enumerate(entries):
        key = cache_key(entry)
        if key in cache:
            r = cache[key]
            r["idx"] = idx
            r["gt_items"] = parse_bbox_output(r.get("gt_text", ""))
            r["pred_items"] = parse_bbox_output(r.get("pred_text", ""))
            results[idx] = r
            with lock:
                completed[0] += 1
        else:
            to_process.append((idx, entry))

    if to_process:
        print(f"  [Gemma] {total - len(to_process)}/{total} cached, {len(to_process)} to process", flush=True)

    def process_one(idx, entry):
        key = cache_key(entry)
        image_file = entry.get("image_file", "")
        image_path = DATASET_DIR / "test" / image_file

        gt_text = ""
        for msg in entry["messages"]:
            if msg["role"] == "assistant":
                for c in msg["content"]:
                    if "text" in c:
                        gt_text = c["text"]

        gt_items = parse_bbox_output(gt_text)

        start_time = time.time()
        if not image_path.exists():
            pred_items, pred_text = [], ""
            elapsed = 0
        else:
            try:
                pred_items, pred_text = call_gemma_single(image_path, api_key)
            except Exception as e:
                print(f"  Gemma error on sample {idx}: {e}", flush=True)
                pred_items, pred_text = [], ""
            elapsed = time.time() - start_time

        with lock:
            completed[0] += 1
            print(
                f"  [Gemma] {completed[0]}/{total} ({elapsed:.1f}s)",
                flush=True,
            )

        return idx, key, {
            "idx": idx,
            "page_id": entry.get("page_id", idx),
            "gt_text": gt_text,
            "pred_text": pred_text,
            "gt_items": gt_items,
            "pred_items": pred_items,
            "num_gt_bubbles": len(gt_items),
            "num_pred_bubbles": len(pred_items),
            "inference_time": elapsed,
            "image_file": image_file,
            "resized_size": entry.get("resized_size", [0, 0]),
        }

    if to_process:
        with ThreadPoolExecutor(max_workers=GEMMA_MAX_WORKERS) as executor:
            futures = [
                executor.submit(process_one, idx, entry)
                for idx, entry in to_process
            ]
            for future in as_completed(futures):
                idx, key, result = future.result()
                results[idx] = result
                cache[key] = {k: v for k, v in result.items() if k != "idx"}
                if len(cache) % 5 == 0:
                    save_cache(CACHE_GEMMA, cache)

        save_cache(CACHE_GEMMA, cache)

    total_api_time = sum(r["inference_time"] for r in results if r)
    avg_time = total_api_time / max(len([r for r in results if r and r["inference_time"] > 0]), 1)
    print(
        f"  Gemma total API time: {total_api_time:.1f}s, avg: {avg_time:.2f}s/sample",
        flush=True,
    )
    return results


def compute_all_metrics(results):
    metrics = {
        "num_samples": len(results),
        "total_gt_bubbles": 0,
        "total_pred_bubbles": 0,
    }

    all_cer = []
    all_wer = []
    all_levenshtein = []
    all_ious_matched = []
    all_gious_matched = []
    all_center_dists = []
    all_bbox_area_error = []

    precision_per_threshold = {t: [] for t in IOU_THRESHOLDS}
    recall_per_threshold = {t: [] for t in IOU_THRESHOLDS}
    f1_per_threshold = {t: [] for t in IOU_THRESHOLDS}

    all_inference_times = []
    detection_rates = []
    exact_matches = 0
    per_sample = []

    for r in results:
        gt_items = r["gt_items"]
        pred_items = r["pred_items"]
        n_gt = len(gt_items)
        n_pred = len(pred_items)
        metrics["total_gt_bubbles"] += n_gt
        metrics["total_pred_bubbles"] += n_pred
        all_inference_times.append(r["inference_time"])

        if n_gt == 0 and n_pred == 0:
            exact_matches += 1
            per_sample.append(
                {
                    "cer": 0.0,
                    "wer": 0.0,
                    "exact_match": True,
                    "num_gt": 0,
                    "num_pred": 0,
                    "detection_rate": 1.0,
                    "mean_iou": 1.0,
                    "precision_50": 1.0,
                    "recall_50": 1.0,
                }
            )
            continue

        det_rate = min(n_pred, n_gt) / max(n_gt, 1)
        detection_rates.append(det_rate)

        if n_gt > 0 and n_pred > 0 and n_pred == n_gt:
            if r["pred_text"].strip() == r["gt_text"].strip():
                exact_matches += 1

        cer_vals = []
        wer_vals = []
        lev_vals = []
        ious = []

        for threshold in IOU_THRESHOLDS:
            matched, unmatched_gt, unmatched_pred = match_predictions_to_gt(
                pred_items, gt_items, iou_threshold=threshold
            )
            tp = len(matched)
            fp = len(unmatched_pred)
            fn = len(unmatched_gt)
            prec = tp / max(tp + fp, 1)
            rec = tp / max(tp + fn, 1)
            f1 = 2 * prec * rec / max(prec + rec, 1e-10)
            precision_per_threshold[threshold].append(prec)
            recall_per_threshold[threshold].append(rec)
            f1_per_threshold[threshold].append(f1)

            if threshold == 0.5:
                for pred_idx, gt_idx, iou_val in matched:
                    cer_vals.append(
                        compute_cer_single(
                            pred_items[pred_idx]["text"], gt_items[gt_idx]["text"]
                        )
                    )
                    wer_vals.append(
                        compute_wer_single(
                            pred_items[pred_idx]["text"], gt_items[gt_idx]["text"]
                        )
                    )
                    lev_vals.append(
                        levenshtein_distance(
                            pred_items[pred_idx]["text"], gt_items[gt_idx]["text"]
                        )
                    )
                    ious.append(iou_val)
                    all_ious_matched.append(iou_val)
                    all_gious_matched.append(
                        compute_giou(
                            pred_items[pred_idx]["bbox"], gt_items[gt_idx]["bbox"]
                        )
                    )
                    all_center_dists.append(
                        compute_bbox_center_distance(
                            pred_items[pred_idx]["bbox"], gt_items[gt_idx]["bbox"]
                        )
                    )
                    gt_area = max(
                        0,
                        (gt_items[gt_idx]["bbox"][2] - gt_items[gt_idx]["bbox"][0])
                        * (gt_items[gt_idx]["bbox"][3] - gt_items[gt_idx]["bbox"][1]),
                    )
                    pred_area = max(
                        0,
                        (
                            pred_items[pred_idx]["bbox"][2]
                            - pred_items[pred_idx]["bbox"][0]
                        )
                        * (
                            pred_items[pred_idx]["bbox"][3]
                            - pred_items[pred_idx]["bbox"][1]
                        ),
                    )
                    if gt_area > 0:
                        all_bbox_area_error.append(abs(pred_area - gt_area) / gt_area)

        sample_cer = np.mean(cer_vals) if cer_vals else 1.0
        sample_wer = np.mean(wer_vals) if wer_vals else 1.0
        sample_iou = np.mean(ious) if ious else 0.0
        all_cer.append(sample_cer)
        all_wer.append(sample_wer)
        all_levenshtein.append(np.mean(lev_vals) if lev_vals else 0.0)

        per_sample.append(
            {
                "cer": sample_cer,
                "wer": sample_wer,
                "exact_match": False,
                "num_gt": n_gt,
                "num_pred": n_pred,
                "detection_rate": det_rate,
                "mean_iou": sample_iou,
                "precision_50": precision_per_threshold[0.5][-1]
                if precision_per_threshold[0.5]
                else 0,
                "recall_50": recall_per_threshold[0.5][-1]
                if recall_per_threshold[0.5]
                else 0,
            }
        )

    metrics["cer"] = float(np.mean(all_cer)) if all_cer else 1.0
    metrics["wer"] = float(np.mean(all_wer)) if all_wer else 1.0
    metrics["exact_match_rate"] = exact_matches / max(len(results), 1)
    metrics["mean_levenshtein"] = (
        float(np.mean(all_levenshtein)) if all_levenshtein else 0.0
    )

    metrics["mean_iou"] = float(np.mean(all_ious_matched)) if all_ious_matched else 0.0
    metrics["median_iou"] = (
        float(np.median(all_ious_matched)) if all_ious_matched else 0.0
    )
    metrics["mean_giou"] = (
        float(np.mean(all_gious_matched)) if all_gious_matched else 0.0
    )
    metrics["mean_center_dist"] = (
        float(np.mean(all_center_dists)) if all_center_dists else 0.0
    )
    metrics["mean_bbox_area_error"] = (
        float(np.mean(all_bbox_area_error)) if all_bbox_area_error else 0.0
    )

    for threshold in IOU_THRESHOLDS:
        p = precision_per_threshold[threshold]
        r = recall_per_threshold[threshold]
        f = f1_per_threshold[threshold]
        t_str = str(threshold).replace(".", "_")
        metrics[f"precision@{t_str}"] = float(np.mean(p)) if p else 0.0
        metrics[f"recall@{t_str}"] = float(np.mean(r)) if r else 0.0
        metrics[f"f1@{t_str}"] = float(np.mean(f)) if f else 0.0

    metrics["avg_inference_time"] = (
        float(np.mean(all_inference_times)) if all_inference_times else 0.0
    )
    metrics["avg_detection_rate"] = (
        float(np.mean(detection_rates)) if detection_rates else 0.0
    )

    metrics["iou_distribution"] = (
        [float(x) for x in all_ious_matched] if all_ious_matched else []
    )
    metrics["cer_distribution"] = [float(x) for x in all_cer] if all_cer else []
    metrics["bbox_area_error_distribution"] = (
        [float(x) for x in all_bbox_area_error] if all_bbox_area_error else []
    )
    metrics["per_sample"] = per_sample

    ious = metrics["iou_distribution"]
    metrics["iou_std"] = float(np.std(ious)) if ious else 0.0
    metrics["iou_p10"] = float(np.percentile(ious, 10)) if ious else 0.0
    metrics["iou_p25"] = float(np.percentile(ious, 25)) if ious else 0.0
    metrics["iou_p75"] = float(np.percentile(ious, 75)) if ious else 0.0
    metrics["iou_p90"] = float(np.percentile(ious, 90)) if ious else 0.0
    metrics["iou_p95"] = float(np.percentile(ious, 95)) if ious else 0.0
    metrics["iou_max"] = float(np.max(ious)) if ious else 0.0
    metrics["iou_min"] = float(np.min(ious)) if ious else 0.0

    cer_d = metrics["cer_distribution"]
    metrics["cer_std"] = float(np.std(cer_d)) if cer_d else 0.0
    metrics["cer_median"] = float(np.median(cer_d)) if cer_d else 1.0
    metrics["cer_p90"] = float(np.percentile(cer_d, 90)) if cer_d else 1.0

    metrics["combined_score"] = (
        (1 - metrics["cer"]) * 0.4
        + metrics["f1@0_5"] * 0.3
        + metrics["mean_iou"] * 0.2
        + metrics["avg_detection_rate"] * 0.1
    )

    return metrics


def draw_sample_result(entry, pred_items, gt_items, output_path):
    img_path = DATASET_DIR / "test" / entry.get("image_file", "")
    if not img_path.exists():
        return

    image = Image.open(img_path).convert("RGB")
    w, h = image.size
    draw = ImageDraw.Draw(image)

    try:
        font = ImageFont.truetype("arial.ttf", 12)
    except:
        font = ImageFont.load_default()

    for item in gt_items:
        bbox = item["bbox"]
        x1 = int(bbox[0] * w / 1000)
        y1 = int(bbox[1] * h / 1000)
        x2 = int(bbox[2] * w / 1000)
        y2 = int(bbox[3] * h / 1000)
        draw.rectangle([x1, y1, x2, y2], outline="#00FF00", width=2)

    for item in pred_items:
        bbox = item["bbox"]
        x1 = int(min(bbox[0], bbox[2]) * w / 1000)
        y1 = int(min(bbox[1], bbox[3]) * h / 1000)
        x2 = int(max(bbox[0], bbox[2]) * w / 1000)
        y2 = int(max(bbox[1], bbox[3]) * h / 1000)
        draw.rectangle([x1, y1, x2, y2], outline="#FF0000", width=2)

    gt_patch = mpatches.Patch(color="#00FF00", label="Ground Truth")
    pred_patch = mpatches.Patch(color="#FF0000", label="Prediction")

    fig, ax = plt.subplots(1, 1, figsize=(10, 14))
    ax.imshow(image)
    ax.legend(handles=[gt_patch, pred_patch], loc="upper right", fontsize=8)
    ax.set_title(f"Poneglyph - Page {entry.get('page_id', '?')}", fontsize=10)
    ax.axis("off")
    fig.savefig(output_path, dpi=120, bbox_inches="tight")
    plt.close(fig)


def print_model_metrics(m, label):
    print(f"\n  --- {label} ---")
    print(f"  CER:              {m['cer']:.4f}")
    print(f"  WER:              {m['wer']:.4f}")
    print(f"  CER Median:       {m['cer_median']:.4f}")
    print(f"  Exact Match:      {m['exact_match_rate']:.4f}")
    print(f"  Mean IoU:         {m['mean_iou']:.4f}")
    print(f"  Median IoU:       {m['median_iou']:.4f}")
    print(f"  IoU P25/P75:      {m['iou_p25']:.4f} / {m['iou_p75']:.4f}")
    print(f"  F1@0.5:           {m['f1@0_5']:.4f}")
    print(f"  Precision@0.5:    {m['precision@0_5']:.4f}")
    print(f"  Recall@0.5:       {m['recall@0_5']:.4f}")
    print(f"  Detection Rate:   {m['avg_detection_rate']:.4f}")
    print(f"  Avg Inference:    {m['avg_inference_time']:.3f}s")
    print(f"  Combined Score:   {m['combined_score']:.4f}")


def print_comparison(lighton_m, gemma_m):
    keys = [
        ("CER", "cer", False),
        ("WER", "wer", False),
        ("Mean IoU", "mean_iou", True),
        ("Median IoU", "median_iou", True),
        ("F1@0.5", "f1@0_5", True),
        ("Precision@0.5", "precision@0_5", True),
        ("Recall@0.5", "recall@0_5", True),
        ("Detection Rate", "avg_detection_rate", True),
        ("Combined Score", "combined_score", True),
        ("Avg Inference", "avg_inference_time", False),
    ]

    print(f"\n{'=' * 70}")
    print(f"  COMPARISON: LightOn vs Gemma {GEMMA_MODEL}")
    print(f"{'=' * 70}")
    print(f"  {'Metric':<20} {'LightOn':>12} {'Gemma':>12} {'Winner':>10}")
    print(f"  {'-' * 54}")

    for name, key, higher_better in keys:
        lv = lighton_m.get(key, 0)
        gv = gemma_m.get(key, 0)
        if higher_better:
            winner = "LightOn" if lv > gv else "Gemma" if gv > lv else "Tie"
        else:
            winner = "LightOn" if lv < gv else "Gemma" if gv < lv else "Tie"
        print(f"  {name:<20} {lv:>12.4f} {gv:>12.4f} {winner:>10}")

    print(f"{'=' * 70}")


def main():
    print("=" * 70)
    print("  PONEGLYPH BBOX BENCHMARK (LightOn vs Gemma)")
    print("=" * 70)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    GRAPHS_DIR.mkdir(parents=True, exist_ok=True)
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)

    entries = load_test_dataset()

    print(f"\nLoading model: {MODEL_ID}")
    processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
    processor.image_processor.default_to_square = False
    processor.tokenizer.padding_side = "left"

    model = LightOnOcrForConditionalGeneration.from_pretrained(
        MODEL_ID, torch_dtype=torch.bfloat16, device_map="auto"
    )
    model.generation_config.do_sample = False
    model.generation_config.max_new_tokens = 2048

    print(f"\nStarting parallel inference:")
    print(f"  - LightOn: {len(entries)} samples (local GPU)")
    print(f"  - Gemma {GEMMA_MODEL}: {len(entries)} samples (API, {GEMMA_MAX_WORKERS} concurrent)")

    benchmark_start = time.time()

    lighton_results_holder = [None]
    gemma_results_holder = [None]

    def lighton_worker():
        lighton_results_holder[0] = run_inference(model, processor, entries)

    def gemma_worker():
        gemma_results_holder[0] = run_gemma_inference(entries, GEMMA_API_KEY)

    lighton_thread = threading.Thread(target=lighton_worker)
    gemma_thread = threading.Thread(target=gemma_worker)

    lighton_thread.start()
    gemma_thread.start()

    lighton_thread.join()
    gemma_thread.join()

    wall_time = time.time() - benchmark_start
    print(f"\nParallel inference completed in {wall_time:.1f}s")

    lighton_results = lighton_results_holder[0]
    gemma_results = gemma_results_holder[0]

    print("\nComputing LightOn metrics...")
    lighton_metrics = compute_all_metrics(lighton_results)

    print("Computing Gemma metrics...")
    gemma_metrics = compute_all_metrics(gemma_results)

    for i in range(min(5, len(entries))):
        draw_sample_result(
            entries[i],
            lighton_results[i]["pred_items"],
            lighton_results[i]["gt_items"],
            SAMPLES_DIR / f"sample_{i}_lighton.png",
        )
        draw_sample_result(
            entries[i],
            gemma_results[i]["pred_items"],
            gemma_results[i]["gt_items"],
            SAMPLES_DIR / f"sample_{i}_gemma.png",
        )

    del model
    gc.collect()
    torch.cuda.empty_cache()

    results_path = OUTPUT_DIR / "metrics.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(lighton_metrics, f, indent=2, ensure_ascii=False)
    print(f"LightOn results saved to {results_path}")

    gemma_path = OUTPUT_DIR / "metrics_gemma.json"
    with open(gemma_path, "w", encoding="utf-8") as f:
        json.dump(gemma_metrics, f, indent=2, ensure_ascii=False)
    print(f"Gemma results saved to {gemma_path}")

    comparison = {
        "lighton": {
            k: v for k, v in lighton_metrics.items() if not isinstance(v, list)
        },
        "gemma": {k: v for k, v in gemma_metrics.items() if not isinstance(v, list)},
    }
    comparison_path = OUTPUT_DIR / "metrics_comparison.json"
    with open(comparison_path, "w", encoding="utf-8") as f:
        json.dump(comparison, f, indent=2, ensure_ascii=False)
    print(f"Comparison saved to {comparison_path}")

    print(f"\n{'=' * 70}")
    print(f"  METRICS SUMMARY")
    print(f"{'=' * 70}")
    print_model_metrics(lighton_metrics, "LightOn (fine-tuned)")
    print_model_metrics(gemma_metrics, f"Gemma {GEMMA_MODEL} (one-shot API)")
    print_comparison(lighton_metrics, gemma_metrics)

    print(f"\nBenchmark complete!")
    return lighton_metrics, gemma_metrics


if __name__ == "__main__":
    main()
