import os
import sys
from pathlib import Path
from huggingface_hub import HfApi, login
from dotenv import load_dotenv

FINETUNE_DIR = Path(__file__).resolve().parent.parent
TEST_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = TEST_DIR / "output"
load_dotenv(FINETUNE_DIR / ".env")

HF_TOKEN = os.getenv("HF_TOKEN")
REPO_ID = os.getenv("HF_REPO", "Remidesbois/LightonOCR-2-1b-poneglyph-bbox")

if not HF_TOKEN:
    print("HF_TOKEN not found in .env")
    sys.exit(1)

login(token=HF_TOKEN)
api = HfApi()

print(f"Uploading to {REPO_ID}...")

metrics_lighton = OUTPUT_DIR / "metrics.json"
if metrics_lighton.exists():
    api.upload_file(
        path_or_fileobj=str(metrics_lighton),
        path_in_repo="test/output/metrics.json",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print("  metrics.json (LightOn) uploaded.")

metrics_gemma = OUTPUT_DIR / "metrics_gemma.json"
if metrics_gemma.exists():
    api.upload_file(
        path_or_fileobj=str(metrics_gemma),
        path_in_repo="test/output/metrics_gemma.json",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print("  metrics_gemma.json uploaded.")

metrics_comparison = OUTPUT_DIR / "metrics_comparison.json"
if metrics_comparison.exists():
    api.upload_file(
        path_or_fileobj=str(metrics_comparison),
        path_in_repo="test/output/metrics_comparison.json",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print("  metrics_comparison.json uploaded.")

graphs_dir = OUTPUT_DIR / "graphs"
if graphs_dir.exists():
    api.upload_folder(
        folder_path=str(graphs_dir),
        path_in_repo="test/output/graphs",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print(f"  Graphs uploaded ({len(list(graphs_dir.glob('*.png')))} files).")

samples_dir = OUTPUT_DIR / "samples"
if samples_dir.exists():
    api.upload_folder(
        folder_path=str(samples_dir),
        path_in_repo="test/output/samples",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print(f"  Samples uploaded ({len(list(samples_dir.glob('*.png')))} files).")

readme_path = TEST_DIR / "README.md"
if readme_path.exists():
    api.upload_file(
        path_or_fileobj=str(readme_path),
        path_in_repo="README.md",
        repo_id=REPO_ID,
        repo_type="model",
    )
    print("  README.md uploaded.")

print(f"\nAll done! Check it out: https://huggingface.co/{REPO_ID}")
