from __future__ import annotations

import argparse
import json
import math
import random
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np
import onnxruntime as ort

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from train_reading_order import (
    DEFAULT_ANNOTATIONS,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_SPLIT_MANIFEST,
    Box,
    BubbleSample,
    PageSample,
    PairDataset,
    PanelSample,
    build_bubble_pairs,
    build_panel_pairs,
    bubble_pair_features,
    box_features,
    create_ranker,
    exact_accuracy,
    export_linear_probability_onnx,
    heuristic_probability_before,
    interval_overlap,
    load_pages,
    pair_features,
    parse_float_list,
    parse_gap_candidates,
    predict_panel_order,
    rank_items,
    read_json,
    safe_div,
    select_heuristic_weights,
    split_pages,
    summarize_pages,
    vertical_override_probability,
    write_json,
    write_model_artifacts,
)


DEFAULT_BENCHMARK_METRICS = SCRIPT_DIR / "metrics" / "reading_order_benchmark.json"
DEFAULT_BENCHMARK_PREDICTIONS = (
    SCRIPT_DIR / "predictions" / "benchmark_page_orders.json"
)
DEFAULT_EXPERIMENT_DOC = (
    SCRIPT_DIR.parent.parent / "documentation" / "reading_order_experiments.md"
)

RANKER_CHOICES = (
    "sklearn-logistic",
    "pure-logistic",
    "extra-trees",
    "hist-gradient-boosting",
)
RECONSTRUCTION_CHOICES = (
    "borda",
    "borda-vertical-repair",
    "bradley-terry",
    "topological",
    "stable-local",
)
RUNTIME_RECONSTRUCTION_CHOICES = ("borda", "borda-vertical-repair")

VERTICAL_REPAIR_GAP_FACTOR = 1.5
VERTICAL_REPAIR_MAX_Y_OVERLAP = 0.05
VERTICAL_REPAIR_MAX_AREA_RATIO = 0.7
VERTICAL_REPAIR_POSTPROCESS_NAME = "vertical_small_bubble_repair_v1"


def postprocess_metadata_for_experiment(
    experiment: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if experiment is None:
        return None
    if experiment.get("reconstruction_method") != "borda-vertical-repair":
        return None
    return {
        "name": VERTICAL_REPAIR_POSTPROCESS_NAME,
        "gap_factor": VERTICAL_REPAIR_GAP_FACTOR,
        "max_y_overlap": VERTICAL_REPAIR_MAX_Y_OVERLAP,
        "max_area_ratio": VERTICAL_REPAIR_MAX_AREA_RATIO,
    }


def is_runtime_compatible_candidate(
    ranker_type: str | None,
    reconstruction_method: str | None,
) -> bool:
    return (
        ranker_type in {"sklearn-logistic", "pure-logistic"}
        and reconstruction_method in RUNTIME_RECONSTRUCTION_CHOICES
    )


@dataclass(frozen=True)
class AssignmentInfo:
    panel_index: int
    panel_id: str | None
    reason: str
    center_inside: bool
    overlap_ratio: float
    distance_to_center: float
    border_distance: float
    second_best_panel_margin: float
    overlap_panel_count: int


@dataclass(frozen=True)
class BubbleContext:
    predicted_panel_index: int
    predicted_panel_id: str | None
    predicted_panel_order: int
    predicted_local_order: int
    current_pipeline_index: int
    panel_box: Box
    assignment: AssignmentInfo
    bubble_confidence: float = 1.0
    panel_confidence: float = 1.0


@dataclass(frozen=True)
class PipelineContext:
    page_id: int
    mode: str
    predicted_panels: tuple[PanelSample, ...]
    predicted_panel_order: tuple[str, ...]
    predicted_bubble_order: tuple[BubbleSample, ...]
    bubble_context: dict[int, BubbleContext]
    panel_details: tuple[dict[str, Any], ...]
    fallback_used: bool
    empty_panel_count: int


@dataclass(frozen=True)
class DetectionBox:
    box: Box
    confidence: float = 1.0


@dataclass(frozen=True)
class DetectionPrediction:
    page_id: int
    bubbles: tuple[DetectionBox, ...]
    panels: tuple[DetectionBox, ...]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def finite(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(-20.0, min(20.0, float(value)))


def finite_features(values: Sequence[float]) -> list[float]:
    return [finite(value) for value in values]


def box_area(box: Box) -> float:
    return max(0.0, box.w) * max(0.0, box.h)


def intersection_area(a: Box, b: Box) -> float:
    x1 = max(a.x, b.x)
    y1 = max(a.y, b.y)
    x2 = min(a.x2, b.x2)
    y2 = min(a.y2, b.y2)
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def box_iou(a: Box, b: Box) -> float:
    intersection = intersection_area(a, b)
    union = box_area(a) + box_area(b) - intersection
    return intersection / union if union > 0 else 0.0


def to_optional_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def parse_detection_box(value: Any, bbox_format: str | None = None) -> Box | None:
    if not isinstance(value, dict):
        return None
    raw_box = value.get("bbox", value.get("box", value))
    if isinstance(raw_box, (list, tuple)) and len(raw_box) >= 4:
        x1 = to_optional_float(raw_box[0])
        y1 = to_optional_float(raw_box[1])
        third = to_optional_float(raw_box[2])
        fourth = to_optional_float(raw_box[3])
        if x1 is None or y1 is None or third is None or fourth is None:
            return None
        if bbox_format == "xyxy" or value.get("bbox_format") == "xyxy":
            w = third - x1
            h = fourth - y1
        else:
            w = third
            h = fourth
        return Box(x=x1, y=y1, w=w, h=h) if w > 0 and h > 0 else None
    if not isinstance(raw_box, dict):
        return None

    if {"x1", "y1", "x2", "y2"}.issubset(raw_box):
        x1 = to_optional_float(raw_box.get("x1"))
        y1 = to_optional_float(raw_box.get("y1"))
        x2 = to_optional_float(raw_box.get("x2"))
        y2 = to_optional_float(raw_box.get("y2"))
        if x1 is None or y1 is None or x2 is None or y2 is None:
            return None
        w = x2 - x1
        h = y2 - y1
        return Box(x=x1, y=y1, w=w, h=h) if w > 0 and h > 0 else None

    x = to_optional_float(raw_box.get("x", raw_box.get("left")))
    y = to_optional_float(raw_box.get("y", raw_box.get("top")))
    w = to_optional_float(raw_box.get("w", raw_box.get("width")))
    h = to_optional_float(raw_box.get("h", raw_box.get("height")))
    if x is None or y is None or w is None or h is None or w <= 0 or h <= 0:
        return None
    return Box(x=x, y=y, w=w, h=h)


def parse_detection_confidence(value: Any) -> float:
    if not isinstance(value, dict):
        return 1.0
    for key in ("conf", "confidence", "score", "probability"):
        parsed = to_optional_float(value.get(key))
        if parsed is not None:
            return max(0.0, min(1.0, parsed))
    return 1.0


def detection_label(value: dict[str, Any]) -> str:
    raw = (
        value.get("type")
        or value.get("label")
        or value.get("class")
        or value.get("class_name")
        or value.get("name")
        or ""
    )
    return str(raw).lower()


def parse_detection_list(items: Any, bbox_format: str | None = None) -> tuple[DetectionBox, ...]:
    parsed: list[DetectionBox] = []
    if not isinstance(items, list):
        return tuple()
    for item in items:
        box = parse_detection_box(item, bbox_format=bbox_format)
        if box is None:
            continue
        parsed.append(DetectionBox(box=box, confidence=parse_detection_confidence(item)))
    return tuple(parsed)


def normalize_detection_page_records(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict) and isinstance(raw.get("pages"), list):
        return [item for item in raw["pages"] if isinstance(item, dict)]
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        records = []
        for key, value in raw.items():
            if not isinstance(value, dict):
                continue
            record = dict(value)
            record.setdefault("page_id", key)
            records.append(record)
        return records
    return []


def load_detection_predictions(path: Path) -> dict[int, DetectionPrediction]:
    raw = read_json(path)
    predictions: dict[int, DetectionPrediction] = {}
    for record in normalize_detection_page_records(raw):
        try:
            page_id = int(record.get("page_id"))
        except (TypeError, ValueError):
            continue
        bbox_format = record.get("bbox_format")
        bubbles = parse_detection_list(
            record.get("bubbles")
            or record.get("bubble_boxes")
            or record.get("detected_bubbles"),
            bbox_format=bbox_format,
        )
        panels = parse_detection_list(
            record.get("panels")
            or record.get("panel_boxes")
            or record.get("detected_panels"),
            bbox_format=bbox_format,
        )
        detections = record.get("detections")
        if isinstance(detections, list):
            bubble_items = []
            panel_items = []
            for item in detections:
                if not isinstance(item, dict):
                    continue
                label = detection_label(item)
                if "panel" in label or "case" in label:
                    panel_items.append(item)
                elif "bubble" in label or "bulle" in label:
                    bubble_items.append(item)
            if bubble_items:
                bubbles = parse_detection_list(bubble_items, bbox_format=bbox_format)
            if panel_items:
                panels = parse_detection_list(panel_items, bbox_format=bbox_format)
        predictions[page_id] = DetectionPrediction(
            page_id=page_id,
            bubbles=bubbles,
            panels=panels,
        )
    return predictions


def best_unmatched_iou(
    box: Box,
    candidates: Sequence[Any],
    used_ids: set[Any],
    id_getter: Callable[[Any], Any],
) -> tuple[Any | None, float]:
    best_item = None
    best_score = 0.0
    for item in candidates:
        item_id = id_getter(item)
        if item_id in used_ids:
            continue
        score = box_iou(box, item.box)
        if score > best_score:
            best_item = item
            best_score = score
    return best_item, best_score


def contains_center(panel: Box, bubble: Box) -> bool:
    return panel.x <= bubble.cx <= panel.x2 and panel.y <= bubble.cy <= panel.y2


def border_distance(panel: Box, bubble: Box) -> float:
    if not contains_center(panel, bubble):
        dx = max(panel.x - bubble.cx, 0.0, bubble.cx - panel.x2)
        dy = max(panel.y - bubble.cy, 0.0, bubble.cy - panel.y2)
        return -math.hypot(dx, dy) / max(1.0, max(panel.w, panel.h))
    return (
        min(
            bubble.cx - panel.x,
            panel.x2 - bubble.cx,
            bubble.cy - panel.y,
            panel.y2 - bubble.cy,
        )
        / max(1.0, max(panel.w, panel.h))
    )


def panel_distance(page: PageSample, panel: Box, bubble: Box) -> float:
    return math.hypot(bubble.cx - panel.cx, bubble.cy - panel.cy) / max(
        1.0, math.hypot(page.width, page.height)
    )


def normalized_order(index: int, total: int) -> float:
    return safe_div(index, max(1, total - 1))


def full_page_box(page: PageSample) -> Box:
    return Box(x=0.0, y=0.0, w=page.width, h=page.height)


def relative_box(box: Box, panel: Box) -> Box:
    return Box(x=box.x - panel.x, y=box.y - panel.y, w=box.w, h=box.h)


def gt_panel_order(page: PageSample) -> list[PanelSample]:
    return sorted(page.panels, key=lambda panel: panel.order)


def gt_bubble_order(page: PageSample) -> list[BubbleSample]:
    bubbles: list[BubbleSample] = []
    for panel in gt_panel_order(page):
        bubbles.extend(sorted(panel.bubbles, key=lambda bubble: bubble.order))
    return bubbles


def manga_order_sort(bubbles: Sequence[BubbleSample]) -> list[BubbleSample]:
    sorted_bubbles = sorted(bubbles, key=lambda bubble: bubble.box.y)
    rows: list[list[BubbleSample]] = []
    for bubble in sorted_bubbles:
        if rows and abs(bubble.box.y - rows[-1][0].box.y) < 100:
            rows[-1].append(bubble)
        else:
            rows.append([bubble])
    ordered: list[BubbleSample] = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda bubble: bubble.box.x, reverse=True))
    return ordered


