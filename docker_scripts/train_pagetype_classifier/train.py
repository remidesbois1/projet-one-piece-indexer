#!/usr/bin/env python3
"""Fine-tune and export a light ONNX page-type classifier from labelizer data."""

from __future__ import annotations

import argparse
import copy
import json
import random
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
import torch
from PIL import Image, ImageOps, UnidentifiedImageError
from torch import Tensor, nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision import models, transforms


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET_DIR = REPO_ROOT / "scripts" / "pagetype_labelizer" / "data"
RUNS_DIR = Path(__file__).resolve().parent / "runs"
CLASS_NAMES = ("cover", "story_page", "annexe", "summary")
CLASS_TO_INDEX = {name: index for index, name in enumerate(CLASS_NAMES)}
IMAGE_SIZE = 224
RESIZE_SIZE = 256
NORMALIZE_MEAN = (0.485, 0.456, 0.406)
NORMALIZE_STD = (0.229, 0.224, 0.225)


@dataclass(frozen=True)
class Sample:
    image_path: Path
    label: str
    volume_name: str
    page_id: str


def atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = True


def load_samples(dataset_dir: Path) -> list[Sample]:
    labels_path = dataset_dir / "labels.json"
    manifest_path = dataset_dir / "manifest.json"
    if not labels_path.exists() or not manifest_path.exists():
        raise FileNotFoundError(
            f"Dataset incomplet dans {dataset_dir}. labels.json et manifest.json sont requis."
        )

    labels = json.loads(labels_path.read_text(encoding="utf-8")).get("labels", {})
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    volumes = {volume["id"]: volume for volume in manifest.get("volumes", [])}
    samples: list[Sample] = []

    for page_id, entry in labels.items():
        label = entry.get("label")
        volume_id = entry.get("volume_id")
        volume = volumes.get(volume_id)
        if label not in CLASS_TO_INDEX or volume is None:
            continue
        image_path = dataset_dir / "volumes" / volume_id / "images" / entry["page_file"]
        if not image_path.is_file():
            raise FileNotFoundError(f"Image absente pour {page_id}: {image_path}")
        samples.append(
            Sample(
                image_path=image_path,
                label=label,
                volume_name=entry.get("volume_name") or volume["display_name"],
                page_id=page_id,
            )
        )
    if not samples:
        raise RuntimeError("Aucun label exploitable dans labels.json.")
    return sorted(samples, key=lambda sample: (sample.volume_name, sample.page_id))


def split_by_volume(samples: list[Sample], held_out_volume: str) -> tuple[list[Sample], list[Sample]]:
    train = [sample for sample in samples if sample.volume_name != held_out_volume]
    validation = [sample for sample in samples if sample.volume_name == held_out_volume]
    if not train:
        raise RuntimeError(f"Le tome de validation '{held_out_volume}' laisse un entraînement vide.")
    if not validation:
        available = sorted({sample.volume_name for sample in samples})
        raise RuntimeError(f"Tome de validation introuvable: {held_out_volume}. Disponibles: {available}")
    missing_train = set(CLASS_NAMES) - {sample.label for sample in train}
    missing_validation = set(CLASS_NAMES) - {sample.label for sample in validation}
    if missing_train or missing_validation:
        raise RuntimeError(
            "Chaque classe doit être présente dans train et validation. "
            f"Manquantes train={sorted(missing_train)}, validation={sorted(missing_validation)}"
        )
    return train, validation


def make_transforms() -> tuple[transforms.Compose, transforms.Compose]:
    # No horizontal flip: it reverses manga text and reading direction.
    train_transform = transforms.Compose(
        [
            transforms.Resize(RESIZE_SIZE, antialias=True),
            transforms.CenterCrop(IMAGE_SIZE),
            transforms.RandomApply([transforms.ColorJitter(0.08, 0.08, 0.04, 0.02)], p=0.35),
            transforms.RandomAffine(degrees=2, translate=(0.02, 0.02), interpolation=transforms.InterpolationMode.BILINEAR),
            transforms.ToTensor(),
            transforms.Normalize(NORMALIZE_MEAN, NORMALIZE_STD),
        ]
    )
    validation_transform = transforms.Compose(
        [
            transforms.Resize(RESIZE_SIZE, antialias=True),
            transforms.CenterCrop(IMAGE_SIZE),
            transforms.ToTensor(),
            transforms.Normalize(NORMALIZE_MEAN, NORMALIZE_STD),
        ]
    )
    return train_transform, validation_transform


