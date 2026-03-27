import json
import os
import math
import random
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from PIL import Image
from torch.utils.data import Dataset, DataLoader

SCRIPT_DIR = Path(__file__).resolve().parent

CANVAS_H = 256
CANVAS_W = 384

# Model dims
FEAT_DIM = 96
GLOBAL_DIM = 64
BUBBLE_EMB_DIM = 48

LR = 2e-4
EPOCHS = 100
WEIGHT_DECAY = 1e-4

# Geometry dims
ABS_GEOM_DIM = 14   # bbox + center + area/aspect + border distances
REL_GEOM_DIM = 20   # richer pairwise features


# ----------------------------
# Utils
# ----------------------------

def clamp01(x):
    return max(0.0, min(1.0, x))

def safe_div(a, b, eps=1e-6):
    return a / (b + eps)

def bbox_to_xyxy(box):
    x, y, w, h = box
    return x, y, x + w, y + h

def bbox_center(box):
    x, y, w, h = box
    return x + w * 0.5, y + h * 0.5

def bbox_area(box):
    return box[2] * box[3]

def bbox_iou(a, b):
    ax1, ay1, ax2, ay2 = bbox_to_xyxy(a)
    bx1, by1, bx2, by2 = bbox_to_xyxy(b)

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    union = bbox_area(a) + bbox_area(b) - inter
    return safe_div(inter, union)

def overlap_1d(a1, a2, b1, b2):
    inter = max(0.0, min(a2, b2) - max(a1, b1))
    return inter

def compute_abs_geom(box):
    x, y, w, h = box
    x = clamp01(x)
    y = clamp01(y)
    w = clamp01(w)
    h = clamp01(h)

    x2 = clamp01(x + w)
    y2 = clamp01(y + h)
    cx = clamp01(x + w * 0.5)
    cy = clamp01(y + h * 0.5)
    area = w * h
    aspect = safe_div(w, h)

    dist_left = x
    dist_right = 1.0 - x2
    dist_top = y
    dist_bottom = 1.0 - y2

    return [
        x, y, w, h,
        cx, cy,
        x2, y2,
        area, aspect,
        dist_left, dist_right,
        dist_top, dist_bottom
    ]

def compute_rel_geom(box_a, box_b):
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b

    acx, acy = bbox_center(box_a)
    bcx, bcy = bbox_center(box_b)

    dx = bcx - acx
    dy = bcy - acy
    abs_dx = abs(dx)
    abs_dy = abs(dy)

    eucl = math.sqrt(dx * dx + dy * dy)
    manh = abs_dx + abs_dy

    angle = math.atan2(dy, dx)
    angle_sin = math.sin(angle)
    angle_cos = math.cos(angle)

    ax1, ay1, ax2, ay2 = bbox_to_xyxy(box_a)
    bx1, by1, bx2, by2 = bbox_to_xyxy(box_b)

    ovx = overlap_1d(ax1, ax2, bx1, bx2)
    ovy = overlap_1d(ay1, ay2, by1, by2)
    iou = bbox_iou(box_a, box_b)

    w_ratio = safe_div(aw, bw)
    h_ratio = safe_div(ah, bh)
    area_ratio = safe_div(aw * ah, bw * bh)

    a_right_of_b = 1.0 if acx > bcx else 0.0
    a_left_of_b = 1.0 if acx < bcx else 0.0
    a_above_b = 1.0 if acy < bcy else 0.0
    a_below_b = 1.0 if acy > bcy else 0.0

    same_row_score = math.exp(-abs_dy * 8.0)
    same_col_score = math.exp(-abs_dx * 8.0)

    horizontal_dominance = 1.0 if abs_dx > abs_dy else 0.0
    vertical_dominance = 1.0 if abs_dy >= abs_dx else 0.0

    right_to_left_gap = max(0.0, acx - bcx)   # A right of B
    top_to_bottom_gap = max(0.0, bcy - acy)   # A above B

    # simple manga prior: right-to-left + top-to-bottom
    jp_reading_prior = 0.6 * right_to_left_gap + 0.4 * top_to_bottom_gap

    edge_min_dist = min(
        abs(ax1 - bx2), abs(ax2 - bx1),
        abs(ay1 - by2), abs(ay2 - by1)
    )

    return [
        dx, dy, abs_dx, abs_dy,
        eucl, manh,
        angle_sin, angle_cos,
        ovx, ovy, iou,
        w_ratio, h_ratio, area_ratio,
        a_right_of_b, a_left_of_b,
        a_above_b, a_below_b,
        same_row_score, same_col_score
    ]


