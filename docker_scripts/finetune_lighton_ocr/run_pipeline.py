import os
import shutil
import subprocess
import sys

# Force unbuffered stdout/stderr for RunPod real-time logs
os.environ["PYTHONUNBUFFERED"] = "1"
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

import requests
from huggingface_hub import HfApi, login
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

REQUIRED_ENV_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HF_TOKEN"]
missing_vars = [var for var in REQUIRED_ENV_VARS if var not in os.environ]

if missing_vars:
    print(f"Error: Missing environment variables: {', '.join(missing_vars)}")
    sys.exit(1)

import time

def terminate_runpod(is_error=False):
    pod_id = os.environ.get("RUNPOD_POD_ID")
    api_key = os.environ.get("RUNPOD_API_KEY")

    if not pod_id:
        print("ℹ️ Not running on RunPod. Skipping termination.")
        return
    
    if not api_key:
        print("⚠️ RUNPOD_API_KEY is missing. Cannot terminate automatically.")
        return

    if is_error:
        print("\n⏳ ERROR: Pipeline failed. Autodestruct in 10 minutes to allow log reading...", flush=True)
        time.sleep(600)

    print(f"🛑 Terminating Pod ID: {pod_id}")
    url = f"https://api.runpod.io/graphql?api_key={api_key}"
    query = f"mutation {{ podTerminate(input: {{podId: \"{pod_id}\"}}) }}"
    
    try:
        response = requests.post(url, json={"query": query})
        print(f"✅ Termination status: {response.text}")
    except Exception as e:
        print(f"❌ Failed to terminate: {e}")

print("🚀 Starting LightOnOCR-2-1B Fine-Tuning Pipeline...", flush=True)
login(token=os.environ["HF_TOKEN"])

def run_step(label, script):
    """Run a sub-script with real-time unbuffered output."""
    print(f"\n{label}", flush=True)
    result = subprocess.run(
        [sys.executable, "-u", script],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    if result.returncode != 0:
        print(f"❌ {script} failed.", flush=True)
        terminate_runpod(is_error=True)
        sys.exit(1)

# 1. Dataset Export
dataset_dir = Path("lighton_dataset")
if dataset_dir.exists() and (dataset_dir / "train" / "metadata.jsonl").exists():
    print("✅ Dataset already exists. Skipping export.", flush=True)
else:
    run_step("1️⃣  Exporting Dataset from Supabase...", "export_dataset.py")

# 2. Fine-Tuning
model_out = Path("outputs_lighton_manga/final_lora_merged")
if model_out.exists() and (model_out / "config.json").exists():
    print("✅ Final model already exists. Skipping training.", flush=True)
else:
    run_step("2️⃣  Starting Fine-Tuning (SFT/LoRA)...", "train_lighton_ocr.py")

# 3. Upload to Hugging Face
print("\n3️⃣  Uploading to Hugging Face...", flush=True)
repo_id = os.getenv("HF_REPO", "Remidesbois/LightonOCR-2-1b-poneglyph")
api = HfApi()

try:
    api.create_repo(repo_id=repo_id, exist_ok=True, private=False)
    print(f"📦 Uploading merged weights to {repo_id} (repo root)...", flush=True)
    api.upload_folder(
        folder_path=str(model_out),
        repo_id=repo_id,
        repo_type="model",
    )
    print("✅ Upload completed.", flush=True)
except Exception as e:
    print(f"❌ Upload failed: {e}", flush=True)
    terminate_runpod(is_error=True)
    sys.exit(1)

print("\n🎉 LightOn Pipeline Finished!", flush=True)
terminate_runpod()
