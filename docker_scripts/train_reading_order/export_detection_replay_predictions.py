from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
DEFAULT_ANNOTATIONS = (
    SCRIPT_DIR.parent / "train_panel_detector" / "panel_annotation_dataset" / "panel_annotations.json"
)
DEFAULT_SPLIT_MANIFEST = SCRIPT_DIR.parent / "train_panel_detector" / "dataset" / "manifest.json"
DEFAULT_OUTPUT = SCRIPT_DIR / "predictions" / "detector_replay_predictions.json"
DEFAULT_CACHE_DIR = SCRIPT_DIR / "models" / "downloaded"

BUBBLE_SOURCE_REPO = "Remidesbois/YoloPiece_BubbleDetector_Nano"
BUBBLE_SOURCE_FILE = "onepiece_detector_nano.onnx"
PANEL_SOURCE_REPO = "Remidesbois/YoloPiece_OneShot_Models"
PANEL_SOURCE_FILE = "panel_detector.onnx"


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp_path.replace(path)


def to_int(value: Any, default: int | None = None) -> int | None:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def resolve_image_base_dir(annotations_path: Path, annotations: dict[str, Any]) -> Path:
    dataset_file = annotations.get("dataset_file")
    if dataset_file:
        dataset_path = Path(dataset_file)
        if dataset_path.exists():
            return dataset_path.parent
    return annotations_path.parent


def manifest_ids(manifest_path: Path, split: str) -> set[int] | None:
    if split == "all" or not manifest_path.exists():
        return None
    manifest = read_json(manifest_path)
    items = (manifest.get("splits") or {}).get(split, {}).get("items") or []
    ids = {int(item["page_id"]) for item in items if "page_id" in item}
    return ids or None


def iter_pages(
    annotations_path: Path,
    manifest_path: Path,
    split: str,
) -> tuple[list[dict[str, Any]], Path]:
    annotations = read_json(annotations_path)
    image_base_dir = resolve_image_base_dir(annotations_path, annotations)
    ids = manifest_ids(manifest_path, split)
    pages = []
    for page in annotations.get("pages") or []:
        page_id = to_int(page.get("page_id"))
        if page_id is None:
            continue
        if ids is not None and page_id not in ids:
            continue
        image_file = page.get("image_file")
        if not image_file:
            continue
        image_path = (image_base_dir / image_file).resolve()
        if not image_path.exists():
            continue
        pages.append({**page, "page_id": page_id, "image_path": str(image_path)})
    return pages, image_base_dir


