import argparse
import json
import os
import re
from pathlib import Path

import torch
from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont
from transformers import AutoModelForImageTextToText, AutoProcessor


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

DEFAULT_MODEL_ID = os.getenv("HF_REPO", "Remidesbois/surya-ocr-2-poneglyph-bbox")
PROMPT = os.getenv(
    "SURYA_BBOX_USER_PROMPT",
    "Extrais le texte des bulles de cette page de manga dans l'ordre de lecture japonais, "
    "avec leurs bbox normalisees entre 0 et 1000. Format strict: Texte [x1,y1,x2,y2].",
)
BBOX_NORM_SCALE = int(os.getenv("SURYA_BBOX_NORM_SCALE", "1000"))
BBOX_PATTERN = re.compile(r"(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]")

COLORS = [
    "#FF3B30",
    "#FF9500",
    "#FFCC00",
    "#34C759",
    "#00C7BE",
    "#30B0C7",
    "#007AFF",
    "#5856D6",
    "#AF52DE",
    "#FF2D55",
]


def parse_args():
    parser = argparse.ArgumentParser(description="Run Surya bbox inference on one manga page.")
    parser.add_argument("image", help="Path to an input page image.")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID, help="HF repo id or local model path.")
    parser.add_argument("--output", default=None, help="Output image path for drawn bboxes.")
    parser.add_argument("--json-output", default=None, help="Optional JSON output path.")
    parser.add_argument("--max-new-tokens", type=int, default=2048)
    return parser.parse_args()


def parse_bbox_output(text: str):
    results = []
    for line in str(text or "").splitlines():
        match = BBOX_PATTERN.match(line.strip())
        if not match:
            continue
        bbox = [int(match.group(i)) for i in range(2, 6)]
        if any(coord < 0 or coord > BBOX_NORM_SCALE for coord in bbox):
            continue
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            continue
        results.append({"text": match.group(1).strip(), "bbox": bbox})
    return results


def model_dtype(model):
    for param in model.parameters():
        if param.is_floating_point():
            return param.dtype
    return torch.float32


def move_inputs_to_device(inputs, device, dtype):
    moved = {}
    for key, value in inputs.items():
        if value.is_floating_point():
            moved[key] = value.to(device=device, dtype=dtype)
        else:
            moved[key] = value.to(device=device)
    return moved


def draw_bboxes(image, bubbles, output_path):
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except Exception:
        font = ImageFont.load_default()

    width, height = image.size
    for idx, item in enumerate(bubbles):
        color = COLORS[idx % len(COLORS)]
        x1 = int(item["bbox"][0] * width / BBOX_NORM_SCALE)
        y1 = int(item["bbox"][1] * height / BBOX_NORM_SCALE)
        x2 = int(item["bbox"][2] * width / BBOX_NORM_SCALE)
        y2 = int(item["bbox"][3] * height / BBOX_NORM_SCALE)
        draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
        label = f"#{idx + 1}"
        label_box = draw.textbbox((0, 0), label, font=font)
        label_w = label_box[2] - label_box[0] + 8
        label_h = label_box[3] - label_box[1] + 6
        label_y = max(0, y1 - label_h - 2)
        draw.rectangle([x1, label_y, x1 + label_w, label_y + label_h], fill=color)
        draw.text((x1 + 4, label_y + 2), label, fill="white", font=font)
    image.save(output_path, quality=95)


def main():
    args = parse_args()
    image_path = Path(args.image)
    if not image_path.exists():
        raise FileNotFoundError(image_path)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    print(f"Loading processor: {args.model_id}", flush=True)
    processor = AutoProcessor.from_pretrained(args.model_id, trust_remote_code=True)
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is not None:
        tokenizer.padding_side = "left"
        if tokenizer.pad_token_id is None and tokenizer.eos_token is not None:
            tokenizer.pad_token = tokenizer.eos_token

    print(f"Loading model on {device}: {args.model_id}", flush=True)
    kwargs = {
        "torch_dtype": dtype,
        "trust_remote_code": True,
        "low_cpu_mem_usage": True,
    }
    if device == "cuda":
        kwargs["device_map"] = {"": "cuda:0"}
    model = AutoModelForImageTextToText.from_pretrained(args.model_id, **kwargs).eval()
    if device != "cuda":
        model.to(device)

    image = Image.open(image_path).convert("RGB")
    image.thumbnail((1540, 1540), Image.Resampling.LANCZOS)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": str(image_path)},
                {"type": "text", "text": PROMPT},
            ],
        }
    ]
    prompt = processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=False,
    )
    inputs = processor(text=[prompt], images=[image], return_tensors="pt")
    inputs = move_inputs_to_device(inputs, next(model.parameters()).device, model_dtype(model))

    print("Generating...", flush=True)
    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=args.max_new_tokens,
            do_sample=False,
        )

    gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    output_text = processor.decode(gen_ids, skip_special_tokens=True).strip()
    bubbles = parse_bbox_output(output_text)

    print("\nRAW OUTPUT")
    print("=" * 60)
    print(output_text)
    print("=" * 60)
    print(f"Parsed bubbles: {len(bubbles)}", flush=True)

    out_image = Path(args.output) if args.output else image_path.with_name(f"{image_path.stem}_surya_bbox.jpg")
    draw_bboxes(image.copy(), bubbles, out_image)
    print(f"Drawn bbox image saved to {out_image}", flush=True)

    if args.json_output:
        payload = {"model_id": args.model_id, "image": str(image_path), "raw_output": output_text, "bubbles": bubbles}
        Path(args.json_output).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"JSON saved to {args.json_output}", flush=True)


if __name__ == "__main__":
    main()
