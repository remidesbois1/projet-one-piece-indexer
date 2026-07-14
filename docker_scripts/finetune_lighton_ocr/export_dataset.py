import io
import hashlib
import json
import os
import re
import shutil
import sys
import threading
import urllib.request
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
SPLIT_MANIFEST = OUTPUT_DIR / "split_manifest.json"
BASELINE_BENCHMARK = os.getenv(
    "LIGHTON_BASELINE_BENCHMARK",
    "https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/resolve/main/benchmark_test.json",
)
NEAR_DUPLICATE_DISTANCE = int(os.getenv("LIGHTON_NEAR_DUPLICATE_DISTANCE", "4"))


def normalize_text(text):
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


def image_hashes(image):
    rgb = image.convert("RGB")
    exact = hashlib.sha256(rgb.tobytes() + str(rgb.size).encode("ascii")).hexdigest()
    gray = rgb.resize((9, 8), Image.Resampling.LANCZOS).convert("L")
    pixel_source = (
        gray.get_flattened_data()
        if hasattr(gray, "get_flattened_data")
        else gray.getdata()
    )
    pixels = list(pixel_source)
    bits = 0
    for y in range(8):
        for x in range(8):
            bits = (bits << 1) | int(pixels[y * 9 + x] > pixels[y * 9 + x + 1])
    return exact, bits


class DuplicateIndex:
    """Small BK-tree-like index suitable for a few thousand bubble crops."""

    def __init__(self, max_distance=4):
        self.max_distance = max_distance
        self.exact = {}
        self.hashes = []

    def find(self, exact_hash, perceptual_hash):
        if exact_hash in self.exact:
            return self.exact[exact_hash], "exact"
        for previous_hash, payload in self.hashes:
            if (previous_hash ^ perceptual_hash).bit_count() <= self.max_distance:
                return payload, "near"
        return None, None

    def add(self, exact_hash, perceptual_hash, payload):
        self.exact[exact_hash] = payload
        self.hashes.append((perceptual_hash, payload))


