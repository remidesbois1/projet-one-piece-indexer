import os
from pathlib import Path
from huggingface_hub import HfApi
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv()

HF_TOKEN = os.getenv("HF_TOKEN")
REPO_ID = "Remidesbois/ReaderNet-V5"

if not HF_TOKEN:
    env_path = SCRIPT_DIR.parent.parent / "backend" / ".env"
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
            path_in_repo="readernet_v5.onnx",
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
        upload(Path(sys.argv[1]))
    else:
        default = SCRIPT_DIR / "dataset" / "readernet_v5.onnx"
        if default.exists():
            upload(default)
        else:
            print(f"File not found: {default}")
