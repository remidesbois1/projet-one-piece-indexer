import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import shutil
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import requests
from dotenv import load_dotenv
from PIL import Image
from PIL import ImageOps
from sklearn.model_selection import train_test_split
from supabase import Client
from supabase import create_client
from tqdm import tqdm
from ultralytics import YOLO

try:
    import pillow_avif  # noqa: F401
except ImportError:
    pillow_avif = None


DEFAULT_SOURCE_DIR = Path("/workspace/bubble_line_dataset")
DEFAULT_DETECTOR = Path("/workspace/line_detector/best.pt")
DEFAULT_OUTPUT_DIR = Path("/workspace/outputs_paddleocr_line_rec")
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(SCRIPT_DIR.parent / ".env")
load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class LineBox:
    x1: float
    y1: float
    x2: float
    y2: float
    conf: float

    @property
    def w(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def h(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def area(self) -> float:
        return self.w * self.h


def stable_split(bubble_id: str, val_ratio: float) -> str:
    digest = hashlib.sha1(str(bubble_id).encode("utf-8")).digest()
    value = (digest[0] << 8 | digest[1]) / 65535.0
    return "val" if value < val_ratio else "train"


def valid_bbox_values(x, y, w, h) -> bool:
    try:
        return float(w) > 0 and float(h) > 0 and float(x) == float(x) and float(y) == float(y)
    except (TypeError, ValueError):
        return False


def crop_bubble_image(page_image: Image.Image, bubble: dict, pad: int) -> Image.Image | None:
    if not valid_bbox_values(bubble.get("x"), bubble.get("y"), bubble.get("w"), bubble.get("h")):
        return None
    img_w, img_h = page_image.size
    x = float(bubble["x"])
    y = float(bubble["y"])
    w = float(bubble["w"])
    h = float(bubble["h"])
    x1 = max(0, min(img_w, int(round(x - pad))))
    y1 = max(0, min(img_h, int(round(y - pad))))
    x2 = max(0, min(img_w, int(round(x + w + pad))))
    y2 = max(0, min(img_h, int(round(y + h + pad))))
    if x2 <= x1 or y2 <= y1:
        return None
    return page_image.crop((x1, y1, x2, y2)).convert("RGB")


def normalize_text(text: str) -> str:
    text = str(text or "").replace("\r", "\n")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def display_len(text: str) -> float:
    total = 0.0
    for ch in text:
        if ch.isspace():
            total += 0.45
        elif ch in ".,;:!?…'\"`´’‘“”()[]{}":
            total += 0.45
        elif ch in "ilI|":
            total += 0.55
        elif ch in "MW@#%&":
            total += 1.35
        else:
            total += 1.0
    return max(total, 0.1)


def split_text_chars(text: str, weights: list[float]) -> list[str]:
    chars = list(text)
    if len(weights) <= 1:
        return [text]
    total = sum(display_len(ch) for ch in chars)
    if total <= 0:
        return [text]
    target_cum = []
    running = 0.0
    for weight in weights[:-1]:
        running += weight
        target_cum.append(total * running / sum(weights))

    parts = []
    start = 0
    acc = 0.0
    target_idx = 0
    for idx, ch in enumerate(chars):
        acc += display_len(ch)
        if target_idx < len(target_cum) and acc >= target_cum[target_idx]:
            parts.append("".join(chars[start : idx + 1]).strip())
            start = idx + 1
            target_idx += 1
    parts.append("".join(chars[start:]).strip())
    return [p for p in parts if p]


def tokenize_words(text: str) -> list[str]:
    return text.split()


def split_text_for_lines(text: str, boxes: list[LineBox]) -> list[str]:
    text = normalize_text(text)
    if not text or not boxes:
        return []
    if len(boxes) == 1:
        return [text]

    weights = [max(8.0, box.w) for box in boxes]
    words = tokenize_words(text)
    if len(words) < len(boxes):
        return split_text_chars(text, weights)

    token_lens = [display_len(word) for word in words]
    prefix = [0.0]
    for idx, word_len in enumerate(token_lens):
        prefix.append(prefix[-1] + word_len + (0.45 if idx else 0.0))

    total = prefix[-1]
    weight_total = sum(weights)
    targets = [total * weight / weight_total for weight in weights]
    n_words = len(words)
    n_lines = len(boxes)
    dp = [[math.inf] * (n_words + 1) for _ in range(n_lines + 1)]
    back = [[-1] * (n_words + 1) for _ in range(n_lines + 1)]
    dp[0][0] = 0.0

    for line_idx in range(1, n_lines + 1):
        min_end = line_idx
        max_end = n_words - (n_lines - line_idx)
        for end in range(min_end, max_end + 1):
            for start in range(line_idx - 1, end):
                if dp[line_idx - 1][start] == math.inf:
                    continue
                chunk_len = prefix[end] - prefix[start]
                target = max(targets[line_idx - 1], 0.1)
                chunk = " ".join(words[start:end])
                penalty = ((chunk_len - target) / target) ** 2
                if re.search(r"[,;:]$", chunk) and line_idx < n_lines:
                    penalty *= 0.92
                if re.search(r"[.!?…]$", chunk) and line_idx < n_lines:
                    penalty *= 0.82
                score = dp[line_idx - 1][start] + penalty
                if score < dp[line_idx][end]:
                    dp[line_idx][end] = score
                    back[line_idx][end] = start

    if back[n_lines][n_words] < 0:
        return split_text_chars(text, weights)

    parts = []
    end = n_words
    for line_idx in range(n_lines, 0, -1):
        start = back[line_idx][end]
        parts.append(" ".join(words[start:end]).strip())
        end = start
    parts.reverse()
    return [part for part in parts if part]


def sort_boxes_reading_order(boxes: list[LineBox]) -> list[LineBox]:
    if not boxes:
        return []
    median_h = sorted(box.h for box in boxes)[len(boxes) // 2]
    band = max(10.0, median_h * 0.65)
    return sorted(boxes, key=lambda b: (round(((b.y1 + b.y2) / 2.0) / band), b.x1))


def line_box_iou(left: LineBox, right: LineBox) -> float:
    ix1, iy1 = max(left.x1, right.x1), max(left.y1, right.y1)
    ix2, iy2 = min(left.x2, right.x2), min(left.y2, right.y2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    return inter / max(left.area + right.area - inter, 1e-6)


def dedupe_line_boxes(boxes: list[LineBox], threshold: float) -> list[LineBox]:
    kept = []
    for box in sorted(boxes, key=lambda item: item.conf, reverse=True):
        if all(line_box_iou(box, existing) < threshold for existing in kept):
            kept.append(box)
    return kept


def predict_line_boxes(model: YOLO, image: Image.Image, conf: float, iou: float, imgsz: int, line_nms_iou: float) -> list[LineBox]:
    result = model.predict(image, conf=conf, iou=iou, imgsz=imgsz, verbose=False)[0]
    boxes = []
    img_w, img_h = image.size
    for raw_box in result.boxes:
        xyxy = raw_box.xyxy[0].tolist()
        score = float(raw_box.conf[0])
        x1, y1, x2, y2 = xyxy
        x1 = max(0.0, min(float(x1), img_w))
        y1 = max(0.0, min(float(y1), img_h))
        x2 = max(0.0, min(float(x2), img_w))
        y2 = max(0.0, min(float(y2), img_h))
        box = LineBox(x1=x1, y1=y1, x2=x2, y2=y2, conf=score)
        if box.w >= 4 and box.h >= 4 and box.area >= 24:
            boxes.append(box)
    return sort_boxes_reading_order(dedupe_line_boxes(boxes, line_nms_iou))


def crop_box(image: Image.Image, box: LineBox, pad: int) -> Image.Image:
    w, h = image.size
    x1 = max(0, int(math.floor(box.x1)) - pad)
    y1 = max(0, int(math.floor(box.y1)) - pad)
    x2 = min(w, int(math.ceil(box.x2)) + pad)
    y2 = min(h, int(math.ceil(box.y2)) + pad)
    return image.crop((x1, y1, x2, y2)).convert("RGB")


def stitch_lines_as_single_image(image: Image.Image, boxes: list[LineBox], pad: int, gap: int) -> Image.Image | None:
    crops = [crop_box(image, box, pad) for box in boxes]
    crops = [crop for crop in crops if crop.width > 0 and crop.height > 0]
    if not crops:
        return None

    target_h = max(crop.height for crop in crops)
    resized = []
    for crop in crops:
        if crop.height != target_h:
            new_w = max(1, int(round(crop.width * (target_h / crop.height))))
            crop = crop.resize((new_w, target_h), Image.Resampling.LANCZOS)
        resized.append(crop)

    total_w = sum(crop.width for crop in resized) + gap * max(0, len(resized) - 1)
    canvas = Image.new("RGB", (max(1, total_w), target_h), "white")
    x = 0
    for crop in resized:
        canvas.paste(crop, (x, (target_h - crop.height) // 2))
        x += crop.width + gap
    return canvas


def load_manifest(source_dir: Path) -> dict:
    path = source_dir / "manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"Missing source manifest: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def require_supabase_env() -> tuple[str, str]:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    missing = [name for name, value in {"SUPABASE_URL": url, "SUPABASE_SERVICE_ROLE_KEY": key}.items() if not value]
    if missing:
        raise RuntimeError(f"Missing required Supabase env: {', '.join(missing)}")
    return url, key


def fetch_all_bubbles(client: Client, page_size: int, status_value: str) -> list[dict]:
    print(f"Fetching bubbles from Supabase with statut={status_value!r}...", flush=True)
    bubbles = []
    offset = 0
    while True:
        response = (
            client.table("bulles")
            .select("id, x, y, w, h, texte_propose, id_page, pages(url_image)")
            .eq("statut", status_value)
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = response.data or []
        if not batch:
            break
        bubbles.extend(batch)
        print(f"  fetched {len(bubbles)} bubbles so far", flush=True)
        if len(batch) < page_size:
            break
        offset += page_size
    print(f"Total validated bubbles fetched: {len(bubbles)}", flush=True)
    return bubbles


def build_page_groups(bubbles: list[dict], min_text_len: int) -> tuple[dict, dict]:
    pages = defaultdict(lambda: {"url_image": None, "bubbles": []})
    skipped = defaultdict(int)
    for bubble in bubbles:
        text = normalize_text(bubble.get("texte_propose"))
        if len(text) < min_text_len:
            skipped["short_or_empty_text"] += 1
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
    print(
        f"After filtering: {len(pages)} pages, {sum(len(v['bubbles']) for v in pages.values())} bubbles",
        flush=True,
    )
    if skipped:
        print(f"Skipped during Supabase grouping: {dict(skipped)}", flush=True)
    return pages, dict(skipped)


def split_pages(page_ids: list[str], val_size: float, test_size: float, seed: int) -> dict[str, list[str]]:
    if len(page_ids) == 1:
        return {"train": sorted(page_ids), "val": [], "test": []}
    if len(page_ids) == 2:
        sorted_ids = sorted(page_ids)
        return {"train": [sorted_ids[0]], "val": [sorted_ids[1]], "test": []}
    if len(page_ids) < 3:
        raise ValueError("At least 3 distinct pages are required for page-level train/val/test split.")
    if val_size <= 0 or test_size < 0 or val_size + test_size >= 1:
        raise ValueError("--val-size must be > 0, --test-size must be >= 0, and their sum must be < 1.")
    train_ids, holdout_ids = train_test_split(
        sorted(page_ids),
        test_size=val_size + test_size,
        random_state=seed,
        shuffle=True,
    )
    if test_size > 0:
        relative_test_size = test_size / (val_size + test_size)
        val_ids, test_ids = train_test_split(
            holdout_ids,
            test_size=relative_test_size,
            random_state=seed,
            shuffle=True,
        )
    else:
        val_ids, test_ids = holdout_ids, []
    return {"train": sorted(train_ids), "val": sorted(val_ids), "test": sorted(test_ids)}


def download_pages(pages: dict, workers: int, timeout: int) -> dict[str, Image.Image]:
    print(f"Downloading {len(pages)} unique source pages...", flush=True)
    page_cache = {}
    lock = threading.Lock()

    def download_one(page_id: str, url: str) -> None:
        try:
            response = requests.get(url, timeout=timeout)
            response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as image:
                page_image = ImageOps.exif_transpose(image).convert("RGB")
            with lock:
                page_cache[page_id] = page_image
        except Exception as exc:  # noqa: BLE001
            print(f"  failed to download page {page_id}: {exc}", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(download_one, page_id, data["url_image"])
            for page_id, data in pages.items()
        ]
        for _ in tqdm(as_completed(futures), total=len(futures), desc="Downloading pages"):
            pass
    print(f"Cached pages: {len(page_cache)}/{len(pages)}", flush=True)
    return page_cache


def download_page_image(page_id: str, url: str, timeout: int) -> Image.Image | None:
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        with Image.open(io.BytesIO(response.content)) as image:
            return ImageOps.exif_transpose(image).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        print(f"  failed to download page {page_id}: {exc}", flush=True)
        return None


def iter_source_bubbles(args: argparse.Namespace):
    manifest = load_manifest(args.source_dir)
    entries = list((manifest.get("bubbles") or {}).items())
    if args.limit:
        entries = entries[: args.limit]
    for bubble_id, entry in entries:
        image_path = args.source_dir / entry.get("crop_path", "")
        if not image_path.exists():
            yield bubble_id, None, None, "missing_image"
            continue
        split = entry.get("split") or stable_split(str(bubble_id), args.val_ratio)
        yield bubble_id, {"text": entry.get("text", ""), "split": split, "source_crop": entry.get("crop_path", "")}, Image.open(image_path).convert("RGB"), None


def iter_supabase_bubbles(args: argparse.Namespace):
    url, key = require_supabase_env()
    client = create_client(url, key)
    bubbles = fetch_all_bubbles(client, args.supabase_page_size, args.status_value)
    pages, grouping_skips = build_page_groups(bubbles, args.min_text_len)
    if args.limit:
        limited_pages = {}
        remaining = args.limit
        for page_id in sorted(pages):
            selected = pages[page_id]["bubbles"][:remaining]
            if selected:
                limited_pages[page_id] = {**pages[page_id], "bubbles": selected}
                remaining -= len(selected)
            if remaining <= 0:
                break
        pages = limited_pages
    page_splits = split_pages(list(pages.keys()), args.val_size, args.test_size, args.seed)
    print("Page-level split:", flush=True)
    for split, page_ids in page_splits.items():
        print(f"  {split}: {len(page_ids)} pages, {sum(len(pages[p]['bubbles']) for p in page_ids)} bubbles", flush=True)

    page_to_split = {page_id: split for split, ids in page_splits.items() for page_id in ids}
    print(f"Streaming {len(pages)} source pages one by one to keep RAM low...", flush=True)
    yielded = 0
    for page_id in tqdm(sorted(pages), desc="Streaming pages"):
        page_image = download_page_image(page_id, pages[page_id]["url_image"], args.request_timeout)
        for bubble in pages[page_id]["bubbles"]:
            if args.limit and yielded >= args.limit:
                return
            if page_image is None:
                yield bubble["id"], None, None, "missing_page_image"
                continue
            crop = crop_bubble_image(page_image, bubble, args.bubble_crop_pad)
            if crop is None:
                yield bubble["id"], None, None, "invalid_bubble_crop"
                continue
            yielded += 1
            yield (
                bubble["id"],
                {
                    "text": bubble["text"],
                    "split": page_to_split[page_id],
                    "page_id": page_id,
                    "source_page_url": bubble["source_page_url"],
                    "bubble_bbox": [round(bubble["x"]), round(bubble["y"]), round(bubble["w"]), round(bubble["h"])],
                    "source_crop": f"supabase:{bubble['id']}",
                },
                crop,
                None,
            )

    if grouping_skips:
        print(f"Supabase grouping skips: {grouping_skips}", flush=True)


def write_label_file(path: Path, rows: list[tuple[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        for rel_path, text in rows:
            handle.write(f"{rel_path}\t{text}\n")


def export_dataset(args: argparse.Namespace) -> Path:
    detector_path = args.detector.resolve()
    output_dir = args.output_dir.resolve()
    dataset_dir = output_dir / "bubble_single_line_rec_dataset"
    images_root = dataset_dir / "images"
    manifest_out = dataset_dir / "line_manifest.jsonl"
    stats_path = dataset_dir / "dataset_stats.json"

    if not detector_path.exists():
        raise FileNotFoundError(f"Missing YOLO line detector: {detector_path}")

    if args.clean and dataset_dir.exists():
        shutil.rmtree(dataset_dir)
    dataset_dir.mkdir(parents=True, exist_ok=True)
    for split in ("train", "val", "test"):
        (images_root / split).mkdir(parents=True, exist_ok=True)

    model = YOLO(str(detector_path))
    rows = {"train": [], "val": [], "test": []}
    stats = {
        "source": args.source_mode,
        "source_dir": str(args.source_dir.resolve()) if args.source_dir else None,
        "detector": str(detector_path),
        "bubbles_seen": 0,
        "bubbles_exported": 0,
        "bubbles_without_text": 0,
        "bubbles_without_image": 0,
        "bubbles_without_lines": 0,
        "single_line_images": 0,
        "train_images": 0,
        "val_images": 0,
        "test_images": 0,
        "conversion": "YOLO line boxes stitched left-to-right into one single-line bubble image",
        "yolo_conf": args.conf,
        "yolo_iou": args.iou,
        "imgsz": args.imgsz,
    }

    records = iter_supabase_bubbles(args) if args.source_mode == "supabase" else iter_source_bubbles(args)

    with manifest_out.open("w", encoding="utf-8") as manifest_handle:
        for bubble_id, entry, image, skip_reason in tqdm(records, desc="YOLO bubble-to-line"):
            stats["bubbles_seen"] += 1
            if skip_reason:
                if skip_reason in {"missing_image", "missing_page_image", "invalid_bubble_crop"}:
                    stats["bubbles_without_image"] += 1
                continue

            text = normalize_text(entry.get("text", "") if entry else "")
            if not text:
                stats["bubbles_without_text"] += 1
                continue

            boxes = predict_line_boxes(model, image, conf=args.conf, iou=args.iou, imgsz=args.imgsz, line_nms_iou=args.line_nms_iou)
            if not boxes:
                stats["bubbles_without_lines"] += 1
                continue

            single_line = stitch_lines_as_single_image(image, boxes, args.pad, args.line_gap)
            if single_line is None:
                stats["bubbles_without_lines"] += 1
                continue

            split = entry.get("split") or stable_split(str(bubble_id), args.val_ratio)
            if split not in {"train", "val", "test"}:
                split = stable_split(str(bubble_id), args.val_ratio)

            filename = f"{bubble_id}.png"
            rel_path = f"images/{split}/{filename}"
            single_line.save(dataset_dir / rel_path)
            rows[split].append((rel_path, text))
            stats["single_line_images"] += 1
            stats[f"{split}_images"] += 1
            stats["bubbles_exported"] += 1

            detected_lines = [
                {
                    "line_index": idx,
                    "bbox": [round(box.x1, 3), round(box.y1, 3), round(box.x2, 3), round(box.y2, 3)],
                    "confidence": round(box.conf, 6),
                }
                for idx, box in enumerate(boxes, start=1)
            ]
            manifest_handle.write(
                json.dumps(
                    {
                        "bubble_id": bubble_id,
                        "source_crop": entry.get("source_crop"),
                        "page_id": entry.get("page_id"),
                        "source_page_url": entry.get("source_page_url"),
                        "bubble_bbox": entry.get("bubble_bbox"),
                        "split": split,
                        "single_line_image": rel_path,
                        "text": text,
                        "detected_lines": detected_lines,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    write_label_file(dataset_dir / "rec_gt_train.txt", rows["train"])
    write_label_file(dataset_dir / "rec_gt_val.txt", rows["val"])
    write_label_file(dataset_dir / "rec_gt_test.txt", rows["test"])

    with (dataset_dir / "summary.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["metric", "value"])
        for key, value in stats.items():
            writer.writerow([key, value])

    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)
    print(f"Dataset written to: {dataset_dir}", flush=True)
    return dataset_dir


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Use the trained YOLO bubble-line detector to turn each bubble into one stitched single-line OCR image."
    )
    parser.add_argument("--source-mode", choices=["supabase", "source_dir"], default="supabase")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--detector", type=Path, default=DEFAULT_DETECTOR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--iou", type=float, default=0.45)
    parser.add_argument("--line-nms-iou", type=float, default=float(os.getenv("PPOCR_LINE_NMS_IOU", "0.85")))
    parser.add_argument("--imgsz", type=int, default=800)
    parser.add_argument("--pad", type=int, default=2)
    parser.add_argument("--line-gap", type=int, default=8)
    parser.add_argument("--val-ratio", type=float, default=0.1)
    parser.add_argument("--limit", type=int, default=0, help="Optional bubble limit for smoke tests.")
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--val-size", type=float, default=float(os.getenv("PPOCR_VAL_SIZE", "0.15")))
    parser.add_argument("--test-size", type=float, default=float(os.getenv("PPOCR_TEST_SIZE", "0.15")))
    parser.add_argument("--seed", type=int, default=int(os.getenv("PPOCR_RANDOM_SEED", "42")))
    parser.add_argument("--min-text-len", type=int, default=int(os.getenv("PPOCR_MIN_TEXT_LENGTH", "1")))
    parser.add_argument("--bubble-crop-pad", type=int, default=int(os.getenv("PPOCR_BUBBLE_CROP_PAD_PX", "0")))
    parser.add_argument("--supabase-page-size", type=int, default=int(os.getenv("PPOCR_SUPABASE_PAGE_SIZE", "1000")))
    parser.add_argument("--status-value", default=os.getenv("PPOCR_BUBBLE_STATUS", "Valid\u00e9"))
    parser.add_argument("--download-workers", type=int, default=int(os.getenv("PPOCR_DOWNLOAD_WORKERS", "16")))
    parser.add_argument("--request-timeout", type=int, default=int(os.getenv("PPOCR_REQUEST_TIMEOUT_SECONDS", "45")))
    return parser.parse_args()


if __name__ == "__main__":
    export_dataset(parse_args())