def kendall_tau_from_order(pred_order, true_order):
    """
    pred_order, true_order: lists of bubble indices in order
    """
    if len(pred_order) <= 1:
        return 1.0

    pos_pred = {idx: i for i, idx in enumerate(pred_order)}
    pos_true = {idx: i for i, idx in enumerate(true_order)}

    concordant = 0
    discordant = 0
    items = true_order

    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            a, b = items[i], items[j]
            pred_sign = pos_pred[a] < pos_pred[b]
            true_sign = pos_true[a] < pos_true[b]
            if pred_sign == true_sign:
                concordant += 1
            else:
                discordant += 1

    denom = concordant + discordant
    if denom == 0:
        return 1.0
    return (concordant - discordant) / denom


# ----------------------------
# Model
# ----------------------------

class InvertedResidual(nn.Module):
    def __init__(self, inp, oup, stride, expand_ratio, use_hswish=True):
        super().__init__()
        self.use_res = stride == 1 and inp == oup
        hidden = int(inp * expand_ratio)
        act = nn.Hardswish if use_hswish else lambda: nn.ReLU6(inplace=True)

        layers = []
        if expand_ratio != 1:
            layers += [
                nn.Conv2d(inp, hidden, 1, bias=False),
                nn.BatchNorm2d(hidden),
                act()
            ]
        else:
            hidden = inp

        layers += [
            nn.Conv2d(hidden, hidden, 3, stride, 1, groups=hidden, bias=False),
            nn.BatchNorm2d(hidden),
            act(),
            nn.Conv2d(hidden, oup, 1, bias=False),
            nn.BatchNorm2d(oup)
        ]
        self.conv = nn.Sequential(*layers)

    def forward(self, x):
        out = self.conv(x)
        if self.use_res:
            return x + out
        return out


class PageBackboneV6(nn.Module):
    """
    Keeps a 16x24 spatial map for 256x384 input.
    """
    def __init__(self):
        super().__init__()
        self.stem = nn.Sequential(
            nn.Conv2d(1, 16, 3, stride=2, padding=1, bias=False),  # 128x192
            nn.BatchNorm2d(16),
            nn.Hardswish()
        )
        self.blocks = nn.Sequential(
            InvertedResidual(16, 16, 2, 1, False),   # 64x96
            InvertedResidual(16, 24, 2, 4, False),   # 32x48
            InvertedResidual(24, 24, 1, 4, False),
            InvertedResidual(24, 40, 2, 4, True),    # 16x24
            InvertedResidual(40, 40, 1, 4, True),
            InvertedResidual(40, 64, 1, 4, True),
            InvertedResidual(64, 64, 1, 4, True),
            InvertedResidual(64, FEAT_DIM, 1, 4, True),
        )
        self.global_proj = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(FEAT_DIM, GLOBAL_DIM),
            nn.Hardswish()
        )

    def forward(self, x):
        fmap = self.blocks(self.stem(x))   # [B, 96, 16, 24]
        gvec = self.global_proj(fmap)      # [B, 64]
        return fmap, gvec


