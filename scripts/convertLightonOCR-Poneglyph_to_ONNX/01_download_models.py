# 01_download_models.py
import os
import shutil
from huggingface_hub import snapshot_download

def main():
    print("Initialisation du pipeline d'acquisition des actifs multimodaux...")
    
    # Définition stricte des identifiants de dépôts cibles
    onnx_repo_id = "onnx-community/LightOnOCR-2-1B-ONNX"
    poneglyph_repo_id = "Remidesbois/LightonOCR-2-1b-poneglyph"
    
    # Configuration des espaces de travail locaux isolés
    local_onnx_dir = "./staging/onnx_base"
    local_poneglyph_dir = "./staging/poneglyph_weights"
    
    os.makedirs(local_onnx_dir, exist_ok=True)
    os.makedirs(local_poneglyph_dir, exist_ok=True)
    
    # 1. Extraction de la topologie ONNX de référence
    # Nous filtrons spécifiquement pour exclure les versions pré-quantifiées q4/q8
    print(f"Extraction des topologies structurelles ONNX depuis {onnx_repo_id}...")
    onnx_path = snapshot_download(
        repo_id=onnx_repo_id,
        allow_patterns=["onnx/*.onnx", "onnx/*.onnx_data*", "config.json", "generation_config.json", "preprocessor_config.json"],
        ignore_patterns=["*q4*", "*q8*"], # Exclusion proactive des formats non-FP16
        local_dir=local_onnx_dir,
        local_dir_use_symlinks=False # Obligatoire pour autoriser la mutation binaire ultérieure
    )
    print(f"Architecture ONNX validée et mise en file d'attente à l'emplacement : {onnx_path}")
    
    # 2. Extraction des tenseurs de poids affinés au format Safetensors
    print(f"Extraction des matrices de poids Poneglyph depuis {poneglyph_repo_id}...")
    poneglyph_path = snapshot_download(
        repo_id=poneglyph_repo_id,
        allow_patterns=["*.safetensors", "config.json"],
        local_dir=local_poneglyph_dir,
        local_dir_use_symlinks=False
    )
    print(f"Poids Safetensors acquis et validés à l'emplacement : {poneglyph_path}")
    print("Phase 1 achevée avec succès. Prêt pour l'ingénierie d'injection.")

if __name__ == "__main__":
    main()