import os
import sys
import io
import math
import json
import requests
from pathlib import Path
from PIL import Image
from supabase import create_client, Client
from tqdm import tqdm
from sklearn.model_selection import train_test_split
from dotenv import load_dotenv

try:
    import pillow_avif
except ImportError:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    env_path = SCRIPT_DIR.parent.parent / "backend" / ".env"
    load_dotenv(env_path)
    SUPABASE_URL = os.getenv("SUPABASE_URL")
    SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

TARGET_H = 256
TARGET_W = 384
OUTPUT_DIR = SCRIPT_DIR / "dataset"
TEST_SIZE = 0.1
RANDOM_SEED = 42


def letterbox(img, target_h=TARGET_H, target_w=TARGET_W):
    ratio = target_h / img.height
    new_w = round(img.width * ratio)
    clamped_w = min(new_w, target_w)

    resized = img.resize((clamped_w, target_h), Image.BILINEAR)
    canvas = Image.new("L", (target_w, target_h), 0)
    pad_left = (target_w - clamped_w) // 2
    canvas.paste(resized.convert("L"), (pad_left, 0))

    return canvas, ratio, pad_left


def normalize_bubbles(bubbles, ratio, pad_left):
    result = []
    for b in bubbles:
        x = (b["x"] * ratio + pad_left) / TARGET_W
        y = (b["y"] * ratio) / TARGET_H
        w = (b["w"] * ratio) / TARGET_W
        h = (b["h"] * ratio) / TARGET_H
        cx = x + w / 2
        cy = y + h / 2
        result.append({"x": x, "y": y, "w": w, "h": h, "cx": cx, "cy": cy})
    return result


def generate_pairs(normalized):
    pairs = []
    for i in range(len(normalized)):
        for j in range(len(normalized)):
            if i == j:
                continue
            a, b = normalized[i], normalized[j]
            dx = b["cx"] - a["cx"]
            dy = b["cy"] - a["cy"]
            dist = math.sqrt(dx * dx + dy * dy)
            angle = math.atan2(dy, dx) / math.pi
            pairs.append({
                "a": {"x": a["x"], "y": a["y"], "w": a["w"], "h": a["h"]},
                "b": {"x": b["x"], "y": b["y"], "w": b["w"], "h": b["h"]},
                "rel": {"dx": dx, "dy": dy, "dist": dist, "angle": angle},
                "label": 1 if i < j else 0,
            })
    return pairs


def fetch_data():
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("Fetching pages and bubbles from Supabase...")

    response = (
        supabase.table("pages")
        .select('id, url_image, bulles(x, y, w, h, "order")')
        .execute()
    )

    pages = response.data
    valid = [p for p in pages if p.get("bulles") and len(p["bulles"]) >= 2]
    print(f"Pages with >=2 bubbles: {len(valid)}")
    return valid


def main():
    pages = fetch_data()
    if not pages:
        print("No data found.")
        return

    train_pages, val_pages = train_test_split(pages, test_size=TEST_SIZE, random_state=RANDOM_SEED)

    for split_name, split_pages in [("train", train_pages), ("val", val_pages)]:
        img_dir = OUTPUT_DIR / split_name / "images"
        img_dir.mkdir(parents=True, exist_ok=True)

        annotations = []
        print(f"\nProcessing '{split_name}' ({len(split_pages)} pages)...")

        for page in tqdm(split_pages, desc=split_name):
            try:
                resp = requests.get(page["url_image"], timeout=15)
                resp.raise_for_status()
                img = Image.open(io.BytesIO(resp.content))

                canvas, ratio, pad_left = letterbox(img)
                img_name = f"page_{page['id']}.png"
                canvas.save(img_dir / img_name)

                sorted_bubbles = sorted(page["bulles"], key=lambda b: b["order"] if b.get("order") is not None else float("inf"))
                normalized = normalize_bubbles(sorted_bubbles, ratio, pad_left)
                pairs = generate_pairs(normalized)

                annotations.append({
                    "image": img_name,
                    "canvas": {"w": TARGET_W, "h": TARGET_H},
                    "num_bubbles": len(normalized),
                    "pairs": pairs,
                })
            except Exception as e:
                print(f"\n  Error on page {page['id']}: {e}")

        ann_path = OUTPUT_DIR / split_name / "annotations.json"
        with open(ann_path, "w") as f:
            json.dump(annotations, f)

        total_pairs = sum(a["num_bubbles"] * (a["num_bubbles"] - 1) for a in annotations)
        print(f"  {len(annotations)} pages, {total_pairs} pairs -> {ann_path}")

    print("\nDataset export complete.")


if __name__ == "__main__":
    main()
