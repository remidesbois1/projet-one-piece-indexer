from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SPLITS = ("train", "val", "test")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: str | Path) -> dict[str, Any] | None:
    path = Path(path)
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str | Path, payload: dict[str, Any]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


def count_metadata_rows(path: Path) -> int:
    if not path.exists():
        return 0
    with open(path, "r", encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def dataset_split_counts(dataset_dir: str | Path) -> dict[str, dict[str, Any]]:
    dataset_dir = Path(dataset_dir)
    counts: dict[str, dict[str, Any]] = {}
    for split in SPLITS:
        split_dir = dataset_dir / split
        metadata_path = split_dir / "metadata.jsonl"
        counts[split] = {
            "metadata": str(metadata_path),
            "rows": count_metadata_rows(metadata_path),
            "files": sum(1 for item in split_dir.rglob("*") if item.is_file()) if split_dir.exists() else 0,
        }
    return counts


def normalize_source_report_paths(source_report: dict[str, Any] | None, dataset_dir: Path) -> dict[str, Any] | None:
    if not isinstance(source_report, dict):
        return source_report
    normalized = json.loads(json.dumps(source_report))
    normalized["dataset_dir"] = str(dataset_dir)
    splits = normalized.get("splits")
    if isinstance(splits, dict):
        for split, details in splits.items():
            if isinstance(details, dict):
                details["metadata"] = str(dataset_dir / split / "metadata.jsonl")
    return normalized


def write_dataset_manifest(
    dataset_dir: str | Path,
    *,
    job_id: str | None,
    dataset_kind: str,
    provider: str,
    params: dict[str, Any] | None = None,
    sharding_requested: bool = False,
    file_warning_threshold: int = 50_000,
) -> Path:
    dataset_dir = Path(dataset_dir)
    source_report = read_json(dataset_dir / "dataset_report.json")
    file_count = sum(1 for item in dataset_dir.rglob("*") if item.is_file()) if dataset_dir.exists() else 0
    manifest = {
        "job_id": job_id,
        "dataset_kind": dataset_kind,
        "provider": provider,
        "dataset_dir": str(dataset_dir),
        "created_at": utc_now_iso(),
        "params": params or {},
        "splits": dataset_split_counts(dataset_dir),
        "source_report": normalize_source_report_paths(source_report, dataset_dir),
        "file_count": file_count,
        "sharding": {
            "requested": bool(sharding_requested),
            "recommended": file_count >= file_warning_threshold,
            "format": "tar",
            "reason": "Modal Volumes get slower with many small files; tar shards are supported by the manifest contract.",
        },
    }
    return write_json(dataset_dir / "dataset_manifest.json", manifest)


def standard_pipeline_summary(
    *,
    status: str,
    training_kind: str,
    provider: str,
    dataset_dir: str | Path,
    output_dir: str | Path,
    final_model_dir: str | Path,
    hf_repo: str,
    benchmark_path: str | Path | None = None,
    comparison_path: str | Path | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    summary = {
        "status": status,
        "training_kind": training_kind,
        "provider": provider,
        "training_job_id": os.getenv("TRAINING_JOB_ID") or os.getenv("PONEGLYPH_TRAINING_JOB_ID"),
        "dataset_dir": str(dataset_dir),
        "output_dir": str(output_dir),
        "final_model_dir": str(final_model_dir),
        "benchmark_path": str(benchmark_path) if benchmark_path else None,
        "comparison_path": str(comparison_path) if comparison_path else None,
        "hf_repo": hf_repo,
        "finished_at": utc_now_iso() if status in {"complete", "completed", "failed"} else None,
    }
    if error_message:
        summary["error_message"] = error_message
    return summary
