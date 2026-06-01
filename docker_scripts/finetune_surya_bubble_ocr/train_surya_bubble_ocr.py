import argparse
import glob
import json
import os
import random
import re
import sys
from pathlib import Path

import jiwer
import numpy as np
import torch
from datasets import load_dataset
from dotenv import load_dotenv
from Levenshtein import distance as levenshtein_distance
from PIL import Image
from transformers import (
    AutoModelForImageTextToText,
    AutoProcessor,
    EarlyStoppingCallback,
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    TrainerCallback,
)


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
MAX_NEW_TOKENS = int(os.getenv("SURYA_MAX_NEW_TOKENS", "96"))
GEN_EVAL_MAX_SAMPLES = int(os.getenv("SURYA_GEN_EVAL_MAX_SAMPLES", "256"))
FINAL_TEST_MAX_SAMPLES = int(os.getenv("SURYA_FINAL_TEST_MAX_SAMPLES", "0"))
RANDOM_SEED = int(os.getenv("SURYA_RANDOM_SEED", "42"))
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
    parser.add_argument("--model-path", default=None, help="Model path for merge-only or benchmark-only.")
    return parser.parse_args()


def configure_torch_runtime() -> None:
    torch.set_num_threads(int(os.getenv("SURYA_TORCH_THREADS", "8")))
    if torch.cuda.is_available():
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        try:
            torch.set_float32_matmul_precision("high")
        except Exception:
            pass
    if hasattr(torch, "_dynamo"):
        torch._dynamo.config.suppress_errors = True


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def prepare_dataset(file_path: Path, split_name: str):
    if not file_path.exists():
        raise FileNotFoundError(f"Missing dataset file: {file_path}")
    print(f"Loading {split_name} dataset from {file_path}", flush=True)
    dataset = load_dataset("json", data_files=str(file_path), split="train")
    if "split" not in dataset.column_names:
        dataset = dataset.map(lambda _: {"split": split_name})
    print(f"  {split_name}: {len(dataset)} samples", flush=True)
    return dataset


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


def process_batch(examples, processor):
    batch_texts = []
    batch_images = []
    prompt_texts = []
    per_example_images = []

    ids = examples.get("id", [None] * len(examples["image_file"]))
    image_files = examples["image_file"]
    split_names = examples.get("split", [None] * len(image_files))
    references = examples.get("text", [""] * len(image_files))

    for item_id, image_file, split_name, reference in zip(ids, image_files, split_names, references):
        entry = {"id": item_id, "image_file": image_file, "split": split_name}
        image_path = resolve_image_path(entry, split_name)
        if image_path is None:
            raise FileNotFoundError(f"Missing image for sample {item_id}: {image_file}")

        with Image.open(image_path) as img:
            image = img.convert("RGB")

        full_messages = messages_for_entry(image_path, str(reference))
        prompt_messages = messages_for_entry(image_path, None)
        batch_texts.append(apply_template(processor, full_messages, add_generation_prompt=False))
        prompt_texts.append(apply_template(processor, prompt_messages, add_generation_prompt=True))
        batch_images.append(image)
        per_example_images.append(image)

    model_inputs = processor(
        text=batch_texts,
        images=batch_images,
        padding=True,
        return_tensors="pt",
    )

    labels = model_inputs["input_ids"].clone()
    tokenizer = getattr(processor, "tokenizer", None)
    pad_token_id = getattr(tokenizer, "pad_token_id", None)
    padding_side = getattr(tokenizer, "padding_side", "right")

    for idx, (full_text, prompt_text, image) in enumerate(zip(batch_texts, prompt_texts, per_example_images)):
        prompt_inputs = processor(text=[prompt_text], images=[image], return_tensors="pt")
        full_inputs = processor(text=[full_text], images=[image], return_tensors="pt")
        prompt_len = prompt_inputs["input_ids"].shape[1]
        full_len = full_inputs["input_ids"].shape[1]
        assistant_len = max(full_len - prompt_len, 0)

        if padding_side == "left":
            mask_until = labels.shape[1] - assistant_len
            labels[idx, :mask_until] = -100
        else:
            labels[idx, :prompt_len] = -100

        if pad_token_id is not None:
            labels[idx, model_inputs["input_ids"][idx] == pad_token_id] = -100

    model_inputs["labels"] = labels
    return model_inputs


