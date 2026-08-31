"""Train a YOLO segmentation model on the exported four-point case dataset."""
from __future__ import annotations

import argparse
import json
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ultralytics import YOLO


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATA = SCRIPT_DIR / "dataset" / "data.yaml"
DEFAULT_RUNS = SCRIPT_DIR / "runs"
DEFAULT_LATEST = SCRIPT_DIR / "models" / "latest_polygon_seg.pt"


def count_dataset(data_yaml: Path) -> tuple[int, int, int]:
    root = data_yaml.parent
    image_count = 0
    label_count = 0
    case_count = 0
    for split in ("train", "val"):
        image_dir = root / split / "images"
        label_dir = root / split / "labels"
        for image in image_dir.glob("*") if image_dir.exists() else []:
            if image.is_file():
                image_count += 1
                label = label_dir / f"{image.stem}.txt"
                if label.exists():
                    label_count += 1
                    case_count += sum(1 for line in label.read_text(encoding="utf-8").splitlines() if line.strip())
    return image_count, label_count, case_count


def device_value(value: str) -> str | int:
    if value.isdigit():
        return int(value)
    return value


def train(args: argparse.Namespace) -> Path:
    data_yaml = args.data.resolve()
    if not data_yaml.exists():
        raise FileNotFoundError(f"Dataset introuvable : {data_yaml}. Lancez d’abord l’export depuis l’annotateur.")
    images, labels, cases = count_dataset(data_yaml)
    if images == 0 or labels == 0 or cases == 0:
        raise ValueError(f"Dataset vide ou sans annotations utilisables : images={images}, labels={labels}, cases={cases}")

    print("=" * 68)
    print("  ENTRAINEMENT YOLO SEGMENTATION — CASES POLYGONALES")
    print("=" * 68)
    print(f"Dataset : {data_yaml}")
    print(f"Pages   : {images}")
    print(f"Labels  : {labels}")
    print(f"Cases   : {cases}")
    print(f"Modèle  : {args.model}")
    print(f"Device  : {args.device}")
    print(f"Epochs  : {args.epochs}")
    print(f"Image   : {args.imgsz}")
    print()

    import torch
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    torch.backends.cudnn.benchmark = True
    torch.set_float32_matmul_precision("high")
    print("Acceleration : AMP + TF32 + cuDNN benchmark", flush=True)
    started = time.time()
    model = YOLO(args.model)
    run_name = args.name or f"polygon_seg_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    result = model.train(
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        workers=args.workers,
        patience=args.patience,
        device=device_value(args.device),
        project=str(args.runs.resolve()),
        name=run_name,
        exist_ok=False,
        plots=True,
        cache=args.cache,
        amp=True,
        resume=args.resume,
    )
    run_dir = Path(result.save_dir)
    best = run_dir / "weights" / "best.pt"
    if not best.exists():
        raise FileNotFoundError(f"Poids best.pt introuvables dans {run_dir}")

    latest = args.latest.resolve()
    latest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, latest)
    metadata: dict[str, Any] = {
        "kind": "polygon_case_detector_training",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "dataset": str(data_yaml),
        "run_dir": str(run_dir),
        "best_model": str(best),
        "latest_model": str(latest),
        "pages": images,
        "labels": labels,
        "cases": cases,
        "model": args.model,
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "duration_seconds": round(time.time() - started, 2),
    }
    (run_dir / "training_summary.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print()
    print(f"Entraînement terminé en {metadata['duration_seconds']} s")
    print(f"Best model : {best}")
    print(f"Dernier modèle pour l’annotateur : {latest}")
    return best


def main() -> None:
    parser = argparse.ArgumentParser(description="Entraîne YOLO segmentation sur les cases polygonales exportées.")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="data.yaml de l’export polygonal")
    parser.add_argument("--model", default="yolo11n-seg.pt", help="modèle de base Ultralytics, par défaut yolo11n-seg.pt")
    parser.add_argument("--runs", type=Path, default=DEFAULT_RUNS)
    parser.add_argument("--latest", type=Path, default=DEFAULT_LATEST)
    parser.add_argument("--name", default=None)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=1504, help="résolution d’entraînement ; 1504 est aligné sur le stride 32 pour des pages de 1500 px")
    parser.add_argument("--batch", type=int, default=-1, help="-1 = auto-batch Ultralytics, recommandé pour la RTX 5090 32 Go")
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--patience", type=int, default=25)
    parser.add_argument("--device", default="auto", help="auto, cpu, 0, 1…")
    parser.add_argument("--cache", action="store_true", help="met les images en cache pendant l’entraînement")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.device == "auto":
        try:
            import torch
            args.device = "0" if torch.cuda.is_available() else "cpu"
        except ImportError:
            args.device = "cpu"
    train(args)


if __name__ == "__main__":
    main()
