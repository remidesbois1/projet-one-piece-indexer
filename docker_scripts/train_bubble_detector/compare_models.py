import os
import sys
from pathlib import Path

import requests
import torch
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
OLD_MODEL_URL = "https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector_Nano/resolve/main/onepiece_detector_nano.onnx"
DATASET_YAML = SCRIPT_DIR / "dataset" / "data.yaml"
IMGSZ = 800


def find_latest_run():
    runs_dir = SCRIPT_DIR / "runs"
    if not runs_dir.exists():
        return None
    all_runs = sorted(runs_dir.glob("yolo26n_bubble*"), key=os.path.getmtime, reverse=True)
    return all_runs[0] if all_runs else None


def download_old_model():
    path = SCRIPT_DIR / "old_model_nano.onnx"
    if not path.exists():
        print("  Downloading current production model from HuggingFace...")
        resp = requests.get(OLD_MODEL_URL, timeout=60)
        resp.raise_for_status()
        with open(path, "wb") as f:
            f.write(resp.content)
        print(f"  Saved to: {path}")
    else:
        print(f"  Using cached model: {path}")
    return path


def validate_model(model_path, label):
    device = 0 if torch.cuda.is_available() else "cpu"
    model = YOLO(model_path)
    results = model.val(data=str(DATASET_YAML), imgsz=IMGSZ, device=device, verbose=False)
    map50 = results.results_dict.get("metrics/mAP50(B)", 0)
    map50_95 = results.results_dict.get("metrics/mAP50-95(B)", 0)
    return map50, map50_95


def compare() -> bool:
    print()
    print("=" * 60)
    print("  MODEL COMPARISON")
    print("=" * 60)
    print()

    run_dir = find_latest_run()
    if not run_dir:
        print("  [ERROR] No training runs found. Run training first.")
        return False

    new_model_path = run_dir / "weights" / "best.pt"
    if not new_model_path.exists():
        print(f"  [ERROR] Best model not found: {new_model_path}")
        return False

    print(f"  New model: {new_model_path.name} ({run_dir.name})")

    try:
        old_model_path = download_old_model()
    except Exception as e:
        print(f"  [WARN] Could not download old model: {e}")
        print("  Assuming new model is better (no baseline to compare).")
        return True

    print()
    print("  Validating new model...")
    new_map50, new_map50_95 = validate_model(new_model_path, "new")

    print("  Validating production model...")
    try:
        old_map50, old_map50_95 = validate_model(old_model_path, "old")
    except Exception as e:
        print(f"  [WARN] Could not validate old model: {e}")
        old_map50 = 0.0
        old_map50_95 = 0.0

    print()
    print("-" * 60)
    print("  RESULTS")
    print("-" * 60)
    print(f"  {'Model':<22} {'mAP50':>10} {'mAP50-95':>10}")
    print(f"  {'-' * 22} {'-' * 10} {'-' * 10}")
    print(f"  {'Production (old)':<22} {old_map50:>10.4f} {old_map50_95:>10.4f}")
    print(f"  {'New (YOLO26n)':<22} {new_map50:>10.4f} {new_map50_95:>10.4f}")
    print()

    delta = new_map50 - old_map50
    is_better = new_map50 > old_map50

    if is_better:
        print(f"  New model is BETTER by +{delta:.4f} mAP50")
    else:
        print(f"  New model is WORSE by {delta:.4f} mAP50")

    print()
    print("=" * 60)
    if is_better:
        print("  RESULT: New model will be uploaded")
    else:
        print("  RESULT: Keeping production model")
    print("=" * 60)

    return is_better


if __name__ == "__main__":
    result = compare()
    sys.exit(0 if result else 1)
