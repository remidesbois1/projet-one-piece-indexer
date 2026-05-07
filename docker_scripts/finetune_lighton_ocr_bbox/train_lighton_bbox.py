import os
import sys
import re
import builtins

builtins.PeftConfigLike = object

import torch
import numpy as np
from PIL import Image
from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from transformers import (
    LightOnOcrForConditionalGeneration,
    LightOnOcrProcessor,
    Seq2SeqTrainingArguments,
    Seq2SeqTrainer,
    TrainerCallback,
)
from Levenshtein import distance as levenshtein_distance
import jiwer


def compute_cer(predictions, references):
    transform = jiwer.Compose(
        [
            jiwer.RemoveMultipleSpaces(),
            jiwer.Strip(),
            jiwer.ReduceToListOfListOfChars(),
        ]
    )
    total_edits = 0
    total_chars = 0
    for pred, ref in zip(predictions, references):
        if not ref:
            continue
        measures = jiwer.process_words(
            [" ".join(ref)],
            [" ".join(pred)],
            reference_transform=transform,
            hypothesis_transform=transform,
        )
        total_edits += measures.substitutions + measures.deletions + measures.insertions
        total_chars += len(ref)
    return total_edits / max(total_chars, 1)


def compute_wer(predictions, references):
    filtered = [(p, r) for p, r in zip(predictions, references) if r]
    if not filtered:
        return 1.0
    preds, refs = zip(*filtered)
    return jiwer.wer(list(refs), list(preds))


torch.set_num_threads(8)
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
torch.backends.cudnn.benchmark = True
if hasattr(torch, "compile"):
    torch._dynamo.config.suppress_errors = True

BASE_PATH = "./lighton_bbox_dataset"
TRAIN_FILE = os.path.join(BASE_PATH, "train", "metadata.jsonl")
TEST_FILE = os.path.join(BASE_PATH, "test", "metadata.jsonl")

MODEL_ID = "lightonai/LightOnOCR-2-1B-bbox-base"
OUTPUT_DIR = "./outputs_lighton_bbox"
LOGS_DIR = "./logs"

BBOX_PATTERN = re.compile(r"(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]")


def parse_bbox_output(text):
    results = []
    for line in text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        match = BBOX_PATTERN.match(line)
        if match:
            bubble_text = match.group(1).strip()
            x1, y1, x2, y2 = (
                int(match.group(2)),
                int(match.group(3)),
                int(match.group(4)),
                int(match.group(5)),
            )
            results.append({"text": bubble_text, "bbox": [x1, y1, x2, y2]})
    return results


def compute_iou(box_a, box_b):
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])

    inter_w = max(0, x2 - x1)
    inter_h = max(0, y2 - y1)
    inter_area = inter_w * inter_h

    area_a = (box_a[2] - box_a[0]) * (box_a[3] - box_a[1])
    area_b = (box_b[2] - box_b[0]) * (box_b[3] - box_b[1])
    union_area = area_a + area_b - inter_area

    if union_area <= 0:
        return 0.0
    return inter_area / union_area


def match_predictions_to_ground_truth(pred_items, gt_items, iou_threshold=0.5):
    if not pred_items or not gt_items:
        return [], list(range(len(gt_items))), list(range(len(pred_items)))

    iou_matrix = np.zeros((len(pred_items), len(gt_items)))
    for i, pred in enumerate(pred_items):
        for j, gt in enumerate(gt_items):
            iou_matrix[i, j] = compute_iou(pred["bbox"], gt["bbox"])

    matched_pairs = []
    used_preds = set()
    used_gts = set()

    while True:
        if iou_matrix.size == 0:
            break
        max_idx = np.unravel_index(np.argmax(iou_matrix), iou_matrix.shape)
        max_iou = iou_matrix[max_idx]
        if max_iou < iou_threshold:
            break

        pred_idx, gt_idx = max_idx
        if pred_idx in used_preds or gt_idx in used_gts:
            iou_matrix[pred_idx, gt_idx] = 0
            continue

        matched_pairs.append((pred_idx, gt_idx, max_iou))
        used_preds.add(pred_idx)
        used_gts.add(gt_idx)
        iou_matrix[pred_idx, :] = 0
        iou_matrix[:, gt_idx] = 0

    unmatched_gts = [j for j in range(len(gt_items)) if j not in used_gts]
    unmatched_preds = [i for i in range(len(pred_items)) if i not in used_preds]

    return matched_pairs, unmatched_gts, unmatched_preds


def prepare_dataset(file_path):
    print(f"Loading dataset from {file_path}...", flush=True)
    dataset = load_dataset("json", data_files=file_path, split="train")
    return dataset


