import warnings
# On ignore les warnings inutiles qui spamment la console
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

import json
import os
import random
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from PIL import Image
from torch.utils.data import Dataset, DataLoader
from torchvision.ops import roi_align
from torch.nn.utils.rnn import pad_sequence
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).resolve().parent

CANVAS_H = 256
CANVAS_W = 384
FEAT_DIM = 128
BUBBLE_CROP_SIZE = 32
BATCH_SIZE = 8  # Réduit car on batch par PAGE complète maintenant
EPOCHS = 180
LR = 3e-4


# ---------------------------------------------------------------------------
# Blocs de base & Backbone
# ---------------------------------------------------------------------------

class SqueezeExcite(nn.Module):
    def __init__(self, in_chs, se_ratio=0.25):
        super().__init__()
        reduced_chs = max(1, int(in_chs * se_ratio))
        self.avg_pool = nn.AdaptiveAvgPool2d(1)
        self.conv_reduce = nn.Conv2d(in_chs, reduced_chs, 1)
        self.act1 = nn.SiLU(inplace=True)
        self.conv_expand = nn.Conv2d(reduced_chs, in_chs, 1)
        self.gate = nn.Sigmoid()

    def forward(self, x):
        return x * self.gate(self.conv_expand(self.act1(self.conv_reduce(self.avg_pool(x)))))

class InvertedResidual(nn.Module):
    def __init__(self, inp, oup, stride, expand_ratio, use_se=True):
        super().__init__()
        self.use_res = stride == 1 and inp == oup
        hidden = int(inp * expand_ratio)
        layers = []
        if expand_ratio != 1:
            layers += [nn.Conv2d(inp, hidden, 1, bias=False), nn.BatchNorm2d(hidden), nn.SiLU(inplace=True)]
        layers += [nn.Conv2d(hidden, hidden, 3, stride, 1, groups=hidden, bias=False), nn.BatchNorm2d(hidden), nn.SiLU(inplace=True)]
        if use_se: layers.append(SqueezeExcite(hidden))
        layers += [nn.Conv2d(hidden, oup, 1, bias=False), nn.BatchNorm2d(oup)]
        self.conv = nn.Sequential(*layers)

    def forward(self, x):
        return x + self.conv(x) if self.use_res else self.conv(x)

class FPNBackbone(nn.Module):
    def __init__(self, out_channels=FEAT_DIM):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(3, 24, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(24), nn.SiLU(inplace=True))
        self.stage1 = nn.Sequential(InvertedResidual(24, 24, 1, 1), InvertedResidual(24, 32, 2, 6), InvertedResidual(32, 32, 1, 6))
        self.stage2 = nn.Sequential(InvertedResidual(32, 48, 2, 6), InvertedResidual(48, 48, 1, 6), InvertedResidual(48, 64, 1, 6))
        self.stage3 = nn.Sequential(InvertedResidual(64, 96, 2, 6), InvertedResidual(96, 96, 1, 6), InvertedResidual(96, 160, 1, 6), InvertedResidual(160, out_channels, 1, 6))
        self.lat1 = nn.Conv2d(32, out_channels, 1, bias=False)
        self.lat2 = nn.Conv2d(64, out_channels, 1, bias=False)
        self.lat3 = nn.Conv2d(out_channels, out_channels, 1, bias=False)
        self.smooth1 = nn.Sequential(nn.Conv2d(out_channels, out_channels, 3, padding=1, bias=False), nn.BatchNorm2d(out_channels), nn.SiLU(inplace=True))
        self.smooth2 = nn.Sequential(nn.Conv2d(out_channels, out_channels, 3, padding=1, bias=False), nn.BatchNorm2d(out_channels), nn.SiLU(inplace=True))

    def forward(self, x):
        c1, c2, c3 = self.stage1(self.stem(x)), self.stage2(self.stage1(self.stem(x))), self.stage3(self.stage2(self.stage1(self.stem(x))))
        p3 = self.lat3(c3)
        p2 = self.smooth2(self.lat2(c2) + F.interpolate(p3, size=c2.shape[-2:], mode="nearest"))
        p1 = self.smooth1(self.lat1(c1) + F.interpolate(p2, size=c1.shape[-2:], mode="nearest"))
        return p1, p2, p3

