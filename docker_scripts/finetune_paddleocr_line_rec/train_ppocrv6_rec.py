import argparse
import json
import math
import os
import sys
from pathlib import Path

import editdistance
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from tqdm import tqdm


DEFAULT_MODEL_ID = "PaddlePaddle/PP-OCRv6_medium_rec_safetensors"
DEFAULT_OUTPUT_DIR = Path("/workspace/outputs_paddleocr_line_rec")


def dataset_ready(dataset_dir: Path) -> bool:
    return (dataset_dir / "rec_gt_train.txt").exists() and (dataset_dir / "rec_gt_val.txt").exists()


def count_label_rows(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def load_transformers_components(model_id: str, resume_from: Path | None = None):
    from transformers import AutoConfig, AutoProcessor

    model_source = str(resume_from) if resume_from else model_id
    try:
        config = AutoConfig.from_pretrained(model_source, trust_remote_code=True)
        processor = AutoProcessor.from_pretrained(model_source, trust_remote_code=True)
        from transformers.models.pp_ocrv6_small_rec.modeling_pp_ocrv6_small_rec import PPOCRV6SmallRecForTextRecognition

        model = PPOCRV6SmallRecForTextRecognition.from_pretrained(model_source, trust_remote_code=True)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "Transformers cannot load PP-OCRv6 yet in this environment. "
            "Install a Transformers build that registers `pp_ocrv6_small_rec`, "
            "or switch this launcher to PaddleOCR's native training-model path. "
            f"Original error: {exc}"
        ) from exc

    return config, processor, model


def build_lr_scheduler(optimizer, scheduler_name: str, total_steps: int, warmup_ratio: float):
    if scheduler_name == "none":
        return None
    warmup_steps = int(total_steps * warmup_ratio)

    def lr_lambda(step: int) -> float:
        if warmup_steps and step < warmup_steps:
            return max(step, 1) / max(warmup_steps, 1)
        progress = (step - warmup_steps) / max(total_steps - warmup_steps, 1)
        if scheduler_name == "cosine":
            return 0.5 * (1.0 + math.cos(math.pi * min(max(progress, 0.0), 1.0)))
        return 1.0

    return torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda)


def read_label_file(dataset_dir: Path, split: str) -> list[tuple[Path, str]]:
    rows = []
    label_path = dataset_dir / f"rec_gt_{split}.txt"
    for raw in label_path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        rel_image, text = raw.split("\t", 1)
        rows.append((dataset_dir / rel_image, text))
    return rows


class RecDataset(Dataset):
    def __init__(
        self,
        rows: list[tuple[Path, str]],
        char_to_id: dict[str, int],
        max_target_len: int,
        short_max_len: int,
        short_loss_weight: float,
    ):
        self.rows = []
        dropped = 0
        short_count = 0
        self.short_max_len = short_max_len
        for image_path, text in rows:
            ids = [char_to_id[ch] for ch in text if ch in char_to_id and char_to_id[ch] != 0]
            if not ids or len(ids) > max_target_len:
                dropped += 1
                continue
            is_short = len(text) <= short_max_len
            if is_short:
                short_count += 1
            loss_weight = short_loss_weight if is_short else 1.0
            self.rows.append((image_path, text, torch.tensor(ids, dtype=torch.long), loss_weight, is_short))
        self.dropped = dropped
        self.short_count = short_count

    def sampler_weights(self, short_oversample: float) -> list[float]:
        return [float(short_oversample if row[4] else 1.0) for row in self.rows]

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        image_path, text, target, loss_weight, is_short = self.rows[index]
        with Image.open(image_path) as img:
            image = img.convert("RGB")
        return {"image": image, "text": text, "target": target, "loss_weight": loss_weight, "is_short": is_short}


def configure_processor_width(processor, image_width: int) -> None:
    processor.size = {"height": 48, "width": image_width}
    processor.pad_size = {"height": 48, "width": image_width}


def make_collate(processor):
    def collate(batch):
        encoded = processor(images=[item["image"] for item in batch], return_tensors="pt")
        targets = torch.cat([item["target"] for item in batch])
        target_lengths = torch.tensor([len(item["target"]) for item in batch], dtype=torch.long)
        return {
            "pixel_values": encoded["pixel_values"],
            "targets": targets,
            "target_lengths": target_lengths,
            "loss_weights": torch.tensor([item["loss_weight"] for item in batch], dtype=torch.float32),
            "is_short": [item["is_short"] for item in batch],
            "texts": [item["text"] for item in batch],
        }

    return collate