def process_batch(examples, processor, split_name="train"):
    batch_texts = []
    batch_images = []
    prompts_for_masking = []

    for i in range(len(examples["messages"])):
        example_messages = examples["messages"][i]
        example_images = []
        clean_messages = []

        for msg in example_messages:
            clean_content = []
            for content in msg["content"]:
                if content["type"] == "image":
                    img_path = content["image"]
                    path_to_img = os.path.join(BASE_PATH, split_name, img_path)
                    if not os.path.exists(path_to_img):
                        for alt_split in ["train", "test"]:
                            alt_path = os.path.join(BASE_PATH, alt_split, img_path)
                            if os.path.exists(alt_path):
                                path_to_img = alt_path
                                break

                    if os.path.exists(path_to_img):
                        with Image.open(path_to_img) as img:
                            example_images.append(img.convert("RGB"))
                        clean_content.append({"type": "image"})
                    else:
                        print(f"⚠️ Image not found: {img_path}", flush=True)
                else:
                    clean_content.append(content)
            clean_messages.append({"role": msg["role"], "content": clean_content})

        text = processor.apply_chat_template(
            clean_messages, add_generation_prompt=False, tokenize=False
        )
        batch_texts.append(text)
        batch_images.extend(example_images)
        prompts_for_masking.append(clean_messages[:-1])

    model_inputs = processor(
        text=batch_texts, images=batch_images, padding=True, return_tensors="pt"
    )

    labels = model_inputs["input_ids"].clone()

    for i in range(len(batch_texts)):
        prompt_text = processor.apply_chat_template(
            prompts_for_masking[i], add_generation_prompt=True, tokenize=False
        )

        n_images = sum(
            1
            for msg in prompts_for_masking[i]
            for content in msg["content"]
            if content["type"] == "image"
        )

        p_imgs = batch_images[i : i + n_images] if n_images > 0 else None
        p_inputs = processor(text=[prompt_text], images=p_imgs, return_tensors="pt")
        prompt_len = p_inputs["input_ids"].shape[1]

        batch_seq_len = labels.shape[1]

        if processor.tokenizer.padding_side == "left":
            full_inputs = processor(
                text=[batch_texts[i]], images=p_imgs, return_tensors="pt"
            )
            assistant_len = full_inputs["input_ids"].shape[1] - prompt_len
            mask_until = batch_seq_len - assistant_len
            labels[i, :mask_until] = -100
        else:
            labels[i, :prompt_len] = -100
            padding_mask = (
                model_inputs["input_ids"][i] == processor.tokenizer.pad_token_id
            )
            labels[i, padding_mask] = -100

    model_inputs["labels"] = labels
    return model_inputs


class CustomDataCollator:
    def __init__(self, processor, split_name="train"):
        self.processor = processor
        self.split_name = split_name

    def __call__(self, features):
        batch_dict = {"messages": [f["messages"] for f in features]}
        return process_batch(batch_dict, self.processor, self.split_name)


def run_generation_check(model, processor, dataset, split_name, n_samples=3):
    model.eval()
    device = next(model.parameters()).device
    P = lambda msg: print(msg, flush=True)
    P("\n" + "=" * 70)
    P(f" GENERATION CHECK ({n_samples} samples from {split_name})")
    P("=" * 70)

    indices = list(range(min(n_samples, len(dataset))))
    for idx in indices:
        entry = dataset[idx]
        msgs = entry["messages"]

        gt_text = ""
        for msg in msgs:
            if msg["role"] == "assistant":
                for c in msg["content"]:
                    if "text" in c:
                        gt_text = c["text"]

        user_msgs = [m for m in msgs if m["role"] != "assistant"]
        images = []
        clean_user = []
        for msg in user_msgs:
            clean_content = []
            for c in msg["content"]:
                if c["type"] == "image":
                    img_path = c.get("image", "")
                    full_path = os.path.join(BASE_PATH, split_name, img_path)
                    if os.path.exists(full_path):
                        images.append(Image.open(full_path).convert("RGB"))
                    clean_content.append({"type": "image"})
                else:
                    clean_content.append(c)
            clean_user.append({"role": msg["role"], "content": clean_content})

        prompt = processor.apply_chat_template(
            clean_user, add_generation_prompt=True, tokenize=False
        )
        inputs = processor(
            text=[prompt], images=images if images else None, return_tensors="pt"
        )
        inputs = {k: v.to(device) for k, v in inputs.items()}

        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=512, do_sample=False)
        gen_ids = out[0, inputs["input_ids"].shape[1] :]
        pred_text = processor.tokenizer.decode(
            gen_ids, skip_special_tokens=True
        ).strip()

        P(f"\n--- Sample {idx} ---")
        P(f"  GT  (first 200): {gt_text[:200]}")
        P(f"  PRED(first 200): {pred_text[:200]}")

        pred_items = parse_bbox_output(pred_text)
        gt_items = parse_bbox_output(gt_text)
        P(f"  GT bubbles: {len(gt_items)}, PRED bubbles: {len(pred_items)}")

    P("=" * 70 + "\n")
    model.train()


