import json
import os
import random
import numpy as np
from pathlib import Path
from PIL import Image
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader

SCRIPT_DIR = Path(__file__).resolve().parent

CANVAS_H = 256
CANVAS_W = 384
GEOM_DIM = 12
FEAT_DIM = 128
BATCH_SIZE = 256
EPOCHS = 100
LR = 3e-4

torch.backends.cudnn.benchmark = True


class InvertedResidual(nn.Module):
    def __init__(self, inp, oup, stride, expand_ratio):
        super().__init__()
        self.use_res = stride == 1 and inp == oup
        hidden = int(inp * expand_ratio)
        layers = []
        if expand_ratio != 1:
            layers += [nn.Conv2d(inp, hidden, 1, bias=False), nn.BatchNorm2d(hidden), nn.ReLU6(inplace=True)]
        layers += [
            nn.Conv2d(hidden, hidden, 3, stride, 1, groups=hidden, bias=False),
            nn.BatchNorm2d(hidden),
            nn.ReLU6(inplace=True),
            nn.Conv2d(hidden, oup, 1, bias=False),
            nn.BatchNorm2d(oup),
        ]
        self.conv = nn.Sequential(*layers)

    def forward(self, x):
        if self.use_res:
            return x + self.conv(x)
        return self.conv(x)


class PageBackbone(nn.Module):
    def __init__(self):
        super().__init__()
        self.stem = nn.Sequential(
            nn.Conv2d(1, 16, 3, stride=2, padding=1, bias=False),
            nn.BatchNorm2d(16),
            nn.ReLU6(inplace=True),
        )
        self.blocks = nn.Sequential(
            InvertedResidual(16, 16, 1, 1),
            InvertedResidual(16, 24, 2, 6),
            InvertedResidual(24, 24, 1, 6),
            InvertedResidual(24, 40, 2, 6),
            InvertedResidual(40, 40, 1, 6),
            InvertedResidual(40, 80, 2, 6),
            InvertedResidual(80, 80, 1, 6),
            InvertedResidual(80, 112, 1, 6),
            InvertedResidual(112, 112, 1, 6),
            InvertedResidual(112, FEAT_DIM, 2, 6),
        )
        self.pool = nn.AdaptiveAvgPool2d(1)

    def forward(self, x):
        x = self.stem(x)
        x = self.blocks(x)
        x = self.pool(x)
        return x.flatten(1)


class ReadingOrderHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.mlp = nn.Sequential(
            nn.Linear(FEAT_DIM + GEOM_DIM, 128),
            nn.ReLU(inplace=True),
            nn.Dropout(0.3),
            nn.Linear(128, 64),
            nn.ReLU(inplace=True),
            nn.Dropout(0.2),
            nn.Linear(64, 1),
        )

    def forward(self, page_feat, geom):
        x = torch.cat([page_feat, geom], dim=1)
        return self.mlp(x)


