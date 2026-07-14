import argparse
import glob
import json
import math
import os
import random
import re
import shutil
import sys
import time
import unicodedata
import urllib.request
from collections import defaultdict
from pathlib import Path

import jiwer
import numpy as np
import torch
from datasets import load_dataset
from Levenshtein import distance as levenshtein_distance
from peft import (
    LoraConfig,
    PeftModel,
    get_peft_model,
    get_peft_model_state_dict,
    set_peft_model_state_dict,
)
from PIL import Image
from transformers import (
    LightOnOcrForConditionalGeneration,
    LightOnOcrProcessor,
    EarlyStoppingCallback,
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    TrainerCallback,
)


torch.set_num_threads(int(os.getenv("LIGHTON_TORCH_THREADS", "8")))
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
torch.backends.cudnn.benchmark = True
if hasattr(torch, "compile"):
    torch._dynamo.config.suppress_errors = True


SCRIPT_DIR = Path(__file__).resolve().parent
BASE_PATH = Path(os.getenv("LIGHTON_DATASET_DIR", str(SCRIPT_DIR / "lighton_dataset")))
TRAIN_FILE = BASE_PATH / "train" / "metadata.jsonl"
VAL_FILE = BASE_PATH / "val" / "metadata.jsonl"
TEST_FILE = BASE_PATH / "test" / "metadata.jsonl"

MODEL_ID = os.getenv("LIGHTON_MODEL_ID", "lightonai/LightOnOCR-2-1B-base")
OUTPUT_DIR = Path(os.getenv("LIGHTON_OUTPUT_DIR", str(SCRIPT_DIR / "outputs_lighton_manga")))
FINAL_DIR = OUTPUT_DIR / "final_lora_merged"
CANDIDATE_DIR = OUTPUT_DIR / "candidate_lora_merged"
PREVIOUS_DIR = OUTPUT_DIR / "previous_lora_merged"

# Keep the current crop-OCR instruction, but use the exact same text everywhere.
USER_PROMPT = os.getenv(
    "LIGHTON_USER_PROMPT",
    "\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :",
)

SPLITS = ("train", "val", "test")
MAX_NEW_TOKENS = int(os.getenv("LIGHTON_MAX_NEW_TOKENS", "128"))
GEN_EVAL_MAX_SAMPLES = int(os.getenv("LIGHTON_GEN_EVAL_MAX_SAMPLES", "256"))
FINAL_TEST_MAX_SAMPLES = int(os.getenv("LIGHTON_FINAL_TEST_MAX_SAMPLES", "0"))
RANDOM_SEED = int(os.getenv("LIGHTON_RANDOM_SEED", "42"))
IMAGE_LONGEST_EDGE = int(os.getenv("LIGHTON_IMAGE_LONGEST_EDGE", "700"))
MAX_SEQUENCE_LENGTH = int(os.getenv("LIGHTON_MAX_SEQUENCE_LENGTH", "512"))
GENERATION_BATCH_SIZE = int(os.getenv("LIGHTON_GENERATION_BATCH", "16"))
BASELINE_URL = os.getenv(
    "LIGHTON_BASELINE_BENCHMARK_URL",
    "https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/resolve/main/benchmark_test.json",
)
PUBLISHED_CER = float(os.getenv("LIGHTON_PUBLISHED_CER", "0.0042395336512983575"))
PUBLISHED_EXACT_MATCH = float(os.getenv("LIGHTON_PUBLISHED_EXACT_MATCH", "0.925531914893617"))


def env_bool(name, default=False):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", ""}


def parse_args():
    parser = argparse.ArgumentParser(description="Fine-tune LightOnOCR for manga bubble OCR.")
    parser.add_argument("--merge-only", action="store_true", help="Merge the best LoRA checkpoint and exit.")
    parser.add_argument("--benchmark-only", action="store_true", help="Benchmark an already merged model on the test split.")
    parser.add_argument("--model-path", default=None, help="Model path for --benchmark-only. Defaults to final_lora_merged.")
    parser.add_argument(
        "--profile-resolutions",
        action="store_true",
        help="Benchmark 512/700/896px on validation without training.",
    )
    return parser.parse_args()


def prepare_dataset(file_path, split_name):
    if not file_path.exists():
        raise FileNotFoundError(f"Missing dataset file: {file_path}")

    print(f"Loading {split_name} dataset from {file_path}...", flush=True)
    dataset = load_dataset("json", data_files=str(file_path), split="train")

    if "split" not in dataset.column_names:
        dataset = dataset.map(lambda _: {"split": split_name})

    print(f"  -> {len(dataset)} samples", flush=True)
    return dataset


def resolve_image_path(image_path, preferred_split=None):
    candidate_splits = []
    if preferred_split:
        candidate_splits.append(preferred_split)
    candidate_splits.extend(split for split in SPLITS if split not in candidate_splits)

    for split_name in candidate_splits:
        full_path = BASE_PATH / split_name / image_path
        if full_path.exists():
            return full_path

    return None


def clean_messages_and_load_images(messages, split_name, include_assistant=True):
    clean_messages = []
    images = []

    for msg in messages:
        if msg.get("role") == "assistant" and not include_assistant:
            continue

        clean_content = []
        for content in msg.get("content", []):
            if content.get("type") == "image":
                image_rel_path = content.get("image")
                image_path = resolve_image_path(image_rel_path, split_name)
                if image_path is None:
                    print(f"Image not found: {image_rel_path}", flush=True)
                    continue

                with Image.open(image_path) as img:
                    images.append(img.convert("RGB"))
                clean_content.append({"type": "image"})
            else:
                clean_content.append(content)

        clean_messages.append({"role": msg["role"], "content": clean_content})

    if clean_messages and clean_messages[0].get("role") == "user" and USER_PROMPT:
        existing_user_text = "\n".join(
            content.get("text", "")
            for content in clean_messages[0].get("content", [])
            if content.get("type") == "text"
        )
        if USER_PROMPT.strip() in existing_user_text:
            return clean_messages, images
        clean_messages[0]["content"].append({"type": "text", "text": USER_PROMPT})

    return clean_messages, images


def extract_reference_text(entry):
    if entry.get("text"):
        return str(entry["text"]).strip()

    for msg in entry.get("messages", []):
        if msg.get("role") != "assistant":
            continue
        for content in msg.get("content", []):
            if "text" in content:
                return str(content["text"]).strip()
    return ""


def find_subsequence(sequence, pattern, last=False):
    if not pattern or len(pattern) > len(sequence):
        return None
    matches = range(len(sequence) - len(pattern) + 1)
    if last:
        matches = reversed(list(matches))
    for idx in matches:
        if sequence[idx : idx + len(pattern)] == pattern:
            return idx
    return None


