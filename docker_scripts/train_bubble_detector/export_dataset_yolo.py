import io
import json
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from PIL import Image
from sklearn.model_selection import train_test_split
from supabase import create_client, Client
from tqdm import tqdm

try:
    import pillow_avif
except ImportError:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    env_path = SCRIPT_DIR.parent.parent / ".env"
    load_dotenv(env_path)
    SUPABASE_URL = os.getenv("SUPABASE_URL")
    SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[ERROR] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not found in .env")
    sys.exit(1)

OUTPUT_DIR = SCRIPT_DIR / "dataset"
TEST_SIZE = 0.1
RANDOM_SEED = 42


def convert_to_yolo(size, box):
    dw = 1.0 / size[0]
    dh = 1.0 / size[1]
    x = (box[0] + box[2] / 2.0) * dw
    y = (box[1] + box[3] / 2.0) * dh
    w = box[2] * dw
    h = box[3] * dh
    return x, y, w, h


def fetch_pages(supabase: Client):
    response = (
        supabase.table("pages")
        .select("id, url_image, bulles(x, y, w, h)")
        .execute()
    )
    pages = response.data
    valid = [p for p in pages if p.get("bulles") and len(p["bulles"]) > 0]
    return valid


def process_split(split_name, split_pages, output_dir):
    split_dir = output_dir / split_name
    img_dir = split_dir / "images"
    lbl_dir = split_dir / "labels"
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    errors = 0
    for p in tqdm(split_pages, desc=f"  {split_name:>5}"):
        try:
            resp = requests.get(p["url_image"], timeout=15)
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")
            w, h = img.size

            stem = f"page_{p['id']}"
            img.save(img_dir / f"{stem}.jpg", quality=95)

            with open(lbl_dir / f"{stem}.txt", "w") as f:
                for b in p["bulles"]:
                    yolo_box = convert_to_yolo((w, h), (b["x"], b["y"], b["w"], b["h"]))
                    f.write(f"0 {yolo_box[0]:.6f} {yolo_box[1]:.6f} {yolo_box[2]:.6f} {yolo_box[3]:.6f}\n")
        except Exception as e:
            errors += 1
            tqdm.write(f"    [WARN] page {p['id']}: {e}")

    return errors


def write_dataset_yaml(output_dir):
    yaml_content = (
        f"path: {output_dir.absolute().as_posix()}\n"
        f"train: train/images\n"
        f"val: val/images\n"
        f"\n"
        f"names:\n"
        f"  0: bubble\n"
    )
    yaml_path = output_dir / "data.yaml"
    with open(yaml_path, "w") as f:
        f.write(yaml_content)
    return yaml_path


def main():
    print()
    print("=" * 60)
    print("  STEP 1: DATASET EXPORT")
    print("=" * 60)
    print()

    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    pages = fetch_pages(supabase)

    if not pages:
        print("  No pages with bubbles found. Aborting.")
        sys.exit(1)

    print(f"  Pages with bubbles: {len(pages)}")
    print(f"  Train/val split:    {(1 - TEST_SIZE) * 100:.0f}% / {TEST_SIZE * 100:.0f}%")
    print()

    train_pages, val_pages = train_test_split(
        pages, test_size=TEST_SIZE, random_state=RANDOM_SEED
    )

    train_errors = process_split("train", train_pages, OUTPUT_DIR)
    val_errors = process_split("val", val_pages, OUTPUT_DIR)

    yaml_path = write_dataset_yaml(OUTPUT_DIR)

    print()
    print(f"  Train pages: {len(train_pages)} ({train_errors} errors)")
    print(f"  Val pages:   {len(val_pages)} ({val_errors} errors)")
    print(f"  Config YAML: {yaml_path}")
    print()
    print("=" * 60)
    print("  DATASET EXPORT COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
