import json
import os
from pathlib import Path
from typing import Dict, List

import numpy as np
import torch
import torch.nn as nn
import torchvision.transforms as T
from PIL import Image
from sklearn.metrics import roc_auc_score
from torch.utils.data import DataLoader, Dataset
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_DIR = SCRIPT_DIR / "dataset_reading_order"
RUNS_DIR = SCRIPT_DIR / "runs_reading_order"
RUNS_DIR.mkdir(parents=True, exist_ok=True)

# --- Config ---
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
IMG_SIZE = 224
POS_FEATURES = 12
BATCH_SIZE = 1  # one page at a time (variable number of pairs)
NUM_WORKERS = 4
LR = 1e-3
WEIGHT_DECAY = 1e-4
EPOCHS = 100
PATIENCE = 15


# --- Dataset ---
class ReadingOrderDataset(Dataset):
    def __init__(self, json_path, transform=None):
        with open(json_path) as f:
            self.pages = json.load(f)
        self.transform = transform or self._default_transform()

    def _default_transform(self):
        return T.Compose(
            [
                T.Resize((IMG_SIZE, IMG_SIZE)),
                T.ToTensor(),
                T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            ]
        )

    def __len__(self):
        return len(self.pages)

    def __getitem__(self, idx):
        page = self.pages[idx]
        with Image.open(page["image"]) as img_raw:
            img = img_raw.convert("RGB")
            crops = []
            for bbox in page["panels"]:
                crop = img.crop(tuple(bbox))
                crop = self.transform(crop)
                crops.append(crop)
        crops = torch.stack(crops)

        pairs = page["pairs"]
        n_pairs = len(pairs)

        img_a = torch.empty(n_pairs, 3, IMG_SIZE, IMG_SIZE)
        img_b = torch.empty(n_pairs, 3, IMG_SIZE, IMG_SIZE)
        pos = torch.empty(n_pairs, POS_FEATURES)
        labels = torch.empty(n_pairs)
        pair_a = torch.empty(n_pairs, dtype=torch.long)
        pair_b = torch.empty(n_pairs, dtype=torch.long)

        for i, p in enumerate(pairs):
            img_a[i] = crops[p["panel_a_idx"]]
            img_b[i] = crops[p["panel_b_idx"]]
            pos[i] = torch.tensor(p["pos"], dtype=torch.float32)
            labels[i] = float(p["label"])
            pair_a[i] = p["panel_a_idx"]
            pair_b[i] = p["panel_b_idx"]

        return {
            "img_a": img_a,
            "img_b": img_b,
            "pos": pos,
            "labels": labels,
            "pair_a": pair_a,
            "pair_b": pair_b,
            "num_panels": len(page["panels"]),
        }


# --- Model ---
class PanelOrderNet(nn.Module):
    def __init__(self, num_pos_features: int = POS_FEATURES):
        super().__init__()
        import torchvision

        backbone = torchvision.models.resnet18(weights="DEFAULT")
        self.backbone = nn.Sequential(
            *list(backbone.children())[:-1],
            nn.Flatten(),
        )
        feat_dim = 512

        self.classifier = nn.Sequential(
            nn.Linear(feat_dim * 2 + num_pos_features, 256),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(64, 1),
        )

    def forward(self, img_a, img_b, pos):
        f_a = self.backbone(img_a)
        f_b = self.backbone(img_b)
        x = torch.cat([f_a, f_b, pos], dim=-1)
        return self.classifier(x)


# --- Metrics ---
def kendall_tau(pred_ranks, true_ranks):
    n = len(pred_ranks)
    if n < 2:
        return 1.0
    concordant = 0
    discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            if pred_ranks[i] < pred_ranks[j]:
                concordant += 1
            else:
                discordant += 1
    total_pairs = n * (n - 1) / 2
    return (concordant - discordant) / total_pairs


def spearman_correlation(pred_ranks, true_ranks):
    n = len(pred_ranks)
    if n < 2:
        return 1.0
    d = (pred_ranks - true_ranks) ** 2
    return 1.0 - (6.0 * np.sum(d)) / (n * (n**2 - 1))


# --- Training ---
def train_epoch(model, loader, optimizer, criterion, device):
    model.train()
    total_loss = 0.0
    total_correct = 0
    total_samples = 0

    for batch in tqdm(loader, desc="Train"):
        img_a = batch["img_a"][0].to(device)
        img_b = batch["img_b"][0].to(device)
        pos = batch["pos"][0].to(device)
        labels = batch["labels"][0].to(device)

        logits = model(img_a, img_b, pos).squeeze()
        loss = criterion(logits, labels)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        total_loss += loss.item() * labels.size(0)
        preds = (torch.sigmoid(logits) > 0.5).float()
        total_correct += (preds == labels).sum().item()
        total_samples += labels.size(0)

    return {
        "loss": total_loss / total_samples,
        "acc": total_correct / total_samples,
    }


