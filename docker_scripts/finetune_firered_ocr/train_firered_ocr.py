import os
import torch
from datasets import load_dataset
from transformers import (
    AutoModelForCausalLM,
    AutoProcessor,
    TrainingArguments
)
from trl import SFTTrainer
from qwen_vl_utils import process_vision_info

torch.set_num_threads(8)
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True

BASE_PATH = "./firered_dataset"
TRAIN_FILE = os.path.join(BASE_PATH, "train", "metadata.jsonl")
TEST_FILE = os.path.join(BASE_PATH, "test", "metadata.jsonl")

MODEL_ID = "FireRedTeam/FireRed-OCR" 
OUTPUT_DIR = "./outputs_firered_manga"
LOGS_DIR = "./logs"

def format_image_path(example):
    for i, msg in enumerate(example["messages"]):
        if msg["role"] == "user":
            for j, content in enumerate(msg["content"]):
                if content["type"] == "image":
                    is_train = "train" in example.get("split_hint", TRAIN_FILE)
                    split_dir = os.path.join(BASE_PATH, "train" if is_train else "test")
                    abs_path = os.path.abspath(os.path.join(split_dir, content["image"]))
                    example["messages"][i]["content"][j]["image"] = f"file://{abs_path}"
    return example

def prepare_dataset(file_path):
    print(f"Loading dataset from {file_path}...")
    dataset = load_dataset("json", data_files=file_path, split="train")
    dataset = dataset.map(lambda x: {"split_hint": file_path})
    dataset = dataset.map(format_image_path, remove_columns=["split_hint"])
    return dataset

def formatting_prompts_func(example, processor):
    text = processor.apply_chat_template(
        example["messages"], tokenize=False, add_generation_prompt=False
    )
    
    image_inputs, video_inputs = process_vision_info(example["messages"])
    
    return {
        "text": text,
        "images": image_inputs,
        "videos": video_inputs
    }

def process_batch(examples, processor):
    texts = []
    images_list = []
    videos_list = []
    
    for i in range(len(examples['messages'])):
        example_messages = examples['messages'][i]
        text = processor.apply_chat_template(
            example_messages, tokenize=False, add_generation_prompt=False
        )
        texts.append(text)
        
        image_inputs, video_inputs = process_vision_info(example_messages)
        if image_inputs:
            images_list.extend(image_inputs)
        if video_inputs:
            videos_list.extend(video_inputs)
            
    kwargs = {}
    if images_list:
        kwargs["images"] = images_list
    if videos_list:
        kwargs["videos"] = videos_list
        
    model_inputs = processor(
        text=texts,
        padding=True,
        return_tensors="pt",
        **kwargs
    )
    
    return model_inputs

def custom_data_collator(features):
    batch = {}
    pass

if __name__ == "__main__":
    
    print("Loading processor...")
    processor = AutoProcessor.from_pretrained(
        MODEL_ID, 
        trust_remote_code=True
    )
    
    train_dataset = prepare_dataset(TRAIN_FILE)
    test_dataset = prepare_dataset(TEST_FILE)

    print(f"Loaded {len(train_dataset)} training examples and {len(test_dataset)} testing examples.")

    print("Loading model in bfloat16...")
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.bfloat16,
        attn_implementation="flash_attention_2",
        device_map="auto",
        trust_remote_code=True
    )

    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        learning_rate=2e-5,
        
        num_train_epochs=5,
        per_device_train_batch_size=1, 
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=16,
        gradient_checkpointing=True,
        optim="adamw_8bit",
        bf16=True,
        tf32=True,
        
        eval_strategy="steps",
        save_strategy="steps",
        eval_steps=100,
        save_steps=100,
        logging_steps=10,
        
        dataloader_num_workers=2,
        dataloader_pin_memory=True,
        
        logging_dir=LOGS_DIR,
        report_to="tensorboard",
        save_total_limit=2,
        remove_unused_columns=False,
        dataset_kwargs={"skip_prepare_dataset": True}
    )

    def sft_formatting_func(example):
        texts = []
        for i in range(len(example['messages'])):
            text = processor.apply_chat_template(
                example['messages'][i], tokenize=False, add_generation_prompt=False
            )
            texts.append(text)
        return texts
        
    print("Tokenizing datasets...")
    train_dataset = train_dataset.map(
        lambda x: process_batch(x, processor),
        batched=True,
        batch_size=4,
        remove_columns=train_dataset.column_names
    )
    
    test_dataset = test_dataset.map(
        lambda x: process_batch(x, processor),
        batched=True,
        batch_size=4,
        remove_columns=test_dataset.column_names
    )

    print("\n" + "="*50)
    print("🚀 DÉMARRAGE DU FULL FINE-TUNING FIRE-RED OCR")
    print("="*50)
    print(f"   • Modèle base  : {MODEL_ID}")
    print(f"   • Batch Size   : {training_args.per_device_train_batch_size * training_args.gradient_accumulation_steps} (Effective)")
    print(f"   • Optimiseur   : 8-bit AdamW")
    print(f"   • Flash Attn 2 : Active")
    print(f"   • Grad Checkpt : Active")
    print("="*50 + "\n")

    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=test_dataset,
    )

    checkpoint_to_resume = None
    if os.path.isdir(OUTPUT_DIR):
        checkpoints = [d for d in os.listdir(OUTPUT_DIR) if d.startswith("checkpoint-")]
        if checkpoints:
            print(f"🔄 Checkpoint détecté ! Reprise de l'entraînement...")
            checkpoint_to_resume = True
        else:
            print("✨ Aucun checkpoint trouvé, démarrage à zéro.")
            checkpoint_to_resume = False
    
    trainer.train(resume_from_checkpoint=checkpoint_to_resume)

    final_path = os.path.join(OUTPUT_DIR, "final_manga_model")
    print("\n" + "="*50)
    print("💾 SAUVEGARDE DU MODÈLE FINAL")
    print("="*50)
    
    trainer.save_model(final_path)
    processor.save_pretrained(final_path)
    print(f"✅ Modèle sauvegardé dans : {final_path}\n")

    print("\n" + "="*50)
    print("📊 ÉVALUATION DU MODÈLE FINAL")
    print("="*50)
    metrics = trainer.evaluate()
    print(metrics)

    os.makedirs(LOGS_DIR, exist_ok=True)
    log_file_path = os.path.join(LOGS_DIR, "training_summary.txt")
    with open(log_file_path, "w", encoding="utf-8") as f:
        f.write(f"Dataset Size:\n")
        f.write(f"Train: {len(train_dataset)}\n")
        f.write(f"Test: {len(test_dataset)}\n\n")
        f.write(f"Final Metrics:\n")
        for k, v in metrics.items():
            f.write(f"{k}: {v}\n")

    print(f"✅ Logs sauvegardés dans : {log_file_path}\n")
