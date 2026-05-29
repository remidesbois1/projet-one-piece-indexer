# Reading Order Training

This pipeline trains two geometry-based pairwise rankers from the panel annotation
dataset:

- `panel_order`: orders panels on a page.
- `bubble_order`: orders bubbles inside one panel.

The final evaluation runs the complete ordering pipeline on held-out test pages:
sort panels, sort bubbles within each predicted panel order, concatenate the
bubbles, and compare the full page sequence against the ground-truth bubble
order. The primary metric is `page_full_accuracy`.

## Run

```powershell
pip install -r requirements.txt
python train_reading_order.py
```

By default, the script reads:

- annotations from
  `../train_panel_detector/panel_annotation_dataset/panel_annotations.json`
- the train/test page split from `../train_panel_detector/dataset/manifest.json`

Using the existing manifest keeps the reading-order test pages aligned with the
panel detector holdout split. If the manifest is missing, the script creates a
deterministic page split with `--test-size` and `--seed`.

## Outputs

```text
models/
  panel_order_model.json
  panel_order_model.joblib
  bubble_order_model.json
  bubble_order_model.joblib
metrics/
  reading_order_metrics.json
predictions/
  test_page_orders.json
```

`reading_order_metrics.json` includes train/test page ids, pairwise model
accuracies, panel exact-order accuracy, bubble-within-panel exact-order
accuracy, and the final page-level full accuracy.

The pipeline can also select a conservative vertical-separation override for the
bubble ranker. That selection is made only on training pages and is recorded in
`metrics/reading_order_metrics.json`.

The default ranker is `sklearn-logistic`. For a dependency-free fallback:

```powershell
python train_reading_order.py --ranker pure-logistic
```

Non-linear rankers are available for experiments:

```powershell
python train_reading_order.py --ranker extra-trees --heuristic-weights 0
python train_reading_order.py --ranker hist-gradient-boosting --heuristic-weights 0
```
