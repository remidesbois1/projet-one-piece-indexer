import argparse
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def step_header(step_num, total_steps, title):
    print()
    print("+" + "=" * 58 + "+")
    print(f"|  STEP {step_num}/{total_steps}: {title:<44} |")
    print("+" + "=" * 58 + "+")


def pipeline(skip_dataset=False, skip_compare=False, skip_upload=False):
    pipeline_start = time.time()
    total_steps = 4 - sum([skip_dataset, skip_compare, skip_upload])
    step = 0

    print()
    print("*" * 60)
    print("*  YOLO26n Bubble Detector - Training Pipeline")
    print("*" * 60)

    if not skip_dataset:
        step += 1
        step_header(step, total_steps, "EXPORT DATASET")
        t0 = time.time()
        from export_dataset_yolo import main as export_dataset
        export_dataset()
        print(f"\n  Done in {time.time() - t0:.1f}s")

    step += 1
    step_header(step, total_steps, "TRAIN YOLO26n")
    t0 = time.time()
    from train_yolo import train
    onnx_path, best_path = train()
    print(f"\n  Done in {time.time() - t0:.1f}s")

    if not skip_compare:
        step += 1
        step_header(step, total_steps, "COMPARE MODELS")
        t0 = time.time()
        from compare_models import compare
        is_better = compare()
        print(f"\n  Done in {time.time() - t0:.1f}s")
    else:
        is_better = True

    if is_better and not skip_upload:
        step += 1
        step_header(step, total_steps, "UPLOAD TO HUGGINGFACE")
        t0 = time.time()
        from uploader import upload
        upload(onnx_path)
        print(f"\n  Done in {time.time() - t0:.1f}s")
    elif not is_better:
        print()
        print("  New model is NOT better than production. Skipping upload.")

    total_time = time.time() - pipeline_start

    print()
    print("*" * 60)
    print("*  PIPELINE SUMMARY")
    print("*" * 60)
    print(f"  Total time:    {total_time / 60:.1f} min")
    print(f"  Best model:    {best_path}")
    print(f"  ONNX model:    {onnx_path}")
    print(f"  Uploaded:      {'Yes' if is_better and not skip_upload else 'No'}")
    print("*" * 60)
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="YOLO26n Bubble Detector - Full Training Pipeline"
    )
    parser.add_argument(
        "--skip-dataset", action="store_true",
        help="Skip dataset download (use existing dataset/)"
    )
    parser.add_argument(
        "--skip-compare", action="store_true",
        help="Skip model comparison (auto-accept new model)"
    )
    parser.add_argument(
        "--skip-upload", action="store_true",
        help="Skip upload to HuggingFace"
    )
    args = parser.parse_args()

    try:
        pipeline(
            skip_dataset=args.skip_dataset,
            skip_compare=args.skip_compare,
            skip_upload=args.skip_upload,
        )
    except KeyboardInterrupt:
        print("\n\n  Pipeline interrupted by user.")
        sys.exit(130)
    except Exception as e:
        print(f"\n  [FATAL] Pipeline failed: {e}")
        sys.exit(1)
