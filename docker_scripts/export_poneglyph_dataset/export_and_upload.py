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
from huggingface_hub import HfApi

try:
    import pillow_avif
    print("✅ AVIF support enabled")
except ImportError:
    pass

# Paths
SCRIPT_DIR = Path(__file__).resolve().parent
# Try to load .env from parent or current dir
load_dotenv(SCRIPT_DIR / ".." / ".." / ".env")
load_dotenv() # Also check current dir

# Config
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
HF_TOKEN = os.getenv("HF_TOKEN")
REPO_ID = "Remidesbois/Poneglyph"
OUTPUT_DIR = SCRIPT_DIR / "poneglyph_dataset"
TEST_SIZE = 0.2
RANDOM_SEED = 42

if not all([SUPABASE_URL, SUPABASE_KEY, HF_TOKEN]):
    print("Missing API Keys (Supabase or HF). Check your .env")
    sys.exit(1)

def normalize_text(text):
    if not text: return ""
    return re.sub(r'\s+', ' ', text).strip()

def process_bubble_image(page_image, x, y, w, h):
    return page_image.crop((x, y, x + w, y + h))

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
        if not batch: break
        bubbles.extend(batch)
        print(f"  -> {len(bubbles)} fetched...")
        if len(batch) < page_size: break
        offset += page_size
    return bubbles

def main():
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    bubbles = fetch_all_bubbles(supabase)
    
    valid_data = []
    for b in bubbles:
        text = normalize_text(b.get("texte_propose", ""))
        if len(text) < 2: continue
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

    print(f"Valid bubbles: {len(valid_data)}")
    if not valid_data:
        print("Nothing to export.")
        return

    train_data, test_data = train_test_split(valid_data, test_size=TEST_SIZE, random_state=RANDOM_SEED)

    for split_name, split_data in [("train", train_data), ("test", test_data)]:
        split_dir = OUTPUT_DIR / split_name
        split_dir.mkdir(parents=True, exist_ok=True)
        img_dir = split_dir 

        jsonl_entries = []
        page_cache = {}

        print(f"\nProcessing '{split_name}' ({len(split_data)} images)...")
        for b in tqdm(split_data, desc=split_name):
            try:
                file_name = f"{b['id']}.png"
                img_path = img_dir / file_name
                
                if b["id_page"] not in page_cache:
                    resp = requests.get(b["url_image"])
                    resp.raise_for_status()
                    page_cache[b["id_page"]] = Image.open(io.BytesIO(resp.content)).convert("RGB")

                page_img = page_cache[b["id_page"]]
                processed = process_bubble_image(page_img, b["x"], b["y"], b["w"], b["h"])
                processed.save(img_path, "PNG")

                entry = {
                    "file_name": file_name,
                    "messages": [
                        {
                            "role": "user",
                            "content": [{"type": "image", "image": file_name}]
                        },
                        {
                            "role": "assistant",
                            "content": [{"type": "text", "text": b["text"]}]
                        }
                    ]
                }
                jsonl_entries.append(entry)
                
            except Exception as e:
                print(f"Error on bubble {b['id']}: {e}")

        jsonl_path = split_dir / "metadata.jsonl"
        with open(jsonl_path, "w", encoding="utf-8") as f:
            for entry in jsonl_entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print("\n🚀 Uploading to Hugging Face...")
    api = HfApi(token=HF_TOKEN)
    api.create_repo(repo_id=REPO_ID, repo_type="dataset", exist_ok=True)
    api.upload_folder(
        folder_path=str(OUTPUT_DIR),
        repo_id=REPO_ID,
        repo_type="dataset"
    )
    print(f"\n✅ Dataset '{REPO_ID}' updated successfully!")

if __name__ == "__main__":
    main()
