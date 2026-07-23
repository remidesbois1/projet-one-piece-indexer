#!/usr/bin/env python3
"""Train the production candidate on every labelled page after validation is complete.

This script intentionally has no validation split.  Select the number of epochs
from a prior held-out-volume run, then pass that report with --selection-metrics.
"""

from __future__ import annotations

import argparse
import copy
import json
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR
from torch.utils.data import DataLoader, WeightedRandomSampler

from train import (
    DEFAULT_DATASET_DIR,
    RUNS_DIR,
    CLASS_NAMES,
    PageDataset,
    atomic_json,
    build_model,
    export_and_verify,
    freeze_backbone,
    load_samples,
    make_transforms,
    set_seed,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Entraîne le candidat de production sur tous les labels page-type.")
    parser.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    parser.add_argument("--selection-metrics", type=Path, required=True, help="metrics.json de la validation qui a fixé epochs.")
    parser.add_argument("--exclude-volume", default="One Piece T07", help="Tome réservé au test, exclu de l'entraînement de production.")
    parser.add_argument("--epochs", type=int, required=True, help="Nombre d'époques retenu sur le volume de validation.")
    parser.add_argument("--warmup-epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.epochs < 1 or args.warmup_epochs < 0 or args.batch_size < 1:
        raise SystemExit("epochs et batch-size doivent être positifs; warmup-epochs doit être nul ou positif.")
    if not args.selection_metrics.is_file():
        raise SystemExit(f"Rapport de sélection introuvable: {args.selection_metrics}")

    selection = json.loads(args.selection_metrics.read_text(encoding="utf-8"))
    set_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    all_samples = load_samples(args.dataset_dir.resolve())
    samples = [sample for sample in all_samples if sample.volume_name != args.exclude_volume]
    if not samples:
        raise SystemExit(f"L'exclusion de '{args.exclude_volume}' laisse un entraînement vide.")
    if not any(sample.volume_name == args.exclude_volume for sample in all_samples):
        raise SystemExit(f"Tome exclu introuvable dans le dataset : {args.exclude_volume}")
    train_transform, _ = make_transforms()
    dataset = PageDataset(samples, train_transform)
    counts = Counter(sample.label for sample in samples)
    weights = [1.0 / counts[sample.label] for sample in samples]
    generator = torch.Generator().manual_seed(args.seed)
    sampler = WeightedRandomSampler(weights, num_samples=len(samples), replacement=True, generator=generator)
    loader = DataLoader(
        dataset,
        batch_size=args.batch_size,
        sampler=sampler,
        num_workers=args.workers,
        pin_memory=device.type == "cuda",
        persistent_workers=args.workers > 0,
    )

    output_dir = RUNS_DIR / f"final-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    output_dir.mkdir(parents=True, exist_ok=False)
    model = build_model(pretrained=True).to(device)
    optimizer = AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    scheduler = CosineAnnealingLR(optimizer, T_max=max(args.epochs - args.warmup_epochs, 1), eta_min=args.learning_rate * 0.05)
    criterion = nn.CrossEntropyLoss()
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    history: list[dict[str, Any]] = []

    print(json.dumps({"device": str(device), "training_counts": dict(counts), "excluded_volume": args.exclude_volume, "epochs": args.epochs}, ensure_ascii=False))
    for epoch in range(1, args.epochs + 1):
        frozen = epoch <= args.warmup_epochs
        freeze_backbone(model, frozen=frozen)
        model.train()
        loss_sum = 0.0
        seen = 0
        started = time.perf_counter()
        for inputs, labels in loader:
            inputs, labels = inputs.to(device, non_blocking=True), labels.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                loss = criterion(model(inputs), labels)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            loss_sum += loss.item() * labels.size(0)
            seen += labels.size(0)
        if not frozen:
            scheduler.step()
        entry = {
            "epoch": epoch,
            "phase": "frozen_backbone" if frozen else "finetune",
            "learning_rate": optimizer.param_groups[0]["lr"],
            "train_loss": loss_sum / max(seen, 1),
            "seconds": time.perf_counter() - started,
        }
        history.append(entry)
        atomic_json(output_dir / "history.json", history)
        print(f"epoch={epoch:02d}/{args.epochs} phase={entry['phase']} loss={entry['train_loss']:.4f}")

    model_cpu = copy.deepcopy(model).to("cpu")
    checkpoint = {
        "architecture": "mobilenet_v3_small",
        "class_names": list(CLASS_NAMES),
        "state_dict": model_cpu.state_dict(),
        "training_counts": dict(counts),
        "excluded_volume": args.exclude_volume,
        "arguments": vars(args) | {"dataset_dir": str(args.dataset_dir.resolve()), "selection_metrics": str(args.selection_metrics.resolve())},
    }
    torch.save(checkpoint, output_dir / "final.pt")
    export_summary = export_and_verify(model_cpu, output_dir, device)
    result = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "kind": "production_candidate_trained_on_all_labels",
        "architecture": "mobilenet_v3_small",
        "training_counts": dict(counts),
        "excluded_volume": args.exclude_volume,
        "selection": {
            "metrics_path": str(args.selection_metrics.resolve()),
            "held_out_volume": selection.get("held_out_volume"),
            "best_epoch": selection.get("best_epoch"),
            "best_metrics": selection.get("best_metrics"),
        },
        "training_epochs": args.epochs,
        "arguments": checkpoint["arguments"],
        **export_summary,
    }
    atomic_json(output_dir / "metrics.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
