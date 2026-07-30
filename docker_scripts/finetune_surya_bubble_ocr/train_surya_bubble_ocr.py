import argparse
import glob
import importlib.metadata
import json
import math
import os
import random
import re
import time
from collections import OrderedDict
from pathlib import Path

import jiwer
import numpy as np
import torch
import torch.nn.functional as F
from datasets import load_dataset
from dotenv import load_dotenv
from Levenshtein import distance as levenshtein_distance
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from transformers import (
    AutoModelForImageTextToText,
    AutoProcessor,
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    Trainer,
    TrainerCallback,
)
from transformers.trainer_utils import get_last_checkpoint


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

MODEL_ID = os.getenv("SURYA_MODEL_ID", "datalab-to/surya-ocr-2")
DATASET_DIR = Path(os.getenv("SURYA_DATASET_DIR", str(SCRIPT_DIR / "surya_bubble_dataset")))
OUTPUT_DIR = Path(os.getenv("SURYA_OUTPUT_DIR", str(SCRIPT_DIR / "outputs_surya_bubble_ocr")))
FINAL_DIR = OUTPUT_DIR / "final_merged"
TRAIN_FILE = DATASET_DIR / "train" / "metadata.jsonl"
VAL_FILE = DATASET_DIR / "val" / "metadata.jsonl"
TEST_FILE = DATASET_DIR / "test" / "metadata.jsonl"
SPLITS = ("train", "val", "test")

USER_PROMPT = os.getenv(
    "SURYA_USER_PROMPT",
    "Transcris exactement le texte visible dans cette bulle. Ne rajoute rien.",
)
MAX_NEW_TOKENS = int(os.getenv("SURYA_MAX_NEW_TOKENS", "256"))
GEN_EVAL_MAX_SAMPLES = int(os.getenv("SURYA_GEN_EVAL_MAX_SAMPLES", "256"))
GEN_EVAL_BATCH_SIZE = int(os.getenv("SURYA_GEN_EVAL_BATCH", "8"))
FINAL_TEST_MAX_SAMPLES = int(os.getenv("SURYA_FINAL_TEST_MAX_SAMPLES", "0"))
RANDOM_SEED = int(os.getenv("SURYA_RANDOM_SEED", "42"))
MIN_IMAGE_PIXELS = int(os.getenv("SURYA_MIN_IMAGE_PIXELS", str(256 * 256)))
MAX_IMAGE_PIXELS = int(os.getenv("SURYA_MAX_IMAGE_PIXELS", str(1024 * 1024)))
COLLAPSE_WHITESPACE = os.getenv("SURYA_COLLAPSE_WHITESPACE", "1").lower() not in {
    "0",
    "false",
    "no",
    "off",
    "",
}


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def parse_args():
    parser = argparse.ArgumentParser(description="Fine-tune Surya OCR 2 for Poneglyph bubble OCR.")
    parser.add_argument("--merge-only", action="store_true", help="Merge the best LoRA checkpoint and exit.")
    parser.add_argument("--benchmark-only", action="store_true", help="Benchmark an existing merged model.")
    parser.add_argument(
        "--validate-setup",
        action="store_true",
        help="Validate the dataset, processor, trainable modules and GPU fast path without training.",
    )
    parser.add_argument(
        "--train-smoke-steps",
        type=int,
        default=0,
        help="Run this many real Trainer steps, then exit without saving or benchmarking.",
    )
    parser.add_argument("--model-path", default=None, help="Model path for merge-only or benchmark-only.")
    return parser.parse_args()


def configure_torch_runtime() -> None:
    torch.set_num_threads(int(os.getenv("SURYA_TORCH_THREADS", "8")))
    if torch.cuda.is_available():
        for flag_name in ("enable_flash_sdp", "enable_mem_efficient_sdp", "enable_math_sdp"):
            flag = getattr(torch.backends.cuda, flag_name, None)
            if callable(flag):
                flag(True)
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        try:
            torch.set_float32_matmul_precision("high")
        except Exception:
            pass
    if hasattr(torch, "_dynamo"):
        torch._dynamo.config.suppress_errors = True
        if hasattr(torch._dynamo.config, "dynamic_shapes"):
            torch._dynamo.config.dynamic_shapes = True


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def prepare_dataset(file_path: Path, split_name: str, processor=None):
    if not file_path.exists():
        raise FileNotFoundError(f"Missing dataset file: {file_path}")
    print(f"Loading {split_name} dataset from {file_path}", flush=True)
    dataset = load_dataset("json", data_files=str(file_path), split="train")
    if "split" not in dataset.column_names:
        dataset = dataset.map(lambda _: {"split": split_name})
    if processor is not None:
        dataset = add_training_metadata(dataset, processor)
        target_lengths = dataset["target_token_length"]
        max_target_length = max(target_lengths, default=0)
        p99_target_length = (
            int(np.percentile(target_lengths, 99)) if target_lengths else 0
        )
        over_budget = sum(length > MAX_NEW_TOKENS for length in target_lengths)
        print(
            f"  {split_name} target tokens: p99={p99_target_length}, "
            f"max={max_target_length}, generation_budget={MAX_NEW_TOKENS}",
            flush=True,
        )
        if over_budget:
            raise RuntimeError(
                f"{over_budget} {split_name} target(s) exceed "
                f"SURYA_MAX_NEW_TOKENS={MAX_NEW_TOKENS}; refusing a run whose "
                "validation would silently truncate valid references."
            )
    print(f"  {split_name}: {len(dataset)} samples", flush=True)
    return dataset


def is_onomatopoeia_like(reference: str) -> bool:
    reference = str(reference or "").strip()
    return bool(
        re.search(r"(.)\1{2,}", reference, flags=re.IGNORECASE)
        or re.fullmatch(r"[A-ZÀ-Ý!?.\- ]{2,}", reference)
    )


def sample_training_weight(reference: str) -> float:
    reference = str(reference or "").strip()
    length = len(reference)
    weight = 1.0
    if length <= 3:
        weight *= float(os.getenv("SURYA_VERY_SHORT_WEIGHT", "1.20"))
    elif length <= 8:
        weight *= float(os.getenv("SURYA_SHORT_WEIGHT", "1.10"))
    if is_onomatopoeia_like(reference):
        weight *= float(os.getenv("SURYA_ONOMATOPOEIA_WEIGHT", "1.12"))
    return min(weight, float(os.getenv("SURYA_MAX_SAMPLE_WEIGHT", "1.50")))


def approximate_vision_tokens(entry) -> int:
    bbox = entry.get("bbox") or []
    if len(bbox) >= 4:
        width = max(int(round(float(bbox[2]))), 1)
        height = max(int(round(float(bbox[3]))), 1)
        pixels = min(max(width * height, MIN_IMAGE_PIXELS), MAX_IMAGE_PIXELS)
        return max(1, math.ceil(pixels / (16 * 16 * 4)))
    return max(1, math.ceil(MIN_IMAGE_PIXELS / (16 * 16 * 4)))


def add_training_metadata(dataset, processor):
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is None:
        return dataset
    template_probe_path = Path("__surya_template_probe__.png")
    empty_full = apply_template(
        processor,
        messages_for_entry(template_probe_path, ""),
        add_generation_prompt=False,
    )
    prompt_only = apply_template(
        processor,
        messages_for_entry(template_probe_path, None),
        add_generation_prompt=True,
    )
    assistant_template_overhead = max(
        len(tokenizer(empty_full, add_special_tokens=False).input_ids)
        - len(tokenizer(prompt_only, add_special_tokens=False).input_ids),
        1,
    )

    def annotate(batch):
        references = [str(value or "") for value in batch.get("text", [])]
        tokenized = tokenizer(
            references,
            add_special_tokens=False,
            padding=False,
            truncation=False,
        )
        bboxes = batch.get("bbox") or [None] * len(references)
        lengths = []
        target_token_lengths = []
        weights = []
        for reference, token_ids, bbox in zip(references, tokenized["input_ids"], bboxes):
            target_token_lengths.append(len(token_ids) + assistant_template_overhead)
            lengths.append(
                96
                + len(token_ids)
                + approximate_vision_tokens({"bbox": bbox})
            )
            weights.append(sample_training_weight(reference))
        return {
            "length": lengths,
            "target_token_length": target_token_lengths,
            "sample_weight": weights,
        }

    return dataset.map(
        annotate,
        batched=True,
        batch_size=512,
        desc="Estimating token lengths and OCR sample weights",
    )


