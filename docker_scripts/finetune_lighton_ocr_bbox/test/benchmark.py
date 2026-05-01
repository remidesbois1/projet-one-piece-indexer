import os
import sys
import json
import re
import time
import gc
import traceback
from pathlib import Path
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
OUTPUT_DIR = SCRIPT_DIR / "output"
GRAPHS_DIR = OUTPUT_DIR / "graphs"
SAMPLES_DIR = OUTPUT_DIR / "samples"

DATASET_DIR = FINETUNE_DIR / "lighton_bbox_dataset"
TEST_JSONL = DATASET_DIR / "test" / "metadata.jsonl"

BBOX_PATTERN = re.compile(r"(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]")
IOU_THRESHOLDS = [0.3, 0.5, 0.75, 0.9]

MODEL_ID = "Remidesbois/LightonOCR-2-1b-poneglyph-bbox"


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


def run_inference(model, processor, entries):
    device = next(model.parameters()).device
    results = []
    total_time = 0

    for idx, entry in enumerate(tqdm(entries, desc="Inference")):
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

        results.append(
            {
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
        )

    avg_time = total_time / max(len(results), 1)
    print(f"  Avg inference time: {avg_time:.3f}s/sample, Total: {total_time:.1f}s")
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
        x1 = int(bbox[0] * w / 10000)
        y1 = int(bbox[1] * h / 10000)
        x2 = int(bbox[2] * w / 10000)
        y2 = int(bbox[3] * h / 10000)
        draw.rectangle([x1, y1, x2, y2], outline="#00FF00", width=2)

    for item in pred_items:
        bbox = item["bbox"]
        x1 = int(bbox[0] * w / 10000)
        y1 = int(bbox[1] * h / 10000)
        x2 = int(bbox[2] * w / 10000)
        y2 = int(bbox[3] * h / 10000)
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


def main():
    print("=" * 70)
    print("  PONEGLYPH BBOX BENCHMARK")
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

    print(f"Running inference on {len(entries)} test samples...")
    inference_results = run_inference(model, processor, entries)

    print("Computing metrics...")
    metrics = compute_all_metrics(inference_results)

    for i in range(min(5, len(entries))):
        draw_sample_result(
            entries[i],
            inference_results[i]["pred_items"],
            inference_results[i]["gt_items"],
            SAMPLES_DIR / f"sample_{i}.png",
        )

    del model
    gc.collect()
    torch.cuda.empty_cache()

    results_path = OUTPUT_DIR / "metrics.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to {results_path}")

    m = metrics
    print(f"\n{'=' * 70}")
    print(f"  METRICS SUMMARY")
    print(f"{'=' * 70}")
    print(f"  CER:              {m['cer']:.4f}")
    print(f"  WER:              {m['wer']:.4f}")
    print(f"  CER Median:       {m['cer_median']:.4f}")
    print(f"  Exact Match:      {m['exact_match_rate']:.4f}")
    print(f"  Mean IoU:         {m['mean_iou']:.4f}")
    print(f"  Median IoU:       {m['median_iou']:.4f}")
    print(f"  IoU P25/P75:      {m['iou_p25']:.4f} / {m['iou_p75']:.4f}")
    print(f"  IoU P90/P95:      {m['iou_p90']:.4f} / {m['iou_p95']:.4f}")
    print(f"  F1@0.3:           {m['f1@0_3']:.4f}")
    print(f"  F1@0.5:           {m['f1@0_5']:.4f}")
    print(f"  F1@0.75:          {m['f1@0_75']:.4f}")
    print(f"  Precision@0.5:    {m['precision@0_5']:.4f}")
    print(f"  Recall@0.5:       {m['recall@0_5']:.4f}")
    print(f"  Mean GIoU:        {m['mean_giou']:.4f}")
    print(f"  Detection Rate:   {m['avg_detection_rate']:.4f}")
    print(f"  BBox Area Error:  {m['mean_bbox_area_error']:.4f}")
    print(f"  Avg Inference:    {m['avg_inference_time']:.3f}s")
    print(f"  Combined Score:   {m['combined_score']:.4f}")
    print(f"\nBenchmark complete!")
    return metrics


if __name__ == "__main__":
    main()
