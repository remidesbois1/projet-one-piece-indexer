#!/usr/bin/env python3
"""Build and validate the Hugging Face Poneglyph ReaderNet package."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(__file__).resolve().parent / "hf_package"
PANEL_RANKER = ROOT / "scripts/polygon_case_annotator/panel_order/polygon_panel_order.onnx"
BUBBLE_RANKER = ROOT / "scripts/polygon_case_annotator/bubble_order/bubble_order.onnx"
BUBBLE_DETECTOR = ROOT / "docker_scripts/package_one_shot_models/hf_package/bubble_detector.onnx"
PANEL_DETECTOR = ROOT / "scripts/Yolo11-seg-Panel-Poneglyph/panel_detector.onnx"

METRICS = {
    "metrics/panel_order_metrics.json": ROOT / "scripts/polygon_case_annotator/panel_order/metrics.json",
    "metrics/bubble_order_metrics.json": ROOT / "scripts/polygon_case_annotator/bubble_order/metrics.json",
    "metrics/shared_detector_comparison.json": ROOT / "scripts/polygon_case_annotator/bubble_order/hf_pipeline_comparison.json",
    "metrics/end_to_end_metrics.json": ROOT / "scripts/polygon_case_annotator/bubble_order/end_to_end_metrics.json",
    "metrics/box_polygon_runtime_metrics.json": ROOT / "scripts/polygon_case_annotator/bubble_order/box_polygon_runtime_metrics.json",
    "metrics/panel_detector_metrics.json": ROOT / "scripts/Yolo11-seg-Panel-Poneglyph/metrics_report.json",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tensor_shape(value_info: onnx.ValueInfoProto) -> list[int | str | None]:
    dims: list[int | str | None] = []
    for dim in value_info.type.tensor_type.shape.dim:
        dims.append(dim.dim_value or dim.dim_param or None)
    return dims


def model_info(path: Path) -> dict:
    model = onnx.load(path, load_external_data=False)
    return {
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "ir_version": model.ir_version,
        "opsets": {item.domain or "ai.onnx": item.version for item in model.opset_import},
        "inputs": {item.name: tensor_shape(item) for item in model.graph.input},
        "outputs": {item.name: tensor_shape(item) for item in model.graph.output},
    }


def build_ordering_model(destination: Path) -> None:
    panel = onnx.compose.add_prefix(onnx.load(PANEL_RANKER), "panel_")
    bubble = onnx.compose.add_prefix(onnx.load(BUBBLE_RANKER), "bubble_")
    merged = onnx.compose.merge_models(panel, bubble, io_map=[])
    # The source exports both call their dynamic batch dimension "pairs". Once
    # merged, ONNX interprets equal symbolic names as equal dimensions even
    # though each independent head may receive a different number of rows.
    for value_info in [*merged.graph.input, *merged.graph.output, *merged.graph.value_info]:
        prefix = "panel" if value_info.name.startswith("panel_") else "bubble"
        for dim in value_info.type.tensor_type.shape.dim:
            if dim.dim_param == "pairs":
                dim.dim_param = f"{prefix}_pairs"
    merged.doc_string = (
        "Poneglyph ReaderNet pairwise reading-order rankers. The two independent heads "
        "share one ONNX file and one runtime session. Apply sigmoid to logits, sum each "
        "item's pairwise probabilities, then sort descending. Bubble ordering is local "
        "to its assigned panel; no global bubble reranker is included."
    )
    metadata = {
        "model_name": "Poneglyph ReaderNet Ordering",
        "panel_feature_size": "96",
        "bubble_feature_size": "102",
        "panel_decoding": "pairwise sigmoid Borda score descending",
        "bubble_decoding": "pairwise sigmoid Borda score descending within assigned panel",
        "source_panel_sha256": sha256(PANEL_RANKER),
        "source_bubble_sha256": sha256(BUBBLE_RANKER),
    }
    del merged.metadata_props[:]
    for key, value in metadata.items():
        prop = merged.metadata_props.add()
        prop.key, prop.value = key, value
    onnx.checker.check_model(merged)
    onnx.save(merged, destination)


def validate_parity(ordering_path: Path) -> dict:
    rng = np.random.default_rng(42)
    panel_features = rng.normal(size=(37, 96)).astype(np.float32)
    bubble_features = rng.normal(size=(53, 102)).astype(np.float32)
    panel_session = ort.InferenceSession(str(PANEL_RANKER), providers=["CPUExecutionProvider"])
    bubble_session = ort.InferenceSession(str(BUBBLE_RANKER), providers=["CPUExecutionProvider"])
    merged_session = ort.InferenceSession(str(ordering_path), providers=["CPUExecutionProvider"])

    started = time.perf_counter()
    expected_panel = panel_session.run(None, {"features": panel_features})[0]
    expected_bubble = bubble_session.run(None, {"features": bubble_features})[0]
    separate_ms = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    actual_panel, actual_bubble = merged_session.run(
        None,
        {"panel_features": panel_features, "bubble_features": bubble_features},
    )
    merged_ms = (time.perf_counter() - started) * 1000
    panel_error = float(np.max(np.abs(expected_panel - actual_panel)))
    bubble_error = float(np.max(np.abs(expected_bubble - actual_bubble)))
    if panel_error > 1e-6 or bubble_error > 1e-6:
        raise AssertionError(f"ONNX parity failed: panel={panel_error}, bubble={bubble_error}")
    return {
        "status": "passed",
        "seed": 42,
        "panel_rows": len(panel_features),
        "bubble_rows": len(bubble_features),
        "panel_max_abs_error": panel_error,
        "bubble_max_abs_error": bubble_error,
        "single_run_smoke_ms": merged_ms,
        "two_source_runs_smoke_ms": separate_ms,
        "note": "Timing is a local smoke measurement, not a stable cross-platform benchmark.",
    }


def write_readme(path: Path) -> None:
    path.write_text(
        """---
