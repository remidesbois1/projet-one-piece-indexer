"""Validated Poneglyph bubbles, exhaustive export and immutable page splits."""

import hashlib
import io
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from PIL import Image, ImageOps


def normalize(text):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(text or ""))).strip()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    temporary.replace(path)


def image_hash(image):
    rgb = image.convert("RGB")
    return hashlib.sha256(str(rgb.size).encode() + rgb.tobytes()).hexdigest()


def parse_r2_reference(reference, allowed_bucket):
    """Same canonical private-page reference contract as backend/pageStorage.js."""
    parts = urlsplit(reference)
    if (
        reference != reference.strip()
        or parts.scheme != "r2"
        or not allowed_bucket
        or parts.netloc != allowed_bucket
        or parts.query
        or parts.fragment
    ):
        raise ValueError("Invalid or unconfigured private page bucket")
    segments = parts.path.removeprefix("/").split("/")
    decoded = [unquote(segment, errors="strict") for segment in segments]
    for raw, value in zip(segments, decoded):
        if (
            not value
            or value in {".", ".."}
            or "/" in value
            or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or quote(value, safe="~!*'()-._") != raw
        ):
            raise ValueError("Invalid private page object key")
    return parts.netloc, "/".join(decoded)


def assign_splits(rows, seed=42):
    """Group pages connected by identical crops; retain every bubble, even duplicates."""
    parent = {r["page_id"]: r["page_id"] for r in rows}

    def root(page):
        while parent[page] != page:
            parent[page] = parent[parent[page]]
            page = parent[page]
        return page

    hashes = {}
    for row in rows:
        for key in ("image_sha256", "page_sha256"):
            digest = row[key]
            previous = hashes.setdefault(digest, row["page_id"])
            a, b = sorted((root(previous), root(row["page_id"])))
            parent[b] = a
    assignments = {}
    for page in parent:
        bucket = (
            int.from_bytes(
                hashlib.sha256(f"{seed}:{root(page)}".encode()).digest()[:8], "big"
            )
            / 2**64
        )
        assignments[page] = (
            "test" if bucket < 0.15 else "val" if bucket < 0.30 else "train"
        )
    if len(set(assignments.values())) != 3:
        raise ValueError(
            "Too few independent page groups for nonempty train/val/test splits"
        )
    return assignments


