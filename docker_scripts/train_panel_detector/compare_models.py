import os
from pathlib import Path
from ultralytics import YOLO
import requests

SCRIPT_DIR = Path(__file__).resolve().parent
OLD_MODEL_URL = "https://huggingface.co/Remidesbois/YoloPiece_PanelDetector/resolve/main/panel_detector.onnx"
DATASET_YAML = SCRIPT_DIR / "dataset_yolo" / "data.yaml"


def download_old_model():
    path = SCRIPT_DIR / "old_model.onnx"
    if not path.exists():
        print(f"Downloading old model from {OLD_MODEL_URL}...")
        try:
            resp = requests.get(OLD_MODEL_URL, timeout=30)
            resp.raise_for_status()
            with open(path, "wb") as f:
                f.write(resp.content)
        except Exception as e:
            print(f"Could not download old model: {e}")
            return None
    return path


def compare():
    print("Comparing models...")
    runs_dir = SCRIPT_DIR / "runs"
    all_runs = sorted(
        runs_dir.glob("yolo11m_panel_pose*"), key=os.path.getmtime, reverse=True
    )

    if not all_runs:
        print("No runs found in runs/ directory.")
        return False

    new_model_path = all_runs[0] / "weights" / "best.pt"
    if not new_model_path.exists():
        print(f"New model not found at {new_model_path}. Run training first.")
        return False

    # Validate new model
    model_new = YOLO(new_model_path)
    results_new = model_new.val(imgsz=800, device=None)
    map50_new = results_new.results_dict["metrics/mAP50(B)"]
    print(f"New Model mAP50: {map50_new:.4f}")

    # Try to validate old model
    old_model_path = download_old_model()
    if old_model_path and old_model_path.exists():
        try:
            model_old = YOLO(old_model_path, task="pose")
            results_old = model_old.val(data=str(DATASET_YAML), imgsz=800, device=None)
            map50_old = results_old.results_dict["metrics/mAP50(B)"]
        except Exception as e:
            print(f"Could not validate old model: {e}")
            map50_old = 0.0
    else:
        print("No old model available -- new model wins by default.")
        map50_old = 0.0

    print(f"Old Model mAP50: {map50_old:.4f}")

    is_better = map50_new > map50_old
    if is_better:
        print("New model is better!")
    else:
        print("New model is not better.")

    return is_better


if __name__ == "__main__":
    compare()
