from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ANNOTATIONS_PATH = SCRIPT_DIR / "panel_annotation_dataset" / "panel_annotations.json"
DEFAULT_DATASET_DIR = SCRIPT_DIR / "dataset"
DEFAULT_DATASET_YAML = DEFAULT_DATASET_DIR / "data.yaml"


def step_header(step_num: int, total_steps: int, title: str) -> None:
    print()
    print("+" + "=" * 58 + "+")
    print(f"|  STEP {step_num}/{total_steps}: {title:<44} |")
    print("+" + "=" * 58 + "+")


def pipeline(
    annotations_path: Path,
    dataset_dir: Path,
    skip_export: bool,
    test_size: float,
    seed: int,
    min_cases: int,
    model_name: str,
    imgsz: int,
    epochs: int,
    batch: int,
    patience: int,
    workers: int,
    device: str,
    export_onnx: bool,
) -> None:
    total_steps = 1 if skip_export else 2
    step = 0
    t0 = time.time()

    print()
    print("*" * 60)
    print("*  YOLO26 Panel Detector - Training Pipeline")
    print("*" * 60)

    dataset_yaml = dataset_dir / "data.yaml"

    if not skip_export:
        step += 1
        step_header(step, total_steps, "EXPORT TRAIN/TEST DATASET")
        from export_dataset_yolo import export_dataset

        dataset_yaml = export_dataset(
            annotations_path=annotations_path,
            output_dir=dataset_dir,
            test_size=test_size,
            seed=seed,
            min_cases=min_cases,
        )

    step += 1
    step_header(step, total_steps, "TRAIN AND TEST YOLO26")
    from train_yolo import train

    onnx_path, best_path, metrics_path = train(
        model_name=model_name,
        dataset_yaml=dataset_yaml,
        imgsz=imgsz,
        epochs=epochs,
        batch=batch,
        patience=patience,
        workers=workers,
        device=device,
        export=export_onnx,
    )

    print()
    print("*" * 60)
    print("*  PIPELINE SUMMARY")
    print("*" * 60)
    print(f"  Total time:   {(time.time() - t0) / 60:.1f} min")
    print(f"  Dataset YAML: {dataset_yaml}")
    print(f"  Best model:   {best_path}")
    if onnx_path:
        print(f"  ONNX model:   {onnx_path}")
    print(f"  Metrics JSON: {metrics_path}")
    print("*" * 60)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export panel annotations, train YOLO26, and evaluate on the test split."
    )
    parser.add_argument("--annotations", type=Path, default=DEFAULT_ANNOTATIONS_PATH)
    parser.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    parser.add_argument("--skip-export", action="store_true")
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--min-cases", type=int, default=1)
    parser.add_argument("--model", default="yolo26n.pt")
    parser.add_argument("--imgsz", type=int, default=800)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--patience", type=int, default=20)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--no-onnx", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        pipeline(
            annotations_path=args.annotations,
            dataset_dir=args.dataset_dir,
            skip_export=args.skip_export,
            test_size=args.test_size,
            seed=args.seed,
            min_cases=max(1, args.min_cases),
            model_name=args.model,
            imgsz=args.imgsz,
            epochs=args.epochs,
            batch=args.batch,
            patience=args.patience,
            workers=args.workers,
            device=args.device,
            export_onnx=not args.no_onnx,
        )
    except KeyboardInterrupt:
        print("\nPipeline interrupted by user.")
        sys.exit(130)
    except Exception as exc:
        print(f"\n[FATAL] Pipeline failed: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
