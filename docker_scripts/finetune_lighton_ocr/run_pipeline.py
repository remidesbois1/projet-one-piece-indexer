import os
import shutil
import subprocess
import sys
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
        print("\n⏳ ERROR: Pipeline failed. Autodestruct in 10 minutes to allow log reading...")
        time.sleep(600)

    print(f"🛑 Terminating Pod ID: {pod_id}")
    url = f"https://api.runpod.io/graphql?api_key={api_key}"
    query = f"mutation {{ podTerminate(input: {{podId: \"{pod_id}\"}}) }}"
    
    try:
        response = requests.post(url, json={"query": query})
        print(f"✅ Termination status: {response.text}")
    except Exception as e:
        print(f"❌ Failed to terminate: {e}")

print("🚀 Starting LightOnOCR-2-1B Fine-Tuning Pipeline...")
login(token=os.environ["HF_TOKEN"])

# 1. Dataset Export
dataset_dir = Path("lighton_dataset")
if dataset_dir.exists() and (dataset_dir / "train" / "metadata.jsonl").exists():
    print("✅ Dataset already exists. Skipping export.")
else:
    print("\n1️⃣  Exporting Dataset from Supabase...")
    result = subprocess.run([sys.executable, "export_dataset.py"], capture_output=False)
    if result.returncode != 0:
        print("❌ Dataset export failed.")
        terminate_runpod(is_error=True)
        sys.exit(1)

# 2. Fine-Tuning
model_out = Path("outputs_lighton_manga/final_lora_merged")
if model_out.exists() and (model_out / "config.json").exists():
    print("✅ Final model already exists. Skipping training.")
else:
    print("\n2️⃣  Starting Fine-Tuning (SFT/LoRA)...")
    result = subprocess.run([sys.executable, "train_lighton_ocr.py"], capture_output=False)
    if result.returncode != 0:
        print("❌ Fine-tuning failed.")
        terminate_runpod(is_error=True)
        sys.exit(1)

# 3. GGUF Export
gguf_file = Path("outputs_lighton_manga/lighton-ocr-2-1b-manga-Q4_K_M.gguf")
if gguf_file.exists():
    print("✅ GGUF file already exists. Skipping export.")
else:
    print("\n3\ufe0f\u20e3  Exporting to GGUF format for llama.cpp/WASM...")
    result = subprocess.run([sys.executable, "export_to_gguf.py"], capture_output=False)
    if result.returncode != 0:
        print("\u26a0\ufe0f GGUF conversion failed. Skipping GGUF, uploading safetensors only.")

# 4. Upload to Hugging Face
print("\n4️⃣  Uploading to Hugging Face...")
repo_id = os.getenv("HF_REPO", "Remidesbois/lighton-ocr-2-1b-manga-gguf")
api = HfApi()

try:
    api.create_repo(repo_id=repo_id, exist_ok=True, private=False)
    print(f"📦 Uploading GGUF models to {repo_id}...")
    
    # Upload everything in outputs_lighton_manga ending with .gguf
    for file in Path("outputs_lighton_manga").glob("*.gguf"):
        print(f"  Uploading {file.name}...")
        api.upload_file(
            path_or_fileobj=str(file),
            path_in_repo=file.name,
            repo_id=repo_id,
            repo_type="model"
        )
    
    # Optional: Upload original weights too if needed
    print(f"📦 Uploading full weights (merged)...")
    api.upload_folder(
        folder_path=str(model_out),
        repo_id=repo_id,
        repo_type="model",
        path_in_repo="weights-merged"
    )

    print("✅ Upload completed.")
except Exception as e:
    print(f"❌ Upload failed: {e}")
    terminate_runpod(is_error=True)
    sys.exit(1)

print("\n🎉 LightOn Pipeline Finished!")
terminate_runpod()
