import argparse
import sys
import time


def pipeline(model: str, imgsz: int, epochs: int, batch: int, patience: int, workers: int) -> None:
    pipeline_start = time.time()

    print()
    print("*" * 64)
    print("*  YOLO26n Bubble Line Detector - Training Pipeline")
    print("*" * 64)

    from train_yolo import train

    onnx_path, best_path, metrics_path = train(
        model_name=model,
        imgsz=imgsz,
        epochs=epochs,
        batch=batch,
        patience=patience,
        workers=workers,
    )

    total_time = time.time() - pipeline_start

    print()
    print("*" * 64)
    print("*  PIPELINE SUMMARY")
    print("*" * 64)
    print(f"  Total time:  {total_time / 60:.1f} min")
    print(f"  Best model:  {best_path}")
    print(f"  ONNX model:  {onnx_path}")
    print(f"  Metrics:     {metrics_path}")
    print("*" * 64)
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="YOLO26n Bubble Line Detector - Training Pipeline"
    )
    parser.add_argument("--model", default="yolo26n.pt", help="Base model (default: yolo26n.pt)")
    parser.add_argument("--imgsz", type=int, default=800, help="Image size (default: 800)")
    parser.add_argument("--epochs", type=int, default=100, help="Number of epochs (default: 100)")
    parser.add_argument("--batch", type=int, default=16, help="Batch size (default: 16)")
    parser.add_argument("--patience", type=int, default=20, help="Early stopping patience (default: 20)")
    parser.add_argument("--workers", type=int, default=0, help="Data loader workers (default: 0)")
    args = parser.parse_args()

    try:
        pipeline(
            model=args.model,
            imgsz=args.imgsz,
            epochs=args.epochs,
            batch=args.batch,
            patience=args.patience,
            workers=args.workers,
        )
    except KeyboardInterrupt:
        print("\n\n  Pipeline interrupted by user.")
        sys.exit(130)
    except Exception as exc:
        print(f"\n  [FATAL] Pipeline failed: {exc}")
        sys.exit(1)
