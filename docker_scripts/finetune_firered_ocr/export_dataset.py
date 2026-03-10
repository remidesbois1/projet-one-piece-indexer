import os
import sys
import json
import requests
import io
import re
from pathlib import Path
from PIL import Image
from supabase import create_client, Client
from tqdm import tqdm
from sklearn.model_selection import train_test_split
from dotenv import load_dotenv

try:
    import pillow_avif
except ImportError:
    print("pillow-avif-plugin not found. Install: pip install pillow-avif-plugin")

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print(f"Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in {PROJECT_ROOT}/.env")
    SUPABASE_URL = os.environ.get("SUPABASE_URL")
    SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.")
        sys.exit(1)

OUTPUT_DIR = SCRIPT_DIR / "firered_dataset"
TEST_SIZE = 0.2
RANDOM_SEED = 42

def normalize_text(text):
    if not text:
        return ""
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def process_bubble_image(page_image, x, y, w, h):
    crop = page_image.crop((x, y, x + w, y + h))
    return crop

def fetch_all_bubbles(supabase: Client):
    print("Fetching validated bubbles from Supabase...")
    bubbles = []
    page_size = 1000
    offset = 0

    while True:
        response = (
            supabase.table("bulles")
            .select("id, x, y, w, h, texte_propose, id_page, pages(url_image)")
            .eq("statut", "Validé")
            .range(offset, offset + page_size - 1)
            .execute()
        )

        batch = response.data
        if not batch:
            break

        bubbles.extend(batch)
        print(f"  -> {len(bubbles)} fetched so far...")

        if len(batch) < page_size:
            break
        offset += page_size

    print(f"Total: {len(bubbles)} validated bubbles.")
    return bubbles

def main():
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    bubbles = fetch_all_bubbles(supabase)

    valid_data = []
    for b in bubbles:
        text = normalize_text(b.get("texte_propose", ""))
        if len(text) < 2:
            continue
        valid_data.append({
            "id": b["id"],
            "x": int(b["x"]),
            "y": int(b["y"]),
            "w": int(b["w"]),
            "h": int(b["h"]),
            "text": text,
            "url_image": b["pages"]["url_image"],
            "id_page": b["id_page"],
        })

    print(f"After filtering (text >= 2 chars): {len(valid_data)} bubbles.")

    if not valid_data:
        print("Nothing to export.")
        return

    train_data, test_data = train_test_split(
        valid_data, test_size=TEST_SIZE, random_state=RANDOM_SEED
    )

    for split_name, split_data in [("train", train_data), ("test", test_data)]:
        split_dir = OUTPUT_DIR / split_name
        split_dir.mkdir(parents=True, exist_ok=True)
        img_dir = split_dir / "images"
        img_dir.mkdir(parents=True, exist_ok=True)

        jsonl_entries = []
        page_cache = {}

        print(f"\nProcessing '{split_name}' ({len(split_data)} images)...")
        for b in tqdm(split_data, desc=split_name):
            try:
                if b["id_page"] not in page_cache:
                    resp = requests.get(b["url_image"])
                    resp.raise_for_status()
                    page_cache[b["id_page"]] = Image.open(io.BytesIO(resp.content)).convert("RGB")

                page_img = page_cache[b["id_page"]]
                processed = process_bubble_image(page_img, b["x"], b["y"], b["w"], b["h"])

                file_name = f"{b['id']}.png"
                img_path = img_dir / file_name
                processed.save(img_path, "PNG")

                rel_img_path = f"images/{file_name}"
                
                entry = {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "image", "image": rel_img_path},
                                {"type": "text", "text": "Extrais le texte de cette image sur une ligne."}
                            ]
                        },
                        {
                            "role": "assistant",
                            "content": [
                                {"type": "text", "text": b["text"]}
                            ]
                        }
                    ]
                }
                jsonl_entries.append(entry)
                
            except Exception as e:
                print(f"\n  Error on bubble {b['id']}: {e}")

        jsonl_path = split_dir / "metadata.jsonl"
        with open(jsonl_path, "w", encoding="utf-8") as f:
            for entry in jsonl_entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                
        print(f"  -> Saved {len(jsonl_entries)} entries to {jsonl_path}")

    print(f"\nDone! Dataset in: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
