import os
import torch
from datasets import load_dataset
from transformers import (
    Qwen3VLForConditionalGeneration,
    AutoProcessor,
    TrainingArguments,
    Trainer
)
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

def prepare_dataset(file_path):
    print(f"Loading dataset from {file_path}...")
    dataset = load_dataset("json", data_files=file_path, split="train")
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

from PIL import Image

def process_batch(examples, processor):
    batch_texts = []
    batch_images = []
    
    for i in range(len(examples['messages'])):
        example_messages = examples['messages'][i]
        
        # 1. Extraire et charger les images PIL manuellement
        # On ne touche pas au messages originaux pour l'instant
        example_images = []
        for msg in example_messages:
            if msg["role"] == "user":
                for content in msg["content"]:
                    if content["type"] == "image":
                        img_path = content["image"]
                        
                        # Résoudre le chemin
                        # On assume que c'est relatif à BASE_PATH/train ou BASE_PATH/test
                        # ou déjà absolu
                        possible_paths = [
                            os.path.join(BASE_PATH, "train", img_path),
                            os.path.join(BASE_PATH, "test", img_path),
                            img_path
                        ]
                        
                        loaded_img = None
                        for p in possible_paths:
                            if os.path.exists(p):
                                try:
                                    loaded_img = Image.open(p).convert("RGB")
                                    break
                                except:
                                    continue
                        
                        if loaded_img is None:
                            # Fallback: on crée une image noire pour ne pas casser la séquence
                            print(f"⚠️ Image non trouvée: {img_path}. Remplacement par une image vide.")
                            loaded_img = Image.new("RGB", (224, 224), (0, 0, 0))
                        
                        example_images.append(loaded_img)
                        
        # Nettoyage des None insérés par the datasets library (qui force un schéma fixe pour tous les dicts)
        # Ça cause un bug dans le Jinja chat template de Qwen3VL ('image' in content => 2 images par message)
        clean_messages = []
        for msg in example_messages:
            clean_content = []
            for content in msg["content"]:
                clean_content.append({k: v for k, v in content.items() if v is not None})
            clean_messages.append({"role": msg["role"], "content": clean_content})

        # 2. Appliquer le template de chat pour obtenir le texte
        # Note: apply_chat_template avec tokenize=False insère les tokens <|vision_start|> etc.
        text = processor.apply_chat_template(
            clean_messages, tokenize=False, add_generation_prompt=False
        )
        batch_texts.append(text)
        batch_images.extend(example_images)
            
    # 3. Utiliser le processor pour encoder le texte et les images
    # Le processor gère lui-même le redimensionnement et le grid_thw
    model_inputs = processor(
        text=batch_texts,
        images=batch_images,
        padding=True,
        return_tensors="pt"
    )
    
    # On doit s'assurer que les labels sont présents pour l'entraînement (copie des input_ids)
    model_inputs["labels"] = model_inputs["input_ids"].clone()
    
    return model_inputs

class CustomDataCollator:
    def __init__(self, processor):
        self.processor = processor

    def __call__(self, features):
        batch_dict = {"messages": [f["messages"] for f in features]}
        return process_batch(batch_dict, self.processor)

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
    
    attn_implementation = "sdpa"
    try:
        import flash_attn
        attn_implementation = "flash_attention_2"
        print("✨ Flash Attention 2 détecté et activé.")
    except ImportError:
        print("ℹ️ Flash Attention 2 non trouvé (normal sous Windows). Utilisation de SDPA.")

    model = Qwen3VLForConditionalGeneration.from_pretrained(
        MODEL_ID,
        dtype=torch.bfloat16,
        attn_implementation=attn_implementation,
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
        optim="adamw_torch",
        bf16=True,
        tf32=True,
        
        eval_strategy="steps",
        save_strategy="steps",
        eval_steps=100,
        save_steps=100,
        logging_steps=10,
        
        dataloader_num_workers=0,
        dataloader_pin_memory=True,
        
        logging_dir=LOGS_DIR,
        report_to="tensorboard",
        save_total_limit=2,
        remove_unused_columns=False
    )

    def sft_formatting_func(example):
        texts = []
        for i in range(len(example['messages'])):
            text = processor.apply_chat_template(
                example['messages'][i], tokenize=False, add_generation_prompt=False
            )
            texts.append(text)
        return texts
        
    print("Initialisation du Data Collator...")
    data_collator_fn = CustomDataCollator(processor)

    print("\n" + "="*50)
    print("🚀 DÉMARRAGE DU FULL FINE-TUNING FIRE-RED OCR")
    print("="*50)
    print(f"   • Modèle base  : {MODEL_ID}")
    print(f"   • Batch Size   : {training_args.per_device_train_batch_size * training_args.gradient_accumulation_steps} (Effective)")
    print(f"   • Optimiseur   : Standard AdamW (Windows Safe)")
    print(f"   • Flash Attn 2 : Active")
    print(f"   • Grad Checkpt : Active")
    print("="*50 + "\n")

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=test_dataset,
        data_collator=data_collator_fn
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