class LiveMetricsCallback(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        if logs is None:
            return
        step = state.global_step
        parts = [f"step={step}"]
        for key in [
            "loss",
            "learning_rate",
            "eval_loss",
            "eval_cer",
            "eval_wer",
            "eval_mean_iou",
            "eval_f1_50",
            "eval_combined_score",
            "eval_exact_match",
        ]:
            if key in logs:
                val = logs[key]
                parts.append(
                    f"{key}={val:.6f}" if isinstance(val, float) else f"{key}={val}"
                )
        print(f"[LIVE] {' | '.join(parts)}", flush=True)

    def on_evaluate(self, args, state, control, metrics=None, **kwargs):
        if metrics is None:
            return
        step = state.global_step
        print(f"\n{'=' * 70}", flush=True)
        print(f" EVAL @ step {step}", flush=True)
        for k, v in sorted(metrics.items()):
            if isinstance(v, float):
                print(f"  {k}: {v:.6f}", flush=True)
            else:
                print(f"  {k}: {v}", flush=True)
        print(f"{'=' * 70}\n", flush=True)

        cer = metrics.get("eval_cer", 1.0)
        combined = metrics.get("eval_combined_score", 0.0)
        if cer == 0.0 and combined >= 0.99:
            print(f"\n{'#' * 70}", flush=True)
            print(f"  NEAR-PERFECT SCORE @ step {step}", flush=True)
            print(f"  CER={cer:.4f}, Combined={combined:.4f}", flush=True)
            print(f"  Stopping training early.", flush=True)
            print(f"{'#' * 70}\n", flush=True)
            control.should_training_stop = True


if __name__ == "__main__":
    print(f"Loading processor for {MODEL_ID}...", flush=True)
    processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
    processor.image_processor.default_to_square = False
    processor.tokenizer.padding_side = "left"

    merge_only = "--merge-only" in sys.argv

    if not merge_only:
        train_dataset = prepare_dataset(TRAIN_FILE)
        test_dataset = prepare_dataset(TEST_FILE)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16

    print(f"Loading model in {dtype} on {device}...", flush=True)
    model = LightOnOcrForConditionalGeneration.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        device_map={"": "cuda:0"},
        attn_implementation="sdpa",
    )

    peft_config = LoraConfig(
        r=64,
        lora_alpha=128,
        use_dora=True,
        target_modules=[
            "q_proj",
            "v_proj",
            "k_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
            "lm_head",
        ],
        lora_dropout=0.01,
        bias="none",
        task_type="CAUSAL_LM",
    )

    if not merge_only:
        model = get_peft_model(model, peft_config)
        model.print_trainable_parameters()

    model.generation_config.do_sample = False
    model.generation_config.max_new_tokens = 2048
    model.generation_config.max_length = None
    model.generation_config.temperature = None
    model.generation_config.top_p = None
    model.generation_config.top_k = None

    if not merge_only:
        training_args = Seq2SeqTrainingArguments(
            output_dir=OUTPUT_DIR,
            learning_rate=5e-5,
            num_train_epochs=25,
            per_device_train_batch_size=1,
            per_device_eval_batch_size=1,
            gradient_accumulation_steps=8,
            gradient_checkpointing=True,
            optim="paged_adamw_8bit",
            bf16=True,
            fp16=False,
            logging_steps=5,
            eval_strategy="steps",
            eval_steps=50,
            save_strategy="steps",
            save_steps=50,
            save_total_limit=3,
            load_best_model_at_end=True,
            metric_for_best_model="eval_loss",
            greater_is_better=False,
            remove_unused_columns=False,
            report_to="none",
            predict_with_generate=False,
            dataloader_num_workers=0,
            dataloader_pin_memory=True,
            torch_compile=False,
            lr_scheduler_type="cosine",
            warmup_ratio=0.10,
            weight_decay=0.01,
        )

        train_collator = CustomDataCollator(processor, split_name="train")
        eval_collator = CustomDataCollator(processor, split_name="test")

        trainer = Seq2SeqTrainer(
            model=model,
            args=training_args,
            train_dataset=train_dataset,
            eval_dataset=test_dataset,
            data_collator=train_collator,
            callbacks=[LiveMetricsCallback()],
        )

    merge_only = "--merge-only" in sys.argv

    if merge_only:
        import glob

        checkpoints = sorted(
            glob.glob(os.path.join(OUTPUT_DIR, "checkpoint-*")), key=os.path.getmtime
        )
        if not checkpoints:
            print("No checkpoints found. Run training first.")
            sys.exit(1)
        latest = checkpoints[-1]
        print(f"Loading checkpoint: {latest}", flush=True)
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, latest)
    else:
        print("Starting Fine-Tuning LightOnOCR bbox...", flush=True)
        trainer.train()

        print("\nFinal Eval Loss...", flush=True)
        final_metrics = trainer.evaluate()
        print(f"Final eval_loss: {final_metrics.get('eval_loss', 'N/A')}", flush=True)

        print("\nRunning generation check on test set...", flush=True)
        run_generation_check(model, processor, test_dataset, "test", n_samples=5)

    final_path = os.path.join(OUTPUT_DIR, "final_lora_merged")
    print("Merging and saving weights...", flush=True)
    merged_model = model.merge_and_unload()
    merged_model.generation_config.do_sample = False
    merged_model.generation_config.temperature = None
    merged_model.generation_config.top_p = None
    merged_model.generation_config.top_k = None
    merged_model.generation_config.max_length = None
    merged_model.generation_config.max_new_tokens = 2048
    merged_model.save_pretrained(final_path)
    processor.save_pretrained(final_path)
    print(f"Model saved to: {final_path}", flush=True)
