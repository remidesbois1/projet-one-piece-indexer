import argparse
import glob
import json
import os
import random
import sys
from pathlib import Path

import jiwer
import numpy as np
import torch
from datasets import load_dataset
from Levenshtein import distance as levenshtein_distance
from peft import LoraConfig, PeftModel, get_peft_model
from PIL import Image
from transformers import (
    LightOnOcrForConditionalGeneration,
    LightOnOcrProcessor,
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


def parse_args():
    parser = argparse.ArgumentParser(description="Fine-tune LightOnOCR for manga bubble OCR.")
    parser.add_argument("--merge-only", action="store_true", help="Merge the best LoRA checkpoint and exit.")
    parser.add_argument("--benchmark-only", action="store_true", help="Benchmark an already merged model on the test split.")
    parser.add_argument("--model-path", default=None, help="Model path for --benchmark-only. Defaults to final_lora_merged.")
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


def process_batch(examples, processor):
    batch_texts = []
    batch_images = []
    images_per_example = []
    prompts_for_masking = []

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
        images_per_example.append(example_images)
        prompts_for_masking.append(
            [msg for msg in clean_messages if msg.get("role") != "assistant"]
        )

    model_inputs = processor(
        text=batch_texts,
        images=batch_images if batch_images else None,
        padding=True,
        return_tensors="pt",
    )

    labels = model_inputs["input_ids"].clone()
    pad_token_id = processor.tokenizer.pad_token_id

    for idx, full_text in enumerate(batch_texts):
        prompt_text = processor.apply_chat_template(
            prompts_for_masking[idx],
            add_generation_prompt=True,
            tokenize=False,
        )
        example_images = images_per_example[idx] or None

        prompt_inputs = processor(
            text=[prompt_text],
            images=example_images,
            return_tensors="pt",
        )
        full_inputs = processor(
            text=[full_text],
            images=example_images,
            return_tensors="pt",
        )

        prompt_len = prompt_inputs["input_ids"].shape[1]
        full_len = full_inputs["input_ids"].shape[1]
        assistant_len = max(full_len - prompt_len, 0)

        if processor.tokenizer.padding_side == "left":
            mask_until = labels.shape[1] - assistant_len
            labels[idx, :mask_until] = -100
        else:
            labels[idx, :prompt_len] = -100

        if pad_token_id is not None:
            labels[idx, model_inputs["input_ids"][idx] == pad_token_id] = -100

    model_inputs["labels"] = labels
    return model_inputs


class CustomDataCollator:
    def __init__(self, processor):
        self.processor = processor

    def __call__(self, features):
        batch = {
            "messages": [feature["messages"] for feature in features],
            "split": [feature.get("split") for feature in features],
        }
        return process_batch(batch, self.processor)


def postprocess_prediction(text):
    text = text.strip()
    if "\n" in text:
        text = text.splitlines()[0].strip()
    return text


def sample_cer(prediction, reference):
    if not reference:
        return 0.0 if not prediction else 1.0
    return levenshtein_distance(prediction, reference) / max(len(reference), 1)


def compute_text_metrics(samples):
    references = [sample["reference"] for sample in samples if sample["reference"]]
    predictions = [sample["prediction"] for sample in samples if sample["reference"]]

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

    return {
        "cer": cer,
        "wer": wer,
        "exact_match": exact_matches / len(references),
        "avg_levenshtein": avg_lev,
        "blank_rate": blank_rate,
        "multiline_rate": multiline_rate,
    }


def model_dtype(model):
    for param in model.parameters():
        if param.is_floating_point():
            return param.dtype
    return torch.float32


def move_inputs_to_device(inputs, device, dtype):
    moved = {}
    for key, value in inputs.items():
        if value.is_floating_point():
            moved[key] = value.to(device=device, dtype=dtype)
        else:
            moved[key] = value.to(device=device)
    return moved


def generate_prediction(model, processor, entry):
    split_name = entry.get("split") or "test"
    clean_messages, images = clean_messages_and_load_images(
        entry["messages"],
        split_name,
        include_assistant=False,
    )
    prompt = processor.apply_chat_template(
        clean_messages,
        add_generation_prompt=True,
        tokenize=False,
    )

    inputs = processor(
        text=[prompt],
        images=images if images else None,
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

    gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    return processor.tokenizer.decode(gen_ids, skip_special_tokens=True).strip()


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
    worst_count=5,
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

    for sample_idx, dataset_idx in enumerate(indices, 1):
        entry = dataset[dataset_idx]
        reference = extract_reference_text(entry)
        raw_prediction = generate_prediction(model, processor, entry)
        prediction = postprocess_prediction(raw_prediction)
        item_cer = sample_cer(prediction, reference)

        samples.append(
            {
                "dataset_idx": dataset_idx,
                "id": entry.get("id"),
                "page_id": entry.get("page_id"),
                "reference": reference,
                "prediction": prediction,
                "raw_prediction": raw_prediction,
                "cer": item_cer,
                "levenshtein": levenshtein_distance(prediction, reference),
            }
        )

        if sample_idx % 50 == 0 or sample_idx == len(indices):
            print(f"  generated {sample_idx}/{len(indices)}", flush=True)

    metrics = compute_text_metrics(samples)
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


def save_benchmark(path, metrics, samples):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"metrics": metrics, "samples": samples}, f, ensure_ascii=False, indent=2)
    print(f"Benchmark saved to {path}", flush=True)