def stable_bucket(value):
    digest = hashlib.sha256(f"{RANDOM_SEED}:{value}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def baseline_split_ids():
    try:
        path = Path(BASELINE_BENCHMARK)
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
        else:
            with urllib.request.urlopen(BASELINE_BENCHMARK, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
        samples = payload.get("samples", [])
        return {
            "page_ids": sorted(
                {str(sample["page_id"]) for sample in samples if sample.get("page_id")}
            ),
            "sample_ids": sorted(
                {str(sample["id"]) for sample in samples if sample.get("id")}
            ),
        }
    except Exception as exc:
        print(f"Could not load published benchmark split: {exc}", flush=True)
        return {"page_ids": [], "sample_ids": []}


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

    by_string = {str(page_id): page_id for page_id in page_ids}
    existing = None
    if SPLIT_MANIFEST.exists():
        existing = json.loads(SPLIT_MANIFEST.read_text(encoding="utf-8"))
        print(f"Reusing frozen split manifest: {SPLIT_MANIFEST}", flush=True)

    assigned = {}
    published = {"page_ids": [], "sample_ids": []}
    if existing:
        for split_name in ("train", "val", "test"):
            for page_id in existing.get("splits", {}).get(split_name, []):
                if str(page_id) in by_string:
                    assigned[str(page_id)] = split_name
        if not existing.get("test_sample_ids"):
            published = baseline_split_ids()
    else:
        published = baseline_split_ids()
        published_test = set(published["page_ids"])
        matched_test = published_test & set(by_string)
        if matched_test:
            print(
                f"Freezing {len(matched_test)} published benchmark pages as test.",
                flush=True,
            )
            assigned.update({page_id: "test" for page_id in matched_test})
        else:
            train_ids, holdout_ids = train_test_split(
                list(by_string),
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
            assigned.update({page_id: "train" for page_id in train_ids})
            assigned.update({page_id: "val" for page_id in val_ids})
            assigned.update({page_id: "test" for page_id in test_ids})

    # New pages never alter or contaminate the frozen test. Their assignment is
    # deterministic, so incremental exports keep identical train/val membership.
    val_share = VAL_SIZE / max(1.0 - TEST_SIZE, 1e-9)
    for page_id in sorted(set(by_string) - set(assigned)):
        assigned[page_id] = "val" if stable_bucket(page_id) < val_share else "train"

    splits = {
        split_name: sorted(
            [by_string[page_id] for page_id, assigned_split in assigned.items() if assigned_split == split_name],
            key=str,
        )
        for split_name in ("train", "val", "test")
    }
    verify_split_integrity(splits)
    manifest = {
        "version": 1,
        "random_seed": RANDOM_SEED,
        "baseline_benchmark": BASELINE_BENCHMARK,
        "test_sample_ids": (
            existing.get("test_sample_ids") or published.get("sample_ids", [])
            if existing
            else published.get("sample_ids", [])
        ),
        "splits": {
            split_name: [str(page_id) for page_id in split_ids]
            for split_name, split_ids in splits.items()
        },
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    SPLIT_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
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


def write_split(
    split_name,
    page_ids,
    pages,
    page_cache,
    duplicate_index=None,
    allowed_test_sample_ids=None,
):
    split_dir = OUTPUT_DIR / split_name
    img_dir = split_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)

    jsonl_entries = []
    skipped = 0
    duplicate_stats = defaultdict(int)

    split_bubbles = []
    for page_id in page_ids:
        split_bubbles.extend(pages[page_id]["bubbles"])

    print(
        f"\nProcessing '{split_name}' ({len(page_ids)} pages, {len(split_bubbles)} bubbles)...",
        flush=True,
    )

    for bubble in tqdm(split_bubbles, desc=split_name):
        try:
            if (
                split_name == "test"
                and allowed_test_sample_ids
                and str(bubble["id"]) not in allowed_test_sample_ids
            ):
                skipped += 1
                duplicate_stats["not_in_frozen_test"] += 1
                continue
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
                exact_hash, perceptual_hash = image_hashes(processed)
                duplicate, duplicate_kind = (
                    duplicate_index.find(exact_hash, perceptual_hash)
                    if duplicate_index is not None
                    else (None, None)
                )
                same_label = duplicate is not None and normalize_text(
                    duplicate.get("text")
                ) == normalize_text(bubble["text"])
                if duplicate is not None and duplicate.get("split") != split_name:
                    if duplicate_kind == "exact" or same_label:
                        skipped += 1
                        duplicate_stats[duplicate_kind] += 1
                        if not same_label:
                            duplicate_stats["label_conflict"] += 1
                        continue
                    duplicate_stats["near_hash_label_mismatch_kept"] += 1
                processed.save(img_path, "PNG")
                if duplicate_index is not None and (duplicate is None or not same_label):
                    duplicate_index.add(
                        exact_hash,
                        perceptual_hash,
                        {
                            "id": bubble["id"],
                            "page_id": bubble["id_page"],
                            "split": split_name,
                            "text": bubble["text"],
                        },
                    )
            elif duplicate_index is not None:
                with Image.open(img_path) as existing_image:
                    exact_hash, perceptual_hash = image_hashes(existing_image)
                duplicate, duplicate_kind = duplicate_index.find(exact_hash, perceptual_hash)
                same_label = duplicate is not None and normalize_text(
                    duplicate.get("text")
                ) == normalize_text(bubble["text"])
                if duplicate is not None and duplicate.get("split") != split_name:
                    if duplicate_kind == "exact" or same_label:
                        skipped += 1
                        duplicate_stats[duplicate_kind] += 1
                        if not same_label:
                            duplicate_stats["label_conflict"] += 1
                        continue
                    duplicate_stats["near_hash_label_mismatch_kept"] += 1
                if duplicate is None or not same_label:
                    duplicate_index.add(
                        exact_hash,
                        perceptual_hash,
                        {
                            "id": bubble["id"],
                            "page_id": bubble["id_page"],
                            "split": split_name,
                            "text": bubble["text"],
                        },
                    )

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
    if duplicate_stats:
        print(f"  -> Duplicate filtering: {dict(duplicate_stats)}", flush=True)
    return len(jsonl_entries), skipped, dict(duplicate_stats)


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
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.", flush=True)
        sys.exit(1)
    frozen_manifest = SPLIT_MANIFEST.read_text(encoding="utf-8") if SPLIT_MANIFEST.exists() else None
    if CLEAN_DATASET and OUTPUT_DIR.exists():
        print(f"Cleaning existing dataset directory: {OUTPUT_DIR}", flush=True)
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if frozen_manifest:
        SPLIT_MANIFEST.write_text(frozen_manifest, encoding="utf-8")

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
    duplicate_index = DuplicateIndex(NEAR_DUPLICATE_DISTANCE)
    manifest_payload = json.loads(SPLIT_MANIFEST.read_text(encoding="utf-8"))
    allowed_test_sample_ids = set(manifest_payload.get("test_sample_ids") or [])
    # Protect held-out data first. Any duplicate found later in val/train is
    # discarded instead of leaking a test crop into training.
    for split_name in ("test", "val", "train"):
        page_ids = splits[split_name]
        saved, skipped, duplicates = write_split(
            split_name,
            page_ids,
            pages,
            page_cache,
            duplicate_index,
            allowed_test_sample_ids=allowed_test_sample_ids,
        )
        stats[split_name] = {
            "saved": saved,
            "skipped": skipped,
            "duplicates": duplicates,
        }

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
            "duplicates": stats[split_name]["duplicates"],
        }
    report["split_manifest"] = str(SPLIT_MANIFEST)
    report["near_duplicate_distance"] = NEAR_DUPLICATE_DISTANCE
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
