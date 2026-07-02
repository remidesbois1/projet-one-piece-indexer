import os
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


if __name__ == "__main__":
    main()