def panel_assignment_stats(
    page: PageSample,
    bubble: BubbleSample,
    panel: PanelSample,
) -> dict[str, float | bool]:
    overlap_area = intersection_area(bubble.box, panel.box)
    bubble_area = max(1.0, box_area(bubble.box))
    center_inside = contains_center(panel.box, bubble.box)
    return {
        "center_inside": center_inside,
        "overlap_area": overlap_area,
        "overlap_ratio": overlap_area / bubble_area,
        "distance": panel_distance(page, panel.box, bubble.box),
        "border_distance": border_distance(panel.box, bubble.box),
        "panel_area": box_area(panel.box),
    }


def assignment_score(stats: dict[str, float | bool]) -> float:
    return (
        (2.0 if bool(stats["center_inside"]) else 0.0)
        + float(stats["overlap_ratio"])
        - min(1.0, float(stats["distance"]))
    )


def build_assignment_info(
    page: PageSample,
    bubble: BubbleSample,
    panels: Sequence[PanelSample],
    panel_index: int,
    reason: str,
    stats_by_panel: Sequence[dict[str, float | bool]],
) -> AssignmentInfo:
    if panel_index < 0 or panel_index >= len(panels):
        return AssignmentInfo(
            panel_index=-1,
            panel_id=None,
            reason=reason,
            center_inside=False,
            overlap_ratio=0.0,
            distance_to_center=1.0,
            border_distance=-1.0,
            second_best_panel_margin=0.0,
            overlap_panel_count=0,
        )

    stats = stats_by_panel[panel_index]
    scores = sorted((assignment_score(item) for item in stats_by_panel), reverse=True)
    margin = scores[0] - scores[1] if len(scores) > 1 else scores[0]
    overlap_count = sum(1 for item in stats_by_panel if float(item["overlap_area"]) > 0)
    panel = panels[panel_index]
    return AssignmentInfo(
        panel_index=panel_index,
        panel_id=panel.panel_id,
        reason=reason,
        center_inside=bool(stats["center_inside"]),
        overlap_ratio=float(stats["overlap_ratio"]),
        distance_to_center=float(stats["distance"]),
        border_distance=float(stats["border_distance"]),
        second_best_panel_margin=margin,
        overlap_panel_count=overlap_count,
    )


def choose_assignment(
    page: PageSample,
    bubble: BubbleSample,
    panels: Sequence[PanelSample],
    strategy: str,
) -> AssignmentInfo:
    if not panels:
        return build_assignment_info(page, bubble, panels, -1, "no_panels", [])

    stats_by_panel = [
        panel_assignment_stats(page, bubble, panel)
        for panel in panels
    ]

    if strategy == "assignment_aware":
        containing = [
            (float(stats["panel_area"]), index)
            for index, stats in enumerate(stats_by_panel)
            if bool(stats["center_inside"])
        ]
        if containing:
            _, panel_index = min(containing)
            return build_assignment_info(
                page, bubble, panels, panel_index, "smallest_center_panel", stats_by_panel
            )
        overlapping = [
            (float(stats["overlap_ratio"]), -float(stats["panel_area"]), index)
            for index, stats in enumerate(stats_by_panel)
            if float(stats["overlap_area"]) > 0
        ]
        if overlapping:
            _, _, panel_index = max(overlapping)
            return build_assignment_info(
                page, bubble, panels, panel_index, "largest_overlap_ratio", stats_by_panel
            )
        distances = [
            (float(stats["distance"]), index)
            for index, stats in enumerate(stats_by_panel)
        ]
        _, panel_index = min(distances)
        return build_assignment_info(
            page, bubble, panels, panel_index, "nearest_panel_center", stats_by_panel
        )

    for index, stats in enumerate(stats_by_panel):
        if bool(stats["center_inside"]):
            return build_assignment_info(
                page, bubble, panels, index, "first_center_panel", stats_by_panel
            )

    overlaps = [
        (float(stats["overlap_area"]), index)
        for index, stats in enumerate(stats_by_panel)
        if float(stats["overlap_area"]) > 0
    ]
    if overlaps:
        _, panel_index = max(overlaps)
        return build_assignment_info(
            page, bubble, panels, panel_index, "largest_overlap_area", stats_by_panel
        )

    distances = [
        (float(stats["distance"]), index)
        for index, stats in enumerate(stats_by_panel)
    ]
    _, panel_index = min(distances)
    return build_assignment_info(
        page, bubble, panels, panel_index, "nearest_panel_center", stats_by_panel
    )


def bubble_probability(
    page: PageSample,
    panel: PanelSample,
    bubble_model: Any,
    bubble_heuristic_weight: float,
    bubble_vertical_override_gap: float | None,
    a: BubbleSample,
    b: BubbleSample,
) -> float:
    model_probability = bubble_model.predict_proba(
        bubble_pair_features(a, b, page.width, page.height, panel.box)
    )
    override_probability = vertical_override_probability(
        model_probability,
        a.box,
        b.box,
        bubble_vertical_override_gap,
    )
    if override_probability is not None:
        return override_probability
    return (
        (1.0 - bubble_heuristic_weight) * model_probability
        + bubble_heuristic_weight * heuristic_probability_before(a.box, b.box)
    )


def rank_bubble_group(
    page: PageSample,
    panel: PanelSample,
    bubbles: Sequence[BubbleSample],
    bubble_model: Any,
    bubble_heuristic_weight: float,
    bubble_vertical_override_gap: float | None,
) -> list[BubbleSample]:
    return rank_items(
        list(bubbles),
        lambda a, b: bubble_probability(
            page,
            panel,
            bubble_model,
            bubble_heuristic_weight,
            bubble_vertical_override_gap,
            a,
            b,
        ),
    )


def make_pipeline_context(
    page: PageSample,
    panel_model: Any,
    bubble_model: Any,
    panel_heuristic_weight: float,
    bubble_heuristic_weight: float,
    bubble_vertical_override_gap: float | None,
    assignment_strategy: str,
    panel_candidates: Sequence[PanelSample] | None = None,
    bubble_candidates: Sequence[BubbleSample] | None = None,
    panel_confidences: dict[str, float] | None = None,
    bubble_confidences: dict[int, float] | None = None,
) -> PipelineContext:
    candidate_panels = tuple(panel_candidates) if panel_candidates is not None else page.panels
    candidate_bubbles = tuple(bubble_candidates) if bubble_candidates is not None else page.bubbles
    panel_confidences = panel_confidences or {}
    bubble_confidences = bubble_confidences or {}
    if panel_candidates is None:
        predicted_panels = tuple(
            predict_panel_order(page, panel_model, panel_heuristic_weight)
        )
    else:
        predicted_panels = tuple(
            rank_items(
                list(candidate_panels),
                lambda a, b: (
                    (1.0 - panel_heuristic_weight)
                    * panel_model.predict_proba(
                        pair_features(a.box, b.box, page.width, page.height)
                    )
                    + panel_heuristic_weight
                    * heuristic_probability_before(a.box, b.box)
                ),
            )
        )
    if not predicted_panels:
        ordered = tuple(manga_order_sort(candidate_bubbles))
        page_box = full_page_box(page)
        bubble_context = {
            bubble.bubble_id: BubbleContext(
                predicted_panel_index=-1,
                predicted_panel_id=None,
                predicted_panel_order=-1,
                predicted_local_order=index,
                current_pipeline_index=index,
                panel_box=page_box,
                assignment=AssignmentInfo(
                    panel_index=-1,
                    panel_id=None,
                    reason="mangaOrderSort",
                    center_inside=False,
                    overlap_ratio=0.0,
                    distance_to_center=1.0,
                    border_distance=-1.0,
                    second_best_panel_margin=0.0,
                    overlap_panel_count=0,
                ),
                bubble_confidence=bubble_confidences.get(bubble.bubble_id, 1.0),
                panel_confidence=1.0,
            )
            for index, bubble in enumerate(ordered)
        }
        return PipelineContext(
            page_id=page.page_id,
            mode=assignment_strategy,
            predicted_panels=tuple(),
            predicted_panel_order=tuple(),
            predicted_bubble_order=ordered,
            bubble_context=bubble_context,
            panel_details=tuple(),
            fallback_used=True,
            empty_panel_count=1,
        )

    groups: dict[int, list[BubbleSample]] = {index: [] for index in range(len(predicted_panels))}
    assignments: dict[int, AssignmentInfo] = {}

    if assignment_strategy == "ground_truth":
        predicted_panel_index = {
            panel.panel_id: index for index, panel in enumerate(predicted_panels)
        }
        for panel in page.panels:
            index = predicted_panel_index.get(panel.panel_id, -1)
            for bubble in panel.bubbles:
                if index >= 0:
                    groups[index].append(bubble)
                assignments[bubble.bubble_id] = build_assignment_info(
                    page,
                    bubble,
                    predicted_panels,
                    index,
                    "ground_truth_panel",
                    [
                        panel_assignment_stats(page, bubble, predicted_panel)
                        for predicted_panel in predicted_panels
                    ],
                )
    else:
        for bubble in candidate_bubbles:
            assignment = choose_assignment(
                page,
                bubble,
                predicted_panels,
                "assignment_aware" if assignment_strategy == "assignment_aware" else "worker",
            )
            assignments[bubble.bubble_id] = assignment
            if assignment.panel_index >= 0:
                groups.setdefault(assignment.panel_index, []).append(bubble)

    ordered: list[BubbleSample] = []
    panel_details: list[dict[str, Any]] = []
    bubble_context: dict[int, BubbleContext] = {}
    empty_panel_count = 0

    for panel_index, panel in enumerate(predicted_panels):
        group = groups.get(panel_index, [])
        if not group:
            empty_panel_count += 1
            panel_details.append(
                {
                    "panel_id": panel.panel_id,
                    "predicted_bubble_order": [],
                    "ground_truth_bubble_order": [
                        bubble.bubble_id
                        for bubble in sorted(panel.bubbles, key=lambda item: item.order)
                    ],
                    "empty_predicted_group": True,
                }
            )
            continue

        ordered_group = rank_bubble_group(
            page,
            panel,
            group,
            bubble_model,
            bubble_heuristic_weight,
            bubble_vertical_override_gap,
        )
        panel_details.append(
            {
                "panel_id": panel.panel_id,
                "predicted_bubble_order": [bubble.bubble_id for bubble in ordered_group],
                "ground_truth_bubble_order": [
                    bubble.bubble_id
                    for bubble in sorted(panel.bubbles, key=lambda item: item.order)
                ],
                "empty_predicted_group": False,
            }
        )
        for local_index, bubble in enumerate(ordered_group):
            current_index = len(ordered) + local_index
            bubble_context[bubble.bubble_id] = BubbleContext(
                predicted_panel_index=panel_index,
                predicted_panel_id=panel.panel_id,
                predicted_panel_order=panel_index,
                predicted_local_order=local_index,
                current_pipeline_index=current_index,
                panel_box=panel.box,
                assignment=assignments[bubble.bubble_id],
                bubble_confidence=bubble_confidences.get(bubble.bubble_id, 1.0),
                panel_confidence=panel_confidences.get(panel.panel_id, 1.0),
            )
        ordered.extend(ordered_group)

    if len(ordered) != len(candidate_bubbles):
        ordered = manga_order_sort(candidate_bubbles)
        page_box = full_page_box(page)
        for index, bubble in enumerate(ordered):
            bubble_context.setdefault(
                bubble.bubble_id,
                BubbleContext(
                    predicted_panel_index=-1,
                    predicted_panel_id=None,
                    predicted_panel_order=-1,
                    predicted_local_order=index,
                    current_pipeline_index=index,
                    panel_box=page_box,
                    assignment=assignments.get(
                        bubble.bubble_id,
                        AssignmentInfo(
                            panel_index=-1,
                            panel_id=None,
                            reason="mangaOrderSort",
                            center_inside=False,
                            overlap_ratio=0.0,
                            distance_to_center=1.0,
                            border_distance=-1.0,
                            second_best_panel_margin=0.0,
                            overlap_panel_count=0,
                        ),
                    ),
                    bubble_confidence=bubble_confidences.get(bubble.bubble_id, 1.0),
                    panel_confidence=1.0,
                ),
            )
        fallback_used = True
    else:
        fallback_used = False

    return PipelineContext(
        page_id=page.page_id,
        mode=assignment_strategy,
        predicted_panels=predicted_panels,
        predicted_panel_order=tuple(panel.panel_id for panel in predicted_panels),
        predicted_bubble_order=tuple(ordered),
        bubble_context=bubble_context,
        panel_details=tuple(panel_details),
        fallback_used=fallback_used,
        empty_panel_count=empty_panel_count,
    )


