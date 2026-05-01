import modal
import os
import re
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
        "fastapi[standard]",
    )
)

app = modal.App("poneglyph-bbox-one-shot")
volume = modal.Volume.from_name("poneglyph-bbox-volume", create_if_missing=True)
MODEL_DIR = "/models"


@app.cls(
    image=image,
    gpu="L4",
    volumes={MODEL_DIR: volume},
    timeout=600,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
class PoneglyphBBox:
    @modal.enter()
    def load_model(self):
        from transformers import LightOnOcrProcessor, LightOnOcrForConditionalGeneration
        from huggingface_hub import snapshot_download

        self.model_id = "Remidesbois/LightonOCR-2-1b-poneglyph-bbox"
        self.model_path = os.path.join(MODEL_DIR, "lighton-ocr-poneglyph-bbox-weights")

        config_file = os.path.join(self.model_path, "config.json")
        if not os.path.exists(config_file):
            print("--- Downloading bbox model weights... ---")
            snapshot_download(
                repo_id=self.model_id,
                local_dir=self.model_path,
                token=os.environ.get("HF_TOKEN"),
                local_dir_use_symlinks=False,
            )
            print("--- Download complete ---")

        print("--- Loading Poneglyph BBox model... ---")
        self.processor = LightOnOcrProcessor.from_pretrained(self.model_path)
        self.processor.image_processor.default_to_square = False
        self.model = LightOnOcrForConditionalGeneration.from_pretrained(
            self.model_path, torch_dtype=torch.bfloat16, device_map="auto"
        ).eval()
        print("--- Model loaded and ready! ---")

    @modal.fastapi_endpoint(method="POST", label="poneglyph-bbox")
    async def extract(self, request: Request):
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
            image.thumbnail((1540, 1540), Image.Resampling.LANCZOS)

            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image"},
                        {
                            "type": "text",
                            "text": "Extrais le texte et les coordonnées des bulles de cette page de manga.",
                        },
                    ],
                }
            ]

            text_prompt = self.processor.apply_chat_template(
                messages,
                add_generation_prompt=True,
                tokenize=False,
            )
            inputs = self.processor(
                text=[text_prompt],
                images=[image],
                return_tensors="pt",
            )
            inputs = {
                k: v.to(device="cuda", dtype=torch.bfloat16)
                if v.is_floating_point()
                else v.to("cuda")
                for k, v in inputs.items()
            }

            with torch.no_grad():
                output_ids = self.model.generate(
                    **inputs, max_new_tokens=2048, do_sample=False
                )

            gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
            output_text = self.processor.decode(
                gen_ids, skip_special_tokens=True
            ).strip()

            pattern = re.compile(r"(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]")
            bubbles = []
            for line in output_text.strip().split("\n"):
                match = pattern.match(line.strip())
                if match:
                    text = match.group(1).strip()
                    coords = [int(match.group(i)) for i in range(2, 6)]
                    bubbles.append({"content": text, "bbox": coords})

            return {"bubbles": bubbles}

        except Exception as e:
            print(f"--- ERROR: {str(e)} ---")
            return {"error": str(e)}