def resolve_image_path(entry, preferred_split=None):
    image_file = entry.get("image_file")
    if not image_file:
        messages = entry.get("messages") or []
        if messages and messages[0].get("content"):
            image_file = messages[0]["content"][0].get("image")
    if not image_file:
        return None

    candidate_splits = []
    if preferred_split:
        candidate_splits.append(preferred_split)
    candidate_splits.extend(split for split in SPLITS if split not in candidate_splits)

    for split_name in candidate_splits:
        candidate = DATASET_DIR / split_name / image_file
        if candidate.exists():
            return candidate
    return None


def extract_reference_text(entry) -> str:
    if entry.get("text") is not None:
        return str(entry.get("text", "")).strip()
    for message in entry.get("messages") or []:
        if message.get("role") != "assistant":
            continue
        for content in message.get("content") or []:
            if "text" in content:
                return str(content["text"]).strip()
    return ""


def messages_for_entry(image_path: Path, reference_text: str = None):
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": str(image_path)},
                {"type": "text", "text": USER_PROMPT},
            ],
        }
    ]
    if reference_text is not None:
        messages.append(
            {
                "role": "assistant",
                "content": [{"type": "text", "text": reference_text}],
            }
        )
    return messages


def apply_template(processor, messages, add_generation_prompt):
    return processor.apply_chat_template(
        messages,
        add_generation_prompt=add_generation_prompt,
        tokenize=False,
    )


class ImageLRUCache:
    def __init__(self, max_items: int):
        self.max_items = max(0, max_items)
        self.items = OrderedDict()

    def get(self, path: Path):
        key = str(path)
        cached = self.items.pop(key, None)
        if cached is not None:
            self.items[key] = cached
            return cached.copy()
        with Image.open(path) as image_file:
            image = image_file.convert("RGB")
        if self.max_items > 0:
            self.items[key] = image.copy()
            while len(self.items) > self.max_items:
                self.items.popitem(last=False)
        return image


class MangaOCRAugmenter:
    """Mild, text-preserving augmentation for clean manga bubble crops."""

    def __init__(self):
        self.enabled = env_bool("SURYA_AUGMENT", True)
        self.probability = float(os.getenv("SURYA_AUGMENT_PROBABILITY", "0.70"))

    def __call__(self, image: Image.Image) -> Image.Image:
        if not self.enabled or random.random() >= self.probability:
            return image
        if random.random() < 0.20:
            image = ImageOps.autocontrast(image, cutoff=random.uniform(0.0, 1.0))
        image = ImageEnhance.Contrast(image).enhance(random.uniform(0.90, 1.12))
        image = ImageEnhance.Brightness(image).enhance(random.uniform(0.95, 1.06))
        if random.random() < 0.35:
            image = ImageEnhance.Sharpness(image).enhance(random.uniform(0.82, 1.18))
        if random.random() < 0.10:
            image = image.filter(ImageFilter.GaussianBlur(radius=random.uniform(0.15, 0.45)))
        if random.random() < 0.15:
            image = image.rotate(
                random.uniform(-1.0, 1.0),
                resample=Image.Resampling.BICUBIC,
                expand=False,
                fillcolor=(255, 255, 255),
            )
        return image


def process_batch(examples, processor, image_cache=None, augmenter=None):
    batch_texts = []
    batch_images = []
    prompt_texts = []

    ids = examples.get("id", [None] * len(examples["image_file"]))
    image_files = examples["image_file"]
    split_names = examples.get("split", [None] * len(image_files))
    references = examples.get("text", [""] * len(image_files))

    for item_id, image_file, split_name, reference in zip(ids, image_files, split_names, references):
        entry = {"id": item_id, "image_file": image_file, "split": split_name}
        image_path = resolve_image_path(entry, split_name)
        if image_path is None:
            raise FileNotFoundError(f"Missing image for sample {item_id}: {image_file}")

        if image_cache is None:
            with Image.open(image_path) as image_file_handle:
                image = image_file_handle.convert("RGB")
        else:
            image = image_cache.get(image_path)
        if augmenter is not None:
            image = augmenter(image)

        full_messages = messages_for_entry(image_path, str(reference))
        prompt_messages = messages_for_entry(image_path, None)
        batch_texts.append(apply_template(processor, full_messages, add_generation_prompt=False))
        prompt_texts.append(apply_template(processor, prompt_messages, add_generation_prompt=True))
        batch_images.append(image)

    model_inputs = processor(
        text=batch_texts,
        images=batch_images,
        padding=True,
        pad_to_multiple_of=int(os.getenv("SURYA_PAD_TO_MULTIPLE_OF", "16")),
        return_tensors="pt",
    )

    labels = model_inputs["input_ids"].clone()
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is None:
        raise RuntimeError("Surya processor has no tokenizer; assistant-only labels cannot be built.")
    pad_token_id = getattr(tokenizer, "pad_token_id", None)
    padding_side = getattr(tokenizer, "padding_side", "right")
    rendered_token_ids = tokenizer(
        batch_texts + prompt_texts,
        add_special_tokens=False,
        padding=False,
        truncation=False,
    )["input_ids"]
    batch_size = len(batch_texts)
    full_text_token_ids = rendered_token_ids[:batch_size]
    prompt_text_token_ids = rendered_token_ids[batch_size:]

    for idx, (full_ids, prompt_ids) in enumerate(zip(full_text_token_ids, prompt_text_token_ids)):
        assistant_len = max(len(full_ids) - len(prompt_ids), 0)
        if assistant_len <= 0:
            raise RuntimeError(
                f"Empty assistant span for sample {ids[idx]}; refusing to train on prompt tokens."
            )

        if padding_side == "left":
            mask_until = labels.shape[1] - assistant_len
            labels[idx, :mask_until] = -100
        else:
            multimodal_length = int(model_inputs["attention_mask"][idx].sum().item())
            labels[idx, : multimodal_length - assistant_len] = -100

        if pad_token_id is not None:
            labels[idx, model_inputs["input_ids"][idx] == pad_token_id] = -100

    model_inputs["labels"] = labels
    weights = examples.get("sample_weight")
    if weights is None or any(weight is None for weight in weights):
        weights = [sample_training_weight(reference) for reference in references]
    model_inputs["sample_weights"] = torch.tensor(weights, dtype=torch.float32)
    return model_inputs


class SuryaBubbleCollator:
    def __init__(self, processor, training=False):
        self.processor = processor
        self.training = training
        self.image_cache = ImageLRUCache(int(os.getenv("SURYA_IMAGE_CACHE_ITEMS", "512")))
        self.augmenter = MangaOCRAugmenter() if training else None

    def __call__(self, features):
        keys = ("id", "image_file", "split", "text", "sample_weight")
        examples = {key: [feature.get(key) for feature in features] for key in keys}
        is_training_batch = self.training and all(
            str(split_name or "train") == "train"
            for split_name in examples["split"]
        )
        return process_batch(
            examples,
            self.processor,
            image_cache=self.image_cache,
            augmenter=self.augmenter if is_training_batch else None,
        )


