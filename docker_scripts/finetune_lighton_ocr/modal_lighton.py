import modal
import os
import torch
from fastapi import Request, HTTPException

USER_PROMPT = os.getenv(
    "LIGHTON_USER_PROMPT",
    "\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :",
)

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
        "fastapi[standard]",
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
    scaledown_window=300,
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
class LightonOCR:
    @modal.enter()
    def load_model(self):
        from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor
        from huggingface_hub import snapshot_download

        self.model_id = os.getenv("HF_REPO", "Remidesbois/LightonOCR-2-1b-poneglyph")
        self.model_path = os.path.join(MODEL_DIR, "lighton-ocr-poneglyph-weights")

        config_file = os.path.join(self.model_path, "config.json")
        if not os.path.exists(config_file):
            print("--- Downloading model weights... ---")
            snapshot_download(
                repo_id=self.model_id,
                local_dir=self.model_path,
                token=os.environ.get("HF_TOKEN"),
                local_dir_use_symlinks=False,
            )
            print("--- Download complete ---")

        print("--- Loading LightonOCR model into GPU (bf16 when available)... ---")
        try:
            self.processor = LightOnOcrProcessor.from_pretrained(self.model_path)
            self.processor.image_processor.default_to_square = False
            self.processor.tokenizer.padding_side = "left"

            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
            load_kwargs = {"torch_dtype": dtype}
            if self.device == "cuda":
                load_kwargs["device_map"] = "auto"
            self.model = LightOnOcrForConditionalGeneration.from_pretrained(
                self.model_path,
                **load_kwargs,
            ).eval()
            if self.device != "cuda":
                self.model.to(self.device)
            self.dtype = dtype
            print("--- Model loaded and ready! ---")
        except Exception as e:
            print(f"--- FAILURE with LightonOCR Load: {str(e)} ---")
            raise

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
                raise HTTPException(status_code=400, detail="Request body is empty")

            from PIL import Image
            import io

            image = Image.open(io.BytesIO(image_data)).convert("RGB")
            
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image"},
                        {"type": "text", "text": USER_PROMPT},
                    ],
                }
            ]

            text_prompt = self.processor.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False
            )
            inputs = self.processor(text=[text_prompt], images=[image], return_tensors="pt")
            inputs = {
                key: value.to(device=self.device, dtype=self.dtype)
                if value.is_floating_point()
                else value.to(self.device)
                for key, value in inputs.items()
            }

            with torch.inference_mode():
                generated_ids = self.model.generate(**inputs, max_new_tokens=128, do_sample=False)

            input_len = inputs["input_ids"].shape[1]
            output_text = self.processor.tokenizer.decode(generated_ids[0][input_len:], skip_special_tokens=True).strip()
            if "\n" in output_text:
                output_text = output_text.split("\n")[0].strip()

            return {"text": output_text}
            
        except HTTPException:
            raise
        except Exception as e:
            print(f"--- ERROR DURING OCR: {str(e)} ---")
            raise HTTPException(status_code=500, detail=str(e))
