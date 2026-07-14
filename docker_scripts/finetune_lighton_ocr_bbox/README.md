# LightOnOCR-2 BBox — entraînement RTX 5090

Adaptation de LightOnOCR sur des pages manga
Le point de depart est volontairement `lightonai/LightOnOCR-2-1B-bbox-base`.
Le modele publie sert uniquement de reference de benchmark et de quality gate.
complètes. Les images restent plafonnées à **1500 px côté long** : cette
résolution n'est jamais réduite par le profil GPU.

Par défaut, le pipeline reprend le modèle publié
`Remidesbois/LightonOCR-2-1b-poneglyph-bbox` afin de préserver le record OCR
existant. Pour repartir volontairement du modèle brut, définir explicitement
`LIGHTON_MODEL_ID=lightonai/LightOnOCR-2-1B-bbox-base`.

## Profil RTX 5090 par défaut

- BF16, TF32, SDPA et optimizer AdamW fusionné ;
- calibration progressive des batchs `1, 2, 4, 8` sur les pages les plus
  coûteuses ; le batch offrant le meilleur débit est retenu ;
- backward sans gradient checkpointing en priorité, checkpointing uniquement
  si la VRAM l'impose ;
- batch effectif 8, avec accumulation calculée automatiquement. Il reste
  identique à l'ancien entraînement afin de préserver le nombre d'updates et
  la dynamique d'optimisation ;
- pages regroupées par coût image + longueur de réponse afin de réduire le
  padding et les formes très variables au sein d'un batch ;
- quatre workers persistants, mémoire pinnée et préchargement de quatre batchs ;
- logits calculés uniquement sur la tranche utile à la réponse assistant ;
- rsLoRA rang 64, alpha 128, dropout 0, sans `lm_head` ;
- maximum 6 époques, validation bbox batchée une fois par époque, early stopping
  patience 2, puis une époque optionnelle sur les pages difficiles ;
- LR par défaut `1e-5` lors de l'adaptation du modèle publié, pour éviter
  l'oubli catastrophique de la transcription ;
- test final gelé et aucun upload si le candidat régresse.

Le batch retenu dépend réellement du contenu des pages. La calibration arrête
les essais dès que le débit régresse, que le temps prédit devient excessif ou
que la marge VRAM de 10 % serait dépassée. Un batch plus gros mais plus lent
n'est donc pas choisi.

## Lancement Windows

```powershell
cd docker_scripts\finetune_lighton_ocr_bbox
.\build_image.bat
.\run_pipeline.bat
```

Les rapports sont écrits sous `outputs_lighton_bbox/`, notamment
`5090_profile.json`, `training_timing.json`, `benchmark_test.json` et
`quality_gate.json`.

## Variables utiles

- `LIGHTON_BASELINE_BENCHMARK` : JSON du benchmark du modèle publié ;
- `LIGHTON_BASELINE_TRAIN_SECONDS` : durée réelle de l'ancien entraînement ;
- `LIGHTON_CALIBRATE_ONLY=1` : calibration GPU sans entraînement ;
- `LIGHTON_SKIP_UPLOAD=1` : interdit tout upload ;
- `LIGHTON_FORCE_EXPORT=1` : rafraîchit l'export en conservant le split gelé ;
- `LIGHTON_RESET_SPLIT=1` : recrée volontairement le split, à ne pas utiliser
  pour comparer au benchmark public ;
- `LIGHTON_TORCH_COMPILE=1` : essai opt-in seulement ; les formes dynamiques des
  pages peuvent rendre la compilation plus lente que le mode eager.
- `LIGHTON_HARDWARE_PROFILE=h200` : profil H200 avec batchs candidats jusqu'à
  32, validation/génération par 8 et checkpointing désactivé en priorité.

Les benchmarks batchent désormais les pages par coût image + longueur de
réponse estimée. Cela évite qu'une page très longue ralentisse tout un batch,
sans modifier l'ensemble des pages évaluées ni leur ordre dans les métriques.

Pour réutiliser le profil conservateur RTX 3090 :

```dotenv
LIGHTON_HARDWARE_PROFILE=rtx3090
LIGHTON_EFFECTIVE_BATCH=8
LIGHTON_CALIBRATION_REQUIRE_CHECKPOINTING=1
LIGHTON_GENERATION_BATCH=1
LIGHTON_EVAL_BATCH=1
LIGHTON_PROFILE_FILENAME=3090_profile.json
```

## Récupération après interruption du hard-SFT

Si le SFT principal est terminé mais que le replay échoue, la commande SSH
suivante fusionne le meilleur checkpoint principal, exécute le benchmark bbox,
crée le README du modèle et publie le dossier fusionné :

```bash
docker run --rm --gpus all --ipc=host --shm-size=16g --env-file ../../.env \
  -v "$PWD/lighton_bbox_dataset:/app/lighton_bbox_dataset" \
  -v "$PWD/outputs_lighton_bbox:/app/outputs_lighton_bbox" \
  -v "$PWD/logs:/app/logs" \
  lighton-ocr-bbox-finetune python publish_main_sft.py --force
```

`--force` est nécessaire ici car le benchmark relancé seul ne possède pas le
temps historique complet pour le test de vitesse automatique. Le score et le
rapport `quality_gate.json` sont tout de même recalculés avant l'upload.