def postprocess_prediction(text: str) -> str:
    text = str(text or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'", "`"}:
        text = text[1:-1].strip()
    if COLLAPSE_WHITESPACE:
        text = re.sub(r"\s+", " ", text).strip()
    return text


def sample_cer(prediction: str, reference: str) -> float:
    if not reference:
        return 0.0 if not prediction else 1.0
    return levenshtein_distance(prediction, reference) / max(len(reference), 1)


def length_bucket(reference: str) -> str:
    n = len(reference)
    if n == 0:
        return "0"
    if n <= 3:
        return "1-3"
    if n <= 8:
        return "4-8"
    if n <= 20:
        return "9-20"
    if n <= 40:
        return "21-40"
    return "41+"


def compute_text_metrics(samples):
    if not samples:
        return {
            "cer": 1.0,
            "wer": 1.0,
            "exact_match": 0.0,
            "avg_levenshtein": 0.0,
            "blank_rate": 1.0,
            "multiline_rate": 0.0,
            "hallucination_rate": 0.0,
            "token_limit_rate": 0.0,
            "token_limit_count": 0,
            "empty_reference_count": 0,
            "sample_count": 0,
            "error_distribution_by_length": {},
        }

    prepared = []
    for sample in samples:
        reference = str(sample.get("reference", ""))
        prediction = str(sample.get("prediction", ""))
        raw_prediction = str(sample.get("raw_prediction", prediction))
        edit_distance = levenshtein_distance(prediction, reference)
        prepared.append(
            {
                **sample,
                "reference": reference,
                "prediction": prediction,
                "raw_prediction": raw_prediction,
                "levenshtein": edit_distance,
                "cer": sample_cer(prediction, reference),
            }
        )

    references = [sample["reference"] for sample in prepared]
    predictions = [sample["prediction"] for sample in prepared]
    total_edits = sum(sample["levenshtein"] for sample in prepared)
    total_chars = sum(len(reference) for reference in references)
    cer = total_edits / max(total_chars, 1)
    try:
        wer = jiwer.wer(references, predictions)
    except Exception:
        wer = 1.0

    exact_match = sum(1 for pred, ref in zip(predictions, references) if pred == ref) / len(prepared)
    avg_lev = total_edits / len(prepared)
    blank_rate = sum(1 for prediction in predictions if not prediction) / len(prepared)
    multiline_rate = sum(
        1 for sample in prepared if "\n" in sample.get("raw_prediction", "").strip()
    ) / len(prepared)
    empty_refs = [sample for sample in prepared if not sample["reference"]]
    hallucinations = [sample for sample in empty_refs if sample["prediction"]]
    hallucination_rate = len(hallucinations) / len(empty_refs) if empty_refs else 0.0
    token_limit_count = sum(bool(sample.get("hit_token_limit")) for sample in prepared)
    token_limit_rate = token_limit_count / len(prepared)

    by_length = {}
    for bucket in ("0", "1-3", "4-8", "9-20", "21-40", "41+"):
        bucket_samples = [sample for sample in prepared if length_bucket(sample["reference"]) == bucket]
        if not bucket_samples:
            continue
        bucket_chars = sum(len(sample["reference"]) for sample in bucket_samples)
        bucket_edits = sum(sample["levenshtein"] for sample in bucket_samples)
        by_length[bucket] = {
            "count": len(bucket_samples),
            "cer": bucket_edits / max(bucket_chars, 1),
            "exact_match": sum(
                1 for sample in bucket_samples if sample["prediction"] == sample["reference"]
            )
            / len(bucket_samples),
            "avg_levenshtein": bucket_edits / len(bucket_samples),
        }

    return {
        "cer": cer,
        "wer": wer,
        "exact_match": exact_match,
        "avg_levenshtein": avg_lev,
        "blank_rate": blank_rate,
        "multiline_rate": multiline_rate,
        "hallucination_rate": hallucination_rate,
        "token_limit_rate": token_limit_rate,
        "token_limit_count": token_limit_count,
        "empty_reference_count": len(empty_refs),
        "hallucination_count": len(hallucinations),
        "sample_count": len(prepared),
        "error_distribution_by_length": by_length,
    }


def slice_predicates():
    accent_re = re.compile(r"[àâäçéèêëîïôöùûüÿñæœÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÑÆŒ]")
    punctuation_re = re.compile(r"[!?.,;:…\"'()\\-]")
    return {
        "short_len_le_5": lambda sample: 0 < len(sample["reference"]) <= 5,
        "very_short_len_le_2": lambda sample: 0 < len(sample["reference"]) <= 2,
        "has_accents": lambda sample: bool(accent_re.search(sample["reference"])),
        "has_punctuation": lambda sample: bool(punctuation_re.search(sample["reference"])),
        "onomatopoeia_like": lambda sample: bool(
            re.search(r"(.)\1{2,}", sample["reference"], flags=re.IGNORECASE)
            or re.fullmatch(r"[A-ZÀ-Ý!?.\- ]{2,}", sample["reference"] or "")
        ),
        "reference_multiline": lambda sample: "\n" in sample["reference"],
    }


def compute_slice_metrics(samples):
    metrics = {}
    for name, predicate in slice_predicates().items():
        subset = [sample for sample in samples if predicate(sample)]
        if subset:
            metrics[name] = compute_text_metrics(subset)
    return metrics


def model_dtype(model):
    for param in model.parameters():
        if param.is_floating_point():
            return param.dtype
    return torch.float32


def move_inputs_to_device(inputs, device, dtype):
    moved = {}
    for key, value in inputs.items():
        if not hasattr(value, "to"):
            moved[key] = value
        elif value.is_floating_point():
            moved[key] = value.to(device=device, dtype=dtype)
        else:
            moved[key] = value.to(device=device)
    return moved


def decode_tokens(processor, token_ids):
    if hasattr(processor, "decode"):
        return processor.decode(token_ids, skip_special_tokens=True)
    return processor.tokenizer.decode(token_ids, skip_special_tokens=True)


def generation_token_metadata(generated_ids, eos_token_id, pad_token_id):
    if isinstance(eos_token_id, int):
        eos_token_ids = {eos_token_id}
    elif isinstance(eos_token_id, (list, tuple, set)):
        eos_token_ids = {token_id for token_id in eos_token_id if isinstance(token_id, int)}
    else:
        eos_token_ids = set()

    metadata = []
    for row in generated_ids.tolist():
        eos_position = next(
            (index for index, token_id in enumerate(row) if token_id in eos_token_ids),
            None,
        )
        if eos_position is not None:
            generated_tokens = eos_position + 1
            hit_token_limit = False
        else:
            generated_tokens = len(row)
            if isinstance(pad_token_id, int):
                while generated_tokens > 0 and row[generated_tokens - 1] == pad_token_id:
                    generated_tokens -= 1
            hit_token_limit = generated_tokens >= MAX_NEW_TOKENS
        metadata.append(
            {
                "generated_tokens": generated_tokens,
                "hit_token_limit": hit_token_limit,
            }
        )
    return metadata


def generate_predictions(model, processor, entries, return_metadata=False):
    prompts = []
    images = []
    for entry in entries:
        split_name = entry.get("split") or "test"
        image_path = resolve_image_path(entry, split_name)
        if image_path is None:
            raise FileNotFoundError(f"Missing image for sample {entry.get('id')}")
        with Image.open(image_path) as image_file:
            images.append(image_file.convert("RGB"))
        messages = messages_for_entry(image_path, None)
        prompts.append(apply_template(processor, messages, add_generation_prompt=True))

    inputs = processor(
        text=prompts,
        images=images,
        padding=True,
        pad_to_multiple_of=int(os.getenv("SURYA_PAD_TO_MULTIPLE_OF", "16")),
        return_tensors="pt",
    )

    device = next(model.parameters()).device
    dtype = model_dtype(model)
    inputs = move_inputs_to_device(inputs, device, dtype)

    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
        )

    prompt_width = inputs["input_ids"].shape[1]
    generated_ids = output_ids[:, prompt_width:]
    generation_metadata = generation_token_metadata(
        generated_ids,
        getattr(model.generation_config, "eos_token_id", None),
        getattr(model.generation_config, "pad_token_id", None),
    )
    if hasattr(processor, "batch_decode"):
        decoded = processor.batch_decode(generated_ids, skip_special_tokens=True)
    else:
        decoded = processor.tokenizer.batch_decode(generated_ids, skip_special_tokens=True)
    predictions = [text.strip() for text in decoded]
    if return_metadata:
        return predictions, generation_metadata
    return predictions