class BubbleCropEncoder(nn.Module):
    def __init__(self, out_dim=64):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(1, 16, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(16), nn.SiLU(inplace=True),
            nn.Conv2d(16, 32, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(32), nn.SiLU(inplace=True),
            SqueezeExcite(32),
            nn.Conv2d(32, 64, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(64), nn.SiLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
        )
        self.proj = nn.Linear(64, out_dim)

    def forward(self, x):
        return self.proj(self.net(x).flatten(1))

class FourierPositionalEncoding(nn.Module):
    def __init__(self, in_dim, num_freqs=8):
        super().__init__()
        self.register_buffer("freqs", torch.exp(torch.linspace(0, np.log(100), num_freqs)))
        self.out_dim = in_dim * (2 * num_freqs + 1)

    def forward(self, x):
        B, D = x.shape
        x_exp = x.unsqueeze(-1) * self.freqs * np.pi
        return torch.cat([x.unsqueeze(-1), torch.sin(x_exp), torch.cos(x_exp)], dim=-1).view(B, -1)

# ---------------------------------------------------------------------------
# Modèle Principal : ReaderNet V8 (Architecture Contextuelle)
# ---------------------------------------------------------------------------

class ReaderNetV8(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = FPNBackbone(out_channels=FEAT_DIM)
        self.crop_encoder = BubbleCropEncoder(out_dim=64)
        
        self.geom_enc = FourierPositionalEncoding(9, num_freqs=8)
        
        feat_roi_dim = FEAT_DIM * 16 # 4x4 ROI
        raw_token_dim = FEAT_DIM + feat_roi_dim + 64 + self.geom_enc.out_dim
        
        # Projection pour avoir une dimension propre et divisible par nhead
        self.d_model = 1024
        self.feature_proj = nn.Linear(raw_token_dim, self.d_model)

        # Le Transformer qui permet aux bulles de se "regarder"
        encoder_layer = nn.TransformerEncoderLayer(d_model=self.d_model, nhead=8, batch_first=True, dim_feedforward=2048, dropout=0.1)
        self.context_encoder = nn.TransformerEncoder(encoder_layer, num_layers=3)

        # Prédiction Pairwise (Bulle i vs Bulle j)
        self.pair_head = nn.Sequential(
            nn.Linear(self.d_model * 2, 512), nn.LayerNorm(512), nn.SiLU(inplace=True), nn.Dropout(0.2),
            nn.Linear(512, 128), nn.SiLU(inplace=True),
            nn.Linear(128, 1)
        )

        # Prédiction Rank Absolu
        self.rank_head = nn.Sequential(
            nn.Linear(self.d_model, 256), nn.LayerNorm(256), nn.SiLU(inplace=True), nn.Dropout(0.2),
            nn.Linear(256, 128), nn.SiLU(inplace=True),
            nn.Linear(128, 1)
        )

        grid_y = torch.linspace(-1, 1, CANVAS_H).view(1, 1, CANVAS_H, 1).expand(1, 1, CANVAS_H, CANVAS_W)
        grid_x = torch.linspace(-1, 1, CANVAS_W).view(1, 1, 1, CANVAS_W).expand(1, 1, CANVAS_H, CANVAS_W)
        self.register_buffer("grid_y", grid_y)
        self.register_buffer("grid_x", grid_x)

    def _extract_multiscale_roi(self, fpn_maps, box_xywh, batch_indices):
        N_total = box_xywh.shape[0]
        results = torch.zeros(N_total, FEAT_DIM * 16, dtype=fpn_maps[0].dtype, device=box_xywh.device)
        
        for lvl in range(3):
            mask = torch.zeros(N_total, dtype=torch.bool, device=box_xywh.device)
            for i in range(N_total):
                area = (box_xywh[i, 2] * CANVAS_W) * (box_xywh[i, 3] * CANVAS_H)
                tgt_lvl = int(torch.clamp(torch.floor(torch.log2(torch.sqrt(area) / 56 + 1e-6) + 2), min=0, max=2).item())
                if tgt_lvl == lvl: mask[i] = True
            
            if mask.any():
                b_idx = batch_indices[mask].to(fpn_maps[lvl].dtype)
                x, y, w, h = box_xywh[mask, 0], box_xywh[mask, 1], box_xywh[mask, 2], box_xywh[mask, 3]
                rois = torch.stack([b_idx, x * CANVAS_W, y * CANVAS_H, (x + w) * CANVAS_W, (y + h) * CANVAS_H], dim=1)
                results[mask] = roi_align(fpn_maps[lvl], rois, output_size=4, spatial_scale=1.0, aligned=True).flatten(1)
        return results

    def forward(self, images, geoms, crops, padding_mask):
        B, N, _ = geoms.shape
        
        # 1. Image Globale
        x = torch.cat([images, self.grid_x.expand(B, -1, -1, -1), self.grid_y.expand(B, -1, -1, -1)], dim=1)
        p1, p2, p3 = self.backbone(x)
        global_feat = F.adaptive_avg_pool2d(p3, 1).flatten(1) # (B, FEAT_DIM)

        # 2. Features Locales (Aplatis pour traiter tout le batch d'un coup)
        flat_geoms = geoms.view(B * N, -1)
        flat_crops = crops.view(B * N, 1, BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE)
        batch_indices = torch.arange(B, device=images.device).view(B, 1).expand(B, N).reshape(-1)

        roi_feats = self._extract_multiscale_roi((p1, p2, p3), flat_geoms[:, :4], batch_indices)
        crop_feats = self.crop_encoder(flat_crops)
        geom_feats = self.geom_enc(flat_geoms)

        # 3. Assemblage des Tokens
        global_feats_exp = global_feat.unsqueeze(1).expand(-1, N, -1).reshape(B * N, -1)
        raw_tokens = torch.cat([global_feats_exp, roi_feats, crop_feats, geom_feats], dim=-1)
        raw_tokens = raw_tokens.view(B, N, -1)

        # Projection linéaire pour adapter la dimension au Transformer
        tokens = self.feature_proj(raw_tokens)

        # 4. Contexte Global via Transformer
        context_tokens = self.context_encoder(tokens, src_key_padding_mask=padding_mask)

        # 5. Prédictions
        # Rank Absolu:
        rank_logits = self.rank_head(context_tokens).squeeze(-1) # (B, N)
        
        # Pairwise (Bulle i vs Bulle j):
        tokens_i = context_tokens.unsqueeze(2).expand(B, N, N, -1)
        tokens_j = context_tokens.unsqueeze(1).expand(B, N, N, -1)
        pair_inputs = torch.cat([tokens_i, tokens_j], dim=-1)
        pair_logits = self.pair_head(pair_inputs).squeeze(-1) # (B, N, N)

        return pair_logits, rank_logits


# ---------------------------------------------------------------------------
# Dataset au niveau PAGE
# ---------------------------------------------------------------------------

class PageDataset(Dataset):
    def __init__(self, annotations, images_dir, augment=False):
        self.augment = augment
        self.samples = []
        
        for page in annotations:
            img_path = os.path.join(images_dir, page["image"])
            if not os.path.exists(img_path): continue
            
            # Extraire les bulles uniques
            nodes = []
            for pair in page["pairs"]:
                a_tuple = (pair["a"]["x"], pair["a"]["y"], pair["a"]["w"], pair["a"]["h"])
                b_tuple = (pair["b"]["x"], pair["b"]["y"], pair["b"]["w"], pair["b"]["h"])
                if a_tuple not in nodes: nodes.append(a_tuple)
                if b_tuple not in nodes: nodes.append(b_tuple)
                
            node_idx = {n: i for i, n in enumerate(nodes)}
            N = len(nodes)
            if N < 2: continue

            # Matrice d'adjacence des paires
            target_matrix = np.zeros((N, N), dtype=np.float32)
            for pair in page["pairs"]:
                a_tuple = (pair["a"]["x"], pair["a"]["y"], pair["a"]["w"], pair["a"]["h"])
                b_tuple = (pair["b"]["x"], pair["b"]["y"], pair["b"]["w"], pair["b"]["h"])
                i, j = node_idx[a_tuple], node_idx[b_tuple]
                target_matrix[i, j] = pair["label"]
                target_matrix[j, i] = 1.0 - pair["label"]

            self.samples.append((img_path, nodes, target_matrix, page["image"]))

    def __len__(self): return len(self.samples)

    def _crop(self, img_np, box):
        x, y, w, h = box
        x1, y1 = max(0, int(x * CANVAS_W)), max(0, int(y * CANVAS_H))
        x2, y2 = min(CANVAS_W, int((x + w) * CANVAS_W)), min(CANVAS_H, int((y + h) * CANVAS_H))
        if x2 <= x1 or y2 <= y1: return np.zeros((BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE), dtype=np.float32)
        return np.array(Image.fromarray((img_np[y1:y2, x1:x2]*255).astype(np.uint8)).resize((BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE)), dtype=np.float32) / 255.0

    def __getitem__(self, idx):
        img_path, nodes, target_matrix, img_name = self.samples[idx]
        img = Image.open(img_path).convert("L").resize((CANVAS_W, CANVAS_H), Image.BILINEAR)
        img_np = np.array(img, dtype=np.float32) / 255.0

        if self.augment and random.random() > 0.4:
            img_np = np.clip(img_np ** random.uniform(0.6, 1.5), 0, 1)

        geoms, crops = [], []
        for (x, y, w, h) in nodes:
            geom = [x, y, w, h, w*h, 1.0-(x+w/2), h/(w+1e-6), x+w/2, y+h/2]
            geoms.append(geom)
            crops.append(self._crop(img_np, (x, y, w, h)))

        return (
            torch.from_numpy(img_np).unsqueeze(0),
            torch.tensor(geoms, dtype=torch.float32),
            torch.tensor(np.array(crops), dtype=torch.float32).unsqueeze(1),
            torch.tensor(target_matrix, dtype=torch.float32),
            img_name
        )

def collate_pages(batch):
    imgs, geoms, crops, target_matrices, img_names = zip(*batch)
    imgs = torch.stack(imgs)
    
    # Padding des séquences (bulles)
    geoms_padded = pad_sequence(geoms, batch_first=True, padding_value=0.0)
    crops_padded = pad_sequence(crops, batch_first=True, padding_value=0.0)
    
    B, max_N = len(batch), geoms_padded.shape[1]
    
    targets_padded = torch.zeros(B, max_N, max_N)
    padding_mask = torch.ones(B, max_N, dtype=torch.bool) # True = pad
    
    for b in range(B):
        N = geoms[b].shape[0]
        targets_padded[b, :N, :N] = target_matrices[b]
        padding_mask[b, :N] = False

    return imgs, geoms_padded, crops_padded, targets_padded, padding_mask, img_names

# ---------------------------------------------------------------------------
# Training Loop
# ---------------------------------------------------------------------------

def train():
    dataset_dir = SCRIPT_DIR / "dataset"
    with open(dataset_dir / "train/annotations.json") as f: train_ann = json.load(f)
    with open(dataset_dir / "val/annotations.json") as f: val_ann = json.load(f)

    train_loader = DataLoader(
        PageDataset(train_ann, str(dataset_dir/"train/images"), augment=True), 
        batch_size=BATCH_SIZE, shuffle=True, collate_fn=collate_pages, 
        num_workers=4, persistent_workers=True, pin_memory=True
    )
    val_loader = DataLoader(
        PageDataset(val_ann, str(dataset_dir/"val/images")), 
        batch_size=BATCH_SIZE, shuffle=False, collate_fn=collate_pages, 
        num_workers=2, persistent_workers=True, pin_memory=True
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = ReaderNetV8().to(device)
    
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-2)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=LR*5, total_steps=EPOCHS*len(train_loader), pct_start=0.08)
    bce_loss = nn.BCEWithLogitsLoss(reduction='none')
    scaler = torch.amp.GradScaler("cuda") if device.type == "cuda" else None

    best_val_exact = 0.0
    model_path = dataset_dir / "readernet_v8.pt"

    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0.0

        pbar = tqdm(train_loader, desc=f"Epoch {epoch+1}/{EPOCHS}")
        for imgs, geoms, crops, targets, pad_mask, _ in pbar:
            imgs, geoms, crops, targets, pad_mask = [x.to(device, non_blocking=True) for x in (imgs, geoms, crops, targets, pad_mask)]
            optimizer.zero_grad(set_to_none=True)

            with torch.autocast("cuda", enabled=(scaler is not None)):
                pair_logits, rank_logits = model(imgs, geoms, crops, pad_mask)
                
                # Masque pour ignorer le padding et la diagonale (i == j)
                valid_2d_mask = (~pad_mask.unsqueeze(1)) & (~pad_mask.unsqueeze(2))
                valid_2d_mask.diagonal(dim1=1, dim2=2).fill_(False)
                
                # Loss Pairwise
                loss_pair = bce_loss(pair_logits, targets)[valid_2d_mask].mean()
                
                # Loss Rank (Supervision faible basée sur le nombre de bulles qu'elle précède)
                target_ranks = targets.sum(dim=2) / ( (~pad_mask).sum(dim=1, keepdim=True).float() + 1e-6)
                loss_rank = bce_loss(rank_logits, target_ranks)[~pad_mask].mean()

                loss = loss_pair + loss_rank * 0.5

            if scaler:
                scaler.scale(loss).backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
            else:
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                
            scheduler.step()
            total_loss += loss.item()
            pbar.set_postfix(loss=f"{loss.item():.4f}")

        # --- VALIDATION EXACT MATCH AVEC GRAPHE DIRIGÉ ---
        model.eval()
        exact_pages, total_pages = 0, 0

        with torch.no_grad():
            for imgs, geoms, crops, targets, pad_mask, _ in tqdm(val_loader, desc="Val", leave=False):
                imgs, geoms, crops, pad_mask = [x.to(device, non_blocking=True) for x in (imgs, geoms, crops, pad_mask)]
                
                with torch.autocast("cuda", enabled=(scaler is not None)):
                    pair_logits, rank_logits = model(imgs, geoms, crops, pad_mask)
                
                # Passage des probabilités
                pair_probs = torch.sigmoid(pair_logits).cpu().numpy()
                rank_scores = torch.sigmoid(rank_logits).cpu().numpy()
                targets_np = targets.numpy()
                pad_mask_np = pad_mask.cpu().numpy()

                B = imgs.size(0)
                for b in range(B):
                    N = (~pad_mask_np[b]).sum()
                    if N < 2: continue
                    
                    # On combine le "Out-Degree" du graphe pairwise avec le rank absolu
                    pred_matrix = pair_probs[b, :N, :N]
                    pred_combined_scores = pred_matrix.sum(axis=1) + 0.1 * rank_scores[b, :N]
                    pred_order = np.argsort(-pred_combined_scores).tolist()

                    gt_matrix = targets_np[b, :N, :N]
                    gt_scores = gt_matrix.sum(axis=1)
                    gt_order = np.argsort(-gt_scores).tolist()

                    if pred_order == gt_order:
                        exact_pages += 1
                    total_pages += 1

        val_exact = exact_pages / total_pages if total_pages > 0 else 0.0

        if val_exact > best_val_exact:
            best_val_exact = val_exact
            torch.save(model.state_dict(), str(model_path))

        print(f"Epoch {epoch+1:3d} | Loss: {total_loss/len(train_loader):.4f} | ValExact: {val_exact:.3f} | Best: {best_val_exact:.3f}", flush=True)

if __name__ == "__main__":
    train()