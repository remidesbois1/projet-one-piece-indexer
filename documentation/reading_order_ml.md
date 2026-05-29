# Système d'ordre de lecture one-shot

Ce document décrit le remplacement de ReaderNet par un bundle ONNX unique publié sur Hugging Face :

[`Remidesbois/YoloPiece_OneShot_Models`](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models)

Le worker navigateur charge les détecteurs et les rankers depuis ce dépôt. Le chemin one-shot Gemini/Poneglyph garde l'ordre renvoyé par le modèle OCR ; les détections servent uniquement à aligner ou corriger les boîtes.

## Architecture

Le bundle contient quatre artefacts ONNX :

| Fichier | Rôle |
|---|---|
| `bubble_detector.onnx` | Détecte les bulles sur la page. |
| `panel_detector.onnx` | Détecte les cases pour assigner les bulles à un contexte de lecture. |
| `panel_order.onnx` | Classe les cases par paires. |
| `bubble_order.onnx` | Classe les bulles à l'intérieur de chaque case par paires. |

Les deux rankers remplacent ReaderNet. Ils prennent des features géométriques normalisées, évaluent chaque paire `(A, B)`, puis produisent une probabilité que `A` soit lu avant `B`. Le worker agrège ces scores pour obtenir l'ordre final.

## Entraînement

Le pipeline est dans `docker_scripts/train_reading_order/`.

- `train_reading_order.py` entraîne deux rankers `sklearn-logistic`.
- `models/panel_order.onnx` et `models/bubble_order.onnx` sont exportés avec `onnx`.
- L'export est validé avec `onnx.checker` et une comparaison ONNX Runtime contre Python.
- Les rapports sont écrits dans `metrics/reading_order_metrics.json`.

## Métriques test

Dernier run validé :

| Mesure | Valeur |
|---|---:|
| Pages train / test | 63 / 16 |
| Panel pair accuracy | 1.0000 |
| Bubble pair accuracy | 0.9928 |
| Panel exact order | 1.0000 |
| Bubble exact order inside panels | 0.9818 |
| Page full accuracy | 0.9375 (15/16) |

## Packaging Hugging Face

Le package est préparé avec :

```bash
python docker_scripts/package_one_shot_models/prepare_and_upload.py
```

L'upload se fait avec :

```bash
python docker_scripts/package_one_shot_models/prepare_and_upload.py --upload
```

Le script copie les artefacts ONNX, ajoute les métriques, génère `model_manifest.json`, puis publie le dossier sur Hugging Face.
