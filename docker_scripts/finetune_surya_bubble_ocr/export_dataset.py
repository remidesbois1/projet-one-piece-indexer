import io
import json
import os
import re
import shutil
import sys
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from dotenv import load_dotenv
from PIL import Image, ImageOps
from sklearn.model_selection import train_test_split
from supabase import Client, create_client
from tqdm import tqdm

try:
    import pillow_avif  # noqa: F401

    print("AVIF support enabled via pillow-avif-plugin", flush=True)
except ImportError:
    print("AVIF support not found. AVIF images will fail to open.", flush=True)


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent
import sys
sys.path.insert(0, str(DOCKER_SCRIPTS_DIR))
from common_training.prompts import get_prompt

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

OUTPUT_DIR = Path(os.getenv("SURYA_DATASET_DIR", str(SCRIPT_DIR / "surya_bubble_dataset")))
VAL_SIZE = float(os.getenv("SURYA_VAL_SIZE", "0.15"))
TEST_SIZE = float(os.getenv("SURYA_TEST_SIZE", "0.15"))
RANDOM_SEED = int(os.getenv("SURYA_RANDOM_SEED", "42"))
MIN_TEXT_LENGTH = int(os.getenv("SURYA_MIN_TEXT_LENGTH", "1"))
ALLOW_EMPTY_TEXT = os.getenv("SURYA_ALLOW_EMPTY_TEXT", "0").lower() not in {
    "0",
    "false",
    "no",
    "off",
    "",
}
DOWNLOAD_WORKERS = int(os.getenv("SURYA_DOWNLOAD_WORKERS", "16"))
SUPABASE_PAGE_SIZE = int(os.getenv("SURYA_SUPABASE_PAGE_SIZE", "1000"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("SURYA_REQUEST_TIMEOUT_SECONDS", "45"))
CROP_PAD_PX = int(os.getenv("SURYA_CROP_PAD_PX", "0"))
USER_PROMPT = get_prompt("ocr_surya_bubble", "SURYA_USER_PROMPT")
CLEAN_DATASET = os.getenv("SURYA_CLEAN_DATASET", "0").lower() not in {
    "0",
    "false",
    "no",
    "off",
    "",
}


def require_env() -> None:
    missing = [
        name
        for name, value in {
            "SUPABASE_URL": SUPABASE_URL,
            "SUPABASE_SERVICE_ROLE_KEY": SUPABASE_KEY,
        }.items()
        if not value
    ]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}", flush=True)
        sys.exit(1)


def normalize_text(text) -> str:
    if text is None:
        return ""
    return re.sub(r"\s+", " ", str(text)).strip()


