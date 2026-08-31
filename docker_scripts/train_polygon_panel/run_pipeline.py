from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

os.environ["PYTHONUNBUFFERED"] = "1"
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(SCRIPT_DIR.parent / ".env")
DATASET_DIR = Path(os.getenv("POLYGON_DATASET_DIR", "/app/dataset"))
OUTPUT_DIR = Path(os.getenv("POLYGON_OUTPUT_DIR", "/workspace/outputs_polygon_panel"))
HF_REPO = os.getenv("HF_REPO", "Remidesbois/Yolo11-seg-Panel-Poneglyph")
DEFAULT_MODEL = os.getenv("POLYGON_MODEL", "yolo11n-seg.pt")

def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", ""}


def json_safe(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            return str(value)
    if hasattr(value, "tolist"):
        try:
            return json_safe(value.tolist())
        except Exception:
            return str(value)
    return value


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(json_safe(payload), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_step(label: str, script: str, *args: str) -> None:
    print(f"\n{'=' * 78}\n{label}\n{'=' * 78}", flush=True)
    result = subprocess.run([sys.executable, "-u", script, *args], env={**os.environ, "PYTHONUNBUFFERED": "1"})
    if result.returncode:
        raise RuntimeError(f"{script} a échoué avec le code {result.returncode}")


def write_container_data_yaml() -> Path:
    source = DATASET_DIR / "data.yaml"
    if not source.exists():
        raise FileNotFoundError(f"Dataset absent : {source}")
    # Keep the generated YAML beside the dataset. train_polygon.py performs
    # its fast preflight count relative to the YAML parent, so placing it in
    # OUTPUT_DIR would make a valid /app/dataset look empty.
    target = DATASET_DIR / "container_data.yaml"
    target.write_text(
        "path: /app/dataset\ntrain: train/images\nval: val/images\n\nnames:\n  0: case\n",
        encoding="utf-8",
    )
    return target


def _non_rectangular_score(values: list[float]) -> float:
    """Return how far a four-point YOLO polygon is from its minimum rectangle."""
    if len(values) != 8:
        return 0.0
    try:
        import cv2
        import numpy as np
        points = np.asarray(values, dtype=np.float32).reshape(4, 2)
        polygon_area = abs(float(cv2.contourArea(points.reshape(-1, 1, 2))))
        rectangle = cv2.minAreaRect(points)
        rw, rh = rectangle[1]
        rectangle_area = float(rw * rh)
        if rectangle_area <= 1e-6:
            return 0.0
        return max(0.0, min(1.0, 1.0 - polygon_area / rectangle_area))
    except Exception:
        return 0.0


def prepare_weighted_training_dataset() -> tuple[Path, dict[str, Any]]:
    """Create a temporary train split with a light oversampling of hard pages.

    Validation is never duplicated. A page gets one or two extra copies only
    when several of its polygons are measurably less rectangular, which gives
    YOLO more gradient updates on trapezoidal/irregular cases without letting
    a handful of examples dominate the run.
    """
    import cv2  # noqa: F401 - validates the dependency before training starts

    output = OUTPUT_DIR / "weighted_dataset"
    if output.exists():
        shutil.rmtree(output)
    train_images = DATASET_DIR / "train" / "images"
    train_labels = DATASET_DIR / "train" / "labels"
    weighted_images = output / "train" / "images"
    weighted_labels = output / "train" / "labels"
    weighted_images.mkdir(parents=True, exist_ok=True)
    weighted_labels.mkdir(parents=True, exist_ok=True)

    min_score = float(os.getenv("POLYGON_HARD_MIN_SCORE", "0.025"))
    min_ratio = float(os.getenv("POLYGON_HARD_MIN_RATIO", "0.25"))
    max_extra = max(0, int(os.getenv("POLYGON_HARD_MAX_EXTRA", "2")))
    stats: dict[str, Any] = {"pages": 0, "hard_pages": 0, "extra_copies": 0, "hard_cases": 0, "threshold": min_score}
    image_extensions = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".avif"}

    for image in sorted(train_images.iterdir()):
        if not image.is_file() or image.suffix.lower() not in image_extensions:
            continue
        label = train_labels / f"{image.stem}.txt"
        lines = label.read_text(encoding="utf-8").splitlines() if label.exists() else []
        scores = []
        for line in lines:
            parts = line.split()
            if len(parts) >= 9:
                try:
                    score = _non_rectangular_score([float(value) for value in parts[1:9]])
                except ValueError:
                    score = 0.0
                scores.append(score)
        hard_cases = sum(score >= min_score for score in scores)
        hard_ratio = hard_cases / len(scores) if scores else 0.0
        extra = 0
        if hard_cases >= 2 and hard_ratio >= min_ratio:
            extra = 1
        if hard_cases >= 4 and hard_ratio >= max(min_ratio, 0.5):
            extra = min(max_extra, 2)
        copies = 1 + extra
        for copy_index in range(copies):
            suffix = "" if copy_index == 0 else f"_hard{copy_index}"
            destination_image = weighted_images / f"{image.stem}{suffix}{image.suffix.lower()}"
            destination_label = weighted_labels / f"{image.stem}{suffix}.txt"
            shutil.copy2(image, destination_image)
            if label.exists():
                shutil.copy2(label, destination_label)
        stats["pages"] += 1
        stats["hard_pages"] += int(extra > 0)
        stats["extra_copies"] += extra
        stats["hard_cases"] += hard_cases

    data_yaml = output / "data.yaml"
    data_yaml.write_text(
        f"path: {output.as_posix()}\ntrain: train/images\nval: {(DATASET_DIR / 'val' / 'images').as_posix()}\n\nnames:\n  0: case\n",
        encoding="utf-8",
    )
    print(
        f"Sur-échantillonnage formes difficiles : {stats['pages']} pages, "
        f"{stats['hard_pages']} pages renforcées, +{stats['extra_copies']} copies, "
        f"{stats['hard_cases']} cases non rectangulaires détectées.",
        flush=True,
    )
    return data_yaml, stats


def latest_run_dir() -> Path:
    candidates = sorted((OUTPUT_DIR / "runs").glob("**/weights/best.pt"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise FileNotFoundError("Aucun best.pt produit par l’entraînement.")
    return candidates[0].parents[1]


def read_csv_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def metrics_from_validator(metrics: Any) -> dict[str, Any]:
    box = getattr(metrics, "box", None)
    names = getattr(metrics, "names", {}) or {}
    if isinstance(names, list):
        names = {i: value for i, value in enumerate(names)}
    per_class = []
    maps = getattr(box, "maps", []) if box is not None else []
    precisions = getattr(box, "p", []) if box is not None else []
    recalls = getattr(box, "r", []) if box is not None else []
    f1s = getattr(box, "f1", []) if box is not None else []
    ap50s = getattr(box, "ap50", []) if box is not None else []
    for index in range(len(maps)):
        per_class.append({
            "class_id": index,
            "class_name": names.get(index, str(index)),
            "precision": precisions[index] if index < len(precisions) else None,
            "recall": recalls[index] if index < len(recalls) else None,
            "f1": f1s[index] if index < len(f1s) else None,
            "mAP50": ap50s[index] if index < len(ap50s) else None,
            "mAP50-95": maps[index],
        })
    return {
        "results_dict": getattr(metrics, "results_dict", {}),
        "speed": getattr(metrics, "speed", {}),
        "fitness": getattr(metrics, "fitness", None),
        "names": names,
        "per_class": per_class,
        "save_dir": getattr(metrics, "save_dir", None),
    }


def collect_file_index(root: Path) -> list[dict[str, Any]]:
    result = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            result.append({"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size})
    return result


def collect_environment() -> dict[str, Any]:
    info: dict[str, Any] = {"python": platform.python_version(), "platform": platform.platform()}
    try:
        import torch
        info.update({"torch": torch.__version__, "cuda": torch.version.cuda, "cuda_available": torch.cuda.is_available()})
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
            info["gpu_memory_bytes"] = torch.cuda.get_device_properties(0).total_memory
    except Exception as exc:
        info["torch_error"] = str(exc)
    try:
        import ultralytics
        info["ultralytics"] = ultralytics.__version__
    except Exception:
        pass
    return info


def write_markdown_report(report: dict[str, Any], path: Path) -> None:
    val = report.get("validation", {})
    results = val.get("results_dict", {})
    lines = [
        "# YOLO11 segmentation — Panel Poneglyph",
        "",
        f"- Repository: `{HF_REPO}`",
        f"- Run: `{report.get('run_dir')}`",
        f"- Dataset: `{report.get('dataset', {}).get('pages')} pages / {report.get('dataset', {}).get('cases')} cases`",
        f"- Model base: `{report.get('training', {}).get('model')}`",
        f"- Image size: `{report.get('training', {}).get('imgsz')}`",
        f"- Device: `{report.get('environment', {}).get('gpu', report.get('environment', {}).get('cuda_available'))}`",
        "",
        "## Validation metrics",
        "",
        "| Metric | Value |",
        "|---|---:|",
    ]
    for key, value in results.items():
        lines.append(f"| `{key}` | `{value}` |")
    lines += ["", "## Artefacts", "", "Les poids, `results.csv`, courbes, matrices de confusion, prédictions JSON et fichiers produits par Ultralytics sont conservés dans `runs/`.", "", "```text"]
    lines.extend(item["path"] for item in report.get("files", []))
    lines += ["```", "", "Le détail machine-readable complet est dans `metrics_report.json`."]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def publish(run_dir: Path, data_yaml: Path, args: argparse.Namespace) -> Path:
    from ultralytics import YOLO
    from huggingface_hub import HfApi, login

    best = run_dir / "weights" / "best.pt"
    model = YOLO(str(best))
    eval_project = OUTPUT_DIR / "runs" / "evaluation"
    print("\nValidation complète du best.pt…", flush=True)
    validation = model.val(
        data=str(data_yaml), imgsz=args.imgsz, split="val", plots=True, save_json=True,
        project=str(eval_project), name="val", exist_ok=True, device=args.device,
    )

    onnx_path = None
    if not args.no_onnx:
        print("Export ONNX…", flush=True)
        exported = model.export(format="onnx", imgsz=args.imgsz, simplify=True, opset=12, nms=True)
        onnx_path = Path(exported)

    release = OUTPUT_DIR / "hf_release"
    if release.exists():
        shutil.rmtree(release)
    release.mkdir(parents=True)
    shutil.copytree(OUTPUT_DIR / "runs", release / "runs")
    (release / "weights").mkdir()
    shutil.copy2(best, release / "weights" / "best.pt")
    last = run_dir / "weights" / "last.pt"
    if last.exists(): shutil.copy2(last, release / "weights" / "last.pt")
    if onnx_path and onnx_path.exists(): shutil.copy2(onnx_path, release / "panel_detector.onnx")

    dataset_images = len(list((DATASET_DIR / "train" / "images").glob("*"))) + len(list((DATASET_DIR / "val" / "images").glob("*")))
    dataset_cases = sum(len(path.read_text(encoding="utf-8").splitlines()) for path in (DATASET_DIR / "train" / "labels").glob("*.txt")) + sum(len(path.read_text(encoding="utf-8").splitlines()) for path in (DATASET_DIR / "val" / "labels").glob("*.txt"))
    report = {
        "kind": "yolo_polygon_panel_training_report",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "repo": HF_REPO,
        "dataset": {"path": str(DATASET_DIR), "pages": dataset_images, "cases": dataset_cases, "data_yaml": str(data_yaml)},
        "run_dir": str(run_dir),
        "training": {"model": args.model, "epochs": args.epochs, "imgsz": args.imgsz, "batch": args.batch, "workers": args.workers, "patience": args.patience, "device": args.device, "results_csv": read_csv_rows(run_dir / "results.csv")},
        "validation": metrics_from_validator(validation),
        "environment": collect_environment(),
        "files": collect_file_index(OUTPUT_DIR / "runs"),
    }
    write_json(release / "metrics_report.json", report)
    write_markdown_report(report, release / "metrics_report.md")
    (release / "README.md").write_text((release / "metrics_report.md").read_text(encoding="utf-8"), encoding="utf-8")

    token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_HUB_TOKEN")
    if env_bool("POLYGON_SKIP_UPLOAD", False):
        print("Upload Hugging Face désactivé par POLYGON_SKIP_UPLOAD=1.", flush=True)
    elif not token:
        raise RuntimeError("HF_TOKEN est requis pour publier le modèle. Utilisez POLYGON_SKIP_UPLOAD=1 pour un run local.")
    else:
        login(token=token)
        api = HfApi(token=token)
        api.create_repo(repo_id=HF_REPO, repo_type="model", private=env_bool("HF_PRIVATE", False), exist_ok=True)
        print(f"Publication de tous les artefacts vers https://huggingface.co/{HF_REPO}…", flush=True)
        api.upload_folder(folder_path=str(release), repo_id=HF_REPO, repo_type="model", commit_message="Train YOLO11 segmentation panel detector")
        print("Publication Hugging Face terminée.", flush=True)
    return release


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train, evaluate and publish the YOLO polygon panel detector.")
    parser.add_argument("--epochs", type=int, default=int(os.getenv("POLYGON_EPOCHS", "100")))
    parser.add_argument("--imgsz", type=int, default=int(os.getenv("POLYGON_IMGSZ", "1504")))
    parser.add_argument("--batch", type=int, default=int(os.getenv("POLYGON_BATCH", "-1")))
    parser.add_argument("--workers", type=int, default=int(os.getenv("POLYGON_WORKERS", "12")))
    parser.add_argument("--patience", type=int, default=int(os.getenv("POLYGON_PATIENCE", "30")))
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default=os.getenv("POLYGON_DEVICE", "0"))
    parser.add_argument("--name", default=os.getenv("POLYGON_RUN_NAME", "yolo11_seg_panel"))
    parser.add_argument("--no-onnx", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    write_container_data_yaml()
    if not (DATASET_DIR / "train" / "images").exists() or not (DATASET_DIR / "val" / "images").exists():
        raise RuntimeError(f"Dataset intégré incomplet dans {DATASET_DIR}")
    data_yaml, hard_shape_stats = prepare_weighted_training_dataset()
    if args.dry_run:
        print(f"Dry run OK: dataset={DATASET_DIR}, weighted_data={data_yaml}, output={OUTPUT_DIR}, repo={HF_REPO}, imgsz={args.imgsz}, device={args.device}")
        return

    from common_training.env import training_job_id, training_provider
    from common_training.provider import provider_from_env
    hooks = provider_from_env(job_id=training_job_id(), kind="yolo_polygon_panel")
    try:
        hooks.on_start(status="running", hf_repo=HF_REPO, runpod_pod_id=os.getenv("RUNPOD_POD_ID"))
        train_args = ["--data", str(data_yaml), "--runs", str(OUTPUT_DIR / "runs"), "--latest", str(OUTPUT_DIR / "latest_polygon_seg.pt"), "--model", args.model, "--epochs", str(args.epochs), "--imgsz", str(args.imgsz), "--batch", str(args.batch), "--workers", str(args.workers), "--patience", str(args.patience), "--device", str(args.device), "--name", args.name]
        if env_bool("POLYGON_CACHE_RAM", True):
            train_args.append("--cache")
        run_step("Entraînement YOLO segmentation — profil RTX 5090", "/app/train_polygon.py", *train_args)
        run_dir = latest_run_dir()
        release = publish(run_dir, data_yaml, args)
        summary = {"status": "complete", "training_kind": "yolo_polygon_panel", "provider": training_provider(), "hf_repo": HF_REPO, "run_dir": str(run_dir), "release_dir": str(release), "dataset_dir": str(DATASET_DIR), "weighted_dataset": hard_shape_stats, "output_dir": str(OUTPUT_DIR)}
        write_json(OUTPUT_DIR / "pipeline_summary.json", summary)
        hooks.on_complete(summary)
    except Exception as exc:
        write_json(OUTPUT_DIR / "pipeline_summary.json", {"status": "failed", "error": str(exc), "hf_repo": HF_REPO, "output_dir": str(OUTPUT_DIR)})
        hooks.on_error(str(exc))
        raise


if __name__ == "__main__":
    main()