def assistant_marker_ids(processor):
    """Derive the assistant marker once without processing an image."""
    user = [{"role": "user", "content": [{"type": "text", "text": "x"}]}]
    without_generation = processor.apply_chat_template(
        user, add_generation_prompt=False, tokenize=False
    )
    with_generation = processor.apply_chat_template(
        user, add_generation_prompt=True, tokenize=False
    )
    prefix_ids = processor.tokenizer.encode(without_generation, add_special_tokens=False)
    full_ids = processor.tokenizer.encode(with_generation, add_special_tokens=False)
    common = 0
    for left, right in zip(prefix_ids, full_ids):
        if left != right:
            break
        common += 1
    marker = full_ids[common:]
    if not marker:
        # LightOnOCR-2/Qwen chat-template fallback from the official notebook.
        marker = [151644, 77091, 198]
    return marker


def mask_assistant_labels(input_ids, attention_mask, marker, pad_token_id):
    labels = input_ids.clone()
    for row_idx in range(labels.shape[0]):
        row = input_ids[row_idx].tolist()
        start = find_subsequence(row, marker, last=True)
        labels[row_idx, :] = -100
        if start is None:
            continue
        content_start = start + len(marker)
        labels[row_idx, content_start:] = input_ids[row_idx, content_start:]
        if attention_mask is not None:
            labels[row_idx, attention_mask[row_idx] == 0] = -100
        if pad_token_id is not None:
            labels[row_idx, input_ids[row_idx] == pad_token_id] = -100
    return labels


def process_batch(examples, processor, image_longest_edge=None):
    batch_texts = []
    batch_images = []

    messages_batch = examples["messages"]
    split_batch = examples.get("split", [None] * len(messages_batch))

    for messages, split_name in zip(messages_batch, split_batch):
        clean_messages, example_images = clean_messages_and_load_images(
            messages,
            split_name,
            include_assistant=True,
        )

        text = processor.apply_chat_template(
            clean_messages,
            add_generation_prompt=False,
            tokenize=False,
        )
        batch_texts.append(text)
        batch_images.extend(example_images)

    model_inputs = processor(
        text=batch_texts,
        images=batch_images if batch_images else None,
        padding=True,
        truncation=True,
        max_length=MAX_SEQUENCE_LENGTH,
        size={"longest_edge": image_longest_edge or IMAGE_LONGEST_EDGE},
        return_tensors="pt",
    )
    model_inputs["labels"] = mask_assistant_labels(
        model_inputs["input_ids"],
        model_inputs.get("attention_mask"),
        assistant_marker_ids(processor),
        processor.tokenizer.pad_token_id,
    )
    return model_inputs


class CustomDataCollator:
    def __init__(self, processor, image_longest_edge=None):
        self.processor = processor
        self.image_longest_edge = image_longest_edge or IMAGE_LONGEST_EDGE

    def __call__(self, features):
        batch = {
            "messages": [feature["messages"] for feature in features],
            "split": [feature.get("split") for feature in features],
        }
        return process_batch(batch, self.processor, self.image_longest_edge)


def postprocess_prediction(text):
    text = text.strip()
    if "\n" in text:
        text = text.splitlines()[0].strip()
    return text


def strict_prediction(text):
    return unicodedata.normalize("NFC", str(text).strip())


def sample_cer(prediction, reference):
    if not reference:
        return 0.0 if not prediction else 1.0
    return levenshtein_distance(prediction, reference) / max(len(reference), 1)


def compute_text_metrics(samples, prediction_key="prediction"):
    references = [str(sample["reference"]) for sample in samples if sample.get("reference")]
    predictions = [str(sample.get(prediction_key, "")) for sample in samples if sample.get("reference")]

    if not references:
        return {
            "cer": 1.0,
            "wer": 1.0,
            "exact_match": 0.0,
            "avg_levenshtein": 0.0,
            "blank_rate": 1.0,
            "multiline_rate": 0.0,
        }

    total_edits = sum(
        levenshtein_distance(prediction, reference)
        for prediction, reference in zip(predictions, references)
    )
    total_chars = sum(len(reference) for reference in references)
    cer = total_edits / max(total_chars, 1)

    try:
        wer = jiwer.wer(references, predictions)
    except Exception:
        wer = 1.0

    exact_matches = sum(
        1 for prediction, reference in zip(predictions, references) if prediction == reference
    )
    avg_lev = total_edits / max(len(references), 1)
    blank_rate = sum(1 for prediction in predictions if not prediction) / len(predictions)
    multiline_rate = sum(
        1 for sample in samples if "\n" in sample.get("raw_prediction", "").strip()
    ) / max(len(samples), 1)
    lengths = [len(prediction) for prediction in predictions]

    return {
        "cer": cer,
        "wer": wer,
        "exact_match": exact_matches / len(references),
        "avg_levenshtein": avg_lev,
        "blank_rate": blank_rate,
        "multiline_rate": multiline_rate,
        "avg_prediction_length": sum(lengths) / max(len(lengths), 1),
        "sample_count": len(references),
    }


def length_bucket(reference):
    size = len(reference)
    if size <= 3:
        return "1-3"
    if size <= 8:
        return "4-8"
    if size <= 20:
        return "9-20"
    if size <= 40:
        return "21-40"
    return "41+"


def compute_slice_metrics(samples):
    accent_re = re.compile(r"[^\x00-\x7f]")
    punctuation_re = re.compile(r"[!?.,;:\u2026\"'()\-]")
    predicates = {
        **{
            f"length_{bucket}": lambda sample, expected=bucket: length_bucket(sample["reference"]) == expected
            for bucket in ("1-3", "4-8", "9-20", "21-40", "41+")
        },
        "has_accents": lambda sample: bool(accent_re.search(sample["reference"])),
        "has_punctuation": lambda sample: bool(punctuation_re.search(sample["reference"])),
        "small_crop": lambda sample: min(sample.get("image_width", 9999), sample.get("image_height", 9999)) < 96,
        "extreme_aspect_ratio": lambda sample: sample.get("aspect_ratio", 1.0) >= 4.0 or sample.get("aspect_ratio", 1.0) <= 0.25,
    }
    result = {}
    for name, predicate in predicates.items():
        subset = [sample for sample in samples if predicate(sample)]
        if subset:
            result[name] = {
                "legacy": compute_text_metrics(subset),
                "strict": compute_text_metrics(subset, "strict_prediction"),
            }
    return result


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


def generate_predictions(model, processor, entries, image_longest_edge=None):
    prompts = []
    images = []
    image_meta = []
    for entry in entries:
        split_name = entry.get("split") or "test"
        clean_messages, entry_images = clean_messages_and_load_images(
            entry["messages"], split_name, include_assistant=False
        )
        prompts.append(
            processor.apply_chat_template(
                clean_messages, add_generation_prompt=True, tokenize=False
            )
        )
        if not entry_images:
            raise FileNotFoundError(f"Missing image for sample {entry.get('id')}")
        image = entry_images[0]
        images.append(image)
        image_meta.append(
            {
                "image_width": image.width,
                "image_height": image.height,
                "aspect_ratio": image.width / max(image.height, 1),
            }
        )
    inputs = processor(
        text=prompts,
        images=images,
        padding=True,
        truncation=True,
        max_length=MAX_SEQUENCE_LENGTH,
        size={"longest_edge": image_longest_edge or IMAGE_LONGEST_EDGE},
        return_tensors="pt",
    )
    device = next(model.parameters()).device
    dtype = model_dtype(model)
    inputs = move_inputs_to_device(inputs, device, dtype)
    started = time.perf_counter()
    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
        )
    elapsed = time.perf_counter() - started
    input_width = inputs["input_ids"].shape[1]
    decoded = processor.tokenizer.batch_decode(
        output_ids[:, input_width:], skip_special_tokens=True
    )
    return [text.strip() for text in decoded], image_meta, elapsed