def decode_ctc(probabilities: torch.Tensor, characters: list[str], blank_penalty: float = 0.0) -> list[str]:
    scores = probabilities.float().clamp_min(1e-8).log()
    if blank_penalty:
        scores[..., 0] -= blank_penalty
    ids = scores.argmax(dim=-1).detach().cpu().tolist()
    texts = []
    for seq in ids:
        previous = None
        chars = []
        for idx in seq:
            if idx != 0 and idx != previous and idx < len(characters):
                chars.append(characters[idx])
            previous = idx
        texts.append("".join(chars))
    return texts


def compute_cer(predictions: list[str], references: list[str]) -> float:
    distance = sum(editdistance.eval(pred, ref) for pred, ref in zip(predictions, references))
    total = sum(len(ref) for ref in references)
    return float(distance / max(total, 1))


def compute_exact(predictions: list[str], references: list[str]) -> float:
    return sum(pred == ref for pred, ref in zip(predictions, references)) / max(len(references), 1)


def pairs_metric(predictions: list[str], references: list[str]) -> dict:
    return {
        "samples": len(references),
        "cer": compute_cer(predictions, references) if references else 0.0,
        "exact_match": compute_exact(predictions, references) if references else 0.0,
    }


def evaluate(model, loader, characters: list[str], device: torch.device, use_amp: bool, blank_penalty: float) -> dict:
    model.eval()
    losses = []
    predictions = []
    references = []
    with torch.no_grad():
        for batch in loader:
            pixel_values = batch["pixel_values"].to(device)
            targets = batch["targets"].to(device)
            target_lengths = batch["target_lengths"].to(device)
            with torch.amp.autocast(device_type="cuda", enabled=use_amp):
                probabilities = model(pixel_values=pixel_values).last_hidden_state
            log_probs = probabilities.float().clamp_min(1e-8).log().transpose(0, 1)
            input_lengths = torch.full(
                size=(pixel_values.shape[0],),
                fill_value=log_probs.shape[0],
                dtype=torch.long,
                device=device,
            )
            sample_losses = F.ctc_loss(
                log_probs,
                targets,
                input_lengths,
                target_lengths,
                blank=0,
                zero_infinity=True,
                reduction="none",
            )
            sample_losses = sample_losses / target_lengths.float().clamp_min(1)
            losses.extend(float(value) for value in sample_losses.detach().cpu())
            predictions.extend(decode_ctc(probabilities, characters, blank_penalty=blank_penalty))
            references.extend(batch["texts"])
    short_pairs = [(pred, ref) for pred, ref in zip(predictions, references) if len(ref) <= loader.dataset.short_max_len]
    medium_pairs = [(pred, ref) for pred, ref in zip(predictions, references) if loader.dataset.short_max_len < len(ref) <= 40]
    dialogue_pairs = [(pred, ref) for pred, ref in zip(predictions, references) if len(ref) > 40]
    short_metrics = pairs_metric([pred for pred, _ in short_pairs], [ref for _, ref in short_pairs])
    medium_metrics = pairs_metric([pred for pred, _ in medium_pairs], [ref for _, ref in medium_pairs])
    dialogue_metrics = pairs_metric([pred for pred, _ in dialogue_pairs], [ref for _, ref in dialogue_pairs])
    return {
        "loss": sum(losses) / max(len(losses), 1),
        "cer": compute_cer(predictions, references),
        "exact_match": compute_exact(predictions, references),
        "samples": len(references),
        "empty_predictions": sum(1 for pred in predictions if not pred),
        "short_samples": short_metrics["samples"],
        "short_cer": short_metrics["cer"],
        "short_exact_match": short_metrics["exact_match"],
        "medium_samples": medium_metrics["samples"],
        "medium_cer": medium_metrics["cer"],
        "medium_exact_match": medium_metrics["exact_match"],
        "dialogue_samples": dialogue_metrics["samples"],
        "dialogue_cer": dialogue_metrics["cer"],
        "dialogue_exact_match": dialogue_metrics["exact_match"],
    }


