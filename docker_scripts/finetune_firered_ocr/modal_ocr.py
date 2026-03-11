import modal
import os
import torch
import json
from fastapi import Request, HTTPException
import os

# Utilisation de la version de transformers qui supporte officiellement Qwen3-VL
# (Version 4.57.0+ requise pour le support de l'architecture qwen3_vl)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "transformers>=5.0.0",
        "torch",
        "torchvision",
        "accelerate",
        "qwen-vl-utils",
        "huggingface_hub",
        "Pillow",
        "fastapi[standard]",
        "timm"
    )
)

app = modal.App("poneglyph-ocr-v2")
volume = modal.Volume.from_name("poneglyph-models-v2", create_if_missing=True)
MODEL_DIR = "/models"

@app.cls(
    image=image,
    gpu="L4",
    volumes={MODEL_DIR: volume},
    timeout=600,
    scaledown_window=180,
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
class PoneglyphOCR:
    @modal.enter()
    def load_model(self):
        # AutoModelForImageTextToText est la classe recommandée pour Qwen3-VL
        from transformers import AutoModelForImageTextToText, AutoProcessor
        from huggingface_hub import snapshot_download

        self.model_id = "Remidesbois/firered-ocr-onepiece"
        self.model_path = os.path.join(MODEL_DIR, "firered-ocr-onepiece-pytorch")
        
        # Téléchargement si nécessaire
        config_file = os.path.join(self.model_path, "config.json")
        if not os.path.exists(config_file):
            print("--- Downloading model weights... ---")
            snapshot_download(
                repo_id=self.model_id,
                local_dir=self.model_path,
                token=os.environ.get("HF_TOKEN"),
                local_dir_use_symlinks=False
            )
            print("--- Download complete ---")

        # Plus besoin de patcher manuellement si on a la bonne version de transformers
        print("--- Loading Qwen3-VL model into GPU (fp16)... ---")
        try:
            self.model = AutoModelForImageTextToText.from_pretrained(
                self.model_path,
                torch_dtype=torch.float16,
                device_map="auto",
                trust_remote_code=True
            ).eval()
            
            self.processor = AutoProcessor.from_pretrained(
                self.model_path,
                trust_remote_code=True
            )
            print("--- Model loaded and ready! ---")
        except Exception as e:
            print(f"--- FAILURE with AutoModelForImageTextToText: {str(e)} ---")
            print("--- Fallback to AutoModel... ---")
            from transformers import AutoModel
            self.model = AutoModel.from_pretrained(
                self.model_path,
                torch_dtype=torch.float16,
                device_map="auto",
                trust_remote_code=True
            ).eval()
            print("--- Model loaded with AutoModel! ---")

    @modal.fastapi_endpoint(method="POST", label="ocr-poneglyph")
    async def ocr(self, request: Request):
        # Vérification de sécurité
        api_key = request.headers.get("X-API-Key")
        expected_key = os.environ.get("MODAL_OCR_API_KEY")
        
        if not expected_key:
            # Si le secret n'est pas configuré, on bloque par sécurité
            raise HTTPException(status_code=500, detail="Server configuration error")
            
        if api_key != expected_key:
            raise HTTPException(status_code=401, detail="Unauthorized")

        try:
            image_data = await request.body()
            if not image_data:
                return {"error": "Request body is empty"}

            from PIL import Image
            import io
            from qwen_vl_utils import process_vision_info

            # Traitement Image
            image = Image.open(io.BytesIO(image_data))
            
            # Format FireRed-OCR
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": image},
                        {"type": "text", "text": "Transcription OCR de cette image:"},
                    ],
                }
            ]

            # Inférence
            text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            image_inputs, video_inputs = process_vision_info(messages)
            
            inputs = self.processor(
                text=[text],
                images=image_inputs,
                videos=video_inputs,
                padding=True,
                return_tensors="pt"
            ).to("cuda")

            with torch.no_grad():
                generated_ids = self.model.generate(**inputs, max_new_tokens=1024)
                generated_ids_trimmed = [out_id[len(in_id):] for in_id, out_id in zip(inputs.input_ids, generated_ids)]
                output = self.processor.batch_decode(generated_ids_trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)

            return {"text": output[0].strip()}
            
        except Exception as e:
            print(f"--- ERROR DURING OCR: {str(e)} ---")
            return {"error": str(e)}
