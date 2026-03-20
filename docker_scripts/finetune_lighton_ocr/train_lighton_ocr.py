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
    Seq2SeqTrainer
)

# Optimized for RTX 3090 (24GB VRAM)
torch.set_num_threads(8)
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True

BASE_PATH = "./lighton_dataset"
TRAIN_FILE = os.path.join(BASE_PATH, "train", "metadata.jsonl")
TEST_FILE = os.path.join(BASE_PATH, "test", "metadata.jsonl")

MODEL_ID = "lightonai/LightOnOCR-2-1B"
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
    
    for i in range(len(examples['messages'])):
        example_messages = examples['messages'][i]
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
            clean_messages[0]["content"].append({
                "type": "text", 
                "text": "\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :"
            })

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
        text=batch_texts,
        images=batch_images,
        padding=True,
        return_tensors="pt"
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
        n_images = sum(1 for msg in prompts_for_masking[i] for content in msg["content"] if content["type"] == "image")
        
        # Temporary call to get exact prompt length including visual tokens
        # Still faster than the previous double-loading-image approach
        p_imgs = batch_images[i:i+n_images] if n_images > 0 else None
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
            full_inputs = processor(text=[batch_texts[i]], images=p_imgs, return_tensors="pt")
            assistant_len = full_inputs["input_ids"].shape[1] - prompt_len
            mask_until = batch_seq_len - assistant_len
            labels[i, :mask_until] = -100
        else:
            labels[i, :prompt_len] = -100
            # Mask padding at the end
            padding_mask = model_inputs["input_ids"][i] == processor.tokenizer.pad_token_id
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
    
    pad_id = processor.tokenizer.pad_token_id if processor.tokenizer.pad_token_id is not None else processor.tokenizer.eos_token_id

    for i in range(len(labels)):
        # Indices where label is not -100 or PAD
        label_mask = (labels[i] != -100) & (labels[i] != pad_id)
        valid_label_ids = labels[i][label_mask].astype(np.int64)
        valid_label_ids = valid_label_ids[valid_label_ids >= 0]
        
        # Decode Ground Truth
        label_decoded = processor.tokenizer.decode(valid_label_ids, skip_special_tokens=True).strip()
        
        # Find where labels start (first non-mask)
        first_valid_label_idx = np.where(labels[i] != -100)[0]
        if len(first_valid_label_idx) > 0:
            idx = first_valid_label_idx[0]
            # Slice and cast to int64 to prevent OverflowError in Rust tokenizer
            raw_pred_ids = preds[i][idx:]
            valid_pred_ids = raw_pred_ids[raw_pred_ids >= 0].astype(np.int64)
            decoded_p = processor.tokenizer.decode(valid_pred_ids, skip_special_tokens=True).strip()
        else:
            raw_pred_ids = preds[i]
            valid_pred_ids = raw_pred_ids[raw_pred_ids >= 0].astype(np.int64)
            decoded_p = processor.tokenizer.decode(valid_pred_ids, skip_special_tokens=True).strip()

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
        return {"cer": 0, "wer": 0}
        
    cer = cer_metric.compute(predictions=final_preds, references=final_labels)
    wer = wer_metric.compute(predictions=final_preds, references=final_labels)
    
    # Pretty print results
    print("\n" + "="*50)
    print(" RESULTATS EVALUATION")
    print("-" * 50)
    print(f" CER: {cer:.4f} ({cer*100:.2f}%)")
    print(f" WER: {wer:.4f} ({wer*100:.2f}%)")
    print("-" * 50)
    
    # Print some examples (top 3)
    print(" ECHANTILLONS (TOP 3)")
    print("-" * 50)
    indices = np.random.choice(len(final_labels), min(3, len(final_labels)), replace=False)
    for idx in indices:
        print(f" REF:  {final_labels[idx]}")
        print(f" PRED: {final_preds[idx]}")
        print("-" * 30)
    print("=" * 50 + "\n")
    
    return {"cer": cer, "wer": wer}

if __name__ == "__main__":
    print(f"Loading processor for {MODEL_ID}...")
    processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
    
    # Use left-padding for generation
    processor.tokenizer.padding_side = "left"
    
    merge_only = "--merge-only" in sys.argv

    if not merge_only:
        train_dataset = prepare_dataset(TRAIN_FILE)
        test_dataset = prepare_dataset(TEST_FILE)
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

    print(f"Loading model in {dtype}...")
    model = LightOnOcrForConditionalGeneration.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        device_map="auto",
        attn_implementation="sdpa"
    )

    peft_config = LoraConfig(
        r=16,
        lora_alpha=32,
        target_modules=["q_proj", "v_proj", "k_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM"
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
            per_device_train_batch_size=2,
            per_device_eval_batch_size=2,
            gradient_accumulation_steps=8,
            gradient_checkpointing=True,
            optim="adamw_torch",
            bf16=dtype == torch.bfloat16,
            fp16=dtype == torch.float16,
            logging_steps=10,
            eval_strategy="steps",
            eval_steps=100,
            save_strategy="steps",
            save_steps=100,
            save_total_limit=2,
            remove_unused_columns=False,
            report_to="none",
            predict_with_generate=True,
            dataloader_num_workers=0
        )

        data_collator_fn = CustomDataCollator(processor)

        trainer = Seq2SeqTrainer(
            model=model,
            args=training_args,
            train_dataset=train_dataset,
            eval_dataset=test_dataset,
            data_collator=data_collator_fn,
            compute_metrics=compute_metrics
        )

    merge_only = "--merge-only" in sys.argv

    if merge_only:
        import glob
        checkpoints = sorted(glob.glob(os.path.join(OUTPUT_DIR, "checkpoint-*")), key=os.path.getmtime)
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
