import os
import sys
import json
import requests
import io
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
PROJECT_ROOT = SCRIPT_DIR.parent.parent
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    load_dotenv(env_path)
    SUPABASE_URL = os.getenv("SUPABASE_URL")
    SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

OUTPUT_DIR = SCRIPT_DIR / "dataset"
TEST_SIZE = 0.1
RANDOM_SEED = 42

def convert_to_yolo(size, box):
    dw = 1. / size[0]
    dh = 1. / size[1]
    x = box[0] + box[2] / 2.0
    y = box[1] + box[3] / 2.0
    w = box[2]
    h = box[3]
    x = x * dw
    w = w * dw
    y = y * dh
    h = h * dh
    return (x, y, w, h)

def fetch_data(supabase: Client):
    print("Fetching pages and bubbles from Supabase...")
    
    response = (
        supabase.table("pages")
        .select("id, url_image, bulles(x, y, w, h)")
        .execute()
    )
    
    pages = response.data
    valid_pages = [p for p in pages if p.get("bulles") and len(p["bulles"]) > 0]
    print(f"Total pages with bubbles: {len(valid_pages)}")
    return valid_pages

def main():
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    pages = fetch_data(supabase)

    if not pages:
        print("No data found.")
        return

    train_data, test_data = train_test_split(pages, test_size=TEST_SIZE, random_state=RANDOM_SEED)

    for split_name, split_pages in [("train", train_data), ("val", test_data)]:
        split_dir = OUTPUT_DIR / split_name
        img_dir = split_dir / "images"
        lbl_dir = split_dir / "labels"
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        print(f"\nProcessing '{split_name}' ({len(split_pages)} pages)...")
        for p in tqdm(split_pages, desc=split_name):
            try:
                img_url = p["url_image"]
                resp = requests.get(img_url, timeout=10)
                resp.raise_for_status()
                img = Image.open(io.BytesIO(resp.content)).convert("RGB")
                w, h = img.size
                
                img_filename = f"page_{p['id']}.jpg"
                img.save(img_dir / img_filename, quality=95)
                
                label_filename = f"page_{p['id']}.txt"
                with open(lbl_dir / label_filename, "w") as f:
                    for b in p["bulles"]:
                        yolo_box = convert_to_yolo((w, h), (b["x"], b["y"], b["w"], b["h"]))
                        f.write(f"0 {' '.join([f'{x:.6f}' for x in yolo_box])}\n")
                        
            except Exception as e:
                print(f"\n  Error on page {p['id']}: {e}")

    yaml_content = f"""
path: {OUTPUT_DIR.absolute().as_posix()}
train: train/images
val: val/images

names:
  0: bubble
"""
    with open(OUTPUT_DIR / "data.yaml", "w") as f:
        f.write(yaml_content)
    
    print(f"\nDataset preparation complete. YAML at: {OUTPUT_DIR / 'data.yaml'}")

if __name__ == "__main__":
    main()