def generate_prediction(model, processor, entry):
    return generate_predictions(model, processor, [entry])[0]


def benchmark_indices(dataset, max_samples):
    total = len(dataset)
    if max_samples is None or max_samples <= 0 or max_samples >= total:
        return list(range(total))
    rng = random.Random(RANDOM_SEED)
    all_indices = list(range(total))
    rng.shuffle(all_indices)
    strata = {
        "very_short": [],
        "short": [],
        "long": [],
        "accent": [],
        "onomatopoeia": [],
        "multiline": [],
    }
    accent_re = re.compile(r"[àâäçéèêëîïôöùûüÿñæœÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÑÆŒ]")
    for index in all_indices:
        reference = extract_reference_text(dataset[index])
        if len(reference) <= 3:
            strata["very_short"].append(index)
        elif len(reference) <= 8:
            strata["short"].append(index)
        elif len(reference) > 40:
            strata["long"].append(index)
        if accent_re.search(reference):
            strata["accent"].append(index)
        if is_onomatopoeia_like(reference):
            strata["onomatopoeia"].append(index)
        if "\n" in reference:
            strata["multiline"].append(index)

    selected = []
    seen = set()
    quota = max(1, max_samples // (len(strata) * 2))
    for candidates in strata.values():
        for index in candidates[:quota]:
            if index not in seen:
                selected.append(index)
                seen.add(index)
    for index in all_indices:
        if len(selected) >= max_samples:
            break
        if index not in seen:
            selected.append(index)
            seen.add(index)
    return sorted(selected[:max_samples])


def run_generation_benchmark(
    model,
    processor,
    dataset,
    split_name,
    max_samples=None,
    title="GENERATION BENCHMARK",
    worst_count=20,
):
    was_training = model.training
    old_use_cache = getattr(model.config, "use_cache", None)
    if old_use_cache is not None:
        model.config.use_cache = True
    model.eval()

    indices = benchmark_indices(dataset, max_samples)
    samples = []
    print("", flush=True)
    print("=" * 72, flush=True)
    print(f"{title} [{split_name}] - {len(indices)}/{len(dataset)} samples", flush=True)
    print("=" * 72, flush=True)

    generation_batch_size = max(1, GEN_EVAL_BATCH_SIZE)
    for batch_start in range(0, len(indices), generation_batch_size):
        batch_indices = indices[batch_start : batch_start + generation_batch_size]
        entries = [dataset[index] for index in batch_indices]
        raw_predictions, generation_metadata = generate_predictions(
            model,
            processor,
            entries,
            return_metadata=True,
        )
        for dataset_index, entry, raw_prediction, generation_info in zip(
            batch_indices,
            entries,
            raw_predictions,
            generation_metadata,
        ):
            reference = extract_reference_text(entry)
            prediction = postprocess_prediction(raw_prediction)
            samples.append(
                {
                    "dataset_idx": dataset_index,
                    "id": entry.get("id"),
                    "page_id": entry.get("page_id"),
                    "reference": reference,
                    "prediction": prediction,
                    "raw_prediction": raw_prediction,
                    **generation_info,
                    "cer": sample_cer(prediction, reference),
                    "levenshtein": levenshtein_distance(prediction, reference),
                }
            )
        generated_count = min(batch_start + generation_batch_size, len(indices))
        if generated_count % 50 < generation_batch_size or generated_count == len(indices):
            print(f"  generated {generated_count}/{len(indices)}", flush=True)

    metrics = compute_text_metrics(samples)
    ranked = sorted(samples, key=lambda sample: (sample["cer"], sample["levenshtein"]), reverse=True)
    print("-" * 72, flush=True)
    print(f"CER:             {metrics['cer']:.6f} ({metrics['cer'] * 100:.3f}%)", flush=True)
    print(f"WER:             {metrics['wer']:.6f} ({metrics['wer'] * 100:.3f}%)", flush=True)
    print(f"Exact match:     {metrics['exact_match']:.6f}", flush=True)
    print(f"Avg Levenshtein: {metrics['avg_levenshtein']:.4f}", flush=True)
    print(f"Blank rate:      {metrics['blank_rate']:.6f}", flush=True)
    print(f"Multiline rate:  {metrics['multiline_rate']:.6f}", flush=True)
    print(f"Hallucination:   {metrics['hallucination_rate']:.6f}", flush=True)
    print(
        f"Token-limit hit: {metrics['token_limit_rate']:.6f} "
        f"({metrics['token_limit_count']}/{metrics['sample_count']})",
        flush=True,
    )
    print("-" * 72, flush=True)
    for rank, sample in enumerate(ranked[: min(worst_count, len(ranked))], 1):
        token_limit_suffix = (
            f" TOKEN_LIMIT={sample['generated_tokens']}/{MAX_NEW_TOKENS}"
            if sample.get("hit_token_limit")
            else ""
        )
        print(
            f"#{rank} idx={sample['dataset_idx']} id={sample['id']} "
            f"page={sample['page_id']} CER={sample['cer']:.4f} "
            f"Lev={sample['levenshtein']}{token_limit_suffix}",
            flush=True,
        )
        print(f"  REF:  {sample['reference']}", flush=True)
        print(f"  PRED: {sample['prediction']}", flush=True)
    print("=" * 72, flush=True)

    if old_use_cache is not None:
        model.config.use_cache = old_use_cache
    if was_training:
        model.train()
    return metrics, samples


class SuryaOCRTrainer(Seq2SeqTrainer):
    def __init__(
        self,
        *args,
        processor=None,
        gen_eval_max_samples=256,
        generation_early_stopping_patience=0,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.processor = processor
        self.gen_eval_max_samples = gen_eval_max_samples
        self.generation_early_stopping_patience = generation_early_stopping_patience
        self.generation_early_stopping_threshold = float(
            os.getenv("SURYA_EARLY_STOPPING_THRESHOLD", "0.0")
        )
        self._best_generation_cer = None
        self._generation_bad_eval_count = 0
        self.model_accepts_loss_kwargs = False

    def update_generation_early_stopping(self, cer):
        if self.generation_early_stopping_patience <= 0:
            return
        if self._best_generation_cer is None:
            previous_best = getattr(self.state, "best_metric", None)
            if isinstance(previous_best, (int, float)):
                self._best_generation_cer = float(previous_best)

        improved = (
            self._best_generation_cer is None
            or cer
            < self._best_generation_cer
            - self.generation_early_stopping_threshold
        )
        if improved:
            self._best_generation_cer = cer
            self._generation_bad_eval_count = 0
        else:
            self._generation_bad_eval_count += 1

        print(
            "Generation CER early stopping: "
            f"best={self._best_generation_cer:.6f}, current={cer:.6f}, "
            f"non_improving={self._generation_bad_eval_count}/"
            f"{self.generation_early_stopping_patience}",
            flush=True,
        )
        if (
            self._generation_bad_eval_count
            >= self.generation_early_stopping_patience
        ):
            self.control.should_training_stop = True
            print("Generation CER early stopping requested.", flush=True)

    def compute_loss(
        self,
        model,
        inputs,
        return_outputs=False,
        num_items_in_batch=None,
    ):
        del num_items_in_batch
        inputs = dict(inputs)
        labels = inputs.pop("labels")
        sample_weights = inputs.pop("sample_weights", None)

        # The OCR answer is a short suffix. Computing the 65k-vocabulary LM head
        # over image and prompt tokens wastes a large amount of GEMM work and VRAM.
        assistant_lengths = labels.ne(-100).sum(dim=1)
        if int(assistant_lengths.min().item()) <= 0:
            raise RuntimeError("A training sample contains no supervised assistant token.")
        logits_to_keep = min(labels.shape[1], int(assistant_lengths.max().item()) + 1)
        outputs = model(**inputs, logits_to_keep=logits_to_keep)

        shift_logits = outputs.logits[:, :-1, :].contiguous()
        shift_labels = labels[:, -(logits_to_keep - 1) :].contiguous()
        valid_tokens = shift_labels.ne(-100)
        token_losses = F.cross_entropy(
            shift_logits.float().view(-1, shift_logits.shape[-1]),
            shift_labels.view(-1),
            ignore_index=-100,
            reduction="none",
        ).view_as(shift_labels)
        per_sample_loss = token_losses.sum(dim=1) / valid_tokens.sum(dim=1).clamp_min(1)

        if sample_weights is None:
            loss = per_sample_loss.mean()
        else:
            sample_weights = sample_weights.to(
                device=per_sample_loss.device,
                dtype=per_sample_loss.dtype,
            )
            loss = (per_sample_loss * sample_weights).sum() / sample_weights.sum().clamp_min(1e-6)
        return (loss, outputs) if return_outputs else loss

    def create_optimizer(self, model=None):
        if self.optimizer is not None:
            return self.optimizer
        opt_model = self.model if model is None else model
        decay_parameters = set(self.get_decay_parameter_names(opt_model))
        vision_lr_multiplier = float(os.getenv("SURYA_VISION_LR_MULTIPLIER", "0.25"))
        merger_lr_multiplier = float(os.getenv("SURYA_MERGER_LR_MULTIPLIER", "0.50"))
        grouped = {}

        for name, parameter in opt_model.named_parameters():
            if not parameter.requires_grad:
                continue
            if ".visual.merger." in name:
                lr_multiplier = merger_lr_multiplier
            elif ".visual.blocks." in name or name.startswith("model.visual.blocks."):
                lr_multiplier = vision_lr_multiplier
            else:
                lr_multiplier = 1.0
            weight_decay = self.args.weight_decay if name in decay_parameters else 0.0
            key = (lr_multiplier, weight_decay)
            grouped.setdefault(key, []).append(parameter)

        optimizer_groups = [
            {
                "params": parameters,
                "lr": self.args.learning_rate * lr_multiplier,
                "weight_decay": weight_decay,
            }
            for (lr_multiplier, weight_decay), parameters in grouped.items()
        ]
        optimizer_cls, optimizer_kwargs = Trainer.get_optimizer_cls_and_kwargs(
            self.args,
            opt_model,
        )
        unsupported = {"params", "model", "optimizer_dict"}.intersection(optimizer_kwargs)
        if unsupported:
            raise RuntimeError(
                "Differential OCR learning rates are incompatible with optimizer kwargs: "
                + ", ".join(sorted(unsupported))
            )
        self.optimizer = optimizer_cls(optimizer_groups, **optimizer_kwargs)
        summary = [
            {
                "lr": group["lr"],
                "weight_decay": group["weight_decay"],
                "parameters": sum(parameter.numel() for parameter in group["params"]),
            }
            for group in optimizer_groups
        ]
        print("Optimizer parameter groups: " + json.dumps(summary), flush=True)
        return self.optimizer

    def evaluate(self, eval_dataset=None, ignore_keys=None, metric_key_prefix="eval"):
        metrics = super().evaluate(
            eval_dataset=eval_dataset,
            ignore_keys=ignore_keys,
            metric_key_prefix=metric_key_prefix,
        )
        dataset = eval_dataset if eval_dataset is not None else self.eval_dataset
        if dataset is None or self.gen_eval_max_samples == 0:
            return metrics
        split_name = "val"
        try:
            split_name = dataset[0].get("split") or split_name
        except Exception:
            pass
        gen_metrics, _samples = run_generation_benchmark(
            self.model,
            self.processor,
            dataset,
            split_name=split_name,
            max_samples=self.gen_eval_max_samples,
            title="PROMPT-ONLY VALIDATION",
            worst_count=5,
        )
        prefixed = {
            f"{metric_key_prefix}_{key}": value
            for key, value in gen_metrics.items()
            if isinstance(value, (int, float))
        }
        metrics.update(prefixed)
        self.log(prefixed)
        self.update_generation_early_stopping(gen_metrics["cer"])
        return metrics


class LiveMetricsCallback(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        if not logs:
            return
        keys = (
            "loss",
            "learning_rate",
            "eval_loss",
            "eval_cer",
            "eval_wer",
            "eval_exact_match",
            "eval_blank_rate",
            "eval_multiline_rate",
            "eval_hallucination_rate",
            "eval_token_limit_rate",
        )
        parts = [f"step={state.global_step}"]
        for key in keys:
            if key in logs:
                value = logs[key]
                parts.append(f"{key}={value:.6f}" if isinstance(value, float) else f"{key}={value}")
        print("[LIVE] " + " | ".join(parts), flush=True)


def find_best_checkpoint(output_dir):
    output_dir = Path(output_dir)
    state_files = [output_dir / "trainer_state.json"]
    state_files.extend(
        Path(path) / "trainer_state.json" for path in glob.glob(str(output_dir / "checkpoint-*"))
    )
    for state_file in sorted(
        state_files,
        key=lambda path: path.stat().st_mtime if path.exists() else 0,
        reverse=True,
    ):
        if not state_file.exists():
            continue
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state = json.load(f)
            best = state.get("best_model_checkpoint")
            if best and Path(best).exists():
                return best
        except Exception:
            continue

    checkpoints = sorted(glob.glob(str(output_dir / "checkpoint-*")), key=os.path.getmtime)
    return checkpoints[-1] if checkpoints else None


def load_benchmark_samples(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    samples = payload.get("samples") or payload.get("errors") or []
    normalized = []
    for sample in samples:
        reference = sample.get("reference") or sample.get("text") or sample.get("expected") or ""
        prediction = sample.get("prediction") or sample.get("pred") or sample.get("output") or ""
        normalized.append(
            {
                "id": str(sample.get("id") or sample.get("bubble_id") or ""),
                "page_id": sample.get("page_id"),
                "reference": str(reference),
                "prediction": postprocess_prediction(prediction),
                "raw_prediction": str(sample.get("raw_prediction") or prediction),
            }
        )
    return payload.get("metrics") or {}, normalized


def default_baseline_paths():
    candidates = []
    for env_name in ("SURYA_LIGHTON_BENCHMARK_PATH",):
        value = os.getenv(env_name)
        if value:
            candidates.append(Path(value))
    candidates.extend(
        [
            DOCKER_SCRIPTS_DIR
            / "finetune_lighton_ocr"
            / "outputs_lighton_manga"
            / "final_lora_merged"
            / "benchmark_test.json",
        ]
    )
    seen = set()
    unique = []
    for path in candidates:
        key = str(path.resolve()) if path.exists() else str(path)
        if key not in seen:
            unique.append(path)
            seen.add(key)
    return unique


def compare_with_baselines(current_samples):
    comparisons = []
    current_by_id = {str(sample.get("id")): sample for sample in current_samples if sample.get("id")}
    for path in default_baseline_paths():
        if not path.exists():
            continue
        try:
            metrics, baseline_samples = load_benchmark_samples(path)
            comparison = {
                "path": str(path),
                "metrics": metrics,
            }
            baseline_by_id = {
                str(sample.get("id")): sample for sample in baseline_samples if sample.get("id")
            }
            shared_ids = sorted(set(current_by_id) & set(baseline_by_id))
            if shared_ids:
                aligned = []
                for sample_id in shared_ids:
                    baseline = baseline_by_id[sample_id]
                    aligned.append(
                        {
                            "id": sample_id,
                            "page_id": current_by_id[sample_id].get("page_id"),
                            "reference": current_by_id[sample_id]["reference"],
                            "prediction": baseline["prediction"],
                            "raw_prediction": baseline.get("raw_prediction", baseline["prediction"]),
                        }
                    )
                comparison["shared_sample_count"] = len(aligned)
                comparison["shared_sample_metrics"] = compute_text_metrics(aligned)
                comparison["shared_slice_metrics"] = compute_slice_metrics(aligned)
            comparisons.append(comparison)
        except Exception as exc:
            comparisons.append({"path": str(path), "error": str(exc)})
    return comparisons


def save_benchmark(path, metrics, samples):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ranked = sorted(samples, key=lambda sample: (sample["cer"], sample["levenshtein"]), reverse=True)
    payload = {
        "model_id": MODEL_ID,
        "prompt": USER_PROMPT,
        "max_new_tokens": MAX_NEW_TOKENS,
        "postprocess": {
            "collapse_whitespace": COLLAPSE_WHITESPACE,
        },
        "metrics": metrics,
        "slice_metrics": compute_slice_metrics(samples),
        "baseline_comparisons": compare_with_baselines(samples),
        "top_20_worst_errors": ranked[:20],
        "samples": samples,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Benchmark saved to {path}", flush=True)


def configure_processor(model_id_or_path=MODEL_ID):
    print(f"Loading processor: {model_id_or_path}", flush=True)
    processor = AutoProcessor.from_pretrained(model_id_or_path, trust_remote_code=True)
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is not None:
        tokenizer.padding_side = "left"
        if not valid_token_id(getattr(tokenizer, "eos_token_id", None), tokenizer):
            im_end_token_id = tokenizer.convert_tokens_to_ids("<|im_end|>")
            if not valid_token_id(im_end_token_id, tokenizer):
                raise RuntimeError("Unable to recover a valid Surya <|im_end|> EOS token.")
            tokenizer.eos_token_id = im_end_token_id
        if not valid_token_id(getattr(tokenizer, "pad_token_id", None), tokenizer):
            end_of_text_id = tokenizer.convert_tokens_to_ids("<|endoftext|>")
            tokenizer.pad_token_id = (
                end_of_text_id
                if valid_token_id(end_of_text_id, tokenizer)
                else tokenizer.eos_token_id
            )
    image_processor = getattr(processor, "image_processor", None)
    if image_processor is not None:
        if hasattr(image_processor, "default_to_square"):
            image_processor.default_to_square = False
        size = getattr(image_processor, "size", None)
        if hasattr(size, "shortest_edge"):
            size.shortest_edge = MIN_IMAGE_PIXELS
            size.longest_edge = MAX_IMAGE_PIXELS
        elif isinstance(size, dict):
            size["shortest_edge"] = MIN_IMAGE_PIXELS
            size["longest_edge"] = MAX_IMAGE_PIXELS
        print(
            f"Image pixel budget: min={MIN_IMAGE_PIXELS}, max={MAX_IMAGE_PIXELS}",
            flush=True,
        )
    return processor


def valid_token_id(token_id, tokenizer) -> bool:
    if token_id is None or tokenizer is None:
        return False
    try:
        token_count = len(tokenizer)
    except Exception:
        return isinstance(token_id, int)
    if isinstance(token_id, int):
        return 0 <= token_id < token_count
    if isinstance(token_id, (list, tuple)):
        return all(isinstance(item, int) and 0 <= item < token_count for item in token_id)
    return False


def configure_generation(model, processor=None):
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = True
    model.generation_config.do_sample = False
    model.generation_config.max_new_tokens = MAX_NEW_TOKENS
    model.generation_config.temperature = None
    model.generation_config.top_p = None
    model.generation_config.top_k = None

    tokenizer = getattr(processor, "tokenizer", None) if processor is not None else None
    if tokenizer is None:
        return

    eos_token_id = getattr(tokenizer, "eos_token_id", None)
    pad_token_id = getattr(tokenizer, "pad_token_id", None)
    if valid_token_id(eos_token_id, tokenizer):
        model.generation_config.eos_token_id = eos_token_id
        if hasattr(model.config, "eos_token_id"):
            model.config.eos_token_id = eos_token_id
    if valid_token_id(pad_token_id, tokenizer):
        model.generation_config.pad_token_id = pad_token_id
        if hasattr(model.config, "pad_token_id"):
            model.config.pad_token_id = pad_token_id


def load_model(model_id_or_path=MODEL_ID):
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading model: {model_id_or_path} ({dtype}, device={device})", flush=True)
    kwargs = {
        "dtype": dtype,
        "trust_remote_code": True,
        "low_cpu_mem_usage": True,
    }
    attn_impl = os.getenv("SURYA_ATTN_IMPLEMENTATION", "sdpa").strip()
    if attn_impl:
        kwargs["attn_implementation"] = attn_impl
    if device == "cuda":
        kwargs["device_map"] = {"": "cuda:0"}
    model = AutoModelForImageTextToText.from_pretrained(model_id_or_path, **kwargs)
    if device != "cuda":
        model.to(device)
    configure_generation(model)
    return model


def package_version(package_name: str):
    try:
        return importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        return None


def resolve_resume_checkpoint():
    configured = os.getenv("SURYA_RESUME_FROM_CHECKPOINT", "auto").strip()
    if configured.lower() in {"", "0", "false", "no", "off", "none"}:
        return None
    if configured.lower() != "auto":
        checkpoint = Path(configured)
        if not checkpoint.exists():
            raise FileNotFoundError(
                f"SURYA_RESUME_FROM_CHECKPOINT does not exist: {checkpoint}"
            )
        return str(checkpoint)
    if not OUTPUT_DIR.exists():
        return None
    return get_last_checkpoint(str(OUTPUT_DIR))


def validate_training_runtime(require_fast_path=None):
    if require_fast_path is None:
        require_fast_path = env_bool("SURYA_REQUIRE_FAST_LINEAR_ATTENTION", False)

    cuda_available = torch.cuda.is_available()
    profile = {
        "torch": torch.__version__,
        "cuda_runtime": torch.version.cuda,
        "transformers": package_version("transformers"),
        "peft": package_version("peft"),
        "flash_linear_attention": package_version("flash-linear-attention"),
        "causal_conv1d": package_version("causal-conv1d"),
        "cuda_available": cuda_available,
    }
    fast_path_available = False
    if cuda_available:
        capability = torch.cuda.get_device_capability(0)
        capability_string = f"{capability[0]}.{capability[1]}"
        profile.update(
            {
                "gpu": torch.cuda.get_device_name(0),
                "compute_capability": capability_string,
                "vram_gib": round(
                    torch.cuda.get_device_properties(0).total_memory / (1024**3),
                    2,
                ),
                "bf16_supported": torch.cuda.is_bf16_supported(),
            }
        )
        try:
            from transformers.models.qwen3_5 import modeling_qwen3_5

            fast_path_available = bool(modeling_qwen3_5.is_fast_path_available)
        except Exception as exc:
            profile["fast_path_probe_error"] = str(exc)
        expected_capability = os.getenv("SURYA_EXPECTED_COMPUTE_CAPABILITY", "").strip()
        if expected_capability and capability_string != expected_capability:
            profile["expected_compute_capability"] = expected_capability
    profile["qwen35_fast_linear_attention"] = fast_path_available
    print("Training runtime profile:", flush=True)
    print(json.dumps(profile, ensure_ascii=False, indent=2), flush=True)

    if require_fast_path and not cuda_available:
        raise RuntimeError(
            f"CUDA is unavailable in PyTorch {torch.__version__} "
            f"(container CUDA runtime: {torch.version.cuda}). The NVIDIA driver is "
            "missing or too old for this container runtime. On RunPod, select a host "
            "whose driver supports the image CUDA runtime, or rebuild the image on the "
            "CUDA 12.8 compatibility profile. Refusing CPU training."
        )
    expected_capability = os.getenv("SURYA_EXPECTED_COMPUTE_CAPABILITY", "").strip()
    if (
        require_fast_path
        and expected_capability
        and profile.get("compute_capability") != expected_capability
    ):
        raise RuntimeError(
            f"This image was compiled for compute capability {expected_capability}, "
            f"but the selected GPU reports {profile.get('compute_capability')}. "
            "Use the RTX 3090 image on an Ampere SM86 GPU."
        )
    if require_fast_path and not fast_path_available:
        raise RuntimeError(
            "Qwen3.5 fast Gated DeltaNet kernels are unavailable. "
            "Install both flash-linear-attention and causal-conv1d; refusing the slow "
            "PyTorch reference path because SURYA_REQUIRE_FAST_LINEAR_ATTENTION=1."
        )
    if torch.cuda.is_available() and not fast_path_available:
        print(
            "WARNING: Qwen3.5 is using the slow Gated DeltaNet reference path. "
            "This is acceptable for CPU-oriented validation, not for the RTX 3090 training image.",
            flush=True,
        )
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_DIR / "training_runtime_profile.json", "w", encoding="utf-8") as handle:
        json.dump(profile, handle, ensure_ascii=False, indent=2)
    return profile


def build_lora_config():
    from peft import LoraConfig

    lora_r = int(os.getenv("SURYA_LORA_R", "64"))
    lora_alpha = int(os.getenv("SURYA_LORA_ALPHA", str(lora_r * 2)))
    target_modules = [
        item.strip()
        for item in os.getenv(
            "SURYA_LORA_TARGET_MODULES",
            "q_proj,k_proj,v_proj,o_proj,in_proj_qkv,in_proj_z,in_proj_b,"
            "in_proj_a,out_proj,gate_proj,up_proj,down_proj",
        ).split(",")
        if item.strip()
    ]
    return LoraConfig(
        r=lora_r,
        lora_alpha=lora_alpha,
        lora_dropout=float(os.getenv("SURYA_LORA_DROPOUT", "0.0")),
        use_dora=env_bool("SURYA_USE_DORA", False),
        use_rslora=env_bool("SURYA_USE_RSLORA", True),
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )


def configure_trainable_model(model):
    train_mode = os.getenv("SURYA_TRAIN_MODE", "hybrid").strip().lower()
    if train_mode == "full":
        print("Training mode: full fine-tuning", flush=True)
        for parameter in model.parameters():
            parameter.requires_grad = True
        return model, "full"
    if train_mode == "hybrid":
        print(
            "Training mode: full language model + merger + upper vision blocks",
            flush=True,
        )
        for parameter in model.parameters():
            parameter.requires_grad = False
        for parameter in model.model.language_model.parameters():
            parameter.requires_grad = True
        for parameter in model.lm_head.parameters():
            parameter.requires_grad = True
        for parameter in model.model.visual.merger.parameters():
            parameter.requires_grad = True
        vision_blocks = model.model.visual.blocks
        requested_blocks = int(os.getenv("SURYA_VISION_TRAIN_LAST_BLOCKS", "4"))
        trained_blocks = min(max(requested_blocks, 0), len(vision_blocks))
        if trained_blocks > 0:
            for block in vision_blocks[len(vision_blocks) - trained_blocks :]:
                for parameter in block.parameters():
                    parameter.requires_grad = True
        trainable = sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)
        total = sum(parameter.numel() for parameter in model.parameters())
        print(
            f"Trainable: {trainable:,}/{total:,} parameters "
            f"({100 * trainable / total:.2f}%), upper vision blocks={trained_blocks}",
            flush=True,
        )
        return model, "hybrid"
    if train_mode != "lora":
        raise ValueError("SURYA_TRAIN_MODE must be one of: hybrid, full, lora.")

    try:
        from peft import get_peft_model

        print("Training mode: rsLoRA over full-attention, DeltaNet and MLP projections", flush=True)
        model = get_peft_model(model, build_lora_config())
        if hasattr(model, "enable_input_require_grads"):
            model.enable_input_require_grads()
        model.print_trainable_parameters()
        return model, "lora"
    except Exception as exc:
        if not env_bool("SURYA_ALLOW_FULL_FALLBACK", False):
            raise
        print(f"LoRA setup failed, falling back to full fine-tuning: {exc}", flush=True)
        for parameter in model.parameters():
            parameter.requires_grad = True
        return model, "full_fallback"


def make_training_args(smoke_steps: int = 0):
    # The processor is already fast enough to prepare a batch while the 3090 is
    # busy. More importantly, forking workers after CUDA/Triton initialization
    # can leave every worker waiting on an inherited lock before batch zero.
    dataloader_workers = int(os.getenv("SURYA_DATALOADER_WORKERS", "0"))
    eval_strategy = os.getenv("SURYA_EVAL_STRATEGY", "epoch").strip().lower()
    compile_enabled = env_bool("SURYA_TORCH_COMPILE", False)
    kwargs = {
        "output_dir": str(OUTPUT_DIR),
        "learning_rate": float(os.getenv("SURYA_LR", "1.2e-5")),
        "num_train_epochs": float(os.getenv("SURYA_EPOCHS", "5")),
        "per_device_train_batch_size": int(os.getenv("SURYA_TRAIN_BATCH", "16")),
        "per_device_eval_batch_size": int(os.getenv("SURYA_EVAL_BATCH", "16")),
        "gradient_accumulation_steps": int(os.getenv("SURYA_GRAD_ACCUM", "2")),
        "gradient_checkpointing": env_bool("SURYA_GRADIENT_CHECKPOINTING", False),
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "auto_find_batch_size": env_bool("SURYA_AUTO_FIND_BATCH_SIZE", False),
        "optim": os.getenv(
            "SURYA_OPTIM",
            "adamw_torch_fused" if torch.cuda.is_available() else "adamw_torch",
        ),
        "bf16": torch.cuda.is_available(),
        "bf16_full_eval": torch.cuda.is_available(),
        "fp16": False,
        "tf32": torch.cuda.is_available(),
        "logging_steps": int(os.getenv("SURYA_LOGGING_STEPS", "5")),
        "eval_strategy": eval_strategy,
        "save_strategy": eval_strategy,
        "save_total_limit": int(os.getenv("SURYA_SAVE_TOTAL_LIMIT", "2")),
        "load_best_model_at_end": True,
        "metric_for_best_model": "eval_cer",
        "greater_is_better": False,
        "remove_unused_columns": False,
        "report_to": os.getenv("SURYA_REPORT_TO", "none"),
        "predict_with_generate": False,
        "dataloader_num_workers": dataloader_workers,
        "dataloader_pin_memory": torch.cuda.is_available(),
        "dataloader_persistent_workers": dataloader_workers > 0,
        "dataloader_prefetch_factor": (
            int(os.getenv("SURYA_DATALOADER_PREFETCH_FACTOR", "4"))
            if dataloader_workers > 0
            else None
        ),
        "torch_compile": compile_enabled,
        "lr_scheduler_type": os.getenv("SURYA_LR_SCHEDULER", "cosine_with_min_lr"),
        "lr_scheduler_kwargs": {
            "min_lr_rate": float(os.getenv("SURYA_MIN_LR_RATE", "0.10"))
        },
        "warmup_steps": int(os.getenv("SURYA_WARMUP_STEPS", "80")),
        "weight_decay": float(os.getenv("SURYA_WEIGHT_DECAY", "0.05")),
        "max_grad_norm": float(os.getenv("SURYA_MAX_GRAD_NORM", "1.0")),
        "eval_accumulation_steps": 1,
        # A baseline generation benchmark can take several minutes while the
        # training progress bar remains at 0%. Epoch validation and the final
        # held-out benchmark still run normally.
        "eval_on_start": env_bool("SURYA_EVAL_ON_START", False),
        "include_num_input_tokens_seen": "all",
        "seed": RANDOM_SEED,
        "data_seed": RANDOM_SEED,
    }
    if compile_enabled:
        kwargs["torch_compile_backend"] = os.getenv(
            "SURYA_TORCH_COMPILE_BACKEND",
            "inductor",
        )
        kwargs["torch_compile_mode"] = os.getenv("SURYA_TORCH_COMPILE_MODE", "default")
    if eval_strategy == "steps":
        eval_steps = int(os.getenv("SURYA_EVAL_STEPS", "250"))
        kwargs["eval_steps"] = eval_steps
        kwargs["save_steps"] = eval_steps
    if smoke_steps > 0:
        kwargs.update(
            {
                "max_steps": smoke_steps,
                "eval_strategy": "no",
                "save_strategy": "no",
                "load_best_model_at_end": False,
                "eval_on_start": False,
            }
        )
    fields = Seq2SeqTrainingArguments.__dataclass_fields__
    if "train_sampling_strategy" in fields:
        kwargs["train_sampling_strategy"] = "group_by_length"
    elif "group_by_length" in fields:
        kwargs["group_by_length"] = True
    kwargs["length_column_name"] = "length"
    kwargs = {key: value for key, value in kwargs.items() if key in fields}
    try:
        return Seq2SeqTrainingArguments(**kwargs)
    except TypeError as exc:
        if "eval_strategy" not in str(exc):
            raise
        kwargs["evaluation_strategy"] = kwargs.pop("eval_strategy")
        return Seq2SeqTrainingArguments(**kwargs)


def merge_and_save(model, processor, train_mode: str):
    print("Saving final model...", flush=True)
    if train_mode.startswith("lora"):
        print("Merging LoRA weights into the base model...", flush=True)
        model = model.merge_and_unload()
    configure_generation(model, processor)
    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(FINAL_DIR)
    processor.save_pretrained(FINAL_DIR)
    print(f"Final model saved to {FINAL_DIR}", flush=True)
    return model


def benchmark_existing_model(model_path: str):
    processor = configure_processor(model_path)
    model = load_model(model_path).eval()
    configure_generation(model, processor)
    test_dataset = prepare_dataset(TEST_FILE, "test", processor)
    metrics, samples = run_generation_benchmark(
        model,
        processor,
        test_dataset,
        split_name="test",
        max_samples=FINAL_TEST_MAX_SAMPLES or None,
        title="FINAL TEST BENCHMARK",
        worst_count=20,
    )
    save_benchmark(Path(model_path) / "benchmark_test.json", metrics, samples)


def main():
    args = parse_args()
    configure_torch_runtime()
    set_seed(RANDOM_SEED)

    if args.benchmark_only:
        benchmark_existing_model(args.model_path or str(FINAL_DIR))
        return

    processor = configure_processor()
    validate_training_runtime()
    model = load_model()
    configure_generation(model, processor)

    if args.merge_only:
        from peft import PeftModel

        checkpoint = args.model_path or find_best_checkpoint(OUTPUT_DIR)
        if not checkpoint:
            raise RuntimeError("No LoRA checkpoint found to merge.")
        print(f"Loading LoRA checkpoint: {checkpoint}", flush=True)
        model = PeftModel.from_pretrained(model, checkpoint)
        merge_and_save(model, processor, "lora")
        return

    train_dataset = prepare_dataset(TRAIN_FILE, "train", processor)
    val_dataset = prepare_dataset(VAL_FILE, "val", processor)
    test_dataset = prepare_dataset(TEST_FILE, "test", processor)

    model, train_mode = configure_trainable_model(model)
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = False

    data_collator = SuryaBubbleCollator(processor, training=True)
    training_args = make_training_args(args.train_smoke_steps)
    if args.validate_setup:
        sample_count = min(training_args.per_device_train_batch_size, len(train_dataset))
        if sample_count <= 0:
            raise RuntimeError("The training dataset is empty.")
        smoke_loader = torch.utils.data.DataLoader(
            train_dataset,
            batch_size=sample_count,
            shuffle=False,
            collate_fn=data_collator,
            num_workers=training_args.dataloader_num_workers,
            pin_memory=training_args.dataloader_pin_memory,
            persistent_workers=training_args.dataloader_persistent_workers,
            prefetch_factor=training_args.dataloader_prefetch_factor,
        )
        started_at = time.perf_counter()
        batch = next(iter(smoke_loader))
        first_batch_seconds = time.perf_counter() - started_at
        supervised = batch["labels"].ne(-100).sum(dim=1).tolist()
        print(
            "Setup validation passed: "
            f"batch={sample_count}, input_shape={tuple(batch['input_ids'].shape)}, "
            f"supervised_tokens={supervised}, train_mode={train_mode}, "
            f"dataloader_workers={training_args.dataloader_num_workers}, "
            f"first_batch_seconds={first_batch_seconds:.3f}",
            flush=True,
        )
        return

    callbacks = [LiveMetricsCallback()]
    patience = int(os.getenv("SURYA_EARLY_STOPPING_PATIENCE", "2"))

    trainer = SuryaOCRTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        data_collator=data_collator,
        callbacks=callbacks,
        processor=processor,
        gen_eval_max_samples=GEN_EVAL_MAX_SAMPLES,
        generation_early_stopping_patience=(
            patience if args.train_smoke_steps <= 0 else 0
        ),
    )

    print(
        "Starting Surya bubble OCR fine-tuning...\n"
        "Data path: "
        f"workers={training_args.dataloader_num_workers}, "
        f"persistent_workers={training_args.dataloader_persistent_workers}, "
        f"prefetch_factor={training_args.dataloader_prefetch_factor}, "
        f"eval_on_start={training_args.eval_on_start}\n"
        "Cold start: the first optimizer step compiles CUDA/Triton kernels once "
        "(about 60 seconds with an empty cache, about 5 seconds after a restart); "
        "later steps are expected around 2.5 seconds.",
        flush=True,
    )
    resume_checkpoint = (
        None if args.train_smoke_steps > 0 else resolve_resume_checkpoint()
    )
    if resume_checkpoint:
        print(f"Resuming training from checkpoint: {resume_checkpoint}", flush=True)
    trainer.train(resume_from_checkpoint=resume_checkpoint)
    if args.train_smoke_steps > 0:
        print(
            f"Training smoke test passed: {trainer.state.global_step} real step(s) completed.",
            flush=True,
        )
        return
    print(f"Best checkpoint: {trainer.state.best_model_checkpoint or find_best_checkpoint(OUTPUT_DIR)}", flush=True)

    final_model = merge_and_save(trainer.model, processor, train_mode)
    print("Running held-out test benchmark...", flush=True)
    metrics, samples = run_generation_benchmark(
        final_model,
        processor,
        test_dataset,
        split_name="test",
        max_samples=FINAL_TEST_MAX_SAMPLES or None,
        title="FINAL TEST BENCHMARK",
        worst_count=20,
    )
    save_benchmark(FINAL_DIR / "benchmark_test.json", metrics, samples)


if __name__ == "__main__":
    main()
