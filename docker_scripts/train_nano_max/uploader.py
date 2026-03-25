import os
from pathlib import Path
from huggingface_hub import HfApi
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
load_dotenv()

HF_TOKEN = os.getenv("HF_TOKEN")
REPO_X = "Remidesbois/YoloPiece_BubbleDetector_X"
REPO_N = "Remidesbois/YoloPiece_BubbleDetector_Nano"

if not HF_TOKEN:
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    load_dotenv(env_path)
    HF_TOKEN = os.getenv("HF_TOKEN")


def upload_x(onnx_path):
    return _upload(onnx_path, REPO_X, "onepiece_detector_x.onnx")


def upload_n(onnx_path):
    return _upload(onnx_path, REPO_N, "onepiece_detector_nano.onnx")


def _upload(onnx_path, repo_id, filename):
    if not HF_TOKEN:
        print("HF_TOKEN not found in .env")
        return False

    api = HfApi()
    print(f"Uploading {onnx_path} to {repo_id} as {filename}...")

    try:
        api.create_repo(repo_id=repo_id, token=HF_TOKEN, exist_ok=True)
        api.upload_file(
            path_or_fileobj=str(onnx_path),
            path_in_repo=filename,
            repo_id=repo_id,
            token=HF_TOKEN
        )
        print(f"Upload to {repo_id} successful!")
        return True
    except Exception as e:
        print(f"Upload to {repo_id} failed: {e}")
        return False


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2:
        model_type = sys.argv[1]
        onnx_file = Path(sys.argv[2])
        if not onnx_file.exists():
            print(f"File not found: {onnx_file}")
        elif model_type == "x":
            upload_x(onnx_file)
        elif model_type == "n":
            upload_n(onnx_file)
        else:
            print("Usage: python uploader.py [x|n] <onnx_path>")
    else:
        print("Usage: python uploader.py [x|n] <onnx_path>")
