import os
from pathlib import Path

from dotenv import load_dotenv


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

MODEL_ID = os.getenv("SURYA_MODEL_ID", "datalab-to/surya-ocr-2")


def main():
    from transformers import AutoProcessor

    print(f"Loading processor smoke check: {MODEL_ID}", flush=True)
    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is None:
        raise RuntimeError("Processor has no tokenizer.")
    print(f"Processor ok. Tokenizer size: {len(tokenizer)}", flush=True)

    if os.getenv("SURYA_SMOKE_LOAD_MODEL", "0").lower() in {"1", "true", "yes"}:
        from transformers import AutoModelForImageTextToText

        print("Loading full model because SURYA_SMOKE_LOAD_MODEL=1", flush=True)
        model = AutoModelForImageTextToText.from_pretrained(
            MODEL_ID,
            trust_remote_code=True,
            low_cpu_mem_usage=True,
        )
        print(f"Model ok: {model.__class__.__name__}", flush=True)


if __name__ == "__main__":
    main()