def as_number(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def valid_bbox_values(x, y, w, h) -> bool:
    values = [as_number(v) for v in (x, y, w, h)]
    return all(v is not None for v in values) and values[2] > 0 and values[3] > 0


def crop_bubble_image(page_image: Image.Image, x, y, w, h):
    if not valid_bbox_values(x, y, w, h):
        return None

    img_w, img_h = page_image.size
    x = float(x)
    y = float(y)
    w = float(w)
    h = float(h)

    x1 = max(0, min(img_w, int(round(x - CROP_PAD_PX))))
    y1 = max(0, min(img_h, int(round(y - CROP_PAD_PX))))
    x2 = max(0, min(img_w, int(round(x + w + CROP_PAD_PX))))
    y2 = max(0, min(img_h, int(round(y + h + CROP_PAD_PX))))

    if x2 <= x1 or y2 <= y1:
        return None

    return page_image.crop((x1, y1, x2, y2)).convert("RGB")


def fetch_all_bubbles(supabase: Client):
    print("Fetching validated bubbles from Supabase...", flush=True)
    bubbles = []
    offset = 0

    while True:
        response = (
            supabase.table("bulles")
            .select("id, x, y, w, h, texte_propose, id_page, pages(url_image)")
            .eq("statut", "Validé")
            .range(offset, offset + SUPABASE_PAGE_SIZE - 1)
            .execute()
        )

        batch = response.data or []
        if not batch:
            break

        bubbles.extend(batch)
        print(f"  fetched {len(bubbles)} bubbles so far", flush=True)

        if len(batch) < SUPABASE_PAGE_SIZE:
            break
        offset += SUPABASE_PAGE_SIZE

    print(f"Total validated bubbles fetched: {len(bubbles)}", flush=True)
    return bubbles


def build_page_groups(bubbles):
    pages = defaultdict(lambda: {"url_image": None, "bubbles": []})
    skipped = defaultdict(int)

    for bubble in bubbles:
        text = normalize_text(bubble.get("texte_propose"))
        if not text and not ALLOW_EMPTY_TEXT:
            skipped["empty_text"] += 1
            continue
        if text and len(text) < MIN_TEXT_LENGTH:
            skipped["short_text"] += 1
            continue

        page = bubble.get("pages") or {}
        url_image = page.get("url_image")
        if not url_image:
            skipped["missing_page_url"] += 1
            continue

        if not valid_bbox_values(bubble.get("x"), bubble.get("y"), bubble.get("w"), bubble.get("h")):
            skipped["invalid_bbox"] += 1
            continue

        page_id = str(bubble["id_page"])
        pages[page_id]["url_image"] = url_image
        pages[page_id]["bubbles"].append(
            {
                "id": str(bubble["id"]),
                "page_id": page_id,
                "x": float(bubble["x"]),
                "y": float(bubble["y"]),
                "w": float(bubble["w"]),
                "h": float(bubble["h"]),
                "text": text,
                "source_page_url": url_image,
            }
        )

    pages = {page_id: data for page_id, data in pages.items() if data["bubbles"]}
    total_bubbles = sum(len(data["bubbles"]) for data in pages.values())
    print(
        f"After filtering: {len(pages)} pages, {total_bubbles} bubbles "
        f"(allow_empty={ALLOW_EMPTY_TEXT}, min_text_length={MIN_TEXT_LENGTH})",
        flush=True,
    )
    if skipped:
        print(f"Skipped during grouping: {dict(skipped)}", flush=True)
    return pages, dict(skipped)


def verify_split_integrity(splits) -> None:
    seen = {}
    leaks = []
    for split_name, page_ids in splits.items():
        for page_id in page_ids:
            previous = seen.get(page_id)
            if previous and previous != split_name:
                leaks.append((page_id, previous, split_name))
            seen[page_id] = split_name

    if leaks:
        details = ", ".join(f"{page_id}: {a}/{b}" for page_id, a, b in leaks[:10])
        raise RuntimeError(f"Page-level split leak detected: {details}")


def split_pages(page_ids):
    if VAL_SIZE <= 0 or TEST_SIZE <= 0 or VAL_SIZE + TEST_SIZE >= 1:
        raise ValueError("SURYA_VAL_SIZE and SURYA_TEST_SIZE must be > 0 and sum to < 1.")
    if len(page_ids) < 3:
        raise ValueError("At least 3 distinct pages are required for train/val/test splits.")

    train_ids, holdout_ids = train_test_split(
        sorted(page_ids),
        test_size=VAL_SIZE + TEST_SIZE,
        random_state=RANDOM_SEED,
        shuffle=True,
    )
    relative_test_size = TEST_SIZE / (VAL_SIZE + TEST_SIZE)
    val_ids, test_ids = train_test_split(
        holdout_ids,
        test_size=relative_test_size,
        random_state=RANDOM_SEED,
        shuffle=True,
    )
    splits = {
        "train": sorted(train_ids),
        "val": sorted(val_ids),
        "test": sorted(test_ids),
    }
    verify_split_integrity(splits)
    return splits


def download_pages(pages):
    print(f"Downloading {len(pages)} unique source pages...", flush=True)
    page_cache = {}
    page_cache_lock = threading.Lock()

    def download_page(page_id, url):
        try:
            response = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS)
            response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as img:
                page_img = ImageOps.exif_transpose(img).convert("RGB")
            with page_cache_lock:
                page_cache[page_id] = page_img
        except Exception as exc:
            print(f"  failed to download page {page_id}: {exc}", flush=True)

    with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as executor:
        futures = [
            executor.submit(download_page, page_id, data["url_image"])
            for page_id, data in pages.items()
        ]
        for _ in tqdm(as_completed(futures), total=len(futures), desc="Downloading pages"):
            pass

    print(f"Cached pages: {len(page_cache)}/{len(pages)}", flush=True)
    return page_cache


def entry_messages(image_file: str, text: str):
    return [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image_file},
                {"type": "text", "text": USER_PROMPT},
            ],
        },
        {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    ]


