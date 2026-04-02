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
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).resolve().parent

CANVAS_H = 256
CANVAS_W = 384
GEOM_DIM = 24
FEAT_DIM = 128
BUBBLE_CROP_SIZE = 32
BATCH_SIZE = 48
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

def extract_roi_feat(feat_map, boxes_xywh, roi_size=4):
    B, C, H, W = feat_map.shape
    x, y, w, h = boxes_xywh[:, 0], boxes_xywh[:, 1], boxes_xywh[:, 2], boxes_xywh[:, 3]
    batch_idx = torch.arange(B, device=feat_map.device, dtype=feat_map.dtype)
    rois = torch.stack([batch_idx, x * W, y * H, (x + w) * W, (y + h) * H], dim=1)
    return roi_align(feat_map, rois, output_size=roi_size, spatial_scale=1.0, aligned=True).flatten(1)

def select_fpn_level(box_w, box_h):
    area = (box_w * CANVAS_W) * (box_h * CANVAS_H)
    return int(torch.clamp(torch.floor(torch.log2(torch.sqrt(area) / 56 + 1e-6) + 2), min=0, max=2).item())

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
# Les Têtes de Prédiction
# ---------------------------------------------------------------------------

class RankHead(nn.Module):
    def __init__(self, feat_roi_dim, crop_enc_dim=64, num_freqs=8):
        super().__init__()
        self.geom_enc = FourierPositionalEncoding(9, num_freqs=num_freqs)
        in_dim = FEAT_DIM + feat_roi_dim + crop_enc_dim + self.geom_enc.out_dim
        
        self.mlp = nn.Sequential(
            nn.Linear(in_dim, 512), nn.LayerNorm(512), nn.SiLU(inplace=True), nn.Dropout(0.2),
            nn.Linear(512, 128), nn.SiLU(inplace=True),
            nn.Linear(128, 1)
        )

    def forward(self, global_feat, roi, crop, geom_indiv):
        g_feat = self.geom_enc(geom_indiv)
        x = torch.cat([global_feat, roi, crop, g_feat], dim=1)
        return self.mlp(x)


class PairwiseHead(nn.Module):
    def __init__(self, feat_roi_dim, crop_enc_dim=64, num_freqs=8):
        super().__init__()
        self.geom_enc = FourierPositionalEncoding(GEOM_DIM, num_freqs=num_freqs)
        in_dim = FEAT_DIM + feat_roi_dim * 2 + crop_enc_dim * 2 + self.geom_enc.out_dim
        
        self.mlp = nn.Sequential(
            nn.Linear(in_dim, 1024), nn.LayerNorm(1024), nn.SiLU(inplace=True), nn.Dropout(0.25),
            nn.Linear(1024, 256), nn.SiLU(inplace=True), nn.Dropout(0.15),
            nn.Linear(256, 128), nn.SiLU(inplace=True),
            nn.Linear(128, 1)
        )

    def forward(self, global_feat, feat_a, feat_b, crop_feat_a, crop_feat_b, geom):
        g_feat = self.geom_enc(geom)
        x = torch.cat([global_feat, feat_a, feat_b, crop_feat_a, crop_feat_b, g_feat], dim=1)
        return self.mlp(x)


# ---------------------------------------------------------------------------
# Modèle Principal : ReaderNet V8 (Avec Correction de Vitesse)
# ---------------------------------------------------------------------------