@torch.no_grad()
def validate(model, loader, device):
    model.eval()
    total_loss = 0.0
    total_correct = 0
    total_samples = 0

    all_probs = []
    all_labels = []

    kendall_taus = []
    spearmans = []
    exact_matches = 0
    total_pages = 0
    mean_rank_errors = []

    for batch in tqdm(loader, desc="Val"):
        img_a = batch["img_a"][0].to(device)
        img_b = batch["img_b"][0].to(device)
        pos = batch["pos"][0].to(device)
        labels = batch["labels"][0].to(device)

        logits = model(img_a, img_b, pos).squeeze()
        loss = nn.functional.binary_cross_entropy_with_logits(logits, labels)

        probs = torch.sigmoid(logits)
        preds = (probs > 0.5).float()

        total_loss += loss.item() * labels.size(0)
        total_correct += (preds == labels).sum().item()
        total_samples += labels.size(0)

        all_probs.extend(probs.cpu().numpy())
        all_labels.extend(labels.cpu().numpy())

        # Page-level ranking metrics
        num_panels = batch["num_panels"][0].item()
        pair_a = batch["pair_a"][0].cpu().numpy()
        pair_b = batch["pair_b"][0].cpu().numpy()
        logits_np = logits.cpu().numpy()

        scores = np.zeros(num_panels)
        for a, b, logit in zip(pair_a, pair_b, logits_np):
            scores[a] += logit

        pred_order = np.argsort(-scores)
        true_order = np.arange(num_panels)

        pred_ranks = np.empty(num_panels, dtype=int)
        pred_ranks[pred_order] = np.arange(num_panels)

        kendall_taus.append(kendall_tau(pred_ranks, true_order))
        spearmans.append(spearman_correlation(pred_ranks, true_order))
        if np.array_equal(pred_order, true_order):
            exact_matches += 1
        total_pages += 1
        mean_rank_errors.append(np.mean(np.abs(pred_ranks - true_order)))

    try:
        auc = roc_auc_score(all_labels, all_probs)
    except ValueError:
        auc = 0.5

    return {
        "loss": total_loss / total_samples,
        "acc": total_correct / total_samples,
        "auc": auc,
        "kendall_tau": float(np.mean(kendall_taus)),
        "spearman": float(np.mean(spearmans)),
        "exact_match_ratio": exact_matches / total_pages,
        "mean_rank_error": float(np.mean(mean_rank_errors)),
    }


def save_metrics_history(history, path):
    with open(path, "w") as f:
        json.dump(history, f, indent=2)


def train():
    print(f"Using device: {DEVICE}")

    train_dataset = ReadingOrderDataset(DATASET_DIR / "train.json")
    val_dataset = ReadingOrderDataset(DATASET_DIR / "val.json")

    train_loader = DataLoader(
        train_dataset,
        batch_size=BATCH_SIZE,
        shuffle=True,
        num_workers=NUM_WORKERS,
        pin_memory=True,
        persistent_workers=True,
    )
    val_loader = DataLoader(
        val_dataset,
        batch_size=BATCH_SIZE,
        shuffle=False,
        num_workers=NUM_WORKERS,
        pin_memory=True,
        persistent_workers=True,
    )

    model = PanelOrderNet().to(DEVICE)
    criterion = nn.BCEWithLogitsLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)

    best_kendall = -1.0
    epochs_no_improve = 0
    history = []

    for epoch in range(EPOCHS):
        print(f"\n--- Epoch {epoch + 1}/{EPOCHS} ---")
        train_metrics = train_epoch(model, train_loader, optimizer, criterion, DEVICE)
        val_metrics = validate(model, val_loader, DEVICE)
        scheduler.step()

        print(
            f"Train Loss: {train_metrics['loss']:.4f} | Train Acc: {train_metrics['acc']:.4f}"
        )
        print(
            f"Val Loss: {val_metrics['loss']:.4f} | Val Acc: {val_metrics['acc']:.4f} | Val AUC: {val_metrics['auc']:.4f}"
        )
        print(
            f"Val Kendall Tau: {val_metrics['kendall_tau']:.4f} | Spearman: {val_metrics['spearman']:.4f} | Exact Match: {val_metrics['exact_match_ratio']:.4f} | Mean Rank Error: {val_metrics['mean_rank_error']:.4f}"
        )

        entry = {
            "epoch": epoch + 1,
            "train_loss": train_metrics["loss"],
            "train_acc": train_metrics["acc"],
            **{f"val_{k}": v for k, v in val_metrics.items()},
            "lr": scheduler.get_last_lr()[0],
        }
        history.append(entry)
        save_metrics_history(history, RUNS_DIR / "metrics_history.json")

        if val_metrics["kendall_tau"] > best_kendall:
            best_kendall = val_metrics["kendall_tau"]
            epochs_no_improve = 0
            torch.save(
                {
                    "epoch": epoch + 1,
                    "model_state_dict": model.state_dict(),
                    "optimizer_state_dict": optimizer.state_dict(),
                    "metrics": val_metrics,
                },
                RUNS_DIR / "best_model.pt",
            )
            print(f"New best model saved (Kendall Tau: {best_kendall:.4f})")
        else:
            epochs_no_improve += 1
            print(f"No improvement for {epochs_no_improve} epochs.")

        if epochs_no_improve >= PATIENCE:
            print("Early stopping triggered.")
            break

    # Export best model to ONNX
    best_ckpt = RUNS_DIR / "best_model.pt"
    if not best_ckpt.exists():
        print("No best model found to export.")
        return None

    print(f"\nLoading best model from {best_ckpt} for ONNX export...")
    ckpt = torch.load(best_ckpt, map_location=DEVICE)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()

    dummy_img_a = torch.randn(10, 3, IMG_SIZE, IMG_SIZE).to(DEVICE)
    dummy_img_b = torch.randn(10, 3, IMG_SIZE, IMG_SIZE).to(DEVICE)
    dummy_pos = torch.randn(10, POS_FEATURES).to(DEVICE)

    onnx_path = RUNS_DIR / "panel_order_model.onnx"
    torch.onnx.export(
        model,
        (dummy_img_a, dummy_img_b, dummy_pos),
        str(onnx_path),
        input_names=["img_a", "img_b", "pos"],
        output_names=["logits"],
        dynamic_axes={
            "img_a": {0: "batch_size"},
            "img_b": {0: "batch_size"},
            "pos": {0: "batch_size"},
            "logits": {0: "batch_size"},
        },
    )
    print(f"ONNX model exported to: {onnx_path}")
    return str(onnx_path)


if __name__ == "__main__":
    train()
