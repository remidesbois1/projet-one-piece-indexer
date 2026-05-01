import re
import sys
import torch
from PIL import Image, ImageDraw, ImageFont
from transformers import LightOnOcrProcessor, LightOnOcrForConditionalGeneration

MODEL_ID = "Remidesbois/LightonOCR-2-1b-poneglyph-bbox"
IMAGE_PATH = sys.argv[1] if len(sys.argv) > 1 else "test_image.jpg"

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

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16

print(f"Loading model from {MODEL_ID}...", flush=True)
processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
processor.image_processor.default_to_square = False
model = LightOnOcrForConditionalGeneration.from_pretrained(
    MODEL_ID, torch_dtype=dtype, device_map="auto"
)

image = Image.open(IMAGE_PATH).convert("RGB")
image.thumbnail((1540, 1540), Image.Resampling.LANCZOS)
w, h = image.size
print(f"Image: {IMAGE_PATH} ({w}x{h})")

messages = [
    {
        "role": "user",
        "content": [
            {"type": "image", "url": IMAGE_PATH},
            {
                "type": "text",
                "text": "Extrais le texte et les coordonnees des bulles de cette page de manga.",
            },
        ],
    }
]

inputs = processor.apply_chat_template(
    messages,
    add_generation_prompt=True,
    tokenize=True,
    return_dict=True,
    return_tensors="pt",
)
inputs = {
    k: v.to(device=device, dtype=dtype) if v.is_floating_point() else v.to(device)
    for k, v in inputs.items()
}

print("Generating...", flush=True)
with torch.no_grad():
    output_ids = model.generate(**inputs, max_new_tokens=2048, do_sample=False)

gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
output_text = processor.decode(gen_ids, skip_special_tokens=True).strip()

print(f"\n{'=' * 60}")
print(f" RAW OUTPUT")
print(f"{'=' * 60}")
print(output_text)
print(f"{'=' * 60}\n")

pattern = re.compile(r"(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]")
results = []
for line in output_text.strip().split("\n"):
    match = pattern.match(line.strip())
    if match:
        text = match.group(1).strip()
        coords = [int(match.group(i)) for i in range(2, 6)]
        results.append({"text": text, "bbox": coords})

if not results:
    print("No bounding boxes found in output.")
    sys.exit(1)

print(f"{len(results)} bubbles detected. Drawing bboxes...\n")

draw = ImageDraw.Draw(image)

try:
    font = ImageFont.truetype("arial.ttf", 14)
    font_small = ImageFont.truetype("arial.ttf", 11)
except:
    font = ImageFont.load_default()
    font_small = font

for i, item in enumerate(results):
    color = COLORS[i % len(COLORS)]

    x1 = int(item["bbox"][0] * w / 10000)
    y1 = int(item["bbox"][1] * h / 10000)
    x2 = int(item["bbox"][2] * w / 10000)
    y2 = int(item["bbox"][3] * h / 10000)

    for offset in range(3):
        draw.rectangle(
            [x1 - offset, y1 - offset, x2 + offset, y2 + offset], outline=color
        )

    label = f"#{i + 1}"
    label_bbox = draw.textbbox((0, 0), label, font=font)
    label_w = label_bbox[2] - label_bbox[0] + 8
    label_h = label_bbox[3] - label_bbox[1] + 6
    label_x = x1
    label_y = max(0, y1 - label_h - 2)
    draw.rectangle([label_x, label_y, label_x + label_w, label_y + label_h], fill=color)
    draw.text((label_x + 4, label_y + 2), label, fill="white", font=font)

    print(f"  #{i + 1} [{x1},{y1},{x2},{y2}] {color} -> {item['text']}")

out_path = IMAGE_PATH.rsplit(".", 1)[0] + "_bbox_result.jpg"
image.save(out_path, quality=95)
print(f"\nSaved: {out_path}")