def box_feature_names(prefix: str) -> list[str]:
    return [
        f"{prefix}_x",
        f"{prefix}_y",
        f"{prefix}_x2",
        f"{prefix}_y2",
        f"{prefix}_cx",
        f"{prefix}_cy",
        f"{prefix}_w",
        f"{prefix}_h",
        f"{prefix}_area_ratio",
        f"{prefix}_aspect",
    ]


def pair_feature_names(prefix: str) -> list[str]:
    return [
        *box_feature_names(f"{prefix}_a"),
        *box_feature_names(f"{prefix}_b"),
        f"{prefix}_dx",
        f"{prefix}_dy",
        f"{prefix}_abs_dx",
        f"{prefix}_abs_dy",
        f"{prefix}_delta_x",
        f"{prefix}_delta_y",
        f"{prefix}_delta_x2",
        f"{prefix}_delta_y2",
        f"{prefix}_delta_w",
        f"{prefix}_delta_h",
        f"{prefix}_distance",
        f"{prefix}_angle",
        f"{prefix}_overlap_x",
        f"{prefix}_overlap_y",
        f"{prefix}_a_right_of_b",
        f"{prefix}_a_above_b",
        f"{prefix}_same_y_overlap_band",
        f"{prefix}_same_x_overlap_band",
        f"{prefix}_same_reading_band",
        f"{prefix}_heuristic_rtl_before",
        f"{prefix}_heuristic_ltr_before",
        f"{prefix}_heuristic_direction_score",
    ]


def assignment_feature_names(prefix: str) -> list[str]:
    return [
        f"{prefix}_center_in_panel",
        f"{prefix}_overlap_area_ratio",
        f"{prefix}_distance_to_panel_center",
        f"{prefix}_border_distance",
        f"{prefix}_second_best_panel_margin",
        f"{prefix}_overlap_panel_count",
    ]


def global_feature_names() -> list[str]:
    return [
        *pair_feature_names("page"),
        "same_predicted_panel",
        "predicted_panel_order_a",
        "predicted_panel_order_b",
        "delta_predicted_panel_order",
        "predicted_local_order_a",
        "predicted_local_order_b",
        "delta_predicted_local_order",
        "current_pipeline_index_a",
        "current_pipeline_index_b",
        "delta_current_pipeline_index",
        *box_feature_names("relative_a_in_panel"),
        *box_feature_names("relative_b_in_panel"),
        *box_feature_names("predicted_panel_a"),
        *box_feature_names("predicted_panel_b"),
        "bubble_confidence_a",
        "bubble_confidence_b",
        "panel_confidence_a",
        "panel_confidence_b",
        *assignment_feature_names("assignment_a"),
        *assignment_feature_names("assignment_b"),
    ]


def assignment_features(info: AssignmentInfo, panel_count: int) -> list[float]:
    return [
        1.0 if info.center_inside else 0.0,
        info.overlap_ratio,
        info.distance_to_center,
        info.border_distance,
        info.second_best_panel_margin,
        safe_div(info.overlap_panel_count, max(1, panel_count)),
    ]


def global_pair_features(
    page: PageSample,
    a: BubbleSample,
    b: BubbleSample,
    context: PipelineContext,
) -> list[float]:
    page_pair = pair_features(a.box, b.box, page.width, page.height)
    page_box = full_page_box(page)
    a_context = context.bubble_context.get(
        a.bubble_id,
        BubbleContext(
            predicted_panel_index=-1,
            predicted_panel_id=None,
            predicted_panel_order=-1,
            predicted_local_order=0,
            current_pipeline_index=0,
            panel_box=page_box,
            assignment=AssignmentInfo(
                panel_index=-1,
                panel_id=None,
                reason="missing_context",
                center_inside=False,
                overlap_ratio=0.0,
                distance_to_center=1.0,
                border_distance=-1.0,
                second_best_panel_margin=0.0,
                overlap_panel_count=0,
            ),
        ),
    )
    b_context = context.bubble_context.get(
        b.bubble_id,
        BubbleContext(
            predicted_panel_index=-1,
            predicted_panel_id=None,
            predicted_panel_order=-1,
            predicted_local_order=0,
            current_pipeline_index=0,
            panel_box=page_box,
            assignment=AssignmentInfo(
                panel_index=-1,
                panel_id=None,
                reason="missing_context",
                center_inside=False,
                overlap_ratio=0.0,
                distance_to_center=1.0,
                border_distance=-1.0,
                second_best_panel_margin=0.0,
                overlap_panel_count=0,
            ),
        ),
    )
    panel_count = max(1, len(context.predicted_panels))
    bubble_count = max(1, len(page.bubbles))
    panel_order_a = normalized_order(max(0, a_context.predicted_panel_order), panel_count)
    panel_order_b = normalized_order(max(0, b_context.predicted_panel_order), panel_count)
    local_order_a = normalized_order(max(0, a_context.predicted_local_order), bubble_count)
    local_order_b = normalized_order(max(0, b_context.predicted_local_order), bubble_count)
    current_index_a = normalized_order(max(0, a_context.current_pipeline_index), bubble_count)
    current_index_b = normalized_order(max(0, b_context.current_pipeline_index), bubble_count)

    relative_a = relative_box(a.box, a_context.panel_box)
    relative_b = relative_box(b.box, b_context.panel_box)

    features = [
        *page_pair,
        1.0 if a_context.predicted_panel_id == b_context.predicted_panel_id else 0.0,
        panel_order_a,
        panel_order_b,
        panel_order_a - panel_order_b,
        local_order_a,
        local_order_b,
        local_order_a - local_order_b,
        current_index_a,
        current_index_b,
        current_index_a - current_index_b,
        *box_features(relative_a, max(1.0, a_context.panel_box.w), max(1.0, a_context.panel_box.h)),
        *box_features(relative_b, max(1.0, b_context.panel_box.w), max(1.0, b_context.panel_box.h)),
        *box_features(a_context.panel_box, page.width, page.height),
        *box_features(b_context.panel_box, page.width, page.height),
        a_context.bubble_confidence,
        b_context.bubble_confidence,
        a_context.panel_confidence,
        b_context.panel_confidence,
        *assignment_features(a_context.assignment, panel_count),
        *assignment_features(b_context.assignment, panel_count),
    ]
    return finite_features(features)


def panel_less_pair_features(
    page: PageSample,
    a: BubbleSample,
    b: BubbleSample,
    _context: PipelineContext,
) -> list[float]:
    return finite_features(pair_features(a.box, b.box, page.width, page.height))


def should_apply_vertical_small_bubble_repair(
    lower_candidate: BubbleSample,
    upper_candidate: BubbleSample,
    context: PipelineContext,
) -> bool:
    lower_context = context.bubble_context.get(lower_candidate.bubble_id)
    upper_context = context.bubble_context.get(upper_candidate.bubble_id)
    if lower_context is None or upper_context is None:
        return False
    if lower_context.predicted_panel_id != upper_context.predicted_panel_id:
        return False
    lower_box = lower_candidate.box
    upper_box = upper_candidate.box
    vertical_gap = lower_box.cy - upper_box.cy
    if vertical_gap < max(lower_box.h, upper_box.h) * VERTICAL_REPAIR_GAP_FACTOR:
        return False
    overlap_y = safe_div(
        interval_overlap(lower_box.y, lower_box.y2, upper_box.y, upper_box.y2),
        min(lower_box.h, upper_box.h),
    )
    if overlap_y > VERTICAL_REPAIR_MAX_Y_OVERLAP:
        return False
    area_ratio = safe_div(box_area(lower_box), max(1.0, box_area(upper_box)))
    return area_ratio <= VERTICAL_REPAIR_MAX_AREA_RATIO


def apply_vertical_small_bubble_repair(
    ordered: Sequence[BubbleSample],
    context: PipelineContext,
) -> list[BubbleSample]:
    repaired = list(ordered)
    for index in range(len(repaired) - 1):
        if should_apply_vertical_small_bubble_repair(
            repaired[index],
            repaired[index + 1],
            context,
        ):
            repaired[index], repaired[index + 1] = repaired[index + 1], repaired[index]
    return repaired