def write_split(split_name, page_ids, pages, page_cache):
    split_dir = OUTPUT_DIR / split_name
    image_dir = split_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    entries = []
    skipped = defaultdict(int)
    split_bubbles = []
    for page_id in page_ids:
        split_bubbles.extend(pages[page_id]["bubbles"])

    print(
        f"Processing {split_name}: {len(page_ids)} pages, {len(split_bubbles)} bubbles",
        flush=True,
    )

    for bubble in tqdm(split_bubbles, desc=split_name):
        page_img = page_cache.get(bubble["page_id"])
        if page_img is None:
            skipped["missing_page_image"] += 1
            continue

        crop = crop_bubble_image(page_img, bubble["x"], bubble["y"], bubble["w"], bubble["h"])
        if crop is None:
            skipped["invalid_or_empty_crop"] += 1
            continue

        file_name = f"{bubble['id']}.png"
        image_path = image_dir / file_name
        crop.save(image_path, "PNG")
        rel_image_path = f"images/{file_name}"
        bbox = [
            int(round(bubble["x"])),
            int(round(bubble["y"])),
            int(round(bubble["w"])),
            int(round(bubble["h"])),
        ]
        entries.append(
            {
                "id": bubble["id"],
                "page_id": bubble["page_id"],
                "split": split_name,
                "bbox": bbox,
                "image_file": rel_image_path,
                "text": bubble["text"],
                "source_page_url": bubble["source_page_url"],
                "prompt": USER_PROMPT,
                "messages": entry_messages(rel_image_path, bubble["text"]),
            }
        )

    jsonl_path = split_dir / "metadata.jsonl"
    with open(jsonl_path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(
        f"Saved {len(entries)} entries to {jsonl_path} "
        f"({sum(skipped.values())} skipped)",
        flush=True,
    )
    return entries, dict(skipped)


def verify_dataset(splits):
    print("Verifying exported dataset...", flush=True)
    errors = []
    page_to_split = {}
    split_counts = {}

    for split_name in ("train", "val", "test"):
        jsonl_path = OUTPUT_DIR / split_name / "metadata.jsonl"
        if not jsonl_path.exists():
            errors.append(f"Missing {jsonl_path}")
            continue

        with open(jsonl_path, "r", encoding="utf-8") as f:
            entries = [json.loads(line) for line in f if line.strip()]

        split_counts[split_name] = len(entries)
        for entry in entries:
            page_id = str(entry.get("page_id"))
            previous = page_to_split.get(page_id)
            if previous and previous != split_name:
                errors.append(f"Page leak: page {page_id} appears in {previous} and {split_name}")
            page_to_split[page_id] = split_name

            bbox = entry.get("bbox")
            if not isinstance(bbox, list) or len(bbox) != 4 or bbox[2] <= 0 or bbox[3] <= 0:
                errors.append(f"Invalid bbox for bubble {entry.get('id')}: {bbox}")

            text = entry.get("text", "")
            if not text and not ALLOW_EMPTY_TEXT:
                errors.append(f"Empty text for bubble {entry.get('id')} in {split_name}")

            image_file = entry.get("image_file")
            image_path = OUTPUT_DIR / split_name / image_file
            if not image_path.exists():
                errors.append(f"Missing image for bubble {entry.get('id')}: {image_path}")
            else:
                try:
                    with Image.open(image_path) as img:
                        if img.mode != "RGB":
                            errors.append(f"Image is not RGB: {image_path}")
                        if img.width <= 0 or img.height <= 0:
                            errors.append(f"Invalid image size: {image_path}")
                except Exception as exc:
                    errors.append(f"Unreadable image {image_path}: {exc}")

        print(f"  {split_name}: {len(entries)} entries checked", flush=True)

    if errors:
        for error in errors[:50]:
            print(f"  ERROR: {error}", flush=True)
        raise RuntimeError(f"Dataset verification failed with {len(errors)} errors.")

    verify_split_integrity(splits)
    print("Dataset verification passed.", flush=True)
    return split_counts


def write_report(splits, split_entries, grouping_skips, split_skips):
    report = {
        "dataset_dir": str(OUTPUT_DIR),
        "random_seed": RANDOM_SEED,
        "val_size": VAL_SIZE,
        "test_size": TEST_SIZE,
        "allow_empty_text": ALLOW_EMPTY_TEXT,
        "min_text_length": MIN_TEXT_LENGTH,
        "crop_pad_px": CROP_PAD_PX,
        "prompt": USER_PROMPT,
        "splits": {},
        "skipped": {
            "grouping": grouping_skips,
            "split_processing": split_skips,
        },
    }
    for split_name, page_ids in splits.items():
        entries = split_entries.get(split_name, [])
        report["splits"][split_name] = {
            "pages": len(page_ids),
            "bubbles": len(entries),
            "metadata": str(OUTPUT_DIR / split_name / "metadata.jsonl"),
        }

    report_path = OUTPUT_DIR / "dataset_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"Dataset report saved to {report_path}", flush=True)


def main():
    require_env()

    if CLEAN_DATASET and OUTPUT_DIR.exists():
        print(f"Cleaning existing dataset directory: {OUTPUT_DIR}", flush=True)
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    bubbles = fetch_all_bubbles(supabase)
    pages, grouping_skips = build_page_groups(bubbles)
    if not pages:
        raise RuntimeError("No valid bubbles were exported from Supabase.")

    splits = split_pages(list(pages.keys()))
    print("Page-level split:", flush=True)
    for split_name, page_ids in splits.items():
        n_bubbles = sum(len(pages[page_id]["bubbles"]) for page_id in page_ids)
        print(f"  {split_name}: {len(page_ids)} pages, {n_bubbles} bubbles", flush=True)

    page_cache = download_pages(pages)
    split_entries = {}
    split_skips = {}
    for split_name, page_ids in splits.items():
        entries, skipped = write_split(split_name, page_ids, pages, page_cache)
        split_entries[split_name] = entries
        split_skips[split_name] = skipped

    verify_dataset(splits)
    write_report(splits, split_entries, grouping_skips, split_skips)
    print("Dataset export complete.", flush=True)


if __name__ == "__main__":
    main()
