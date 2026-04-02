import json, os, random, math
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from PIL import Image
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).resolve().parent
CANVAS_H, CANVAS_W = 256, 384
BUBBLE_CROP_SIZE = 32
BATCH_SIZE = 8
EPOCHS = 200
LR = 3e-4


class ReaderNetV6(nn.Module):
    def __init__(self, d_model=64, nhead=4, num_layers=3):
        super().__init__()
        self.d_model = d_model
        self.crop_enc = nn.Sequential(
            nn.Conv2d(1, 16, 3, stride=2, padding=1),
            nn.ReLU(inplace=True),
            nn.Conv2d(16, 32, 3, stride=2, padding=1),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(32, d_model // 2),
        )
        self.pos_enc = nn.Sequential(
            nn.Linear(8, 32),
            nn.ReLU(inplace=True),
            nn.Linear(32, d_model // 2),
        )
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=d_model * 2,
            dropout=0.1,
            activation='gelu',
            batch_first=True,
        )
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        self.score_head = nn.Linear(d_model, 1)

    def encode_position(self, geom):
        x, y, w, h = geom[:, 0], geom[:, 1], geom[:, 2], geom[:, 3]
        cx = x + w / 2
        cy = y + h / 2
        rx = 1.0 - cx
        manga_score = rx + cy * 0.5
        area = w * h
        return torch.stack([x, y, w, h, cx, cy, manga_score, area], dim=1)

    def forward(self, crops, geoms):
        N = crops.shape[0]
        if N == 0:
            return torch.zeros(0, device=crops.device)
        crop_feat = self.crop_enc(crops)
        pos_feat = self.pos_enc(self.encode_position(geoms))
        tokens = torch.cat([crop_feat, pos_feat], dim=1)
        tokens = tokens.unsqueeze(0)
        out = self.transformer(tokens)
        out = out.squeeze(0)
        scores = self.score_head(out).squeeze(-1)
        return scores


class PageDataset(Dataset):
    def __init__(self, annotations, images_dir, augment=False):
        self.augment = augment
        self.images = {}
        self.pages = []
        for page in annotations:
            p = os.path.join(images_dir, page["image"])
            if not os.path.exists(p):
                continue
            img = (
                Image.open(p).convert("L").resize((CANVAS_W, CANVAS_H), Image.BILINEAR)
            )
            self.images[page["image"]] = np.array(img, dtype=np.float32) / 255.0
            bubbles = []
            for pair in page["pairs"]:
                a = pair["a"]
                if not any(
                    abs(b["x"] - a["x"]) < 1e-6 and abs(b["y"] - a["y"]) < 1e-6
                    for b in bubbles
                ):
                    bubbles.append(a)
            self.pages.append({"image": page["image"], "bubbles": bubbles})

    def __len__(self):
        return len(self.pages)

    def _crop(self, img, box):
        x1, y1 = max(0, int(box["x"] * CANVAS_W)), max(0, int(box["y"] * CANVAS_H))
        x2, y2 = (
            min(CANVAS_W, int((box["x"] + box["w"]) * CANVAS_W)),
            min(CANVAS_H, int((box["y"] + box["h"]) * CANVAS_H)),
        )
        if x2 <= x1 or y2 <= y1:
            return np.zeros((BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE), dtype=np.float32)
        return (
            np.array(
                Image.fromarray((img[y1:y2, x1:x2] * 255).astype(np.uint8)).resize(
                    (BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE), Image.BILINEAR
                ),
                dtype=np.float32,
            )
            / 255.0
        )

    def __getitem__(self, idx):
        page = self.pages[idx]
        img = self.images[page["image"]].copy()
        if self.augment:
            if random.random() > 0.5:
                img = np.clip(img ** random.uniform(0.8, 1.2), 0, 1)
            if random.random() > 0.5:
                img = np.clip(
                    img + np.random.normal(0, random.uniform(0.01, 0.02), img.shape),
                    0,
                    1,
                ).astype(np.float32)
        geoms, crops = [], []
        for b in page["bubbles"]:
            geoms.append([b["x"], b["y"], b["w"], b["h"]])
            crops.append(self._crop(img, b))
        return (
            torch.from_numpy(img).unsqueeze(0),
            torch.tensor(geoms, dtype=torch.float32),
            torch.tensor(np.array(crops), dtype=torch.float32).unsqueeze(1),
            page["image"],
        )


def compute_loss(scores, gt_order):
    N = len(gt_order)
    if N <= 1:
        return scores.sum() * 0.0
    loss = torch.tensor(0.0, device=scores.device)
    count = 0
    for i in range(N):
        for j in range(i + 1, N):
            si = scores[gt_order[i]]
            sj = scores[gt_order[j]]
            loss = loss + torch.log(1 + torch.exp(sj - si))
            count += 1
    return loss / count


def collate_pages(batch):
    return (
        [b[0] for b in batch],
        [b[1] for b in batch],
        [b[2] for b in batch],
        [list(range(b[1].shape[0])) for b in batch],
        [b[3] for b in batch],
    )


def kendall_tau(pred, gt):
    n = len(pred)
    if n <= 1:
        return 1.0
    concordant = 0
    discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            pred_order = pred.index(i) - pred.index(j)
            gt_order = gt.index(i) - gt.index(j)
            if pred_order * gt_order > 0:
                concordant += 1
            elif pred_order * gt_order < 0:
                discordant += 1
    total = concordant + discordant
    if total == 0:
        return 1.0
    return (concordant - discordant) / total


def train():
    ds_dir = SCRIPT_DIR / "dataset"
    with open(ds_dir / "train/annotations.json") as f:
        train_ann = json.load(f)
    with open(ds_dir / "val/annotations.json") as f:
        val_ann = json.load(f)

    train_dl = DataLoader(
        PageDataset(train_ann, str(ds_dir / "train/images"), augment=True),
        batch_size=BATCH_SIZE,
        shuffle=True,
        num_workers=4,
        pin_memory=True,
        collate_fn=collate_pages,
    )
    val_dl = DataLoader(
        PageDataset(val_ann, str(ds_dir / "val/images"), augment=False),
        batch_size=BATCH_SIZE,
        shuffle=False,
        num_workers=2,
        pin_memory=True,
        collate_fn=collate_pages,
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = ReaderNetV6().to(device)
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"ReaderNet V6 Transformer | Params: {n_params:,} | Device: {device}")

    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-2)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=LR, epochs=EPOCHS, steps_per_epoch=len(train_dl)
    )

    best_exact, patience = 0.0, 0
    model_path = ds_dir / "readernet_v6.pt"
    log_path = ds_dir / "training_log.json"
    log = []

    for epoch in range(EPOCHS):
        model.train()
        t_loss, t_pages = 0.0, 0
        pbar = tqdm(train_dl, desc=f"Epoch {epoch + 1}/{EPOCHS}")

        for images, geoms_list, crops_list, gt_orders, names in pbar:
            opt.zero_grad(set_to_none=True)
            batch_loss = torch.tensor(0.0, device=device)

            for pi in range(len(images)):
                geoms = geoms_list[pi].to(device)
                crops = crops_list[pi].to(device)
                gt = gt_orders[pi]
                N = len(gt)
                if N < 2:
                    continue

                scores = model(crops, geoms)
                batch_loss = batch_loss + compute_loss(scores, gt)

            batch_loss = batch_loss / max(len(images), 1)
            batch_loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            scheduler.step()
            t_loss += batch_loss.item()
            t_pages += 1
            pbar.set_postfix(loss=f"{batch_loss.item():.4f}")

        model.eval()
        exact, total = 0, 0
        total_tau = 0.0
        with torch.no_grad():
            for images, geoms_list, crops_list, gt_orders, names in val_dl:
                for pi in range(len(images)):
                    geoms = geoms_list[pi].to(device)
                    crops = crops_list[pi].to(device)
                    gt = gt_orders[pi]
                    N = len(gt)
                    if N < 2:
                        continue

                    scores = model(crops, geoms)
                    pred = sorted(
                        range(N), key=lambda i: scores[i].item(), reverse=True
                    )
                    if pred == gt:
                        exact += 1
                    total_tau += kendall_tau(pred, gt)
                    total += 1

        ve = exact / total if total else 0
        avg_tau = total_tau / total if total else 0
        if ve > best_exact:
            best_exact = ve
            patience = 0
            torch.save(model.state_dict(), str(model_path))
            print(f"  ** New best: {best_exact:.3f} ({exact}/{total}) **")
        else:
            patience += 1

        print(
            f"Epoch {epoch + 1:3d} | Loss: {t_loss / max(t_pages, 1):.4f} | ValExact: {ve:.3f} | Tau: {avg_tau:.3f} | Best: {best_exact:.3f} | P: {patience}/60",
            flush=True,
        )
        log.append(
            {
                "epoch": epoch + 1,
                "loss": round(t_loss / max(t_pages, 1), 5),
                "val_exact": round(ve, 4),
                "kendall_tau": round(avg_tau, 4),
                "best": round(best_exact, 4),
            }
        )
        if (epoch + 1) % 10 == 0:
            with open(log_path, "w") as f:
                json.dump(log, f)
        if patience >= 60:
            print(f"Early stop at {epoch + 1}. Best: {best_exact:.3f}")
            break

    with open(log_path, "w") as f:
        json.dump(log, f)
    print(f"\nDone. Best ValExact: {best_exact:.3f}")


if __name__ == "__main__":
    train()