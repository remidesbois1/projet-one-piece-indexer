import argparse
import csv
import json
import math
import os
import re
import sys
import unicodedata
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


def get_backbone_module(model: torch.nn.Module) -> torch.nn.Module | None:
    if hasattr(model, "backbone"):
        return model.backbone
    nested_model = getattr(model, "model", None)
    if nested_model is not None and hasattr(nested_model, "backbone"):
        return nested_model.backbone
    return None


def get_classifier_module(model: torch.nn.Module) -> torch.nn.Module | None:
    head = getattr(model, "head", None)
    classifier = getattr(head, "head", None)
    if classifier is not None:
        return classifier
    nested_model = getattr(model, "model", None)
    nested_head = getattr(nested_model, "head", None) if nested_model is not None else None
    return getattr(nested_head, "head", None) if nested_head is not None else None


PUNCT_TRANSLATION = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201a": "'",
        "\u201b": "'",
        "\u2032": "'",
        "\u00b4": "'",
        "\u0060": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201e": '"',
        "\u201f": '"',
        "\u2033": '"',
        "\u00ab": '"',
        "\u00bb": '"',
        "\u2010": "-",
        "\u2011": "-",
        "\u2012": "-",
        "\u2013": "-",
        "\u2014": "-",
        "\u2026": "...",
        "\u00a0": " ",
        "\u202f": " ",
    }
)


def normalize_for_metrics(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = text.translate(PUNCT_TRANSLATION)
    text = text.replace("\u0153", "oe").replace("\u0152", "OE")
    text = re.sub(r"\s+", " ", text.strip())
    text = re.sub(r"\s+([?!.,;:])", r"\1", text)
    text = re.sub(r"([([{])\s+", r"\1", text)
    text = re.sub(r"\s+([])}])", r"\1", text)
    return text


def read_label_file(dataset_dir: Path, split: str) -> list[tuple[Path, str, str]]:
    rows = []
    label_path = dataset_dir / f"rec_gt_{split}.txt"
    for raw in label_path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        rel_image, text = raw.split("\t", 1)
        rows.append((dataset_dir / rel_image, text, rel_image.replace("\\", "/")))
    return rows


def load_manifest_features(dataset_dir: Path) -> dict[str, dict]:
    manifest_path = dataset_dir / "line_manifest.jsonl"
    if not manifest_path.exists():
        return {}
    features = {}
    for raw in manifest_path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        item = json.loads(raw)
        rel_image = str(item.get("single_line_image") or "").replace("\\", "/")
        if not rel_image:
            continue
        features[rel_image] = {
            "line_count": len(item.get("detected_lines") or []),
            "bubble_id": str(item.get("bubble_id") or ""),
        }
    return features


def load_hard_examples(
    paths: list[Path],
    min_cer: float,
    short_max_len: int,
    short_only: bool,
    include_exact_failures: bool,
) -> dict[str, set[str]]:
    hard_images: set[str] = set()
    hard_bubbles: set[str] = set()
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"Missing hard-example CSV: {path}")
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                reference = row.get("reference") or ""
                prediction = row.get("prediction") or ""
                if short_only and len(reference) > short_max_len:
                    continue
                try:
                    cer = float(row.get("raw_cer") or row.get("cer") or "")
                except ValueError:
                    cer = editdistance.eval(prediction, reference) / max(len(reference), 1)
                failed_exact = prediction != reference
                if cer < min_cer and not (include_exact_failures and failed_exact):
                    continue
                image = str(row.get("image") or "").replace("\\", "/")
                if image:
                    hard_images.add(image)
                bubble_id = str(row.get("bubble_id") or "")
                if bubble_id:
                    hard_bubbles.add(bubble_id)
    return {"images": hard_images, "bubbles": hard_bubbles}


