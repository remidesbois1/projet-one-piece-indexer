# Fine-tuning LightOnOCR-2-1B pour Projet Poneglyph

Ce répertoire contient les scripts nécessaires pour fine-tuner LightOnOCR-2-1B sur le dataset de manga et l'utiliser avec Modal.

## Prérequis
- Nvidia RTX 3090 (24GB VRAM) ou supérieure
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
2. Calibrer le plus grand batch BF16 qui tient sur 24 Go, sans gradient checkpointing si possible.
3. Fine-tuner via rsLoRA r=64 à 700 px maximum, puis faire une courte passe sur les erreurs difficiles si elle améliore la validation.
4. Évaluer en génération réelle prompt-only et batchée, sans injecter la réponse attendue.
5. Fusionner le meilleur checkpoint et lancer le benchmark final sur le test public figé.
6. Publier uniquement si le gate statistique de qualité et le gate de vitesse configuré passent.
7. Auto-terminer le pod si `RUNPOD_API_KEY` est fourni.

## Réglages utiles
- `LIGHTON_EPOCHS` : défaut `6`, early stopping de patience `2`
- `LIGHTON_AUTO_BATCH=1` : essaie `32,24,16,12,8,4`, puis le checkpointing en dernier recours
- `LIGHTON_EFFECTIVE_BATCH` : défaut `32`; l'accumulation est calculée automatiquement
- `LIGHTON_IMAGE_LONGEST_EDGE` : défaut `700` (`--profile-resolutions` compare `512/700/896`)
- `LIGHTON_HARD_EXAMPLE_SFT=1` : replay 70 % erreurs / 30 % exemples propres
- `LIGHTON_BASELINE_BENCHMARK` : chemin ou URL du benchmark de référence
- `LIGHTON_BASELINE_TRAIN_SECONDS` : durée historique 3090 pour imposer le gate de vitesse
- `LIGHTON_LR` : défaut `5e-5`
- `LIGHTON_GEN_EVAL_MAX_SAMPLES` : défaut `256` échantillons de validation générés à chaque évaluation
- `LIGHTON_FINAL_TEST_MAX_SAMPLES` : défaut `0` = tout le test set
- `LIGHTON_FORCE_EXPORT=1` ou `LIGHTON_FORCE_TRAIN=1` pour forcer une étape

## Métriques
Les scores fiables sont ceux de `outputs_lighton_manga/final_lora_merged/benchmark_test.json`.
Ils sont calculés sur le test set page-level, en génération depuis l'image seule, avec post-processing identique à l'inférence.
Le fichier contient aussi le CER strict, les slices, la comparaison appariée et le bootstrap par page.

Le pipeline entraîne d'abord dans `candidate_lora_merged` et ne remplace `final_lora_merged` que si `quality_gate.json` contient `release_ready: true`; l'ancienne release est alors archivée dans `previous_lora_merged`. Le gate de vitesse exige soit `LIGHTON_BASELINE_TRAIN_SECONDS`, soit le rapport produit par `profile_3090.py`. Un échec conserve le candidat, les checkpoints et les rapports sans uploader. Les mesures GPU et les temps SFT, post-SFT et benchmark séparés sont écrits dans `3090_profile.json`.

## Validation

```powershell
python -m unittest discover -s docker_scripts/finetune_lighton_ocr -p 'test_*.py' -v
python docker_scripts/finetune_lighton_ocr/smoke_check.py
$env:LIGHTON_SMOKE_LOAD_MODEL='1'; $env:LIGHTON_SMOKE_TRAIN_STEP='1'; python docker_scripts/finetune_lighton_ocr/smoke_check.py
python docker_scripts/finetune_lighton_ocr/profile_3090.py  # ancien/nouveau, 200 steps chacun
```

Pour une première exécution avec gate de vitesse : exporter d'abord le dataset (`python export_dataset.py`), lancer `profile_3090.py`, puis lancer `run_pipeline.py`. Si une durée historique fiable est déjà connue, définir `LIGHTON_BASELINE_TRAIN_SECONDS` permet de sauter le profil comparatif.
