import os
import sys
from pathlib import Path
from huggingface_hub import HfApi, login
from dotenv import load_dotenv

FINETUNE_DIR = Path(__file__).resolve().parent.parent
TEST_DIR = Path(__file__).resolve().parent
load_dotenv(FINETUNE_DIR / ".env")

HF_TOKEN = os.getenv("HF_TOKEN")
REPO_ID = os.getenv("HF_REPO", "Remidesbois/LightonOCR-2-1b-poneglyph-bbox")

if not HF_TOKEN:
    print("HF_TOKEN not found in .env")
    sys.exit(1)

login(token=HF_TOKEN)
api = HfApi()

print(f"Uploading to {REPO_ID}...")

readme_path = TEST_DIR / "README.md"
if readme_path.exists():
    api.upload_file(
        path_or_fileobj=str(readme_path),
        path_in_repo="README.md",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print("  README.md uploaded.")

graphs_dir = TEST_DIR / "output" / "graphs"
if graphs_dir.exists():
    api.upload_folder(
        folder_path=str(graphs_dir),
        path_in_repo="test/output/graphs",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print(f"  Graphs uploaded ({len(list(graphs_dir.glob('*.png')))} files).")

samples_dir = TEST_DIR / "output" / "samples"
if samples_dir.exists():
    api.upload_folder(
        folder_path=str(samples_dir),
        path_in_repo="test/output/samples",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print(f"  Samples uploaded ({len(list(samples_dir.glob('*.png')))} files).")

metrics_path = TEST_DIR / "output" / "metrics.json"
if metrics_path.exists():
    api.upload_file(
        path_or_fileobj=str(metrics_path),
        path_in_repo="test/output/metrics.json",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print("  metrics.json uploaded.")

print(f"\nAll done! Check it out: https://huggingface.co/{REPO_ID}")
