import os
import shutil
import subprocess
import sys
import requests
from huggingface_hub import HfApi, login
from pathlib import Path

REQUIRED_ENV_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HF_TOKEN"]
missing_vars = [var for var in REQUIRED_ENV_VARS if var not in os.environ]

if missing_vars:
    print(f"Error: Missing environment variables: {', '.join(missing_vars)}")
    sys.exit(1)

def terminate_runpod():
    pod_id = os.environ.get("RUNPOD_POD_ID")
    api_key = os.environ.get("RUNPOD_API_KEY")

    if not pod_id:
        print("ℹ️ Not running on RunPod (RUNPOD_POD_ID not found). Skipping termination.")
        return
    
    if not api_key:
        print("⚠️ Running on RunPod but RUNPOD_API_KEY is missing. Cannot terminate pod automatically.")
        return

    print(f"🛑 Initiating termination for Pod ID: {pod_id}")
    
    url = f"https://api.runpod.io/graphql?api_key={api_key}"
    query = f"""
    mutation {{
        podTerminate(input: {{podId: "{pod_id}"}})
    }}
    """
    
    try:
        response = requests.post(url, json={"query": query})
        response.raise_for_status()
        print(f"✅ Termination request sent. Response: {response.text}")
    except Exception as e:
        print(f"❌ Failed to terminate pod: {e}")

print("🚀 Starting Automated FireRed-OCR Fine-Tuning Pipeline...")
login(token=os.environ["HF_TOKEN"])

print("\n1️⃣  Downloading Dataset from Supabase...")
result = subprocess.run([sys.executable, "export_dataset.py"], capture_output=False)
if result.returncode != 0:
    print("❌ Dataset download failed.")
    terminate_runpod() 
    sys.exit(1)

dataset_dir = Path("firered_dataset")
if dataset_dir.exists():
    print(f"✅ Dataset found at {dataset_dir.resolve()}")
else:
    print(f"❌ Dataset not found at {dataset_dir}. Processing failed.")
    terminate_runpod()
    sys.exit(1)


print("\n2️⃣  Starting Fine-Tuning...")
final_model_path = Path("outputs_firered_manga/final_manga_model")
if final_model_path.exists() and (final_model_path / "config.json").exists():
    print("✅ Modèle final déjà existant ! Sauf si vous voulez tout refaire, on passe directement à l'export.")
    print("   (Si vous voulez réentraîner, supprimez le dossier outputs_firered_manga avant de lancer)")
else:
    result = subprocess.run([sys.executable, "train_firered_ocr.py"], capture_output=False)
    if result.returncode != 0:
        print("❌ Fine-tuning failed.")
        terminate_runpod()
        sys.exit(1)


print("\n3️⃣  Uploading to Hugging Face...")
repo_id = "Remidesbois/firered-ocr-onepiece"
api = HfApi()
try:
    api.create_repo(repo_id=repo_id, exist_ok=True, private=False)
except Exception as e:
    print(f"⚠️  Repo creation warning (might exist): {e}")

print(f"Uploading model weights and configs to {repo_id} (root)...")
model_dir = Path("outputs_firered_manga/final_manga_model")

try:
    api.upload_folder(
        folder_path=str(model_dir),
        repo_id=repo_id,
        repo_type="model",
        ignore_patterns=["*optimizer.pt", "scheduler.pt", "rng_state.pth", "*.bin"]
    )
    print("✅ Root files uploaded.")
except Exception as e:
    print(f"❌ Failed to upload root files: {e}")
    terminate_runpod()
    sys.exit(1)


logs_dir = Path("logs")
if logs_dir.exists():
    print(f"Uploading Logs to {repo_id}/logs...")
    try:
        api.upload_folder(
            folder_path=str(logs_dir),
            path_in_repo="logs",
            repo_id=repo_id,
            repo_type="model"
        )
        print("✅ Logs uploaded.")
    except Exception as e:
        print(f"❌ Failed to upload logs: {e}")
else:
    print(f"⚠️ Logs directory not found: {logs_dir}")

print("\n🎉 Pipeline Completed Successfully!")
terminate_runpod()
