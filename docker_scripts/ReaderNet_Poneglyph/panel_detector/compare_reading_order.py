import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from train_reading_order import (
    RUNS_DIR,
    DATASET_DIR,
    DEVICE,
    PanelOrderNet,
    ReadingOrderDataset,
    validate,
)

BEST_METRIC_FILE = RUNS_DIR / "best_reading_order_metric.json"


def compare():
    print("Comparing reading order models...")
    best_ckpt = RUNS_DIR / "best_model.pt"
    if not best_ckpt.exists():
        print("No trained model found in runs_reading_order/.")
        return False

    val_dataset = ReadingOrderDataset(DATASET_DIR / "val.json")
    val_loader = DataLoader(
        val_dataset, batch_size=1, shuffle=False, num_workers=2, pin_memory=True
    )

    model = PanelOrderNet().to(DEVICE)
    ckpt = torch.load(best_ckpt, map_location=DEVICE)
    model.load_state_dict(ckpt["model_state_dict"])

    metrics = validate(model, val_loader, DEVICE)
    current_kendall = metrics["kendall_tau"]

    old_kendall = -1.0
    if BEST_METRIC_FILE.exists():
        with open(BEST_METRIC_FILE) as f:
            old_kendall = json.load(f).get("kendall_tau", -1.0)

    print(f"Current model Kendall Tau: {current_kendall:.4f}")
    print(f"Previous best Kendall Tau: {old_kendall:.4f}")

    is_better = current_kendall > old_kendall
    if is_better:
        print("New reading order model is better!")
        with open(BEST_METRIC_FILE, "w") as f:
            json.dump({"kendall_tau": current_kendall}, f)
    else:
        print("New reading order model is not better.")

    return is_better


if __name__ == "__main__":
    compare()
