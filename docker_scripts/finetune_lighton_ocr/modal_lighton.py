import modal
import os
import torch
from fastapi import Request, HTTPException

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "git+https://github.com/huggingface/transformers.git",
        "torch",
        "torchvision",
        "accelerate",
        "huggingface_hub",
        "Pillow",
        "fastapi[standard]"
    )
)

app = modal.App("lighton-ocr-poneglyph")
volume = modal.Volume.from_name("lighton-models-volume", create_if_missing=True)
MODEL_DIR = "/models"

@app.cls(
    image=image,
    gpu="L4",
    volumes={MODEL_DIR: volume},
    timeout=600,
    scaledown_window=180,
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
class LightonOCR:
    @modal.enter()
    def load_model(self):
        from transformers import AutoModelForImageTextToText, AutoProcessor
        from huggingface_hub import snapshot_download

        self.model_id = "Remidesbois/LightonOCR-2-1b-poneglyph"
        self.model_path = os.path.join(MODEL_DIR, "lighton-ocr-poneglyph-weights")

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

        print("--- Loading LightonOCR model into GPU (bfloat16)... ---")
        actual_model_path = os.path.join(self.model_path, "weights-merged")
        try:
            self.processor = AutoProcessor.from_pretrained(
                "lightonai/LightOnOCR-2-1B",
                trust_remote_code=True
            )
            self.model = AutoModelForImageTextToText.from_pretrained(
                actual_model_path,
                dtype=torch.bfloat16,
                device_map="auto",
                trust_remote_code=True
            ).eval()
            print("--- Model loaded and ready! ---")
        except Exception as e:
            print(f"--- FAILURE with LightonOCR Load: {str(e)} ---")

    @modal.fastapi_endpoint(method="POST", label="ocr-lighton")
    async def ocr(self, request: Request):
        api_key = request.headers.get("X-API-Key")
        expected_key = os.environ.get("MODAL_OCR_API_KEY")
        
        if not expected_key:
            raise HTTPException(status_code=500, detail="Server configuration error")
            
        if api_key != expected_key:
            raise HTTPException(status_code=401, detail="Unauthorized")

        try:
            image_data = await request.body()
            if not image_data:
                return {"error": "Request body is empty"}

            from PIL import Image
            import io

            image = Image.open(io.BytesIO(image_data)).convert("RGB")
            
            messages = [
                {"role": "user", "content": [
                    {"type": "image"},
                    {"type": "text", "text": "Extrais le texte de cette image.\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :"}
                ]}
            ]

            text_prompt = self.processor.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
            inputs = self.processor(text=[text_prompt], images=[image], return_tensors="pt").to("cuda")

            with torch.no_grad():
                generated_ids = self.model.generate(**inputs, max_new_tokens=128, do_sample=False)
                
            input_len = inputs["input_ids"].shape[1]
            output_text = self.processor.tokenizer.decode(generated_ids[0][input_len:], skip_special_tokens=True).strip()

            return {"text": output_text}
            
        except Exception as e:
            print(f"--- ERROR DURING OCR: {str(e)} ---")
            return {"error": str(e)}