class ReaderNetV8(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = FPNBackbone(out_channels=FEAT_DIM)
        self.crop_encoder = BubbleCropEncoder(out_dim=64)
        feat_roi_dim = FEAT_DIM * 16 # 4x4 ROI

        self.rank_head = RankHead(feat_roi_dim=feat_roi_dim)
        self.pair_head = PairwiseHead(feat_roi_dim=feat_roi_dim)

        grid_y = torch.linspace(-1, 1, CANVAS_H).view(1, 1, CANVAS_H, 1).expand(1, 1, CANVAS_H, CANVAS_W)
        grid_x = torch.linspace(-1, 1, CANVAS_W).view(1, 1, 1, CANVAS_W).expand(1, 1, CANVAS_H, CANVAS_W)
        self.register_buffer("grid_y", grid_y)
        self.register_buffer("grid_x", grid_x)

    def _run_backbone(self, image):
        B = image.shape[0]
        x = torch.cat([image, self.grid_x.expand(B, -1, -1, -1), self.grid_y.expand(B, -1, -1, -1)], dim=1)
        return self.backbone(x)

    def _dedup_backbone(self, image, img_ids):
        unique_ids, inv = torch.unique(img_ids, return_inverse=True)
        B_u = unique_ids.shape[0]
        B = image.shape[0]

        if B_u == B:
            return self._run_backbone(image)

        seen, indices = set(), []
        for i, uid in enumerate(img_ids.tolist()):
            if uid not in seen:
                indices.append(i)
                seen.add(uid)
                if len(seen) == B_u:
                    break
        indices = torch.tensor(indices, device=image.device)
        unique_imgs = image[indices]

        p1_u, p2_u, p3_u = self._run_backbone(unique_imgs)
        return p1_u[inv], p2_u[inv], p3_u[inv]

    def _extract_multiscale_roi(self, fpn_maps, box_xywh):
        B = box_xywh.shape[0]
        results = torch.zeros(B, FEAT_DIM * 16, dtype=fpn_maps[0].dtype, device=box_xywh.device)
        for lvl in range(3):
            mask = torch.zeros(B, dtype=torch.bool, device=box_xywh.device)
            for i in range(B):
                if select_fpn_level(box_xywh[i, 2], box_xywh[i, 3]) == lvl: mask[i] = True
            if mask.any():
                results[mask] = extract_roi_feat(fpn_maps[lvl][mask], box_xywh[mask], roi_size=4)
        return results

    def forward(self, image, geom, crop_a, crop_b, img_ids=None):
        B = image.shape[0]
        
        # L'OPTIMISATION QUI SAUVE LA VITESSE EST DE RETOUR ICI
        if self.training and img_ids is not None and B > 1:
            p1, p2, p3 = self._dedup_backbone(image, img_ids)
        else:
            p1, p2, p3 = self._run_backbone(image)
            
        fpn_maps = (p1, p2, p3)
        global_feat = F.adaptive_avg_pool2d(p3, 1).flatten(1)

        feat_a = self._extract_multiscale_roi(fpn_maps, geom[:, :4])
        feat_b = self._extract_multiscale_roi(fpn_maps, geom[:, 4:8])
        crop_feat_a = self.crop_encoder(crop_a)
        crop_feat_b = self.crop_encoder(crop_b)

        # 1. Prédiction Pairwise
        pair_logit = self.pair_head(global_feat, feat_a, feat_b, crop_feat_a, crop_feat_b, geom)

        # 2. RankNet
        geom_a_indiv = torch.stack([geom[:,0], geom[:,1], geom[:,2], geom[:,3], geom[:,12], geom[:,16], geom[:,18], geom[:,20], geom[:,21]], dim=1)
        geom_b_indiv = torch.stack([geom[:,4], geom[:,5], geom[:,6], geom[:,7], geom[:,13], geom[:,17], geom[:,19], geom[:,22], geom[:,23]], dim=1)

        score_a = self.rank_head(global_feat, feat_a, crop_feat_a, geom_a_indiv)
        score_b = self.rank_head(global_feat, feat_b, crop_feat_b, geom_b_indiv)
        
        rank_logit = score_a - score_b 

        return pair_logit, rank_logit, score_a, score_b


# ---------------------------------------------------------------------------
# Dataset & Utils
# ---------------------------------------------------------------------------

def build_geom_features(pair):
    a, b, rel = pair["a"], pair["b"], pair["rel"]
    ax, ay, aw, ah = a["x"], a["y"], a["w"], a["h"]
    bx, by, bw, bh = b["x"], b["y"], b["w"], b["h"]
    return [
        ax, ay, aw, ah, bx, by, bw, bh, rel["dx"], rel["dy"], rel["dist"], rel["angle"],
        aw*ah, bw*bh, max(0, min(ax+aw, bx+bw) - max(ax, bx)), max(0, min(ay+ah, by+bh) - max(ay, by)),
        1.0 - (ax + aw/2), 1.0 - (bx + bw/2), ah/(aw+1e-6), bh/(bw+1e-6),
        ax+aw/2, ay+ah/2, bx+bw/2, by+bh/2
    ]

class PagePairDataset(Dataset):
    def __init__(self, annotations, images_dir, augment=False):
        self.augment = augment
        self.page_images, self.samples = {}, []
        for page in annotations:
            img_path = os.path.join(images_dir, page["image"])
            if os.path.exists(img_path):
                img = Image.open(img_path).convert("L").resize((CANVAS_W, CANVAS_H), Image.BILINEAR)
                self.page_images[page["image"]] = np.array(img, dtype=np.float32) / 255.0
                for pair in page["pairs"]:
                    self.samples.append((page["image"], pair["a"], pair["b"], build_geom_features(pair), pair["label"]))

        self.img_names = list(self.page_images.keys())
        self.name_to_id = {name: i for i, name in enumerate(self.img_names)}

    def __len__(self): return len(self.samples)

    def _crop(self, img_np, box):
        x1, y1 = max(0, int(box["x"] * CANVAS_W)), max(0, int(box["y"] * CANVAS_H))
        x2, y2 = min(CANVAS_W, int((box["x"] + box["w"]) * CANVAS_W)), min(CANVAS_H, int((box["y"] + box["h"]) * CANVAS_H))
        if x2 <= x1 or y2 <= y1: return np.zeros((BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE), dtype=np.float32)
        return np.array(Image.fromarray((img_np[y1:y2, x1:x2]*255).astype(np.uint8)).resize((BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE)), dtype=np.float32) / 255.0

    def __getitem__(self, idx):
        img_name, _, _, geom, label = self.samples[idx]
        img, geom = self.page_images[img_name].copy(), list(geom)
        
        if self.augment and random.random() > 0.4:
            img = np.clip(img ** random.uniform(0.6, 1.5), 0, 1)
        if self.augment and random.random() > 0.5:
            img = np.clip(img + np.random.normal(0, random.uniform(0.01, 0.04), img.shape), 0, 1).astype(np.float32)
            
        crop_a = self._crop(img, {"x": geom[0], "y": geom[1], "w": geom[2], "h": geom[3]})
        crop_b = self._crop(img, {"x": geom[4], "y": geom[5], "w": geom[6], "h": geom[7]})

        img_id = self.name_to_id[img_name]

        return (torch.from_numpy(img).unsqueeze(0), torch.tensor(geom, dtype=torch.float32),
                torch.from_numpy(crop_a).unsqueeze(0), torch.from_numpy(crop_b).unsqueeze(0),
                torch.tensor([label], dtype=torch.float32), img_id, img_name)

class FocalLoss(nn.Module):
    def __init__(self, gamma=2.5):
        super().__init__()
        self.gamma = gamma
        self.bce = nn.BCEWithLogitsLoss(reduction="none")
    def forward(self, inputs, targets):
        bce_loss = self.bce(inputs, targets)
        return ((1 - torch.exp(-bce_loss)) ** self.gamma * bce_loss).mean()

# ---------------------------------------------------------------------------
# Training Loop
# ---------------------------------------------------------------------------

def train():
    dataset_dir = SCRIPT_DIR / "dataset"
    with open(dataset_dir / "train/annotations.json") as f: train_ann = json.load(f)
    with open(dataset_dir / "val/annotations.json") as f: val_ann = json.load(f)

    train_loader = DataLoader(PagePairDataset(train_ann, str(dataset_dir/"train/images"), augment=True), batch_size=BATCH_SIZE, shuffle=True, num_workers=4)
    val_loader = DataLoader(PagePairDataset(val_ann, str(dataset_dir/"val/images")), batch_size=BATCH_SIZE, shuffle=False, num_workers=2)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = ReaderNetV8().to(device)
    
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-2)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=LR*5, total_steps=EPOCHS*len(train_loader), pct_start=0.08)
    criterion = FocalLoss()
    scaler = torch.amp.GradScaler("cuda") if device.type == "cuda" else None

    best_val_exact = 0.0
    model_path = dataset_dir / "readernet_v8.pt"

    for epoch in range(EPOCHS):
        model.train()
        total_loss, correct, total = 0.0, 0, 0

        pbar = tqdm(train_loader, desc=f"Epoch {epoch+1}/{EPOCHS}")
        for imgs, geoms, crops_a, crops_b, labels, img_ids, _ in pbar:
            imgs, geoms, crops_a, crops_b, labels, img_ids = [x.to(device, non_blocking=True) for x in (imgs, geoms, crops_a, crops_b, labels, img_ids)]
            optimizer.zero_grad(set_to_none=True)

            with torch.autocast("cuda", enabled=(scaler is not None)):
                pair_logit, rank_logit, _, _ = model(imgs, geoms, crops_a, crops_b, img_ids)
                loss = criterion(pair_logit, labels) + criterion(rank_logit, labels)

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
            total_loss += loss.item() * imgs.size(0)
            
            final_logit = pair_logit + rank_logit
            correct += ((final_logit > 0).float() == labels).sum().item()
            total += labels.size(0)
            pbar.set_postfix(loss=f"{loss.item():.4f}")

        # --- VALIDATION RANKNET ---
        model.eval()
        v_correct_pairs, v_total_pairs = 0, 0
        page_bubble_scores = {}
        page_gt_pairs = {}

        with torch.no_grad():
            for imgs, geoms, crops_a, crops_b, labels, img_ids, img_names in tqdm(val_loader, desc="Val", leave=False):
                imgs, geoms, crops_a, crops_b, labels, img_ids = [x.to(device, non_blocking=True) for x in (imgs, geoms, crops_a, crops_b, labels, img_ids)]
                
                with torch.autocast("cuda", enabled=(scaler is not None)):
                    pair_logit, rank_logit, score_a, score_b = model(imgs, geoms, crops_a, crops_b, img_ids)
                
                final_logit = pair_logit + rank_logit
                v_correct_pairs += ((final_logit > 0).float() == labels).sum().item()
                v_total_pairs += labels.size(0)

                geoms_np = geoms.cpu().numpy()
                sa_np = score_a.cpu().numpy()
                sb_np = score_b.cpu().numpy()
                lbl_np = labels.cpu().numpy()

                for i, img_name in enumerate(img_names):
                    if img_name not in page_bubble_scores:
                        page_bubble_scores[img_name] = {}
                        page_gt_pairs[img_name] = []
                    
                    box_a = tuple(np.round(geoms_np[i, :4], 4))
                    box_b = tuple(np.round(geoms_np[i, 4:8], 4))
                    
                    page_bubble_scores[img_name][box_a] = sa_np[i][0]
                    page_bubble_scores[img_name][box_b] = sb_np[i][0]
                    page_gt_pairs[img_name].append((box_a, box_b, lbl_np[i][0]))

        exact_pages = 0
        total_pages = len(page_bubble_scores)

        for img_name in page_bubble_scores:
            scores = page_bubble_scores[img_name]
            nodes = list(scores.keys())
            node_idx = {n: i for i, n in enumerate(nodes)}
            N = len(nodes)
            
            target_matrix = np.zeros((N, N))
            for box_a, box_b, lbl in page_gt_pairs[img_name]:
                target_matrix[node_idx[box_a], node_idx[box_b]] = lbl
                target_matrix[node_idx[box_b], node_idx[box_a]] = 1 - lbl
                
            gt_scores = np.sum(target_matrix, axis=1)
            gt_order = np.argsort(-gt_scores)
            gt_sorted_nodes = [nodes[i] for i in gt_order]
            
            pred_sorted_nodes = sorted(nodes, key=lambda n: scores[n], reverse=True)
            
            if pred_sorted_nodes == gt_sorted_nodes:
                exact_pages += 1

        val_exact = exact_pages / total_pages if total_pages > 0 else 0.0
        val_pair = v_correct_pairs / v_total_pairs if v_total_pairs > 0 else 0.0

        if val_exact > best_val_exact:
            best_val_exact = val_exact
            torch.save(model.state_dict(), str(model_path))

        print(f"Epoch {epoch+1:3d} | Loss: {total_loss/total:.4f} | ValPair: {val_pair:.3f} | ValExact: {val_exact:.3f} | Best: {best_val_exact:.3f}", flush=True)

if __name__ == "__main__":
    train()