class BubbleROIEncoder(nn.Module):
    def __init__(self, in_channels, abs_geom_dim, global_dim, emb_dim, roi_size=3):
        super().__init__()
        self.roi_size = roi_size
        roi_flat_dim = in_channels * roi_size * roi_size

        self.proj = nn.Sequential(
            nn.Linear(roi_flat_dim + abs_geom_dim + global_dim, 128),
            nn.LayerNorm(128),
            nn.SiLU(),
            nn.Dropout(0.05),
            nn.Linear(128, emb_dim)
        )

    def forward(self, fmap, bboxes, abs_geom, gvec):
        """
        fmap: [1, C, H, W]
        bboxes: [N, 4] in normalized x,y,w,h
        abs_geom: [N, ABS_GEOM_DIM]
        gvec: [1, GLOBAL_DIM]
        """
        N = bboxes.size(0)
        C = fmap.size(1)

        # Clamp and ensure minimal size
        x1 = bboxes[:, 0].clamp(0.0, 1.0)
        y1 = bboxes[:, 1].clamp(0.0, 1.0)
        w = bboxes[:, 2].clamp(1e-4, 1.0)
        h = bboxes[:, 3].clamp(1e-4, 1.0)
        x2 = (x1 + w).clamp(0.0, 1.0)
        y2 = (y1 + h).clamp(0.0, 1.0)

        gx = torch.linspace(-1, 1, self.roi_size, device=bboxes.device, dtype=bboxes.dtype)
        gy = torch.linspace(-1, 1, self.roi_size, device=bboxes.device, dtype=bboxes.dtype)
        grid_y, grid_x = torch.meshgrid(gy, gx, indexing='ij')
        base_grid = torch.stack([grid_x, grid_y], dim=-1)  # [R, R, 2]
        base_grid = base_grid.unsqueeze(0).repeat(N, 1, 1, 1)  # [N, R, R, 2]

        # map from local roi grid to image-normalized [0,1], then to [-1,1]
        grid_x_local = base_grid[..., 0:1]
        grid_y_local = base_grid[..., 1:2]

        x_mapped = x1.view(N, 1, 1, 1) + (grid_x_local + 1.0) * 0.5 * (x2 - x1).view(N, 1, 1, 1)
        y_mapped = y1.view(N, 1, 1, 1) + (grid_y_local + 1.0) * 0.5 * (y2 - y1).view(N, 1, 1, 1)

        grid_final = torch.cat([x_mapped * 2.0 - 1.0, y_mapped * 2.0 - 1.0], dim=-1)
        grid_final = grid_final.clamp(-1.0, 1.0)

        fmap_exp = fmap.expand(N, -1, -1, -1)
        roi_feats = F.grid_sample(
            fmap_exp,
            grid_final,
            mode="bilinear",
            padding_mode="zeros",
            align_corners=False
        )  # [N, C, R, R]
        roi_feats = roi_feats.flatten(1)

        combined = torch.cat([roi_feats, abs_geom, gvec.expand(N, -1)], dim=1)
        return self.proj(combined)


class PairScorerV6(nn.Module):
    def __init__(self, emb_dim, rel_geom_dim):
        super().__init__()
        in_dim = emb_dim * 4 + rel_geom_dim
        self.mlp = nn.Sequential(
            nn.Linear(in_dim, 128),
            nn.LayerNorm(128),
            nn.SiLU(),
            nn.Dropout(0.05),
            nn.Linear(128, 64),
            nn.SiLU(),
            nn.Linear(64, 1)
        )

    def forward(self, eA, eB, rel_geom):
        x = torch.cat([eA, eB, eA - eB, eA * eB, rel_geom], dim=1)
        return self.mlp(x)


class ReaderNetV6True(nn.Module):
    """
    Keeps the same external forward signature:
      forward(image, bboxes, pair_indices, rel_geom)
    """
    def __init__(self):
        super().__init__()
        self.backbone = PageBackboneV6()
        self.bubble_enc = BubbleROIEncoder(
            in_channels=FEAT_DIM,
            abs_geom_dim=ABS_GEOM_DIM,
            global_dim=GLOBAL_DIM,
            emb_dim=BUBBLE_EMB_DIM,
            roi_size=3
        )
        self.pair_head = PairScorerV6(BUBBLE_EMB_DIM, REL_GEOM_DIM)

    def forward(self, image, bboxes, pair_indices, rel_geom):
        """
        image: [1,1,256,384]
        bboxes: [N,4]
        pair_indices: [P,2]
        rel_geom: [P,REL_GEOM_DIM]
        """
        fmap, gvec = self.backbone(image)

        abs_geom = []
        bboxes_cpu = bboxes.detach().cpu().tolist()
        for box in bboxes_cpu:
            abs_geom.append(compute_abs_geom(box))
        abs_geom = torch.tensor(abs_geom, dtype=bboxes.dtype, device=bboxes.device)

        embs = self.bubble_enc(fmap, bboxes, abs_geom, gvec)  # [N, D]

        eA = embs[pair_indices[:, 0]]
        eB = embs[pair_indices[:, 1]]
        return self.pair_head(eA, eB, rel_geom)


# ----------------------------
# Dataset
# ----------------------------

