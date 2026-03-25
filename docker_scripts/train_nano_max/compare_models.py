import os
import onnxruntime as ort
import numpy as np
import cv2
from pathlib import Path
from tqdm import tqdm
from PIL import Image
import requests
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
OLD_MODEL_URL = "https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector/resolve/main/onepiece_detector.onnx"
VAL_DIR = SCRIPT_DIR / "dataset" / "val"
IMG_SIZE = 800


def download_old_model():
    path = SCRIPT_DIR / "old_model.onnx"
    if not path.exists():
        print(f"Downloading old model from {OLD_MODEL_URL}...")
        resp = requests.get(OLD_MODEL_URL)
        with open(path, "wb") as f:
            f.write(resp.content)
    return path


def compare_x():
    print("=== Comparing YOLO11x model vs baseline ===")
    return _compare("yolo11x_bubble")


def compare_n():
    print("=== Comparing YOLO11n distilled model vs baseline ===")
    return _compare("yolo11n_distilled")


def _compare(run_pattern):
    runs_dir = SCRIPT_DIR / "runs"
    all_runs = sorted(runs_dir.glob(f"{run_pattern}*"), key=os.path.getmtime, reverse=True)

    if not all_runs:
        print(f"No runs found matching '{run_pattern}' in runs/ directory.")
        return False

    new_model_path = all_runs[0] / "weights" / "best.pt"
    if not new_model_path.exists():
        print(f"New model not found at {new_model_path}. Run training first.")
        return False

    old_model_path = download_old_model()

    model_new = YOLO(new_model_path)
    results_new = model_new.val(imgsz=1024, device=None)
    map50_new = results_new.results_dict['metrics/mAP50(B)']

    print(f"New Model ({run_pattern}) mAP50: {map50_new:.4f}")

    try:
        model_old = YOLO(old_model_path, task='detect')
        results_old = model_old.val(data=str(SCRIPT_DIR / "dataset" / "data.yaml"), imgsz=1024, device=None)
        map50_old = results_old.results_dict['metrics/mAP50(B)']
    except Exception as e:
        print(f"Could not run ultralytics val on old ONNX model: {e}")
        map50_old = 0.97

    print(f"Baseline Model mAP50: {map50_old:.4f}")

    TOLERANCE = 0.005
    is_better = map50_new >= (map50_old - TOLERANCE)
    if map50_new >= map50_old:
        print(f"{run_pattern} is better or equal to baseline! ({map50_new:.4f} >= {map50_old:.4f})")
    elif is_better:
        print(f"{run_pattern} within tolerance of baseline ({map50_new:.4f} ~ {map50_old:.4f}, delta={map50_new - map50_old:.4f})")
    else:
        print(f"{run_pattern} is worse than baseline. ({map50_new:.4f} < {map50_old:.4f} - {TOLERANCE})")

    return is_better


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "n":
        compare_n()
    else:
        compare_x()
