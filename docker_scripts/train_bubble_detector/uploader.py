import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from huggingface_hub import HfApi

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ID = "Remidesbois/YoloPiece_BubbleDetector_Nano"

load_dotenv()
HF_TOKEN = os.getenv("HF_TOKEN")

if not HF_TOKEN:
    env_path = SCRIPT_DIR.parent.parent / ".env"
    load_dotenv(env_path)
    HF_TOKEN = os.getenv("HF_TOKEN")


def upload(onnx_path) -> bool:
    if not HF_TOKEN:
        print("  [ERROR] HF_TOKEN not found. Cannot upload.")
        return False

    onnx_path = Path(onnx_path)
    if not onnx_path.exists():
        print(f"  [ERROR] File not found: {onnx_path}")
        return False

    print()
    print("=" * 60)
    print("  UPLOAD TO HUGGINGFACE")
    print("=" * 60)
    print()
    print(f"  File:   {onnx_path}")
    print(f"  Repo:   {REPO_ID}")
    print(f"  Target: onepiece_detector_nano.onnx")
    print()

    api = HfApi()
    try:
        api.upload_file(
            path_or_fileobj=str(onnx_path),
            path_in_repo="onepiece_detector_nano.onnx",
            repo_id=REPO_ID,
            token=HF_TOKEN,
        )
        print("  Upload successful!")
        print()
        print("=" * 60)
        print("  UPLOAD COMPLETE")
        print("=" * 60)
        return True
    except Exception as e:
        print(f"  [ERROR] Upload failed: {e}")
        return False


if __name__ == "__main__":
    if len(sys.argv) > 1:
        onnx_file = Path(sys.argv[1])
    else:
        runs_dir = SCRIPT_DIR / "runs"
        all_runs = sorted(runs_dir.glob("yolo26n_bubble*"), key=os.path.getmtime, reverse=True)
        if all_runs:
            onnx_file = all_runs[0] / "weights" / "best.onnx"
        else:
            onnx_file = SCRIPT_DIR / "runs" / "yolo26n_bubble" / "weights" / "best.onnx"

    if onnx_file.exists():
        upload(onnx_file)
    else:
        print(f"File not found: {onnx_file}")
        sys.exit(1)
