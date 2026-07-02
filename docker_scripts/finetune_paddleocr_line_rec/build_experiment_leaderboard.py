import argparse
import json
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_EXPERIMENTS_DIR = SCRIPT_DIR / "experiments"


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def nested(payload: dict[str, Any], *keys: str) -> Any:
    value: Any = payload
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def best_epoch(metrics: dict[str, Any]) -> dict[str, Any]:
    epochs = metrics.get("epochs") or []
    if not epochs:
        return {}
    return min(epochs, key=lambda item: float(item.get("val_cer", float("inf"))))


def metric_from_analysis(run_dir: Path, split: str, bucket: str, key: str) -> float | None:
    summary = read_json(run_dir / "analysis" / split / "summary.json")
    value = nested(summary, "buckets", bucket, key)
    return float(value) if isinstance(value, (int, float)) else None


def metric_from_epoch(epoch: dict[str, Any], key: str) -> float | None:
    value = epoch.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def yolo_value(payload: dict[str, Any], key: str) -> float | None:
    value = nested(payload, "metrics", key)
    return float(value) if isinstance(value, (int, float)) else None


def collect_run(run_dir: Path) -> dict[str, Any]:
    config = read_json(run_dir / "run_config.json")
    training_metrics = read_json(run_dir / "training_metrics.json")
    best_metrics = read_json(run_dir / "best_checkpoint_metrics.json")
    dataset_stats = read_json(run_dir / "dataset_stats.json")
    yolo_metrics = read_json(run_dir / "yolo_metrics.json")
    line_detector_metrics = read_json(run_dir / "line_detector_metrics.json")
    browser_manifest = read_json(run_dir / "onnx" / "browser_manifest.json")
    pipeline_manifest = read_json(run_dir / "onnx" / "pipeline_manifest.json")

    epoch = best_epoch(best_metrics) or best_epoch(training_metrics)
    val_cer = (
        metric_from_analysis(run_dir, "validation", "all", "raw_cer")
        or metric_from_analysis(run_dir, "val", "all", "raw_cer")
        or metric_from_epoch(epoch, "val_cer")
        or float(training_metrics.get("best_val_cer", 0) or 0)
    )
    val_exact = (
        metric_from_analysis(run_dir, "validation", "all", "raw_exact_match")
        or metric_from_analysis(run_dir, "val", "all", "raw_exact_match")
        or metric_from_epoch(epoch, "val_exact_match")
    )
    short_cer = (
        metric_from_analysis(run_dir, "validation", "short", "raw_cer")
        or metric_from_analysis(run_dir, "val", "short", "raw_cer")
        or metric_from_epoch(epoch, "val_short_cer")
    )
    short_exact = (
        metric_from_analysis(run_dir, "validation", "short", "raw_exact_match")
        or metric_from_analysis(run_dir, "val", "short", "raw_exact_match")
        or metric_from_epoch(epoch, "val_short_exact_match")
    )
    dialogue_cer = (
        metric_from_analysis(run_dir, "validation", "dialogue", "raw_cer")
        or metric_from_analysis(run_dir, "val", "dialogue", "raw_cer")
        or metric_from_epoch(epoch, "val_dialogue_cer")
    )
    onnx_parity = nested(browser_manifest, "parity", "all_text_match")
    if onnx_parity is None:
        onnx_parity = nested(pipeline_manifest, "metrics", "onnx", "all_text_match")

    return {
        "run_name": config.get("run_name") or run_dir.name,
        "run_dir": str(run_dir),
        "git_commit": config.get("git_commit"),
        "hf_repo": config.get("hf_repo") or pipeline_manifest.get("hf_repo"),
        "hf_revision": config.get("hf_revision"),
        "val_cer": val_cer,
        "val_exact_match": val_exact,
        "short_cer": short_cer,
        "short_exact_match": short_exact,
        "dialogue_cer": dialogue_cer,
        "test_cer": metric_from_analysis(run_dir, "test", "all", "raw_cer"),
        "test_exact_match": metric_from_analysis(run_dir, "test", "all", "raw_exact_match"),
        "yolo_map50": yolo_value(yolo_metrics, "metrics/mAP50(B)"),
        "yolo_map50_95": yolo_value(yolo_metrics, "metrics/mAP50-95(B)"),
        "line_detector_map50": yolo_value(line_detector_metrics, "metrics/mAP50(B)"),
        "line_detector_map50_95": yolo_value(line_detector_metrics, "metrics/mAP50-95(B)"),
        "onnx_parity_text_match": onnx_parity,
        "browser_compatible": bool(onnx_parity) and bool(browser_manifest),
        "dataset": {
            "bubbles_exported": dataset_stats.get("bubbles_exported"),
            "bubbles_without_lines": dataset_stats.get("bubbles_without_lines"),
            "train_images": dataset_stats.get("train_images"),
            "val_images": dataset_stats.get("val_images"),
            "test_images": dataset_stats.get("test_images"),
        },
        "notes": config.get("notes"),
    }


def ranking(runs: list[dict[str, Any]], key: str, reverse: bool = False) -> list[str]:
    available = [run for run in runs if isinstance(run.get(key), (int, float))]
    return [run["run_name"] for run in sorted(available, key=lambda run: float(run[key]), reverse=reverse)]


def fmt(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:.6f}"
    if value is None:
        return ""
    return str(value)


def write_markdown(path: Path, runs: list[dict[str, Any]]) -> None:
    headers = [
        "run",
        "val CER",
        "val exact",
        "short CER",
        "short exact",
        "dialogue CER",
        "test CER",
        "ONNX",
    ]
    lines = [
        "# PP-OCRv6 Bubble-Line Experiment Leaderboard",
        "",
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join(["---"] * len(headers)) + " |",
    ]
    for run in sorted(runs, key=lambda item: float(item.get("val_cer") or 999)):
        lines.append(
            "| "
            + " | ".join(
                [
                    run["run_name"],
                    fmt(run.get("val_cer")),
                    fmt(run.get("val_exact_match")),
                    fmt(run.get("short_cer")),
                    fmt(run.get("short_exact_match")),
                    fmt(run.get("dialogue_cer")),
                    fmt(run.get("test_cer")),
                    fmt(run.get("onnx_parity_text_match")),
                ]
            )
            + " |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build the PP-OCRv6 experiment leaderboard.")
    parser.add_argument("--experiments-dir", type=Path, default=DEFAULT_EXPERIMENTS_DIR)
    parser.add_argument("--output-json", type=Path, default=None)
    parser.add_argument("--output-md", type=Path, default=None)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    run_dirs = [
        path
        for path in sorted(args.experiments_dir.iterdir())
        if path.is_dir() and (path / "run_config.json").exists()
    ]
    runs = [collect_run(path) for path in run_dirs]
    payload = {
        "runs": runs,
        "rankings": {
            "best_validation_cer": ranking(runs, "val_cer"),
            "best_validation_exact_match": ranking(runs, "val_exact_match", reverse=True),
            "best_short_text_cer": ranking(runs, "short_cer"),
            "best_short_text_exact_match": ranking(runs, "short_exact_match", reverse=True),
            "best_dialogue_cer": ranking(runs, "dialogue_cer"),
            "best_downstream_test_cer": ranking(runs, "test_cer"),
            "browser_compatible": [run["run_name"] for run in runs if run.get("browser_compatible")],
        },
    }
    output_json = args.output_json or (args.experiments_dir / "leaderboard.json")
    output_md = args.output_md or (args.experiments_dir / "leaderboard.md")
    output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(output_md, runs)
    print(json.dumps({"runs": len(runs), "leaderboard": str(output_json)}, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