def build_global_pair_dataset(
    pages: Sequence[PageSample],
    contexts: dict[int, PipelineContext],
    feature_builder: Callable[[PageSample, BubbleSample, BubbleSample, PipelineContext], list[float]],
) -> PairDataset:
    dataset = PairDataset(features=[], labels=[], groups=[])
    for page in pages:
        context = contexts[page.page_id]
        ordered = gt_bubble_order(page)
        gt_position = {bubble.bubble_id: index for index, bubble in enumerate(ordered)}
        bubbles = list(page.bubbles)
        for i in range(len(bubbles)):
            for j in range(i + 1, len(bubbles)):
                a = bubbles[i]
                b = bubbles[j]
                label = 1 if gt_position[a.bubble_id] < gt_position[b.bubble_id] else 0
                dataset.features.append(feature_builder(page, a, b, context))
                dataset.labels.append(label)
                dataset.groups.append(page.page_id)
                dataset.features.append(feature_builder(page, b, a, context))
                dataset.labels.append(1 - label)
                dataset.groups.append(page.page_id)
    return dataset


def predict_pairwise_order(
    page: PageSample,
    model: Any,
    context: PipelineContext,
    feature_builder: Callable[[PageSample, BubbleSample, BubbleSample, PipelineContext], list[float]],
    reconstruction_method: str,
    stable_swap_threshold: float,
) -> list[BubbleSample]:
    items = list(page.bubbles)
    probability_cache: dict[tuple[int, int], float] = {}

    def probability_index(i: int, j: int) -> float:
        key = (i, j)
        if key not in probability_cache:
            probability_cache[key] = model.predict_proba(
                feature_builder(page, items[i], items[j], context)
            )
        return probability_cache[key]

    if reconstruction_method in {"borda", "borda-vertical-repair"}:
        scores = {index: 0.0 for index in range(len(items))}
        for i in range(len(items)):
            for j in range(len(items)):
                if i != j:
                    scores[i] += probability_index(i, j)
        ordered = [
            items[index]
            for index in sorted(range(len(items)), key=lambda item: (-scores[item], item))
        ]
        if reconstruction_method == "borda-vertical-repair":
            return apply_vertical_small_bubble_repair(ordered, context)
        return ordered

    if reconstruction_method == "bradley-terry":
        scores = {index: 0.0 for index in range(len(items))}
        for i in range(len(items)):
            for j in range(len(items)):
                if i == j:
                    continue
                probability = min(0.999, max(0.001, probability_index(i, j)))
                scores[i] += math.log(probability / (1.0 - probability))
        return [
            items[index]
            for index in sorted(range(len(items)), key=lambda item: (-scores[item], item))
        ]

    if reconstruction_method == "topological":
        scores = {index: 0.0 for index in range(len(items))}
        outgoing: dict[int, set[int]] = {index: set() for index in range(len(items))}
        incoming: dict[int, set[int]] = {index: set() for index in range(len(items))}
        for i in range(len(items)):
            for j in range(len(items)):
                if i == j:
                    continue
                probability = probability_index(i, j)
                scores[i] += probability
                if probability > 0.5:
                    outgoing[i].add(j)
                    incoming[j].add(i)

        remaining = set(range(len(items)))
        ordered_indices: list[int] = []
        while remaining:
            ready = [index for index in remaining if not incoming[index] & remaining]
            if ready:
                selected = min(ready, key=lambda index: (-scores[index], index))
            else:
                selected = min(remaining, key=lambda index: (-scores[index], index))
            ordered_indices.append(selected)
            remaining.remove(selected)
        return [items[index] for index in ordered_indices]

    if reconstruction_method == "stable-local":
        current_order = [
            bubble
            for bubble in context.predicted_bubble_order
            if bubble.bubble_id in {item.bubble_id for item in items}
        ]
        if len(current_order) != len(items):
            current_order = manga_order_sort(items)
        index_by_id = {bubble.bubble_id: index for index, bubble in enumerate(items)}
        ordered = list(current_order)
        for _ in range(max(1, len(ordered))):
            changed = False
            for index in range(len(ordered) - 1):
                left = index_by_id[ordered[index].bubble_id]
                right = index_by_id[ordered[index + 1].bubble_id]
                if probability_index(right, left) >= stable_swap_threshold:
                    ordered[index], ordered[index + 1] = ordered[index + 1], ordered[index]
                    changed = True
            if not changed:
                break
        return ordered

    raise ValueError(f"Unsupported reconstruction method: {reconstruction_method}")


def page_pairwise_stats(gt_ids: Sequence[int], predicted_ids: Sequence[int]) -> tuple[int, int]:
    gt_position = {bubble_id: index for index, bubble_id in enumerate(gt_ids)}
    predicted_position = {bubble_id: index for index, bubble_id in enumerate(predicted_ids)}
    correct = 0
    total = 0
    for i in range(len(gt_ids)):
        for j in range(i + 1, len(gt_ids)):
            a = gt_ids[i]
            b = gt_ids[j]
            total += 1
            if a not in predicted_position or b not in predicted_position:
                continue
            if (gt_position[a] < gt_position[b]) == (
                predicted_position[a] < predicted_position[b]
            ):
                correct += 1
    return correct, total


