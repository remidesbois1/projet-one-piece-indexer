import os
import gc
import torch
from export_dataset_yolo import main as export_main
from train_yolo_x import train as train_x
from train_yolo_n import train as train_n
from compare_models import compare_x, compare_n
from uploader import upload_x, upload_n
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def flush_gpu():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        print(f"  GPU memory freed. Allocated: {torch.cuda.memory_allocated(0) / 1e9:.2f} GB")


def run():
    print("=" * 60)
    print("  NANO-MAX PIPELINE")
    print("  Phase 1: Train YOLO11x (Extra-Large)")
    print("  Phase 2: Upload YOLO11x to HuggingFace")
    print("  Phase 3: Distill YOLO11n (Nano) from YOLO11x")
    print("=" * 60)

    print("\n[1/6] Extracting dataset from Supabase...")
    export_main()

    print("\n[2/6] Training YOLO11x...")
    teacher_pt_path, x_onnx_path = train_x()
    flush_gpu()

    print("\n[3/6] Comparing YOLO11x vs baseline...")
    x_is_better = compare_x()
    flush_gpu()

    if x_is_better:
        print("\n[4/6] Uploading YOLO11x to HuggingFace...")
        upload_x(x_onnx_path)
    else:
        print("\n[4/6] YOLO11x not better than baseline, skipping upload.")
        print("       Continuing with distillation anyway (X model is still a strong teacher).")

    print("\n[5/6] Training YOLO11n with YOLO11x as teacher...")
    flush_gpu()
    n_onnx_path = train_n(str(teacher_pt_path))
    flush_gpu()

    print("\n[6/6] Comparing YOLO11n vs baseline...")
    n_is_better = compare_n()

    if n_is_better:
        print("\nUploading YOLO11n to HuggingFace...")
        upload_n(n_onnx_path)
    else:
        print("\nYOLO11n not better than baseline, skipping upload.")

    print("\n" + "=" * 60)
    print("  NANO-MAX PIPELINE COMPLETE")
    print(f"  YOLO11x: {'UPLOADED' if x_is_better else 'NOT UPLOADED (below baseline)'}")
    print(f"  YOLO11n: {'UPLOADED' if n_is_better else 'NOT UPLOADED (below baseline)'}")
    print("=" * 60)


if __name__ == "__main__":
    run()
