"""
Analyze validation failures to understand exact match bottlenecks.
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
import torch

# Add parent to path to import train_readernet
sys.path.insert(0, str(Path(__file__).parent))
from train_readernet import (
    SimpleReaderNet,
    PageDataset,
    collate_pages,
    hierarchical_sort,
    compute_exact_match,
    MODEL_INPUT_H,
    MODEL_INPUT_W,
    BUBBLE_CROP_SIZE,
)


def load_model(checkpoint_path, device="cpu"):
    model = SimpleReaderNet()
    ckpt = torch.load(str(checkpoint_path), map_location=device, weights_only=False)
    state_dict = ckpt["model_state_dict"]

    # Handle architecture changes gracefully
    model_dict = model.state_dict()
    filtered_dict = {
        k: v
        for k, v in state_dict.items()
        if k in model_dict and v.shape == model_dict[k].shape
    }
    missing = set(model_dict.keys()) - set(filtered_dict.keys())
    if missing:
        print(
            f"Warning: {len(missing)} keys missing from checkpoint, using fresh init for those:"
        )
        for k in list(missing)[:5]:
            print(f"  - {k}")
        if len(missing) > 5:
            print(f"  ... and {len(missing) - 5} more")

    model_dict.update(filtered_dict)
    model.load_state_dict(model_dict, strict=False)
    model.eval()
    return model.to(device)


def analyze():
    dataset_dir = Path(__file__).parent / "dataset"
    val_ann_path = dataset_dir / "val" / "annotations.json"
    val_img_dir = dataset_dir / "val" / "images"

    with open(val_ann_path) as f:
        val_ann = json.load(f)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_model(dataset_dir / "readernet_poneglyph.pt", str(device))

    from torch.utils.data import DataLoader

    val_loader = DataLoader(
        PageDataset(val_ann, str(val_img_dir)),
        batch_size=1,
        shuffle=False,
        collate_fn=collate_pages,
    )

    failures = []
    total = 0
    exact = 0

    with torch.no_grad():
        for batch in val_loader:
            (
                imgs,
                panels,
                geoms,
                crops,
                bubble_panels,
                targets,
                intra_panel_mask,
                panel_mask,
                bubble_mask,
                img_names,
            ) = batch

            imgs = imgs.to(device)
            panels = panels.to(device)
            geoms = geoms.to(device)
            crops = crops.to(device)
            bubble_panels = bubble_panels.to(device)
            panel_mask = panel_mask.to(device)
            bubble_mask = bubble_mask.to(device)

            scores = model(
                imgs, panels, geoms, bubble_panels, crops, panel_mask, bubble_mask
            )

            scores_np = scores.cpu().numpy()[0]
            targets_np = targets.numpy()[0]
            bp_np = bubble_panels.cpu().numpy()[0]
            bm_np = bubble_mask.cpu().numpy()[0]
            geoms_np = geoms.cpu().numpy()[0]

            N = (~bm_np).sum()
            if N < 2:
                continue

            gt_scores = targets_np[:N, :N].sum(axis=1)
            gt_order = np.argsort(-gt_scores).tolist()

            score_order = np.argsort(scores_np[:N]).tolist()
            hier_order = hierarchical_sort(scores_np[:N], bp_np[:N])

            total += 1
            best_em = max(
                compute_exact_match(score_order, gt_order),
                compute_exact_match(hier_order, gt_order),
            )
            exact += best_em

            if best_em < 1.0:
                # Record failure details
                pred = score_order
                wrong_pairs = []
                for i in range(N):
                    for j in range(i + 1, N):
                        gt_i_before_j = gt_order.index(i) < gt_order.index(j)
                        pred_i_before_j = pred.index(i) < pred.index(j)
                        if gt_i_before_j != pred_i_before_j:
                            wrong_pairs.append((i, j))

                failures.append(
                    {
                        "image": img_names[0],
                        "N": int(N),
                        "gt_order": gt_order,
                        "score_order": score_order,
                        "hier_order": hier_order,
                        "wrong_pairs": wrong_pairs[:10],  # top 10 wrong pairs
                        "bubbles": [
                            {
                                "idx": i,
                                "x": float(geoms_np[i][0]),
                                "y": float(geoms_np[i][1]),
                                "w": float(geoms_np[i][2]),
                                "h": float(geoms_np[i][3]),
                                "panel": int(bp_np[i]),
                                "gt_rank": gt_order.index(i),
                                "pred_rank": pred.index(i),
                                "score": float(scores_np[i]),
                            }
                            for i in range(N)
                        ],
                    }
                )

    print(f"\n{'=' * 60}")
    print(f"Validation Exact Match: {exact}/{total} = {exact / total:.3f}")
    print(f"Failed pages: {len(failures)}")
    print(f"{'=' * 60}\n")

    # Analysis: categorize failures
    panel_boundary_errors = 0
    within_panel_errors = 0
    for f in failures:
        for i, j in f["wrong_pairs"]:
            pi = f["bubbles"][i]["panel"]
            pj = f["bubbles"][j]["panel"]
            if pi != pj:
                panel_boundary_errors += 1
            else:
                within_panel_errors += 1

    total_errors = panel_boundary_errors + within_panel_errors
    if total_errors > 0:
        print(
            f"Error breakdown: {panel_boundary_errors} panel-boundary ({panel_boundary_errors / total_errors:.1%}), "
            f"{within_panel_errors} within-panel ({within_panel_errors / total_errors:.1%})"
        )

    # Show first 3 failures in detail
    for f in failures[:3]:
        print(f"\n--- Failure: {f['image']} (N={f['N']}) ---")
        print(f"GT order:  {f['gt_order']}")
        print(f"Pred (score): {f['score_order']}")
        print(f"Pred (rank):  {f['rank_order']}")
        print(f"Pred (hier):  {f['hier_order']}")
        print("Bubbles:")
        for b in sorted(f["bubbles"], key=lambda x: x["gt_rank"]):
            marker = ""
            if b["gt_rank"] != b["pred_rank"]:
                marker = " <-- WRONG POSITION"
            print(
                f"  [{b['idx']}] panel={b['panel']} "
                f"x={b['x']:.3f} y={b['y']:.3f} "
                f"gt_rank={b['gt_rank']} pred_rank={b['pred_rank']} "
                f"score={b['score']:.3f} rank_pred={b['rank_pred']:.3f}{marker}"
            )
        print(f"Wrong pairs: {f['wrong_pairs']}")

    # Save full analysis
    out_path = dataset_dir / "failure_analysis.json"
    with open(out_path, "w") as f:
        json.dump(
            {
                "exact_match": exact / total,
                "total_pages": total,
                "failed_pages": len(failures),
                "panel_boundary_errors": panel_boundary_errors,
                "within_panel_errors": within_panel_errors,
                "failures": failures,
            },
            f,
            indent=2,
        )
    print(f"\nFull analysis saved to: {out_path}")


if __name__ == "__main__":
    analyze()
