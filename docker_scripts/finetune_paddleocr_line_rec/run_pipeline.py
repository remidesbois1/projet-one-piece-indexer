import argparse
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

from prepare_line_rec_dataset import DEFAULT_DETECTOR, DEFAULT_OUTPUT_DIR, DEFAULT_SOURCE_DIR, export_dataset


os.environ["PYTHONUNBUFFERED"] = "1"
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)
SCRIPT_DIR = Path(__file__).resolve().parent


def run_command(command: list[str], allow_blocked: bool = False) -> int:
    print("", flush=True)
    print(" ".join(command), flush=True)
    result = subprocess.run(command, env={**os.environ, "PYTHONUNBUFFERED": "1"})
    if result.returncode == 2 and allow_blocked:
        return result.returncode
    if result.returncode != 0:
        sys.exit(result.returncode)
    return result.returncode


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare stitched single-line bubble images and launch PP-OCRv6 recognition training.")
    parser.add_argument("--source-mode", choices=["supabase", "source_dir"], default=os.getenv("PPOCR_SOURCE_MODE", "supabase"))
    parser.add_argument("--source-dir", type=Path, default=Path(os.getenv("PPOCR_LINE_SOURCE_DIR", DEFAULT_SOURCE_DIR)))
    parser.add_argument("--detector", type=Path, default=Path(os.getenv("PPOCR_LINE_DETECTOR", DEFAULT_DETECTOR)))
    parser.add_argument("--output-dir", type=Path, default=Path(os.getenv("PPOCR_LINE_OUTPUT_DIR", DEFAULT_OUTPUT_DIR)))
    parser.add_argument("--limit", type=int, default=0, help="Optional bubble limit for smoke tests.")
    parser.add_argument("--skip-dataset", action="store_true")
    parser.add_argument("--train", action="store_true", help="Attempt the PP-OCRv6 Transformers training launcher after dataset export.")
    parser.add_argument("--dry-run-train", action="store_true", help="Only verify model loading for the training launcher.")
    parser.add_argument("--allow-training-blocked", action="store_true", help="Return success when Transformers lacks PP-OCRv6 support but dataset export succeeded.")
    parser.add_argument("--epochs", type=int, default=int(os.getenv("PPOCR_EPOCHS", "5")))
    parser.add_argument("--batch-size", type=int, default=int(os.getenv("PPOCR_BATCH_SIZE", "2")))
    parser.add_argument("--learning-rate", type=float, default=float(os.getenv("PPOCR_LEARNING_RATE", "2e-5")))
    parser.add_argument("--backbone-learning-rate", type=float, default=float(os.getenv("PPOCR_BACKBONE_LEARNING_RATE", "2e-6")))
    parser.add_argument("--weight-decay", type=float, default=float(os.getenv("PPOCR_WEIGHT_DECAY", "0.01")))
    parser.add_argument("--lr-scheduler", choices=["none", "cosine"], default=os.getenv("PPOCR_LR_SCHEDULER", "none"))
    parser.add_argument("--warmup-ratio", type=float, default=float(os.getenv("PPOCR_WARMUP_RATIO", "0.03")))
    parser.add_argument("--resume-from", type=Path, default=None)
    parser.add_argument("--auto-resume-best", action="store_true")
    parser.add_argument("--train-workers", type=int, default=int(os.getenv("PPOCR_TRAIN_WORKERS", "0")))
    parser.add_argument("--image-width", type=int, default=int(os.getenv("PPOCR_IMAGE_WIDTH", "640")))
    parser.add_argument("--grad-accum-steps", type=int, default=int(os.getenv("PPOCR_GRAD_ACCUM_STEPS", "8")))
    parser.add_argument("--short-max-len", type=int, default=int(os.getenv("PPOCR_SHORT_MAX_LEN", "12")))
    parser.add_argument("--short-loss-weight", type=float, default=float(os.getenv("PPOCR_SHORT_LOSS_WEIGHT", "2.5")))
    parser.add_argument("--short-oversample", type=float, default=float(os.getenv("PPOCR_SHORT_OVERSAMPLE", "3.0")))
    parser.add_argument("--blank-penalty", type=float, default=float(os.getenv("PPOCR_BLANK_PENALTY", "0.0")))
    parser.add_argument("--train-backbone", action="store_true", help="Unfreeze the recognition backbone. Uses much more VRAM.")
    parser.add_argument("--no-amp", action="store_true", help="Disable CUDA mixed precision.")
    parser.add_argument("--pin-memory", action="store_true", help="Use pinned host memory for DataLoader batches.")
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--iou", type=float, default=0.45)
    parser.add_argument("--line-nms-iou", type=float, default=float(os.getenv("PPOCR_LINE_NMS_IOU", "0.85")))
    parser.add_argument("--imgsz", type=int, default=800)
    parser.add_argument("--pad", type=int, default=2)
    parser.add_argument("--line-gap", type=int, default=8)
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--val-size", type=float, default=float(os.getenv("PPOCR_VAL_SIZE", "0.15")))
    parser.add_argument("--test-size", type=float, default=float(os.getenv("PPOCR_TEST_SIZE", "0.15")))
    parser.add_argument("--seed", type=int, default=int(os.getenv("PPOCR_RANDOM_SEED", "42")))
    parser.add_argument("--min-text-len", type=int, default=int(os.getenv("PPOCR_MIN_TEXT_LENGTH", "1")))
    parser.add_argument("--bubble-crop-pad", type=int, default=int(os.getenv("PPOCR_BUBBLE_CROP_PAD_PX", "0")))
    parser.add_argument("--supabase-page-size", type=int, default=int(os.getenv("PPOCR_SUPABASE_PAGE_SIZE", "1000")))
    parser.add_argument("--status-value", default=os.getenv("PPOCR_BUBBLE_STATUS", "Valid\u00e9"))
    parser.add_argument("--download-workers", type=int, default=int(os.getenv("PPOCR_DOWNLOAD_WORKERS", "16")))
    parser.add_argument("--request-timeout", type=int, default=int(os.getenv("PPOCR_REQUEST_TIMEOUT_SECONDS", "45")))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    print("PP-OCRv6 bubble-line recognition pipeline", flush=True)
    print(f"Source mode: {args.source_mode}", flush=True)
    print(f"Source:   {args.source_dir}", flush=True)
    print(f"Detector: {args.detector}", flush=True)
    print(f"Output:   {args.output_dir}", flush=True)

    if not args.skip_dataset:
        export_args = SimpleNamespace(
            source_dir=args.source_dir,
            source_mode=args.source_mode,
            detector=args.detector,
            output_dir=args.output_dir,
            limit=args.limit,
            conf=args.conf,
            iou=args.iou,
            line_nms_iou=args.line_nms_iou,
            imgsz=args.imgsz,
            pad=args.pad,
            line_gap=args.line_gap,
            val_ratio=0.1,
            clean=args.clean,
            val_size=args.val_size,
            test_size=args.test_size,
            seed=args.seed,
            min_text_len=args.min_text_len,
            bubble_crop_pad=args.bubble_crop_pad,
            supabase_page_size=args.supabase_page_size,
            status_value=args.status_value,
            download_workers=args.download_workers,
            request_timeout=args.request_timeout,
        )
        export_dataset(export_args)

    if args.train or args.dry_run_train:
        command = [
            sys.executable,
            "-u",
            str(SCRIPT_DIR / "train_ppocrv6_rec.py"),
            "--output-dir",
            str(args.output_dir),
            "--epochs",
            str(args.epochs),
            "--batch-size",
            str(args.batch_size),
            "--learning-rate",
            str(args.learning_rate),
            "--backbone-learning-rate",
            str(args.backbone_learning_rate),
            "--weight-decay",
            str(args.weight_decay),
            "--lr-scheduler",
            args.lr_scheduler,
            "--warmup-ratio",
            str(args.warmup_ratio),
            "--workers",
            str(args.train_workers),
            "--image-width",
            str(args.image_width),
            "--grad-accum-steps",
            str(args.grad_accum_steps),
            "--short-max-len",
            str(args.short_max_len),
            "--short-loss-weight",
            str(args.short_loss_weight),
            "--short-oversample",
            str(args.short_oversample),
            "--blank-penalty",
            str(args.blank_penalty),
        ]
        if args.train_backbone:
            command.append("--train-backbone")
        if args.resume_from:
            command.extend(["--resume-from", str(args.resume_from)])
        if args.auto_resume_best:
            command.append("--auto-resume-best")
        if args.no_amp:
            command.append("--no-amp")
        if args.pin_memory:
            command.append("--pin-memory")
        if args.dry_run_train:
            command.append("--dry-run")
        code = run_command(command, allow_blocked=args.allow_training_blocked)
        if code == 2 and args.allow_training_blocked:
            print("Training launcher is blocked by missing Transformers architecture support, but dataset export succeeded.", flush=True)
            return 0

    print("Pipeline complete.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
