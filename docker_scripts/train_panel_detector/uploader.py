import os
from pathlib import Path
from huggingface_hub import HfApi
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv()

HF_TOKEN = os.getenv("HF_TOKEN")
REPO_ID = "Remidesbois/YoloPiece_PanelDetector"

if not HF_TOKEN:
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    load_dotenv(env_path)
    HF_TOKEN = os.getenv("HF_TOKEN")


def upload(onnx_path):
    if not HF_TOKEN:
        print("HF_TOKEN not found in .env")
        return False

    api = HfApi()
    print(f"Uploading {onnx_path} to {REPO_ID}...")

    try:
        api.upload_file(
            path_or_fileobj=str(onnx_path),
            path_in_repo="panel_detector.onnx",
            repo_id=REPO_ID,
            token=HF_TOKEN,
        )
        print("Upload successful!")
        return True
    except Exception as e:
        print(f"Upload failed: {e}")
        return False


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        onnx_file = Path(sys.argv[1])
    else:
        runs_dir = SCRIPT_DIR / "runs"
        all_runs = sorted(
            runs_dir.glob("yolo11m_panel_pose*"), key=os.path.getmtime, reverse=True
        )
        if all_runs:
            onnx_file = all_runs[0] / "weights" / "best.onnx"
        else:
            onnx_file = (
                SCRIPT_DIR / "runs" / "yolo11m_panel_pose" / "weights" / "best.onnx"
            )

    if onnx_file.exists():
        upload(onnx_file)
    else:
        print(f"File not found: {onnx_file}")
