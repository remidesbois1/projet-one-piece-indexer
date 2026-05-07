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
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import threading

try:
    import pillow_avif
except ImportError:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
FINETUNE_DIR = SCRIPT_DIR.parent
load_dotenv(FINETUNE_DIR / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env")
    sys.exit(1)

OUTPUT_DIR = FINETUNE_DIR / "lighton_bbox_dataset"
TARGET_LONGEST_SIDE = 1540
BBOX_NORM_SCALE = 1000
TEST_SIZE = 0.2
RANDOM_SEED = 42
JPEG_QUALITY = 95
MIN_BUBBLES_PER_PAGE = 1
MIN_TEXT_LENGTH = 1


def normalize_text(text):
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


def resize_page(image, target_longest_side):
    w, h = image.size
    if max(w, h) <= target_longest_side:
        return image, w, h
    if w >= h:
        new_w = target_longest_side
        new_h = int(h * (target_longest_side / w))
    else:
        new_h = target_longest_side
        new_w = int(w * (target_longest_side / h))
    resized = image.resize((new_w, new_h), Image.LANCZOS)
    return resized, new_w, new_h


def convert_bbox_to_normalized(x, y, w, h, orig_w, orig_h, new_w, new_h):
    scale_x = new_w / orig_w
    scale_y = new_h / orig_h
    x1_px = x * scale_x
    y1_px = y * scale_y
    x2_px = (x + w) * scale_x
    y2_px = (y + h) * scale_y
    x1_norm = int(round(x1_px / new_w * BBOX_NORM_SCALE))
    y1_norm = int(round(y1_px / new_h * BBOX_NORM_SCALE))
    x2_norm = int(round(x2_px / new_w * BBOX_NORM_SCALE))
    y2_norm = int(round(y2_px / new_h * BBOX_NORM_SCALE))
    x1_norm = max(0, min(BBOX_NORM_SCALE, x1_norm))
    y1_norm = max(0, min(BBOX_NORM_SCALE, y1_norm))
    x2_norm = max(0, min(BBOX_NORM_SCALE, x2_norm))
    y2_norm = max(0, min(BBOX_NORM_SCALE, y2_norm))
    return x1_norm, y1_norm, x2_norm, y2_norm


def sort_bubbles_manga_order(bubbles):
    if any(b.get("order") is None for b in bubbles):
        return None
    return sorted(bubbles, key=lambda b: b["order"])


def format_assistant_response(bubbles_with_bbox):
    lines = []
    for text, (x1, y1, x2, y2) in bubbles_with_bbox:
        lines.append(f"{text} [{x1},{y1},{x2},{y2}]")
    return "\n".join(lines)


def main():
    if OUTPUT_DIR.exists() and (OUTPUT_DIR / "test" / "metadata.jsonl").exists():
        print(f"Dataset already exists at {OUTPUT_DIR}. Skipping download.")
        return

    print("Downloading dataset from Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Fetching validated bubbles...")
    bubbles = []
    page_size = 1000
    offset = 0
    while True:
        response = (
            supabase.table("bulles")
            .select("id, x, y, w, h, texte_propose, order, id_page, pages(url_image)")
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

    pages_dict = defaultdict(lambda: {"bubbles": [], "url_image": None})
    for b in bubbles:
        text = normalize_text(b.get("texte_propose", ""))
        if len(text) < MIN_TEXT_LENGTH:
            continue
        page_id = b["id_page"]
        pages_dict[page_id]["url_image"] = b["pages"]["url_image"]
        pages_dict[page_id]["bubbles"].append(
            {
                "id": b["id"],
                "x": int(b["x"]),
                "y": int(b["y"]),
                "w": int(b["w"]),
                "h": int(b["h"]),
                "order": b.get("order", 9999),
                "text": text,
            }
        )

    pages_dict = {
        pid: pdata
        for pid, pdata in pages_dict.items()
        if len(pdata["bubbles"]) >= MIN_BUBBLES_PER_PAGE
    }

    print(f"Pages with >= {MIN_BUBBLES_PER_PAGE} bubbles: {len(pages_dict)}")
    total_bubbles = sum(len(p["bubbles"]) for p in pages_dict.values())
    print(f"Total bubbles: {total_bubbles}")

    page_ids = list(pages_dict.keys())
    train_ids, test_ids = train_test_split(
        page_ids, test_size=TEST_SIZE, random_state=RANDOM_SEED
    )
    print(f"Split: {len(train_ids)} train, {len(test_ids)} test")

    print(f"\nDownloading {len(pages_dict)} pages in parallel...")
    page_images = {}
    page_images_lock = threading.Lock()
    session = requests.Session()

    def download_page(page_id, url):
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")
            with page_images_lock:
                page_images[page_id] = img
        except Exception as e:
            print(f"  Failed to download page {page_id}: {e}")

    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = [
            executor.submit(download_page, pid, pdata["url_image"])
            for pid, pdata in pages_dict.items()
        ]
        for f in tqdm(as_completed(futures), total=len(futures), desc="Downloading"):
            pass

    print(f"  -> {len(page_images)} pages downloaded.")

    for split_name, split_ids in [("train", train_ids), ("test", test_ids)]:
        split_dir = OUTPUT_DIR / split_name
        img_dir = split_dir / "images"
        img_dir.mkdir(parents=True, exist_ok=True)

        jsonl_entries = []
        print(f"\nProcessing '{split_name}' ({len(split_ids)} pages)...")
        for page_id in tqdm(split_ids, desc=split_name):
            if page_id not in page_images:
                continue
            page_data = pages_dict[page_id]
            page_img = page_images[page_id]
            orig_w, orig_h = page_img.size
            resized_img, new_w, new_h = resize_page(page_img, TARGET_LONGEST_SIDE)

            file_name = f"page_{page_id}.jpg"
            img_path = img_dir / file_name
            if not img_path.exists():
                resized_img.save(img_path, "JPEG", quality=JPEG_QUALITY)

            sorted_bubbles = sort_bubbles_manga_order(page_data["bubbles"])
            if sorted_bubbles is None:
                continue

            bubbles_with_bbox = []
            for bubble in sorted_bubbles:
                x1, y1, x2, y2 = convert_bbox_to_normalized(
                    bubble["x"],
                    bubble["y"],
                    bubble["w"],
                    bubble["h"],
                    orig_w,
                    orig_h,
                    new_w,
                    new_h,
                )
                bubbles_with_bbox.append((bubble["text"], (x1, y1, x2, y2)))

            assistant_text = format_assistant_response(bubbles_with_bbox)
            entry = {
                "page_id": page_id,
                "image_file": f"images/{file_name}",
                "original_size": [orig_w, orig_h],
                "resized_size": [new_w, new_h],
                "num_bubbles": len(bubbles_with_bbox),
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image", "image": f"images/{file_name}"},
                            {
                                "type": "text",
                                "text": "Extrais le texte et les coordonnées des bulles de cette page de manga.",
                            },
                        ],
                    },
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": assistant_text}],
                    },
                ],
            }
            jsonl_entries.append(entry)

        jsonl_path = split_dir / "metadata.jsonl"
        with open(jsonl_path, "w", encoding="utf-8") as f:
            for entry in jsonl_entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        print(f"  -> {len(jsonl_entries)} entries saved to {jsonl_path}")

    print(f"\nDataset ready at: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
