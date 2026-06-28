import argparse
import csv
import json
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import torch
import yaml
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_DIR = Path("/app/dataset")
INTERNAL_RUNS_DIR = Path("/tmp/bubble_line_runs")
OUTPUT_RUNS_DIR = SCRIPT_DIR / "runs"
DOCKER_DATASET_YAML = SCRIPT_DIR / "dataset.docker.yaml"


def ensure_dataset_config() -> Path:
    images_train = DATASET_DIR / "images" / "train"
    images_val = DATASET_DIR / "images" / "val"
    labels_train = DATASET_DIR / "labels" / "train"
    labels_val = DATASET_DIR / "labels" / "val"

    missing = [
        path
        for path in (images_train, images_val, labels_train, labels_val)
        if not path.exists()
    ]
    if missing:
        print("[ERROR] Dataset mount is incomplete.")
        for path in missing:
            print(f"        Missing: {path}")
        print("        Mount scripts/bubble_line_dataset/dataset to /app/dataset.")
        sys.exit(1)

    config = {
        "path": str(DATASET_DIR),
        "train": "images/train",
        "val": "images/val",
        "names": {0: "line"},
    }
    DOCKER_DATASET_YAML.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return DOCKER_DATASET_YAML


def dataset_counts() -> dict[str, int]:
    return {
        "train_images": len(list((DATASET_DIR / "images" / "train").glob("*"))),
        "val_images": len(list((DATASET_DIR / "images" / "val").glob("*"))),
        "train_labels": len(list((DATASET_DIR / "labels" / "train").glob("*.txt"))),
        "val_labels": len(list((DATASET_DIR / "labels" / "val").glob("*.txt"))),
    }


def print_config(model_name, imgsz, epochs, batch, patience, device, gpu_name, data_yaml):
    counts = dataset_counts()
    rows = [
        ("Model", model_name),
        ("Device", f"{device} ({gpu_name})"),
        ("Image size", str(imgsz)),
        ("Epochs", str(epochs)),
        ("Batch", str(batch)),
        ("Patience", str(patience)),
        ("Dataset", str(DATASET_DIR)),
        ("Data yaml", str(data_yaml)),
        ("Train images", str(counts["train_images"])),
        ("Val images", str(counts["val_images"])),
        ("Train labels", str(counts["train_labels"])),
        ("Val labels", str(counts["val_labels"])),
    ]
    for label, value in rows:
        print(f"  {label + ':':<15} {value}")


def write_metrics(metrics_path: Path, metrics: dict, train_time: float, best_path: Path, onnx_path: Path) -> None:
    payload = {
        "train_time_seconds": round(train_time, 3),
        "best_model": str(best_path),
        "onnx_model": str(onnx_path),
        "metrics": metrics,
    }
    metrics_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    csv_path = metrics_path.with_suffix(".csv")
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["metric", "value"])
        writer.writerow(["train_time_seconds", round(train_time, 3)])
        for key, value in metrics.items():
            writer.writerow([key, value])


def copy_run_to_output(save_dir: Path) -> Path:
    OUTPUT_RUNS_DIR.mkdir(parents=True, exist_ok=True)
    destination = OUTPUT_RUNS_DIR / save_dir.name
    if destination.exists():
        suffix = datetime.now().strftime("%Y%m%d_%H%M%S")
        destination = OUTPUT_RUNS_DIR / f"{save_dir.name}_{suffix}"

    shutil.copytree(save_dir, destination)
    return destination


def train(
    model_name: str = "yolo26n.pt",
    imgsz: int = 800,
    epochs: int = 100,
    batch: int = 16,
    patience: int = 20,
    workers: int = 0,
) -> tuple[Path, Path, Path]:
    data_yaml = ensure_dataset_config()
    device = 0 if torch.cuda.is_available() else "cpu"
    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"

    print()
    print("=" * 64)
    print("  TRAINING - Bubble Line Detector (YOLO26n)")
    print("=" * 64)
    print()
    print_config(model_name, imgsz, epochs, batch, patience, device, gpu_name, data_yaml)
    print()

    model = YOLO(model_name)
    run_name = f"{model_name.replace('.pt', '')}_bubble_line"

    t0 = time.time()
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        workers=workers,
        patience=patience,
        save=True,
        device=device,
        project=str(INTERNAL_RUNS_DIR),
        name=run_name,
    )
    train_time = time.time() - t0

    save_dir = Path(results.save_dir)
    best_path = save_dir / "weights" / "best.pt"
    if not best_path.exists():
        raise FileNotFoundError(f"Best model was not created: {best_path}")

    print()
    print("-" * 64)
    print("  VALIDATION METRICS")
    print("-" * 64)

    best_model = YOLO(best_path)
    val_results = best_model.val(
        data=str(data_yaml),
        imgsz=imgsz,
        device=device,
        project=str(save_dir),
        name="validation",
        exist_ok=True,
    )
    metrics = {
        key: float(value)
        for key, value in val_results.results_dict.items()
        if isinstance(value, (int, float))
    }

    for key in sorted(metrics):
        print(f"  {key:<28} {metrics[key]:.6f}")

    print()
    print("-" * 64)
    print("  ONNX EXPORT")
    print("-" * 64)

    onnx_path = Path(
        best_model.export(
            format="onnx",
            imgsz=imgsz,
            simplify=True,
            opset=12,
            nms=True,
        )
    )

    metrics_path = save_dir / "metrics.json"
    write_metrics(metrics_path, metrics, train_time, best_path, onnx_path)

    output_dir = copy_run_to_output(save_dir)
    output_best_path = output_dir / "weights" / "best.pt"
    output_onnx_path = output_dir / onnx_path.relative_to(save_dir)
    output_metrics_path = output_dir / "metrics.json"
    write_metrics(output_metrics_path, metrics, train_time, output_best_path, output_onnx_path)

    print()
    print("=" * 64)
    print(f"  TRAINING COMPLETE in {train_time / 60:.1f} min")
    print(f"  Output dir:   {output_dir}")
    print(f"  Best model:   {output_best_path}")
    print(f"  ONNX model:   {output_onnx_path}")
    print(f"  Metrics JSON: {output_metrics_path}")
    print(f"  Metrics CSV:  {output_metrics_path.with_suffix('.csv')}")
    print("=" * 64)

    return output_onnx_path, output_best_path, output_metrics_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train YOLO26n bubble line detector")
    parser.add_argument("--model", default="yolo26n.pt", help="Base model (default: yolo26n.pt)")
    parser.add_argument("--imgsz", type=int, default=800, help="Image size (default: 800)")
    parser.add_argument("--epochs", type=int, default=100, help="Number of epochs (default: 100)")
    parser.add_argument("--batch", type=int, default=16, help="Batch size (default: 16)")
    parser.add_argument("--patience", type=int, default=20, help="Early stopping patience (default: 20)")
    parser.add_argument("--workers", type=int, default=0, help="Data loader workers (default: 0)")
    args = parser.parse_args()

    train(
        model_name=args.model,
        imgsz=args.imgsz,
        epochs=args.epochs,
        batch=args.batch,
        patience=args.patience,
        workers=args.workers,
    )
