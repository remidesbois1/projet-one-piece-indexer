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
from PIL import Image
from sklearn.model_selection import train_test_split
from supabase import Client, create_client
from tqdm import tqdm

try:
    import pillow_avif  # noqa: F401

    print("AVIF support enabled via pillow-avif-plugin", flush=True)
except ImportError:
    print("AVIF support NOT found. AVIF images will fail to open.", flush=True)


SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.", flush=True)
    sys.exit(1)

OUTPUT_DIR = Path(os.getenv("LIGHTON_DATASET_DIR", str(SCRIPT_DIR / "lighton_dataset")))
STATUS_VALUE = os.getenv("LIGHTON_STATUS_VALUE", "Valid\u00e9")
VAL_SIZE = float(os.getenv("LIGHTON_VAL_SIZE", "0.15"))
TEST_SIZE = float(os.getenv("LIGHTON_TEST_SIZE", "0.15"))
RANDOM_SEED = int(os.getenv("LIGHTON_RANDOM_SEED", "42"))
MIN_TEXT_LENGTH = int(os.getenv("LIGHTON_MIN_TEXT_LENGTH", "2"))
DOWNLOAD_WORKERS = int(os.getenv("LIGHTON_DOWNLOAD_WORKERS", "16"))
SUPABASE_PAGE_SIZE = int(os.getenv("LIGHTON_SUPABASE_PAGE_SIZE", "1000"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("LIGHTON_REQUEST_TIMEOUT_SECONDS", "30"))
CLEAN_DATASET = os.getenv("LIGHTON_CLEAN_DATASET", "0").lower() not in {
    "0",
    "false",
    "no",
    "off",
    "",
}


def normalize_text(text):
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


def process_bubble_image(page_image, x, y, w, h):
    img_w, img_h = page_image.size
    x1 = max(0, min(img_w, int(round(x))))
    y1 = max(0, min(img_h, int(round(y))))
    x2 = max(0, min(img_w, int(round(x + w))))
    y2 = max(0, min(img_h, int(round(y + h))))

    if x2 <= x1 or y2 <= y1:
        return None

    return page_image.crop((x1, y1, x2, y2))


def fetch_all_bubbles(supabase: Client):
    print("Fetching validated bubbles from Supabase...", flush=True)
    bubbles = []
    offset = 0

    while True:
        response = (
            supabase.table("bulles")
            .select("id, x, y, w, h, texte_propose, id_page, pages(url_image)")
            .eq("statut", STATUS_VALUE)
            .range(offset, offset + SUPABASE_PAGE_SIZE - 1)
            .execute()
        )

        batch = response.data
        if not batch:
            break

        bubbles.extend(batch)
        print(f"  -> {len(bubbles)} fetched so far...", flush=True)

        if len(batch) < SUPABASE_PAGE_SIZE:
            break
        offset += SUPABASE_PAGE_SIZE

    print(f"Total: {len(bubbles)} validated bubbles.", flush=True)
    return bubbles


def build_page_groups(bubbles):
    pages = defaultdict(lambda: {"url_image": None, "bubbles": []})

    for b in bubbles:
        text = normalize_text(b.get("texte_propose", ""))
        if len(text) < MIN_TEXT_LENGTH:
            continue

        page = b.get("pages") or {}
        url_image = page.get("url_image")
        if not url_image:
            continue

        page_id = b["id_page"]
        pages[page_id]["url_image"] = url_image
        pages[page_id]["bubbles"].append(
            {
                "id": b["id"],
                "x": int(b["x"]),
                "y": int(b["y"]),
                "w": int(b["w"]),
                "h": int(b["h"]),
                "text": text,
                "id_page": page_id,
                "url_image": url_image,
            }
        )

    pages = {pid: pdata for pid, pdata in pages.items() if pdata["bubbles"]}
    total_bubbles = sum(len(pdata["bubbles"]) for pdata in pages.values())
    print(
        f"After filtering: {len(pages)} pages, {total_bubbles} bubbles "
        f"(text >= {MIN_TEXT_LENGTH} chars).",
        flush=True,
    )
    return pages


def split_pages(page_ids):
    if VAL_SIZE <= 0 or TEST_SIZE <= 0 or VAL_SIZE + TEST_SIZE >= 1:
        raise ValueError("LIGHTON_VAL_SIZE and LIGHTON_TEST_SIZE must be > 0 and sum to < 1.")

    train_ids, holdout_ids = train_test_split(
        page_ids,
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


def verify_split_integrity(splits):
    seen = {}
    leaks = []
    for split_name, page_ids in splits.items():
        for page_id in page_ids:
            if page_id in seen:
                leaks.append((page_id, seen[page_id], split_name))
            seen[page_id] = split_name

    if leaks:
        details = ", ".join(f"page {pid}: {a}/{b}" for pid, a, b in leaks[:10])
        raise RuntimeError(f"Page-level split leak detected: {details}")


def download_pages(pages):
    print(f"\nDownloading {len(pages)} unique pages in parallel...", flush=True)
    page_cache = {}
    page_cache_lock = threading.Lock()

    def download_page(page_id, url):
        try:
            resp = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS)
            resp.raise_for_status()
            with Image.open(io.BytesIO(resp.content)) as img:
                page_img = img.convert("RGB")
            with page_cache_lock:
                page_cache[page_id] = page_img
        except Exception as exc:
            print(f"  Failed to download page {page_id}: {exc}", flush=True)

    with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as executor:
        futures = [
            executor.submit(download_page, page_id, pdata["url_image"])
            for page_id, pdata in pages.items()
        ]
        for _ in tqdm(as_completed(futures), total=len(futures), desc="Downloading pages"):
            pass

    print(f"  -> {len(page_cache)} pages cached.", flush=True)
    return page_cache


def write_split(split_name, page_ids, pages, page_cache):
    split_dir = OUTPUT_DIR / split_name
    img_dir = split_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)

    jsonl_entries = []
    skipped = 0

    split_bubbles = []
    for page_id in page_ids:
        split_bubbles.extend(pages[page_id]["bubbles"])

    print(
        f"\nProcessing '{split_name}' ({len(page_ids)} pages, {len(split_bubbles)} bubbles)...",
        flush=True,
    )

    for bubble in tqdm(split_bubbles, desc=split_name):
        try:
            page_img = page_cache.get(bubble["id_page"])
            if page_img is None:
                skipped += 1
                continue

            file_name = f"{bubble['id']}.png"
            img_path = img_dir / file_name

            if not img_path.exists():
                processed = process_bubble_image(
                    page_img,
                    bubble["x"],
                    bubble["y"],
                    bubble["w"],
                    bubble["h"],
                )
                if processed is None:
                    skipped += 1
                    continue
                processed.save(img_path, "PNG")

            rel_img_path = f"images/{file_name}"
            jsonl_entries.append(
                {
                    "id": bubble["id"],
                    "page_id": bubble["id_page"],
                    "split": split_name,
                    "bbox": [bubble["x"], bubble["y"], bubble["w"], bubble["h"]],
                    "image_file": rel_img_path,
                    "text": bubble["text"],
                    "messages": [
                        {
                            "role": "user",
                            "content": [{"type": "image", "image": rel_img_path}],
                        },
                        {
                            "role": "assistant",
                            "content": [{"type": "text", "text": bubble["text"]}],
                        },
                    ],
                }
            )
        except Exception as exc:
            skipped += 1
            print(f"\n  Error on bubble {bubble['id']}: {exc}", flush=True)

    jsonl_path = split_dir / "metadata.jsonl"
    with open(jsonl_path, "w", encoding="utf-8") as f:
        for entry in jsonl_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(
        f"  -> Saved {len(jsonl_entries)} entries to {jsonl_path} "
        f"({skipped} skipped)",
        flush=True,
    )
    return len(jsonl_entries), skipped


