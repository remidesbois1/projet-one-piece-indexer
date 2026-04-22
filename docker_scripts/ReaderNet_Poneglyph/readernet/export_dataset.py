import json
import math
import os
import sys
import io
from pathlib import Path
from typing import List, Dict, Tuple

import numpy as np
import onnxruntime as ort
import requests
from PIL import Image
from PIL import UnidentifiedImageError
from pillow_avif import AvifImagePlugin  # Register AVIF support
from sklearn.model_selection import train_test_split
from supabase import create_client, Client
from dotenv import load_dotenv
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).resolve().parent
PANEL_DETECTOR_ONNX = (
    SCRIPT_DIR.parent
    / "panel_detector"
    / "runs"
    / "yolo11m_panel_pose"
    / "weights"
    / "best.onnx"
)
PANEL_ORDER_ONNX = (
    SCRIPT_DIR.parent
    / "panel_detector"
    / "runs_reading_order"
    / "panel_order_model.onnx"
)

load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    env_path = SCRIPT_DIR.parent.parent.parent / ".env"
    load_dotenv(env_path)
    SUPABASE_URL = os.getenv("SUPABASE_URL")
    SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

OUTPUT_DIR = SCRIPT_DIR / "dataset"
TEST_SIZE = 0.1
RANDOM_SEED = 42


def point_in_polygon(px, py, polygon):
    """Ray casting algorithm for point-in-polygon."""
    n = len(polygon)
    inside = False
    x1, y1 = polygon[0]
    for i in range(1, n + 1):
        x2, y2 = polygon[i % n]
        if py > min(y1, y2):
            if py <= max(y1, y2):
                if px <= max(x1, x2):
                    if y1 != y2:
                        xinters = (py - y1) * (x2 - x1) / (y2 - y1 + 1e-9) + x1
                    if x1 == x2 or px <= xinters:
                        inside = not inside
        x1, y1 = x2, y2
    return inside