class PageDatasetV6(Dataset):
    def __init__(self, annotations, images_dir, augment=False):
        self.images_dir = images_dir
        self.augment = augment
        self.pages = []

        for page in annotations:
            img_path = os.path.join(images_dir, page["image"])
            if os.path.exists(img_path) and "bubbles" in page and len(page["bubbles"]) >= 2:
                self.pages.append(page)

    def __len__(self):
        return len(self.pages)

    def _augment_image(self, img):
        if random.random() < 0.5:
            img = np.clip(img * random.uniform(0.9, 1.1), 0.0, 1.0)
        if random.random() < 0.3:
            noise = np.random.normal(0.0, 0.015, img.shape).astype(np.float32)
            img = np.clip(img + noise, 0.0, 1.0)
        return img.astype(np.float32)

    def _jitter_boxes(self, bboxes):
        if not self.augment:
            return bboxes
        out = []
        for x, y, w, h in bboxes:
            jx = random.uniform(-0.015, 0.015)
            jy = random.uniform(-0.015, 0.015)
            jw = random.uniform(-0.015, 0.015)
            jh = random.uniform(-0.015, 0.015)

            nx = clamp01(x + jx)
            ny = clamp01(y + jy)
            nw = max(1e-4, min(1.0 - nx, w * (1.0 + jw)))
            nh = max(1e-4, min(1.0 - ny, h * (1.0 + jh)))
            out.append([nx, ny, nw, nh])
        return out

    def __getitem__(self, idx):
        page = self.pages[idx]

        img = Image.open(os.path.join(self.images_dir, page["image"])).convert("L")
        img = img.resize((CANVAS_W, CANVAS_H), Image.BILINEAR)
        img = np.array(img, dtype=np.float32) / 255.0

        if self.augment:
            img = self._augment_image(img)

        bubbles = page["bubbles"]

        # IMPORTANT:
        # We keep the same assumption as your current pipeline:
        # the order in page["bubbles"] is the reading order.
        # We do not change dataset format.
        bboxes_list = [[b["x"], b["y"], b["w"], b["h"]] for b in bubbles]
        bboxes_list = self._jitter_boxes(bboxes_list)
        bboxes = torch.tensor(bboxes_list, dtype=torch.float32)

        pair_indices = []
        labels = []
        rel_geoms = []

        n = len(bubbles)
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue

                pair_indices.append([i, j])
                labels.append([1.0 if i < j else 0.0])

                rel_geoms.append(compute_rel_geom(bboxes_list[i], bboxes_list[j]))

        return (
            torch.from_numpy(img).unsqueeze(0),                 # [1,H,W]
            bboxes,                                             # [N,4]
            torch.tensor(pair_indices, dtype=torch.long),       # [P,2]
            torch.tensor(rel_geoms, dtype=torch.float32),       # [P,20]
            torch.tensor(labels, dtype=torch.float32)           # [P,1]
        )


# ----------------------------
# Ranking / Eval
# ----------------------------

def rank_page_with_borda(logits, pair_indices, num_bubbles):
    """
    logits: [P,1]
    pair_indices: [P,2]
    """
    probs = torch.sigmoid(logits).view(-1)
    scores = torch.zeros(num_bubbles, dtype=probs.dtype, device=probs.device)

    for k in range(pair_indices.size(0)):
        i = pair_indices[k, 0].item()
        scores[i] += probs[k]

    order = torch.argsort(scores, descending=True).tolist()
    return order, scores.detach().cpu().tolist()

def evaluate_page(model, device, sample):
    img, bboxes, p_idx, rel, lbl = sample
    img = img.unsqueeze(0).to(device).float()
    bboxes = bboxes.to(device).float()
    p_idx = p_idx.to(device)
    rel = rel.to(device).float()
    lbl = lbl.to(device).float()

    with torch.no_grad():
        out = model(img, bboxes, p_idx, rel)

    pred = (out > 0).float()
    pair_acc = (pred == lbl).float().mean().item()

    n = bboxes.size(0)
    pred_order, _ = rank_page_with_borda(out, p_idx, n)
    true_order = list(range(n))

    ktau = kendall_tau_from_order(pred_order, true_order)
    exact = 1.0 if pred_order == true_order else 0.0
    first_ok = 1.0 if len(pred_order) > 0 and pred_order[0] == 0 else 0.0

    return pair_acc, ktau, exact, first_ok


# ----------------------------
# Train
# ----------------------------