def evaluate_pages(
    pages: Sequence[PageSample],
    experiment_name: str,
    order_provider: Callable[[PageSample], list[BubbleSample]],
    context_provider: Callable[[PageSample], PipelineContext | None],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    page_exact: list[bool] = []
    panel_exact: list[bool] = []
    within_panel_exact: list[bool] = []
    position_correct = 0
    position_total = 0
    pairwise_correct = 0
    pairwise_total = 0
    inversion_counts: list[int] = []
    error_counts = {
        "wrong_panel_order": 0,
        "wrong_order_in_panel": 0,
        "wrong_bubble_panel_assignment": 0,
        "bubble_outside_panel": 0,
        "empty_or_missing_panels": 0,
        "fallback_mangaOrderSort_used": 0,
    }
    predictions: list[dict[str, Any]] = []

    for page in pages:
        context = context_provider(page)
        gt_bubbles = gt_bubble_order(page)
        gt_ids = [bubble.bubble_id for bubble in gt_bubbles]
        predicted_bubbles = order_provider(page)
        predicted_ids = [bubble.bubble_id for bubble in predicted_bubbles]
        is_exact = predicted_ids == gt_ids
        page_exact.append(is_exact)

        for index, expected_id in enumerate(gt_ids):
            position_total += 1
            if index < len(predicted_ids) and predicted_ids[index] == expected_id:
                position_correct += 1

        page_pairwise_correct, page_pairwise_total = page_pairwise_stats(gt_ids, predicted_ids)
        pairwise_correct += page_pairwise_correct
        pairwise_total += page_pairwise_total
        inversion_counts.append(page_pairwise_total - page_pairwise_correct)

        gt_panels = [panel.panel_id for panel in gt_panel_order(page)]
        if context is not None and context.predicted_panel_order:
            panel_match = list(context.predicted_panel_order) == gt_panels
            panel_exact.append(panel_match)
            if not panel_match:
                error_counts["wrong_panel_order"] += 1
        elif context is not None:
            error_counts["empty_or_missing_panels"] += 1

        page_has_within_error = False
        predicted_position = {
            bubble_id: index for index, bubble_id in enumerate(predicted_ids)
        }
        for panel in page.panels:
            local_gt = [bubble.bubble_id for bubble in sorted(panel.bubbles, key=lambda item: item.order)]
            if len(local_gt) <= 1:
                continue
            local_pred = [
                bubble_id
                for bubble_id in sorted(
                    local_gt,
                    key=lambda bubble_id: predicted_position.get(bubble_id, 10**9),
                )
            ]
            local_match = local_pred == local_gt
            within_panel_exact.append(local_match)
            if not local_match:
                page_has_within_error = True
        if page_has_within_error:
            error_counts["wrong_order_in_panel"] += 1

        assignment_errors: list[int] = []
        outside_panel: list[int] = []
        if context is not None:
            if context.fallback_used:
                error_counts["fallback_mangaOrderSort_used"] += 1
            if not context.predicted_panels or context.empty_panel_count:
                error_counts["empty_or_missing_panels"] += 1
            for bubble in page.bubbles:
                info = context.bubble_context.get(bubble.bubble_id)
                if info is None:
                    assignment_errors.append(bubble.bubble_id)
                    outside_panel.append(bubble.bubble_id)
                    continue
                if info.predicted_panel_id != bubble.panel_id:
                    assignment_errors.append(bubble.bubble_id)
                if info.assignment.panel_index < 0 or (
                    not info.assignment.center_inside
                    and info.assignment.overlap_ratio <= 0.0
                ):
                    outside_panel.append(bubble.bubble_id)
        if assignment_errors:
            error_counts["wrong_bubble_panel_assignment"] += 1
        if outside_panel:
            error_counts["bubble_outside_panel"] += 1

        predictions.append(
            {
                "experiment": experiment_name,
                "page_id": page.page_id,
                "full_accuracy_match": is_exact,
                "ground_truth_panel_order": gt_panels,
                "predicted_panel_order": (
                    list(context.predicted_panel_order) if context is not None else None
                ),
                "ground_truth_bubble_order": gt_ids,
                "predicted_bubble_order": predicted_ids,
                "pairwise_correct": page_pairwise_correct,
                "pairwise_total": page_pairwise_total,
                "inversions": page_pairwise_total - page_pairwise_correct,
                "context_mode": context.mode if context is not None else None,
                "fallback_used": context.fallback_used if context is not None else False,
                "assignment_errors": assignment_errors,
                "outside_panel_bubbles": outside_panel,
            }
        )

    page_count = len(pages)
    avg_inversions = (
        sum(inversion_counts) / len(inversion_counts) if inversion_counts else None
    )
    metrics = {
        "page_full_accuracy": exact_accuracy(page_exact),
        "page_exact_matches": sum(1 for value in page_exact if value),
        "page_count": page_count,
        "bubble_position_accuracy": (
            position_correct / position_total if position_total else None
        ),
        "bubble_position_correct": position_correct,
        "bubble_position_total": position_total,
        "global_pairwise_accuracy": (
            pairwise_correct / pairwise_total if pairwise_total else None
        ),
        "global_pairwise_correct": pairwise_correct,
        "global_pairwise_total": pairwise_total,
        "kendall_tau_distance_mean": avg_inversions,
        "inversion_count_total": sum(inversion_counts),
        "panel_order_full_accuracy": exact_accuracy(panel_exact),
        "bubble_within_panel_full_accuracy": exact_accuracy(within_panel_exact),
        "error_categories": {
            key: {
                "pages": value,
                "rate": value / page_count if page_count else None,
            }
            for key, value in error_counts.items()
        },
    }
    return metrics, predictions


def evaluate_experiment(
    name: str,
    family: str,
    description: str,
    split_pages_by_name: dict[str, list[PageSample]],
    order_provider: Callable[[PageSample], list[BubbleSample]],
    context_provider: Callable[[PageSample], PipelineContext | None],
    runtime_compatible: bool,
    ranker_type: str | None,
    reconstruction_method: str | None,
    feature_count: int | None,
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    split_metrics: dict[str, Any] = {}
    split_predictions: dict[str, list[dict[str, Any]]] = {}
    for split_name, pages in split_pages_by_name.items():
        metrics, predictions = evaluate_pages(
            pages,
            name,
            order_provider,
            context_provider,
        )
        split_metrics[split_name] = metrics
        split_predictions[split_name] = predictions

    return (
        {
            "name": name,
            "family": family,
            "description": description,
            "runtime_compatible": runtime_compatible,
            "ranker_type": ranker_type,
            "reconstruction_method": reconstruction_method,
            "feature_count": feature_count,
            "metrics": split_metrics,
        },
        split_predictions,
    )


def split_train_validation(
    pages: Sequence[PageSample],
    validation_size: float,
    seed: int,
) -> tuple[list[PageSample], list[PageSample]]:
    if len(pages) < 3:
        return list(pages), []
    shuffled = sorted(pages, key=lambda page: page.page_id)
    random.Random(seed).shuffle(shuffled)
    validation_count = int(round(len(shuffled) * validation_size))
    validation_count = max(1, min(len(shuffled) - 1, validation_count))
    return shuffled[validation_count:], shuffled[:validation_count]


def train_current_pipeline(
    train_pages: Sequence[PageSample],
    heuristic_pages: Sequence[PageSample],
    args: argparse.Namespace,
) -> dict[str, Any]:
    panel_pairs = build_panel_pairs(train_pages)
    bubble_pairs = build_bubble_pairs(train_pages)
    panel_model = create_ranker("panel_order", args.current_ranker, seed=args.seed)
    panel_training = panel_model.fit(
        panel_pairs,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        l2=args.l2,
        seed=args.seed,
    )
    bubble_model = create_ranker("bubble_order", args.current_ranker, seed=args.seed + 17)
    bubble_training = bubble_model.fit(
        bubble_pairs,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        l2=args.l2,
        seed=args.seed + 17,
    )
    selected_blend = select_heuristic_weights(
        heuristic_pages or train_pages,
        panel_model,
        bubble_model,
        candidates=parse_float_list(args.heuristic_weights),
        vertical_override_candidates=parse_gap_candidates(args.vertical_override_gaps),
    )
    return {
        "panel_model": panel_model,
        "bubble_model": bubble_model,
        "panel_training": panel_training,
        "bubble_training": bubble_training,
        "panel_pairs": len(panel_pairs.labels),
        "bubble_pairs": len(bubble_pairs.labels),
        "heuristic_blend": selected_blend,
    }


def build_contexts(
    pages: Sequence[PageSample],
    current: dict[str, Any],
    assignment_strategy: str,
) -> dict[int, PipelineContext]:
    blend = current["heuristic_blend"]
    return {
        page.page_id: make_pipeline_context(
            page,
            current["panel_model"],
            current["bubble_model"],
            panel_heuristic_weight=blend["panel_heuristic_weight"],
            bubble_heuristic_weight=blend["bubble_heuristic_weight"],
            bubble_vertical_override_gap=blend["bubble_vertical_override_gap"],
            assignment_strategy=assignment_strategy,
        )
        for page in pages
    }


def detection_candidates_for_page(
    page: PageSample,
    prediction: DetectionPrediction,
    panel_match_iou: float,
    bubble_match_iou: float,
) -> tuple[
    tuple[PanelSample, ...],
    tuple[BubbleSample, ...],
    dict[str, float],
    dict[int, float],
]:
    used_panel_ids: set[str] = set()
    panel_candidates: list[PanelSample] = []
    panel_confidences: dict[str, float] = {}

    for index, detected_panel in enumerate(prediction.panels):
        match, score = best_unmatched_iou(
            detected_panel.box,
            page.panels,
            used_panel_ids,
            lambda panel: panel.panel_id,
        )
        if match is not None and score >= panel_match_iou:
            panel_id = match.panel_id
            order = match.order
            used_panel_ids.add(panel_id)
        else:
            panel_id = f"det_panel_{index + 1}"
            order = 10_000 + index
        panel_candidates.append(
            PanelSample(
                panel_id=panel_id,
                order=order,
                box=detected_panel.box,
                bubbles=tuple(),
            )
        )
        panel_confidences[panel_id] = detected_panel.confidence

    used_bubble_ids: set[int] = set()
    bubble_candidates: list[BubbleSample] = []
    bubble_confidences: dict[int, float] = {}
    gt_bubbles = list(page.bubbles)

    for index, detected_bubble in enumerate(prediction.bubbles):
        match, score = best_unmatched_iou(
            detected_bubble.box,
            gt_bubbles,
            used_bubble_ids,
            lambda bubble: bubble.bubble_id,
        )
        if match is not None and score >= bubble_match_iou:
            bubble_id = match.bubble_id
            order = match.order
            panel_id = match.panel_id
            panel_order = match.panel_order
            panel_box = match.panel_box
            used_bubble_ids.add(bubble_id)
        else:
            bubble_id = -1_000_000 - index
            order = 10_000 + index
            panel_id = "__unmatched_detection__"
            panel_order = 10_000
            panel_box = full_page_box(page)
        bubble_candidates.append(
            BubbleSample(
                bubble_id=bubble_id,
                order=order,
                box=detected_bubble.box,
                panel_id=panel_id,
                panel_order=panel_order,
                panel_box=panel_box,
            )
        )
        bubble_confidences[bubble_id] = detected_bubble.confidence

    return (
        tuple(panel_candidates),
        tuple(bubble_candidates),
        panel_confidences,
        bubble_confidences,
    )


def build_detection_contexts(
    pages: Sequence[PageSample],
    current: dict[str, Any],
    detections: dict[int, DetectionPrediction],
    panel_match_iou: float,
    bubble_match_iou: float,
) -> tuple[dict[int, PipelineContext], dict[str, Any]]:
    blend = current["heuristic_blend"]
    contexts: dict[int, PipelineContext] = {}
    matched_pages = 0
    pages_without_predictions = 0
    total_detected_bubbles = 0
    total_detected_panels = 0

    for page in pages:
        prediction = detections.get(page.page_id)
        if prediction is None:
            pages_without_predictions += 1
            contexts[page.page_id] = make_pipeline_context(
                page,
                current["panel_model"],
                current["bubble_model"],
                panel_heuristic_weight=blend["panel_heuristic_weight"],
                bubble_heuristic_weight=blend["bubble_heuristic_weight"],
                bubble_vertical_override_gap=blend["bubble_vertical_override_gap"],
                assignment_strategy="detector_replay_missing",
                panel_candidates=tuple(),
                bubble_candidates=tuple(page.bubbles),
            )
            continue

        matched_pages += 1
        total_detected_bubbles += len(prediction.bubbles)
        total_detected_panels += len(prediction.panels)
        (
            panel_candidates,
            bubble_candidates,
            panel_confidences,
            bubble_confidences,
        ) = detection_candidates_for_page(
            page,
            prediction,
            panel_match_iou=panel_match_iou,
            bubble_match_iou=bubble_match_iou,
        )
        contexts[page.page_id] = make_pipeline_context(
            page,
            current["panel_model"],
            current["bubble_model"],
            panel_heuristic_weight=blend["panel_heuristic_weight"],
            bubble_heuristic_weight=blend["bubble_heuristic_weight"],
            bubble_vertical_override_gap=blend["bubble_vertical_override_gap"],
            assignment_strategy="detector_replay",
            panel_candidates=panel_candidates,
            bubble_candidates=bubble_candidates,
            panel_confidences=panel_confidences,
            bubble_confidences=bubble_confidences,
        )

    return contexts, {
        "status": "consumed",
        "matched_pages": matched_pages,
        "pages_without_predictions": pages_without_predictions,
        "detected_bubbles": total_detected_bubbles,
        "detected_panels": total_detected_panels,
        "panel_match_iou": panel_match_iou,
        "bubble_match_iou": bubble_match_iou,
    }


def train_candidate_model(
    name: str,
    ranker_type: str,
    dataset: PairDataset,
    args: argparse.Namespace,
    seed_offset: int,
) -> tuple[Any, dict[str, Any]]:
    model = create_ranker(name, ranker_type, seed=args.seed + seed_offset)
    training = model.fit(
        dataset,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        l2=args.l2,
        seed=args.seed + seed_offset,
    )
    return model, training


def metric_value(experiment: dict[str, Any], split: str, name: str) -> float:
    value = experiment["metrics"].get(split, {}).get(name)
    return float(value) if value is not None else -1.0


def experiment_sort_key(experiment: dict[str, Any]) -> tuple[float, float, float]:
    return (
        metric_value(experiment, "test", "page_full_accuracy"),
        metric_value(experiment, "test", "global_pairwise_accuracy"),
        metric_value(experiment, "test", "bubble_position_accuracy"),
    )


def experiment_table(experiments: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for experiment in sorted(experiments, key=experiment_sort_key, reverse=True):
        test_metrics = experiment["metrics"].get("test", {})
        rows.append(
            {
                "name": experiment["name"],
                "family": experiment["family"],
                "runtime_compatible": experiment["runtime_compatible"],
                "page_full_accuracy": test_metrics.get("page_full_accuracy"),
                "page_exact_matches": test_metrics.get("page_exact_matches"),
                "page_count": test_metrics.get("page_count"),
                "global_pairwise_accuracy": test_metrics.get("global_pairwise_accuracy"),
                "bubble_position_accuracy": test_metrics.get("bubble_position_accuracy"),
                "panel_order_full_accuracy": test_metrics.get("panel_order_full_accuracy"),
                "bubble_within_panel_full_accuracy": test_metrics.get(
                    "bubble_within_panel_full_accuracy"
                ),
                "kendall_tau_distance_mean": test_metrics.get(
                    "kendall_tau_distance_mean"
                ),
                "ranker_type": experiment.get("ranker_type"),
                "reconstruction_method": experiment.get("reconstruction_method"),
                "feature_count": experiment.get("feature_count"),
            }
        )
    return rows


def candidate_selection_key(
    experiment: dict[str, Any],
) -> tuple[float, float, float, float, float, float, int]:
    return (
        metric_value(experiment, "validation", "page_full_accuracy"),
        metric_value(experiment, "validation", "global_pairwise_accuracy"),
        metric_value(experiment, "validation", "bubble_position_accuracy"),
        metric_value(experiment, "train", "page_full_accuracy"),
        metric_value(experiment, "train", "global_pairwise_accuracy"),
        metric_value(experiment, "train", "bubble_position_accuracy"),
        1 if experiment["runtime_compatible"] else 0,
    )


def beats_baseline(candidate: dict[str, Any], baseline: dict[str, Any]) -> bool:
    candidate_test = candidate["metrics"]["test"]
    baseline_test = baseline["metrics"]["test"]
    candidate_page = candidate_test.get("page_full_accuracy") or 0.0
    baseline_page = baseline_test.get("page_full_accuracy") or 0.0
    candidate_matches = candidate_test.get("page_exact_matches") or 0
    baseline_matches = baseline_test.get("page_exact_matches") or 0
    if not (candidate_page > baseline_page or candidate_matches > baseline_matches):
        return False
    return (
        (candidate_test.get("global_pairwise_accuracy") or 0.0)
        >= (baseline_test.get("global_pairwise_accuracy") or 0.0)
        and (candidate_test.get("bubble_position_accuracy") or 0.0)
        >= (baseline_test.get("bubble_position_accuracy") or 0.0)
        and (
            baseline_test.get("panel_order_full_accuracy") is None
            or candidate_test.get("panel_order_full_accuracy") is None
            or (candidate_test.get("panel_order_full_accuracy") or 0.0)
            >= (baseline_test.get("panel_order_full_accuracy") or 0.0) - 0.01
        )
    )


def metric_delta(
    candidate: dict[str, Any],
    baseline: dict[str, Any],
    split: str,
    metric: str,
) -> float | int | None:
    candidate_value = candidate["metrics"].get(split, {}).get(metric)
    baseline_value = baseline["metrics"].get(split, {}).get(metric)
    if candidate_value is None or baseline_value is None:
        return None
    return candidate_value - baseline_value


def compact_page_delta(
    page_id: int,
    baseline_page: dict[str, Any],
    candidate_page: dict[str, Any],
) -> dict[str, Any]:
    return {
        "page_id": page_id,
        "ground_truth_bubble_order": candidate_page.get("ground_truth_bubble_order")
        or baseline_page.get("ground_truth_bubble_order"),
        "baseline_predicted_bubble_order": baseline_page.get("predicted_bubble_order"),
        "candidate_predicted_bubble_order": candidate_page.get("predicted_bubble_order"),
        "baseline_inversions": baseline_page.get("inversions"),
        "candidate_inversions": candidate_page.get("inversions"),
        "baseline_assignment_errors": baseline_page.get("assignment_errors", []),
        "candidate_assignment_errors": candidate_page.get("assignment_errors", []),
        "baseline_outside_panel_bubbles": baseline_page.get("outside_panel_bubbles", []),
        "candidate_outside_panel_bubbles": candidate_page.get("outside_panel_bubbles", []),
        "baseline_fallback_used": baseline_page.get("fallback_used", False),
        "candidate_fallback_used": candidate_page.get("fallback_used", False),
    }


def compare_against_baseline(
    baseline: dict[str, Any],
    candidate: dict[str, Any] | None,
    predictions: dict[str, dict[str, list[dict[str, Any]]]],
    split: str = "test",
) -> dict[str, Any] | None:
    if candidate is None:
        return None

    baseline_pages = {
        int(item["page_id"]): item
        for item in predictions.get(baseline["name"], {}).get(split, [])
    }
    candidate_pages = {
        int(item["page_id"]): item
        for item in predictions.get(candidate["name"], {}).get(split, [])
    }
    common_page_ids = sorted(set(baseline_pages) & set(candidate_pages))

    corrected_pages: list[dict[str, Any]] = []
    regressed_pages: list[dict[str, Any]] = []
    still_wrong_pages: list[dict[str, Any]] = []
    changed_wrong_pages: list[dict[str, Any]] = []

    for page_id in common_page_ids:
        baseline_page = baseline_pages[page_id]
        candidate_page = candidate_pages[page_id]
        baseline_exact = bool(baseline_page.get("full_accuracy_match"))
        candidate_exact = bool(candidate_page.get("full_accuracy_match"))
        if not baseline_exact and candidate_exact:
            corrected_pages.append(compact_page_delta(page_id, baseline_page, candidate_page))
        elif baseline_exact and not candidate_exact:
            regressed_pages.append(compact_page_delta(page_id, baseline_page, candidate_page))
        elif not baseline_exact and not candidate_exact:
            still_wrong_pages.append(compact_page_delta(page_id, baseline_page, candidate_page))
            if baseline_page.get("predicted_bubble_order") != candidate_page.get(
                "predicted_bubble_order"
            ):
                changed_wrong_pages.append(
                    compact_page_delta(page_id, baseline_page, candidate_page)
                )

    return {
        "split": split,
        "baseline_experiment": baseline["name"],
        "candidate_experiment": candidate["name"],
        "common_page_count": len(common_page_ids),
        "metric_deltas": {
            "page_full_accuracy": metric_delta(
                candidate, baseline, split, "page_full_accuracy"
            ),
            "page_exact_matches": metric_delta(
                candidate, baseline, split, "page_exact_matches"
            ),
            "bubble_position_accuracy": metric_delta(
                candidate, baseline, split, "bubble_position_accuracy"
            ),
            "global_pairwise_accuracy": metric_delta(
                candidate, baseline, split, "global_pairwise_accuracy"
            ),
            "kendall_tau_distance_mean": metric_delta(
                candidate, baseline, split, "kendall_tau_distance_mean"
            ),
            "inversion_count_total": metric_delta(
                candidate, baseline, split, "inversion_count_total"
            ),
        },
        "corrected_pages": corrected_pages,
        "regressed_pages": regressed_pages,
        "still_wrong_pages": still_wrong_pages,
        "changed_but_still_wrong_pages": changed_wrong_pages,
    }


def verify_onnx_parity(
    model: Any,
    onnx_path: Path,
    samples: Sequence[Sequence[float]],
    tolerance: float = 1e-5,
) -> dict[str, Any]:
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    checked = 0
    max_abs_diff = 0.0
    for sample in samples[:32]:
        row = np.asarray([list(sample)], dtype=np.float32)
        onnx_probability = float(session.run(None, {"features": row})[0][0][0])
        python_probability = float(model.predict_proba(row[0].tolist()))
        diff = abs(onnx_probability - python_probability)
        max_abs_diff = max(max_abs_diff, diff)
        checked += 1
        if diff > tolerance:
            raise ValueError(
                f"ONNX parity failed for {onnx_path}: "
                f"python={python_probability}, onnx={onnx_probability}, diff={diff}"
            )
    return {
        "checked_samples": checked,
        "max_abs_diff": max_abs_diff,
        "tolerance": tolerance,
    }


def write_markdown_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if payload.get("status") == "blocked":
        content = f"""# Reading order experiments

Generated: {payload["created_at"]}

## Status

Blocked before benchmark execution.

Reason: {payload["reason"]}

## Required input

- `{payload["annotations"]}`
- `{payload["split_manifest"]}` when the panel detector holdout split should be reused

## Reproduction

```powershell
python docker_scripts/train_reading_order/train_reading_order.py
python docker_scripts/train_reading_order/benchmark_reading_order.py
python docker_scripts/package_one_shot_models/prepare_and_upload.py
cd frontend
npm run lint
npm run build
```
"""
        path.write_text(content, encoding="utf-8")
        return

    rows = payload["experiments_table"][:20]
    table_lines = [
        "| Experiment | Runtime | Test full | Pairwise | Position | Exact |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        exact = (
            f"{row['page_exact_matches']}/{row['page_count']}"
            if row["page_exact_matches"] is not None
            else "n/a"
        )
        table_lines.append(
            "| {name} | {runtime} | {full:.4f} | {pair:.4f} | {position:.4f} | {exact} |".format(
                name=row["name"],
                runtime="yes" if row["runtime_compatible"] else "no",
                full=row["page_full_accuracy"] or 0.0,
                pair=row["global_pairwise_accuracy"] or 0.0,
                position=row["bubble_position_accuracy"] or 0.0,
                exact=exact,
            )
        )

    selected = payload["selection"]["selected_by_validation"]
    selected_runtime = payload["selection"].get("selected_runtime_candidate")
    decision = payload["selection"]["runtime_decision"]
    baseline_comparison = payload.get("baseline_comparison")
    selected_for_metrics = selected_runtime or selected

    selected_metrics_lines = [
        "| Split | Full | Pairwise | Position | Exact | Inversions |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    if selected_for_metrics:
        for split_name in ("train", "validation", "test"):
            metrics = selected_for_metrics.get("metrics", {}).get(split_name, {})
            exact = (
                f"{metrics.get('page_exact_matches')}/{metrics.get('page_count')}"
                if metrics.get("page_exact_matches") is not None
                else "n/a"
            )
            selected_metrics_lines.append(
                "| {split} | {full:.4f} | {pair:.4f} | {position:.4f} | {exact} | {inversions} |".format(
                    split=split_name,
                    full=metrics.get("page_full_accuracy") or 0.0,
                    pair=metrics.get("global_pairwise_accuracy") or 0.0,
                    position=metrics.get("bubble_position_accuracy") or 0.0,
                    exact=exact,
                    inversions=metrics.get("inversion_count_total", "n/a"),
                )
            )
    else:
        selected_metrics_lines.append("| n/a | 0.0000 | 0.0000 | 0.0000 | n/a | n/a |")

    def page_ids(items: Sequence[dict[str, Any]]) -> str:
        ids = [str(item["page_id"]) for item in items]
        return ", ".join(ids) if ids else "none"

    def page_delta_lines(items: Sequence[dict[str, Any]], limit: int = 12) -> str:
        if not items:
            return "- none"
        lines = []
        for item in items[:limit]:
            lines.append(
                "- page {page_id}: inversions {base_inv} -> {cand_inv}, "
                "assignment errors {base_assign} -> {cand_assign}, "
                "outside-panel bubbles {base_outside} -> {cand_outside}".format(
                    page_id=item["page_id"],
                    base_inv=item.get("baseline_inversions"),
                    cand_inv=item.get("candidate_inversions"),
                    base_assign=len(item.get("baseline_assignment_errors", [])),
                    cand_assign=len(item.get("candidate_assignment_errors", [])),
                    base_outside=len(item.get("baseline_outside_panel_bubbles", [])),
                    cand_outside=len(item.get("candidate_outside_panel_bubbles", [])),
                )
            )
        if len(items) > limit:
            lines.append(f"- ... {len(items) - limit} more")
        return "\n".join(lines)

    baseline_comparison_section = ""
    if baseline_comparison:
        deltas = baseline_comparison.get("metric_deltas", {})
        corrected = baseline_comparison.get("corrected_pages", [])
        regressed = baseline_comparison.get("regressed_pages", [])
        still_wrong = baseline_comparison.get("still_wrong_pages", [])
        changed_wrong = baseline_comparison.get("changed_but_still_wrong_pages", [])
        baseline_comparison_section = f"""
## Baseline comparison

- Baseline: `{baseline_comparison["baseline_experiment"]}`
- Candidate: `{baseline_comparison["candidate_experiment"]}`
- Compared split: {baseline_comparison["split"]} ({baseline_comparison["common_page_count"]} pages)
- Delta page_full_accuracy: {deltas.get("page_full_accuracy", 0.0):+.4f}
- Delta page_exact_matches: {deltas.get("page_exact_matches", 0):+}
- Delta global_pairwise_accuracy: {deltas.get("global_pairwise_accuracy", 0.0):+.4f}
- Delta bubble_position_accuracy: {deltas.get("bubble_position_accuracy", 0.0):+.4f}
- Delta inversion_count_total: {deltas.get("inversion_count_total", 0):+}
- Corrected pages: {page_ids(corrected)}
- Regressed pages: {page_ids(regressed)}
- Still wrong pages: {page_ids(still_wrong)}
- Changed but still wrong pages: {page_ids(changed_wrong)}

### Corrected pages

{page_delta_lines(corrected)}

### Regressed pages

{page_delta_lines(regressed)}

### Remaining wrong pages

{page_delta_lines(still_wrong)}
"""
    content = f"""# Reading order experiments

Generated: {payload["created_at"]}

## Current pipeline

The reference experiment is `current_panel_then_in_panel_ranker`: panel ranking,
worker-equivalent Borda pair aggregation, ground-truth panel membership, then
in-panel bubble ranking. `current_worker_assignment_gt_boxes` uses the same
ground-truth boxes but runs the browser assignment strategy before in-panel
ranking, which isolates assignment mistakes from detector mistakes.

## Protocol

- Split source: `{payload["split_source"]}`
- Development pages: {payload["dataset"]["development"]["pages"]}
- Train pages: {payload["dataset"]["train"]["pages"]}
- Validation pages: {payload["dataset"]["validation"]["pages"]}
- Test pages: {payload["dataset"]["test"]["pages"]}
- Candidate selection uses validation metrics only. The test split is reported
  as a holdout and is not used for hyperparameter choice. Train metrics are
  used only as a tie-breaker when validation metrics are identical.
- Real YOLO detector simulation: {payload["detection_simulation"]["status"]}

## Experiments

{chr(10).join(table_lines)}

## Selection

- Selected by validation: `{selected["name"] if selected else "none"}`
- Selected runtime candidate: `{selected_runtime["name"] if selected_runtime else "none"}`
- Runtime decision: {decision["status"]}
- Reason: {decision["reason"]}

## Selected model metrics

{chr(10).join(selected_metrics_lines)}

{baseline_comparison_section}

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
"""
    path.write_text(content, encoding="utf-8")


def write_blocked_outputs(args: argparse.Namespace, reason: str) -> int:
    payload = {
        "kind": "reading_order_benchmark",
        "status": "blocked",
        "created_at": now_iso(),
        "reason": reason,
        "annotations": str(args.annotations),
        "split_manifest": str(args.split_manifest),
    }
    write_json(args.metrics_output, payload)
    write_json(args.predictions_output, {"status": "blocked", "reason": reason})
    write_markdown_report(args.report_output, payload)
    print(f"[blocked] {reason}", file=sys.stderr)
    print(f"Wrote {args.metrics_output}")
    print(f"Wrote {args.predictions_output}")
    print(f"Wrote {args.report_output}")
    return 2


def run_benchmark(args: argparse.Namespace) -> int:
    if not args.annotations.exists():
        return write_blocked_outputs(
            args,
            f"Missing panel annotations file: {args.annotations}",
        )

    print("Loading reading-order pages...", flush=True)
    pages, skipped = load_pages(args.annotations)
    development_pages, test_pages, split_source = split_pages(
        pages,
        manifest_path=args.split_manifest if args.split_manifest.exists() else None,
        test_size=args.test_size,
        seed=args.seed,
    )
    train_pages, validation_pages = split_train_validation(
        development_pages,
        validation_size=args.validation_size,
        seed=args.seed + 101,
    )
    split_pages_by_name = {
        "train": train_pages,
        "validation": validation_pages,
        "test": test_pages,
    }
    all_eval_pages = [*train_pages, *validation_pages, *test_pages]

    print(
        "Training current pipeline baseline "
        f"({len(train_pages)} train / {len(validation_pages)} validation / "
        f"{len(test_pages)} test pages)...",
        flush=True,
    )
    current_full = train_current_pipeline(
        development_pages,
        heuristic_pages=development_pages,
        args=args,
    )
    print("Building pipeline contexts...", flush=True)
    current_contexts_gt = build_contexts(
        all_eval_pages,
        current_full,
        assignment_strategy="ground_truth",
    )
    current_contexts_worker = build_contexts(
        all_eval_pages,
        current_full,
        assignment_strategy="worker",
    )
    current_contexts_assignment_aware = build_contexts(
        all_eval_pages,
        current_full,
        assignment_strategy="assignment_aware",
    )
    detection_contexts: dict[int, PipelineContext] | None = None
    detection_summary: dict[str, Any] = {
        "status": "not_available",
        "note": "No --detection-predictions file was provided.",
    }
    if args.detection_predictions is not None:
        detections = load_detection_predictions(args.detection_predictions)
        detection_contexts, detection_summary = build_detection_contexts(
            all_eval_pages,
            current_full,
            detections,
            panel_match_iou=args.detection_panel_match_iou,
            bubble_match_iou=args.detection_bubble_match_iou,
        )
        detection_summary["path"] = str(args.detection_predictions)

    panel_less_contexts = {
        page.page_id: PipelineContext(
            page_id=page.page_id,
            mode="panel_less",
            predicted_panels=tuple(),
            predicted_panel_order=tuple(),
            predicted_bubble_order=tuple(manga_order_sort(page.bubbles)),
            bubble_context={},
            panel_details=tuple(),
            fallback_used=False,
            empty_panel_count=0,
        )
        for page in all_eval_pages
    }

    experiments: list[dict[str, Any]] = []
    predictions: dict[str, Any] = {}
    trained_models: dict[str, tuple[Any, PairDataset, list[str]]] = {}

    baseline, baseline_predictions = evaluate_experiment(
        name="current_panel_then_in_panel_ranker",
        family="current_pipeline",
        description="Current pipeline with ground-truth boxes and panel membership.",
        split_pages_by_name=split_pages_by_name,
        order_provider=lambda page: list(
            current_contexts_gt[page.page_id].predicted_bubble_order
        ),
        context_provider=lambda page: current_contexts_gt[page.page_id],
        runtime_compatible=True,
        ranker_type=args.current_ranker,
        reconstruction_method="borda",
        feature_count=None,
    )
    experiments.append(baseline)
    predictions[baseline["name"]] = baseline_predictions

    worker_baseline, worker_predictions = evaluate_experiment(
        name="current_worker_assignment_gt_boxes",
        family="current_pipeline",
        description=(
            "Current pipeline with ground-truth boxes and browser-equivalent "
            "bubble-to-panel assignment."
        ),
        split_pages_by_name=split_pages_by_name,
        order_provider=lambda page: list(
            current_contexts_worker[page.page_id].predicted_bubble_order
        ),
        context_provider=lambda page: current_contexts_worker[page.page_id],
        runtime_compatible=True,
        ranker_type=args.current_ranker,
        reconstruction_method="borda",
        feature_count=None,
    )
    experiments.append(worker_baseline)
    predictions[worker_baseline["name"]] = worker_predictions

    if detection_contexts is not None:
        print("Evaluating detector replay pipeline...", flush=True)
        detector_baseline, detector_predictions = evaluate_experiment(
            name="current_detector_replay_pipeline",
            family="current_pipeline",
            description=(
                "Current worker pipeline replayed from provided detector boxes. "
                "Detected boxes are matched back to GT ids by IoU for scoring."
            ),
            split_pages_by_name=split_pages_by_name,
            order_provider=lambda page: list(
                detection_contexts[page.page_id].predicted_bubble_order
            ),
            context_provider=lambda page: detection_contexts[page.page_id],
            runtime_compatible=True,
            ranker_type=args.current_ranker,
            reconstruction_method="borda",
            feature_count=None,
        )
        experiments.append(detector_baseline)
        predictions[detector_baseline["name"]] = detector_predictions

    ranker_types = [
        item.strip()
        for item in args.candidate_rankers.split(",")
        if item.strip()
    ]
    reconstruction_methods = [
        item.strip()
        for item in args.reconstruction_methods.split(",")
        if item.strip()
    ]

    for ranker_type in ranker_types:
        if ranker_type not in RANKER_CHOICES:
            raise ValueError(f"Unsupported ranker type: {ranker_type}")
        for family, contexts, feature_builder, feature_schema in [
            (
                "global_bubble_reranker_v1",
                current_contexts_worker,
                global_pair_features,
                global_feature_names(),
            ),
            (
                "assignment_aware_global_reranker",
                current_contexts_assignment_aware,
                global_pair_features,
                global_feature_names(),
            ),
            (
                "page_level_no_panel_ranker",
                panel_less_contexts,
                panel_less_pair_features,
                pair_feature_names("page"),
            ),
        ]:
            print(f"Training candidate {family} / {ranker_type}...", flush=True)
            dataset = build_global_pair_dataset(
                train_pages,
                contexts,
                feature_builder,
            )
            model_name = f"{family}__{ranker_type}"
            model, training = train_candidate_model(
                model_name,
                ranker_type,
                dataset,
                args,
                seed_offset=len(trained_models) * 31 + 503,
            )
            for method in reconstruction_methods:
                if method not in RECONSTRUCTION_CHOICES:
                    raise ValueError(f"Unsupported reconstruction method: {method}")
                experiment_name = f"{family}__{ranker_type}__{method}"
                print(f"  Evaluating {experiment_name}...", flush=True)

                def order_provider(
                    page: PageSample,
                    *,
                    trained_model: Any = model,
                    context_map: dict[int, PipelineContext] = contexts,
                    builder: Callable[
                        [PageSample, BubbleSample, BubbleSample, PipelineContext],
                        list[float],
                    ] = feature_builder,
                    reconstruction: str = method,
                ) -> list[BubbleSample]:
                    return predict_pairwise_order(
                        page,
                        trained_model,
                        context_map[page.page_id],
                        builder,
                        reconstruction_method=reconstruction,
                        stable_swap_threshold=args.stable_swap_threshold,
                    )

                record, record_predictions = evaluate_experiment(
                    name=experiment_name,
                    family=family,
                    description=f"{family} using {ranker_type} and {method}.",
                    split_pages_by_name=split_pages_by_name,
                    order_provider=order_provider,
                    context_provider=lambda page, context_map=contexts: context_map[page.page_id],
                    runtime_compatible=is_runtime_compatible_candidate(
                        ranker_type,
                        method,
                    ),
                    ranker_type=ranker_type,
                    reconstruction_method=method,
                    feature_count=len(feature_schema),
                )
                record["training"] = training
                experiments.append(record)
                predictions[experiment_name] = record_predictions
                trained_models[experiment_name] = (model, dataset, feature_schema)

    table = experiment_table(experiments)
    candidate_experiments = [
        experiment
        for experiment in experiments
        if experiment["family"] != "current_pipeline"
    ]
    selected_by_validation = (
        max(candidate_experiments, key=candidate_selection_key)
        if candidate_experiments
        else None
    )
    compatible_candidates = [
        experiment for experiment in candidate_experiments if experiment["runtime_compatible"]
    ]
    selected_runtime = (
        max(compatible_candidates, key=candidate_selection_key)
        if compatible_candidates
        else None
    )

    runtime_decision = {
        "status": "not_enabled",
        "reason": "No runtime-compatible candidate beat the current baseline on holdout metrics.",
        "exported_onnx": None,
        "parity": None,
    }
    if selected_runtime is not None and beats_baseline(selected_runtime, baseline):
        if args.export_winning_onnx:
            model, dataset, feature_schema = trained_models[selected_runtime["name"]]
            onnx_path = export_linear_probability_onnx(
                model,
                args.output_dir / "models" / "global_bubble_order.onnx",
                {
                    "name": "global_bubble_order",
                    "ranker": selected_runtime["ranker_type"],
                },
            )
            if onnx_path is not None:
                metadata_path = args.output_dir / "models" / "global_bubble_order_model.json"
                postprocess = postprocess_metadata_for_experiment(selected_runtime)
                write_model_artifacts(
                    model,
                    metadata_path,
                    {
                        "experiment": selected_runtime["name"],
                        "feature_schema": feature_schema,
                        "selection": "validation",
                        "test_metrics": selected_runtime["metrics"]["test"],
                        "postprocess": postprocess,
                    },
                )
                write_json(
                    args.output_dir / "models" / "global_bubble_order_features.json",
                    {
                        "feature_count": len(feature_schema),
                        "features": feature_schema,
                        "experiment": selected_runtime["name"],
                        "postprocess": postprocess,
                    },
                )
                parity = verify_onnx_parity(
                    model,
                    onnx_path,
                    dataset.features,
                )
                runtime_decision = {
                    "status": "enabled_by_metrics",
                    "reason": "Selected runtime-compatible candidate beat the current baseline.",
                    "exported_onnx": str(onnx_path),
                    "parity": parity,
                    "feature_count": len(feature_schema),
                    "postprocess": postprocess,
                }
            else:
                runtime_decision = {
                    "status": "not_enabled",
                    "reason": "Selected candidate was not exportable to the linear ONNX path.",
                    "exported_onnx": None,
                    "parity": None,
                }
        else:
            runtime_decision = {
                "status": "eligible_not_exported",
                "reason": "Selected runtime-compatible candidate beat baseline, but export was disabled.",
                "exported_onnx": None,
                "parity": None,
                "postprocess": postprocess_metadata_for_experiment(selected_runtime),
            }

    baseline_comparison = (
        compare_against_baseline(
            baseline,
            selected_runtime,
            predictions,
            split="test",
        )
        if selected_runtime is not None
        else None
    )

    payload = {
        "kind": "reading_order_benchmark",
        "status": "complete",
        "created_at": now_iso(),
        "annotations": str(args.annotations),
        "split_source": split_source,
        "seed": args.seed,
        "skipped_pages": skipped,
        "dataset": {
            "all": summarize_pages(pages),
            "development": summarize_pages(development_pages),
            "train": summarize_pages(train_pages),
            "validation": summarize_pages(validation_pages),
            "test": summarize_pages(test_pages),
        },
        "train_page_ids": [page.page_id for page in train_pages],
        "validation_page_ids": [page.page_id for page in validation_pages],
        "test_page_ids": [page.page_id for page in test_pages],
        "current_pipeline": {
            "ranker": args.current_ranker,
            "panel_pairs": current_full["panel_pairs"],
            "bubble_pairs": current_full["bubble_pairs"],
            "heuristic_blend": current_full["heuristic_blend"],
        },
        "detection_simulation": detection_summary,
        "experiments": experiments,
        "experiments_table": table,
        "baseline_comparison": baseline_comparison,
        "selection": {
            "selected_by_validation": selected_by_validation,
            "selected_runtime_candidate": selected_runtime,
            "runtime_decision": runtime_decision,
            "acceptance_criteria": {
                "minimum": (
                    "page_full_accuracy > baseline or page_exact_matches > baseline, "
                    "with no regression in global_pairwise_accuracy or "
                    "bubble_position_accuracy"
                ),
                "baseline_experiment": baseline["name"],
            },
        },
    }
    write_json(args.metrics_output, payload)
    write_json(args.predictions_output, predictions)
    write_markdown_report(args.report_output, payload)

    print()
    print("=" * 80)
    print("Reading Order Benchmark")
    print("=" * 80)
    for row in table[:10]:
        print(
            f"{row['name']}: page_full={row['page_full_accuracy']:.4f} "
            f"pairwise={row['global_pairwise_accuracy']:.4f} "
            f"position={row['bubble_position_accuracy']:.4f} "
            f"exact={row['page_exact_matches']}/{row['page_count']}"
        )
    print("=" * 80)
    print(f"Runtime decision: {runtime_decision['status']} - {runtime_decision['reason']}")
    print(f"Wrote {args.metrics_output}")
    print(f"Wrote {args.predictions_output}")
    print(f"Wrote {args.report_output}")
    return 0


def refresh_exported_global_metadata(
    args: argparse.Namespace,
    selected_runtime: dict[str, Any] | None,
) -> None:
    if selected_runtime is None:
        return
    postprocess = postprocess_metadata_for_experiment(selected_runtime)
    feature_path = args.output_dir / "models" / "global_bubble_order_features.json"
    if feature_path.exists():
        feature_metadata = read_json(feature_path)
        feature_metadata["experiment"] = selected_runtime["name"]
        feature_metadata["postprocess"] = postprocess
        write_json(feature_path, feature_metadata)

    model_metadata_path = args.output_dir / "models" / "global_bubble_order_model.json"
    if model_metadata_path.exists():
        model_metadata = read_json(model_metadata_path)
        metadata = model_metadata.setdefault("metadata", {})
        metadata["experiment"] = selected_runtime["name"]
        metadata["selection"] = "validation"
        metadata["test_metrics"] = selected_runtime["metrics"]["test"]
        metadata["postprocess"] = postprocess
        write_json(model_metadata_path, model_metadata)


def refresh_report_only(args: argparse.Namespace) -> int:
    if not args.metrics_output.exists():
        print(f"Missing metrics file: {args.metrics_output}", file=sys.stderr)
        return 2
    if not args.predictions_output.exists():
        print(f"Missing predictions file: {args.predictions_output}", file=sys.stderr)
        return 2

    payload = read_json(args.metrics_output)
    if payload.get("status") != "complete":
        print(
            f"Cannot refresh report for non-complete benchmark: {payload.get('status')}",
            file=sys.stderr,
        )
        return 2

    predictions = read_json(args.predictions_output)
    experiment_records = payload.get("experiments", [])
    for experiment in experiment_records:
        if experiment.get("family") != "current_pipeline":
            experiment["runtime_compatible"] = is_runtime_compatible_candidate(
                experiment.get("ranker_type"),
                experiment.get("reconstruction_method"),
            )

    payload["experiments_table"] = experiment_table(experiment_records)
    experiments = {
        experiment["name"]: experiment
        for experiment in experiment_records
    }
    baseline_name = (
        payload.get("selection", {})
        .get("acceptance_criteria", {})
        .get("baseline_experiment", "current_panel_then_in_panel_ranker")
    )
    baseline = experiments.get(baseline_name)
    candidate_experiments = [
        experiment
        for experiment in experiment_records
        if experiment.get("family") != "current_pipeline"
    ]
    selected_by_validation = (
        max(candidate_experiments, key=candidate_selection_key)
        if candidate_experiments
        else None
    )
    compatible_candidates = [
        experiment for experiment in candidate_experiments if experiment["runtime_compatible"]
    ]
    selected_runtime = (
        max(compatible_candidates, key=candidate_selection_key)
        if compatible_candidates
        else None
    )

    if baseline is not None and selected_runtime is not None:
        payload["baseline_comparison"] = compare_against_baseline(
            baseline,
            selected_runtime,
            predictions,
            split="test",
        )

    runtime_decision = {
        "status": "not_enabled",
        "reason": "No runtime-compatible candidate beat the current baseline on holdout metrics.",
        "exported_onnx": None,
        "parity": None,
    }
    existing_decision = payload.get("selection", {}).get("runtime_decision", {})
    if (
        baseline is not None
        and selected_runtime is not None
        and beats_baseline(selected_runtime, baseline)
    ):
        onnx_path = args.output_dir / "models" / "global_bubble_order.onnx"
        postprocess = postprocess_metadata_for_experiment(selected_runtime)
        if onnx_path.exists():
            runtime_decision = {
                "status": "enabled_by_metrics",
                "reason": "Selected runtime-compatible candidate beat the current baseline.",
                "exported_onnx": str(onnx_path),
                "parity": existing_decision.get("parity"),
                "feature_count": selected_runtime.get("feature_count"),
                "postprocess": postprocess,
            }
            refresh_exported_global_metadata(args, selected_runtime)
        else:
            runtime_decision = {
                "status": "eligible_not_exported",
                "reason": "Selected runtime-compatible candidate beat baseline, but no ONNX export exists.",
                "exported_onnx": None,
                "parity": None,
                "feature_count": selected_runtime.get("feature_count"),
                "postprocess": postprocess,
            }

    selection = payload.setdefault("selection", {})
    selection["selected_by_validation"] = selected_by_validation
    selection["selected_runtime_candidate"] = selected_runtime
    selection["runtime_decision"] = runtime_decision

    write_json(args.metrics_output, payload)
    write_markdown_report(args.report_output, payload)
    print(f"Refreshed {args.metrics_output}")
    print(f"Refreshed {args.report_output}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark current and candidate manga bubble reading-order pipelines."
    )
    parser.add_argument("--annotations", type=Path, default=DEFAULT_ANNOTATIONS)
    parser.add_argument("--split-manifest", type=Path, default=DEFAULT_SPLIT_MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--metrics-output", type=Path, default=DEFAULT_BENCHMARK_METRICS)
    parser.add_argument(
        "--predictions-output",
        type=Path,
        default=DEFAULT_BENCHMARK_PREDICTIONS,
    )
    parser.add_argument("--report-output", type=Path, default=DEFAULT_EXPERIMENT_DOC)
    parser.add_argument(
        "--refresh-report-only",
        action="store_true",
        help=(
            "Refresh metrics/report from existing benchmark JSON and predictions "
            "without retraining candidate models."
        ),
    )
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--validation-size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--learning-rate", type=float, default=0.03)
    parser.add_argument("--l2", type=float, default=0.0001)
    parser.add_argument("--current-ranker", choices=RANKER_CHOICES, default="sklearn-logistic")
    parser.add_argument(
        "--candidate-rankers",
        default="sklearn-logistic,pure-logistic,extra-trees,hist-gradient-boosting",
    )
    parser.add_argument(
        "--reconstruction-methods",
        default="borda,borda-vertical-repair,bradley-terry,topological,stable-local",
    )
    parser.add_argument(
        "--heuristic-weights",
        default="0",
        help="Comma-separated blend weights used by the current panel/bubble baseline.",
    )
    parser.add_argument(
        "--vertical-override-gaps",
        default="off,0.5,0.75,1.0,1.25",
    )
    parser.add_argument("--stable-swap-threshold", type=float, default=0.62)
    parser.add_argument("--detection-predictions", type=Path, default=None)
    parser.add_argument("--detection-panel-match-iou", type=float, default=0.35)
    parser.add_argument("--detection-bubble-match-iou", type=float, default=0.35)
    parser.add_argument(
        "--no-export-winning-onnx",
        dest="export_winning_onnx",
        action="store_false",
    )
    parser.set_defaults(export_winning_onnx=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.refresh_report_only:
        sys.exit(refresh_report_only(args))
    sys.exit(run_benchmark(args))


if __name__ == "__main__":
    main()
