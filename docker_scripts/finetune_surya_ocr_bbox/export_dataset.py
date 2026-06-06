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

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

OUTPUT_DIR = Path(
    os.getenv("SURYA_BBOX_DATASET_DIR", str(SCRIPT_DIR / "surya_bbox_dataset"))
)
STATUS_VALUE = os.getenv("SURYA_BBOX_STATUS_VALUE", "Valid\u00e9")
TARGET_LONGEST_SIDE = int(os.getenv("SURYA_BBOX_TARGET_LONGEST_SIDE", "1540"))
BBOX_NORM_SCALE = int(os.getenv("SURYA_BBOX_NORM_SCALE", "1000"))
VAL_SIZE = float(os.getenv("SURYA_BBOX_VAL_SIZE", "0.15"))
TEST_SIZE = float(os.getenv("SURYA_BBOX_TEST_SIZE", "0.15"))
RANDOM_SEED = int(os.getenv("SURYA_BBOX_RANDOM_SEED", "42"))
JPEG_QUALITY = int(os.getenv("SURYA_BBOX_JPEG_QUALITY", "95"))
MIN_BUBBLES_PER_PAGE = int(os.getenv("SURYA_BBOX_MIN_BUBBLES_PER_PAGE", "1"))
MIN_TEXT_LENGTH = int(os.getenv("SURYA_BBOX_MIN_TEXT_LENGTH", "1"))
DOWNLOAD_WORKERS = int(os.getenv("SURYA_BBOX_DOWNLOAD_WORKERS", "16"))
SUPABASE_PAGE_SIZE = int(os.getenv("SURYA_BBOX_SUPABASE_PAGE_SIZE", "1000"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("SURYA_BBOX_REQUEST_TIMEOUT_SECONDS", "45"))
CLEAN_DATASET = os.getenv("SURYA_BBOX_CLEAN_DATASET", "0").lower() not in {
    "0",
    "false",
    "no",
    "off",
    "",
}
REQUIRE_ORDER = os.getenv("SURYA_BBOX_REQUIRE_ORDER", "1").lower() not in {
    "0",
    "false",
    "no",
    "off",
    "",
}
USER_PROMPT = os.getenv(
    "SURYA_BBOX_USER_PROMPT",
    "Extrais le texte des bulles de cette page de manga dans l'ordre de lecture japonais, "
    "avec leurs bbox normalisees entre 0 et 1000. Format strict: Texte [x1,y1,x2,y2].",
)


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


def resize_page(image: Image.Image):
    image = ImageOps.exif_transpose(image).convert("RGB")
    orig_w, orig_h = image.size
    if max(orig_w, orig_h) <= TARGET_LONGEST_SIDE:
        return image, orig_w, orig_h

    if orig_w >= orig_h:
        new_w = TARGET_LONGEST_SIDE
        new_h = int(round(orig_h * (TARGET_LONGEST_SIDE / orig_w)))
    else:
        new_h = TARGET_LONGEST_SIDE
        new_w = int(round(orig_w * (TARGET_LONGEST_SIDE / orig_h)))

    return image.resize((new_w, new_h), Image.Resampling.LANCZOS), new_w, new_h


def normalize_bbox(x, y, w, h, orig_w, orig_h, new_w, new_h):
    scale_x = new_w / orig_w
    scale_y = new_h / orig_h

    x1_px = float(x) * scale_x
    y1_px = float(y) * scale_y
    x2_px = (float(x) + float(w)) * scale_x
    y2_px = (float(y) + float(h)) * scale_y

    coords = [
        int(round(x1_px / max(new_w, 1) * BBOX_NORM_SCALE)),
        int(round(y1_px / max(new_h, 1) * BBOX_NORM_SCALE)),
        int(round(x2_px / max(new_w, 1) * BBOX_NORM_SCALE)),
        int(round(y2_px / max(new_h, 1) * BBOX_NORM_SCALE)),
    ]
    return [max(0, min(BBOX_NORM_SCALE, coord)) for coord in coords]


def manga_order_key(bubble):
    order = bubble.get("order")
    if order is not None:
        return (0, int(order), 0, 0)
    # Fallback is intentionally deterministic: top-to-bottom, right-to-left.
    return (1, int(round(bubble["y"])), -int(round(bubble["x"])), bubble["id"])


def format_assistant_response(bubbles):
    return "\n".join(
        f"{item['text']} [{item['bbox'][0]},{item['bbox'][1]},{item['bbox'][2]},{item['bbox'][3]}]"
        for item in bubbles
    )


def fetch_all_bubbles(supabase: Client):
    print("Fetching validated page bubbles from Supabase...", flush=True)
    bubbles = []
    offset = 0
    while True:
        response = (
            supabase.table("bulles")
            .select("id, x, y, w, h, texte_propose, order, id_page, pages(url_image)")
            .eq("statut", STATUS_VALUE)
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
        if len(text) < MIN_TEXT_LENGTH:
            skipped["short_or_empty_text"] += 1
            continue
        if not valid_bbox_values(bubble.get("x"), bubble.get("y"), bubble.get("w"), bubble.get("h")):
            skipped["invalid_bbox"] += 1
            continue
        if REQUIRE_ORDER and bubble.get("order") is None:
            skipped["missing_reading_order"] += 1
            continue

        page = bubble.get("pages") or {}
        url_image = page.get("url_image")
        if not url_image:
            skipped["missing_page_url"] += 1
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
                "order": bubble.get("order"),
                "text": text,
            }
        )

    pages = {
        page_id: data
        for page_id, data in pages.items()
        if len(data["bubbles"]) >= MIN_BUBBLES_PER_PAGE
    }
    total_bubbles = sum(len(data["bubbles"]) for data in pages.values())
    print(
        f"After filtering: {len(pages)} pages, {total_bubbles} bubbles "
        f"(status={STATUS_VALUE!r}, require_order={REQUIRE_ORDER})",
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
        raise ValueError("SURYA_BBOX_VAL_SIZE and SURYA_BBOX_TEST_SIZE must be > 0 and sum to < 1.")
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


def entry_messages(image_file: str, assistant_text: str):
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
            "content": [{"type": "text", "text": assistant_text}],
        },
    ]


