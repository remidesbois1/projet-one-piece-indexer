from ultralytics import YOLO
from pathlib import Path
import torch

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_YAML = SCRIPT_DIR / "dataset" / "data.yaml"


def train(teacher_model_path=None):
    print(f"Starting YOLO11n training (teacher ref: {teacher_model_path})")

    model = YOLO("yolo11n.pt")

    device = 0 if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")

    results = model.train(
        data=str(DATASET_YAML),
        epochs=150,
        imgsz=1024,
        batch=16,
        workers=4,
        patience=30,
        save=True,
        device=device,
        project=str(SCRIPT_DIR / "runs"),
        name="yolo11n_distilled"
    )

    print("YOLO11n training complete.")

    best_model_path = Path(results.save_dir) / "weights" / "best.pt"
    best_model = YOLO(best_model_path)

    print(f"Exporting best model {best_model_path} to ONNX...")
    onnx_path = best_model.export(
        format="onnx",
        imgsz=1024,
        simplify=True,
        opset=12,
        nms=True
    )

    print(f"ONNX model exported to: {onnx_path}")
    return onnx_path


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        train(sys.argv[1])
    else:
        train()