class SuryaBubbleCollator:
    def __init__(self, processor):
        self.processor = processor

    def __call__(self, features):
        keys = ("id", "image_file", "split", "text")
        examples = {key: [feature.get(key) for feature in features] for key in keys}
        return process_batch(examples, self.processor)


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


def generate_prediction(model, processor, entry):
    split_name = entry.get("split") or "test"
    image_path = resolve_image_path(entry, split_name)
    if image_path is None:
        raise FileNotFoundError(f"Missing image for sample {entry.get('id')}")
    with Image.open(image_path) as img:
        image = img.convert("RGB")

    messages = messages_for_entry(image_path, None)
    prompt = apply_template(processor, messages, add_generation_prompt=True)
    inputs = processor(text=[prompt], images=[image], return_tensors="pt")

    device = next(model.parameters()).device
    dtype = model_dtype(model)
    inputs = move_inputs_to_device(inputs, device, dtype)

    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
        )

    gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    return decode_tokens(processor, gen_ids).strip()


def benchmark_indices(dataset, max_samples):
    total = len(dataset)
    if max_samples is None or max_samples <= 0 or max_samples >= total:
        return list(range(total))
    rng = random.Random(RANDOM_SEED)
    return sorted(rng.sample(range(total), max_samples))


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

    for sample_index, dataset_index in enumerate(indices, 1):
        entry = dataset[dataset_index]
        reference = extract_reference_text(entry)
        raw_prediction = generate_prediction(model, processor, entry)
        prediction = postprocess_prediction(raw_prediction)
        samples.append(
            {
                "dataset_idx": dataset_index,
                "id": entry.get("id"),
                "page_id": entry.get("page_id"),
                "reference": reference,
                "prediction": prediction,
                "raw_prediction": raw_prediction,
                "cer": sample_cer(prediction, reference),
                "levenshtein": levenshtein_distance(prediction, reference),
            }
        )
        if sample_index % 50 == 0 or sample_index == len(indices):
            print(f"  generated {sample_index}/{len(indices)}", flush=True)

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
    print("-" * 72, flush=True)
    for rank, sample in enumerate(ranked[: min(worst_count, len(ranked))], 1):
        print(
            f"#{rank} idx={sample['dataset_idx']} id={sample['id']} "
            f"page={sample['page_id']} CER={sample['cer']:.4f} "
            f"Lev={sample['levenshtein']}",
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


class PromptOnlyEvalTrainer(Seq2SeqTrainer):
    def __init__(self, *args, processor=None, gen_eval_max_samples=256, **kwargs):
        super().__init__(*args, **kwargs)
        self.processor = processor
        self.gen_eval_max_samples = gen_eval_max_samples

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
    for env_name in ("SURYA_TROCR_BENCHMARK_PATH", "SURYA_LIGHTON_BENCHMARK_PATH"):
        value = os.getenv(env_name)
        if value:
            candidates.append(Path(value))
    candidates.extend(
        [
            DOCKER_SCRIPTS_DIR
            / "finetune_trocr_large"
            / "outputs_trocr_manga_large"
            / "final_manga_model"
            / "benchmark_test.json",
            DOCKER_SCRIPTS_DIR
            / "finetune_trocr"
            / "outputs_trocr_manga"
            / "final_manga_model"
            / "benchmark_test.json",
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
        if tokenizer.pad_token_id is None and tokenizer.eos_token is not None:
            tokenizer.pad_token = tokenizer.eos_token
    image_processor = getattr(processor, "image_processor", None)
    if image_processor is not None and hasattr(image_processor, "default_to_square"):
        image_processor.default_to_square = False
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
        "torch_dtype": dtype,
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


def build_lora_config():
    from peft import LoraConfig

    lora_r = int(os.getenv("SURYA_LORA_R", "64"))
    lora_alpha = int(os.getenv("SURYA_LORA_ALPHA", str(lora_r * 2)))
    target_modules = [
        item.strip()
        for item in os.getenv(
            "SURYA_LORA_TARGET_MODULES",
            "q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj,lm_head",
        ).split(",")
        if item.strip()
    ]
    return LoraConfig(
        r=lora_r,
        lora_alpha=lora_alpha,
        lora_dropout=float(os.getenv("SURYA_LORA_DROPOUT", "0.01")),
        use_dora=env_bool("SURYA_USE_DORA", True),
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )


def configure_trainable_model(model):
    train_mode = os.getenv("SURYA_TRAIN_MODE", "lora").strip().lower()
    if train_mode == "full":
        print("Training mode: full fine-tuning", flush=True)
        for parameter in model.parameters():
            parameter.requires_grad = True
        return model, "full"

    try:
        from peft import get_peft_model

        print("Training mode: LoRA/DoRA", flush=True)
        model = get_peft_model(model, build_lora_config())
        model.print_trainable_parameters()
        return model, "lora"
    except Exception as exc:
        if not env_bool("SURYA_ALLOW_FULL_FALLBACK", True):
            raise
        print(f"LoRA setup failed, falling back to full fine-tuning: {exc}", flush=True)
        for parameter in model.parameters():
            parameter.requires_grad = True
        return model, "full_fallback"


def make_training_args():
    eval_steps = int(os.getenv("SURYA_EVAL_STEPS", "100"))
    kwargs = {
        "output_dir": str(OUTPUT_DIR),
        "learning_rate": float(os.getenv("SURYA_LR", "5e-5")),
        "num_train_epochs": float(os.getenv("SURYA_EPOCHS", "6")),
        "per_device_train_batch_size": int(os.getenv("SURYA_TRAIN_BATCH", "4")),
        "per_device_eval_batch_size": int(os.getenv("SURYA_EVAL_BATCH", "4")),
        "gradient_accumulation_steps": int(os.getenv("SURYA_GRAD_ACCUM", "4")),
        "gradient_checkpointing": env_bool("SURYA_GRADIENT_CHECKPOINTING", True),
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "optim": os.getenv(
            "SURYA_OPTIM",
            "adamw_torch_fused" if torch.cuda.is_available() else "adamw_torch",
        ),
        "bf16": torch.cuda.is_available(),
        "fp16": False,
        "tf32": torch.cuda.is_available(),
        "logging_steps": int(os.getenv("SURYA_LOGGING_STEPS", "10")),
        "eval_strategy": "steps",
        "eval_steps": eval_steps,
        "save_strategy": "steps",
        "save_steps": eval_steps,
        "save_total_limit": int(os.getenv("SURYA_SAVE_TOTAL_LIMIT", "3")),
        "load_best_model_at_end": True,
        "metric_for_best_model": "eval_cer",
        "greater_is_better": False,
        "remove_unused_columns": False,
        "report_to": os.getenv("SURYA_REPORT_TO", "none"),
        "predict_with_generate": False,
        "dataloader_num_workers": int(os.getenv("SURYA_DATALOADER_WORKERS", "4")),
        "dataloader_pin_memory": torch.cuda.is_available(),
        "torch_compile": env_bool("SURYA_TORCH_COMPILE", False),
        "lr_scheduler_type": os.getenv("SURYA_LR_SCHEDULER", "cosine"),
        "warmup_ratio": float(os.getenv("SURYA_WARMUP_RATIO", "0.05")),
        "weight_decay": float(os.getenv("SURYA_WEIGHT_DECAY", "0.01")),
        "max_grad_norm": float(os.getenv("SURYA_MAX_GRAD_NORM", "1.0")),
        "seed": RANDOM_SEED,
        "data_seed": RANDOM_SEED,
    }
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
    test_dataset = prepare_dataset(TEST_FILE, "test")
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

    train_dataset = prepare_dataset(TRAIN_FILE, "train")
    val_dataset = prepare_dataset(VAL_FILE, "val")
    test_dataset = prepare_dataset(TEST_FILE, "test")

    model, train_mode = configure_trainable_model(model)
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = False

    callbacks = [LiveMetricsCallback()]
    patience = int(os.getenv("SURYA_EARLY_STOPPING_PATIENCE", "0"))
    if patience > 0:
        callbacks.append(EarlyStoppingCallback(early_stopping_patience=patience))

    trainer = PromptOnlyEvalTrainer(
        model=model,
        args=make_training_args(),
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        data_collator=SuryaBubbleCollator(processor),
        callbacks=callbacks,
        processor=processor,
        gen_eval_max_samples=GEN_EVAL_MAX_SAMPLES,
    )

    print("Starting Surya bubble OCR fine-tuning...", flush=True)
    trainer.train()
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
