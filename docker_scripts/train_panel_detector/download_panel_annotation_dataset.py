from __future__ import annotations

import argparse
import io
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from PIL import Image
from supabase import Client, create_client
from tqdm import tqdm

try:
    import pillow_avif  # noqa: F401
except ImportError:
    pass


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / "panel_annotation_dataset"
DEFAULT_PAGE_SIZE = 500
JPEG_QUALITY = 95


def load_supabase_settings() -> tuple[str, str]:
    for env_path in (
        SCRIPT_DIR / ".env",
        SCRIPT_DIR.parent / ".env",
        PROJECT_ROOT / ".env",
        Path.cwd() / ".env",
    ):
        if env_path.exists():
            load_dotenv(env_path)

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
    if not url or not key:
        print(
            "[ERROR] Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
            file=sys.stderr,
        )
        sys.exit(1)
    return url, key


def as_object(value: Any) -> dict[str, Any]:
    if isinstance(value, list):
        return value[0] if value else {}
    if isinstance(value, dict):
        return value
    return {}


def to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_bubbles(
    raw_bubbles: list[dict[str, Any]], status: str | None
) -> list[dict[str, Any]]:
    bubbles: list[dict[str, Any]] = []
    for raw in raw_bubbles or []:
        if status is not None and raw.get("statut") != status:
            continue

        x = to_int(raw.get("x"))
        y = to_int(raw.get("y"))
        w = to_int(raw.get("w"))
        h = to_int(raw.get("h"))
        bubble_id = to_int(raw.get("id"))
        if bubble_id is None or x is None or y is None or w is None or h is None:
            continue
        if w <= 0 or h <= 0:
            continue

        order = to_int(raw.get("order"))
        text = raw.get("texte_propose") or raw.get("texte_ocr_brut") or ""
        bubble = {
            "id": bubble_id,
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "bbox": {"x": x, "y": y, "w": w, "h": h},
            "order": order,
            "text": text,
            "statut": raw.get("statut"),
        }
        bubbles.append(bubble)

    return sorted(
        bubbles,
        key=lambda b: (
            b["order"] is None,
            b["order"] if b["order"] is not None else 10**9,
            b["id"],
        ),
    )


def fetch_pages_with_bubbles(
    supabase: Client,
    status: str | None,
    page_size: int,
    limit: int | None,
) -> list[dict[str, Any]]:
    select_columns = (
        "id, numero_page, url_image, id_chapitre, "
        "chapitres(id, numero, titre, tomes(id, numero, titre, "
        "mangas(id, slug, titre))), "
        "bulles(id, x, y, w, h, texte_ocr_brut, texte_propose, order, statut)"
    )

    pages: list[dict[str, Any]] = []
    offset = 0
    print("Fetching pages and bubbles from Supabase...")

    while True:
        response = (
            supabase.table("pages")
            .select(select_columns)
            .order("id")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = response.data or []
        if not batch:
            break

        for page in batch:
            bubbles = normalize_bubbles(page.get("bulles") or [], status=status)
            if not bubbles:
                continue
            page["bulles"] = bubbles
            pages.append(page)
            if limit is not None and len(pages) >= limit:
                return pages[:limit]

        print(f"  scanned {offset + len(batch)} pages, kept {len(pages)}")
        if len(batch) < page_size:
            break
        offset += page_size

    return pages


def download_page_image(
    page: dict[str, Any], image_dir: Path, force: bool
) -> tuple[int, str, int, int, str | None]:
    page_id = int(page["id"])
    output_path = image_dir / f"page_{page_id}.jpg"
    rel_path = output_path.relative_to(image_dir.parent).as_posix()

    if output_path.exists() and not force:
        with Image.open(output_path) as image:
            width, height = image.size
        return page_id, rel_path, width, height, None

    response = requests.get(page["url_image"], timeout=45)
    response.raise_for_status()

    with Image.open(io.BytesIO(response.content)) as image:
        rgb_image = image.convert("RGB")
        width, height = rgb_image.size
        rgb_image.save(output_path, "JPEG", quality=JPEG_QUALITY)

    return page_id, rel_path, width, height, None


def build_page_record(
    page: dict[str, Any],
    image_file: str,
    width: int,
    height: int,
) -> dict[str, Any]:
    chapitre = as_object(page.get("chapitres"))
    tome = as_object(chapitre.get("tomes"))
    manga = as_object(tome.get("mangas"))

    return {
        "page_id": int(page["id"]),
        "image_file": image_file,
        "url_image": page["url_image"],
        "width": width,
        "height": height,
        "numero_page": page.get("numero_page"),
        "chapitre": {
            "id": chapitre.get("id"),
            "numero": chapitre.get("numero"),
            "titre": chapitre.get("titre"),
        },
        "tome": {
            "id": tome.get("id"),
            "numero": tome.get("numero"),
            "titre": tome.get("titre"),
        },
        "manga": {
            "id": manga.get("id"),
            "slug": manga.get("slug"),
            "titre": manga.get("titre"),
        },
        "bubbles": page["bulles"],
    }


def write_json(path: Path, data: dict[str, Any]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp_path.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download Supabase pages with bubbles for panel annotation."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Dataset directory. Default: {DEFAULT_OUTPUT_DIR}",
    )
    parser.add_argument(
        "--status",
        default=None,
        help="Optional bubble status filter. Leave empty to keep every bubble.",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=DEFAULT_PAGE_SIZE,
        help="Supabase page query size.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional maximum number of kept pages, useful for testing.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=12,
        help="Parallel image downloads.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Redownload images even if they already exist.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    image_dir = output_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    url, key = load_supabase_settings()
    supabase = create_client(url, key)

    pages = fetch_pages_with_bubbles(
        supabase=supabase,
        status=args.status,
        page_size=max(1, args.page_size),
        limit=args.limit,
    )
    if not pages:
        print("No page with at least one bubble was found.")
        return

    print(f"Downloading {len(pages)} page images...")
    download_results: dict[int, tuple[str, int, int]] = {}
    errors: list[str] = []

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        future_to_page = {
            executor.submit(download_page_image, page, image_dir, args.force): page
            for page in pages
        }
        for future in tqdm(
            as_completed(future_to_page),
            total=len(future_to_page),
            desc="pages",
        ):
            page = future_to_page[future]
            try:
                page_id, image_file, width, height, error = future.result()
            except Exception as exc:
                errors.append(f"page {page.get('id')}: {exc}")
                continue
            if error:
                errors.append(f"page {page_id}: {error}")
                continue
            download_results[page_id] = (image_file, width, height)

    records = []
    for page in pages:
        page_id = int(page["id"])
        result = download_results.get(page_id)
        if result is None:
            continue
        image_file, width, height = result
        records.append(build_page_record(page, image_file, width, height))

    manifest = {
        "version": 1,
        "kind": "panel_annotation_dataset",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": "supabase",
        "status_filter": args.status,
        "page_count": len(records),
        "bubble_count": sum(len(page["bubbles"]) for page in records),
        "pages": records,
    }

    manifest_path = output_dir / "dataset.json"
    write_json(manifest_path, manifest)

    print()
    print(f"Dataset: {manifest_path}")
    print(f"Pages:   {len(records)}")
    print(f"Bubbles: {manifest['bubble_count']}")
    if errors:
        error_path = output_dir / "download_errors.txt"
        error_path.write_text("\n".join(errors) + "\n", encoding="utf-8")
        print(f"Errors:  {len(errors)} written to {error_path}")


if __name__ == "__main__":
    main()
