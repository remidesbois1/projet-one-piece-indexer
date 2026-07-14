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
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import threading
import hashlib
import random

try:
    import pillow_avif as _pillow_avif  # noqa: F401 - registers the Pillow codec

    print("✅ AVIF support enabled via pillow-avif-plugin")
except ImportError:
    print("⚠️ AVIF support NOT found. AVIF images will fail to open.")
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    SUPABASE_URL = os.environ.get("SUPABASE_URL")
    SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
        sys.exit(1)

OUTPUT_DIR = Path(
    os.getenv("LIGHTON_BBOX_DATASET_DIR", SCRIPT_DIR / "lighton_bbox_dataset")
)
TARGET_LONGEST_SIDE = 1500
BBOX_NORM_SCALE = 1000
TEST_SIZE = 0.2
VAL_SIZE = 0.1
RANDOM_SEED = 42
JPEG_QUALITY = 95
MIN_BUBBLES_PER_PAGE = 1
MIN_TEXT_LENGTH = 1
USER_PROMPT = ""


def normalize_text(text):
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text).strip()
    return text


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
    return sorted(
        bubbles,
        key=lambda b: (
            b.get("order") is None,
            b.get("order") if b.get("order") is not None else 10**9,
            b.get("y", 0),
            -b.get("x", 0),
            b.get("id", 0),
        ),
    )


def image_sha256(image):
    digest = hashlib.sha256()
    digest.update(f"{image.mode}:{image.size[0]}x{image.size[1]}".encode("ascii"))
    digest.update(image.tobytes())
    return digest.hexdigest()


def build_frozen_splits(page_hashes, manifest_path, force_new=False):
    existing = None
    if manifest_path.exists() and not force_new:
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))

    groups = defaultdict(list)
    for page_id, digest in page_hashes.items():
        groups[digest].append(page_id)

    assignments = {}
    hash_assignments = {}
    if existing:
        existing_hashes = existing.get("page_hashes", {})
        for split in ("train", "val", "test"):
            for page_id in existing.get("splits", {}).get(split, []):
                page_id = int(page_id)
                if page_id not in page_hashes:
                    continue
                assignments[page_id] = split
                digest = existing_hashes.get(str(page_id)) or page_hashes[page_id]
                hash_assignments[digest] = split

    unassigned_groups = []
    for digest, page_ids in groups.items():
        known = {assignments[page_id] for page_id in page_ids if page_id in assignments}
        if len(known) > 1:
            chosen = "test" if "test" in known else "val" if "val" in known else "train"
        else:
            chosen = next(iter(known), hash_assignments.get(digest))
        if chosen:
            for page_id in page_ids:
                assignments[page_id] = chosen
            hash_assignments[digest] = chosen
        else:
            unassigned_groups.append((digest, page_ids))

    rng = random.Random(RANDOM_SEED)
    rng.shuffle(unassigned_groups)
    total = len(page_hashes)
    target_test = round(total * TEST_SIZE)
    target_val = round(total * VAL_SIZE)
    counts = {
        split: sum(value == split for value in assignments.values())
        for split in ("train", "val", "test")
    }
    for digest, page_ids in unassigned_groups:
        if not existing and counts["test"] < target_test:
            split = "test"
        elif counts["val"] < target_val:
            split = "val"
        else:
            split = "train"
        for page_id in page_ids:
            assignments[page_id] = split
        counts[split] += len(page_ids)
        hash_assignments[digest] = split

    splits = {
        split: sorted(page_id for page_id, value in assignments.items() if value == split)
        for split in ("train", "val", "test")
    }
    assert not (set(splits["train"]) & set(splits["val"]))
    assert not (set(splits["train"]) & set(splits["test"]))
    assert not (set(splits["val"]) & set(splits["test"]))
    manifest = {
        "version": 2,
        "random_seed": RANDOM_SEED,
        "image_longest_edge": TARGET_LONGEST_SIDE,
        "bbox_normalization_scale": BBOX_NORM_SCALE,
        "splits": splits,
        "page_hashes": {str(page_id): digest for page_id, digest in page_hashes.items()},
        "duplicate_groups": [sorted(page_ids) for page_ids in groups.values() if len(page_ids) > 1],
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return splits, manifest


def format_assistant_response(bubbles_with_bbox):
    lines = []
    for text, (x1, y1, x2, y2) in bubbles_with_bbox:
        lines.append(f"{text} [{x1},{y1},{x2},{y2}]")
    return "\n".join(lines)


def fetch_all_bubbles(supabase: Client):
    print("Fetching validated bubbles from Supabase...", flush=True)
    bubbles = []
    page_size = 1000
    offset = 0

    while True:
        response = (
            supabase.table("bulles")
            .select("id, x, y, w, h, texte_propose, order, id_page, pages(url_image)")
            .eq("statut", os.getenv("LIGHTON_STATUS_VALUE", "Validé"))
            .range(offset, offset + page_size - 1)
            .execute()
        )

        batch = response.data
        if not batch:
            break

        bubbles.extend(batch)
        print(f"  -> {len(bubbles)} fetched so far...", flush=True)

        if len(batch) < page_size:
            break
        offset += page_size

    print(f"Total: {len(bubbles)} validated bubbles.", flush=True)
    return bubbles


def main():
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    bubbles = fetch_all_bubbles(supabase)

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

    print(
        f"Pages with >= {MIN_BUBBLES_PER_PAGE} bubbles: {len(pages_dict)}", flush=True
    )
    total_bubbles = sum(len(p["bubbles"]) for p in pages_dict.values())
    print(f"Total bubbles in dataset: {total_bubbles}", flush=True)

    if not pages_dict:
        print("Nothing to export.")
        return

    print(f"\nDownloading {len(pages_dict)} unique pages in parallel...", flush=True)
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
            print(f"  ⚠️ Failed to download page {page_id}: {e}", flush=True)

    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = [
            executor.submit(download_page, pid, pdata["url_image"])
            for pid, pdata in pages_dict.items()
        ]
        for f in tqdm(
            as_completed(futures), total=len(futures), desc="Downloading pages"
        ):
            pass

    print(f"  -> {len(page_images)} pages downloaded.", flush=True)

    page_hashes = {
        page_id: image_sha256(image) for page_id, image in page_images.items()
    }
    splits, manifest = build_frozen_splits(
        page_hashes,
        OUTPUT_DIR / "split_manifest.json",
        force_new=os.getenv("LIGHTON_RESET_SPLIT", "0").lower()
        in {"1", "true", "yes"},
    )
    print(
        f"Frozen split: {len(splits['train'])} train, {len(splits['val'])} val, "
        f"{len(splits['test'])} test pages; "
        f"{len(manifest['duplicate_groups'])} duplicate groups.",
        flush=True,
    )

    stats = {
        split: {"pages": 0, "bubbles": 0}
        for split in ("train", "val", "test")
    }

    for split_name in ("train", "val", "test"):
        split_ids = splits[split_name]
        split_dir = OUTPUT_DIR / split_name
        img_dir = split_dir / "images"
        img_dir.mkdir(parents=True, exist_ok=True)

        jsonl_entries = []

        print(f"\nProcessing '{split_name}' ({len(split_ids)} pages)...", flush=True)
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
                "id": page_id,
                "page_id": page_id,
                "split": split_name,
                "image_file": f"images/{file_name}",
                "original_size": [orig_w, orig_h],
                "resized_size": [new_w, new_h],
                "num_bubbles": len(bubbles_with_bbox),
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image", "image": f"images/{file_name}"},
                        ],
                    },
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": assistant_text}],
                    },
                ],
            }
            jsonl_entries.append(entry)
            stats[split_name]["pages"] += 1
            stats[split_name]["bubbles"] += len(bubbles_with_bbox)

        jsonl_path = split_dir / "metadata.jsonl"
        with open(jsonl_path, "w", encoding="utf-8") as f:
            for entry in jsonl_entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        print(f"  -> Saved {len(jsonl_entries)} entries to {jsonl_path}", flush=True)

    print("\n" + "=" * 60, flush=True)
    print(" DATASET EXPORT SUMMARY", flush=True)
    print("-" * 60, flush=True)
    for split_name in ["train", "val", "test"]:
        s = stats[split_name]
        print(f"  {split_name}: {s['pages']} pages, {s['bubbles']} bubbles", flush=True)
    print(f"  Image target: {TARGET_LONGEST_SIDE}px longest side", flush=True)
    print(f"  BBox normalization: [0, {BBOX_NORM_SCALE}]", flush=True)
    print("=" * 60, flush=True)

    print(f"\nDone! Dataset in: {OUTPUT_DIR}", flush=True)

    verify_dataset(OUTPUT_DIR)


