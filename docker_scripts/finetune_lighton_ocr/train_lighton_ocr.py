import os
import sys
import torch
import evaluate
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

# Optimized for RTX 5090 (32GB VRAM)
torch.set_num_threads(8)
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
torch.backends.cudnn.benchmark = True
if hasattr(torch, "compile"):
    torch._dynamo.config.suppress_errors = True

BASE_PATH = "./lighton_dataset"
TRAIN_FILE = os.path.join(BASE_PATH, "train", "metadata.jsonl")
TEST_FILE = os.path.join(BASE_PATH, "test", "metadata.jsonl")

MODEL_ID = "lightonai/LightOnOCR-2-1B-base"
OUTPUT_DIR = "./outputs_lighton_manga"
LOGS_DIR = "./logs"


def prepare_dataset(file_path):
    print(f"Loading dataset from {file_path}...")
    dataset = load_dataset("json", data_files=file_path, split="train")
    return dataset


def process_batch(examples, processor):
    batch_texts = []
    batch_images = []
    prompts_for_masking = []

    for i in range(len(examples["messages"])):
        example_messages = examples["messages"][i]
        example_images = []
        clean_messages = []

        # Identify images and text
        for msg in example_messages:
            clean_content = []
            for content in msg["content"]:
                if content["type"] == "image":
                    img_path = content["image"]
                    path_to_img = os.path.join(BASE_PATH, "train", img_path)
                    if not os.path.exists(path_to_img):
                        path_to_img = os.path.join(BASE_PATH, "test", img_path)

                    if os.path.exists(path_to_img):
                        with Image.open(path_to_img) as img:
                            example_images.append(img.convert("RGB"))
                        clean_content.append({"type": "image"})
                    else:
                        print(f"⚠️ Image not found: {img_path}")
                else:
                    clean_content.append(content)
            clean_messages.append({"role": msg["role"], "content": clean_content})

        # Ajout d'une consigne stricte pour eviter les hallucinations
        if clean_messages[0]["role"] == "user":
            clean_messages[0]["content"].append(
                {
                    "type": "text",
                    "text": "\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :",
                }
            )

        # Apply chat template
        text = processor.apply_chat_template(
            clean_messages, add_generation_prompt=False, tokenize=False
        )
        batch_texts.append(text)
        batch_images.extend(example_images)

        # Store for label masking
        prompts_for_masking.append(clean_messages[:-1])

    # Processor call (once per batch)
    model_inputs = processor(
        text=batch_texts, images=batch_images, padding=True, return_tensors="pt"
    )

    # Target labeling: copy input_ids and mask prompt
    labels = model_inputs["input_ids"].clone()

    # Efficient masking without redundant processor calls
    # We use processor.tokenizer to handle text part and assume image tokens are constant
    for i in range(len(batch_texts)):
        prompt_text = processor.apply_chat_template(
            prompts_for_masking[i], add_generation_prompt=True, tokenize=False
        )

        # Get count of images in this example
        n_images = sum(
            1
            for msg in prompts_for_masking[i]
            for content in msg["content"]
            if content["type"] == "image"
        )

        # Temporary call to get exact prompt length including visual tokens
        # Still faster than the previous double-loading-image approach
        p_imgs = batch_images[i : i + n_images] if n_images > 0 else None
        p_inputs = processor(text=[prompt_text], images=p_imgs, return_tensors="pt")
        prompt_len = p_inputs["input_ids"].shape[1]

        # Calculate assistant response length (excluding padding in batch)
        # full_inputs = processor(text=[batch_texts[i]], images=p_imgs, return_tensors="pt")
        # full_len = full_inputs["input_ids"].shape[1]

        # Labels are padded to model_inputs["input_ids"].shape[1]
        batch_seq_len = labels.shape[1]

        # Determine assistant length by looking at our tokens
        # Faster: search for the end of prompt tokens in the labels sequence
        # But safest is to use the calculated offset

        if processor.tokenizer.padding_side == "left":
            # Mask everything from start of batch sequence until (last_token - assistant_text_len)
            # Actually simpler: mask everything except the last N tokens that correspond to the response
            # We need to know response token count
            full_inputs = processor(
                text=[batch_texts[i]], images=p_imgs, return_tensors="pt"
            )
            assistant_len = full_inputs["input_ids"].shape[1] - prompt_len
            mask_until = batch_seq_len - assistant_len
            labels[i, :mask_until] = -100
        else:
            labels[i, :prompt_len] = -100
            # Mask padding at the end
            padding_mask = (
                model_inputs["input_ids"][i] == processor.tokenizer.pad_token_id
            )
            labels[i, padding_mask] = -100

    model_inputs["labels"] = labels
    return model_inputs


