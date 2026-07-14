import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

MODEL_ID = os.getenv("LIGHTON_MODEL_ID", "lightonai/LightOnOCR-2-1B-base")


def main():
    from transformers import LightOnOcrProcessor

    print(f"Loading LightOnOCR processor smoke check: {MODEL_ID}", flush=True)
    processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
    processor.image_processor.default_to_square = False
    processor.image_processor.size = {
        "longest_edge": int(os.getenv("LIGHTON_IMAGE_LONGEST_EDGE", "700"))
    }
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is None:
        raise RuntimeError("Processor has no tokenizer.")
    print(f"Processor ok. Tokenizer size: {len(tokenizer)}", flush=True)

    if os.getenv("LIGHTON_SMOKE_LOAD_MODEL", "0").lower() in {"1", "true", "yes"}:
        import torch
        from transformers import LightOnOcrForConditionalGeneration

        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
        print("Loading full model because LIGHTON_SMOKE_LOAD_MODEL=1", flush=True)
        model = LightOnOcrForConditionalGeneration.from_pretrained(
            MODEL_ID,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )
        print(f"Model ok: {model.__class__.__name__}", flush=True)

        if os.getenv("LIGHTON_SMOKE_TRAIN_STEP", "0").lower() in {"1", "true", "yes"}:
            from PIL import Image, ImageDraw
            from peft import PeftModel, get_peft_model
            from train_lighton_ocr import (
                assistant_marker_ids,
                build_peft_config,
                mask_assistant_labels,
            )

            model = model.to("cuda" if torch.cuda.is_available() else "cpu")
            model = get_peft_model(model, build_peft_config())
            image = Image.new("RGB", (320, 160), "white")
            ImageDraw.Draw(image).text((20, 60), "SMOKE TEST", fill="black")
            messages = [
                {"role": "user", "content": [{"type": "image"}]},
                {"role": "assistant", "content": [{"type": "text", "text": "SMOKE TEST"}]},
            ]
            text = processor.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=False
            )
            inputs = processor(
                text=[text],
                images=[image],
                size={"longest_edge": int(os.getenv("LIGHTON_IMAGE_LONGEST_EDGE", "700"))},
                return_tensors="pt",
            )
            inputs["labels"] = mask_assistant_labels(
                inputs["input_ids"],
                inputs.get("attention_mask"),
                assistant_marker_ids(processor),
                processor.tokenizer.pad_token_id,
            )
            device = next(model.parameters()).device
            dtype = next(parameter.dtype for parameter in model.parameters() if parameter.is_floating_point())
            inputs = {
                key: value.to(device=device, dtype=dtype)
                if hasattr(value, "is_floating_point") and value.is_floating_point()
                else value.to(device) if hasattr(value, "to") else value
                for key, value in inputs.items()
            }
            loss = model(**inputs).loss
            loss.backward()
            model.zero_grad(set_to_none=True)
            with tempfile.TemporaryDirectory(prefix="lighton-smoke-") as tmp:
                model.save_pretrained(tmp)
                base = model.unload()
                if hasattr(base, "peft_config"):
                    delattr(base, "peft_config")
                resumed = PeftModel.from_pretrained(base, tmp)
                resumed.merge_and_unload()
            print(f"Train/backward/resume/merge smoke ok. loss={loss.item():.6f}", flush=True)


if __name__ == "__main__":
    main()
