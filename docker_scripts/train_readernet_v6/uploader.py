import os
from pathlib import Path
from huggingface_hub import HfApi, upload_file
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv()

HF_TOKEN = os.getenv("HF_TOKEN")
REPO_ID = "Remidesbois/ReaderNet-V6"


def main():
    if not HF_TOKEN:
        print("Error: HF_TOKEN not set")
        return

    api = HfApi(token=HF_TOKEN)
    api.create_repo(repo_id=REPO_ID, repo_type="model", exist_ok=True)

    onnx_path = SCRIPT_DIR / "dataset" / "readernet_v6.onnx"
    if not onnx_path.exists():
        print("No ONNX file found. Run training + export first.")
        return

    upload_file(
        path_or_fileobj=str(onnx_path),
        path_in_repo="readernet_v6.onnx",
        repo_id=REPO_ID,
        token=HF_TOKEN,
    )
    print(f"Uploaded to https://huggingface.co/{REPO_ID}")

    # Also upload the .pt checkpoint
    pt_path = SCRIPT_DIR / "dataset" / "readernet_v6.pt"
    if pt_path.exists():
        upload_file(
            path_or_fileobj=str(pt_path),
            path_in_repo="readernet_v6.pt",
            repo_id=REPO_ID,
            token=HF_TOKEN,
        )
        print(f"Checkpoint uploaded.")

    # Upload training log
    log_path = SCRIPT_DIR / "dataset" / "training_log.json"
    if log_path.exists():
        upload_file(
            path_or_fileobj=str(log_path),
            path_in_repo="training_log.json",
            repo_id=REPO_ID,
            token=HF_TOKEN,
        )
        print(f"Training log uploaded.")


if __name__ == "__main__":
    main()
