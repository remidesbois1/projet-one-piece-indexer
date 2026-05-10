import argparse
import sys
import time
from pathlib import Path

import torch
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_YAML = SCRIPT_DIR / "dataset" / "data.yaml"


def print_config(model_name, imgsz, epochs, batch, patience, device, gpu_name):
    rows = [
        ("Model", model_name),
        ("Device", f"{device} ({gpu_name})"),
        ("Image size", str(imgsz)),
        ("Epochs", str(epochs)),
        ("Batch", str(batch)),
        ("Patience", str(patience)),
        ("Dataset", str(DATASET_YAML)),
    ]
    for label, value in rows:
        print(f"  {label + ':':<14} {value}")


def train(
    model_name: str = "yolo26n.pt",
    imgsz: int = 800,
    epochs: int = 100,
    batch: int = 16,
    patience: int = 20,
) -> Path:
    if not DATASET_YAML.exists():
        print(f"[ERROR] Dataset config not found: {DATASET_YAML}")
        print("        Run export_dataset_yolo.py first.")
        sys.exit(1)

    device = 0 if torch.cuda.is_available() else "cpu"
    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"

    print()
    print("=" * 60)
    print("  TRAINING - Bubble Detector (YOLO26n)")
    print("=" * 60)
    print()
    print_config(model_name, imgsz, epochs, batch, patience, device, gpu_name)
    print()

    model = YOLO(model_name)
    run_name = f"{model_name.replace('.pt', '')}_bubble"

    t0 = time.time()
    results = model.train(
        data=str(DATASET_YAML),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        workers=8,
        patience=patience,
        save=True,
        device=device,
        project=str(SCRIPT_DIR / "runs"),
        name=run_name,
    )
    train_time = time.time() - t0

    save_dir = Path(results.save_dir)
    best_path = save_dir / "weights" / "best.pt"

    print()
    print("-" * 60)
    print("  VALIDATION")
    print("-" * 60)

    best_model = YOLO(best_path)
    metrics = best_model.val(data=str(DATASET_YAML), imgsz=imgsz, device=device)

    map50 = metrics.results_dict.get("metrics/mAP50(B)", 0)
    map50_95 = metrics.results_dict.get("metrics/mAP50-95(B)", 0)

    print()
    print(f"  mAP50:       {map50:.4f}")
    print(f"  mAP50-95:    {map50_95:.4f}")

    print()
    print("-" * 60)
    print("  ONNX EXPORT")
    print("-" * 60)

    onnx_path = best_model.export(
        format="onnx",
        imgsz=imgsz,
        simplify=True,
        opset=12,
        nms=True,
    )

    print()
    print(f"  Exported to: {onnx_path}")

    print()
    print("=" * 60)
    print(f"  TRAINING COMPLETE in {train_time / 60:.1f} min")
    print(f"  Best model:  {best_path}")
    print(f"  ONNX model:  {onnx_path}")
    print("=" * 60)

    return Path(onnx_path), best_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train YOLO bubble detector")
    parser.add_argument("--model", default="yolo26n.pt", help="Base model (default: yolo26n.pt)")
    parser.add_argument("--imgsz", type=int, default=800, help="Image size (default: 800)")
    parser.add_argument("--epochs", type=int, default=100, help="Number of epochs (default: 100)")
    parser.add_argument("--batch", type=int, default=16, help="Batch size (default: 16)")
    parser.add_argument("--patience", type=int, default=20, help="Early stopping patience (default: 20)")
    args = parser.parse_args()

    onnx_path, best_path = train(
        model_name=args.model,
        imgsz=args.imgsz,
        epochs=args.epochs,
        batch=args.batch,
        patience=args.patience,
    )
