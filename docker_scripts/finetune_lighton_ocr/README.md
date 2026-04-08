# Fine-tuning LightOnOCR-2-1B pour Projet Poneglyph

Ce répertoire contient les scripts nécessaires pour fine-tuner LightOnOCR-2-1B sur le dataset de manga et l'utiliser avec Modal.

## Prérequis
- Nvidia RTX 5090 ou supérieure (32GB VRAM recommandée)
- Docker avec NVIDIA Container Toolkit

## Configuration
1. Copiez votre fichier `.env` à la racine du projet avec les variables suivantes :
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `HF_TOKEN`
   - `HF_REPO` (ex: `Remidesbois/lighton-ocr-2-1b-poneglyph`)

## Utilisation

### Local (GPU Nvidia avec Docker)
1. Assurez-vous que votre `.env` est à la racine du projet.
2. Lancez `build_image.bat` pour construire l'image Docker.
3. Lancez `run_pipeline.bat` pour démarrer le fine-tuning.

### Distant (RunPod / Cloud GPU)
1. Lancez `build_and_push.bat` pour pousser l'image sur Docker Hub (éditez `DOCKER_USER` dans le fichier .bat au préalable).
2. Déployez un pod utilisant l'image `DOCKER_USER/lighton-ocr-finetune:latest`.
3. Configurez les variables d'environnement : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HF_TOKEN`, `RUNPOD_API_KEY`, `RUNPOD_POD_ID`.

Le pipeline va automatiquement :
1. Exporter les bulles validées depuis Supabase (Téléchargement parallèle optimisé).
2. Fine-tuner le modèle via LoRA (Optimisé pour RTX 5090 / Blackwell).
3. Fusionner les poids en utilisant le meilleur checkpoint (CER minimisé).
4. Pousser les poids fusionnés sur Hugging Face.
5. Auto-terminer le pod si `RUNPOD_API_KEY` est fourni.

## Performances (Dataset Manga)
- **Exact Match (EM)** : ~99.9% (Step 400)
- **CER** : 0.0001 (0.01%)
- **WER** : 0.0002 (0.02%)
- **Distance Levenshtein Moyenne** : < 0.01 chars
- **Inférence** : Optimisée pour Modal (Troncation post-processing activée pour 0% d'hallucination).
