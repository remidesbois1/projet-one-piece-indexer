# 03_upload_hf.py
import os
import sys
from huggingface_hub import HfApi

def main():
    print("Initialisation du gestionnaire de transactions de l'état distant...")
    
    # Paramètres de ciblage de l'infrastructure
    repo_cible_id = "Remidesbois/LightonOCR-2-1b-poneglyph-ONNX"
    chemin_local_upload = "./fp16_poneglyph"
    
    # L'instanciation de HfApi résout automatiquement l'authentification 
    # via les variables d'environnement système ou le cache local
    try:
        api = HfApi()
        utilisateur = api.whoami()
        print(f"Authentification validée pour l'utilisateur : {utilisateur.get('name', 'Inconnu')}")
    except Exception as e:
        print(" L'authentification a échoué. Assurez-vous que HF_TOKEN est défini.")
        sys.exit(1)
    
    # Audit pré-vol du répertoire source
    if not os.path.exists(chemin_local_upload):
        raise FileNotFoundError(f"Répertoire source introuvable : {chemin_local_upload}. La Phase 2 a-t-elle échoué?")
        
    print(f"Préparation de la propagation vers le dépôt : {repo_cible_id}")
    print(f"Montage des actifs depuis : {chemin_local_upload}")
    print("DÉCLENCHEMENT DE LA TRANSACTION ATOMIQUE : Effacement total et remplacement global.")
    print("Veuillez patienter, la synchronisation LFS peut requérir un temps substantiel...")
    
    try:
        # Exécution du commit combiné
        # L'utilisation de delete_patterns="*" force l'assainissement total du répertoire
        # distant avant le rattachement des nouveaux pointeurs LFS, répondant
        # exactement à la demande de "supprime le contenu du repo".
        info_transaction = api.upload_folder(
            folder_path=chemin_local_upload,
            repo_id=repo_cible_id,
            repo_type="model",
            commit_message="Remplacement radical : Injection des poids Poneglyph en format strict FP16 optimisé pour l'exécution WebGPU (Transformers.js v4).",
            delete_patterns="*" # La clause destructrice de nettoyage
        )
        
        print("\n🎉 Transaction achevée et scellée avec succès sur les serveurs Hugging Face!")
        print(f"Empreinte cryptographique du Commit (OID) : {info_transaction.oid}")
        print(f"Lien de traçabilité : {info_transaction.commit_url}")
        print("\nLe modèle Poneglyph est désormais structurellement paré pour une inférence locale "
              "sans friction via WebGPU sur architecture Ampere.")
        
    except Exception as e:
        print(f"\n❌ Échec de la synchronisation lors du push : {str(e)}")
        print("Vérifiez les permissions d'écriture (Write) associées à votre jeton d'accès.")

if __name__ == "__main__":
    main()