class CustomDataCollator:
    def __init__(self, processor):
        self.processor = processor

    def __call__(self, features):
        batch_dict = {"messages": [f["messages"] for f in features]}
        return process_batch(batch_dict, self.processor)


# Load metrics
cer_metric = evaluate.load("cer")
wer_metric = evaluate.load("wer")


def compute_metrics(eval_preds):
    preds, labels = eval_preds

    if isinstance(preds, tuple):
        preds = preds[0]

    all_preds_decoded = []
    all_labels_decoded = []

    pad_id = (
        processor.tokenizer.pad_token_id
        if processor.tokenizer.pad_token_id is not None
        else processor.tokenizer.eos_token_id
    )

    for i in range(len(labels)):
        # Indices where label is not -100 or PAD
        label_mask = (labels[i] != -100) & (labels[i] != pad_id)
        valid_label_ids = labels[i][label_mask].astype(np.int64)
        valid_label_ids = valid_label_ids[valid_label_ids >= 0]

        # Decode Ground Truth
        label_decoded = processor.tokenizer.decode(
            valid_label_ids, skip_special_tokens=True
        ).strip()

        # Find where labels start (first non-mask)
        first_valid_label_idx = np.where(labels[i] != -100)[0]
        if len(first_valid_label_idx) > 0:
            idx = first_valid_label_idx[0]
            # Slice and cast to int64 to prevent OverflowError in Rust tokenizer
            raw_pred_ids = preds[i][idx:]
            valid_pred_ids = raw_pred_ids[raw_pred_ids >= 0].astype(np.int64)
            decoded_p = processor.tokenizer.decode(
                valid_pred_ids, skip_special_tokens=True
            ).strip()
        else:
            raw_pred_ids = preds[i]
            valid_pred_ids = raw_pred_ids[raw_pred_ids >= 0].astype(np.int64)
            decoded_p = processor.tokenizer.decode(
                valid_pred_ids, skip_special_tokens=True
            ).strip()

        all_preds_decoded.append(decoded_p)
        all_labels_decoded.append(label_decoded)

    # Filter empty labels
    final_preds = []
    final_labels = []
    for p, l in zip(all_preds_decoded, all_labels_decoded):
        if len(l) > 0:
            final_preds.append(p)
            final_labels.append(l)

    if not final_labels:
        return {"cer": 0, "wer": 0, "exact_match": 0, "avg_levenshtein": 0}

    cer = cer_metric.compute(predictions=final_preds, references=final_labels)
    wer = wer_metric.compute(predictions=final_preds, references=final_labels)

    exact_matches = sum(1 for p, l in zip(final_preds, final_labels) if p == l)
    exact_match_rate = exact_matches / len(final_labels)
    lev_distances = [
        levenshtein_distance(p, l) for p, l in zip(final_preds, final_labels)
    ]
    avg_lev = sum(lev_distances) / len(lev_distances)

    per_sample_cer = []
    for p, l in zip(final_preds, final_labels):
        s_cer = cer_metric.compute(predictions=[p], references=[l]) if l else 0.0
        per_sample_cer.append(s_cer)

    ranked = sorted(
        range(len(per_sample_cer)), key=lambda i: per_sample_cer[i], reverse=True
    )

    P = lambda msg: print(msg, flush=True)
    P("\n" + "=" * 60)
    P(" RESULTATS EVALUATION")
    P("-" * 60)
    P(f" CER:             {cer:.4f}  ({cer * 100:.2f}%)")
    P(f" WER:             {wer:.4f}  ({wer * 100:.2f}%)")
    P(
        f" Exact Match:     {exact_matches}/{len(final_labels)}  ({exact_match_rate * 100:.1f}%)"
    )
    P(f" Avg Levenshtein: {avg_lev:.2f} chars")
    P("-" * 60)

    # Top 5 worst errors
    n_show = min(5, len(ranked))
    P(f" TOP {n_show} PIRES ERREURS (tri par CER decroissant)")
    P("-" * 60)
    for rank, idx in enumerate(ranked[:n_show], 1):
        P(f"  #{rank}  CER={per_sample_cer[idx]:.4f}  Lev={lev_distances[idx]}")
        P(f"   REF:  {final_labels[idx]}")
        P(f"   PRED: {final_preds[idx]}")
        P("")
    P("=" * 60 + "\n")

    return {
        "cer": cer,
        "wer": wer,
        "exact_match": exact_match_rate,
        "avg_levenshtein": avg_lev,
    }


