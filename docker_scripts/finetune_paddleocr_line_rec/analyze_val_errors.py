import argparse
import base64
import csv
import html
import json
from pathlib import Path

import editdistance
import torch
from PIL import Image
from tqdm import tqdm
from transformers import AutoProcessor
from transformers.models.pp_ocrv6_small_rec.modeling_pp_ocrv6_small_rec import PPOCRV6SmallRecForTextRecognition

from train_ppocrv6_rec import decode_ctc


DEFAULT_OUTPUT_DIR = Path("/workspace/outputs_paddleocr_line_rec")


def read_labels(dataset_dir: Path, split: str) -> list[tuple[str, str]]:
    rows = []
    for raw in (dataset_dir / f"rec_gt_{split}.txt").read_text(encoding="utf-8").splitlines():
        if raw.strip():
            image_path, text = raw.split("\t", 1)
            rows.append((image_path, text))
    return rows


def load_manifest(dataset_dir: Path) -> dict[str, dict]:
    manifest = {}
    path = dataset_dir / "line_manifest.jsonl"
    if not path.exists():
        return manifest
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        item = json.loads(raw)
        manifest[item["single_line_image"]] = item
    return manifest


def box_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    return inter / max(area_a + area_b - inter, 1e-6)


def duplicate_pairs(lines: list[dict], threshold: float) -> int:
    count = 0
    for i, left in enumerate(lines):
        for right in lines[i + 1 :]:
            if box_iou(left["bbox"], right["bbox"]) >= threshold:
                count += 1
    return count


def image_data_uri(path: Path) -> str:
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{payload}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze PP-OCRv6 validation errors with image previews.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--dataset-dir", type=Path, default=None)
    parser.add_argument("--model-dir", type=Path, default=None)
    parser.add_argument("--split", default="val")
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--image-width", type=int, default=640)
    parser.add_argument("--blank-penalty", type=float, default=0.0)
    parser.add_argument("--duplicate-iou", type=float, default=0.85)
    parser.add_argument("--max-html", type=int, default=120)
    args = parser.parse_args()

    dataset_dir = args.dataset_dir or (args.output_dir / "bubble_single_line_rec_dataset")
    model_dir = args.model_dir or (args.output_dir / "ppocrv6_medium_rec_line_finetune_best")
    report_dir = args.output_dir / f"{args.split}_error_analysis"
    report_dir.mkdir(parents=True, exist_ok=True)

    rows = read_labels(dataset_dir, args.split)
    manifest = load_manifest(dataset_dir)
    processor = AutoProcessor.from_pretrained(model_dir, trust_remote_code=True)
    processor.size = {"height": 48, "width": args.image_width}
    processor.pad_size = {"height": 48, "width": args.image_width}
    model = PPOCRV6SmallRecForTextRecognition.from_pretrained(model_dir, trust_remote_code=True)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    model.eval()

    details = []
    total_distance = 0
    total_chars = 0
    with torch.no_grad():
        for start in tqdm(range(0, len(rows), args.batch_size), desc=f"Analyzing {args.split}"):
            batch_rows = rows[start : start + args.batch_size]
            images = []
            for rel_path, _ in batch_rows:
                with Image.open(dataset_dir / rel_path) as image:
                    images.append(image.convert("RGB"))
            encoded = processor(images=images, return_tensors="pt")
            pixel_values = encoded["pixel_values"].to(device)
            with torch.amp.autocast(device_type="cuda", enabled=torch.cuda.is_available()):
                probabilities = model(pixel_values=pixel_values).last_hidden_state
            predictions = decode_ctc(probabilities, list(processor.character_list), blank_penalty=args.blank_penalty)
            for (rel_path, reference), prediction in zip(batch_rows, predictions):
                distance = editdistance.eval(prediction, reference)
                cer = distance / max(len(reference), 1)
                total_distance += distance
                total_chars += len(reference)
                item = manifest.get(rel_path, {})
                detected_lines = item.get("detected_lines") or []
                details.append(
                    {
                        "image": rel_path,
                        "reference": reference,
                        "prediction": prediction,
                        "cer": cer,
                        "distance": distance,
                        "ref_len": len(reference),
                        "pred_len": len(prediction),
                        "line_count": len(detected_lines),
                        "duplicate_pairs": duplicate_pairs(detected_lines, args.duplicate_iou),
                        "page_id": item.get("page_id"),
                        "bubble_id": item.get("bubble_id"),
                        "source_page_url": item.get("source_page_url"),
                    }
                )

    details.sort(key=lambda item: (item["cer"], item["distance"]), reverse=True)
    summary = {
        "split": args.split,
        "samples": len(details),
        "cer": total_distance / max(total_chars, 1),
        "exact_match": sum(item["prediction"] == item["reference"] for item in details) / max(len(details), 1),
        "with_duplicate_line_boxes": sum(item["duplicate_pairs"] > 0 for item in details),
        "mean_line_count": sum(item["line_count"] for item in details) / max(len(details), 1),
        "blank_penalty": args.blank_penalty,
        "worst": details[:20],
    }

    (report_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    with (report_dir / "predictions.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(details[0].keys()) if details else [])
        writer.writeheader()
        writer.writerows(details)

    html_rows = []
    for item in details[: args.max_html]:
        img_src = image_data_uri(dataset_dir / item["image"])
        html_rows.append(
            "<tr>"
            f"<td><img src='{img_src}'></td>"
            f"<td>{item['cer']:.3f}</td>"
            f"<td>{html.escape(item['reference'])}</td>"
            f"<td>{html.escape(item['prediction'])}</td>"
            f"<td>{item['line_count']}</td>"
            f"<td>{item['duplicate_pairs']}</td>"
            f"<td>{html.escape(str(item['bubble_id']))}</td>"
            "</tr>"
        )
    html_doc = f"""<!doctype html>
<meta charset="utf-8">
<title>PP-OCRv6 {html.escape(args.split)} errors</title>
<style>
body {{ font-family: Arial, sans-serif; margin: 24px; }}
table {{ border-collapse: collapse; width: 100%; }}
td, th {{ border: 1px solid #ddd; padding: 6px; vertical-align: top; }}
img {{ max-width: 720px; background: #f7f7f7; }}
code {{ white-space: pre-wrap; }}
</style>
<h1>PP-OCRv6 {html.escape(args.split)} errors</h1>
<p>CER: {summary['cer']:.6f}, exact match: {summary['exact_match']:.3f}, samples: {summary['samples']}, duplicate-box samples: {summary['with_duplicate_line_boxes']}</p>
<table>
<thead><tr><th>Image</th><th>CER</th><th>Reference</th><th>Prediction</th><th>Lines</th><th>Dup pairs</th><th>Bubble</th></tr></thead>
<tbody>
{''.join(html_rows)}
</tbody>
</table>
"""
    (report_dir / "worst.html").write_text(html_doc, encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