class PageDataset(Dataset[tuple[Tensor, int]]):
    def __init__(self, samples: list[Sample], transform: transforms.Compose) -> None:
        self.samples = samples
        self.transform = transform

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> tuple[Tensor, int]:
        sample = self.samples[index]
        try:
            with Image.open(sample.image_path) as raw:
                image = ImageOps.exif_transpose(raw).convert("RGB")
        except (OSError, UnidentifiedImageError) as exc:
            raise RuntimeError(f"Image illisible: {sample.image_path}") from exc
        return self.transform(image), CLASS_TO_INDEX[sample.label]


def build_model(pretrained: bool) -> nn.Module:
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
    model = models.mobilenet_v3_small(weights=weights)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(CLASS_NAMES))
    return model


def freeze_backbone(model: nn.Module, frozen: bool) -> None:
    for name, parameter in model.named_parameters():
        parameter.requires_grad = (not frozen) or name.startswith("classifier.")


def classification_metrics(targets: list[int], predictions: list[int]) -> dict[str, Any]:
    matrix = np.zeros((len(CLASS_NAMES), len(CLASS_NAMES)), dtype=int)
    for target, prediction in zip(targets, predictions):
        matrix[target, prediction] += 1
    per_class: dict[str, dict[str, float | int]] = {}
    f1_values: list[float] = []
    for index, name in enumerate(CLASS_NAMES):
        tp = int(matrix[index, index])
        fp = int(matrix[:, index].sum() - tp)
        fn = int(matrix[index, :].sum() - tp)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
        per_class[name] = {"support": int(matrix[index, :].sum()), "precision": precision, "recall": recall, "f1": f1}
        f1_values.append(f1)
    return {
        "accuracy": float(np.trace(matrix) / matrix.sum()) if matrix.sum() else 0.0,
        "macro_f1": float(np.mean(f1_values)),
        "cover_f1": per_class["cover"]["f1"],
        "cover_recall": per_class["cover"]["recall"],
        "per_class": per_class,
        "confusion_matrix": matrix.tolist(),
        "class_order": list(CLASS_NAMES),
    }


@torch.inference_mode()
def evaluate(model: nn.Module, loader: DataLoader[tuple[Tensor, int]], device: torch.device) -> tuple[float, dict[str, Any]]:
    model.eval()
    criterion = nn.CrossEntropyLoss()
    total_loss = 0.0
    total_items = 0
    targets: list[int] = []
    predictions: list[int] = []
    for inputs, labels in loader:
        inputs, labels = inputs.to(device, non_blocking=True), labels.to(device, non_blocking=True)
        logits = model(inputs)
        total_loss += criterion(logits, labels).item() * labels.size(0)
        total_items += labels.size(0)
        targets.extend(labels.cpu().tolist())
        predictions.extend(logits.argmax(dim=1).cpu().tolist())
    return total_loss / max(total_items, 1), classification_metrics(targets, predictions)


