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

def preprocess_image(img_path):
    img = cv2.imread(str(img_path))
    h, w = img.shape[:2]
    scale = min(IMG_SIZE / w, IMG_SIZE / h)
    nw, nh = int(w * scale), int(h * scale)
    img_resized = cv2.resize(img, (nw, nh))
    
    pad_x = (IMG_SIZE - nw) // 2
    pad_y = (IMG_SIZE - nh) // 2
    
    img_padded = np.full((IMG_SIZE, IMG_SIZE, 3), 128, dtype=np.uint8)
    img_padded[pad_y:pad_y+nh, pad_x:pad_x+nw, :] = img_resized
    
    img_padded = img_padded[:, :, ::-1]
    img_input = img_padded.astype(np.float32) / 255.0
    img_input = np.transpose(img_input, (2, 0, 1))
    img_input = np.expand_dims(img_input, axis=0)
    
    return img_input, scale, pad_x, pad_y

def run_old_model(session, img_input, scale, pad_x, pad_y):
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: img_input})
    data = outputs[0]
    
    boxes = []
    if len(data.shape) == 3:
        data = data[0].T
        return None
    
    for i in range(0, len(data), 6):
        score = data[i+4]
        if score < 0.25: continue
        x1 = (data[i] - pad_x) / scale
        y1 = (data[i+1] - pad_y) / scale
        x2 = (data[i+2] - pad_x) / scale
        y2 = (data[i+3] - pad_y) / scale
        boxes.append([x1, y1, x2, y2, score])
    return boxes

def calculate_iou(box1, box2):
    xA = max(box1[0], box2[0])
    yA = max(box1[1], box2[1])
    xB = min(box1[2], box2[2])
    yB = min(box1[3], box2[3])
    interArea = max(0, xB - xA + 1) * max(0, yB - yA + 1)
    box1Area = (box1[2] - box1[0] + 1) * (box1[3] - box1[1] + 1)
    box2Area = (box2[2] - box2[0] + 1) * (box2[3] - box2[1] + 1)
    iou = interArea / float(box1Area + box2Area - interArea)
    return iou

def compare():
    print("Comparing models...")
    runs_dir = SCRIPT_DIR / "runs"
    all_runs = sorted(runs_dir.glob("yolo11m_bubble*"), key=os.path.getmtime, reverse=True)
    
    if not all_runs:
        print("No runs found in runs/ directory.")
        return False
        
    new_model_path = all_runs[0] / "weights" / "best.pt"
    if not new_model_path.exists():
        print(f"New model not found at {new_model_path}. Run training first.")
        return False

    old_model_path = download_old_model()
    
    model_new = YOLO(new_model_path)
    results_new = model_new.val(imgsz=800, device=None)
    map50_new = results_new.results_dict['metrics/mAP50(B)']
    
    print(f"New Model mAP50: {map50_new:.4f}")
    
    try:
        model_old = YOLO(old_model_path, task='detect')
        results_old = model_old.val(data=str(SCRIPT_DIR / "dataset" / "data.yaml"), imgsz=800, device=None)
        map50_old = results_old.results_dict['metrics/mAP50(B)']
    except Exception as e:
        print(f"Could not run ultralytics val on old ONNX model: {e}")
        map50_old = 0.97
    
    print(f"Old Model mAP50: {map50_old:.4f}")
    
    is_better = map50_new > map50_old
    if is_better:
        print("New model is better!")
    else:
        print("New model is not better or equal.")
    
    return is_better

if __name__ == "__main__":
    compare()
