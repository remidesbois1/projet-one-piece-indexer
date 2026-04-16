import os
import sys
import json
import requests
import io
from pathlib import Path
from PIL import Image
from supabase import create_client, Client
from tqdm import tqdm
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
    env_path = SCRIPT_DIR.parent.parent / ".env"
    load_dotenv(env_path)
    SUPABASE_URL = os.getenv("SUPABASE_URL")
    SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

OUTPUT_DIR = SCRIPT_DIR / "dataset"
IMAGES_DIR = OUTPUT_DIR / "images"


def fetch_pages_without_bubbles(supabase: Client):
    print("Fetching pages without bubbles from Supabase...")

    pages_resp = (
        supabase.table("pages")
        .select("id, url_image, numero_page")
        .eq("statut", "completed")
        .execute()
    )
    all_pages = {p["id"]: p for p in pages_resp.data}
    print(f"Total completed pages: {len(all_pages)}")

    bubbles_resp = (
        supabase.table("bulles")
        .select("id_page")
        .execute()
    )
    pages_with_bubbles = {b["id_page"] for b in bubbles_resp.data}
    print(f"Pages with bubbles: {len(pages_with_bubbles)}")

    pages_without = [p for p in all_pages.values() if p["id"] not in pages_with_bubbles]
    print(f"Pages without bubbles: {len(pages_without)}")
    return pages_without


def main():
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    pages = fetch_pages_without_bubbles(supabase)

    if not pages:
        print("No pages to download.")
        return

    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    metadata = {"pages": []}

    print(f"\nDownloading {len(pages)} pages...")
    for p in tqdm(pages, desc="Downloading"):
        try:
            resp = requests.get(p["url_image"], timeout=30)
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")

            img_filename = f"page_{p['id']}.jpg"
            img.save(IMAGES_DIR / img_filename, quality=95)

            metadata["pages"].append({
                "id": p["id"],
                "file": img_filename,
                "width": img.width,
                "height": img.height,
            })
        except Exception as e:
            print(f"\n  Error on page {p['id']}: {e}")

    with open(OUTPUT_DIR / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\nDone. {len(metadata['pages'])} images saved to {IMAGES_DIR}")
    print(f"Metadata at {OUTPUT_DIR / 'metadata.json'}")


if __name__ == "__main__":
    main()
