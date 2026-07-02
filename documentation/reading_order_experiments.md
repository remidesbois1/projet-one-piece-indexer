# Reading order experiments

Generated: 2026-07-02T21:56:08.956143+00:00

## Current pipeline

The reference experiment is `current_panel_then_in_panel_ranker`: panel ranking,
worker-equivalent Borda pair aggregation, ground-truth panel membership, then
in-panel bubble ranking. `current_worker_assignment_gt_boxes` uses the same
ground-truth boxes but runs the browser assignment strategy before in-panel
ranking, which isolates assignment mistakes from detector mistakes.

## Protocol

- Split source: `C:\Users\remis\Documents\Projet Git\projet-one-piece-indexer\docker_scripts\train_panel_detector\dataset\manifest.json`
- Development pages: 126
- Train pages: 101
- Validation pages: 25
- Test pages: 31
- Candidate selection uses validation metrics only. The test split is reported
  as a holdout and is not used for hyperparameter choice. Train metrics are
  used only as a tie-breaker when validation metrics are identical.
- Real YOLO detector simulation: not_available

## Experiments

| Experiment | Runtime | Test full | Pairwise | Position | Exact |
|---|---:|---:|---:|---:|---:|
| global_bubble_reranker_v1__sklearn-logistic__borda-vertical-repair | yes | 0.9677 | 0.9993 | 0.9932 | 30/31 |
| global_bubble_reranker_v1__pure-logistic__borda-vertical-repair | yes | 0.9677 | 0.9993 | 0.9932 | 30/31 |
| assignment_aware_global_reranker__sklearn-logistic__borda-vertical-repair | yes | 0.9355 | 0.9986 | 0.9863 | 29/31 |
| assignment_aware_global_reranker__hist-gradient-boosting__borda-vertical-repair | no | 0.9355 | 0.9986 | 0.9863 | 29/31 |
| global_bubble_reranker_v1__sklearn-logistic__borda | yes | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| global_bubble_reranker_v1__sklearn-logistic__topological | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| global_bubble_reranker_v1__sklearn-logistic__stable-local | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| assignment_aware_global_reranker__sklearn-logistic__topological | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| assignment_aware_global_reranker__sklearn-logistic__stable-local | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| global_bubble_reranker_v1__pure-logistic__borda | yes | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| global_bubble_reranker_v1__pure-logistic__bradley-terry | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| global_bubble_reranker_v1__pure-logistic__topological | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| assignment_aware_global_reranker__pure-logistic__borda-vertical-repair | yes | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| global_bubble_reranker_v1__hist-gradient-boosting__borda-vertical-repair | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| assignment_aware_global_reranker__hist-gradient-boosting__borda | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| assignment_aware_global_reranker__hist-gradient-boosting__bradley-terry | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| assignment_aware_global_reranker__hist-gradient-boosting__topological | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| assignment_aware_global_reranker__hist-gradient-boosting__stable-local | no | 0.9032 | 0.9979 | 0.9795 | 28/31 |
| current_panel_then_in_panel_ranker | yes | 0.8710 | 0.9971 | 0.9726 | 27/31 |
| current_worker_assignment_gt_boxes | yes | 0.8710 | 0.9971 | 0.9726 | 27/31 |

## Selection

- Selected by validation: `global_bubble_reranker_v1__sklearn-logistic__stable-local`
- Selected runtime candidate: `global_bubble_reranker_v1__sklearn-logistic__borda-vertical-repair`
- Runtime decision: enabled_by_metrics
- Reason: Selected runtime-compatible candidate beat the current baseline.

## Selected model metrics

| Split | Full | Pairwise | Position | Exact | Inversions |
|---|---:|---:|---:|---:|---:|
| train | 0.8812 | 0.9972 | 0.9736 | 89/101 | 13 |
| validation | 0.9600 | 0.9985 | 0.9844 | 24/25 | 2 |
| test | 0.9677 | 0.9993 | 0.9932 | 30/31 | 1 |


## Baseline comparison

- Baseline: `current_panel_then_in_panel_ranker`
- Candidate: `global_bubble_reranker_v1__sklearn-logistic__borda-vertical-repair`
- Compared split: test (31 pages)
- Delta page_full_accuracy: +0.0968
- Delta page_exact_matches: +3
- Delta global_pairwise_accuracy: +0.0021
- Delta bubble_position_accuracy: +0.0205
- Delta inversion_count_total: -3
- Corrected pages: 381, 459, 496
- Regressed pages: none
- Still wrong pages: 356
- Changed but still wrong pages: none

### Corrected pages

- page 381: inversions 1 -> 0, assignment errors 0 -> 0, outside-panel bubbles 0 -> 0
- page 459: inversions 1 -> 0, assignment errors 0 -> 0, outside-panel bubbles 0 -> 0
- page 496: inversions 1 -> 0, assignment errors 0 -> 0, outside-panel bubbles 0 -> 0

### Regressed pages

- none

### Remaining wrong pages

- page 356: inversions 1 -> 1, assignment errors 0 -> 2, outside-panel bubbles 0 -> 0


## Artifacts

- Metrics: `docker_scripts/train_reading_order/metrics/reading_order_benchmark.json`
- Predictions: `docker_scripts/train_reading_order/predictions/benchmark_page_orders.json`
- Optional ONNX: `docker_scripts/train_reading_order/models/global_bubble_order.onnx`

## Reproduction

```powershell
python docker_scripts/train_reading_order/train_reading_order.py
python docker_scripts/train_reading_order/benchmark_reading_order.py
python docker_scripts/package_one_shot_models/prepare_and_upload.py
cd frontend
npm run lint
npm run build
```
