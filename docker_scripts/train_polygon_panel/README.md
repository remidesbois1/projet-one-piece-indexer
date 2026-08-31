# YOLO11 segmentation — Panel Poneglyph — RTX 5090 / RunPod

Cette image entraîne le détecteur de cases polygonales à partir du dataset
exporté par `scripts/polygon_case_annotator`. Le dataset est copié dans
l’image Docker au build, donc le pod RunPod n’a pas besoin de Supabase/R2 pour
l’entraînement.

## Construire et pousser l’image

Depuis Windows, après avoir exporté le dataset polygonal :

```powershell
docker_scripts\train_polygon_panel\build_and_push.bat
```

L’image produite est :

```text
docker.io/remidesbois/yolo11-seg-panel-poneglyph:latest
```

## RunPod

Créer un pod avec cette image et une RTX 5090. Variables recommandées :

```text
HF_TOKEN=...
HF_REPO=Remidesbois/Yolo11-seg-Panel-Poneglyph
TRAINING_PROVIDER=runpod
RUNPOD_API_KEY=...
RUNPOD_POD_ID=...
RUNPOD_TERMINATE_ON_EXIT=1
POLYGON_EPOCHS=100
POLYGON_IMGSZ=1504
POLYGON_BATCH=-1
POLYGON_WORKERS=12
POLYGON_DEVICE=0
POLYGON_CACHE_RAM=1
```

`HF_TOKEN` est utilisé uniquement comme variable d’environnement RunPod et
n’est jamais inclus dans l’image. Le pipeline publie automatiquement le
contenu de `hf_release/` dans
[`Remidesbois/Yolo11-seg-Panel-Poneglyph`](https://huggingface.co/Remidesbois/Yolo11-seg-Panel-Poneglyph).

## Contenu publié

Le dépôt contient :

- `weights/best.pt` et `weights/last.pt` ;
- `panel_detector.onnx` ;
- le dossier complet `runs/` produit par Ultralytics : `results.csv`, courbes,
  matrices de confusion, images de validation, prédictions JSON, paramètres,
  poids et artefacts d’évaluation ;
- `metrics_report.json` avec métriques train/validation, métriques par classe,
  vitesse, environnement CUDA/GPU et inventaire des fichiers ;
- `metrics_report.md` et `README.md` lisibles directement sur Hugging Face ;
- `pipeline_summary.json` dans le dossier de sortie RunPod.

## Test sans entraînement ni publication

```powershell
docker run --rm remidesbois/yolo11-seg-panel-poneglyph:latest python -u run_pipeline.py --dry-run
```

Pour faire un entraînement local sans publication, ajouter
`POLYGON_SKIP_UPLOAD=1`.