@torch.inference_mode()
def score_validation_pages(
    model: nn.Module, samples: list[Sample], transform: transforms.Compose, device: torch.device
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Persist page-level cover scores for threshold selection and error review."""
    model.eval()
    predictions: list[dict[str, Any]] = []
    for sample in samples:
        with Image.open(sample.image_path) as raw:
            image = ImageOps.exif_transpose(raw).convert("RGB")
        inputs = transform(image).unsqueeze(0).to(device)
        probabilities = torch.softmax(model(inputs), dim=1)[0].cpu().tolist()
        predicted_index = int(np.argmax(probabilities))
        predictions.append(
            {
                "page_id": sample.page_id,
                "volume_name": sample.volume_name,
                "image_path": str(sample.image_path),
                "label": sample.label,
                "predicted_label": CLASS_NAMES[predicted_index],
                "probabilities": {name: probabilities[index] for index, name in enumerate(CLASS_NAMES)},
            }
        )

    threshold_rows: list[dict[str, Any]] = []
    cover_total = sum(row["label"] == "cover" for row in predictions)
    for threshold in (0.50, 0.25, 0.10, 0.05, 0.01):
        selected = [row for row in predictions if row["probabilities"]["cover"] >= threshold]
        recalled = sum(row["label"] == "cover" for row in selected)
        false_candidates = sum(row["label"] != "cover" for row in selected)
        threshold_rows.append(
            {
                "cover_threshold": threshold,
                "candidates": len(selected),
                "cover_recalled": recalled,
                "cover_total": cover_total,
                "cover_recall": recalled / cover_total if cover_total else 0.0,
                "false_candidates": false_candidates,
            }
        )
    return predictions, threshold_rows


def save_checkpoint(path: Path, model: nn.Module, args: argparse.Namespace, epoch: int, metrics: dict[str, Any]) -> None:
    torch.save(
        {
            "architecture": "mobilenet_v3_small",
            "class_names": list(CLASS_NAMES),
            "image_size": IMAGE_SIZE,
            "state_dict": model.state_dict(),
            "epoch": epoch,
            "metrics": metrics,
            "arguments": vars(args),
        },
        path,
    )


def export_and_verify(model: nn.Module, output_dir: Path, device: torch.device) -> dict[str, Any]:
    model = copy.deepcopy(model).to("cpu").eval()
    sample = torch.zeros((1, 3, IMAGE_SIZE, IMAGE_SIZE), dtype=torch.float32)
    onnx_path = output_dir / "page_type_classifier.onnx"
    torch.onnx.export(
        model,
        sample,
        onnx_path,
        input_names=["input"],
        output_names=["logits"],
        opset_version=17,
        dynamic_axes=None,
        dynamo=False,
    )
    graph = onnx.load(onnx_path)
    onnx.checker.check_model(graph)
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    outputs = session.run(None, {"input": sample.numpy()})
    if len(outputs) != 1 or tuple(outputs[0].shape) != (1, len(CLASS_NAMES)):
        raise RuntimeError(f"Sortie ONNX inattendue: {[output.shape for output in outputs]}")
    metadata = {
        "format": "page_type_classifier_v1",
        "architecture": "mobilenet_v3_small",
        "classes": list(CLASS_NAMES),
        "input": {"name": "input", "shape": [1, 3, IMAGE_SIZE, IMAGE_SIZE], "color_space": "RGB"},
        "output": {"name": "logits", "shape": [1, len(CLASS_NAMES)]},
        "preprocessing": {
            "resize_shortest_edge": RESIZE_SIZE,
            "center_crop": IMAGE_SIZE,
            "mean": list(NORMALIZE_MEAN),
            "std": list(NORMALIZE_STD),
        },
        "onnxruntime_cpu_smoke": {"output_shape": list(outputs[0].shape)},
    }
    atomic_json(output_dir / "page_type_classifier.metadata.json", metadata)
    return {"onnx_path": str(onnx_path), "onnx_output_shape": list(outputs[0].shape)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Entraîne MobileNetV3-Small sur le dataset page-type local.")
    parser.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    parser.add_argument("--held-out-volume", default="One Piece T07")
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--warmup-epochs", type=int, default=3, help="Époques avec backbone gelé.")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--cpu", action="store_true", help="Force le CPU (utile uniquement pour un smoke test).")
    parser.add_argument("--no-pretrained", action="store_true", help="N'utilise pas les poids ImageNet.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.epochs < 1 or args.batch_size < 1 or args.warmup_epochs < 0:
        raise SystemExit("epochs et batch-size doivent être positifs; warmup-epochs doit être nul ou positif.")
    set_seed(args.seed)
    device = torch.device("cpu" if args.cpu or not torch.cuda.is_available() else "cuda")
    samples = load_samples(args.dataset_dir.resolve())
    train_samples, validation_samples = split_by_volume(samples, args.held_out_volume)
    train_transform, validation_transform = make_transforms()
    train_dataset = PageDataset(train_samples, train_transform)
    validation_dataset = PageDataset(validation_samples, validation_transform)

    train_counts = Counter(sample.label for sample in train_samples)
    sample_weights = [1.0 / train_counts[sample.label] for sample in train_samples]
    generator = torch.Generator().manual_seed(args.seed)
    sampler = WeightedRandomSampler(sample_weights, num_samples=len(train_samples), replacement=True, generator=generator)
    loader_kwargs = {"num_workers": args.workers, "pin_memory": device.type == "cuda", "persistent_workers": args.workers > 0}
    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, sampler=sampler, **loader_kwargs)
    validation_loader = DataLoader(validation_dataset, batch_size=args.batch_size, shuffle=False, **loader_kwargs)

    run_name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_dir = RUNS_DIR / run_name
    output_dir.mkdir(parents=True, exist_ok=False)
    model = build_model(pretrained=not args.no_pretrained).to(device)
    optimizer = AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    scheduler = CosineAnnealingLR(optimizer, T_max=max(args.epochs - args.warmup_epochs, 1), eta_min=args.learning_rate * 0.05)
    criterion = nn.CrossEntropyLoss()
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    history: list[dict[str, Any]] = []
    best_state: dict[str, Tensor] | None = None
    best_metrics: dict[str, Any] | None = None
    best_score = (-1.0, -1.0)
    best_epoch = 0

    print(json.dumps({"device": str(device), "train": dict(train_counts), "validation": dict(Counter(s.label for s in validation_samples)), "held_out_volume": args.held_out_volume}, ensure_ascii=False))
    for epoch in range(1, args.epochs + 1):
        is_warmup = epoch <= args.warmup_epochs
        freeze_backbone(model, frozen=is_warmup)
        model.train()
        running_loss = 0.0
        seen = 0
        start = time.perf_counter()
        for inputs, labels in train_loader:
            inputs, labels = inputs.to(device, non_blocking=True), labels.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                logits = model(inputs)
                loss = criterion(logits, labels)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            running_loss += loss.item() * labels.size(0)
            seen += labels.size(0)
        if not is_warmup:
            scheduler.step()
        validation_loss, metrics = evaluate(model, validation_loader, device)
        entry = {
            "epoch": epoch,
            "phase": "frozen_backbone" if is_warmup else "finetune",
            "learning_rate": optimizer.param_groups[0]["lr"],
            "train_loss": running_loss / max(seen, 1),
            "validation_loss": validation_loss,
            "seconds": time.perf_counter() - start,
            **metrics,
        }
        history.append(entry)
        atomic_json(output_dir / "history.json", history)
        save_checkpoint(output_dir / "last.pt", model, args, epoch, metrics)
        # Summary is a first-class import signal, so choose the checkpoint on
        # macro F1 and use cover F1 only to break a tie.
        score = (float(metrics["macro_f1"]), float(metrics["cover_f1"]))
        if score > best_score:
            best_score = score
            best_metrics = metrics
            best_state = copy.deepcopy(model.state_dict())
            best_epoch = epoch
            save_checkpoint(output_dir / "best.pt", model, args, epoch, metrics)
        print(
            f"epoch={epoch:02d}/{args.epochs} phase={entry['phase']} loss={entry['train_loss']:.4f} "
            f"val_loss={validation_loss:.4f} cover_recall={metrics['cover_recall']:.3f} "
            f"cover_f1={metrics['cover_f1']:.3f} macro_f1={metrics['macro_f1']:.3f}"
        )

    if best_state is None or best_metrics is None:
        raise RuntimeError("Aucun checkpoint n'a été produit.")
    model.load_state_dict(best_state)
    export_summary = export_and_verify(model, output_dir, device)
    validation_predictions, candidate_thresholds = score_validation_pages(
        model, validation_samples, validation_transform, device
    )
    atomic_json(output_dir / "validation_predictions.json", validation_predictions)
    result = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "architecture": "mobilenet_v3_small",
        "device": str(device),
        "dataset_dir": str(args.dataset_dir.resolve()),
        "held_out_volume": args.held_out_volume,
        "train_counts": dict(train_counts),
        "validation_counts": dict(Counter(sample.label for sample in validation_samples)),
        "best_metrics": best_metrics,
        "selection_metric": "macro_f1_then_cover_f1",
        "best_epoch": best_epoch,
        "candidate_thresholds": candidate_thresholds,
        "arguments": vars(args) | {"dataset_dir": str(args.dataset_dir.resolve())},
        **export_summary,
    }
    atomic_json(output_dir / "metrics.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
