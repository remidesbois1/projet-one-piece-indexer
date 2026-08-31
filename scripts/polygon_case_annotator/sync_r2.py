"""Download the annotation pages and their R2 images into a local cache."""
from __future__ import annotations

import argparse
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from PIL import Image

try:
    from supabase import Client, create_client
except ImportError:  # dependency is only needed when syncing
    Client = Any  # type: ignore[misc, assignment]
    create_client = None  # type: ignore[assignment]

try:
    import boto3
except ImportError:  # dependency is only needed for r2:// references
    boto3 = None  # type: ignore[assignment]


def _settings(project_root: Path) -> tuple[str, str]:
    for path in (project_root / ".env", project_root / "backend" / ".env", Path.cwd() / ".env"):
        if path.exists():
            load_dotenv(path)
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY sont requis.")
    return url, key


def _r2_client(project_root: Path):
    if boto3 is None:
        raise RuntimeError("Dépendance manquante : installez boto3 avec requirements.txt.")
    endpoint = os.getenv("R2_ENDPOINT")
    access_key = os.getenv("R2_ACCESS_KEY_ID")
    secret_key = os.getenv("R2_SECRET_ACCESS_KEY")
    if not endpoint or not access_key or not secret_key:
        raise RuntimeError("Pour les références r2://, R2_ENDPOINT, R2_ACCESS_KEY_ID et R2_SECRET_ACCESS_KEY sont requis dans backend/.env.")
    return boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=access_key, aws_secret_access_key=secret_key, region_name="auto")


def _obj(value: Any) -> dict[str, Any]:
    if isinstance(value, list):
        return value[0] if value else {}
    return value if isinstance(value, dict) else {}


def _bubbles(values: list[dict[str, Any]], status: str | None) -> list[dict[str, Any]]:
    result = []
    for raw in values or []:
        if status is not None and raw.get("statut") != status:
            continue
        try:
            x, y, w, h, bid = (int(raw[k]) for k in ("x", "y", "w", "h", "id"))
        except (KeyError, TypeError, ValueError):
            continue
        if w <= 0 or h <= 0:
            continue
        result.append({"id": bid, "x": x, "y": y, "w": w, "h": h, "bbox": {"x": x, "y": y, "w": w, "h": h}, "order": raw.get("order"), "text": raw.get("texte_propose") or raw.get("texte_ocr_brut") or "", "statut": raw.get("statut")})
    return sorted(result, key=lambda item: (item["order"] is None, item["order"] or 10**9, item["id"]))


def _fetch_pages(client: Client, status: str | None, page_size: int, limit: int | None) -> list[dict[str, Any]]:
    columns = "id, numero_page, url_image, id_chapitre, chapitres(id, numero, titre, tomes(id, numero, titre, mangas(id, slug, titre))), bulles(id, x, y, w, h, texte_ocr_brut, texte_propose, order, statut)"
    pages: list[dict[str, Any]] = []
    offset = 0
    while True:
        batch = client.table("pages").select(columns).order("id").range(offset, offset + page_size - 1).execute().data or []
        if not batch:
            break
        for page in batch:
            bubbles = _bubbles(page.get("bulles") or [], status)
            if bubbles:
                page["bulles"] = bubbles
                pages.append(page)
                if limit and len(pages) >= limit:
                    return pages[:limit]
        if len(batch) < page_size:
            break
        offset += page_size
    return pages


def _download(page: dict[str, Any], image_dir: Path, force: bool, s3_client: Any = None) -> tuple[int, str, int, int]:
    pid = int(page["id"]); target = image_dir / f"page_{pid}.jpg"
    if not target.exists() or force:
        reference = str(page["url_image"])
        if reference.startswith("r2://"):
            parsed = urlparse(reference)
            if not parsed.netloc or not parsed.path or s3_client is None:
                raise RuntimeError(f"Référence R2 invalide : {reference}")
            payload = s3_client.get_object(Bucket=parsed.netloc, Key=parsed.path.lstrip("/"))["Body"].read()
        else:
            response = requests.get(reference, timeout=60)
            response.raise_for_status()
            payload = response.content
        with Image.open(io.BytesIO(payload)) as image:
            rgb = image.convert("RGB"); width, height = rgb.size; rgb.save(target, "JPEG", quality=95)
    else:
        with Image.open(target) as image:
            width, height = image.size
    return pid, target.relative_to(image_dir.parent).as_posix(), width, height


def sync_dataset(output_dir: Path, status: str | None = None, limit: int | None = None, workers: int = 12, force: bool = False) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True); image_dir = output_dir / "images"; image_dir.mkdir(exist_ok=True)
    root = Path(__file__).resolve().parents[2]; url, key = _settings(root)
    if create_client is None:
        raise RuntimeError("Dépendance manquante : installez scripts/polygon_case_annotator/requirements.txt.")
    pages = _fetch_pages(create_client(url, key), status, 500, limit)
    r2_client = _r2_client(root) if any(str(page.get("url_image", "")).startswith("r2://") for page in pages) else None
    records: dict[int, dict[str, Any]] = {}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(_download, page, image_dir, force, r2_client): page for page in pages}
        for future in as_completed(futures):
            page = futures[future]
            try:
                pid, filename, width, height = future.result()
            except Exception as exc:
                errors.append(f"page {page.get('id')}: {exc}")
                continue
            chapter = _obj(page.get("chapitres")); tome = _obj(chapter.get("tomes")); manga = _obj(tome.get("mangas"))
            records[pid] = {"page_id": pid, "image_file": filename, "url_image": page["url_image"], "width": width, "height": height, "numero_page": page.get("numero_page"), "chapitre": chapter, "tome": tome, "manga": manga, "bubbles": page["bulles"]}
    manifest = {"version": 1, "kind": "panel_annotation_dataset", "created_at": datetime.now(timezone.utc).isoformat(), "source": "supabase_r2", "status_filter": status, "page_count": len(records), "bubble_count": sum(len(p["bubbles"]) for p in records.values()), "pages": sorted(records.values(), key=lambda p: p["page_id"])}
    path = output_dir / "dataset.json"; path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if errors:
        (output_dir / "download_errors.txt").write_text("\n".join(errors) + "\n", encoding="utf-8")
    if not records:
        raise RuntimeError(f"Aucune image n’a pu être téléchargée. Voir {output_dir / 'download_errors.txt'}.")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description="Synchronise les pages Supabase et leurs images Cloudflare R2.")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent / "cache")
    parser.add_argument("--status"); parser.add_argument("--limit", type=int); parser.add_argument("--workers", type=int, default=12); parser.add_argument("--force", action="store_true")
    args = parser.parse_args(); print(sync_dataset(args.output_dir.resolve(), args.status, args.limit, args.workers, args.force))


if __name__ == "__main__": main()
