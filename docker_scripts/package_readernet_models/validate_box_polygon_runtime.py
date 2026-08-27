#!/usr/bin/env python3
"""Validate the rectangular panel representation used by the browser worker."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort


ROOT = Path(__file__).resolve().parents[2]
ANNOTATOR = ROOT / "scripts/polygon_case_annotator"
sys.path.insert(0, str(ANNOTATOR))

import train_bubble_order as bubble_order  # noqa: E402
import train_panel_order as panel_order  # noqa: E402


ORDERING = Path(__file__).resolve().parent / "hf_package/ordering.onnx"
REPORT = ANNOTATOR / "bubble_order/box_polygon_runtime_metrics.json"


def rectangle(polygon: np.ndarray) -> np.ndarray:
    low = polygon.min(axis=0)
    high = polygon.max(axis=0)
    return np.asarray(
        [[low[0], low[1]], [high[0], low[1]], [high[0], high[1]], [low[0], high[1]]],
        dtype=np.float32,
    )


def probabilities(session: ort.InferenceSession, head: str, rows: list[np.ndarray]) -> np.ndarray:
    matrix = np.asarray(rows, dtype=np.float32)
    panel = matrix if head == "panel" else np.zeros((1, 96), dtype=np.float32)
    bubble = matrix if head == "bubble" else np.zeros((1, 102), dtype=np.float32)
    logits = session.run(
        [f"{head}_logits"],
        {"panel_features": panel, "bubble_features": bubble},
    )[0]
    return 1.0 / (1.0 + np.exp(-logits))


def rank(session: ort.InferenceSession, head: str, items: list, feature_builder) -> list:
    if len(items) < 2:
        return items
    rows = []
    owners = []
    for i, item in enumerate(items):
        for j, other in enumerate(items):
            if i == j:
                continue
            owners.append(i)
            rows.append(feature_builder(item, other))
    scores = np.zeros(len(items), dtype=np.float64)
    for owner, probability in zip(owners, probabilities(session, head, rows)):
        scores[owner] += float(probability)
    return [items[index] for index in sorted(range(len(items)), key=lambda i: (-scores[i], i))]


def main() -> None:
    if not ORDERING.is_file():
        raise FileNotFoundError(f"Build the package first: {ORDERING}")
    session = ort.InferenceSession(str(ORDERING), providers=["CPUExecutionProvider"])
    val_ids = panel_order.page_ids_from_split(panel_order.DEFAULT_DATASET, "val")

    pages = panel_order.load_pages(panel_order.DEFAULT_ANNOTATIONS)
    panel_exact = panel_positions = panel_position_correct = 0
    for page_id in sorted(val_ids):
        page = pages[page_id]
        panels = [panel_order.Panel(item.panel_id, item.order, rectangle(item.polygon)) for item in page.panels]
        predicted = rank(session, "panel", panels, panel_order.pair_features)
        expected_ids = [item.panel_id for item in panels]
        predicted_ids = [item.panel_id for item in predicted]
        panel_exact += int(expected_ids == predicted_ids)
        panel_position_correct += sum(a == b for a, b in zip(expected_ids, predicted_ids))
        panel_positions += len(panels)

    groups, _ = bubble_order.load_groups(
        panel_order.DEFAULT_ANNOTATIONS,
        bubble_order.DEFAULT_SOURCE,
        val_ids,
    )
    multi = [group for group in groups if len(group.bubbles) >= 2]
    bubble_exact = bubble_positions = bubble_position_correct = 0
    for group in multi:
        panel = panel_order.Panel(group.panel.panel_id, group.panel.order, rectangle(group.panel.polygon))
        bubbles = list(group.bubbles)
        predicted = rank(
            session,
            "bubble",
            bubbles,
            lambda a, b: bubble_order.pair_features(a, b, panel),
        )
        expected_ids = [item.bubble_id for item in bubbles]
        predicted_ids = [item.bubble_id for item in predicted]
        bubble_exact += int(expected_ids == predicted_ids)
        bubble_position_correct += sum(a == b for a, b in zip(expected_ids, predicted_ids))
        bubble_positions += len(bubbles)

    report = {
        "kind": "browser_box_as_four_point_polygon_validation",
        "protocol": "Held-out validation annotations; replace each polygon by its bounding rectangle and run the fused ONNX heads.",
        "panel_order": {
            "pages": len(val_ids),
            "exact_pages": panel_exact,
            "exact_page_accuracy": panel_exact / len(val_ids),
            "position_accuracy": panel_position_correct / panel_positions,
        },
        "bubble_order": {
            "multi_bubble_panels": len(multi),
            "exact_panels": bubble_exact,
            "exact_panel_accuracy": bubble_exact / len(multi),
            "position_accuracy": bubble_position_correct / bubble_positions,
        },
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
