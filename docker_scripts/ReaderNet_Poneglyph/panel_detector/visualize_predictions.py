import cv2
import numpy as np
from pathlib import Path
from ultralytics import YOLO
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_DIR = SCRIPT_DIR / "dataset_yolo"
VAL_IMG_DIR = DATASET_DIR / "val" / "images"
OUTPUT_DIR = SCRIPT_DIR / "vis_predictions"

CONF_THRESHOLD = 0.25
KP_CONF_THRESH = 0.5

POSE_FILL_ALPHA = 0.30
POSE_LINE_COLOR = (0, 255, 136)
POSE_FILL_COLOR = (0, 255, 136)

BOX_LINE_COLOR = (255, 165, 0)
BOX_FILL_COLOR = (255, 165, 0)
BOX_FILL_ALPHA = 0.15

KP_COLORS = [
    (0, 0, 255),
    (255, 204, 0),
    (0, 255, 0),
    (255, 0, 255),
]
KP_NAMES = ["TL", "TR", "BR", "BL"]
KP_RADIUS = 6


def find_best_model():
    runs_dir = SCRIPT_DIR / "runs"
    all_runs = sorted(
        runs_dir.glob("yolo11m_panel_pose*"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not all_runs:
        raise FileNotFoundError("No trained model found in runs/")
    best = all_runs[0] / "weights" / "best.pt"
    if not best.exists():
        raise FileNotFoundError(f"best.pt not found at {best}")
    return best


def draw_box(img, box, idx, h, w):
    x1, y1, x2, y2 = map(int, box)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    overlay = img.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), BOX_FILL_COLOR, -1)
    cv2.addWeighted(overlay, BOX_FILL_ALPHA, img, 1 - BOX_FILL_ALPHA, 0, img)

    cv2.rectangle(img, (x1, y1), (x2, y2), BOX_LINE_COLOR, 2)
    cv2.putText(
        img,
        f"box#{idx + 1}",
        (x1 + 4, y1 + 16),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.4,
        BOX_LINE_COLOR,
        1,
        cv2.LINE_AA,
    )


def draw_pose(img, kps, idx, h, w):
    pts = np.array([[int(kp[0]), int(kp[1])] for kp in kps], dtype=np.int32)

    overlay = img.copy()
    cv2.fillPoly(overlay, [pts], POSE_FILL_COLOR)
    cv2.addWeighted(overlay, POSE_FILL_ALPHA, img, 1 - POSE_FILL_ALPHA, 0, img)

    cv2.polylines(img, [pts], isClosed=True, color=POSE_LINE_COLOR, thickness=2)

    for i, (x, y) in enumerate(kps):
        cx, cy = int(x), int(y)
        if not (0 <= cx <= w and 0 <= cy <= h):
            continue
        cv2.circle(img, (cx, cy), KP_RADIUS, KP_COLORS[i], -1)
        cv2.circle(img, (cx, cy), KP_RADIUS, (255, 255, 255), 1)
        cv2.putText(
            img,
            KP_NAMES[i],
            (cx + 8, cy - 8),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.4,
            KP_COLORS[i],
            1,
            cv2.LINE_AA,
        )

    label_x = max(0, min(int(kps[0][0]) + 8, w - 30))
    label_y = max(14, min(int(kps[0][1]) + 16, h - 4))
    cv2.putText(
        img,
        f"pose#{idx + 1}",
        (label_x, label_y),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.45,
        (255, 255, 255),
        1,
        cv2.LINE_AA,
    )


def main():
    model_path = find_best_model()
    print(f"Loading model: {model_path}")
    model = YOLO(model_path)

    OUTPUT_DIR.mkdir(exist_ok=True)

    images = sorted(VAL_IMG_DIR.glob("*.*"))
    if not images:
        print(f"No images found in {VAL_IMG_DIR}")
        return

    total_boxes = 0
    total_poses = 0

    print(f"Annotating {len(images)} images...")
    for img_path in tqdm(images, desc="Predicting"):
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        h, w = img.shape[:2]

        results = model.predict(img, imgsz=800, conf=CONF_THRESHOLD, verbose=False)[0]

        if results.boxes is None or len(results.boxes) == 0:
            cv2.imwrite(str(OUTPUT_DIR / img_path.name), img)
            continue

        boxes_xyxy = results.boxes.xyxy.cpu().numpy()
        has_kp = results.keypoints is not None and results.keypoints.xy is not None

        if has_kp:
            kps_all = results.keypoints.xy.cpu().numpy()
            conf_all = (
                results.keypoints.conf.cpu().numpy()
                if results.keypoints.conf is not None
                else None
            )

        for idx in range(len(boxes_xyxy)):
            draw_box(img, boxes_xyxy[idx], total_boxes, h, w)
            total_boxes += 1

            if has_kp and idx < len(kps_all):
                kps = kps_all[idx]
                if conf_all is not None:
                    kp_conf = conf_all[idx]
                    if kp_conf.sum() < KP_CONF_THRESH * 4:
                        continue
                draw_pose(img, kps, total_poses, h, w)
                total_poses += 1

        cv2.imwrite(str(OUTPUT_DIR / img_path.name), img)

    print(
        f"\nDone. {total_boxes} boxes, {total_poses} poses drawn. Output in: {OUTPUT_DIR}"
    )


if __name__ == "__main__":
    main()