def benchmark_indices(dataset, max_samples):
    total = len(dataset)
    if max_samples is None or max_samples <= 0 or max_samples >= total:
        return list(range(total))
    rng = random.Random(RANDOM_SEED)
    return sorted(rng.sample(range(total), max_samples))


def inference_cost(entry):
    """Ordering proxy used only for batching; it never changes scored samples."""
    size = entry.get("resized_size") or entry.get("original_size") or [1500, 1500]
    try:
        width, height = max(1, int(size[0])), max(1, int(size[1]))
    except (TypeError, ValueError, IndexError):
        width, height = 1500, 1500
    # Image tokens dominate the prompt; reference length predicts decode work.
    return ((width + 15) // 16) * ((height + 15) // 16) + len(extract_reference_text(entry))


def inference_batches(dataset, indices, batch_size):
    """Pack similar-cost pages together to avoid padding to the slowest page."""
    ordered = sorted(indices, key=lambda index: inference_cost(dataset[index]))
    return [ordered[start : start + batch_size] for start in range(0, len(ordered), batch_size)]


def run_generation_benchmark(
    model,
    processor,
    dataset,
    split_name,
    max_samples=None,
    title="GENERATION BENCHMARK",
    worst_count=5,
    batch_size=None,
    image_longest_edge=None,
):
    was_training = model.training
    old_use_cache = getattr(model.config, "use_cache", None)
    if old_use_cache is not None:
        model.config.use_cache = True
    model.eval()

    indices = benchmark_indices(dataset, max_samples)
    samples = []

    print("\n" + "=" * 70, flush=True)
    print(f" {title} [{split_name}] - {len(indices)}/{len(dataset)} samples", flush=True)
    print("=" * 70, flush=True)

    batch_size = batch_size or GENERATION_BATCH_SIZE
    generation_seconds = 0.0
    processed = 0
    for batch_indices in inference_batches(dataset, indices, batch_size):
        entries = [dataset[index] for index in batch_indices]
        raw_predictions, metas, elapsed = generate_predictions(
            model, processor, entries, image_longest_edge=image_longest_edge
        )
        generation_seconds += elapsed
        for dataset_idx, entry, raw_prediction, meta in zip(
            batch_indices, entries, raw_predictions, metas
        ):
            reference = extract_reference_text(entry)
            prediction = postprocess_prediction(raw_prediction)
            strict = strict_prediction(raw_prediction)
            samples.append(
                {
                    "dataset_idx": dataset_idx,
                    "id": entry.get("id"),
                    "page_id": entry.get("page_id"),
                    "reference": reference,
                    "prediction": prediction,
                    "strict_prediction": strict,
                    "raw_prediction": raw_prediction,
                    "cer": sample_cer(prediction, reference),
                    "strict_cer": sample_cer(strict, reference),
                    "levenshtein": levenshtein_distance(prediction, reference),
                    "strict_levenshtein": levenshtein_distance(strict, reference),
                    **meta,
                }
            )
        processed += len(batch_indices)
        print(f"  generated {processed}/{len(indices)}", flush=True)

    metrics = compute_text_metrics(samples)
    metrics["strict"] = compute_text_metrics(samples, "strict_prediction")
    metrics["generation_seconds"] = generation_seconds
    metrics["samples_per_second"] = len(samples) / max(generation_seconds, 1e-9)
    ranked = sorted(samples, key=lambda sample: sample["cer"], reverse=True)

    print("-" * 70, flush=True)
    print(f" CER:             {metrics['cer']:.6f} ({metrics['cer'] * 100:.3f}%)", flush=True)
    print(f" WER:             {metrics['wer']:.6f} ({metrics['wer'] * 100:.3f}%)", flush=True)
    print(
        f" Exact Match:     {metrics['exact_match']:.6f} "
        f"({metrics['exact_match'] * 100:.2f}%)",
        flush=True,
    )
    print(f" Avg Levenshtein: {metrics['avg_levenshtein']:.4f} chars", flush=True)
    print(f" Blank Rate:      {metrics['blank_rate']:.6f}", flush=True)
    print(f" Multiline Rate:  {metrics['multiline_rate']:.6f}", flush=True)
    print("-" * 70, flush=True)

    n_show = min(worst_count, len(ranked))
    print(f" TOP {n_show} WORST ERRORS", flush=True)
    for rank, sample in enumerate(ranked[:n_show], 1):
        print(
            f"  #{rank} idx={sample['dataset_idx']} id={sample['id']} "
            f"page={sample['page_id']} CER={sample['cer']:.4f} "
            f"Lev={sample['levenshtein']}",
            flush=True,
        )
        print(f"   REF:  {sample['reference']}", flush=True)
        print(f"   PRED: {sample['prediction']}", flush=True)
    print("=" * 70 + "\n", flush=True)

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

        max_samples = self.gen_eval_max_samples
        gen_metrics, _ = run_generation_benchmark(
            self.model,
            self.processor,
            dataset,
            split_name=split_name,
            max_samples=max_samples,
            title="PROMPT-ONLY EVAL",
            worst_count=3,
        )
        prefixed_metrics = {
            f"{metric_key_prefix}_{key}": value
            for key, value in gen_metrics.items()
            if isinstance(value, (int, float))
        }
        metrics.update(prefixed_metrics)
        self.log(prefixed_metrics)
        return metrics


class LiveMetricsCallback(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        if not logs:
            return

        keys = [
            "loss",
            "learning_rate",
            "eval_loss",
            "eval_cer",
            "eval_wer",
            "eval_exact_match",
            "eval_blank_rate",
            "eval_multiline_rate",
        ]
        parts = [f"step={state.global_step}"]
        for key in keys:
            if key in logs:
                value = logs[key]
                parts.append(f"{key}={value:.6f}" if isinstance(value, float) else f"{key}={value}")
        print(f"[LIVE] {' | '.join(parts)}", flush=True)


def find_best_checkpoint(output_dir):
    output_dir = Path(output_dir)
    state_files = [output_dir / "trainer_state.json"]
    state_files.extend(Path(path) / "trainer_state.json" for path in glob.glob(str(output_dir / "checkpoint-*")))

    for state_file in sorted(state_files, key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
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

    checkpoints = sorted(
        glob.glob(str(output_dir / "checkpoint-*")),
        key=os.path.getmtime,
    )
    return checkpoints[-1] if checkpoints else None


def load_json_url_or_path(value):
    if not value:
        return None
    candidate = Path(value)
    if candidate.exists():
        with open(candidate, "r", encoding="utf-8") as handle:
            return json.load(handle)
    with urllib.request.urlopen(value, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def load_baseline_benchmark():
    value = os.getenv("LIGHTON_BASELINE_BENCHMARK") or BASELINE_URL
    try:
        return load_json_url_or_path(value), value
    except Exception as exc:
        print(f"Baseline benchmark unavailable: {exc}", flush=True)
        return None, value


def paired_page_bootstrap(current_samples, baseline_samples, iterations=2000):
    current_by_id = {str(item.get("id")): item for item in current_samples if item.get("id")}
    baseline_by_id = {str(item.get("id")): item for item in baseline_samples if item.get("id")}
    shared_ids = sorted(set(current_by_id) & set(baseline_by_id))
    pages = defaultdict(list)
    for sample_id in shared_ids:
        current = current_by_id[sample_id]
        baseline = baseline_by_id[sample_id]
        reference = str(current.get("reference", ""))
        pages[str(current.get("page_id") or sample_id)].append(
            (
                len(reference),
                levenshtein_distance(str(current.get("strict_prediction", "")), reference),
                levenshtein_distance(
                    strict_prediction(str(baseline.get("raw_prediction") or baseline.get("prediction", ""))),
                    reference,
                ),
            )
        )
    page_keys = sorted(pages)
    if not page_keys:
        return {"shared_sample_count": 0, "page_count": 0, "available": False}
    rng = random.Random(RANDOM_SEED)
    deltas = []
    for _ in range(iterations):
        chosen = [rng.choice(page_keys) for _ in page_keys]
        chars = current_edits = baseline_edits = 0
        for page in chosen:
            for n_chars, cur_edits, base_edits in pages[page]:
                chars += n_chars
                current_edits += cur_edits
                baseline_edits += base_edits
        deltas.append((current_edits - baseline_edits) / max(chars, 1))
    deltas.sort()
    low_idx = int(0.025 * (len(deltas) - 1))
    high_idx = int(0.975 * (len(deltas) - 1))
    return {
        "available": True,
        "shared_sample_count": len(shared_ids),
        "page_count": len(page_keys),
        "iterations": iterations,
        "cer_delta_current_minus_baseline_ci95": [deltas[low_idx], deltas[high_idx]],
        "statistically_better": deltas[high_idx] < 0,
    }


def compare_with_baseline(samples):
    payload, source = load_baseline_benchmark()
    if not payload:
        return {"available": False, "source": source}
    baseline_samples = payload.get("samples") or []
    bootstrap = paired_page_bootstrap(samples, baseline_samples)
    baseline_by_id = {str(item.get("id")): item for item in baseline_samples if item.get("id")}
    aligned = []
    for sample in samples:
        baseline = baseline_by_id.get(str(sample.get("id")))
        if not baseline:
            continue
        aligned.append(
            {
                "reference": sample["reference"],
                "prediction": postprocess_prediction(
                    str(baseline.get("raw_prediction") or baseline.get("prediction", ""))
                ),
                "raw_prediction": str(
                    baseline.get("raw_prediction") or baseline.get("prediction", "")
                ),
            }
        )
    return {
        "available": bool(aligned),
        "source": source,
        "published_metrics": payload.get("metrics") or {},
        "aligned_metrics": compute_text_metrics(aligned) if aligned else {},
        "bootstrap": bootstrap,
    }


def quality_gate(metrics, comparison, training_seconds=None):
    strict = metrics.get("strict") or {}
    cer = float(strict.get("cer", 1.0))
    exact = float(strict.get("exact_match", 0.0))
    bootstrap = comparison.get("bootstrap") or {}
    required_shared = int(os.getenv("LIGHTON_REQUIRED_BASELINE_SAMPLES", "1128"))
    baseline_seconds = float(os.getenv("LIGHTON_BASELINE_TRAIN_SECONDS", "0") or 0)
    speed_source = "LIGHTON_BASELINE_TRAIN_SECONDS" if baseline_seconds > 0 else None
    comparison_path = OUTPUT_DIR / "3090_comparison.json"
    if baseline_seconds <= 0 and comparison_path.exists():
        try:
            with open(comparison_path, "r", encoding="utf-8") as handle:
                speed_comparison = json.load(handle)
            baseline_seconds = float(
                speed_comparison.get("legacy_estimated_full_seconds") or 0
            )
            if baseline_seconds > 0:
                speed_source = str(comparison_path)
        except Exception:
            baseline_seconds = 0
    quality_pass = (
        cer < PUBLISHED_CER
        and exact >= PUBLISHED_EXACT_MATCH
        and comparison.get("available", False)
        and bootstrap.get("shared_sample_count", 0) >= required_shared
        and bootstrap.get("statistically_better", False)
    )
    speed_pass = (
        training_seconds is not None
        and baseline_seconds > 0
        and training_seconds < baseline_seconds
    )
    if env_bool("LIGHTON_ALLOW_MISSING_SPEED_BASELINE", False) and baseline_seconds <= 0:
        speed_pass = True
        speed_source = "explicit missing-baseline override"
    return {
        "release_ready": quality_pass and speed_pass,
        "quality_pass": quality_pass,
        "speed_pass": speed_pass,
        "strict_cer": cer,
        "required_cer_below": PUBLISHED_CER,
        "strict_exact_match": exact,
        "required_exact_match_at_least": PUBLISHED_EXACT_MATCH,
        "training_seconds": training_seconds,
        "baseline_training_seconds": baseline_seconds or None,
        "speed_evidence_source": speed_source,
        "bootstrap": bootstrap,
        "required_shared_baseline_samples": required_shared,
    }


def save_benchmark(path, metrics, samples, training_seconds=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    comparison = compare_with_baseline(samples)
    gate = quality_gate(metrics, comparison, training_seconds=training_seconds)
    ranked = sorted(samples, key=lambda sample: sample.get("strict_cer", 0), reverse=True)
    payload = {
        "model_id": MODEL_ID,
        "prompt": USER_PROMPT,
        "image_longest_edge": IMAGE_LONGEST_EDGE,
        "max_new_tokens": MAX_NEW_TOKENS,
        "metrics": metrics,
        "slice_metrics": compute_slice_metrics(samples),
        "baseline_comparison": comparison,
        "quality_gate": gate,
        "top_20_worst_errors": ranked[:20],
        "samples": samples,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    with open(path.parent / "quality_gate.json", "w", encoding="utf-8") as f:
        json.dump(gate, f, ensure_ascii=False, indent=2)
    with open(OUTPUT_DIR / "last_quality_gate.json", "w", encoding="utf-8") as f:
        json.dump(gate, f, ensure_ascii=False, indent=2)
    print(f"Benchmark saved to {path}", flush=True)
    print(f"Release quality gate: {'PASS' if gate['release_ready'] else 'FAIL'}", flush=True)
    return gate


def configure_processor():
    print(f"Loading processor for {MODEL_ID}...", flush=True)
    processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
    processor.image_processor.default_to_square = False
    processor.image_processor.size = {"longest_edge": IMAGE_LONGEST_EDGE}
    processor.tokenizer.padding_side = "left"
    if processor.tokenizer.pad_token_id is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token
    print("Dynamic resolution enabled (default_to_square=False)", flush=True)
    return processor


def configure_generation(model):
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = True
    model.generation_config.do_sample = False
    model.generation_config.max_new_tokens = MAX_NEW_TOKENS
    model.generation_config.max_length = None
    model.generation_config.temperature = None
    model.generation_config.top_p = None
    model.generation_config.top_k = None


def load_base_model(dtype):
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading model {MODEL_ID} in {dtype} on {device}...", flush=True)

    kwargs = {
        "torch_dtype": dtype,
        "attn_implementation": "sdpa",
        "low_cpu_mem_usage": True,
    }
    if device == "cuda":
        kwargs["device_map"] = {"": "cuda:0"}

    model = LightOnOcrForConditionalGeneration.from_pretrained(MODEL_ID, **kwargs)
    if device != "cuda":
        model.to(device)

    configure_generation(model)
    return model


def build_peft_config():
    lora_r = int(os.getenv("LIGHTON_LORA_R", "64"))
    lora_alpha = int(os.getenv("LIGHTON_LORA_ALPHA", str(lora_r * 2)))
    include_lm_head = env_bool("LIGHTON_LORA_LM_HEAD", False)
    targets = [
        "q_proj",
        "k_proj",
        "v_proj",
        "o_proj",
        "gate_proj",
        "up_proj",
        "down_proj",
    ]
    if include_lm_head:
        targets.append("lm_head")

    return LoraConfig(
        r=lora_r,
        lora_alpha=lora_alpha,
        use_dora=env_bool("LIGHTON_USE_DORA", False),
        use_rslora=env_bool("LIGHTON_USE_RSLORA", True),
        target_modules=targets,
        lora_dropout=float(os.getenv("LIGHTON_LORA_DROPOUT", "0")),
        bias="none",
        task_type="CAUSAL_LM",
    )


def configure_gradient_checkpointing(model, enabled):
    # KV caching only accelerates autoregressive generation. Keeping it enabled
    # during SFT retains large attention tensors and can saturate a 3090 even
    # for a small calibration batch. generate_predictions() temporarily enables
    # it when needed and restores this training-safe value afterwards.
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = False
    if enabled:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    else:
        model.gradient_checkpointing_disable()
    return enabled


def hardest_features(dataset, count=32):
    ranked = []
    for index in range(len(dataset)):
        entry = dataset[index]
        image_file = entry.get("image_file")
        if not image_file:
            try:
                image_file = entry["messages"][0]["content"][0]["image"]
            except Exception:
                image_file = ""
        image_path = resolve_image_path(image_file, entry.get("split") or "train")
        size = image_path.stat().st_size if image_path and image_path.exists() else 0
        ranked.append((size + len(extract_reference_text(entry)) * 4096, entry))
    ranked.sort(key=lambda item: item[0], reverse=True)
    selected = [entry for _, entry in ranked[:count]]
    return selected or [dataset[0]]


def calibrate_3090(model, processor, train_dataset):
    auto_batch = env_bool("LIGHTON_AUTO_BATCH", True) and torch.cuda.is_available()
    manual_batch = int(os.getenv("LIGHTON_TRAIN_BATCH", "8"))
    if not auto_batch:
        checkpointing = env_bool("LIGHTON_GRADIENT_CHECKPOINTING", False)
        configure_gradient_checkpointing(model, checkpointing)
        return {
            "auto_batch": False,
            "batch_size": manual_batch,
            "gradient_checkpointing": checkpointing,
            "calibration_attempts": [],
        }

    candidates = sorted(
        set(
            [
        int(value.strip())
        for value in os.getenv("LIGHTON_BATCH_CANDIDATES", "32,24,16,12,8,4").split(",")
        if value.strip()
            ]
        )
    )
    sample_pool = hardest_features(train_dataset, max(candidates))
    collator = CustomDataCollator(processor)
    attempts = []
    selected = None
    selected_checkpointing = False
    device = next(model.parameters()).device
    dtype = model_dtype(model)
    total_vram = torch.cuda.get_device_properties(0).total_memory
    headroom_ratio = float(os.getenv("LIGHTON_CALIBRATION_MAX_VRAM_RATIO", "0.86"))
    max_attempt_seconds = float(os.getenv("LIGHTON_CALIBRATION_MAX_ATTEMPT_SECONDS", "90"))
    throughput_tolerance = float(
        os.getenv("LIGHTON_CALIBRATION_THROUGHPUT_TOLERANCE", "0.05")
    )
    checkpointing_modes = (
        (True,)
        if env_bool("LIGHTON_CALIBRATION_REQUIRE_CHECKPOINTING", False)
        else (False, True)
    )
    for checkpointing in checkpointing_modes:
        configure_gradient_checkpointing(model, checkpointing)
        mode_candidates = candidates if not checkpointing else [1, 2, 4, 8]
        mode_selected = None
        for batch_size in mode_candidates:
            successful = [
                attempt
                for attempt in attempts
                if attempt["status"] == "ok"
                and attempt["gradient_checkpointing"] == checkpointing
            ]
            if successful:
                previous = successful[-1]
                scale = batch_size / previous["batch_size"]
                predicted_peak_ratio = previous["peak_vram_ratio"] * scale
                predicted_seconds = previous["seconds"] * scale
                if predicted_peak_ratio >= headroom_ratio or predicted_seconds > max_attempt_seconds:
                    reason = (
                        "predicted_vram_headroom"
                        if predicted_peak_ratio >= headroom_ratio
                        else "predicted_attempt_too_slow"
                    )
                    attempts.append(
                        {
                            "batch_size": batch_size,
                            "gradient_checkpointing": checkpointing,
                            "status": "skipped",
                            "selection_reason": reason,
                            "predicted_peak_vram_ratio": predicted_peak_ratio,
                            "predicted_seconds": predicted_seconds,
                        }
                    )
                    print(
                        f"Calibration batch={batch_size} skipped ({reason}, "
                        f"predicted VRAM={predicted_peak_ratio:.1%}, "
                        f"predicted time={predicted_seconds:.1f}s).",
                        flush=True,
                    )
                    break
            features = [sample_pool[index % len(sample_pool)] for index in range(batch_size)]
            started = time.perf_counter()
            batch = None
            loss = None
            try:
                torch.cuda.empty_cache()
                torch.cuda.reset_peak_memory_stats()
                batch = move_inputs_to_device(collator(features), device, dtype)
                model.train()
                loss = model(**batch).loss
                loss.backward()
                torch.cuda.synchronize()
                elapsed = time.perf_counter() - started
                peak_gb = torch.cuda.max_memory_allocated() / 1024**3
                peak_ratio = torch.cuda.max_memory_allocated() / total_vram
                attempts.append(
                    {
                        "batch_size": batch_size,
                        "gradient_checkpointing": checkpointing,
                        "status": "ok",
                        "seconds": elapsed,
                        "samples_per_second": batch_size / max(elapsed, 1e-9),
                        "peak_vram_gb": peak_gb,
                        "peak_vram_ratio": peak_ratio,
                    }
                )
                print(
                    f"Calibration batch={batch_size}: {elapsed:.2f}s, "
                    f"{batch_size / max(elapsed, 1e-9):.2f} samples/s, "
                    f"peak VRAM={peak_gb:.2f} GiB ({peak_ratio:.1%}).",
                    flush=True,
                )
                selected = batch_size
                mode_selected = batch_size
                selected_checkpointing = checkpointing
                if successful and attempts[-1]["samples_per_second"] < (
                    successful[-1]["samples_per_second"] * (1 - throughput_tolerance)
                ):
                    attempts[-1]["selection_reason"] = "throughput_regressed"
                    break
                if peak_ratio >= headroom_ratio:
                    if batch_size == mode_candidates[0] and not checkpointing:
                        attempts[-1]["selection_reason"] = (
                            "minimum_batch_requires_checkpointing_headroom"
                        )
                        selected = None
                        mode_selected = None
                    else:
                        attempts[-1]["selection_reason"] = "vram_headroom_reached"
                    break
            except (torch.cuda.OutOfMemoryError, RuntimeError) as exc:
                message = str(exc).lower()
                allocator_failure = (
                    "out of memory" in message
                    or "cudacachingallocator" in message
                    or "internal assert failed" in message
                    or "cublas_status" in message
                    or "illegal memory access" in message
                    or isinstance(exc, torch.cuda.OutOfMemoryError)
                )
                if not allocator_failure:
                    raise
                attempts.append(
                    {
                        "batch_size": batch_size,
                        "gradient_checkpointing": checkpointing,
                        "status": "allocator_limit",
                        "error": str(exc)[:500],
                    }
                )
                print(
                    f"Calibration batch={batch_size} reached the CUDA allocator limit.",
                    flush=True,
                )
                break
            finally:
                model.zero_grad(set_to_none=True)
                del loss
                del batch
                torch.cuda.empty_cache()
        if mode_selected is not None:
            break
    if selected is None:
        raise RuntimeError("GPU calibration failed even with gradient checkpointing.")
    effective_batch = int(os.getenv("LIGHTON_EFFECTIVE_BATCH", "32"))
    exact_batch_attempts = [
        attempt
        for attempt in attempts
        if attempt["status"] == "ok"
        and attempt["gradient_checkpointing"] == selected_checkpointing
        and effective_batch % attempt["batch_size"] == 0
    ]
    if exact_batch_attempts:
        fastest_exact = max(exact_batch_attempts, key=lambda attempt: attempt["samples_per_second"])
        selected = fastest_exact["batch_size"]
    print(
        f"Calibration selected batch={selected} x "
        f"accumulation={effective_batch // selected} (effective batch={effective_batch}).",
        flush=True,
    )
    configure_gradient_checkpointing(model, selected_checkpointing)
    return {
        "auto_batch": True,
        "gpu_name": torch.cuda.get_device_name(0),
        "gpu_total_vram_gb": total_vram / 1024**3,
        "max_vram_ratio": headroom_ratio,
        "batch_size": selected,
        "gradient_checkpointing": selected_checkpointing,
        "calibration_attempts": attempts,
    }


def save_profile(profile):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / os.getenv("LIGHTON_PROFILE_FILENAME", "3090_profile.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(profile, handle, ensure_ascii=False, indent=2)
    print(f"GPU profile saved to {path}", flush=True)


def promote_candidate():
    if not CANDIDATE_DIR.exists():
        raise FileNotFoundError(f"Candidate model is missing: {CANDIDATE_DIR}")
    if PREVIOUS_DIR.exists():
        shutil.rmtree(PREVIOUS_DIR)
    moved_previous = False
    try:
        if FINAL_DIR.exists():
            FINAL_DIR.rename(PREVIOUS_DIR)
            moved_previous = True
        CANDIDATE_DIR.rename(FINAL_DIR)
    except Exception:
        if moved_previous and PREVIOUS_DIR.exists() and not FINAL_DIR.exists():
            PREVIOUS_DIR.rename(FINAL_DIR)
        raise
    print(f"Candidate promoted to release model: {FINAL_DIR}", flush=True)


def build_replay_dataset(train_dataset, samples):
    sample_by_id = {str(sample.get("id")): sample for sample in samples if sample.get("id")}
    errors = []
    clean_by_bucket = defaultdict(list)
    for entry in train_dataset:
        sample = sample_by_id.get(str(entry.get("id")))
        if not sample:
            continue
        if sample.get("strict_cer", 0) > 0:
            errors.append(entry)
        else:
            clean_by_bucket[length_bucket(extract_reference_text(entry))].append(entry)
    if not errors:
        return None, {"errors": 0, "clean": 0, "total": 0}
    clean_target = max(1, math.ceil(len(errors) * 3 / 7))
    rng = random.Random(RANDOM_SEED)
    clean = []
    buckets = list(clean_by_bucket)
    while buckets and len(clean) < clean_target:
        for bucket in list(buckets):
            choices = clean_by_bucket[bucket]
            if not choices:
                buckets.remove(bucket)
                continue
            index = rng.randrange(len(choices))
            clean.append(choices.pop(index))
            if len(clean) >= clean_target:
                break
    replay = errors + clean
    rng.shuffle(replay)
    return replay, {
        "errors": len(errors),
        "clean": len(clean),
        "total": len(replay),
    }


def make_training_args(profile, output_dir=None, post_sft=False, train_samples=None):
    batch_size = int(profile["batch_size"])
    effective_batch = int(os.getenv("LIGHTON_EFFECTIVE_BATCH", "32"))
    grad_accum = max(1, math.ceil(effective_batch / batch_size))
    workers = int(os.getenv("LIGHTON_DATALOADER_WORKERS", "4"))
    common = dict(
        output_dir=str(output_dir or OUTPUT_DIR),
        learning_rate=float(
            os.getenv("LIGHTON_POST_SFT_LR", "1e-5")
            if post_sft
            else os.getenv("LIGHTON_LR", "5e-5")
        ),
        num_train_epochs=float(
            os.getenv("LIGHTON_POST_SFT_EPOCHS", "1")
            if post_sft
            else os.getenv("LIGHTON_EPOCHS", "6")
        ),
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=int(os.getenv("LIGHTON_EVAL_BATCH", str(batch_size))),
        gradient_accumulation_steps=grad_accum,
        gradient_checkpointing=bool(profile["gradient_checkpointing"]),
        gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="adamw_torch_fused" if torch.cuda.is_available() else "adamw_torch",
        bf16=torch.cuda.is_available(),
        fp16=False,
        tf32=torch.cuda.is_available(),
        logging_steps=int(os.getenv("LIGHTON_LOGGING_STEPS", "10")),
        save_total_limit=1 if post_sft else int(os.getenv("LIGHTON_SAVE_TOTAL_LIMIT", "2")),
        remove_unused_columns=False,
        report_to="none",
        predict_with_generate=False,
        dataloader_num_workers=workers,
        dataloader_pin_memory=torch.cuda.is_available(),
        dataloader_persistent_workers=workers > 0,
        dataloader_prefetch_factor=(
            int(os.getenv("LIGHTON_DATALOADER_PREFETCH_FACTOR", "2"))
            if workers > 0
            else None
        ),
        # The replay dataset is assembled dynamically and has no input_ids;
        # LengthGroupedSampler cannot infer lengths there.
        group_by_length=env_bool("LIGHTON_GROUP_BY_LENGTH", False) and not post_sft,
        length_column_name=os.getenv("LIGHTON_LENGTH_COLUMN", "length"),
        torch_compile=env_bool("LIGHTON_TORCH_COMPILE", False),
        lr_scheduler_type=os.getenv("LIGHTON_LR_SCHEDULER", "cosine"),
        weight_decay=float(os.getenv("LIGHTON_WEIGHT_DECAY", "0.01")),
        max_grad_norm=float(os.getenv("LIGHTON_MAX_GRAD_NORM", "1.0")),
        seed=RANDOM_SEED,
        data_seed=RANDOM_SEED,
    )
    max_steps = int(os.getenv("LIGHTON_MAX_STEPS", "-1"))
    explicit_warmup = os.getenv("LIGHTON_WARMUP_STEPS")
    if explicit_warmup is not None:
        common["warmup_steps"] = int(explicit_warmup)
    elif train_samples:
        epochs = float(common["num_train_epochs"])
        steps_per_epoch = max(1, math.ceil(train_samples / max(1, batch_size * grad_accum)))
        total_steps = max_steps if max_steps > 0 and not post_sft else math.ceil(steps_per_epoch * epochs)
        common["warmup_steps"] = math.ceil(total_steps * float(os.getenv("LIGHTON_WARMUP_RATIO", "0.05")))
    else:
        common["warmup_steps"] = 0
    if max_steps > 0 and not post_sft:
        common["max_steps"] = max_steps
    if post_sft or env_bool("LIGHTON_PROFILE_ONLY", False):
        common.update(eval_strategy="no", save_strategy="no", load_best_model_at_end=False)
    else:
        common.update(
            eval_strategy="epoch",
            save_strategy="epoch",
            load_best_model_at_end=True,
            metric_for_best_model="eval_cer",
            greater_is_better=False,
        )
    return Seq2SeqTrainingArguments(**common)


def run_hard_example_sft(model, processor, train_dataset, val_dataset, profile):
    if not env_bool("LIGHTON_HARD_EXAMPLE_SFT", True):
        return model, {"enabled": False, "accepted": False}
    print("Mining hard examples from the training split...", flush=True)
    mining_started = time.perf_counter()
    _, train_samples = run_generation_benchmark(
        model,
        processor,
        train_dataset,
        split_name="train",
        max_samples=int(os.getenv("LIGHTON_HARD_MINING_MAX_SAMPLES", "0")) or None,
        title="HARD-EXAMPLE MINING",
        worst_count=5,
    )
    replay_dataset, replay_stats = build_replay_dataset(train_dataset, train_samples)
    if not replay_dataset:
        return model, {
            "enabled": True,
            "accepted": False,
            "reason": "no training errors",
            "replay": replay_stats,
        }
    print("Evaluating main-SFT checkpoint before replay...", flush=True)
    before_metrics, _ = run_generation_benchmark(
        model,
        processor,
        val_dataset,
        split_name="val",
        max_samples=None,
        title="PRE HARD-SFT VALIDATION",
        worst_count=5,
    )
    adapter_state = {
        key: value.detach().cpu().clone()
        for key, value in get_peft_model_state_dict(model).items()
    }
    post_started = time.perf_counter()
    post_trainer = Seq2SeqTrainer(
        model=model,
        args=make_training_args(
            profile,
            OUTPUT_DIR / "post_sft",
            post_sft=True,
            train_samples=len(replay_dataset),
        ),
        train_dataset=replay_dataset,
        data_collator=CustomDataCollator(processor),
        callbacks=[LiveMetricsCallback()],
    )
    post_trainer.train()
    post_seconds = time.perf_counter() - post_started
    after_metrics, _ = run_generation_benchmark(
        model,
        processor,
        val_dataset,
        split_name="val",
        max_samples=None,
        title="POST HARD-SFT VALIDATION",
        worst_count=5,
    )
    before_strict = before_metrics["strict"]
    after_strict = after_metrics["strict"]
    accepted = (
        after_strict["cer"] < before_strict["cer"]
        and after_strict["exact_match"] >= before_strict["exact_match"]
    )
    if not accepted:
        print("Hard-example SFT rejected; restoring main-SFT adapter.", flush=True)
        set_peft_model_state_dict(model, adapter_state)
    else:
        print("Hard-example SFT accepted by validation gate.", flush=True)
    return model, {
        "enabled": True,
        "accepted": accepted,
        "replay": replay_stats,
        "mining_seconds": time.perf_counter() - mining_started - post_seconds,
        "post_sft_seconds": post_seconds,
        "before": before_metrics,
        "after": after_metrics,
    }


def profile_resolutions(model, processor, val_dataset):
    results = {}
    for edge in (512, 700, 896):
        metrics, _ = run_generation_benchmark(
            model,
            processor,
            val_dataset,
            split_name="val",
            max_samples=GEN_EVAL_MAX_SAMPLES or None,
            title=f"RESOLUTION PROFILE {edge}px",
            worst_count=3,
            image_longest_edge=edge,
        )
        results[str(edge)] = metrics
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_DIR / "resolution_profile.json", "w", encoding="utf-8") as handle:
        json.dump(results, handle, ensure_ascii=False, indent=2)
    return results


def main():
    args = parse_args()
    random.seed(RANDOM_SEED)
    np.random.seed(RANDOM_SEED)
    torch.manual_seed(RANDOM_SEED)

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32

    if args.benchmark_only or args.profile_resolutions:
        model_path = args.model_path or str(FINAL_DIR)
        if args.profile_resolutions and not Path(model_path).exists():
            model_path = MODEL_ID
        print(f"Loading merged model for benchmark: {model_path}", flush=True)
        model_kwargs = {"torch_dtype": dtype, "attn_implementation": "sdpa"}
        if torch.cuda.is_available():
            model_kwargs["device_map"] = {"": "cuda:0"}
        model = LightOnOcrForConditionalGeneration.from_pretrained(
            model_path,
            **model_kwargs,
        ).eval()
        processor = LightOnOcrProcessor.from_pretrained(model_path)
        processor.image_processor.default_to_square = False
        processor.image_processor.size = {"longest_edge": IMAGE_LONGEST_EDGE}
        processor.tokenizer.padding_side = "left"
        if args.profile_resolutions:
            val_dataset = prepare_dataset(VAL_FILE, "val")
            profile_resolutions(model, processor, val_dataset)
            return
        test_dataset = prepare_dataset(TEST_FILE, "test")
        max_samples = FINAL_TEST_MAX_SAMPLES or None
        metrics, samples = run_generation_benchmark(
            model,
            processor,
            test_dataset,
            split_name="test",
            max_samples=max_samples,
            title="FINAL TEST BENCHMARK",
            worst_count=10,
        )
        output_path = Path(model_path) / "benchmark_test.json" if Path(model_path).is_dir() else OUTPUT_DIR / "benchmark_test.json"
        save_benchmark(output_path, metrics, samples)
        return

    processor = configure_processor()

    model = load_base_model(dtype)
    timing = {
        "started_at_unix": time.time(),
        "image_longest_edge": IMAGE_LONGEST_EDGE,
    }

    if args.merge_only:
        checkpoint = find_best_checkpoint(OUTPUT_DIR)
        if not checkpoint:
            print("No checkpoint found. Run training first.", flush=True)
            sys.exit(1)
        print(f"Loading LoRA checkpoint: {checkpoint}", flush=True)
        model = PeftModel.from_pretrained(model, checkpoint)
    else:
        train_dataset = prepare_dataset(TRAIN_FILE, "train")
        val_dataset = prepare_dataset(VAL_FILE, "val")
        test_dataset = prepare_dataset(TEST_FILE, "test")

        model = get_peft_model(model, build_peft_config())
        model.print_trainable_parameters()
        if hasattr(model.config, "use_cache"):
            model.config.use_cache = False

        calibration_started = time.perf_counter()
        profile = calibrate_3090(model, processor, train_dataset)
        timing["calibration_seconds"] = time.perf_counter() - calibration_started
        profile.update(
            {
                "image_longest_edge": IMAGE_LONGEST_EDGE,
                "effective_batch_size": int(os.getenv("LIGHTON_EFFECTIVE_BATCH", "32")),
                "lora": {
                    "rank": int(os.getenv("LIGHTON_LORA_R", "64")),
                    "alpha": int(os.getenv("LIGHTON_LORA_ALPHA", "128")),
                    "dropout": float(os.getenv("LIGHTON_LORA_DROPOUT", "0")),
                    "use_rslora": env_bool("LIGHTON_USE_RSLORA", True),
                    "use_dora": env_bool("LIGHTON_USE_DORA", False),
                    "include_lm_head": env_bool("LIGHTON_LORA_LM_HEAD", False),
                },
            }
        )
        save_profile(profile)
        if env_bool("LIGHTON_CALIBRATE_ONLY", False):
            print("GPU calibration complete; stopping before training.", flush=True)
            return
        training_args = make_training_args(profile, train_samples=len(train_dataset))

        callbacks = [LiveMetricsCallback()]
        patience = int(os.getenv("LIGHTON_EARLY_STOPPING_PATIENCE", "2"))
        if patience > 0:
            callbacks.append(EarlyStoppingCallback(early_stopping_patience=patience))

        trainer = PromptOnlyEvalTrainer(
            model=model,
            args=training_args,
            train_dataset=train_dataset,
            eval_dataset=val_dataset,
            data_collator=CustomDataCollator(processor),
            callbacks=callbacks,
            processor=processor,
            gen_eval_max_samples=GEN_EVAL_MAX_SAMPLES,
        )

        print(
            f"Starting Fine-Tuning {os.getenv('LIGHTON_TASK_LABEL', 'LightOnOCR crop OCR')}...",
            flush=True,
        )
        sft_started = time.perf_counter()
        trainer.train()
        timing["main_sft_seconds"] = time.perf_counter() - sft_started
        timing["main_sft_steps"] = trainer.state.global_step
        timing["train_samples"] = len(train_dataset)

        best_checkpoint = trainer.state.best_model_checkpoint or find_best_checkpoint(OUTPUT_DIR)
        print(f"Best checkpoint: {best_checkpoint}", flush=True)

        model = trainer.model
        if env_bool("LIGHTON_PROFILE_ONLY", False):
            profile.update(timing)
            profile["profile_only"] = True
            save_profile(profile)
            print("Throughput profile complete; skipping replay, merge and benchmark.", flush=True)
            return
        # Replay is an optional quality pass. Never discard a completed main
        # SFT because replay data, sampler or CUDA memory failed after hours.
        main_adapter_state = {
            key: value.detach().cpu().clone()
            for key, value in get_peft_model_state_dict(model).items()
        }
        try:
            model, post_report = run_hard_example_sft(
                model, processor, train_dataset, val_dataset, profile
            )
        except Exception as exc:
            set_peft_model_state_dict(model, main_adapter_state)
            post_report = {
                "enabled": True,
                "accepted": False,
                "failed": True,
                "error": f"{type(exc).__name__}: {exc}",
            }
            print(
                "Hard-example SFT failed; restored main-SFT adapter and continuing "
                f"to merge: {type(exc).__name__}: {exc}",
                flush=True,
            )
        timing["hard_example"] = post_report

    print("Merging and saving weights...", flush=True)
    merge_started = time.perf_counter()
    merged_model = model.merge_and_unload()
    configure_generation(merged_model)
    if CANDIDATE_DIR.exists():
        shutil.rmtree(CANDIDATE_DIR)
    CANDIDATE_DIR.mkdir(parents=True, exist_ok=True)
    merged_model.save_pretrained(CANDIDATE_DIR)
    processor.save_pretrained(CANDIDATE_DIR)
    timing["merge_seconds"] = time.perf_counter() - merge_started
    print(f"Candidate model saved to: {CANDIDATE_DIR}", flush=True)

    if not args.merge_only:
        print("Running final prompt-only benchmark on held-out test split...", flush=True)
        max_samples = FINAL_TEST_MAX_SAMPLES or None
        benchmark_started = time.perf_counter()
        metrics, samples = run_generation_benchmark(
            merged_model,
            processor,
            test_dataset,
            split_name="test",
            max_samples=max_samples,
            title="FINAL TEST BENCHMARK",
            worst_count=10,
        )
        timing["benchmark_seconds"] = time.perf_counter() - benchmark_started
        timing["training_seconds"] = timing.get("main_sft_seconds", 0) + (
            timing.get("hard_example", {}).get("mining_seconds", 0)
            + timing.get("hard_example", {}).get("post_sft_seconds", 0)
        )
        timing["total_seconds"] = time.time() - timing["started_at_unix"]
        gate = save_benchmark(
            CANDIDATE_DIR / "benchmark_test.json",
            metrics,
            samples,
            training_seconds=timing["training_seconds"],
        )
        profile.update(timing)
        profile["quality_gate"] = gate
        save_profile(profile)
        if gate["release_ready"]:
            promote_candidate()
        else:
            print(
                f"Candidate rejected and kept for inspection: {CANDIDATE_DIR}",
                flush=True,
            )


if __name__ == "__main__":
    main()