def export_dataset(config):
    import os

    import pillow_avif  # noqa: F401 -- source pages may use AVIF
    import requests
    from requests.adapters import HTTPAdapter
    from rich.progress import track
    from supabase import create_client
    from urllib3.util.retry import Retry

    target = Path(config.dataset_dir)
    if (target / "manifest.json").exists():
        return load_dataset(target)
    if target.exists() and any(target.glob("*/metadata.jsonl")):
        raise RuntimeError(
            "Incomplete export: use a new FALCON_DATASET_DIR; existing data are preserved"
        )
    client = create_client(
        os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    )
    bubbles = []
    offset = 0
    while True:
        batch = (
            client.table("bulles")
            .select("id,x,y,w,h,texte_propose,id_page,pages(url_image)")
            .eq("statut", "Validé")
            .order("id")
            .range(offset, offset + 999)
            .execute()
            .data
            or []
        )
        bubbles.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    if len({str(b["id"]) for b in bubbles}) != len(bubbles):
        raise RuntimeError("Duplicate IDs during pagination; retry on a stable source")
    groups = defaultdict(list)
    excluded = []
    for b in bubbles:
        reason = None
        try:
            box = [float(b[k]) for k in ("x", "y", "w", "h")]
            valid_box = all(math.isfinite(v) for v in box) and min(box[2:]) > 0
        except (TypeError, ValueError):
            valid_box = False
        if not normalize(b.get("texte_propose")):
            reason = "empty_reference"
        elif not valid_box:
            reason = "invalid_bbox"
        elif b.get("id_page") is None or not (b.get("pages") or {}).get("url_image"):
            reason = "missing_page"
        if reason:
            excluded.append({"id": str(b["id"]), "reason": reason})
        else:
            groups[str(b["id_page"])].append(b)
    image_dir = target / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    r2_client = None
    if any(
        records[0]["pages"]["url_image"].startswith("r2://")
        for records in groups.values()
    ):
        from datetime import datetime, timedelta, timezone
        from email.utils import parsedate_to_datetime

        import boto3
        from botocore.auth import AUTH_TYPE_MAPS, SIGV4_TIMESTAMP, S3SigV4Auth
        from botocore.config import Config as S3Config

        required = (
            "R2_ENDPOINT",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_PAGES_BUCKET_NAME",
        )
        missing = [name for name in required if not os.getenv(name)]
        if missing:
            raise RuntimeError("Private page export requires: " + ", ".join(missing))
        # R2 can reject signatures when the host/WSL clock drifts. Correct only
        # this client's signing timestamp, using R2's authenticated HTTPS error
        # response, just as clock-skew-aware S3 SDKs do. Never change the OS clock.
        clock_offset = timedelta()

        class R2ClockAuth(S3SigV4Auth):
            def _modify_request_before_signing(self, request):
                request.context["timestamp"] = (
                    datetime.now(timezone.utc) + clock_offset
                ).strftime(SIGV4_TIMESTAMP)
                super()._modify_request_before_signing(request)

        def clock_skew_retry(response=None, attempts=0, **kwargs):
            nonlocal clock_offset
            parsed = response[1] if response else {}
            if (
                parsed.get("Error", {}).get("Code") == "RequestTimeTooSkewed"
                and attempts < 3
            ):
                date = (
                    parsed.get("ResponseMetadata", {})
                    .get("HTTPHeaders", {})
                    .get("date")
                )
                if date:
                    clock_offset = parsedate_to_datetime(date) - datetime.now(
                        timezone.utc
                    )
                    return 0
            return None

        AUTH_TYPE_MAPS["poneglyph-r2-v4"] = R2ClockAuth
        r2_client = boto3.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT"],
            region_name="auto",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            config=S3Config(
                signature_version="poneglyph-r2-v4",
                retries={"max_attempts": 4, "mode": "standard"},
                max_pool_connections=8,
                read_timeout=60,
            ),
        )
        r2_client.meta.events.register("needs-retry.s3.GetObject", clock_skew_retry)

    def process_page(item):
        page_id, records = item
        session = requests.Session()
        session.mount(
            "https://",
            HTTPAdapter(
                max_retries=Retry(
                    total=4,
                    backoff_factor=1,
                    status_forcelist=[429, 500, 502, 503, 504],
                )
            ),
        )
        # Exceptions deliberately stop export: no silent loss of downloadable labels.
        try:
            reference = records[0]["pages"]["url_image"]
            if reference.startswith("r2://"):
                from botocore.exceptions import BotoCoreError, ClientError

                bucket, key = parse_r2_reference(
                    reference, os.environ["R2_PAGES_BUCKET_NAME"]
                )
                try:
                    response = r2_client.get_object(Bucket=bucket, Key=key)
                    with response["Body"] as body:
                        content = body.read()
                except (BotoCoreError, ClientError) as error:
                    raise OSError(
                        f"Private object read failed ({type(error).__name__})"
                    ) from None
            else:
                response = session.get(reference, timeout=60)
                response.raise_for_status()
                content = response.content
            with Image.open(io.BytesIO(content)) as source:
                page = ImageOps.exif_transpose(source).convert("RGB")
        except (requests.RequestException, OSError, ValueError):
            raise RuntimeError(
                f"Download/decode failed for page {page_id}; retry export"
            ) from None
        finally:
            session.close()
        page_digest = image_hash(page)
        result, rejected = [], []
        for b in records:
            x, y, w, h = (float(b[k]) for k in ("x", "y", "w", "h"))
            box = (
                max(0, round(x)),
                max(0, round(y)),
                min(page.width, round(x + w)),
                min(page.height, round(y + h)),
            )
            if box[2] <= box[0] or box[3] <= box[1]:
                rejected.append({"id": str(b["id"]), "reason": "crop_outside_page"})
                continue
            crop = page.crop(box)
            # Do not use database IDs as filesystem paths.
            name = hashlib.sha256(str(b["id"]).encode()).hexdigest() + ".png"
            crop.save(image_dir / name)
            result.append(
                {
                    "id": str(b["id"]),
                    "page_id": page_id,
                    "image_file": "images/" + name,
                    "text": normalize(b["texte_propose"]),
                    "width": crop.width,
                    "height": crop.height,
                    "image_sha256": image_hash(crop),
                    "page_sha256": page_digest,
                }
            )
        return result, rejected

    rows = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for result, rejected in track(
            pool.map(process_page, sorted(groups.items())),
            total=len(groups),
            description="Export des pages",
        ):
            rows.extend(result)
            excluded.extend(rejected)
    assignments = assign_splits(rows, config.seed)
    for split in ("train", "val", "test"):
        directory = target / split
        directory.mkdir(exist_ok=True)
        selected = [
            dict(r, split=split)
            for r in sorted(rows, key=lambda r: r["id"])
            if assignments[r["page_id"]] == split
        ]
        (directory / "metadata.jsonl").write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in selected),
            encoding="utf-8",
        )
    write_json(
        target / "manifest.json",
        {
            "schema": 1,
            "seed": config.seed,
            "source_status": "Validé",
            "fetched": len(bubbles),
            "exported": len(rows),
            "excluded": excluded,
            "exclusion_counts": dict(Counter(r["reason"] for r in excluded)),
            "pages": assignments,
            "split_policy": "70/15/15 stable hash; identical pages/crops share split",
        },
    )
    return load_dataset(target)


def load_dataset(directory):
    directory = Path(directory).resolve()
    splits, pages, hashes, seen_ids = {}, {}, {}, set()
    fingerprint = hashlib.sha256()
    for split in ("train", "val", "test"):
        content = (directory / split / "metadata.jsonl").read_bytes()
        fingerprint.update(split.encode() + content)
        splits[split] = []
        for line in content.decode("utf-8").splitlines():
            row = json.loads(line)
            if row["id"] in seen_ids or not normalize(row["text"]):
                raise ValueError("Duplicate ID or empty target")
            seen_ids.add(row["id"])
            for mapping, key in (
                (pages, row["page_id"]),
                (hashes, row["image_sha256"]),
                (hashes, row["page_sha256"]),
            ):
                if mapping.setdefault(key, split) != split:
                    raise ValueError("Page/image leakage across splits")
            image_path = (directory / row["image_file"]).resolve()
            if not image_path.is_relative_to(directory):
                raise ValueError("Image path escapes dataset")
            with Image.open(image_path) as image:
                if image_hash(image) != row["image_sha256"]:
                    raise ValueError(f"Image changed: {row['id']}")
            row["image_path"] = str(image_path)
            splits[split].append(row)
        if not splits[split]:
            raise ValueError(f"Empty split: {split}")
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest["exported"] != len(seen_ids) or manifest["fetched"] != len(
        seen_ids
    ) + len(manifest["excluded"]):
        raise ValueError("Export accounting mismatch")
    return splits, fingerprint.hexdigest(), manifest
