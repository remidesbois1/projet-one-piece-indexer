"""
Simplified ReaderNet for manga bubble reading order.
Uses a single score per bubble + pairwise ranking loss.
Much smaller and more stable than the transformer version.
"""

import warnings

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

import json
import os
import random
import math
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from PIL import Image
from torch.utils.data import Dataset, DataLoader
from torch.nn.utils.rnn import pad_sequence
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).resolve().parent

MODEL_INPUT_H = 256
MODEL_INPUT_W = 384
BUBBLE_CROP_SIZE = 96

# Hyperparameters
EPOCHS = 200
BATCH_SIZE = 8
LR = 3e-4
PATIENCE = 40
D_MODEL = 512


class SimpleBubbleEncoder(nn.Module):
    """CNN to encode bubble visual crops."""

    def __init__(self, out_dim=256):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(1, 32, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(64, 128, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(128, out_dim, 3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d(1),
        )

    def forward(self, x):
        B, N, C, H, W = x.shape
        x = x.view(B * N, C, H, W)
        x = self.net(x).view(B, N, -1)
        return x


class PageEncoder(nn.Module):
    """CNN to encode full page image for global context."""

    def __init__(self, out_dim=128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(1, 32, 3, stride=2, padding=1),  # 256x384 -> 128x192
            nn.ReLU(),
            nn.Conv2d(32, 64, 3, stride=2, padding=1),  # -> 64x96
            nn.ReLU(),
            nn.Conv2d(64, 128, 3, stride=2, padding=1),  # -> 32x48
            nn.ReLU(),
            nn.Conv2d(128, 128, 3, stride=2, padding=1),  # -> 16x24
            nn.ReLU(),
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(128, out_dim),
        )

    def forward(self, x):
        return self.net(x)


class SimpleReaderNet(nn.Module):
    """Lightweight model: predicts a scalar reading score per bubble.

    No self-attention - purely per-bubble MLP. Reading order in manga
    follows deterministic geometric rules, so attention is unnecessary
    and may blur fine-grained adjacent distinctions.
    """

    def __init__(self, d_model=D_MODEL):
        super().__init__()

        # Visual encoder for bubble crops
        self.vis_enc = SimpleBubbleEncoder(out_dim=256)

        # Global page context encoder
        self.page_enc = PageEncoder(out_dim=128)

        # Bubble feature combiner
        # Inputs: visual(256) + bbox(4) + area(1) + aspect(1) + panel_idx(1)
        #         + cx(1) + cy(1) + rel_x(1) + rel_y(1) + rel_cx(1) + rel_cy(1)
        #         + rtl_x(1) + rtl_rel_x(1) + rtl_rel_cx(1)
        #         + page_context(128)
        mlp_in = 256 + 4 + 1 + 1 + 1 + 6 + 3 + 128
        self.bubble_mlp = nn.Sequential(
            nn.Linear(mlp_in, d_model),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(d_model, d_model),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(d_model, d_model),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(d_model, d_model),
            nn.ReLU(),
        )

        # Score head: outputs a scalar reading position score per bubble
        self.score_head = nn.Sequential(
            nn.Linear(d_model, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(128, 1),
        )

    def forward(
        self,
        images,
        panels,
        bubbles,
        bubble_panels,
        bubble_crops,
        panel_mask,
        bubble_mask,
    ):
        """
        images: (B, 1, H, W) - page image
        panels: (B, P, 4) - panel bboxes
        bubbles: (B, N, 4) - bubble bboxes [x, y, w, h]
        bubble_panels: (B, N) - panel index for each bubble
        bubble_crops: (B, N, 1, S, S) - visual crops
        panel_mask: (B, P)
        bubble_mask: (B, N)

        Returns:
            scores: (B, N) - scalar reading score per bubble (higher = later)
            ranks: (B, N) - predicted normalized rank [0, 1] (0 = first, 1 = last)
        """
        B, N = bubbles.shape[:2]

        # 1. Visual features
        vis_feats = self.vis_enc(bubble_crops)  # (B, N, 128)

        # 2. Global page context
        page_vec = self.page_enc(images)  # (B, 64)
        page_vec = page_vec.unsqueeze(1).expand(-1, N, -1)  # (B, N, 64)

        # 3. Geometric features
        x, y, w, h = bubbles[..., 0], bubbles[..., 1], bubbles[..., 2], bubbles[..., 3]
        area = w * h
        aspect = h / (w + 1e-6)
        panel_idx = bubble_panels.float().unsqueeze(-1) / 10.0  # normalize
        cx = x + w / 2.0
        cy = y + h / 2.0

        # Panel-relative coordinates: where is the bubble within its panel?
        # Gather panel bboxes for each bubble
        safe_pidx = (
            bubble_panels.clamp(0, panels.shape[1] - 1).unsqueeze(-1).expand(-1, -1, 4)
        )
        panel_for_bubble = torch.gather(panels, 1, safe_pidx)  # (B, N, 4)
        px, py, pw, ph = (
            panel_for_bubble[..., 0],
            panel_for_bubble[..., 1],
            panel_for_bubble[..., 2],
            panel_for_bubble[..., 3],
        )
        rel_x = (x - px) / (pw + 1e-6)
        rel_y = (y - py) / (ph + 1e-6)
        rel_cx = (cx - px) / (pw + 1e-6)
        rel_cy = (cy - py) / (ph + 1e-6)

        # Mask out padded panels
        panel_valid = (~panel_mask.unsqueeze(1)).expand(-1, N, -1)  # (B, N, P)
        # Actually we need per-bubble validity: is the assigned panel real?
        # bubble_panels >= 0 and < num_real_panels
        num_real = (~panel_mask).sum(dim=1, keepdim=True)  # (B, 1)
        assigned_valid = (bubble_panels >= 0) & (bubble_panels < num_real)  # (B, N)
        rel_x = rel_x.masked_fill(~assigned_valid, 0.0)
        rel_y = rel_y.masked_fill(~assigned_valid, 0.0)
        rel_cx = rel_cx.masked_fill(~assigned_valid, 0.0)
        rel_cy = rel_cy.masked_fill(~assigned_valid, 0.0)

        # RTL features: Japanese manga reads right-to-left
        rtl_x = 1.0 - x
        rtl_rel_x = 1.0 - rel_x
        rtl_rel_cx = 1.0 - rel_cx

        geom = torch.stack(
            [
                area,
                aspect,
                panel_idx.squeeze(-1),
                cx,
                cy,
                rel_x,
                rel_y,
                rel_cx,
                rel_cy,
                rtl_x,
                rtl_rel_x,
                rtl_rel_cx,
            ],
            dim=-1,
        )  # (B, N, 12)

        # 4. Combine
        bubble_feats = torch.cat(
            [vis_feats, bubbles, geom, page_vec], dim=-1
        )  # (B, N, 128+4+12+64)
        tokens = self.bubble_mlp(bubble_feats)  # (B, N, d_model)

        # 5. Predict scores (no self-attention - per-bubble only)
        scores = self.score_head(tokens).squeeze(-1)  # (B, N)

        # Mask padded bubbles
        scores = scores.masked_fill(bubble_mask, -1e4)

        return scores


def listmle_loss(scores, targets, bubble_mask, intra_panel_mask, temperature=1.0):
    """
    ListMLE: List-wise Maximum Likelihood Estimation.
    Now applied PER PANEL: bubbles in different panels have their order
    determined by panel reading order, so we only optimize intra-panel.

    scores: (B, N) - predicted reading scores (higher = later in reading order)
    targets: (B, N, N) - target_matrix[i, j] = 1 if bubble i comes before j
    bubble_mask: (B, N) - True for padded bubbles
    intra_panel_mask: (B, N, N) - True if bubbles i and j are in the same panel
    """
    B, N = scores.shape
    device = scores.device

    row_sums = targets.sum(dim=2)  # (B, N)

    loss = torch.tensor(0.0, device=device)
    total_valid_panels = 0

    for b in range(B):
        valid_idx = ~bubble_mask[b]
        n = valid_idx.sum().item()
        if n < 2:
            continue

        # Group valid bubbles by panel
        # Use intra_panel_mask to find which bubbles share a panel
        # For each unique panel among valid bubbles, gather its bubbles and apply ListMLE
        valid_intra = intra_panel_mask[b, :n, :n]

        # Find connected components (panels) within the valid bubbles
        visited = set()
        panels_groups = []

        for i in range(n):
            if i in visited:
                continue
            # Find all bubbles in the same panel as i
            group = []
            queue = [i]
            while queue:
                cur = queue.pop(0)
                if cur in visited:
                    continue
                visited.add(cur)
                group.append(cur)
                # Add all bubbles in the same panel
                for j in range(n):
                    if j not in visited and valid_intra[cur, j]:
                        queue.append(j)
            panels_groups.append(group)

        # Apply ListMLE per panel group
        for group in panels_groups:
            if len(group) < 2:
                continue

            group_tensor = torch.tensor(group, device=device)
            s = scores[b, group_tensor] / temperature  # (len(group),)

            # Row sums for this group
            group_row_sums = row_sums[b, group_tensor]
            # Sort descending: higher row_sum = earlier in reading order
            _, perm_mapped = torch.sort(group_row_sums, descending=True)

            # Compute ListMLE for this panel
            log_loss = torch.tensor(0.0, device=device)
            for t in range(len(group)):
                idx_t = perm_mapped[t]
                s_t = s[idx_t]
                remaining = s[perm_mapped[t:]]
                log_sum_exp = torch.logsumexp(remaining, dim=0)
                log_loss = log_loss + (s_t - log_sum_exp)

            loss = loss - log_loss
            total_valid_panels += 1

    return loss / max(total_valid_panels, 1)


def ranking_loss(scores, targets, bubble_mask, intra_panel_mask):
    """
    scores: (B, N) - predicted reading scores
    targets: (B, N, N) - target_matrix[i, j] = 1 if bubble i comes before j
    bubble_mask: (B, N) - True for padded bubbles
    intra_panel_mask: (B, N, N) - True if bubbles i and j are in the same panel
    """
    B, N = scores.shape

    # Compute pairwise score differences
    scores_i = scores.unsqueeze(2)  # (B, 1, N)
    scores_j = scores.unsqueeze(1)  # (B, N, 1)
    score_diff = scores_j - scores_i  # (B, N, N)

    # Valid pairs: both bubbles are real, i != j, AND same panel
    valid = (~bubble_mask.unsqueeze(1)) & (~bubble_mask.unsqueeze(2))
    valid = valid & ~torch.eye(N, device=scores.device, dtype=torch.bool).unsqueeze(0)
    valid = valid & intra_panel_mask

    # Apply sigmoid to get probability that j comes after i
    probs = torch.sigmoid(score_diff)

    # Binary cross entropy
    eps = 1e-7
    loss_matrix = -(
        targets * torch.log(probs + eps) + (1 - targets) * torch.log(1 - probs + eps)
    )

    # Only count valid intra-panel pairs
    if valid.any():
        loss = loss_matrix[valid].mean()
    else:
        loss = torch.tensor(0.0, device=scores.device)

    return loss


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------


class PageDataset(Dataset):
    def __init__(self, annotations, images_dir, augment=False):
        self.augment = augment
        self.samples = []

        for page in annotations:
            img_path = os.path.join(images_dir, page["image"])
            if not os.path.exists(img_path):
                continue

            bubbles = page.get("bubbles", [])
            panels = page.get("panels", [])
            panel_assignments = page.get("panel_assignments", [])
            pairs = page.get("pairs", [])
            panel_bubbles_data = page.get("panel_bubbles", [])

            if len(bubbles) < 2:
                continue

            # Extract unique bubbles by position
            nodes = []
            for b in bubbles:
                node = (b["x"], b["y"], b["w"], b["h"])
                if node not in nodes:
                    nodes.append(node)

            node_idx = {n: i for i, n in enumerate(nodes)}
            N = len(nodes)

            # Build target matrix from pairs (intra-panel only now)
            target_matrix = np.zeros((N, N), dtype=np.float32)
            for pair in pairs:
                a = (pair["a"]["x"], pair["a"]["y"], pair["a"]["w"], pair["a"]["h"])
                b = (pair["b"]["x"], pair["b"]["y"], pair["b"]["w"], pair["b"]["h"])
                i, j = node_idx[a], node_idx[b]
                target_matrix[i, j] = pair["label"]
                target_matrix[j, i] = 1.0 - pair["label"]

            # Panel data
            panel_bboxes = []
            panel_orders = []
            for p_idx, p in enumerate(panels):
                panel_bboxes.append([p["x"], p["y"], p["w"], p["h"]])
                # Panel order = its index since panels are already sorted
                panel_orders.append(p_idx)

            # Bubble-to-panel mapping
            bubble_panel = []
            for n in nodes:
                for bi, b in enumerate(bubbles):
                    if (b["x"], b["y"], b["w"], b["h"]) == n:
                        pi = (
                            panel_assignments[bi] if bi < len(panel_assignments) else -1
                        )
                        bubble_panel.append(max(0, pi))
                        break

            # Intra-panel mask: only compare bubbles within the same panel
            intra_panel_mask = np.zeros((N, N), dtype=bool)
            for i in range(N):
                for j in range(N):
                    if i != j and bubble_panel[i] == bubble_panel[j]:
                        intra_panel_mask[i, j] = True

            # Deterministic shuffle so the model can't cheat
            rng = np.random.RandomState(abs(hash(page["image"])) % (2**31))
            perm = rng.permutation(N)
            nodes = [nodes[i] for i in perm]
            target_matrix = target_matrix[perm][:, perm]
            intra_panel_mask = intra_panel_mask[perm][:, perm]
            bubble_panel = [bubble_panel[i] for i in perm]

            self.samples.append(
                {
                    "image": img_path,
                    "nodes": nodes,
                    "panels": panel_bboxes,
                    "panel_orders": panel_orders,
                    "bubble_panel": bubble_panel,
                    "target_matrix": target_matrix,
                    "intra_panel_mask": intra_panel_mask,
                    "img_name": page["image"],
                }
            )

    def __len__(self):
        return len(self.samples)

    def _crop_bubble(self, img_np, box):
        x, y, w, h = box
        x1, y1 = max(0, int(x * MODEL_INPUT_W)), max(0, int(y * MODEL_INPUT_H))
        x2, y2 = (
            min(MODEL_INPUT_W, int((x + w) * MODEL_INPUT_W)),
            min(MODEL_INPUT_H, int((y + h) * MODEL_INPUT_H)),
        )
        crop = img_np[y1:y2, x1:x2]
        if crop.size == 0:
            crop = np.zeros((1, 1), dtype=np.float32)
        pil_crop = Image.fromarray((crop * 255).astype(np.uint8)).resize(
            (BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE), Image.BILINEAR
        )
        return np.array(pil_crop, dtype=np.float32) / 255.0

    def __getitem__(self, idx):
        sample = self.samples[idx]
        img = (
            Image.open(sample["image"])
            .convert("L")
            .resize((MODEL_INPUT_W, MODEL_INPUT_H), Image.BILINEAR)
        )
        img_np = np.array(img, dtype=np.float32) / 255.0

        # Simple augmentation (pixel-level only, preserves geometry)
        if self.augment:
            # Random brightness/contrast
            factor = np.array(np.random.uniform(0.8, 1.2), dtype=np.float32)
            img_np = img_np * factor
            img_np = np.clip(img_np, 0.0, 1.0)
            # Random Gaussian noise
            noise = np.random.normal(0, 0.02, img_np.shape).astype(np.float32)
            img_np = img_np + noise
            img_np = np.clip(img_np, 0.0, 1.0)
            # Ensure float32
            img_np = img_np.astype(np.float32)

        geoms, crops = [], []
        for x, y, w, h in sample["nodes"]:
            geoms.append([x, y, w, h])
            crops.append(self._crop_bubble(img_np, (x, y, w, h)))

        panels = sample["panels"] if sample["panels"] else [[0, 0, 1, 1]]
        bubble_panel = sample["bubble_panel"]

        return (
            torch.from_numpy(img_np).unsqueeze(0),
            torch.tensor(panels, dtype=torch.float32),
            torch.tensor(geoms, dtype=torch.float32),
            torch.tensor(np.array(crops), dtype=torch.float32).unsqueeze(1),
            torch.tensor(bubble_panel, dtype=torch.long),
            torch.tensor(sample["target_matrix"], dtype=torch.float32),
            torch.tensor(sample["intra_panel_mask"], dtype=torch.bool),
            sample["img_name"],
        )


def collate_pages(batch):
    imgs, panels, geoms, crops, bubble_panels, targets, intra_masks, img_names = zip(
        *batch
    )
    imgs = torch.stack(imgs)

    panels_padded = pad_sequence(panels, batch_first=True, padding_value=0.0)
    panel_mask = torch.ones(len(batch), panels_padded.shape[1], dtype=torch.bool)
    for b in range(len(batch)):
        panel_mask[b, : panels[b].shape[0]] = False

    geoms_padded = pad_sequence(geoms, batch_first=True, padding_value=0.0)
    crops_padded = pad_sequence(crops, batch_first=True, padding_value=0.0)
    bubble_panels_padded = pad_sequence(
        bubble_panels, batch_first=True, padding_value=0
    )

    B, max_N = len(batch), geoms_padded.shape[1]
    targets_padded = torch.zeros(B, max_N, max_N)
    intra_panel_mask_padded = torch.zeros(B, max_N, max_N, dtype=torch.bool)
    bubble_mask = torch.ones(B, max_N, dtype=torch.bool)

    for b in range(B):
        N = geoms[b].shape[0]
        targets_padded[b, :N, :N] = targets[b]
        intra_panel_mask_padded[b, :N, :N] = intra_masks[b]
        bubble_mask[b, :N] = False

    return (
        imgs,
        panels_padded,
        geoms_padded,
        crops_padded,
        bubble_panels_padded,
        targets_padded,
        intra_panel_mask_padded,
        panel_mask,
        bubble_mask,
        img_names,
    )


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def compute_exact_match(pred_order, gt_order):
    return 1.0 if list(pred_order) == list(gt_order) else 0.0


def hierarchical_sort(scores, bubble_panels):
    """
    Sort bubbles hierarchically: first by panel reading order, then by score within panel.

    Panels are already in perfect reading order (panel index = reading order).
    So we just group by panel, sort panels by their index, and sort bubbles
    within each panel by their predicted score (lower score = earlier bubble).

    scores: (N,) numpy array
    bubble_panels: (N,) list/array of panel indices
    Returns: list of bubble indices in global reading order
    """
    panel_bubbles = {}
    for i, p in enumerate(bubble_panels):
        panel_bubbles.setdefault(int(p), []).append(i)

    # Sort panels by their index (which IS the reading order)
    sorted_panels = sorted(panel_bubbles.keys())

    result = []
    for p in sorted_panels:
        idxs = panel_bubbles[p]
        # Within panel: lower score = earlier bubble
        result.extend(sorted(idxs, key=lambda i: scores[i]))
    return result


def compute_kendall_tau(pred_order, gt_order):
    n = len(pred_order)
    if n < 2:
        return 1.0
    pred_ranks = np.empty(n, dtype=int)
    pred_ranks[pred_order] = np.arange(n)
    gt_ranks = np.empty(n, dtype=int)
    gt_ranks[gt_order] = np.arange(n)

    concordant = 0
    discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            if (pred_ranks[i] < pred_ranks[j]) == (gt_ranks[i] < gt_ranks[j]):
                concordant += 1
            else:
                discordant += 1
    total_pairs = n * (n - 1) / 2
    return (concordant - discordant) / total_pairs


def compute_spearman(pred_order, gt_order):
    n = len(pred_order)
    if n < 2:
        return 1.0
    pred_ranks = np.empty(n, dtype=int)
    pred_ranks[pred_order] = np.arange(n)
    gt_ranks = np.empty(n, dtype=int)
    gt_ranks[gt_order] = np.arange(n)
    d = pred_ranks - gt_ranks
    return 1.0 - (6 * np.sum(d**2)) / (n * (n**2 - 1))


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------


def train():
    dataset_dir = SCRIPT_DIR / "dataset"
    train_ann_path = dataset_dir / "train" / "annotations.json"
    val_ann_path = dataset_dir / "val" / "annotations.json"

    if not train_ann_path.exists() or not val_ann_path.exists():
        print("Dataset not found. Run export_dataset.py first.")
        return

    with open(train_ann_path) as f:
        train_ann = json.load(f)
    with open(val_ann_path) as f:
        val_ann = json.load(f)

    print(f"Train pages: {len(train_ann)}, Val pages: {len(val_ann)}")

    train_loader = DataLoader(
        PageDataset(train_ann, str(dataset_dir / "train" / "images"), augment=True),
        batch_size=BATCH_SIZE,
        shuffle=True,
        collate_fn=collate_pages,
        num_workers=2,
        persistent_workers=True,
        pin_memory=True,
    )
    val_loader = DataLoader(
        PageDataset(val_ann, str(dataset_dir / "val" / "images")),
        batch_size=BATCH_SIZE,
        shuffle=False,
        collate_fn=collate_pages,
        num_workers=2,
        persistent_workers=True,
        pin_memory=True,
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = SimpleReaderNet().to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"Model parameters: {n_params:,}")

    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-2)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="max", factor=0.5, patience=10
    )
    scaler = torch.cuda.amp.GradScaler() if device.type == "cuda" else None

    best_val_exact = 0.0
    best_model_path = dataset_dir / "readernet_poneglyph.pt"
    epochs_no_improve = 0

    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0.0

        pbar = tqdm(train_loader, desc=f"Epoch {epoch + 1}/{EPOCHS}")
        for (
            imgs,
            panels,
            geoms,
            crops,
            bubble_panels,
            targets,
            intra_panel_mask,
            panel_mask,
            bubble_mask,
            _,
        ) in pbar:
            imgs = imgs.to(device, non_blocking=True)
            panels = panels.to(device, non_blocking=True)
            geoms = geoms.to(device, non_blocking=True)
            crops = crops.to(device, non_blocking=True)
            bubble_panels = bubble_panels.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)
            intra_panel_mask = intra_panel_mask.to(device, non_blocking=True)
            panel_mask = panel_mask.to(device, non_blocking=True)
            bubble_mask = bubble_mask.to(device, non_blocking=True)

            optimizer.zero_grad(set_to_none=True)

            with torch.cuda.amp.autocast(enabled=(scaler is not None)):
                scores = model(
                    imgs, panels, geoms, bubble_panels, crops, panel_mask, bubble_mask
                )
                loss_listmle = listmle_loss(
                    scores, targets, bubble_mask, intra_panel_mask, temperature=1.0
                )
                loss_pairwise = ranking_loss(
                    scores, targets, bubble_mask, intra_panel_mask
                )
                loss = 0.2 * loss_listmle + 1.0 * loss_pairwise

            if scaler:
                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
            else:
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()

            total_loss += loss.item()
            pbar.set_postfix(loss=f"{loss.item():.4f}")

        # Validation
        model.eval()
        val_exact_hier_pages = 0
        val_exact_raw_pages = 0
        val_total_pages = 0
        val_kendall_sum = 0.0
        val_spearman_sum = 0.0
        val_mean_rank_error = 0.0
        val_pair_acc = 0.0
        val_pair_total = 0

        with torch.no_grad():
            for (
                imgs,
                panels,
                geoms,
                crops,
                bubble_panels,
                targets,
                intra_panel_mask,
                panel_mask,
                bubble_mask,
                _,
            ) in tqdm(val_loader, desc="Val", leave=False):
                imgs = imgs.to(device, non_blocking=True)
                panels = panels.to(device, non_blocking=True)
                geoms = geoms.to(device, non_blocking=True)
                crops = crops.to(device, non_blocking=True)
                bubble_panels = bubble_panels.to(device, non_blocking=True)
                intra_panel_mask = intra_panel_mask.to(device, non_blocking=True)
                panel_mask = panel_mask.to(device, non_blocking=True)
                bubble_mask = bubble_mask.to(device, non_blocking=True)
                targets_np = targets.cpu().numpy()
                intra_panel_mask_np = intra_panel_mask.cpu().numpy()

                with torch.cuda.amp.autocast(enabled=(scaler is not None)):
                    scores = model(
                        imgs,
                        panels,
                        geoms,
                        bubble_panels,
                        crops,
                        panel_mask,
                        bubble_mask,
                    )

                scores_np = scores.cpu().numpy()
                bubble_mask_np = bubble_mask.cpu().numpy()
                bubble_panels_np = bubble_panels.cpu().numpy()

                B = imgs.size(0)
                for b in range(B):
                    N = (~bubble_mask_np[b]).sum()
                    if N < 2:
                        continue

                    # GT order: strict panel-based hierarchical order
                    # First sort panels by their reading order (panel index = order)
                    # Then sort bubbles within each panel by their GT order
                    gt_scores = targets_np[b, :N, :N].sum(axis=1)

                    # Build GT order using the same logic as inference:
                    # group by panel, sort panels, sort bubbles within panel
                    panel_bubbles_gt = {}
                    for i in range(N):
                        p = int(bubble_panels_np[b, i])
                        panel_bubbles_gt.setdefault(p, []).append(i)

                    gt_order = []
                    for p in sorted(panel_bubbles_gt.keys()):
                        idxs = panel_bubbles_gt[p]
                        # gt_scores[i] = number of bubbles this bubble comes BEFORE
                        # Higher = earlier in reading order -> sort descending
                        idxs_sorted = sorted(
                            idxs, key=lambda i: gt_scores[i], reverse=True
                        )
                        gt_order.extend(idxs_sorted)

                    # Hierarchical sort order (panel-based inference)
                    hier_order = hierarchical_sort(
                        scores_np[b, :N], bubble_panels_np[b, :N]
                    )

                    # Also compute raw global argsort for comparison
                    raw_order = np.argsort(scores_np[b, :N]).tolist()

                    # Primary metric: hierarchical exact match
                    hier_em = compute_exact_match(hier_order, gt_order)
                    val_exact_hier_pages += hier_em

                    # Track raw exact match for debugging
                    raw_em = compute_exact_match(raw_order, gt_order)
                    val_exact_raw_pages += raw_em

                    # Use hierarchical for correlation metrics
                    pred_order = hier_order
                    val_kendall_sum += compute_kendall_tau(pred_order, gt_order)
                    val_spearman_sum += compute_spearman(pred_order, gt_order)

                    pred_ranks = np.empty(N, dtype=int)
                    pred_ranks[pred_order] = np.arange(N)
                    gt_ranks_arr = np.empty(N, dtype=int)
                    gt_ranks_arr[gt_order] = np.arange(N)
                    val_mean_rank_error += np.mean(np.abs(pred_ranks - gt_ranks_arr))

                    # Pairwise accuracy: only INTRA-PANEL pairs
                    val_pair_acc_b = 0
                    val_pair_total_b = 0
                    for p, idxs in panel_bubbles_gt.items():
                        if len(idxs) < 2:
                            continue
                        for ii in range(len(idxs)):
                            for jj in range(ii + 1, len(idxs)):
                                i, j = idxs[ii], idxs[jj]
                                pred_correct = (scores_np[b, i] < scores_np[b, j]) == (
                                    gt_ranks_arr[i] < gt_ranks_arr[j]
                                )
                                val_pair_acc_b += int(pred_correct)
                                val_pair_total_b += 1

                    val_pair_acc += val_pair_acc_b
                    val_pair_total += val_pair_total_b

                    val_total_pages += 1

        val_exact_hier = (
            val_exact_hier_pages / val_total_pages if val_total_pages > 0 else 0.0
        )
        val_exact_raw = (
            val_exact_raw_pages / val_total_pages if val_total_pages > 0 else 0.0
        )
        val_kendall = val_kendall_sum / val_total_pages if val_total_pages > 0 else 0.0
        val_spearman = (
            val_spearman_sum / val_total_pages if val_total_pages > 0 else 0.0
        )
        val_rank_err = (
            val_mean_rank_error / val_total_pages if val_total_pages > 0 else 0.0
        )
        val_pair_accuracy = val_pair_acc / val_pair_total if val_pair_total > 0 else 0.0

        val_best = val_exact_hier

        print(
            f"Epoch {epoch + 1:3d} | Loss: {total_loss / len(train_loader):.4f} | "
            f"ValExact(hier): {val_exact_hier:.3f} | ValExact(raw): {val_exact_raw:.3f} | "
            f"ValKendall: {val_kendall:.3f} | "
            f"ValSpearman: {val_spearman:.3f} | ValRankErr: {val_rank_err:.3f} | "
            f"ValPairAcc: {val_pair_accuracy:.3f} | Best: {best_val_exact:.3f}",
            flush=True,
        )

        scheduler.step(val_best)

        if val_best > best_val_exact:
            best_val_exact = val_best
            epochs_no_improve = 0
            torch.save(
                {
                    "epoch": epoch + 1,
                    "model_state_dict": model.state_dict(),
                    "optimizer_state_dict": optimizer.state_dict(),
                },
                str(best_model_path),
            )
            print(f"  ** New best model saved! **")
        else:
            epochs_no_improve += 1

        if epochs_no_improve >= PATIENCE:
            print(f"Early stopping after {PATIENCE} epochs without improvement.")
            break

    # Export to ONNX
    print(f"\nLoading best model from {best_model_path} for ONNX export...")
    if best_model_path.exists():
        ckpt = torch.load(str(best_model_path), map_location=device, weights_only=False)
        model.load_state_dict(ckpt["model_state_dict"])
        model.eval()

        dummy_imgs = torch.randn(1, 1, MODEL_INPUT_H, MODEL_INPUT_W).to(device)
        dummy_panels = torch.tensor([[[0.1, 0.1, 0.4, 0.4], [0.5, 0.1, 0.4, 0.4]]]).to(
            device
        )
        dummy_geoms = torch.tensor(
            [[[0.2, 0.2, 0.1, 0.1], [0.3, 0.3, 0.1, 0.1], [0.6, 0.2, 0.1, 0.1]]]
        ).to(device)
        dummy_crops = torch.randn(1, 3, 1, BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE).to(
            device
        )
        dummy_bubble_panels = torch.tensor([[0, 0, 1]]).to(device)
        dummy_panel_mask = torch.zeros(1, 2, dtype=torch.bool).to(device)
        dummy_bubble_mask = torch.zeros(1, 3, dtype=torch.bool).to(device)

        onnx_path = dataset_dir / "readernet_poneglyph.onnx"
        torch.onnx.export(
            model,
            (
                dummy_imgs,
                dummy_panels,
                dummy_geoms,
                dummy_bubble_panels,
                dummy_crops,
                dummy_panel_mask,
                dummy_bubble_mask,
            ),
            str(onnx_path),
            input_names=[
                "images",
                "panels",
                "bubbles",
                "bubble_panels",
                "bubble_crops",
                "panel_mask",
                "bubble_mask",
            ],
            output_names=["scores"],
            dynamic_axes={
                "images": {0: "batch"},
                "panels": {0: "batch", 1: "num_panels"},
                "bubbles": {0: "batch", 1: "num_bubbles"},
                "bubble_panels": {0: "batch", 1: "num_bubbles"},
                "bubble_crops": {0: "batch", 1: "num_bubbles"},
                "panel_mask": {0: "batch", 1: "num_panels"},
                "bubble_mask": {0: "batch", 1: "num_bubbles"},
                "scores": {0: "batch", 1: "num_bubbles"},
            },
        )
        print(f"ONNX model exported to: {onnx_path}")
        return str(onnx_path)
    else:
        print("No best model found, skipping ONNX export.")
        return None


if __name__ == "__main__":
    train()
