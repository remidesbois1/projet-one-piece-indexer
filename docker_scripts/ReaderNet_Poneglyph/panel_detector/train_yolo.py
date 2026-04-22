from ultralytics import YOLO
from pathlib import Path
import torch

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_YAML = SCRIPT_DIR / "dataset_yolo" / "data.yaml"


def train():
    model = YOLO("yolo11m-pose.pt")

    device = 0 if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")

    results = model.train(
        data=str(DATASET_YAML),
        epochs=100,
        imgsz=800,
        batch=16,
        workers=8,
        patience=20,
        save=True,
        device=device,
        project=str(SCRIPT_DIR / "runs"),
        name="yolo11m_panel_pose",
    )

    print("Training complete.")

    best_model_path = Path(results.save_dir) / "weights" / "best.pt"
    best_model = YOLO(best_model_path)

    print(f"Exporting best model {best_model_path} to ONNX...")
    onnx_path = best_model.export(
        format="onnx",
        imgsz=800,
        simplify=True,
        opset=12,
    )

    print(f"ONNX model exported to: {onnx_path}")
    return onnx_path


if __name__ == "__main__":
    train()
