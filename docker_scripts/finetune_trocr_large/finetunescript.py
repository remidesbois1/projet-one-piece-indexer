import os
import pandas as pd
import torch
from PIL import Image
from torch.utils.data import Dataset
from transformers import (
    TrOCRProcessor,
    VisionEncoderDecoderModel,
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    default_data_collator,
    EarlyStoppingCallback
)
import evaluate

torch.set_num_threads(8) 
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True

BASE_PATH = "./trocr_dataset"
TRAIN_DIR = os.path.join(BASE_PATH, "train")
TEST_DIR = os.path.join(BASE_PATH, "test")
MODEL_ID = "microsoft/trocr-large-printed"
OUTPUT_DIR = "./outputs_trocr_manga_large"
LOGS_DIR = "./logs"

cer_metric = evaluate.load("cer")
wer_metric = evaluate.load("wer")

class MangaOCRDataset(Dataset):
    def __init__(self, df, processor, img_dir, decoder_start_token_id, max_target_length=64, name="Dataset"):
        self.df = df
        self.processor = processor
        self.img_dir = img_dir
        self.max_target_length = max_target_length
        self.decoder_start_token_id = decoder_start_token_id
        print(f"📦 [{name}] {len(self.df)} images (chargement à la volée)")

    def __len__(self):
        return len(self.df)

    def __getitem__(self, idx):
        item = self.df.iloc[idx]
        file_name = item['file_name']
        image = Image.open(os.path.join(self.img_dir, file_name)).convert("RGB")
        pixel_values = self.processor(image, return_tensors="pt").pixel_values.squeeze()
        
        labels = self.processor.tokenizer(
            item['text'],
            padding="max_length",
            max_length=self.max_target_length,
            truncation=True
        ).input_ids

        decoder_input_ids = [self.decoder_start_token_id] + labels[:-1]
        decoder_input_ids = [tid if tid != -100 else self.processor.tokenizer.pad_token_id for tid in decoder_input_ids]

        labels = [label if label != self.processor.tokenizer.pad_token_id else -100 for label in labels]

        return {
            "pixel_values": pixel_values,
            "labels": torch.tensor(labels),
            "decoder_input_ids": torch.tensor(decoder_input_ids),
        }

def compute_metrics(pred):
    labels_ids = pred.label_ids
    pred_ids = pred.predictions

    pred_str = processor.batch_decode(pred_ids, skip_special_tokens=True)
    labels_ids[labels_ids == -100] = processor.tokenizer.pad_token_id
    label_str = processor.batch_decode(labels_ids, skip_special_tokens=True)

    cer = cer_metric.compute(predictions=pred_str, references=label_str)
    wer = wer_metric.compute(predictions=pred_str, references=label_str)

    return {"cer": cer, "wer": wer}

if __name__ == "__main__":
    processor = TrOCRProcessor.from_pretrained(MODEL_ID)
    
    train_df = pd.read_csv(os.path.join(TRAIN_DIR, "metadata.csv"))
    test_df = pd.read_csv(os.path.join(TEST_DIR, "metadata.csv"))
    
    decoder_start_id = processor.tokenizer.cls_token_id or processor.tokenizer.bos_token_id or 2
    print(f"ℹ️  decoder_start_token_id = {decoder_start_id}")

    train_dataset = MangaOCRDataset(train_df, processor, TRAIN_DIR, decoder_start_id, name="Train")
    test_dataset = MangaOCRDataset(test_df, processor, TEST_DIR, decoder_start_id, name="Test")

    model = VisionEncoderDecoderModel.from_pretrained(MODEL_ID)

    model.config.decoder_start_token_id = processor.tokenizer.cls_token_id or processor.tokenizer.bos_token_id or 2
    model.config.pad_token_id = processor.tokenizer.pad_token_id
    model.config.decoder.decoder_start_token_id = model.config.decoder_start_token_id
    model.config.decoder.pad_token_id = model.config.pad_token_id
    model.config.vocab_size = model.config.decoder.vocab_size
    model.config.eos_token_id = processor.tokenizer.sep_token_id
    model.config.max_length = 64
    model.config.early_stopping = True
    model.config.no_repeat_ngram_size = 0
    model.config.length_penalty = 1.0
    model.config.num_beams = 4
    model.gradient_checkpointing_enable()

    training_args = Seq2SeqTrainingArguments(
        output_dir=OUTPUT_DIR,
        predict_with_generate=True,
        evaluation_strategy="epoch",
        save_strategy="epoch",
        logging_steps=10,
        learning_rate=1e-5,
        
        num_train_epochs=25,
        
        per_device_train_batch_size=8,
        per_device_eval_batch_size=4,
        gradient_accumulation_steps=3,
        
        bf16=True,
        tf32=True,
        optim="adamw_torch_fused",
        
        label_smoothing_factor=0.1,
        weight_decay=0.05,
        lr_scheduler_type="cosine",
        warmup_ratio=0.1,
        
        dataloader_num_workers=0,
        dataloader_pin_memory=True,
        
        logging_dir=LOGS_DIR,
        report_to="tensorboard",
        load_best_model_at_end=True,
        metric_for_best_model="cer",
        greater_is_better=False,
        save_total_limit=3,
        
        logging_first_step=True,
    )

    trainer = Seq2SeqTrainer(
        model=model,
        tokenizer=processor.image_processor, 
        args=training_args,
        compute_metrics=compute_metrics,
        train_dataset=train_dataset,
        eval_dataset=test_dataset,
        data_collator=default_data_collator,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=5)]
    )

    print("\n" + "="*50)
    print("🚀 DÉMARRAGE DU FINE-TUNING (LARGE)")
    print("="*50)
    print(f"   • Modèle       : {MODEL_ID}")
    print(f"   • Images Train  : {len(train_dataset)}")
    print(f"   • Images Test   : {len(test_dataset)}")
    print(f"   • Batch Size    : {training_args.per_device_train_batch_size} (x{training_args.gradient_accumulation_steps} accum)")
    print(f"   • Évaluation    : Chaque epoch")
    print(f"   • Régularisation: label_smoothing=0.1, weight_decay=0.05")
    print(f"   • Scheduler     : cosine (warmup 10%)")
    print("="*50 + "\n")

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
    print(f"   • Final CER : {metrics['eval_cer']:.4f}")
    print(f"   • Final WER : {metrics['eval_wer']:.4f}")

    os.makedirs(LOGS_DIR, exist_ok=True)

    log_file_path = os.path.join(LOGS_DIR, "training_summary.txt")
    with open(log_file_path, "w", encoding="utf-8") as f:
        f.write(f"Model: {MODEL_ID}\n")
        f.write(f"Dataset Size:\n")
        f.write(f"Train: {len(train_dataset)}\n")
        f.write(f"Test: {len(test_dataset)}\n\n")
        f.write(f"Hyperparameters:\n")
        f.write(f"Batch Size: {training_args.per_device_train_batch_size} x {training_args.gradient_accumulation_steps} accum\n")
        f.write(f"Learning Rate: {training_args.learning_rate}\n")
        f.write(f"Scheduler: cosine (warmup 10%)\n")
        f.write(f"Label Smoothing: 0.1\n")
        f.write(f"Weight Decay: 0.05\n")
        f.write(f"no_repeat_ngram_size: 0\n")
        f.write(f"length_penalty: 1.0\n\n")
        f.write(f"Final Metrics:\n")
        f.write(f"CER: {metrics['eval_cer']}\n")
        f.write(f"WER: {metrics['eval_wer']}\n")

    print(f"✅ Logs sauvegardés dans : {log_file_path}\n")