def verify_dataset(output_dir):
    print("\n🔍 Running dataset verification...", flush=True)
    errors = 0

    for split in ["train", "val", "test"]:
        jsonl_path = output_dir / split / "metadata.jsonl"
        if not jsonl_path.exists():
            print(f"  ❌ Missing {jsonl_path}")
            errors += 1
            continue

        with open(jsonl_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        for i, line in enumerate(lines):
            entry = json.loads(line)
            img_rel = entry["messages"][0]["content"][0]["image"]
            img_path = output_dir / split / img_rel

            if not img_path.exists():
                print(f"  ❌ Missing image: {img_path}")
                errors += 1
                continue

            with Image.open(img_path) as img:
                w, h = img.size
                longest = max(w, h)
                if longest > TARGET_LONGEST_SIDE + 1:
                    print(f"  ❌ Image too large: {img_path} ({w}x{h})")
                    errors += 1

            assistant_text = entry["messages"][1]["content"][0]["text"]
            bbox_pattern = re.compile(r".+?\s*\[(\d+),(\d+),(\d+),(\d+)\]")
            for bbox_line in assistant_text.split("\n"):
                match = bbox_pattern.match(bbox_line)
                if match:
                    coords = [int(g) for g in match.groups()]
                    for c in coords:
                        if c < 0 or c > BBOX_NORM_SCALE:
                            print(
                                f"  ❌ BBox out of range: {coords} in {split} entry {i}"
                            )
                            errors += 1

        print(f"  ✅ {split}: {len(lines)} entries checked", flush=True)

    if errors == 0:
        print("  ✅ All checks passed!", flush=True)
    else:
        print(f"  ⚠️ {errors} errors found!", flush=True)


if __name__ == "__main__":
    main()