def write_training_readme(output_dir: Path, model_id: str, dataset_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    readme = output_dir / "TRAINING_BLOCKED_OR_READY.md"
    readme.write_text(
        "\n".join(
            [
                "# PP-OCRv6 line recognition training launcher",
                "",
                f"Model: `{model_id}`",
                f"Dataset: `{dataset_dir}`",
                "",
                "This launcher fine-tunes `PPOCRV6SmallRecForTextRecognition` with CTC loss.",
                "The default profile is memory-conscious: AMP enabled, backbone frozen,",
                "small micro-batches, and gradient accumulation.",
                "",
                "Expected dataset files:",
                "",
                "- `rec_gt_train.txt`",
                "- `rec_gt_val.txt`",
                "- `images/train/*.png`",
                "- `images/val/*.png`",
            ]
        ),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Fine-tune PP-OCRv6 medium recognition on stitched single-line bubble images.")
    parser.add_argument("--model-id", default=os.getenv("PPOCR_MODEL_ID", DEFAULT_MODEL_ID))
    parser.add_argument("--output-dir", type=Path, default=Path(os.getenv("PPOCR_LINE_OUTPUT_DIR", DEFAULT_OUTPUT_DIR)))
    parser.add_argument("--dataset-dir", type=Path, default=None)
    parser.add_argument("--resume-from", type=Path, default=None)
    parser.add_argument("--auto-resume-best", action="store_true")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--backbone-learning-rate", type=float, default=float(os.getenv("PPOCR_BACKBONE_LEARNING_RATE", "2e-6")))
    parser.add_argument("--weight-decay", type=float, default=float(os.getenv("PPOCR_WEIGHT_DECAY", "0.01")))
    parser.add_argument("--lr-scheduler", choices=["none", "cosine"], default=os.getenv("PPOCR_LR_SCHEDULER", "none"))
    parser.add_argument("--warmup-ratio", type=float, default=float(os.getenv("PPOCR_WARMUP_RATIO", "0.03")))
    parser.add_argument("--workers", type=int, default=int(os.getenv("PPOCR_TRAIN_WORKERS", "0")))
    parser.add_argument("--image-width", type=int, default=int(os.getenv("PPOCR_IMAGE_WIDTH", "640")))
    parser.add_argument("--grad-accum-steps", type=int, default=int(os.getenv("PPOCR_GRAD_ACCUM_STEPS", "8")))
    parser.add_argument("--short-max-len", type=int, default=int(os.getenv("PPOCR_SHORT_MAX_LEN", "12")))
    parser.add_argument("--short-loss-weight", type=float, default=float(os.getenv("PPOCR_SHORT_LOSS_WEIGHT", "2.5")))
    parser.add_argument("--short-oversample", type=float, default=float(os.getenv("PPOCR_SHORT_OVERSAMPLE", "3.0")))
    parser.add_argument("--blank-penalty", type=float, default=float(os.getenv("PPOCR_BLANK_PENALTY", "0.0")))
    parser.add_argument("--train-backbone", action="store_true", help="Unfreeze the LCNetV4 backbone. Uses much more VRAM.")
    parser.add_argument("--no-amp", action="store_true", help="Disable CUDA mixed precision.")
    parser.add_argument("--pin-memory", action="store_true", help="Use pinned host memory for DataLoader batches.")
    parser.add_argument("--save-every-epoch", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    dataset_dir = args.dataset_dir or (args.output_dir / "bubble_single_line_rec_dataset")
    if not dataset_ready(dataset_dir):
        print(f"[ERROR] Dataset is not ready: {dataset_dir}", flush=True)
        return 1

    train_rows = count_label_rows(dataset_dir / "rec_gt_train.txt")
    val_rows = count_label_rows(dataset_dir / "rec_gt_val.txt")
    print(f"Dataset rows: train={train_rows}, val={val_rows}", flush=True)
    write_training_readme(args.output_dir, args.model_id, dataset_dir)

    resume_from = args.resume_from
    if args.auto_resume_best:
        best_dir = args.output_dir / "ppocrv6_medium_rec_line_finetune_best"
        if best_dir.exists():
            resume_from = best_dir
            print(f"Auto-resuming from best checkpoint: {resume_from}", flush=True)

    try:
        config, processor, model = load_transformers_components(args.model_id, resume_from=resume_from)
    except RuntimeError as exc:
        print(f"[BLOCKED] {exc}", flush=True)
        (args.output_dir / "training_status.json").write_text(
            json.dumps(
                {
                    "status": "blocked_transformers_architecture",
                    "model_id": args.model_id,
                    "dataset_dir": str(dataset_dir),
                    "train_rows": train_rows,
                    "val_rows": val_rows,
                    "error": str(exc),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return 2

    if args.dry_run:
        print(f"Transformers loader ok: config={type(config).__name__}, processor={type(processor).__name__}, model={type(model).__name__}", flush=True)
        return 0

    if not args.train_backbone and hasattr(model, "backbone"):
        for parameter in model.backbone.parameters():
            parameter.requires_grad = False

    configure_processor_width(processor, args.image_width)
    characters = list(processor.character_list)
    char_to_id = {char: idx for idx, char in enumerate(characters)}
    max_target_len = args.image_width // 8

    train_dataset = RecDataset(
        read_label_file(dataset_dir, "train"),
        char_to_id,
        max_target_len=max_target_len,
        short_max_len=args.short_max_len,
        short_loss_weight=args.short_loss_weight,
    )
    val_dataset = RecDataset(
        read_label_file(dataset_dir, "val"),
        char_to_id,
        max_target_len=max_target_len,
        short_max_len=args.short_max_len,
        short_loss_weight=1.0,
    )
    if not train_dataset or not val_dataset:
        print(
            "[ERROR] No trainable rows after CTC filtering. "
            f"Try a larger --image-width. train_dropped={train_dataset.dropped}, val_dropped={val_dataset.dropped}",
            flush=True,
        )
        return 1

    collate = make_collate(processor)
    sampler = None
    shuffle_train = True
    if args.short_oversample > 1.0:
        sampler = WeightedRandomSampler(
            weights=train_dataset.sampler_weights(args.short_oversample),
            num_samples=len(train_dataset),
            replacement=True,
        )
        shuffle_train = False
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=shuffle_train,
        sampler=sampler,
        num_workers=args.workers,
        collate_fn=collate,
        pin_memory=args.pin_memory and torch.cuda.is_available(),
    )
    val_loader = DataLoader(
        val_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=args.workers,
        collate_fn=collate,
        pin_memory=args.pin_memory and torch.cuda.is_available(),
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    trainable_parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    if args.train_backbone and hasattr(model, "backbone"):
        backbone_parameters = [parameter for parameter in model.backbone.parameters() if parameter.requires_grad]
        backbone_ids = {id(parameter) for parameter in backbone_parameters}
        head_parameters = [parameter for parameter in model.parameters() if parameter.requires_grad and id(parameter) not in backbone_ids]
        optimizer_groups = [
            {"params": head_parameters, "lr": args.learning_rate, "weight_decay": args.weight_decay, "name": "head"},
            {"params": backbone_parameters, "lr": args.backbone_learning_rate, "weight_decay": args.weight_decay, "name": "backbone"},
        ]
    else:
        optimizer_groups = [{"params": trainable_parameters, "lr": args.learning_rate, "weight_decay": args.weight_decay, "name": "trainable"}]
    optimizer = torch.optim.AdamW(optimizer_groups)
    total_update_steps = math.ceil(len(train_loader) / max(args.grad_accum_steps, 1)) * args.epochs
    scheduler = build_lr_scheduler(optimizer, args.lr_scheduler, total_update_steps, args.warmup_ratio)
    use_amp = torch.cuda.is_available() and not args.no_amp
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    best_cer = float("inf")
    metrics = {
        "model_id": args.model_id,
        "resume_from": str(resume_from) if resume_from else None,
        "dataset_dir": str(dataset_dir),
        "image_width": args.image_width,
        "max_target_len": max_target_len,
        "train_rows": len(train_dataset),
        "val_rows": len(val_dataset),
        "train_dropped": train_dataset.dropped,
        "val_dropped": val_dataset.dropped,
        "train_short_rows": train_dataset.short_count,
        "val_short_rows": val_dataset.short_count,
        "short_max_len": args.short_max_len,
        "short_loss_weight": args.short_loss_weight,
        "short_oversample": args.short_oversample,
        "blank_penalty": args.blank_penalty,
        "learning_rate": args.learning_rate,
        "backbone_learning_rate": args.backbone_learning_rate if args.train_backbone else 0.0,
        "weight_decay": args.weight_decay,
        "lr_scheduler": args.lr_scheduler,
        "warmup_ratio": args.warmup_ratio,
        "batch_size": args.batch_size,
        "grad_accum_steps": args.grad_accum_steps,
        "effective_batch_size": args.batch_size * args.grad_accum_steps,
        "amp": use_amp,
        "train_backbone": args.train_backbone,
        "trainable_parameters": sum(parameter.numel() for parameter in trainable_parameters),
        "epochs": [],
    }

    for epoch in range(1, args.epochs + 1):
        model.train()
        train_losses = []
        optimizer.zero_grad(set_to_none=True)
        for step, batch in enumerate(tqdm(train_loader, desc=f"epoch {epoch}/{args.epochs}", leave=False), start=1):
            pixel_values = batch["pixel_values"].to(device)
            targets = batch["targets"].to(device)
            target_lengths = batch["target_lengths"].to(device)
            with torch.amp.autocast(device_type="cuda", enabled=use_amp):
                probabilities = model(pixel_values=pixel_values).last_hidden_state
            log_probs = probabilities.float().clamp_min(1e-8).log().transpose(0, 1)
            input_lengths = torch.full(
                size=(pixel_values.shape[0],),
                fill_value=log_probs.shape[0],
                dtype=torch.long,
                device=device,
            )
            sample_losses = F.ctc_loss(
                log_probs,
                targets,
                input_lengths,
                target_lengths,
                blank=0,
                zero_infinity=True,
                reduction="none",
            )
            sample_losses = sample_losses / target_lengths.float().clamp_min(1)
            loss_weights = batch["loss_weights"].to(device)
            loss = (sample_losses * loss_weights).sum() / loss_weights.sum().clamp_min(1.0)
            scaled_loss = loss / max(args.grad_accum_steps, 1)
            scaler.scale(scaled_loss).backward()
            if step % max(args.grad_accum_steps, 1) == 0 or step == len(train_loader):
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(trainable_parameters, 1.0)
                scaler.step(optimizer)
                scaler.update()
                if scheduler is not None:
                    scheduler.step()
                optimizer.zero_grad(set_to_none=True)
            train_losses.append(float(loss.detach().cpu()))
            del pixel_values, targets, target_lengths, probabilities, log_probs, loss

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        val_metrics = evaluate(model, val_loader, characters, device, use_amp, blank_penalty=args.blank_penalty)
        epoch_metrics = {
            "epoch": epoch,
            "train_loss": sum(train_losses) / max(len(train_losses), 1),
            "val_loss": val_metrics["loss"],
            "val_cer": val_metrics["cer"],
            "val_exact_match": val_metrics["exact_match"],
            "val_empty_predictions": val_metrics["empty_predictions"],
            "val_short_cer": val_metrics["short_cer"],
            "val_short_exact_match": val_metrics["short_exact_match"],
            "val_medium_cer": val_metrics["medium_cer"],
            "val_medium_exact_match": val_metrics["medium_exact_match"],
            "val_dialogue_cer": val_metrics["dialogue_cer"],
            "val_dialogue_exact_match": val_metrics["dialogue_exact_match"],
        }
        metrics["epochs"].append(epoch_metrics)
        print(json.dumps(epoch_metrics, ensure_ascii=False), flush=True)

        if val_metrics["cer"] < best_cer:
            best_cer = val_metrics["cer"]
            best_dir = args.output_dir / "ppocrv6_medium_rec_line_finetune_best"
            best_dir.mkdir(parents=True, exist_ok=True)
            model.save_pretrained(best_dir)
            processor.save_pretrained(best_dir)
            (best_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")

        if args.save_every_epoch:
            epoch_dir = args.output_dir / f"checkpoint_epoch_{epoch:03d}"
            epoch_dir.mkdir(parents=True, exist_ok=True)
            model.save_pretrained(epoch_dir)
            processor.save_pretrained(epoch_dir)

    metrics["best_val_cer"] = best_cer
    metrics_path = args.output_dir / "training_metrics.json"
    metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Training complete. Best CER={best_cer:.6f}. Metrics: {metrics_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