class PanelDetector:
    def __init__(self, onnx_path: Path):
        if not onnx_path.exists():
            # fallback: search for any .onnx in panel_detector runs
            candidates = list(
                (SCRIPT_DIR.parent / "panel_detector" / "runs").rglob("*.onnx")
            )
            if candidates:
                onnx_path = candidates[0]
            else:
                raise FileNotFoundError(f"Panel detector ONNX not found: {onnx_path}")
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.sess = ort.InferenceSession(
            str(onnx_path),
            opts,
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self.input_name = self.sess.get_inputs()[0].name
        _, _, self.in_h, self.in_w = self.sess.get_inputs()[0].shape

    def detect(self, img: Image.Image):
        arr = np.array(
            img.resize((self.in_w, self.in_h)).convert("RGB"), dtype=np.float32
        )
        arr = arr.transpose(2, 0, 1)[None] / 255.0
        outputs = self.sess.run(None, {self.input_name: arr})
        # YOLO-pose output: [1, C, 8400] where C = 4 (box) + 1 (conf) + 1 (cls) + num_kpts*3
        preds = outputs[0][0]  # [C, 8400]
        # Filter by confidence
        confs = preds[4, :]
        mask = confs > 0.25
        if mask.sum() == 0:
            return []
        preds = preds[:, mask]
        # Extract only bounding boxes (first 4 values)
        boxes = preds[:4, :].T  # xywh center format
        scores = preds[4, :]

        # Convert xywh to x1y1x2y2 for NMS
        x, y, w, h = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        x1, y1, x2, y2 = x - w / 2, y - h / 2, x + w / 2, y + h / 2

        # Simple NMS by picking top conf and removing overlapping
        order = np.argsort(-scores)
        keep = []
        while len(order) > 0:
            i = order[0]
            keep.append(i)
            if len(order) == 1:
                break
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
            area = (x2 - x1) * (y2 - y1)
            union = area[i] + area[order[1:]] - inter
            iou = inter / (union + 1e-6)
            order = order[1:][iou < 0.5]

        # Scale from model input resolution to original image resolution
        scale_x = img.width / self.in_w
        scale_y = img.height / self.in_h
        panels = []
        for idx in keep:
            panels.append(
                {
                    "x": float(x1[idx] * scale_x),
                    "y": float(y1[idx] * scale_y),
                    "w": float((x2[idx] - x1[idx]) * scale_x),
                    "h": float((y2[idx] - y1[idx]) * scale_y),
                    "conf": float(scores[idx]),
                }
            )
        return panels


class PanelOrderModel:
    def __init__(self, onnx_path: Path):
        if not onnx_path.exists():
            candidates = list(
                (SCRIPT_DIR.parent / "panel_detector" / "runs_reading_order").rglob(
                    "*.onnx"
                )
            )
            if candidates:
                onnx_path = candidates[0]
            else:
                raise FileNotFoundError(f"Panel order ONNX not found: {onnx_path}")
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.sess = ort.InferenceSession(
            str(onnx_path),
            opts,
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self.input_names = [inp.name for inp in self.sess.get_inputs()]

    def compute_pos_features(self, bbox_a, bbox_b, w=384, h=256):
        def norm(bbox):
            return [bbox[0] / w, bbox[1] / h, bbox[2] / w, bbox[3] / h]

        a = norm(bbox_a)
        b = norm(bbox_b)
        cxa, cya = (a[0] + a[2]) / 2.0, (a[1] + a[3]) / 2.0
        cxb, cyb = (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0
        wa, ha = a[2] - a[0], a[3] - a[1]
        wb, hb = b[2] - b[0], b[3] - b[1]
        return [
            cxa,
            cya,
            wa,
            ha,
            cxb,
            cyb,
            wb,
            hb,
            cxa - cxb,
            cya - cyb,
            wa - wb,
            ha - hb,
        ]

    def rank_panels(self, panels: List[Dict], img: Image.Image):
        if len(panels) <= 1:
            return panels

        import torchvision.transforms as T

        transform = T.Compose(
            [
                T.Resize((224, 224)),
                T.ToTensor(),
                T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            ]
        )

        valid_panels = []
        crops = []
        for p in panels:
            x1, y1 = int(p["x"]), int(p["y"])
            x2, y2 = int(p["x"] + p["w"]), int(p["y"] + p["h"])
            # Validate coordinates
            if x2 <= x1 or y2 <= y1 or x1 >= img.width or y1 >= img.height:
                continue
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(img.width, x2), min(img.height, y2)
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            try:
                crop = img.crop((x1, y1, x2, y2))
                if crop.mode != "RGB":
                    crop = crop.convert("RGB")
                crops.append(transform(crop).numpy())
                valid_panels.append(p)
            except Exception:
                continue

        if len(valid_panels) <= 1:
            return valid_panels if valid_panels else panels

        crops = np.stack(crops, axis=0)  # [N, 3, 224, 224]

        n = len(valid_panels)
        img_a_list, img_b_list, pos_list = [], [], []
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                img_a_list.append(crops[i])
                img_b_list.append(crops[j])
                pos_list.append(
                    self.compute_pos_features(
                        [
                            valid_panels[i]["x"],
                            valid_panels[i]["y"],
                            valid_panels[i]["w"],
                            valid_panels[i]["h"],
                        ],
                        [
                            valid_panels[j]["x"],
                            valid_panels[j]["y"],
                            valid_panels[j]["w"],
                            valid_panels[j]["h"],
                        ],
                    )
                )

        if not img_a_list:
            return valid_panels

        batch_size = 32
        all_logits = []
        for start in range(0, len(img_a_list), batch_size):
            end = start + batch_size
            feed = {
                self.input_names[0]: np.stack(img_a_list[start:end], axis=0).astype(
                    np.float32
                ),
                self.input_names[1]: np.stack(img_b_list[start:end], axis=0).astype(
                    np.float32
                ),
                self.input_names[2]: np.stack(pos_list[start:end], axis=0).astype(
                    np.float32
                ),
            }
            logits = self.sess.run(None, feed)[0]
            all_logits.extend(logits.flatten().tolist())

        scores = np.zeros(n)
        idx = 0
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                scores[i] += all_logits[idx]
                idx += 1

        order = np.argsort(-scores)
        return [valid_panels[int(i)] for i in order]


def fetch_data(supabase: Client):
    print("Fetching pages with bubbles from Supabase...")
    resp = (
        supabase.table("pages")
        .select("id, url_image, numero_page, bulles(x, y, w, h, order)")
        .execute()
    )
    pages = resp.data
    valid = [p for p in pages if p.get("bulles") and len(p["bulles"]) >= 2]
    print(f"Pages with >=2 bubbles: {len(valid)}")
    return valid


def assign_bubbles_to_panels(bubbles, panels):
    """Assign each bubble to the best-fitting panel.

    Priority:
    1. Panel that contains the bubble's center.
    2. Panel whose bounding box intersects the bubble's bounding box.
    3. Closest panel (by center-to-center distance).

    Returns (assignments, panel_orders) where panel_orders is the global
    reading order index of each panel (0 = first panel, 1 = second, etc.)."""
    assignments = []
    for b in bubbles:
        cx = b["x"] + b["w"] / 2
        cy = b["y"] + b["h"] / 2
        assigned_panel = -1

        # Strategy 1: Center point containment
        for pi, p in enumerate(panels):
            if p["x"] <= cx <= p["x"] + p["w"] and p["y"] <= cy <= p["y"] + p["h"]:
                assigned_panel = pi
                break

        # Strategy 2: Bounding box intersection
        if assigned_panel == -1:
            bx1, by1, bx2, by2 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
            best_intersection_area = -1
            for pi, p in enumerate(panels):
                px1, py1, px2, py2 = p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"]
                ix1 = max(bx1, px1)
                iy1 = max(by1, py1)
                ix2 = min(bx2, px2)
                iy2 = min(by2, py2)
                if ix1 < ix2 and iy1 < iy2:
                    area = (ix2 - ix1) * (iy2 - iy1)
                    if area > best_intersection_area:
                        best_intersection_area = area
                        assigned_panel = pi

        # Strategy 3: Closest panel by center distance
        if assigned_panel == -1:
            min_dist = float("inf")
            for pi, p in enumerate(panels):
                pcx = p["x"] + p["w"] / 2
                pcy = p["y"] + p["h"] / 2
                dist = math.sqrt((cx - pcx) ** 2 + (cy - pcy) ** 2)
                if dist < min_dist:
                    min_dist = dist
                    assigned_panel = pi

        assignments.append(assigned_panel)

    panel_orders = {pi: pi for pi in range(len(panels))}
    return assignments, panel_orders


def normalize_bubbles(bubbles, img_w, img_h):
    result = []
    for b in bubbles:
        x = b["x"] / img_w
        y = b["y"] / img_h
        w = b["w"] / img_w
        h = b["h"] / img_h
        result.append({"x": x, "y": y, "w": w, "h": h, "order": b["order"]})
    return result


def normalize_panels(panels, img_w, img_h):
    result = []
    for p in panels:
        x = p["x"] / img_w
        y = p["y"] / img_h
        w = p["w"] / img_w
        h = p["h"] / img_h
        result.append({"x": max(0, x), "y": max(0, y), "w": min(1, w), "h": min(1, h)})
    return result


def generate_pairs_and_groups(bubbles, panel_assignments, panel_orders):
    """Generate pairwise labels and per-panel target matrices.

    Now we only generate pairs for bubbles within the SAME panel.
    Bubbles in different panels have their order determined entirely
    by the panel reading order (which is assumed perfect).

    Returns:
        pairs: list of pairwise labels (only intra-panel)
        panel_groups: dict mapping panel_idx -> list of bubble indices in that panel
        panel_target_matrices: dict mapping panel_idx -> NxN target matrix for that panel
    """
    n = len(bubbles)

    # Group bubbles by panel
    panel_groups = {}
    for bi, pi in enumerate(panel_assignments):
        if pi >= 0:
            panel_groups.setdefault(pi, []).append(bi)

    # For unassigned bubbles, put them in panel -1 (will be ignored)
    unassigned = [bi for bi, pi in enumerate(panel_assignments) if pi < 0]
    if unassigned:
        panel_groups[-1] = unassigned

    pairs = []
    panel_target_matrices = {}

    for pi, bidxs in panel_groups.items():
        if pi < 0 or len(bidxs) < 2:
            # Skip unassigned or single-bubble panels (no intra-panel ordering needed)
            panel_target_matrices[pi] = np.zeros(
                (len(bidxs), len(bidxs)), dtype=np.float32
            )
            continue

        # Sort bubbles in this panel by their global reading order
        bidxs_sorted = sorted(bidxs, key=lambda bi: bubbles[bi]["order"])

        # Build local target matrix: within this panel, what's the reading order?
        local_n = len(bidxs_sorted)
        local_target = np.zeros((local_n, local_n), dtype=np.float32)

        # For pairwise labels within this panel
        for local_i, global_i in enumerate(bidxs_sorted):
            for local_j, global_j in enumerate(bidxs_sorted):
                if local_i == local_j:
                    continue
                # Label: 1 if bubble i comes before bubble j (globally)
                label = (
                    1 if bubbles[global_i]["order"] < bubbles[global_j]["order"] else 0
                )
                local_target[local_i, local_j] = label

                # Also add to pairs list for backward compatibility
                a, b = bubbles[global_i], bubbles[global_j]
                dx = (b["x"] + b["w"] / 2) - (a["x"] + a["w"] / 2)
                dy = (b["y"] + b["h"] / 2) - (a["y"] + a["h"] / 2)
                dist = math.sqrt(dx * dx + dy * dy)
                angle = math.atan2(dy, dx) / math.pi
                pairs.append(
                    {
                        "a": {
                            "x": a["x"],
                            "y": a["y"],
                            "w": a["w"],
                            "h": a["h"],
                            "panel": int(pi),
                            "local_idx": local_i,
                        },
                        "b": {
                            "x": b["x"],
                            "y": b["y"],
                            "w": b["w"],
                            "h": b["h"],
                            "panel": int(pi),
                            "local_idx": local_j,
                        },
                        "rel": {"dx": dx, "dy": dy, "dist": dist, "angle": angle},
                        "label": label,
                    }
                )

        panel_target_matrices[pi] = local_target

    return pairs, panel_groups, panel_target_matrices


def main():
    train_ann_path = OUTPUT_DIR / "train" / "annotations.json"
    val_ann_path = OUTPUT_DIR / "val" / "annotations.json"

    if train_ann_path.exists() and val_ann_path.exists():
        print(f"Dataset already exists in {OUTPUT_DIR}. Skipping export.")
        return

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Error: Missing Supabase credentials")
        sys.exit(1)

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    pages = fetch_data(supabase)

    if not pages:
        print("No data found.")
        return

    # Load panel detector and reading order models
    print("Loading panel detector...")
    panel_detector = PanelDetector(PANEL_DETECTOR_ONNX)
    print("Loading panel order model...")
    panel_order = PanelOrderModel(PANEL_ORDER_ONNX)

    train_pages, val_pages = train_test_split(
        pages, test_size=TEST_SIZE, random_state=RANDOM_SEED
    )

    for split_name, split_pages in [("train", train_pages), ("val", val_pages)]:
        img_dir = OUTPUT_DIR / split_name / "images"
        img_dir.mkdir(parents=True, exist_ok=True)

        annotations = []
        print(f"\nProcessing '{split_name}' ({len(split_pages)} pages)...")

        for page in tqdm(split_pages, desc=split_name):
            try:
                resp = requests.get(page["url_image"], timeout=15)
                resp.raise_for_status()
                try:
                    img = Image.open(io.BytesIO(resp.content))
                except (UnidentifiedImageError, OSError) as img_err:
                    print(f"\n  Skipping page {page['id']}: {img_err}")
                    continue

                img_name = f"page_{page['id']}.png"
                img.convert("L").save(img_dir / img_name)

                # Detect panels
                panels_raw = panel_detector.detect(img)
                if len(panels_raw) == 0:
                    # If no panels detected, create one big panel covering the whole page
                    panels_raw = [
                        {"x": 0, "y": 0, "w": img.width, "h": img.height, "conf": 1.0}
                    ]

                # Order panels
                panels_ordered = panel_order.rank_panels(panels_raw, img)

                # Normalize panels and bubbles to [0,1] based on original image dimensions
                panels_norm = normalize_panels(panels_ordered, img.width, img.height)
                bubbles_raw = sorted(
                    page["bulles"],
                    key=lambda b: b["order"]
                    if b.get("order") is not None
                    else float("inf"),
                )
                bubbles_norm = normalize_bubbles(bubbles_raw, img.width, img.height)

                # Assign bubbles to panels and get panel orders
                panel_assignments, panel_orders = assign_bubbles_to_panels(
                    bubbles_norm, panels_norm
                )

                # Generate intra-panel pairs and per-panel target matrices
                pairs, panel_groups, panel_target_matrices = generate_pairs_and_groups(
                    bubbles_norm, panel_assignments, panel_orders
                )

                # Build panel-wise bubble data for training
                # Each panel contains: its reading order, its bubbles, their local target matrix
                panel_bubbles_data = []
                for pi in sorted(panel_groups.keys()):
                    if pi < 0:
                        continue  # Skip unassigned
                    bidxs = panel_groups[pi]
                    panel_bubbles = [bubbles_norm[bi] for bi in bidxs]
                    # Add local panel index to each bubble
                    for local_idx, bi in enumerate(bidxs):
                        panel_bubbles[local_idx]["local_idx"] = local_idx
                        panel_bubbles[local_idx]["global_idx"] = bi

                    panel_bubbles_data.append(
                        {
                            "panel_idx": int(pi),
                            "panel_order": int(
                                panel_orders.get(pi, pi)
                            ),  # global reading order of this panel
                            "bubbles": panel_bubbles,
                            "target_matrix": panel_target_matrices[pi].tolist(),
                            "num_bubbles": len(bidxs),
                        }
                    )

                annotations.append(
                    {
                        "image": img_name,
                        "img_w": img.width,
                        "img_h": img.height,
                        "panels": panels_norm,
                        "bubbles": bubbles_norm,
                        "panel_assignments": [int(x) for x in panel_assignments],
                        "num_bubbles": len(bubbles_norm),
                        "num_panels": len(panels_norm),
                        "pairs": pairs,
                        "panel_bubbles": panel_bubbles_data,
                    }
                )
            except Exception as e:
                print(f"\n  Error on page {page['id']}: {e}")
                import traceback

                traceback.print_exc()

        ann_path = OUTPUT_DIR / split_name / "annotations.json"
        with open(ann_path, "w") as f:
            json.dump(annotations, f)

        total_pairs = sum(len(a["pairs"]) for a in annotations)
        total_panel_bubbles = sum(
            sum(pb["num_bubbles"] for pb in a.get("panel_bubbles", []))
            for a in annotations
        )
        print(
            f"  {len(annotations)} pages, {total_pairs} intra-panel pairs, "
            f"{total_panel_bubbles} panel-grouped bubbles -> {ann_path}"
        )

    print("\nDataset export complete.")


if __name__ == "__main__":
    main()
