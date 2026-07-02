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

To retrain only the panel-order model and leave `bubble_order` unchanged:

```powershell
python train_reading_order.py --panel-only
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
  panel_order_metrics.json      # when --panel-only is used
predictions/
  test_page_orders.json
  panel_test_orders.json        # when --panel-only is used
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

## Benchmark candidates

Run the reproducible page-level benchmark after the panel annotations and split
manifest are available:

```powershell
python benchmark_reading_order.py
```

The benchmark writes:

```text
metrics/
  reading_order_benchmark.json
predictions/
  benchmark_page_orders.json
../../documentation/
  reading_order_experiments.md
```

It compares the official `current_panel_then_in_panel_ranker` baseline,
`current_worker_assignment_gt_boxes`, global page-level rerankers,
assignment-aware rerankers, and panel-less rerankers. Candidate rankers are
selected on validation metrics; the test split remains a holdout. A
`global_bubble_order.onnx` export is written only when a runtime-compatible
candidate beats the current baseline without regressing pairwise or position
accuracy.

To replay a fuller worker path from detector outputs, pass:

```powershell
python export_detection_replay_predictions.py --split test
python benchmark_reading_order.py --detection-predictions path\to\detections.json
```

By default, `export_detection_replay_predictions.py` reads the panel annotation
image set, uses local detector artifacts when present, and falls back to the
published Hugging Face detector files. Its default output is:

```text
predictions/
  detector_replay_predictions.json
```

Accepted detector JSON shape:

```json
{
  "pages": [
    {
      "page_id": 123,
      "bubbles": [{"bbox": {"x": 10, "y": 20, "w": 80, "h": 40}, "conf": 0.91}],
      "panels": [{"bbox": {"x": 0, "y": 0, "w": 400, "h": 300}, "conf": 0.88}]
    }
  ]
}
```

The replay experiment is named `current_detector_replay_pipeline`. Detected
boxes are matched back to ground-truth IDs by IoU for scoring; unmatched or
missing boxes remain visible in page-level errors.
