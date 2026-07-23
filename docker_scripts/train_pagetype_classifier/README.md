# Page-type classifier training

Fine-tunes a light `MobileNetV3-Small` classifier for the page types labelled
by `scripts/pagetype_labelizer`:

- `cover`
- `story_page`
- `annexe`
- `summary`

The training set is read directly from the labelizer dataset. Original CBZ
archives are never read during training: only the extracted page images and
their `labels.json` are used.

## First baseline

From the repository root:

```powershell
python docker_scripts/train_pagetype_classifier/train.py `
  --held-out-volume "One Piece T07" `
  --epochs 25 `
  --batch-size 64
```

The held-out volume is never used for gradient updates. T07 is permanently
reserved as an unseen validation set and must not be used by `train_final.py`.

## Outputs

Each run is written to `runs/<timestamp>/`:

- `best.pt`: selected checkpoint (highest macro F1, then cover F1, on the held-out tome)
- `last.pt`: checkpoint at the final epoch
- `metrics.json`: full validation report and training configuration
- `history.json`: per-epoch losses and metrics
- `page_type_classifier.onnx`: static FP32 ONNX model
- `page_type_classifier.metadata.json`: class order and preprocessing contract

The exported ONNX graph has a single `input` tensor `[1, 3, 224, 224]` and a
`logits` output `[1, 4]`. Preprocessing is RGB, resize to `256`, center crop
to `224`, then ImageNet mean/std normalization. This model remains deliberately
small enough for a later `onnxruntime-web` WebGPU/WASM worker.

## Important interpretation

This baseline has only a few dozen `cover` examples. Read the held-out cover
recall and confusion matrix as an early signal, not a release metric. Keep
labelling diverse tomes, covers, color pages, title spreads and annexes before
freezing a browser threshold.

## Final model after validation

Once a held-out-volume run has selected an epoch count, train the deployment
candidate on every labelled page except the held-out test tome. This deliberately
has no new validation claim: its evidence remains the referenced held-out run.

```powershell
python docker_scripts/train_pagetype_classifier/train_final.py `
  --selection-metrics docker_scripts/train_pagetype_classifier/runs/<validation-run>/metrics.json `
  --epochs <best_epoch>
```