class RecDataset(Dataset):
    def __init__(
        self,
        rows: list[tuple[Path, str, str]],
        char_to_id: dict[str, int],
        max_target_len: int,
        short_max_len: int,
        short_loss_weight: float,
        manifest_features: dict[str, dict] | None = None,
        hard_examples: dict[str, set[str]] | None = None,
        single_line_loss_weight: float = 1.0,
        single_line_oversample: float = 1.0,
        hard_example_loss_weight: float = 1.0,
        hard_example_oversample: float = 1.0,
    ):
        self.rows = []
        dropped = 0
        short_count = 0
        single_line_count = 0
        hard_count = 0
        self.short_max_len = short_max_len
        manifest_features = manifest_features or {}
        hard_examples = hard_examples or {"images": set(), "bubbles": set()}
        for image_path, text, rel_path in rows:
            ids = [char_to_id[ch] for ch in text if ch in char_to_id and char_to_id[ch] != 0]
            if not ids or len(ids) > max_target_len:
                dropped += 1
                continue
            is_short = len(text) <= short_max_len
            if is_short:
                short_count += 1
            has_manifest_features = rel_path in manifest_features
            features = manifest_features.get(rel_path, {})
            line_count = int(features.get("line_count") or 0)
            bubble_id = str(features.get("bubble_id") or "")
            is_single_line = has_manifest_features and line_count <= 1
            is_hard = rel_path in hard_examples["images"] or bubble_id in hard_examples["bubbles"]
            if is_single_line:
                single_line_count += 1
            if is_hard:
                hard_count += 1
            loss_weight = 1.0
            sample_weight = 1.0
            if is_short:
                loss_weight *= short_loss_weight
            if is_single_line:
                loss_weight *= single_line_loss_weight
                sample_weight *= single_line_oversample
            if is_hard:
                loss_weight *= hard_example_loss_weight
                sample_weight *= hard_example_oversample
            self.rows.append(
                (
                    image_path,
                    text,
                    torch.tensor(ids, dtype=torch.long),
                    loss_weight,
                    is_short,
                    sample_weight,
                    is_single_line,
                    is_hard,
                )
            )
        self.dropped = dropped
        self.short_count = short_count
        self.single_line_count = single_line_count
        self.hard_count = hard_count

    def sampler_weights(self, short_oversample: float) -> list[float]:
        weights = []
        for row in self.rows:
            weight = float(row[5])
            if row[4]:
                weight *= short_oversample
            weights.append(weight)
        return weights

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        image_path, text, target, loss_weight, is_short, _, is_single_line, is_hard = self.rows[index]
        with Image.open(image_path) as img:
            image = img.convert("RGB")
        return {
            "image": image,
            "text": text,
            "target": target,
            "loss_weight": loss_weight,
            "is_short": is_short,
            "is_single_line": is_single_line,
            "is_hard": is_hard,
        }


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
            "is_single_line": [item["is_single_line"] for item in batch],
            "is_hard": [item["is_hard"] for item in batch],
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
    normalized_predictions = [normalize_for_metrics(pred) for pred in predictions]
    normalized_references = [normalize_for_metrics(ref) for ref in references]
    casefold_predictions = [pred.casefold() for pred in normalized_predictions]
    casefold_references = [ref.casefold() for ref in normalized_references]
    return {
        "samples": len(references),
        "cer": compute_cer(predictions, references) if references else 0.0,
        "exact_match": compute_exact(predictions, references) if references else 0.0,
        "normalized_cer": compute_cer(normalized_predictions, normalized_references) if references else 0.0,
        "normalized_exact_match": compute_exact(normalized_predictions, normalized_references) if references else 0.0,
        "casefold_normalized_cer": compute_cer(casefold_predictions, casefold_references) if references else 0.0,
        "casefold_normalized_exact_match": compute_exact(casefold_predictions, casefold_references) if references else 0.0,
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
    all_metrics = pairs_metric(predictions, references)
    return {
        "loss": sum(losses) / max(len(losses), 1),
        "cer": all_metrics["cer"],
        "exact_match": all_metrics["exact_match"],
        "normalized_cer": all_metrics["normalized_cer"],
        "normalized_exact_match": all_metrics["normalized_exact_match"],
        "casefold_normalized_cer": all_metrics["casefold_normalized_cer"],
        "casefold_normalized_exact_match": all_metrics["casefold_normalized_exact_match"],
        "samples": len(references),
        "empty_predictions": sum(1 for pred in predictions if not pred),
        "short_samples": short_metrics["samples"],
        "short_cer": short_metrics["cer"],
        "short_exact_match": short_metrics["exact_match"],
        "short_normalized_cer": short_metrics["normalized_cer"],
        "short_normalized_exact_match": short_metrics["normalized_exact_match"],
        "short_casefold_normalized_cer": short_metrics["casefold_normalized_cer"],
        "short_casefold_normalized_exact_match": short_metrics["casefold_normalized_exact_match"],
        "medium_samples": medium_metrics["samples"],
        "medium_cer": medium_metrics["cer"],
        "medium_exact_match": medium_metrics["exact_match"],
        "medium_normalized_cer": medium_metrics["normalized_cer"],
        "medium_normalized_exact_match": medium_metrics["normalized_exact_match"],
        "medium_casefold_normalized_cer": medium_metrics["casefold_normalized_cer"],
        "medium_casefold_normalized_exact_match": medium_metrics["casefold_normalized_exact_match"],
        "dialogue_samples": dialogue_metrics["samples"],
        "dialogue_cer": dialogue_metrics["cer"],
        "dialogue_exact_match": dialogue_metrics["exact_match"],
        "dialogue_normalized_cer": dialogue_metrics["normalized_cer"],
        "dialogue_normalized_exact_match": dialogue_metrics["normalized_exact_match"],
        "dialogue_casefold_normalized_cer": dialogue_metrics["casefold_normalized_cer"],
        "dialogue_casefold_normalized_exact_match": dialogue_metrics["casefold_normalized_exact_match"],
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
    parser.add_argument("--single-line-loss-weight", type=float, default=float(os.getenv("PPOCR_SINGLE_LINE_LOSS_WEIGHT", "1.0")))
    parser.add_argument("--single-line-oversample", type=float, default=float(os.getenv("PPOCR_SINGLE_LINE_OVERSAMPLE", "1.0")))
    parser.add_argument("--hard-example-csv", type=Path, action="append", default=[])
    parser.add_argument("--hard-example-min-cer", type=float, default=float(os.getenv("PPOCR_HARD_EXAMPLE_MIN_CER", "0.25")))
    parser.add_argument("--hard-example-loss-weight", type=float, default=float(os.getenv("PPOCR_HARD_EXAMPLE_LOSS_WEIGHT", "1.0")))
    parser.add_argument("--hard-example-oversample", type=float, default=float(os.getenv("PPOCR_HARD_EXAMPLE_OVERSAMPLE", "1.0")))
    parser.add_argument("--hard-example-short-only", action="store_true")
    parser.add_argument("--hard-example-include-exact-failures", action="store_true")
    parser.add_argument("--blank-penalty", type=float, default=float(os.getenv("PPOCR_BLANK_PENALTY", "0.0")))
    parser.add_argument("--train-backbone", action="store_true", help="Unfreeze the LCNetV4 backbone. Uses much more VRAM.")
    parser.add_argument("--train-classifier-only", action="store_true", help="Freeze everything except the final CTC classifier.")
    parser.add_argument("--no-amp", action="store_true", help="Disable CUDA mixed precision.")
    parser.add_argument("--pin-memory", action="store_true", help="Use pinned host memory for DataLoader batches.")
    parser.add_argument("--save-every-epoch", action="store_true")
    parser.add_argument("--max-train-steps", type=int, default=int(os.getenv("PPOCR_MAX_TRAIN_STEPS", "0")), help="Stop each epoch after this many train batches. Useful for VRAM smoke tests.")
    parser.add_argument("--profile-vram", action="store_true", help="Run a short train loop, write vram_profile.json, and skip validation/checkpointing.")
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

    backbone_module = get_backbone_module(model)
    classifier_module = get_classifier_module(model)
    if args.train_classifier_only:
        if classifier_module is None:
            print("[ERROR] --train-classifier-only requested but no final classifier module was found.", flush=True)
            return 1
        for parameter in model.parameters():
            parameter.requires_grad = False
        for parameter in classifier_module.parameters():
            parameter.requires_grad = True
    elif not args.train_backbone and backbone_module is not None:
        for parameter in backbone_module.parameters():
            parameter.requires_grad = False

    configure_processor_width(processor, args.image_width)
    characters = list(processor.character_list)
    char_to_id = {char: idx for idx, char in enumerate(characters)}
    max_target_len = args.image_width // 8
    manifest_features = load_manifest_features(dataset_dir)
    hard_examples = load_hard_examples(
        args.hard_example_csv,
        min_cer=args.hard_example_min_cer,
        short_max_len=args.short_max_len,
        short_only=args.hard_example_short_only,
        include_exact_failures=args.hard_example_include_exact_failures,
    )

    train_dataset = RecDataset(
        read_label_file(dataset_dir, "train"),
        char_to_id,
        max_target_len=max_target_len,
        short_max_len=args.short_max_len,
        short_loss_weight=args.short_loss_weight,
        manifest_features=manifest_features,
        hard_examples=hard_examples,
        single_line_loss_weight=args.single_line_loss_weight,
        single_line_oversample=args.single_line_oversample,
        hard_example_loss_weight=args.hard_example_loss_weight,
        hard_example_oversample=args.hard_example_oversample,
    )
    val_dataset = RecDataset(
        read_label_file(dataset_dir, "val"),
        char_to_id,
        max_target_len=max_target_len,
        short_max_len=args.short_max_len,
        short_loss_weight=1.0,
        manifest_features=manifest_features,
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
    sampler_weights = train_dataset.sampler_weights(args.short_oversample)
    if any(abs(weight - 1.0) > 1e-6 for weight in sampler_weights):
        sampler = WeightedRandomSampler(
            weights=sampler_weights,
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
    if args.train_backbone and backbone_module is not None:
        backbone_parameters = [parameter for parameter in backbone_module.parameters() if parameter.requires_grad]
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
        "train_single_line_rows": train_dataset.single_line_count,
        "val_single_line_rows": val_dataset.single_line_count,
        "train_hard_rows": train_dataset.hard_count,
        "short_max_len": args.short_max_len,
        "short_loss_weight": args.short_loss_weight,
        "short_oversample": args.short_oversample,
        "single_line_loss_weight": args.single_line_loss_weight,
        "single_line_oversample": args.single_line_oversample,
        "hard_example_csv": [str(path) for path in args.hard_example_csv],
        "hard_example_min_cer": args.hard_example_min_cer,
        "hard_example_loss_weight": args.hard_example_loss_weight,
        "hard_example_oversample": args.hard_example_oversample,
        "hard_example_short_only": args.hard_example_short_only,
        "hard_example_include_exact_failures": args.hard_example_include_exact_failures,
        "blank_penalty": args.blank_penalty,
        "learning_rate": args.learning_rate,
        "backbone_learning_rate": args.backbone_learning_rate if args.train_backbone else 0.0,
        "weight_decay": args.weight_decay,
        "lr_scheduler": args.lr_scheduler,
        "warmup_ratio": args.warmup_ratio,
        "batch_size": args.batch_size,
        "grad_accum_steps": args.grad_accum_steps,
        "effective_batch_size": args.batch_size * args.grad_accum_steps,
        "max_train_steps": args.max_train_steps,
        "profile_vram": args.profile_vram,
        "amp": use_amp,
        "train_backbone": args.train_backbone,
        "train_classifier_only": args.train_classifier_only,
        "trainable_parameters": sum(parameter.numel() for parameter in trainable_parameters),
        "epochs": [],
    }

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats(device)

    for epoch in range(1, args.epochs + 1):
        if args.train_classifier_only:
            model.eval()
            if classifier_module is not None:
                classifier_module.train()
        else:
            model.train()
        if not args.train_backbone and backbone_module is not None:
            backbone_module.eval()
        train_losses = []
        completed_train_steps = 0
        optimizer.zero_grad(set_to_none=True)
        for step, batch in enumerate(tqdm(train_loader, desc=f"epoch {epoch}/{args.epochs}", leave=False), start=1):
            completed_train_steps = step
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
            if args.max_train_steps > 0 and step >= args.max_train_steps:
                break

        if torch.cuda.is_available():
            torch.cuda.synchronize()
            peak_allocated_mb = torch.cuda.max_memory_allocated(device) / (1024 * 1024)
            peak_reserved_mb = torch.cuda.max_memory_reserved(device) / (1024 * 1024)
            torch.cuda.empty_cache()
        else:
            peak_allocated_mb = 0.0
            peak_reserved_mb = 0.0
        if args.profile_vram:
            profile = {
                "model_id": args.model_id,
                "resume_from": str(resume_from) if resume_from else None,
                "dataset_dir": str(dataset_dir),
                "device": str(device),
                "image_width": args.image_width,
                "batch_size": args.batch_size,
                "grad_accum_steps": args.grad_accum_steps,
                "train_backbone": args.train_backbone,
                "amp": use_amp,
                "pin_memory": args.pin_memory,
                "workers": args.workers,
                "max_train_steps": args.max_train_steps,
                "completed_train_steps": completed_train_steps,
                "train_loss": sum(train_losses) / max(len(train_losses), 1),
                "peak_cuda_allocated_mb": peak_allocated_mb,
                "peak_cuda_reserved_mb": peak_reserved_mb,
            }
            profile_path = args.output_dir / "vram_profile.json"
            profile_path.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"vram_profile": profile}, ensure_ascii=False), flush=True)
            return 0
        val_metrics = evaluate(model, val_loader, characters, device, use_amp, blank_penalty=args.blank_penalty)
        epoch_metrics = {
            "epoch": epoch,
            "train_loss": sum(train_losses) / max(len(train_losses), 1),
            "val_loss": val_metrics["loss"],
            "val_cer": val_metrics["cer"],
            "val_exact_match": val_metrics["exact_match"],
            "val_normalized_cer": val_metrics["normalized_cer"],
            "val_normalized_exact_match": val_metrics["normalized_exact_match"],
            "val_casefold_normalized_cer": val_metrics["casefold_normalized_cer"],
            "val_casefold_normalized_exact_match": val_metrics["casefold_normalized_exact_match"],
            "val_empty_predictions": val_metrics["empty_predictions"],
            "val_short_cer": val_metrics["short_cer"],
            "val_short_exact_match": val_metrics["short_exact_match"],
            "val_short_normalized_cer": val_metrics["short_normalized_cer"],
            "val_short_normalized_exact_match": val_metrics["short_normalized_exact_match"],
            "val_short_casefold_normalized_cer": val_metrics["short_casefold_normalized_cer"],
            "val_short_casefold_normalized_exact_match": val_metrics["short_casefold_normalized_exact_match"],
            "val_medium_cer": val_metrics["medium_cer"],
            "val_medium_exact_match": val_metrics["medium_exact_match"],
            "val_medium_normalized_cer": val_metrics["medium_normalized_cer"],
            "val_medium_normalized_exact_match": val_metrics["medium_normalized_exact_match"],
            "val_medium_casefold_normalized_cer": val_metrics["medium_casefold_normalized_cer"],
            "val_medium_casefold_normalized_exact_match": val_metrics["medium_casefold_normalized_exact_match"],
            "val_dialogue_cer": val_metrics["dialogue_cer"],
            "val_dialogue_exact_match": val_metrics["dialogue_exact_match"],
            "val_dialogue_normalized_cer": val_metrics["dialogue_normalized_cer"],
            "val_dialogue_normalized_exact_match": val_metrics["dialogue_normalized_exact_match"],
            "val_dialogue_casefold_normalized_cer": val_metrics["dialogue_casefold_normalized_cer"],
            "val_dialogue_casefold_normalized_exact_match": val_metrics["dialogue_casefold_normalized_exact_match"],
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
