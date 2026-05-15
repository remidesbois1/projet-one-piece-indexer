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
1. Exporter les bulles validées depuis Supabase avec split strict par page (`train`/`val`/`test`).
2. Fine-tuner le modèle via LoRA/DoRA r=65 en BF16, optimisé pour RTX 5090 / Blackwell.
3. Évaluer en génération réelle prompt-only, sans injecter la réponse attendue dans le contexte.
4. Fusionner les poids en utilisant le meilleur checkpoint selon le CER de validation propre.
5. Lancer un benchmark final sur le test set tenu à l'écart et sauvegarder `benchmark_test.json`.
6. Pousser les poids fusionnés sur Hugging Face.
7. Auto-terminer le pod si `RUNPOD_API_KEY` est fourni.

## Réglages utiles
- `LIGHTON_EPOCHS` : défaut `8`
- `LIGHTON_TRAIN_BATCH` / `LIGHTON_EVAL_BATCH` : défaut `8` / `8`
- `LIGHTON_GRAD_ACCUM` : défaut `2`
- `LIGHTON_LR` : défaut `5e-5`
- `LIGHTON_GEN_EVAL_MAX_SAMPLES` : défaut `256` échantillons de validation générés à chaque évaluation
- `LIGHTON_FINAL_TEST_MAX_SAMPLES` : défaut `0` = tout le test set
- `LIGHTON_FORCE_EXPORT=1` ou `LIGHTON_FORCE_TRAIN=1` pour forcer une étape

## Métriques
Les scores fiables sont ceux de `outputs_lighton_manga/final_lora_merged/benchmark_test.json`.
Ils sont calculés sur le test set page-level, en génération depuis l'image seule, avec post-processing identique à l'inférence.
