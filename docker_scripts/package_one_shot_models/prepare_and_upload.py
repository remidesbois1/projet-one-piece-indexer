from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from huggingface_hub import HfApi, hf_hub_download


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
DEFAULT_PACKAGE_DIR = SCRIPT_DIR / "hf_package"
DEFAULT_REPO_ID = "Remidesbois/YoloPiece_OneShot_Models"

BUBBLE_SOURCE_REPO = "Remidesbois/YoloPiece_BubbleDetector_Nano"
BUBBLE_SOURCE_FILE = "onepiece_detector_nano.onnx"

FALLBACK_PANEL_DETECTOR_ONNX = (
    REPO_ROOT
    / "docker_scripts"
    / "train_panel_detector"
    / "runs"
    / "yolo26n_panel"
    / "weights"
    / "best.onnx"
)

SOURCES = {
    "panel_order.onnx": REPO_ROOT
    / "docker_scripts"
    / "train_reading_order"
    / "models"
    / "panel_order.onnx",
    "bubble_order.onnx": REPO_ROOT
    / "docker_scripts"
    / "train_reading_order"
    / "models"
    / "bubble_order.onnx",
}

METRIC_SOURCES = {
    "metrics/panel_detector_metrics.json": REPO_ROOT
    / "docker_scripts"
    / "train_panel_detector"
    / "metrics"
    / "latest_panel_metrics.json",
    "metrics/reading_order_metrics.json": REPO_ROOT
    / "docker_scripts"
    / "train_reading_order"
    / "metrics"
    / "reading_order_metrics.json",
}


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_file(source: Path, destination: Path) -> None:
    if not source.exists():
        raise FileNotFoundError(f"Missing source artifact: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def resolve_panel_detector_source() -> Path:
    metrics_path = METRIC_SOURCES["metrics/panel_detector_metrics.json"]
    if metrics_path.exists():
        metrics = read_json(metrics_path)
        onnx_model = metrics.get("onnx_model")
        if onnx_model:
            candidate = Path(onnx_model)
            if candidate.exists():
                return candidate
    return FALLBACK_PANEL_DETECTOR_ONNX


def resolve_hf_token() -> str | None:
    load_dotenv(REPO_ROOT / ".env")
    load_dotenv(SCRIPT_DIR / ".env")
    return os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_HUB_TOKEN")


def download_bubble_detector(package_dir: Path) -> Path:
    destination = package_dir / "bubble_detector.onnx"
    local_override = os.getenv("BUBBLE_DETECTOR_ONNX")
    if local_override:
        copy_file(Path(local_override), destination)
        return destination

    try:
        cached_path = hf_hub_download(
            repo_id=BUBBLE_SOURCE_REPO,
            filename=BUBBLE_SOURCE_FILE,
            repo_type="model",
        )
        copy_file(Path(cached_path), destination)
        return destination
    except Exception:
        url = (
            f"https://huggingface.co/{BUBBLE_SOURCE_REPO}/resolve/main/"
            f"{BUBBLE_SOURCE_FILE}"
        )
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        destination.write_bytes(response.content)
        return destination


def write_model_card(package_dir: Path, repo_id: str, manifest: dict[str, Any]) -> None:
    reading = read_json(package_dir / "metrics" / "reading_order_metrics.json")
    panel = read_json(package_dir / "metrics" / "panel_detector_metrics.json")
    primary = reading["primary_metric"]
    test_ordering = reading["test_ordering"]
    panel_test = panel["test"]

    content = f"""---
library_name: onnx
tags:
- manga
- reading-order
- object-detection
- onnx
- onnxruntime-web
---

# YoloPiece One-Shot Models

Unified browser package for Poneglyph one-shot analysis.

This bundle replaces the previous ReaderNet runtime with two small pairwise
rankers. The bubble detector is preserved, and the panel detector is included
because the worker assigns bubbles to panels before in-panel ordering.

## Files

- `bubble_detector.onnx`: preserved YOLO bubble detector.
- `panel_detector.onnx`: YOLO panel detector used to assign bubbles to panels.
- `panel_order.onnx`: new pairwise panel ordering ranker.
- `bubble_order.onnx`: new pairwise in-panel bubble ordering ranker.
- `model_manifest.json`: checksums, sizes, and runtime metadata.
- `metrics/`: held-out evaluation reports.

## Reading Order Metrics

- Test pages: {reading["dataset"]["test"]["pages"]}
- Panel exact order: {test_ordering["panel_order_full_accuracy"]:.4f}
- Bubble exact order inside panels: {test_ordering["bubble_within_panel_full_accuracy"]:.4f}
- Page full accuracy: {primary["value"]:.4f} ({primary["exact_matches"]}/{primary["page_count"]})

The page full-accuracy metric compares the complete predicted bubble sequence
against the ground truth sequence for held-out pages.

## Detector Metrics

- Panel detector mAP50: {panel_test["mAP50"]:.4f}
- Panel detector mAP50-95: {panel_test["mAP50-95"]:.4f}

## Runtime

The frontend worker loads these files from:

`https://huggingface.co/{repo_id}/resolve/main/<file>`
"""
    (package_dir / "README.md").write_text(content, encoding="utf-8")


def prepare_package(package_dir: Path, repo_id: str) -> dict[str, Any]:
    package_dir = package_dir.resolve()
    if package_dir.exists():
        shutil.rmtree(package_dir)
    package_dir.mkdir(parents=True, exist_ok=True)

    copied_files: list[str] = []
    download_bubble_detector(package_dir)
    copied_files.append("bubble_detector.onnx")

    copy_file(resolve_panel_detector_source(), package_dir / "panel_detector.onnx")
    copied_files.append("panel_detector.onnx")

    for target_name, source_path in SOURCES.items():
        copy_file(source_path, package_dir / target_name)
        copied_files.append(target_name)

    for target_name, source_path in METRIC_SOURCES.items():
        copy_file(source_path, package_dir / target_name)
        copied_files.append(target_name)

    manifest = {
        "repo_id": repo_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "runtime": "onnxruntime-web",
        "models": {
            name: {
                "path": name,
                "size_bytes": (package_dir / name).stat().st_size,
                "sha256": sha256_file(package_dir / name),
            }
            for name in [
                "bubble_detector.onnx",
                "panel_detector.onnx",
                "panel_order.onnx",
                "bubble_order.onnx",
            ]
        },
        "metrics": {
            "reading_order": "metrics/reading_order_metrics.json",
            "panel_detector": "metrics/panel_detector_metrics.json",
        },
        "source_repos": {
            "bubble_detector": BUBBLE_SOURCE_REPO,
        },
    }
    write_json(package_dir / "model_manifest.json", manifest)
    write_model_card(package_dir, repo_id, manifest)
    return manifest


def upload_package(package_dir: Path, repo_id: str, private: bool) -> None:
    token = resolve_hf_token()
    if not token:
        raise RuntimeError("HF_TOKEN or HUGGINGFACE_HUB_TOKEN is required for upload.")

    api = HfApi()
    api.create_repo(repo_id=repo_id, repo_type="model", private=private, exist_ok=True, token=token)
    api.upload_folder(
        folder_path=str(package_dir),
        repo_id=repo_id,
        repo_type="model",
        token=token,
        commit_message="Upload one-shot ONNX model bundle",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare and optionally upload the unified one-shot ONNX package."
    )
    parser.add_argument("--repo-id", default=os.getenv("PONEGLYPH_ONESHOT_REPO_ID", DEFAULT_REPO_ID))
    parser.add_argument("--package-dir", type=Path, default=DEFAULT_PACKAGE_DIR)
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--private", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = prepare_package(args.package_dir, args.repo_id)
    print(f"Prepared package: {args.package_dir.resolve()}")
    for name, info in manifest["models"].items():
        print(f"  {name}: {info['size_bytes']} bytes")

    if args.upload:
        upload_package(args.package_dir.resolve(), args.repo_id, args.private)
        print(f"Uploaded to: https://huggingface.co/{args.repo_id}")


if __name__ == "__main__":
    main()