class LiveMetricsCallback(TrainerCallback):
    """Prints key metrics in real-time after every eval and log step."""

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
            "eval_exact_match",
            "eval_avg_levenshtein",
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
        print(f"\n{'=' * 60}", flush=True)
        print(f" EVAL @ step {step}", flush=True)
        for k, v in sorted(metrics.items()):
            if isinstance(v, float):
                print(f"  {k}: {v:.6f}", flush=True)
            else:
                print(f"  {k}: {v}", flush=True)
        print(f"{'=' * 60}\n", flush=True)

        cer = metrics.get("eval_cer", 1.0)
        wer = metrics.get("eval_wer", 1.0)
        if cer == 0.0 and wer == 0.0:
            print(f"\n{'#' * 60}", flush=True)
            print(f"  PERFECT SCORE @ step {step} (CER=0, WER=0)", flush=True)
            print(f"  Stopping training early.", flush=True)
            print(f"{'#' * 60}\n", flush=True)
            control.should_training_stop = True

        cer = metrics.get("eval_cer", 1.0)
        wer = metrics.get("eval_wer", 1.0)
        if cer == 0.0 and wer == 0.0:
            print(f"\n{'#' * 60}", flush=True)
            print(f"  PERFECT SCORE @ step {step} (CER=0, WER=0)", flush=True)
            print(f"  Stopping training early.", flush=True)
            print(f"{'#' * 60}\n", flush=True)
            control.should_training_stop = True


if __name__ == "__main__":
    print(f"Loading processor for {MODEL_ID}...", flush=True)
    processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)

    processor.image_processor.default_to_square = False
    print("Dynamic resolution enabled (default_to_square=False)", flush=True)

    processor.tokenizer.padding_side = "left"

    merge_only = "--merge-only" in sys.argv

    if not merge_only:
        train_dataset = prepare_dataset(TRAIN_FILE)
        test_dataset = prepare_dataset(TEST_FILE)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float32

    print(f"Loading model in full fp32...")
    model = LightOnOcrForConditionalGeneration.from_pretrained(
        MODEL_ID, torch_dtype=dtype, device_map="auto", attn_implementation="sdpa"
    )

    peft_config = LoraConfig(
        r=16,
        lora_alpha=32,
        target_modules=[
            "q_proj",
            "v_proj",
            "k_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )

    if not merge_only:
        model = get_peft_model(model, peft_config)
        model.print_trainable_parameters()

    model.generation_config.do_sample = False
    model.generation_config.max_new_tokens = 128
    model.generation_config.max_length = None
    model.generation_config.temperature = None
    model.generation_config.top_p = None
    model.generation_config.top_k = None

    if not merge_only:
        training_args = Seq2SeqTrainingArguments(
            output_dir=OUTPUT_DIR,
            learning_rate=1e-4,
            num_train_epochs=3,
            per_device_train_batch_size=4,
            per_device_eval_batch_size=4,
            gradient_accumulation_steps=2,
            gradient_checkpointing=True,
            optim="adamw_torch_fused",
            bf16=False,
            fp16=True,
            logging_steps=10,
            eval_strategy="steps",
            eval_steps=100,
            save_strategy="steps",
            save_steps=100,
            save_total_limit=2,
            load_best_model_at_end=True,
            metric_for_best_model="eval_cer",
            greater_is_better=False,
            remove_unused_columns=False,
            report_to="none",
            predict_with_generate=True,
            dataloader_num_workers=4,
            dataloader_pin_memory=True,
            torch_compile=False,
        )

        data_collator_fn = CustomDataCollator(processor)

        trainer = Seq2SeqTrainer(
            model=model,
            args=training_args,
            train_dataset=train_dataset,
            eval_dataset=test_dataset,
            data_collator=data_collator_fn,
            compute_metrics=compute_metrics,
            callbacks=[LiveMetricsCallback()],
        )

    merge_only = "--merge-only" in sys.argv

    if merge_only:
        import glob

        checkpoints = sorted(
            glob.glob(os.path.join(OUTPUT_DIR, "checkpoint-*")), key=os.path.getmtime
        )
        if not checkpoints:
            print("Aucun checkpoint trouve. Lancez l'entrainement d'abord.")
            sys.exit(1)
        latest = checkpoints[-1]
        print(f"Chargement du checkpoint: {latest}")
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, latest)
    else:
        print("Starting Fine-Tuning LightOnOCR...")
        trainer.train()

        print("\nFinal Evaluation...")
        final_metrics = trainer.evaluate()
        print(f"Final CER: {final_metrics.get('eval_cer', 'N/A')}")
        print(f"Final WER: {final_metrics.get('eval_wer', 'N/A')}")

    final_path = os.path.join(OUTPUT_DIR, "final_lora_merged")
    print("Fusion et sauvegarde des poids...")
    merged_model = model.merge_and_unload()
    merged_model.generation_config.do_sample = False
    merged_model.generation_config.temperature = None
    merged_model.generation_config.top_p = None
    merged_model.generation_config.top_k = None
    merged_model.generation_config.max_length = None
    merged_model.generation_config.max_new_tokens = 128
    merged_model.save_pretrained(final_path)
    processor.save_pretrained(final_path)
    print(f"Modele sauve dans : {final_path}")