def train():
    data_dir = SCRIPT_DIR / "dataset"

    with open(data_dir / "train" / "annotations.json", "r", encoding="utf-8") as f:
        train_ann = json.load(f)
    with open(data_dir / "val" / "annotations.json", "r", encoding="utf-8") as f:
        val_ann = json.load(f)

    train_set = PageDatasetV6(train_ann, str(data_dir / "train" / "images"), augment=True)
    val_set = PageDatasetV6(val_ann, str(data_dir / "val" / "images"), augment=False)

    # batch_size=1 because each page has variable number of bubbles/pairs
    train_loader = DataLoader(train_set, batch_size=1, shuffle=True, num_workers=0)
    val_loader = DataLoader(val_set, batch_size=1, shuffle=False, num_workers=0)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = ReaderNetV6True().to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)
    criterion = nn.BCEWithLogitsLoss()

    scaler = torch.amp.GradScaler("cuda", enabled=(device.type == "cuda"))

    best_score = -1e9
    model_path = data_dir / "readernet_v6.pt"

    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0.0
        total_pair_correct = 0.0
        total_pair_count = 0

        for batch in train_loader:
            img, bboxes, p_idx, rel, lbl = batch

            # remove batch dim because batch_size=1
            img = img.to(device).float()         # [1,1,H,W]
            bboxes = bboxes[0].to(device).float() # [N,4]
            p_idx = p_idx[0].to(device)          # [P,2]
            rel = rel[0].to(device).float()      # [P,20]
            lbl = lbl[0].to(device).float()      # [P,1]

            optimizer.zero_grad(set_to_none=True)

            with torch.amp.autocast("cuda", enabled=(device.type == "cuda")):
                out = model(img, bboxes, p_idx, rel)
                loss = criterion(out, lbl)

            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()

            total_loss += loss.item()
            total_pair_correct += ((out > 0).float() == lbl).sum().item()
            total_pair_count += lbl.numel()

        train_pair_acc = total_pair_correct / max(1, total_pair_count)

        model.eval()
        val_pair_acc_sum = 0.0
        val_tau_sum = 0.0
        val_exact_sum = 0.0
        val_first_sum = 0.0
        val_pages = 0

        with torch.no_grad():
            for batch in val_loader:
                img, bboxes, p_idx, rel, lbl = batch
                sample = (
                    img[0], bboxes[0], p_idx[0], rel[0], lbl[0]
                )
                pair_acc, ktau, exact, first_ok = evaluate_page(model, device, sample)
                val_pair_acc_sum += pair_acc
                val_tau_sum += ktau
                val_exact_sum += exact
                val_first_sum += first_ok
                val_pages += 1

        val_pair_acc = val_pair_acc_sum / max(1, val_pages)
        val_tau = val_tau_sum / max(1, val_pages)
        val_exact = val_exact_sum / max(1, val_pages)
        val_first = val_first_sum / max(1, val_pages)

        # Main selection metric: page-level quality first
        score = val_tau + 0.25 * val_exact + 0.10 * val_first

        if score > best_score:
            best_score = score
            torch.save(model.state_dict(), str(model_path))

        print(
            f"Epoch {epoch+1:3d} | "
            f"Loss: {total_loss / max(1, len(train_loader)):.4f} | "
            f"TrainPairAcc: {train_pair_acc:.4f} | "
            f"ValPairAcc: {val_pair_acc:.4f} | "
            f"ValTau: {val_tau:.4f} | "
            f"ValExact: {val_exact:.4f} | "
            f"ValFirst: {val_first:.4f} | "
            f"BestScore: {best_score:.4f}"
        )

        scheduler.step()

    print("Exporting to ONNX...")
    model.load_state_dict(torch.load(str(model_path), map_location="cpu"))
    model.cpu().eval()

    # Dummy inputs for export (N=3 bubbles => 6 pairs)
    d_img = torch.randn(1, 1, CANVAS_H, CANVAS_W, dtype=torch.float32)
    d_bboxes = torch.tensor([
        [0.10, 0.10, 0.15, 0.10],
        [0.50, 0.20, 0.18, 0.12],
        [0.20, 0.55, 0.20, 0.15],
    ], dtype=torch.float32)
    d_p_idx = torch.tensor([
        [0, 1], [0, 2],
        [1, 0], [1, 2],
        [2, 0], [2, 1]
    ], dtype=torch.long)

    d_rel = []
    boxes = d_bboxes.tolist()
    for i, j in d_p_idx.tolist():
        d_rel.append(compute_rel_geom(boxes[i], boxes[j]))
    d_rel = torch.tensor(d_rel, dtype=torch.float32)

    onnx_path = data_dir / "readernet_v6.onnx"

    torch.onnx.export(
        model,
        (d_img, d_bboxes, d_p_idx, d_rel),
        str(onnx_path),
        input_names=["image", "bboxes", "pair_indices", "rel_geom"],
        output_names=["prediction"],
        dynamic_axes={
            "bboxes": {0: "num_bubbles"},
            "pair_indices": {0: "num_pairs"},
            "rel_geom": {0: "num_pairs"},
            "prediction": {0: "num_pairs"}
        },
        opset_version=17,
        do_constant_folding=True
    )

    print(f"Saved ONNX: {onnx_path}")
    return str(onnx_path)


if __name__ == "__main__":
    train()