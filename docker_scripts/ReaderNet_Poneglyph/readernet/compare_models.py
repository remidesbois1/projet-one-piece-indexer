import json
from pathlib import Path
import numpy as np
import torch
from torch.utils.data import DataLoader

from train_readernet import (
    SimpleReaderNet,
    PageDataset,
    collate_pages,
    hierarchical_sort,
    compute_exact_match,
)

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_DIR = SCRIPT_DIR / "dataset"
BEST_METRIC_FILE = DATASET_DIR / "best_readernet_metric.json"


def compare():
    print("Comparing ReaderNet_Poneglyph models...")
    best_ckpt = DATASET_DIR / "readernet_poneglyph.pt"
    if not best_ckpt.exists():
        print("No trained model found.")
        return False

    with open(DATASET_DIR / "val" / "annotations.json") as f:
        val_ann = json.load(f)

    val_loader = DataLoader(
        PageDataset(val_ann, str(DATASET_DIR / "val" / "images")),
        batch_size=4,
        shuffle=False,
        collate_fn=collate_pages,
        num_workers=2,
        persistent_workers=True,
        pin_memory=True,
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = SimpleReaderNet().to(device)
    ckpt = torch.load(str(best_ckpt), map_location=device, weights_only=False)
    model.load_state_dict(ckpt["model_state_dict"])

    model.eval()
    exact_pages = 0
    total_pages = 0

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
        ) in val_loader:
            imgs = imgs.to(device)
            panels = panels.to(device)
            geoms = geoms.to(device)
            crops = crops.to(device)
            bubble_panels = bubble_panels.to(device)
            panel_mask = panel_mask.to(device)
            bubble_mask = bubble_mask.to(device)
            targets_np = targets.numpy()
            bubble_panels_np = bubble_panels.cpu().numpy()
            bubble_mask_np = bubble_mask.cpu().numpy()

            scores = model(
                imgs, panels, geoms, bubble_panels, crops, panel_mask, bubble_mask
            )

            scores_np = scores.cpu().numpy()

            B = imgs.size(0)
            for b in range(B):
                N = (~bubble_mask_np[b]).sum()
                if N < 2:
                    continue

                # GT order: group by panel, sort panels, sort bubbles within panel descending by gt_scores
                gt_scores = targets_np[b, :N, :N].sum(axis=1)
                panel_bubbles_gt = {}
                for i in range(N):
                    p = int(bubble_panels_np[b, i])
                    panel_bubbles_gt.setdefault(p, []).append(i)

                gt_order = []
                for p in sorted(panel_bubbles_gt.keys()):
                    idxs = panel_bubbles_gt[p]
                    idxs_sorted = sorted(idxs, key=lambda i: gt_scores[i], reverse=True)
                    gt_order.extend(idxs_sorted)

                pred_order = hierarchical_sort(
                    scores_np[b, :N], bubble_panels_np[b, :N]
                )

                if compute_exact_match(pred_order, gt_order):
                    exact_pages += 1
                total_pages += 1

    current_exact = exact_pages / total_pages if total_pages > 0 else 0.0

    old_exact = 0.0
    if BEST_METRIC_FILE.exists():
        with open(BEST_METRIC_FILE) as f:
            old_exact = json.load(f).get("val_exact", 0.0)

    print(f"Current model ValExact: {current_exact:.4f}")
    print(f"Previous best ValExact: {old_exact:.4f}")

    is_better = current_exact > old_exact
    if is_better:
        print("New ReaderNet_Poneglyph model is better!")
        with open(BEST_METRIC_FILE, "w") as f:
            json.dump({"val_exact": current_exact}, f)
    else:
        print("New ReaderNet_Poneglyph model is not better.")

    return is_better


if __name__ == "__main__":
    compare()
