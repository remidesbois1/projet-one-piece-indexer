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
    """
    Terminates the current RunPod pod using the GraphQL API.
    Requires RUNPOD_POD_ID and RUNPOD_API_KEY environment variables.
    """
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

print("🚀 Starting Automated Fine-Tuning Pipeline...")

login(token=os.environ["HF_TOKEN"])

print("\n1️⃣  Downloading Dataset from Supabase...")
result = subprocess.run([sys.executable, "export_dataset/export_trocr_dataset.py"], capture_output=False)
if result.returncode != 0:
    print("❌ Dataset download failed.")
    terminate_runpod() # Attempt termination even on failure if configured
    sys.exit(1)

source_dataset = Path("export_dataset/trocr_dataset")
target_dataset = Path("trocr_dataset")

if source_dataset.exists():
    if target_dataset.exists():
        shutil.rmtree(target_dataset)
    shutil.move(str(source_dataset), str(target_dataset))
    print(f"✅ Dataset moved to {target_dataset.resolve()}")
else:
    print(f"❌ Dataset not found at {source_dataset}. processing failed.")
    terminate_runpod()
    sys.exit(1)

print("\n2️⃣  Starting Fine-Tuning (25 epochs)...")
final_model_path = Path("outputs_trocr_manga/final_manga_model")
if final_model_path.exists() and (final_model_path / "config.json").exists():
    print("✅ Modèle final déjà existant ! Sauf si vous voulez tout refaire, on passe directement à l'export.")
    print("   (Si vous voulez réentraîner, supprimez le dossier outputs_trocr_manga avant de lancer)")
else:
    result = subprocess.run([sys.executable, "finetunescript.py"], capture_output=False)
    if result.returncode != 0:
        print("❌ Fine-tuning failed.")
        terminate_runpod()
        sys.exit(1)

print("\n3️⃣  Exporting Model to ONNX...")
model_dir = Path("outputs_trocr_manga/final_manga_model")
if not model_dir.exists():
    print(f"❌ Model directory not found: {model_dir}")
    terminate_runpod()
    sys.exit(1)

result = subprocess.run([sys.executable, "export_onnx.py"], capture_output=False)
if result.returncode != 0:
    print("❌ ONNX Export failed.")
    terminate_runpod()
    sys.exit(1)

print("\n4️⃣  Uploading to Hugging Face...")
repo_id = "Remidesbois/trocr-onepiece-fr"
api = HfApi()

try:
    api.create_repo(repo_id=repo_id, exist_ok=True)
except Exception as e:
    print(f"⚠️  Repo creation warning (might exist): {e}")

print(f"Uploading model weights and configs to {repo_id} (root)...")
try:
    api.upload_folder(
        folder_path=str(model_dir),
        repo_id=repo_id,
        repo_type="model",
        ignore_patterns=["*.onnx", "*optimizer.pt", "scheduler.pt", "rng_state.pth"] 
    )
    print("✅ Root files uploaded.")
except Exception as e:
    print(f"❌ Failed to upload root files: {e}")
    terminate_runpod()
    sys.exit(1)

onnx_dir = Path("onnx_export/onnx")
if onnx_dir.exists():
    print(f"Uploading ONNX files to {repo_id}/onnx...")
    try:
        api.upload_folder(
            folder_path=str(onnx_dir),
            path_in_repo="onnx",
            repo_id=repo_id,
            repo_type="model"
        )
        print("✅ ONNX files uploaded.")
    except Exception as e:
        print(f"❌ Failed to upload ONNX files: {e}")
        terminate_runpod()
        sys.exit(1)
else:
    print(f"❌ ONNX directory not found: {onnx_dir}")
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

# Terminate Pod at the very end
terminate_runpod()
