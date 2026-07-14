import os
import tempfile

import torch
import transformers
from PIL import Image, ImageDraw
from peft import PeftModel, get_peft_model
from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor

import train_lighton_bbox as bbox


MODEL_ID = os.getenv("LIGHTON_MODEL_ID", "lightonai/LightOnOCR-2-1B-bbox-base")
EDGE = int(os.getenv("LIGHTON_IMAGE_LONGEST_EDGE", "1500"))


def main():
    assert transformers.__version__ == "5.0.0", transformers.__version__
    assert EDGE == 1500, "BBox training must keep the 1500 px profile"
    processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
    processor.image_processor.default_to_square = False
    processor.image_processor.size = {"longest_edge": EDGE}
    processor.tokenizer.padding_side = "left"
    print(f"Processor OK: {MODEL_ID}, fixed longest edge={EDGE}.", flush=True)

    if os.getenv("LIGHTON_SMOKE_LOAD_MODEL", "0").lower() not in {"1", "true", "yes"}:
        return
    if not torch.cuda.is_available():
        raise RuntimeError("LIGHTON_SMOKE_LOAD_MODEL=1 requires CUDA")
    model = LightOnOcrForConditionalGeneration.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.bfloat16,
        device_map={"": "cuda:0"},
        attn_implementation="sdpa",
        low_cpu_mem_usage=True,
    )
    model = get_peft_model(model, bbox.engine.build_peft_config())
    bbox.engine.configure_gradient_checkpointing(model, True)
    image = Image.new("RGB", (1500, 1000), "white")
    ImageDraw.Draw(image).rectangle((800, 200, 1250, 500), outline="black", width=4)
    messages = [
        {"role": "user", "content": [{"type": "image"}]},
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "SMOKE TEST [533,200,833,500]"}],
        },
    ]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    inputs = processor(
        text=[text],
        images=[image],
        size={"longest_edge": EDGE},
        return_tensors="pt",
    )
    inputs["labels"] = bbox.engine.mask_assistant_labels(
        inputs["input_ids"],
        inputs.get("attention_mask"),
        bbox.engine.assistant_marker_ids(processor),
        processor.tokenizer.pad_token_id,
    )
    valid_positions = (inputs["labels"] != -100).nonzero(as_tuple=False)
    slice_start = max(0, int(valid_positions[:, 1].min().item()) - 1)
    inputs["labels"] = inputs["labels"][:, slice_start:]
    inputs["logits_to_keep"] = inputs["input_ids"].shape[1] - slice_start
    dtype = bbox.engine.model_dtype(model)
    inputs = bbox.engine.move_inputs_to_device(inputs, next(model.parameters()).device, dtype)
    torch.cuda.reset_peak_memory_stats()
    loss = model(**inputs).loss
    loss.backward()
    torch.cuda.synchronize()
    peak_gib = torch.cuda.max_memory_allocated() / 1024**3
    model.zero_grad(set_to_none=True)
    with tempfile.TemporaryDirectory(prefix="lighton-bbox-smoke-") as tmp:
        model.save_pretrained(tmp)
        base = model.unload()
        resumed = PeftModel.from_pretrained(base, tmp)
        resumed.merge_and_unload()
    print(
        f"BF16/SDPA backward + LoRA save/resume/merge OK; "
        f"loss={loss.item():.6f}, peak={peak_gib:.2f} GiB.",
        flush=True,
    )


if __name__ == "__main__":
    main()
