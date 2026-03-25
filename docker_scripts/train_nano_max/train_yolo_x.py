from ultralytics import YOLO
from pathlib import Path
import torch

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_YAML = SCRIPT_DIR / "dataset" / "data.yaml"

def train():
    model = YOLO("yolo11x.pt")
    
    device = 0 if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")

    results = model.train(
        data=str(DATASET_YAML),
        epochs=120,
        imgsz=1024,
        batch=6,
        workers=8,
        patience=25,
        save=True,
        device=device, 
        project=str(SCRIPT_DIR / "runs"),
        name="yolo11x_bubble"
    )

    print("YOLO11x training complete.")
    
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
    return best_model_path, onnx_path

if __name__ == "__main__":
    train()
