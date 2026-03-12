import json
import os
import random
import numpy as np
from PIL import Image
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
import torchvision.transforms as T

IMG_SIZE = 256

class ReadingOrderCNN(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(5, 32, 3, stride=2, padding=1),
            nn.BatchNorm2d(32), nn.ReLU(),
            nn.Conv2d(32, 64, 3, stride=2, padding=1),
            nn.BatchNorm2d(64), nn.ReLU(),
            nn.Conv2d(64, 128, 3, stride=2, padding=1),
            nn.BatchNorm2d(128), nn.ReLU(),
            nn.Conv2d(128, 128, 3, stride=2, padding=1),
            nn.BatchNorm2d(128), nn.ReLU(),
            nn.AdaptiveAvgPool2d(1),
        )
        self.classifier = nn.Sequential(
            nn.Dropout(0.4),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(64, 1),
        )

    def forward(self, x):
        return self.classifier(self.features(x).flatten(1))

class PairDataset(Dataset):
    def __init__(self, annotations, images_dir, augment=False):
        self.images_dir = images_dir
        self.augment = augment
        self.image_cache = {}
        self.pairs = []

        for page in annotations:
            img_path = os.path.join(images_dir, page['image'])
            if not os.path.exists(img_path):
                continue
            img = Image.open(img_path).convert('RGB')
            self.image_cache[page['image']] = img

            bubbles = page['bubbles']
            n = len(bubbles)
            for i in range(n):
                for j in range(i + 1, n):
                    self.pairs.append((page['image'], bubbles[i], bubbles[j], 1.0))
                    self.pairs.append((page['image'], bubbles[j], bubbles[i], 0.0))

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, idx):
        img_name, box_a, box_b, label = self.pairs[idx]
        img = self.image_cache[img_name]
        orig_w, orig_h = img.size

        img_resized = img.resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)

        if self.augment:
            img_resized = T.ColorJitter(
                brightness=0.3, contrast=0.3, saturation=0.2
            )(img_resized)

        img_tensor = T.ToTensor()(img_resized)

        mask_a = torch.zeros(1, IMG_SIZE, IMG_SIZE)
        mask_b = torch.zeros(1, IMG_SIZE, IMG_SIZE)

        def fill_mask(mask, box):
            x1 = max(0, int(box['x'] / orig_w * IMG_SIZE))
            y1 = max(0, int(box['y'] / orig_h * IMG_SIZE))
            x2 = min(IMG_SIZE, int((box['x'] + box['w']) / orig_w * IMG_SIZE))
            y2 = min(IMG_SIZE, int((box['y'] + box['h']) / orig_h * IMG_SIZE))
            mask[0, y1:y2, x1:x2] = 1.0

        fill_mask(mask_a, box_a)
        fill_mask(mask_b, box_b)

        input_tensor = torch.cat([img_tensor, mask_a, mask_b], dim=0)

        return input_tensor, torch.tensor([label], dtype=torch.float32)

def train(annotations_path, images_dir, output_path="reading_order.onnx"):
    with open(annotations_path) as f:
        annotations = json.load(f)

    random.shuffle(annotations)
    split = max(1, int(len(annotations) * 0.85))
    train_annot = annotations[:split]
    val_annot = annotations[split:]

    print(f"Pages: {len(train_annot)} train, {len(val_annot)} val")

    train_set = PairDataset(train_annot, images_dir, augment=True)
    val_set = PairDataset(val_annot, images_dir, augment=False)

    print(f"Pairs: {len(train_set)} train, {len(val_set)} val")

    train_loader = DataLoader(train_set, batch_size=32, shuffle=True, num_workers=4, pin_memory=True)
    val_loader = DataLoader(val_set, batch_size=32, num_workers=4, pin_memory=True)

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"Device: {device}")

    model = ReadingOrderCNN().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=120)
    criterion = nn.BCEWithLogitsLoss()

    best_val_acc = 0

    for epoch in range(120):
        model.train()
        total_loss, correct, total = 0, 0, 0

        for inputs, labels in train_loader:
            inputs, labels = inputs.to(device), labels.to(device)

            optimizer.zero_grad()
            outputs = model(inputs)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * inputs.size(0)
            preds = (outputs > 0).float()
            correct += (preds == labels).sum().item()
            total += labels.size(0)

        model.eval()
        val_correct, val_total = 0, 0
        with torch.no_grad():
            for inputs, labels in val_loader:
                inputs, labels = inputs.to(device), labels.to(device)
                outputs = model(inputs)
                preds = (outputs > 0).float()
                val_correct += (preds == labels).sum().item()
                val_total += labels.size(0)

        train_acc = correct / total
        val_acc = val_correct / val_total if val_total > 0 else 0
        scheduler.step()

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            torch.save(model.state_dict(), "best_model.pt")

        if (epoch + 1) % 10 == 0:
            print(f"Epoch {epoch+1:3d} | loss={total_loss/total:.4f} | train={train_acc:.3f} | val={val_acc:.3f} | best={best_val_acc:.3f}")

    model.load_state_dict(torch.load("best_model.pt"))
    model.eval()
    model.cpu()

    class ExportModel(nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m
        def forward(self, x):
            return torch.sigmoid(self.m(x))

    export_model = ExportModel(model)
    dummy = torch.randn(1, 5, IMG_SIZE, IMG_SIZE)

    torch.onnx.export(
        export_model, dummy, output_path,
        input_names=["input"],
        output_names=["output"],
        opset_version=17,
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}}
    )

    size_kb = os.path.getsize(output_path) / 1024
    print(f"\nExported: {output_path} ({size_kb:.0f} KB)")
    print(f"Best val accuracy: {best_val_acc:.3f}")

if __name__ == '__main__':
    # Get current script directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    dataset_dir = os.path.join(script_dir, '..', 'dataset')
    
    train(
        annotations_path=os.path.join(dataset_dir, "annotations.json"),
        images_dir=os.path.join(dataset_dir, "pages/"),
        output_path=os.path.join(script_dir, "reading_order.onnx")
    )