def verify_dataset(splits):
    print("\nVerifying exported dataset...", flush=True)
    errors = 0
    page_to_split = {}

    for split_name in splits:
        jsonl_path = OUTPUT_DIR / split_name / "metadata.jsonl"
        if not jsonl_path.exists():
            print(f"  Missing {jsonl_path}", flush=True)
            errors += 1
            continue

        with open(jsonl_path, "r", encoding="utf-8") as f:
            entries = [json.loads(line) for line in f if line.strip()]

        for entry in entries:
            page_id = entry.get("page_id")
            previous_split = page_to_split.get(page_id)
            if previous_split and previous_split != split_name:
                print(
                    f"  Page leak: page {page_id} in {previous_split} and {split_name}",
                    flush=True,
                )
                errors += 1
            page_to_split[page_id] = split_name

            image_file = entry.get("image_file") or entry["messages"][0]["content"][0]["image"]
            img_path = OUTPUT_DIR / split_name / image_file
            if not img_path.exists():
                print(f"  Missing image: {img_path}", flush=True)
                errors += 1

            text = entry.get("text", "")
            if not text:
                print(f"  Empty text in {split_name}: {entry.get('id')}", flush=True)
                errors += 1

        print(f"  {split_name}: {len(entries)} entries checked", flush=True)

    if errors:
        raise RuntimeError(f"Dataset verification failed with {errors} errors.")
    print("  All checks passed.", flush=True)


def main():
    if CLEAN_DATASET and OUTPUT_DIR.exists():
        print(f"Cleaning existing dataset directory: {OUTPUT_DIR}", flush=True)
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    bubbles = fetch_all_bubbles(supabase)
    pages = build_page_groups(bubbles)

    if not pages:
        print("Nothing to export.", flush=True)
        return

    splits = split_pages(list(pages.keys()))
    print("\nPage-level split:", flush=True)
    for split_name, page_ids in splits.items():
        n_bubbles = sum(len(pages[pid]["bubbles"]) for pid in page_ids)
        print(f"  {split_name}: {len(page_ids)} pages, {n_bubbles} bubbles", flush=True)

    page_cache = download_pages(pages)

    stats = {}
    for split_name, page_ids in splits.items():
        saved, skipped = write_split(split_name, page_ids, pages, page_cache)
        stats[split_name] = {"saved": saved, "skipped": skipped}

    verify_dataset(splits)

    report = {
        "dataset_dir": str(OUTPUT_DIR),
        "source_table": "bulles",
        "status_value": STATUS_VALUE,
        "random_seed": RANDOM_SEED,
        "val_size": VAL_SIZE,
        "test_size": TEST_SIZE,
        "min_text_length": MIN_TEXT_LENGTH,
        "splits": {},
    }
    for split_name, page_ids in splits.items():
        report["splits"][split_name] = {
            "pages": len(page_ids),
            "bubbles": stats[split_name]["saved"],
            "metadata": str(OUTPUT_DIR / split_name / "metadata.jsonl"),
            "skipped": stats[split_name]["skipped"],
        }
    report_path = OUTPUT_DIR / "dataset_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"Dataset report saved to {report_path}", flush=True)

    print("\nDataset export summary", flush=True)
    print("-" * 60, flush=True)
    for split_name, split_stats in stats.items():
        print(
            f"  {split_name}: {split_stats['saved']} samples, "
            f"{split_stats['skipped']} skipped",
            flush=True,
        )
    print(f"  output: {OUTPUT_DIR}", flush=True)
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
