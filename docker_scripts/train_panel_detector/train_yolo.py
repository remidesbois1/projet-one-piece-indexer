from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
from ultralytics import YOLO


SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_YAML = SCRIPT_DIR / "dataset" / "data.yaml"
RUNS_DIR = SCRIPT_DIR / "runs"
METRICS_DIR = SCRIPT_DIR / "metrics"


def as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def safe_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


def json_safe(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            return str(value)
    return value


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(json_safe(data), handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp_path.replace(path)


def detect_device(device_arg: str | int) -> str | int:
    if str(device_arg).lower() == "auto":
        return 0 if torch.cuda.is_available() else "cpu"
    if isinstance(device_arg, str) and device_arg.isdigit():
        return int(device_arg)
    return device_arg


def device_label(device: str | int) -> str:
    if device == "cpu":
        return "cpu (CPU)"
    if torch.cuda.is_available():
        index = int(device) if isinstance(device, int) else 0
        return f"{device} ({torch.cuda.get_device_name(index)})"
    return str(device)


def get_result(results: dict[str, Any], key: str, default: float = 0.0) -> float:
    value = as_float(results.get(key))
    return default if value is None else value


def summarize_metrics(metrics: Any, split: str, save_dir: Path | None = None) -> dict[str, Any]:
    raw_results = dict(getattr(metrics, "results_dict", {}) or {})
    precision = get_result(raw_results, "metrics/precision(B)")
    recall = get_result(raw_results, "metrics/recall(B)")
    map50 = get_result(raw_results, "metrics/mAP50(B)")
    map50_95 = get_result(raw_results, "metrics/mAP50-95(B)")
    f1 = 0.0
    if precision + recall > 0:
        f1 = 2 * precision * recall / (precision + recall)

    box = getattr(metrics, "box", None)
    names = getattr(metrics, "names", {}) or {}
    if isinstance(names, list):
        names = {index: name for index, name in enumerate(names)}

    per_class = []
    maps = safe_list(getattr(box, "maps", None))
    p_values = safe_list(getattr(box, "p", None))
    r_values = safe_list(getattr(box, "r", None))
    f1_values = safe_list(getattr(box, "f1", None))
    ap50_values = safe_list(getattr(box, "ap50", None))

    for class_index, class_map in enumerate(maps):
        per_class.append(
            {
                "class_id": class_index,
                "class_name": names.get(class_index, str(class_index)),
                "precision": as_float(p_values[class_index]) if class_index < len(p_values) else None,
                "recall": as_float(r_values[class_index]) if class_index < len(r_values) else None,
                "f1": as_float(f1_values[class_index]) if class_index < len(f1_values) else None,
                "mAP50": as_float(ap50_values[class_index]) if class_index < len(ap50_values) else None,
                "mAP50-95": as_float(class_map),
            }
        )

    speed = getattr(metrics, "speed", None)
    if speed is None:
        speed = {}

    return {
        "split": split,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "mAP50": map50,
        "mAP50-95": map50_95,
        "fitness": as_float(raw_results.get("fitness")),
        "speed_ms": speed,
        "raw": raw_results,
        "per_class": per_class,
        "save_dir": str(save_dir) if save_dir else str(getattr(metrics, "save_dir", "")),
    }


def print_metrics_table(title: str, summary: dict[str, Any]) -> None:
    print()
    print("-" * 60)
    print(f"  {title}")
    print("-" * 60)
    rows = [
        ("Precision", summary["precision"]),
        ("Recall", summary["recall"]),
        ("F1", summary["f1"]),
        ("mAP50", summary["mAP50"]),
        ("mAP50-95", summary["mAP50-95"]),
    ]
    for label, value in rows:
        print(f"  {label + ':':<14} {value:.4f}")
    if summary.get("save_dir"):
        print(f"  Artifacts:     {summary['save_dir']}")


def export_onnx(model: YOLO, imgsz: int) -> Path:
    onnx_path = model.export(
        format="onnx",
        imgsz=imgsz,
        simplify=True,
        opset=12,
        nms=True,
    )
    return Path(onnx_path)


def train(
    model_name: str = "yolo26n.pt",
    dataset_yaml: Path = DATASET_YAML,
    imgsz: int = 800,
    epochs: int = 100,
    batch: int = 16,
    patience: int = 20,
    workers: int = 8,
    device: str | int = "auto",
    export: bool = True,
) -> tuple[Path | None, Path, Path]:
    dataset_yaml = dataset_yaml.resolve()
    if not dataset_yaml.exists():
        print(f"[ERROR] Dataset config not found: {dataset_yaml}")
        print("        Run export_dataset_yolo.py first.")
        sys.exit(1)

    resolved_device = detect_device(device)
    print()
    print("=" * 60)
    print("  TRAINING - Panel Detector (YOLO26)")
    print("=" * 60)
    print()
    config_rows = [
        ("Model", model_name),
        ("Device", device_label(resolved_device)),
        ("Image size", imgsz),
        ("Epochs", epochs),
        ("Batch", batch),
        ("Patience", patience),
        ("Workers", workers),
        ("Dataset", dataset_yaml),
    ]
    for label, value in config_rows:
        print(f"  {label + ':':<14} {value}")
    print()

    model = YOLO(model_name)
    run_name = f"{Path(model_name).stem}_panel"

    started_at = datetime.now(timezone.utc).isoformat()
    t0 = time.time()
    train_results = model.train(
        data=str(dataset_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        workers=workers,
        patience=patience,
        save=True,
        device=resolved_device,
        project=str(RUNS_DIR),
        name=run_name,
        plots=True,
    )
    train_time = time.time() - t0

    save_dir = Path(train_results.save_dir)
    best_path = save_dir / "weights" / "best.pt"
    last_path = save_dir / "weights" / "last.pt"
    if not best_path.exists():
        raise FileNotFoundError(f"Best model not found after training: {best_path}")

    print()
    print("-" * 60)
    print("  TEST EVALUATION")
    print("-" * 60)

    best_model = YOLO(best_path)
    test_metrics = best_model.val(
        data=str(dataset_yaml),
        imgsz=imgsz,
        device=resolved_device,
        split="test",
        plots=True,
        save_json=True,
        project=str(RUNS_DIR / "eval"),
        name=f"{run_name}_test",
    )
    test_save_dir = Path(getattr(test_metrics, "save_dir", RUNS_DIR / "eval"))
    test_summary = summarize_metrics(test_metrics, split="test", save_dir=test_save_dir)
    print_metrics_table("TEST METRICS", test_summary)

    onnx_path: Path | None = None
    if export:
        print()
        print("-" * 60)
        print("  ONNX EXPORT")
        print("-" * 60)
        onnx_path = export_onnx(best_model, imgsz=imgsz)
        print(f"  Exported to: {onnx_path}")

    metrics_payload = {
        "kind": "panel_detector_training_metrics",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "started_at": started_at,
        "training_seconds": train_time,
        "model_name": model_name,
        "dataset_yaml": str(dataset_yaml),
        "imgsz": imgsz,
        "epochs": epochs,
        "batch": batch,
        "patience": patience,
        "device": str(resolved_device),
        "run_dir": str(save_dir),
        "best_model": str(best_path),
        "last_model": str(last_path),
        "onnx_model": str(onnx_path) if onnx_path else None,
        "test": test_summary,
    }
    metrics_path = save_dir / "panel_metrics.json"
    write_json(metrics_path, metrics_payload)
    write_json(METRICS_DIR / "latest_panel_metrics.json", metrics_payload)

    print()
    print("=" * 60)
    print(f"  TRAINING COMPLETE in {train_time / 60:.1f} min")
    print(f"  Best model:   {best_path}")
    if onnx_path:
        print(f"  ONNX model:   {onnx_path}")
    print(f"  Metrics JSON: {metrics_path}")
    print("=" * 60)

    return onnx_path, best_path, metrics_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a YOLO26 panel detector.")
    parser.add_argument("--model", default="yolo26n.pt", help="Base model.")
    parser.add_argument("--dataset", type=Path, default=DATASET_YAML)
    parser.add_argument("--imgsz", type=int, default=800)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--patience", type=int, default=20)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--no-export", action="store_true", help="Skip ONNX export.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    train(
        model_name=args.model,
        dataset_yaml=args.dataset,
        imgsz=args.imgsz,
        epochs=args.epochs,
        batch=args.batch,
        patience=args.patience,
        workers=args.workers,
        device=args.device,
        export=not args.no_export,
    )


if __name__ == "__main__":
    main()
