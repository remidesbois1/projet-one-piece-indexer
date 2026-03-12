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
torch.backends.cudnn.benchmark = True

class ResidualBlock(nn.Module):
    def __init__(self, in_channels, out_channels, stride=1):
        super().__init__()
        self.conv1 = nn.Conv2d(in_channels, out_channels, kernel_size=3, stride=stride, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(out_channels)
        self.relu = nn.ReLU(inplace=True)
        self.conv2 = nn.Conv2d(out_channels, out_channels, kernel_size=3, stride=1, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(out_channels)
        self.shortcut = nn.Sequential()
        if stride != 1 or in_channels != out_channels:
            self.shortcut = nn.Sequential(
                nn.Conv2d(in_channels, out_channels, kernel_size=1, stride=stride, bias=False),
                nn.BatchNorm2d(out_channels)
            )
    def forward(self, x):
        out = self.relu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        out += self.shortcut(x)
        return self.relu(out)

class MonsterNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.stem = nn.Sequential(
            nn.Conv2d(7, 64, kernel_size=7, stride=2, padding=3, bias=False),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(3, 2, 1)
        )
        self.layer1 = nn.Sequential(ResidualBlock(64, 64), ResidualBlock(64, 64))
        self.layer2 = nn.Sequential(ResidualBlock(64, 128, 2), ResidualBlock(128, 128))
        self.layer3 = nn.Sequential(ResidualBlock(128, 256, 2), ResidualBlock(256, 256))
        self.layer4 = nn.Sequential(ResidualBlock(256, 512, 2), ResidualBlock(512, 512))
        self.avgpool = nn.AdaptiveAvgPool2d(8)
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(512 * 8 * 8, 1024),
            nn.ReLU(inplace=True),
            nn.Dropout(0.5),
            nn.Linear(1024, 1)
        )
    def forward(self, x):
        x = self.stem(x)
        x = self.layer1(x); x = self.layer2(x)
        x = self.layer3(x); x = self.layer4(x)
        x = self.avgpool(x)
        return self.classifier(x)

class PairDataset(Dataset):
    def __init__(self, annotations, images_dir, augment=False):
        self.images_dir = images_dir
        self.augment = augment
        self.image_cache = {}
        self.pairs = []
        xx, yy = np.meshgrid(np.linspace(-1, 1, IMG_SIZE), np.linspace(-1, 1, IMG_SIZE))
        self.coord_maps = torch.from_numpy(np.stack([xx, yy], axis=0)).float()
        for page in annotations:
            img_path = os.path.join(images_dir, page['image'])
            if not os.path.exists(img_path): continue
            img = Image.open(img_path).convert('RGB')
            w, h = img.size
            img_resized = img.resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
            self.image_cache[page['image']] = (T.ToTensor()(img_resized), w, h)
            bubbles = page['bubbles']
            for i in range(len(bubbles)):
                for j in range(i + 1, len(bubbles)):
                    self.pairs.append((page['image'], bubbles[i], bubbles[j], 1.0))
                    self.pairs.append((page['image'], bubbles[j], bubbles[i], 0.0))
    def __len__(self): return len(self.pairs)
    def __getitem__(self, idx):
        img_name, box_a, box_b, label = self.pairs[idx]
        img_tensor, orig_w, orig_h = self.image_cache[img_name]
        current_img = img_tensor
        if self.augment:
            if random.random() > 0.5:
                current_img = T.ColorJitter(brightness=0.3, contrast=0.3)(current_img)
            if random.random() > 0.8:
                current_img = T.Grayscale(3)(current_img)
        mask_a = torch.zeros(1, IMG_SIZE, IMG_SIZE)
        mask_b = torch.zeros(1, IMG_SIZE, IMG_SIZE)
        def fill_mask(mask, box):
            x1 = max(0, int(box['x'] / orig_w * IMG_SIZE))
            y1 = max(0, int(box['y'] / orig_h * IMG_SIZE))
            x2 = min(IMG_SIZE, int((box['x'] + box['w']) / orig_w * IMG_SIZE))
            y2 = min(IMG_SIZE, int((box['y'] + box['h']) / orig_h * IMG_SIZE))
            mask[0, y1:y2, x1:x2] = 1.0
        fill_mask(mask_a, box_a); fill_mask(mask_b, box_b)
        input_tensor = torch.cat([current_img, mask_a, mask_b, self.coord_maps], dim=0)
        return input_tensor, torch.tensor([label], dtype=torch.float32)

def train():
    s_dir = os.path.dirname(os.path.abspath(__file__))
    d_dir = os.path.join(s_dir, '..', 'dataset')
    with open(os.path.join(d_dir, "annotations.json")) as f: annotations = json.load(f)
    random.shuffle(annotations)
    split = int(len(annotations) * 0.9)
    train_set = PairDataset(annotations[:split], os.path.join(d_dir, "pages/"), augment=True)
    val_set = PairDataset(annotations[split:], os.path.join(d_dir, "pages/"), augment=False)
    train_loader = DataLoader(train_set, batch_size=256, shuffle=True, num_workers=0, pin_memory=True)
    val_loader = DataLoader(val_set, batch_size=256, num_workers=0, pin_memory=True)
    device = torch.device('cuda')
    model = MonsterNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4, weight_decay=1e-2)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=1e-3, total_steps=150*len(train_loader), pct_start=0.1)
    criterion = nn.BCEWithLogitsLoss()
    scaler = torch.amp.GradScaler('cuda')
    best_val_acc = 0
    for epoch in range(150):
        model.train()
        total_loss, correct, total = 0, 0, 0
        for inputs, labels in train_loader:
            inputs, labels = inputs.to(device, non_blocking=True), labels.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast('cuda'):
                outputs = model(inputs)
                loss = criterion(outputs, labels)
            scaler.scale(loss).backward()
            scaler.step(optimizer); scaler.update(); scheduler.step()
            total_loss += loss.item() * inputs.size(0)
            correct += ((outputs > 0).float() == labels).sum().item(); total += labels.size(0)
        model.eval()
        v_correct, v_total = 0, 0
        with torch.no_grad():
            for inputs, labels in val_loader:
                inputs, labels = inputs.to(device, non_blocking=True), labels.to(device, non_blocking=True)
                with torch.amp.autocast('cuda'): outputs = model(inputs)
                v_correct += ((outputs > 0).float() == labels).sum().item(); v_total += labels.size(0)
        val_acc = v_correct / v_total if v_total > 0 else 0
        if val_acc > best_val_acc:
            best_val_acc = val_acc
            torch.save(model.state_dict(), "best_model_v2.pt")
        print(f"Epoch {epoch+1:3d} | Loss: {total_loss/total:.4f} | Train: {correct/total:.3f} | Val: {val_acc:.3f} | Best: {best_val_acc:.3f}")

if __name__ == '__main__': train()