def write_split(split_name, page_ids, pages, page_cache):
    split_dir = OUTPUT_DIR / split_name
    image_dir = split_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    entries = []
    skipped = defaultdict(int)
    print(f"Processing {split_name}: {len(page_ids)} pages", flush=True)

    for page_id in tqdm(page_ids, desc=split_name):
        page_img = page_cache.get(page_id)
        if page_img is None:
            skipped["missing_page_image"] += 1
            continue

        resized_img, new_w, new_h = resize_page(page_img)
        orig_w, orig_h = page_img.size
        file_name = f"page_{page_id}.jpg"
        rel_image_path = f"images/{file_name}"
        image_path = image_dir / file_name
        resized_img.save(image_path, "JPEG", quality=JPEG_QUALITY)

        bubble_items = []
        for bubble in sorted(pages[page_id]["bubbles"], key=manga_order_key):
            bbox = normalize_bbox(
                bubble["x"],
                bubble["y"],
                bubble["w"],
                bubble["h"],
                orig_w,
                orig_h,
                new_w,
                new_h,
            )
            if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                skipped["degenerate_normalized_bbox"] += 1
                continue
            bubble_items.append(
                {
                    "id": bubble["id"],
                    "text": bubble["text"],
                    "bbox": bbox,
                    "order": bubble.get("order"),
                }
            )

        if len(bubble_items) < MIN_BUBBLES_PER_PAGE:
            skipped["page_without_enough_valid_bubbles"] += 1
            continue

        assistant_text = format_assistant_response(bubble_items)
        entries.append(
            {
                "page_id": page_id,
                "split": split_name,
                "image_file": rel_image_path,
                "original_size": [orig_w, orig_h],
                "resized_size": [new_w, new_h],
                "bbox_norm_scale": BBOX_NORM_SCALE,
                "num_bubbles": len(bubble_items),
                "bubbles": bubble_items,
                "prompt": USER_PROMPT,
                "assistant_text": assistant_text,
                "source_page_url": pages[page_id]["url_image"],
                "messages": entry_messages(rel_image_path, assistant_text),
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
    print("Verifying exported bbox dataset...", flush=True)
    errors = []
    page_to_split = {}

    for split_name in ("train", "val", "test"):
        jsonl_path = OUTPUT_DIR / split_name / "metadata.jsonl"
        if not jsonl_path.exists():
            errors.append(f"Missing {jsonl_path}")
            continue
        with open(jsonl_path, "r", encoding="utf-8") as f:
            entries = [json.loads(line) for line in f if line.strip()]

        for entry in entries:
            page_id = str(entry.get("page_id"))
            previous = page_to_split.get(page_id)
            if previous and previous != split_name:
                errors.append(f"Page leak: page {page_id} appears in {previous} and {split_name}")
            page_to_split[page_id] = split_name

            image_path = OUTPUT_DIR / split_name / entry.get("image_file", "")
            if not image_path.exists():
                errors.append(f"Missing image for page {page_id}: {image_path}")
            else:
                with Image.open(image_path) as img:
                    if img.mode != "RGB":
                        errors.append(f"Image is not RGB: {image_path}")
                    if max(img.size) > TARGET_LONGEST_SIDE + 1:
                        errors.append(f"Image exceeds target longest side: {image_path} {img.size}")

            lines = entry.get("assistant_text", "").splitlines()
            if len(lines) != len(entry.get("bubbles", [])):
                errors.append(f"Line/bubble mismatch for page {page_id}")

            for bubble in entry.get("bubbles", []):
                bbox = bubble.get("bbox")
                if not isinstance(bbox, list) or len(bbox) != 4:
                    errors.append(f"Invalid bbox for bubble {bubble.get('id')}: {bbox}")
                    continue
                if any(coord < 0 or coord > BBOX_NORM_SCALE for coord in bbox):
                    errors.append(f"BBox out of range for bubble {bubble.get('id')}: {bbox}")
                if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                    errors.append(f"Degenerate bbox for bubble {bubble.get('id')}: {bbox}")

        print(f"  {split_name}: {len(entries)} entries checked", flush=True)

    if errors:
        for error in errors[:50]:
            print(f"  ERROR: {error}", flush=True)
        raise RuntimeError(f"Dataset verification failed with {len(errors)} errors.")

    verify_split_integrity(splits)
    print("Dataset verification passed.", flush=True)


def write_report(splits, split_entries, grouping_skips, split_skips):
    report = {
        "dataset_dir": str(OUTPUT_DIR),
        "source_table": "bulles",
        "status_value": STATUS_VALUE,
        "random_seed": RANDOM_SEED,
        "target_longest_side": TARGET_LONGEST_SIDE,
        "bbox_norm_scale": BBOX_NORM_SCALE,
        "val_size": VAL_SIZE,
        "test_size": TEST_SIZE,
        "require_order": REQUIRE_ORDER,
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
            "pages": len(entries),
            "source_pages_before_processing": len(page_ids),
            "bubbles": sum(entry.get("num_bubbles", 0) for entry in entries),
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
        raise RuntimeError("No valid page bbox samples were exported from Supabase.")

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
    print("Surya bbox dataset export complete.", flush=True)


if __name__ == "__main__":
    main()
