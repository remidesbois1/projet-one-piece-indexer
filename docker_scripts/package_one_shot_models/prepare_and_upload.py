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
DEFAULT_BASELINE_FALLBACK_REPO_ID = "Remidesbois/YoloPiece_OneShot_Models"

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

GLOBAL_READING_ORDER_SOURCES = {
    "global_bubble_order.onnx": REPO_ROOT
    / "docker_scripts"
    / "train_reading_order"
    / "models"
    / "global_bubble_order.onnx",
    "global_bubble_order_model.json": REPO_ROOT
    / "docker_scripts"
    / "train_reading_order"
    / "models"
    / "global_bubble_order_model.json",
    "global_bubble_order_features.json": REPO_ROOT
    / "docker_scripts"
    / "train_reading_order"
    / "models"
    / "global_bubble_order_features.json",
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

BENCHMARK_METRICS_SOURCE = (
    REPO_ROOT
    / "docker_scripts"
    / "train_reading_order"
    / "metrics"
    / "reading_order_benchmark.json"
)
EXPERIMENT_DOC_SOURCE = REPO_ROOT / "documentation" / "reading_order_experiments.md"


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


def download_hf_file(repo_id: str, filename: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        cached_path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            repo_type="model",
        )
        copy_file(Path(cached_path), destination)
        return destination
    except Exception:
        url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        destination.write_bytes(response.content)
        return destination


def copy_or_download(
    source: Path,
    destination: Path,
    fallback_repo_id: str,
    fallback_filename: str,
) -> str:
    if source.exists():
        copy_file(source, destination)
        return "local"
    download_hf_file(fallback_repo_id, fallback_filename, destination)
    return f"hf:{fallback_repo_id}/{fallback_filename}"


def model_manifest_entry(path: Path, package_dir: Path, **extra: Any) -> dict[str, Any]:
    relative_path = path.relative_to(package_dir).as_posix()
    return {
        "path": relative_path,
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        **extra,
    }


def load_completed_benchmark() -> dict[str, Any] | None:
    if not BENCHMARK_METRICS_SOURCE.exists():
        return None
    benchmark = read_json(BENCHMARK_METRICS_SOURCE)
    if benchmark.get("status") != "complete":
        return None
    return benchmark


def benchmark_runtime_decision(benchmark: dict[str, Any] | None) -> dict[str, Any]:
    if not benchmark:
        return {
            "status": "not_available",
            "reason": "No completed reading-order benchmark was found.",
        }
    return (
        benchmark.get("selection", {})
        .get("runtime_decision", {})
        or {
            "status": "not_enabled",
            "reason": "Benchmark did not include a runtime decision.",
        }
    )


def benchmark_summary(benchmark: dict[str, Any] | None) -> dict[str, Any] | None:
    if not benchmark:
        return None
    table = benchmark.get("experiments_table") or []
    baseline = next(
        (
            row
            for row in table
            if row.get("name") == "current_panel_then_in_panel_ranker"
        ),
        None,
    )
    selected = benchmark.get("selection", {}).get("selected_runtime_candidate")
    return {
        "created_at": benchmark.get("created_at"),
        "status": benchmark.get("status"),
        "baseline": baseline,
        "selected_runtime_candidate": selected,
        "baseline_comparison": benchmark.get("baseline_comparison"),
        "runtime_decision": benchmark_runtime_decision(benchmark),
    }


def global_model_enabled_by_benchmark(benchmark: dict[str, Any] | None) -> bool:
    decision = benchmark_runtime_decision(benchmark)
    model_path = GLOBAL_READING_ORDER_SOURCES["global_bubble_order.onnx"]
    feature_path = GLOBAL_READING_ORDER_SOURCES["global_bubble_order_features.json"]
    return (
        decision.get("status") == "enabled_by_metrics"
        and model_path.exists()
        and feature_path.exists()
    )


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

    return download_hf_file(BUBBLE_SOURCE_REPO, BUBBLE_SOURCE_FILE, destination)


def write_model_card(package_dir: Path, repo_id: str, manifest: dict[str, Any]) -> None:
    reading = read_json(package_dir / "metrics" / "reading_order_metrics.json")
    panel = read_json(package_dir / "metrics" / "panel_detector_metrics.json")
    primary = reading["primary_metric"]
    test_ordering = reading["test_ordering"]
    panel_test = panel["test"]
    global_model = manifest.get("reading_order", {}).get("global_bubble_order")
    global_section = ""
    if global_model and global_model.get("enabled_by_default"):
        benchmark = global_model.get("benchmark_summary") or {}
        selected = benchmark.get("selected_runtime_candidate") or {}
        selected_test = (selected.get("metrics") or {}).get("test") or {}
        global_section = f"""

## Optional Global Bubble Reranker

- `global_bubble_order.onnx`: enabled by the completed benchmark.
- Feature count: {global_model.get("feature_count")}
- Selected experiment: `{selected.get("name", "unknown")}`
- Page full accuracy: {selected_test.get("page_full_accuracy", 0.0):.4f}
- Global pairwise accuracy: {selected_test.get("global_pairwise_accuracy", 0.0):.4f}
"""

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
- `global_bubble_order.onnx`: optional page-level reranker, present only when benchmark-enabled.
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
{global_section}
"""
    (package_dir / "README.md").write_text(content, encoding="utf-8")


def prepare_package(package_dir: Path, repo_id: str, fallback_repo_id: str) -> dict[str, Any]:
    package_dir = package_dir.resolve()
    if package_dir.exists():
        shutil.rmtree(package_dir)
    package_dir.mkdir(parents=True, exist_ok=True)

    copied_files: list[str] = []
    artifact_sources: dict[str, str] = {}
    benchmark = load_completed_benchmark()
    include_global_model = global_model_enabled_by_benchmark(benchmark)

    download_bubble_detector(package_dir)
    copied_files.append("bubble_detector.onnx")
    artifact_sources["bubble_detector.onnx"] = f"hf:{BUBBLE_SOURCE_REPO}/{BUBBLE_SOURCE_FILE}"

    artifact_sources["panel_detector.onnx"] = copy_or_download(
        resolve_panel_detector_source(),
        package_dir / "panel_detector.onnx",
        fallback_repo_id,
        "panel_detector.onnx",
    )
    copied_files.append("panel_detector.onnx")

    for target_name, source_path in SOURCES.items():
        artifact_sources[target_name] = copy_or_download(
            source_path,
            package_dir / target_name,
            fallback_repo_id,
            target_name,
        )
        copied_files.append(target_name)

    for target_name, source_path in METRIC_SOURCES.items():
        artifact_sources[target_name] = copy_or_download(
            source_path,
            package_dir / target_name,
            fallback_repo_id,
            target_name,
        )
        copied_files.append(target_name)

    if benchmark:
        copy_file(BENCHMARK_METRICS_SOURCE, package_dir / "metrics" / "reading_order_benchmark.json")
        copied_files.append("metrics/reading_order_benchmark.json")
        if EXPERIMENT_DOC_SOURCE.exists():
            copy_file(
                EXPERIMENT_DOC_SOURCE,
                package_dir / "documentation" / "reading_order_experiments.md",
            )
            copied_files.append("documentation/reading_order_experiments.md")

    if include_global_model:
        for target_name, source_path in GLOBAL_READING_ORDER_SOURCES.items():
            if source_path.exists():
                copy_file(source_path, package_dir / target_name)
                artifact_sources[target_name] = "local"
                copied_files.append(target_name)

    model_names = [
        "bubble_detector.onnx",
        "panel_detector.onnx",
        "panel_order.onnx",
        "bubble_order.onnx",
    ]
    if include_global_model:
        model_names.append("global_bubble_order.onnx")

    models = {
        name: model_manifest_entry(package_dir / name, package_dir)
        for name in model_names
    }
    feature_metadata = package_dir / "global_bubble_order_features.json"
    if include_global_model and feature_metadata.exists():
        global_features = read_json(feature_metadata)
        models["global_bubble_order.onnx"].update(
            {
                "feature_count": global_features.get("feature_count"),
                "postprocess": global_features.get("postprocess"),
                "enabled_by_default": True,
                "benchmark_summary": benchmark_summary(benchmark),
            }
        )

    manifest = {
        "repo_id": repo_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "runtime": "onnxruntime-web",
        "models": models,
        "metrics": {
            "reading_order": "metrics/reading_order_metrics.json",
            "panel_detector": "metrics/panel_detector_metrics.json",
            **(
                {"reading_order_benchmark": "metrics/reading_order_benchmark.json"}
                if benchmark
                else {}
            ),
        },
        "reading_order": {
            "global_bubble_order": {
                "path": "global_bubble_order.onnx" if include_global_model else None,
                "enabled_by_default": include_global_model,
                "feature_count": (
                    models.get("global_bubble_order.onnx", {}).get("feature_count")
                    if include_global_model
                    else None
                ),
                "postprocess": (
                    models.get("global_bubble_order.onnx", {}).get("postprocess")
                    if include_global_model
                    else None
                ),
                "benchmark_summary": benchmark_summary(benchmark),
                "runtime_decision": benchmark_runtime_decision(benchmark),
            }
        },
        "source_repos": {
            "bubble_detector": BUBBLE_SOURCE_REPO,
            "baseline_fallback": fallback_repo_id,
        },
        "artifact_sources": {
            name: artifact_sources.get(name, "generated")
            for name in copied_files
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
    parser.add_argument(
        "--baseline-fallback-repo-id",
        default=os.getenv(
            "PONEGLYPH_ONESHOT_FALLBACK_REPO_ID",
            DEFAULT_BASELINE_FALLBACK_REPO_ID,
        ),
        help=(
            "Existing one-shot model repo used only when local baseline artifacts "
            "or metrics are absent."
        ),
    )
    parser.add_argument("--package-dir", type=Path, default=DEFAULT_PACKAGE_DIR)
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--private", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = prepare_package(args.package_dir, args.repo_id, args.baseline_fallback_repo_id)
    print(f"Prepared package: {args.package_dir.resolve()}")
    for name, info in manifest["models"].items():
        print(f"  {name}: {info['size_bytes']} bytes")

    if args.upload:
        upload_package(args.package_dir.resolve(), args.repo_id, args.private)
        print(f"Uploaded to: https://huggingface.co/{args.repo_id}")


if __name__ == "__main__":
    main()