class ReaderNetV5(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = PageBackbone()
        self.head = ReadingOrderHead()

    def forward(self, image, geom):
        feat = self.backbone(image)
        return self.head(feat, geom)


class PagePairDataset(Dataset):
    def __init__(self, annotations, images_dir, augment=False):
        self.images_dir = images_dir
        self.augment = augment
        self.page_images = {}
        self.samples = []

        for page in annotations:
            img_path = os.path.join(images_dir, page["image"])
            if not os.path.exists(img_path):
                continue

            img = Image.open(img_path).convert("L")
            if img.size != (CANVAS_W, CANVAS_H):
                img = img.resize((CANVAS_W, CANVAS_H), Image.BILINEAR)
            self.page_images[page["image"]] = np.array(img, dtype=np.float32) / 255.0

            for pair in page["pairs"]:
                geom = [
                    pair["a"]["x"], pair["a"]["y"], pair["a"]["w"], pair["a"]["h"],
                    pair["b"]["x"], pair["b"]["y"], pair["b"]["w"], pair["b"]["h"],
                    pair["rel"]["dx"], pair["rel"]["dy"], pair["rel"]["dist"], pair["rel"]["angle"],
                ]
                self.samples.append((page["image"], geom, pair["label"]))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        img_name, geom, label = self.samples[idx]
        img = self.page_images[img_name].copy()

        if self.augment:
            if random.random() > 0.7:
                brightness = random.uniform(0.7, 1.3)
                img = np.clip(img * brightness, 0, 1)
            if random.random() > 0.9:
                noise = np.random.normal(0, 0.02, img.shape).astype(np.float32)
                img = np.clip(img + noise, 0, 1)

        img_tensor = torch.from_numpy(img).unsqueeze(0)
        geom_tensor = torch.tensor(geom, dtype=torch.float32)
        label_tensor = torch.tensor([label], dtype=torch.float32)
        return img_tensor, geom_tensor, label_tensor


def train():
    dataset_dir = SCRIPT_DIR / "dataset"
    train_dir = dataset_dir / "train"
    val_dir = dataset_dir / "val"

    with open(train_dir / "annotations.json") as f:
        train_ann = json.load(f)
    with open(val_dir / "annotations.json") as f:
        val_ann = json.load(f)

    train_set = PagePairDataset(train_ann, str(train_dir / "images"), augment=True)
    val_set = PagePairDataset(val_ann, str(val_dir / "images"), augment=False)

    print(f"Train: {len(train_set)} pairs from {len(train_ann)} pages")
    print(f"Val:   {len(val_set)} pairs from {len(val_ann)} pages")

    train_loader = DataLoader(train_set, batch_size=BATCH_SIZE, shuffle=True, num_workers=4, pin_memory=True)
    val_loader = DataLoader(val_set, batch_size=BATCH_SIZE, num_workers=4, pin_memory=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

    model = ReaderNetV5().to(device)
    param_count = sum(p.numel() for p in model.parameters())
    print(f"Parameters: {param_count:,} ({param_count * 4 / 1024 / 1024:.1f} MB)")

    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-2)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=LR * 10, total_steps=EPOCHS * len(train_loader), pct_start=0.1
    )
    criterion = nn.BCEWithLogitsLoss()
    scaler = torch.amp.GradScaler("cuda") if device.type == "cuda" else None

    best_val_acc = 0
    model_path = dataset_dir / "readernet_v5.pt"
    onnx_path = dataset_dir / "readernet_v5.onnx"

    for epoch in range(EPOCHS):
        model.train()
        total_loss, correct, total = 0.0, 0, 0

        for imgs, geoms, labels in train_loader:
            imgs = imgs.to(device, non_blocking=True)
            geoms = geoms.to(device, non_blocking=True)
            labels = labels.to(device, non_blocking=True)

            optimizer.zero_grad(set_to_none=True)

            if scaler:
                with torch.amp.autocast("cuda"):
                    outputs = model(imgs, geoms)
                    loss = criterion(outputs, labels)
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
            else:
                outputs = model(imgs, geoms)
                loss = criterion(outputs, labels)
                loss.backward()
                optimizer.step()

            scheduler.step()
            total_loss += loss.item() * imgs.size(0)
            with torch.no_grad():
                preds = (outputs > 0).float()
                correct += (preds == labels).sum().item()
            total += labels.size(0)

        model.eval()
        v_correct, v_total = 0, 0
        with torch.no_grad():
            for imgs, geoms, labels in val_loader:
                imgs = imgs.to(device, non_blocking=True)
                geoms = geoms.to(device, non_blocking=True)
                labels = labels.to(device, non_blocking=True)
                if scaler:
                    with torch.amp.autocast("cuda"):
                        outputs = model(imgs, geoms)
                else:
                    outputs = model(imgs, geoms)
                preds = (outputs > 0).float()
                v_correct += (preds == labels).sum().item()
                v_total += labels.size(0)

        val_acc = v_correct / v_total if v_total > 0 else 0
        train_acc = correct / total if total > 0 else 0

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            torch.save(model.state_dict(), str(model_path))

        print(f"Epoch {epoch+1:3d}/{EPOCHS} | Loss: {total_loss/total:.4f} | Train: {train_acc:.3f} | Val: {val_acc:.3f} | Best: {best_val_acc:.3f}")

    print(f"\nTraining complete. Best val: {best_val_acc:.3f}")

    print("Exporting to ONNX...")
    model.load_state_dict(torch.load(str(model_path), weights_only=True))
    model.eval()
    model.cpu()

    dummy_img = torch.randn(1, 1, CANVAS_H, CANVAS_W)
    dummy_geom = torch.randn(1, GEOM_DIM)

    torch.onnx.export(
        model,
        (dummy_img, dummy_geom),
        str(onnx_path),
        input_names=["image", "geometry"],
        output_names=["prediction"],
        dynamic_axes={
            "image": {0: "batch"},
            "geometry": {0: "batch"},
            "prediction": {0: "batch"},
        },
        opset_version=17,
    )

    onnx_size = os.path.getsize(str(onnx_path)) / 1024 / 1024
    print(f"ONNX exported: {onnx_path} ({onnx_size:.1f} MB)")
    return str(onnx_path)


if __name__ == "__main__":
    train()