def download_hf_file(repo_id: str, filename: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
    urllib.request.urlretrieve(url, destination)
    return destination


def first_existing(paths: Iterable[Path]) -> Path | None:
    for path in paths:
        if path and path.exists():
            return path
    return None


def panel_detector_candidates() -> list[Path]:
    candidates = [
        SCRIPT_DIR.parent / "package_one_shot_models" / "hf_package" / "panel_detector.onnx",
        SCRIPT_DIR.parent / "train_panel_detector" / "runs" / "yolo26n_panel2" / "weights" / "best.onnx",
        SCRIPT_DIR.parent / "train_panel_detector" / "runs" / "yolo26n_panel" / "weights" / "best.onnx",
    ]
    metrics_path = SCRIPT_DIR.parent / "train_panel_detector" / "metrics" / "latest_panel_metrics.json"
    if metrics_path.exists():
        metrics = read_json(metrics_path)
        onnx_model = metrics.get("onnx_model")
        if onnx_model:
            candidates.insert(0, Path(onnx_model))
    return candidates


def bubble_detector_candidates() -> list[Path]:
    candidates = [
        SCRIPT_DIR.parent / "package_one_shot_models" / "hf_package" / "bubble_detector.onnx",
    ]
    override = os.getenv("BUBBLE_DETECTOR_ONNX")
    if override:
        candidates.insert(0, Path(override))
    return candidates


def resolve_model_path(
    explicit_path: Path | None,
    candidates: Iterable[Path],
    repo_id: str,
    filename: str,
    cache_dir: Path,
) -> tuple[Path, str]:
    if explicit_path is not None:
        if not explicit_path.exists():
            raise FileNotFoundError(f"Model path does not exist: {explicit_path}")
        return explicit_path.resolve(), "explicit"
    existing = first_existing(candidates)
    if existing is not None:
        return existing.resolve(), "local"
    destination = cache_dir / filename
    download_hf_file(repo_id, filename, destination)
    return destination.resolve(), f"hf:{repo_id}/{filename}"


def yolo_boxes_to_json(result: Any) -> list[dict[str, Any]]:
    boxes = getattr(result, "boxes", None)
    if boxes is None or len(boxes) == 0:
        return []
    xyxy = boxes.xyxy.cpu().numpy()
    confs = boxes.conf.cpu().numpy() if boxes.conf is not None else [1.0] * len(xyxy)
    output = []
    for box, conf in zip(xyxy, confs):
        x1, y1, x2, y2 = [float(value) for value in box[:4]]
        w = max(0.0, x2 - x1)
        h = max(0.0, y2 - y1)
        if w <= 0 or h <= 0:
            continue
        output.append(
            {
                "bbox": {
                    "x": round(x1, 3),
                    "y": round(y1, 3),
                    "w": round(w, 3),
                    "h": round(h, 3),
                },
                "conf": round(float(conf), 6),
            }
        )
    return output


def predict_boxes(model: Any, image_path: Path, imgsz: int, conf: float) -> list[dict[str, Any]]:
    results = model.predict(
        source=str(image_path),
        imgsz=imgsz,
        conf=conf,
        verbose=False,
    )
    if not results:
        return []
    return yolo_boxes_to_json(results[0])


def export_predictions(args: argparse.Namespace) -> dict[str, Any]:
    if not args.annotations.exists():
        raise FileNotFoundError(f"Missing panel annotations file: {args.annotations}")

    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise RuntimeError(
            "ultralytics is required to export detector replay predictions. "
            "Install docker_scripts/train_panel_detector/requirements.txt."
        ) from exc

    pages, image_base_dir = iter_pages(args.annotations, args.split_manifest, args.split)
    if not pages:
        raise ValueError(
            f"No pages with local images found for split '{args.split}' in {args.annotations}."
        )

    bubble_model_path, bubble_source = resolve_model_path(
        args.bubble_model,
        bubble_detector_candidates(),
        BUBBLE_SOURCE_REPO,
        BUBBLE_SOURCE_FILE,
        args.cache_dir,
    )
    panel_model_path, panel_source = resolve_model_path(
        args.panel_model,
        panel_detector_candidates(),
        PANEL_SOURCE_REPO,
        PANEL_SOURCE_FILE,
        args.cache_dir,
    )

    bubble_model = YOLO(str(bubble_model_path))
    panel_model = YOLO(str(panel_model_path))

    records = []
    for index, page in enumerate(pages, start=1):
        image_path = Path(page["image_path"])
        print(f"[{index}/{len(pages)}] {page['page_id']} {image_path.name}", flush=True)
        records.append(
            {
                "page_id": page["page_id"],
                "image_file": page.get("image_file"),
                "image_path": str(image_path),
                "width": page.get("width"),
                "height": page.get("height"),
                "bubbles": predict_boxes(
                    bubble_model,
                    image_path,
                    imgsz=args.bubble_imgsz,
                    conf=args.bubble_conf,
                ),
                "panels": predict_boxes(
                    panel_model,
                    image_path,
                    imgsz=args.panel_imgsz,
                    conf=args.panel_conf,
                ),
            }
        )

    payload = {
        "kind": "reading_order_detector_replay_predictions",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "annotations": str(args.annotations.resolve()),
        "image_base_dir": str(image_base_dir.resolve()),
        "split_manifest": str(args.split_manifest.resolve()) if args.split_manifest.exists() else None,
        "split": args.split,
        "models": {
            "bubble_detector": {
                "path": str(bubble_model_path),
                "source": bubble_source,
                "imgsz": args.bubble_imgsz,
                "conf": args.bubble_conf,
            },
            "panel_detector": {
                "path": str(panel_model_path),
                "source": panel_source,
                "imgsz": args.panel_imgsz,
                "conf": args.panel_conf,
            },
        },
        "page_count": len(records),
        "pages": records,
    }
    write_json(args.output, payload)
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run bubble and panel detectors on the panel annotation image set "
            "and export JSON for benchmark_reading_order.py --detection-predictions."
        )
    )
    parser.add_argument("--annotations", type=Path, default=DEFAULT_ANNOTATIONS)
    parser.add_argument("--split-manifest", type=Path, default=DEFAULT_SPLIT_MANIFEST)
    parser.add_argument("--split", choices=["train", "test", "all"], default="test")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--bubble-model", type=Path, default=None)
    parser.add_argument("--panel-model", type=Path, default=None)
    parser.add_argument("--bubble-imgsz", type=int, default=800)
    parser.add_argument("--panel-imgsz", type=int, default=800)
    parser.add_argument("--bubble-conf", type=float, default=0.25)
    parser.add_argument("--panel-conf", type=float, default=0.25)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        payload = export_predictions(args)
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(2)
    print(f"Wrote {payload['page_count']} pages to {args.output}")


if __name__ == "__main__":
    main()