def configure_processor():
    print(f"Loading processor for {MODEL_ID}...", flush=True)
    processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
    processor.image_processor.default_to_square = False
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
    }
    if device == "cuda":
        kwargs["device_map"] = {"": "cuda:0"}

    model = LightOnOcrForConditionalGeneration.from_pretrained(MODEL_ID, **kwargs)
    if device != "cuda":
        model.to(device)

    configure_generation(model)
    return model


def build_peft_config():
    lora_r = int(os.getenv("LIGHTON_LORA_R", "65"))
    lora_alpha = int(os.getenv("LIGHTON_LORA_ALPHA", str(lora_r * 2)))
    use_dora = os.getenv("LIGHTON_USE_DORA", "1") not in {"0", "false", "False"}

    return LoraConfig(
        r=lora_r,
        lora_alpha=lora_alpha,
        use_dora=use_dora,
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
            "lm_head",
        ],
        lora_dropout=float(os.getenv("LIGHTON_LORA_DROPOUT", "0.01")),
        bias="none",
        task_type="CAUSAL_LM",
    )


def main():
    args = parse_args()
    random.seed(RANDOM_SEED)
    np.random.seed(RANDOM_SEED)
    torch.manual_seed(RANDOM_SEED)

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32

    if args.benchmark_only:
        model_path = args.model_path or str(FINAL_DIR)
        print(f"Loading merged model for benchmark: {model_path}", flush=True)
        model_kwargs = {"torch_dtype": dtype}
        if torch.cuda.is_available():
            model_kwargs["device_map"] = {"": "cuda:0"}
        model = LightOnOcrForConditionalGeneration.from_pretrained(
            model_path,
            **model_kwargs,
        ).eval()
        processor = LightOnOcrProcessor.from_pretrained(model_path)
        processor.image_processor.default_to_square = False
        processor.tokenizer.padding_side = "left"
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
        save_benchmark(Path(model_path) / "benchmark_test.json", metrics, samples)
        return

    processor = configure_processor()

    model = load_base_model(dtype)

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

        train_batch = int(os.getenv("LIGHTON_TRAIN_BATCH", "8"))
        eval_batch = int(os.getenv("LIGHTON_EVAL_BATCH", "8"))
        grad_accum = int(os.getenv("LIGHTON_GRAD_ACCUM", "2"))
        eval_steps = int(os.getenv("LIGHTON_EVAL_STEPS", "100"))

        training_args = Seq2SeqTrainingArguments(
            output_dir=str(OUTPUT_DIR),
            learning_rate=float(os.getenv("LIGHTON_LR", "5e-5")),
            num_train_epochs=float(os.getenv("LIGHTON_EPOCHS", "8")),
            per_device_train_batch_size=train_batch,
            per_device_eval_batch_size=eval_batch,
            gradient_accumulation_steps=grad_accum,
            gradient_checkpointing=True,
            gradient_checkpointing_kwargs={"use_reentrant": False},
            optim="adamw_torch_fused" if torch.cuda.is_available() else "adamw_torch",
            bf16=torch.cuda.is_available(),
            fp16=False,
            logging_steps=int(os.getenv("LIGHTON_LOGGING_STEPS", "10")),
            eval_strategy="steps",
            eval_steps=eval_steps,
            save_strategy="steps",
            save_steps=eval_steps,
            save_total_limit=int(os.getenv("LIGHTON_SAVE_TOTAL_LIMIT", "3")),
            load_best_model_at_end=True,
            metric_for_best_model="eval_cer",
            greater_is_better=False,
            remove_unused_columns=False,
            report_to="none",
            predict_with_generate=False,
            dataloader_num_workers=int(os.getenv("LIGHTON_DATALOADER_WORKERS", "4")),
            dataloader_pin_memory=True,
            torch_compile=False,
            lr_scheduler_type=os.getenv("LIGHTON_LR_SCHEDULER", "cosine"),
            warmup_ratio=float(os.getenv("LIGHTON_WARMUP_RATIO", "0.05")),
            weight_decay=float(os.getenv("LIGHTON_WEIGHT_DECAY", "0.01")),
            max_grad_norm=float(os.getenv("LIGHTON_MAX_GRAD_NORM", "1.0")),
            seed=RANDOM_SEED,
            data_seed=RANDOM_SEED,
        )

        trainer = PromptOnlyEvalTrainer(
            model=model,
            args=training_args,
            train_dataset=train_dataset,
            eval_dataset=val_dataset,
            data_collator=CustomDataCollator(processor),
            callbacks=[LiveMetricsCallback()],
            processor=processor,
            gen_eval_max_samples=GEN_EVAL_MAX_SAMPLES,
        )

        print("Starting Fine-Tuning LightOnOCR crop OCR...", flush=True)
        trainer.train()

        best_checkpoint = trainer.state.best_model_checkpoint or find_best_checkpoint(OUTPUT_DIR)
        print(f"Best checkpoint: {best_checkpoint}", flush=True)

        model = trainer.model

    print("Merging and saving weights...", flush=True)
    merged_model = model.merge_and_unload()
    configure_generation(merged_model)
    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    merged_model.save_pretrained(FINAL_DIR)
    processor.save_pretrained(FINAL_DIR)
    print(f"Model saved to: {FINAL_DIR}", flush=True)

    if not args.merge_only:
        print("Running final prompt-only benchmark on held-out test split...", flush=True)
        max_samples = FINAL_TEST_MAX_SAMPLES or None
        metrics, samples = run_generation_benchmark(
            merged_model,
            processor,
            test_dataset,
            split_name="test",
            max_samples=max_samples,
            title="FINAL TEST BENCHMARK",
            worst_count=10,
        )
        save_benchmark(FINAL_DIR / "benchmark_test.json", metrics, samples)


if __name__ == "__main__":
    main()