license: agpl-3.0
library_name: onnxruntime
tags:
- onnx
- comic
- manga
- object-detection
- image-segmentation
- reading-order
---

# Poneglyph ReaderNet

ReaderNet is the browser inference bundle used by Poneglyph to detect speech bubbles and manga panels, assign every bubble to one panel, order panels, then order bubbles **inside each panel only**.

## Files

- `bubble_detector.onnx`: YOLO26n end-to-end speech-bubble detector, input `1×3×800×800`, output `1×300×6`.
- `panel_detector.onnx`: YOLO11n-seg panel detector, input `1×3×1504×1504`; the web application uses its NMS boxes and represents them as four-point rectangular polygons for the ordering features.
- `ordering.onnx`: one ONNX graph/session containing two independent MLP heads: `panel_features[*,96] → panel_logits[*]` and `bubble_features[*,102] → bubble_logits[*]`.
- `model_manifest.json`: immutable hashes, tensor contracts and provenance.
- `parity_report.json`: source-versus-fused ONNX numerical parity.
- `metrics/`: training, shared-detector comparison and end-to-end reports.

## Runtime algorithm

1. Detect panels and bubbles.
2. Rank panels from all directed panel pairs by summed sigmoid probabilities.
3. Assign each bubble by center containment; use the smallest containing panel when overlaps exist, otherwise the nearest panel boundary.
4. Batch all directed bubble pairs across panels into the bubble head.
5. Rank bubbles independently inside each panel. There is no global bubble sorter.

The two rankers were fused to reduce model downloads and ONNX Runtime session setup. They remain independent heads so their predictions are numerically identical to the original ONNX exports.

## Reported validation

- Panel ordering with annotated polygons: 51/51 validation pages exact (100%).
- Bubble ordering with a shared `bubble_detector.onnx` and shared annotated panels: 132/138 exact multi-bubble panels (95.65%), versus 127/138 (92.03%) for the previous published pipeline.
- Browser-compatible bounding rectangles represented as four-point polygons: panel order 51/51 exact pages (100%); bubble order 131/139 exact multi-bubble panels (94.24%).
- End-to-end with predicted panels and reference bubble boxes: 125/139 exact multi-bubble panels (89.93%); bubble-to-panel assignment accuracy 428/438 (97.72%).

See the JSON reports for datasets, splits, protocols and full metrics. Detector artifacts exported by Ultralytics are distributed under AGPL-3.0; see Ultralytics licensing terms for deployment obligations.
""",
        encoding="utf-8",
    )


def main() -> None:
    generated_metric = METRICS["metrics/box_polygon_runtime_metrics.json"]
    required = [
        PANEL_RANKER,
        BUBBLE_RANKER,
        BUBBLE_DETECTOR,
        PANEL_DETECTOR,
        *(path for path in METRICS.values() if path != generated_metric),
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing ReaderNet sources:\n" + "\n".join(missing))

    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    (OUTPUT / "metrics").mkdir(parents=True)
    shutil.copy2(BUBBLE_DETECTOR, OUTPUT / "bubble_detector.onnx")
    shutil.copy2(PANEL_DETECTOR, OUTPUT / "panel_detector.onnx")
    build_ordering_model(OUTPUT / "ordering.onnx")
    subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent / "validate_box_polygon_runtime.py")],
        cwd=ROOT,
        check=True,
    )
    for relative, source in METRICS.items():
        shutil.copy2(source, OUTPUT / relative)
    write_readme(OUTPUT / "README.md")

    parity = validate_parity(OUTPUT / "ordering.onnx")
    (OUTPUT / "parity_report.json").write_text(json.dumps(parity, indent=2) + "\n", encoding="utf-8")
    artifacts = {}
    for path in sorted(OUTPUT.rglob("*")):
        if path.is_file() and path.name != "model_manifest.json":
            relative = path.relative_to(OUTPUT).as_posix()
            artifacts[relative] = model_info(path) if path.suffix == ".onnx" else {
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
    manifest = {
        "schema_version": 1,
        "repository": "Remidesbois/Poneglyph-ReaderNet",
        "runtime": {
            "ordering": "panel-constrained; no global bubble ordering",
            "panel_polygon_representation": "detector bounding box as a four-point polygon",
        },
        "artifacts": artifacts,
    }
    (OUTPUT / "model_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "parity": parity, "files": len(artifacts) + 1}, indent=2))


if __name__ == "__main__":
    main()
