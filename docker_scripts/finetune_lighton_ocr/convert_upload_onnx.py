import os
import sys

# --- MONKEY PATCH OPTIMUM IMPORT ERROR ---
try:
    import transformers.models.clip.modeling_clip as clip_models
    if not hasattr(clip_models, 'CLIPSdpaAttention'):
        clip_models.CLIPSdpaAttention = type('CLIPSdpaAttention', (), {})
except Exception:
    pass
# -----------------------------------------

from huggingface_hub import snapshot_download, HfApi
from optimum.commands.optimum_cli import main as optimum_main
from dotenv import load_dotenv

def main():
    load_dotenv(".env")
    token = os.getenv("HF_TOKEN")
    if not token:
        print("Erreur: HF_TOKEN manquant dans .env")
        return

    model_id = "Remidesbois/LightonOCR-2-1b-poneglyph"
    local_dir = "downloaded_model"
    onnx_dir = "onnx_output"

    print(f"Telechargement de {model_id}...")
    try:
        snapshot_download(repo_id=model_id, local_dir=local_dir, token=token)
    except Exception as e:
        print(f"Erreur lors du telechargement : {e}")
        return

    print("Conversion en ONNX via optimum...")
    # Setup sys.argv to simulate CLI command
    sys.argv = [
        "optimum-cli", "export", "onnx",
        "--model", local_dir,
        "--task", "image-to-text",
        "--trust-remote-code",
        onnx_dir
    ]
    
    try:
        optimum_main()
    except SystemExit as e:
        if e.code != 0:
            print(f"ALERTE : La conversion a echoue (code: {e.code}).")
            return
    except Exception as e:
        print(f"ERREUR CRITIQUE lors de la conversion : {e}")
        return

    print("Upload vers Hugging Face (dossier /onnx)...")
    try:
        api = HfApi(token=token)
        api.upload_folder(
            folder_path=onnx_dir,
            repo_id=model_id,
            repo_type="model",
            path_in_repo="onnx"
        )
        print("ONNX uploade avec succes ! Ton site web l'utilisera desormais nativement sur les GPUs des utilisateurs.")
    except Exception as e:
        print(f"Erreur lors de l'upload : {e}")

if __name__ == "__main__":
    main()
