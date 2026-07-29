import os
from pathlib import Path

from dotenv import load_dotenv
from PIL import Image


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

MODEL_ID = os.getenv("SURYA_MODEL_ID", "datalab-to/surya-ocr-2")


def main():
    from train_surya_bubble_ocr import (
        USER_PROMPT,
        apply_template,
        configure_processor,
        make_training_args,
    )
    from transformers.models.qwen3_5 import modeling_qwen3_5

    print(f"Loading processor smoke check: {MODEL_ID}", flush=True)
    processor = configure_processor(MODEL_ID)
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is None:
        raise RuntimeError("Processor has no tokenizer.")
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": "synthetic.png"},
                {"type": "text", "text": USER_PROMPT},
            ],
        }
    ]
    full_messages = messages + [
        {"role": "assistant", "content": [{"type": "text", "text": "BOUM !!"}]}
    ]
    prompt = apply_template(processor, messages, add_generation_prompt=True)
    full = apply_template(processor, full_messages, add_generation_prompt=False)
    images = [Image.new("RGB", (96, 192), "white"), Image.new("RGB", (192, 96), "white")]
    encoded = processor(
        text=[full, full],
        images=images,
        padding=True,
        pad_to_multiple_of=16,
        return_tensors="pt",
    )
    assistant_text_tokens = len(
        tokenizer(full, add_special_tokens=False)["input_ids"]
    ) - len(tokenizer(prompt, add_special_tokens=False)["input_ids"])
    if assistant_text_tokens <= 0 or encoded["input_ids"].shape[0] != 2:
        raise RuntimeError("Processor batching or assistant-boundary contract is invalid.")

    args = make_training_args()
    if args.metric_for_best_model != "eval_cer":
        raise RuntimeError("Best-checkpoint selection must use eval_cer.")
    fast_path = bool(modeling_qwen3_5.is_fast_path_available)
    require_fast_path = os.getenv("SURYA_REQUIRE_FAST_LINEAR_ATTENTION", "0").lower() in {
        "1",
        "true",
        "yes",
    }
    if require_fast_path and not fast_path:
        raise RuntimeError(
            "Qwen3.5 fast linear attention is required but fla/causal-conv1d is unavailable."
        )
    print(
        f"Processor ok. Tokenizer={len(tokenizer)}, batch={tuple(encoded['input_ids'].shape)}, "
        f"assistant_tokens={assistant_text_tokens}, fast_linear_attention={fast_path}",
        flush=True,
    )

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
