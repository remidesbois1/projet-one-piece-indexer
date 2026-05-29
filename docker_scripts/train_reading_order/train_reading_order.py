from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence, TypeVar

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

try:
    import joblib
    from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    SKLEARN_AVAILABLE = True
except ImportError:
    joblib = None
    ExtraTreesClassifier = None
    HistGradientBoostingClassifier = None
    LogisticRegression = None
    StandardScaler = None
    make_pipeline = None
    SKLEARN_AVAILABLE = False


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ANNOTATIONS = (
    SCRIPT_DIR.parent
    / "train_panel_detector"
    / "panel_annotation_dataset"
    / "panel_annotations.json"
)
DEFAULT_SPLIT_MANIFEST = SCRIPT_DIR.parent / "train_panel_detector" / "dataset" / "manifest.json"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR
T = TypeVar("T")


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float

    @property
    def x2(self) -> float:
        return self.x + self.w

    @property
    def y2(self) -> float:
        return self.y + self.h

    @property
    def cx(self) -> float:
        return self.x + self.w / 2.0

    @property
    def cy(self) -> float:
        return self.y + self.h / 2.0


@dataclass(frozen=True)
class BubbleSample:
    bubble_id: int
    order: int
    box: Box
    panel_id: str
    panel_order: int
    panel_box: Box


@dataclass(frozen=True)
class PanelSample:
    panel_id: str
    order: int
    box: Box
    bubbles: tuple[BubbleSample, ...]


@dataclass(frozen=True)
class PageSample:
    page_id: int
    width: float
    height: float
    panels: tuple[PanelSample, ...]

    @property
    def bubbles(self) -> tuple[BubbleSample, ...]:
        return tuple(bubble for panel in self.panels for bubble in panel.bubbles)


@dataclass
class PairDataset:
    features: list[list[float]]
    labels: list[int]
    groups: list[int]


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp_path.replace(path)


def to_int(value: Any, default: int | None = None) -> int | None:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_box(value: Any) -> Box | None:
    if not isinstance(value, dict):
        return None
    box = value.get("bbox") if isinstance(value.get("bbox"), dict) else value
    x = to_float(box.get("x"))
    y = to_float(box.get("y"))
    w = to_float(box.get("w"))
    h = to_float(box.get("h"))
    if w <= 0 or h <= 0:
        return None
    return Box(x=x, y=y, w=w, h=h)


def clamp(value: float, low: float = -20.0, high: float = 20.0) -> float:
    return max(low, min(high, value))


def safe_div(a: float, b: float) -> float:
    return 0.0 if b == 0 else a / b


def interval_overlap(a1: float, a2: float, b1: float, b2: float) -> float:
    return max(0.0, min(a2, b2) - max(a1, b1))


def box_features(box: Box, width: float, height: float) -> list[float]:
    area = max(1.0, width * height)
    return [
        safe_div(box.x, width),
        safe_div(box.y, height),
        safe_div(box.x2, width),
        safe_div(box.y2, height),
        safe_div(box.cx, width),
        safe_div(box.cy, height),
        safe_div(box.w, width),
        safe_div(box.h, height),
        safe_div(box.w * box.h, area),
        safe_div(box.w, box.h),
    ]


def pair_features(a: Box, b: Box, width: float, height: float) -> list[float]:
    dx = safe_div(a.cx - b.cx, width)
    dy = safe_div(a.cy - b.cy, height)
    abs_dx = abs(dx)
    abs_dy = abs(dy)
    x_overlap = safe_div(interval_overlap(a.x, a.x2, b.x, b.x2), min(a.w, b.w))
    y_overlap = safe_div(interval_overlap(a.y, a.y2, b.y, b.y2), min(a.h, b.h))
    distance = math.hypot(dx, dy)
    angle = safe_div(math.atan2(dy, dx), math.pi)
    same_reading_band = y_overlap > 0.35 or abs(a.cy - b.cy) <= max(a.h, b.h) * 0.35
    rtl_before = (a.cx > b.cx) if same_reading_band else (a.cy < b.cy)
    ltr_before = (a.cx < b.cx) if same_reading_band else (a.cy < b.cy)
    return [
        *box_features(a, width, height),
        *box_features(b, width, height),
        dx,
        dy,
        abs_dx,
        abs_dy,
        safe_div(a.x - b.x, width),
        safe_div(a.y - b.y, height),
        safe_div(a.x2 - b.x2, width),
        safe_div(a.y2 - b.y2, height),
        safe_div(a.w - b.w, width),
        safe_div(a.h - b.h, height),
        distance,
        angle,
        x_overlap,
        y_overlap,
        1.0 if a.cx > b.cx else 0.0,
        1.0 if a.cy < b.cy else 0.0,
        1.0 if y_overlap > 0.35 else 0.0,
        1.0 if x_overlap > 0.35 else 0.0,
        1.0 if same_reading_band else 0.0,
        1.0 if rtl_before else 0.0,
        1.0 if ltr_before else 0.0,
        (1.0 if rtl_before else -1.0) * (1.0 if same_reading_band else 0.5),
    ]


def rtl_reading_heuristic_before(a: Box, b: Box) -> bool:
    y_overlap = safe_div(interval_overlap(a.y, a.y2, b.y, b.y2), min(a.h, b.h))
    same_reading_band = y_overlap > 0.35 or abs(a.cy - b.cy) <= max(a.h, b.h) * 0.35
    return (a.cx > b.cx) if same_reading_band else (a.cy < b.cy)


def heuristic_probability_before(a: Box, b: Box) -> float:
    return 0.98 if rtl_reading_heuristic_before(a, b) else 0.02


def blend_probability(model_probability: float, heuristic_probability: float, weight: float) -> float:
    return (1.0 - weight) * model_probability + weight * heuristic_probability


def vertical_override_probability(
    model_probability: float,
    a: Box,
    b: Box,
    gap_factor: float | None,
) -> float | None:
    if gap_factor is None:
        return None

    y_overlap = safe_div(interval_overlap(a.y, a.y2, b.y, b.y2), min(a.h, b.h))
    clear_vertical_gap = (
        y_overlap <= 0.05
        and abs(a.cy - b.cy) >= max(a.h, b.h) * gap_factor
    )
    if not clear_vertical_gap:
        return None

    heuristic_before = rtl_reading_heuristic_before(a, b)
    model_before = model_probability >= 0.5
    if model_before == heuristic_before:
        return None
    return heuristic_probability_before(a, b)


def bubble_pair_features(
    a: BubbleSample,
    b: BubbleSample,
    page_width: float,
    page_height: float,
    panel_box: Box,
) -> list[float]:
    panel_width = max(1.0, panel_box.w)
    panel_height = max(1.0, panel_box.h)
    relative_a = Box(
        x=a.box.x - panel_box.x,
        y=a.box.y - panel_box.y,
        w=a.box.w,
        h=a.box.h,
    )
    relative_b = Box(
        x=b.box.x - panel_box.x,
        y=b.box.y - panel_box.y,
        w=b.box.w,
        h=b.box.h,
    )
    return [
        *pair_features(a.box, b.box, page_width, page_height),
        *pair_features(relative_a, relative_b, panel_width, panel_height),
        *box_features(panel_box, page_width, page_height),
    ]


def load_pages(annotations_path: Path) -> tuple[list[PageSample], dict[str, int]]:
    annotations = read_json(annotations_path)
    pages: list[PageSample] = []
    skipped = {
        "missing_size": 0,
        "missing_panels": 0,
        "missing_bubbles": 0,
        "invalid_panel": 0,
    }

    for raw_page in annotations.get("pages") or []:
        page_id = to_int(raw_page.get("page_id"))
        width = to_float(raw_page.get("width"))
        height = to_float(raw_page.get("height"))
        if page_id is None or width <= 0 or height <= 0:
            skipped["missing_size"] += 1
            continue

        panels: list[PanelSample] = []
        for raw_panel in raw_page.get("cases") or []:
            panel_order = to_int(raw_panel.get("order"))
            panel_box = parse_box(raw_panel)
            panel_id = str(raw_panel.get("case_id") or f"panel_{len(panels) + 1}")
            if panel_order is None or panel_box is None:
                skipped["invalid_panel"] += 1
                continue

            bubbles: list[BubbleSample] = []
            for raw_bubble in raw_panel.get("bubbles") or []:
                bubble_id = to_int(raw_bubble.get("id"))
                bubble_order = to_int(raw_bubble.get("order"))
                bubble_box = parse_box(raw_bubble)
                if bubble_id is None or bubble_order is None or bubble_box is None:
                    continue
                bubbles.append(
                    BubbleSample(
                        bubble_id=bubble_id,
                        order=bubble_order,
                        box=bubble_box,
                        panel_id=panel_id,
                        panel_order=panel_order,
                        panel_box=panel_box,
                    )
                )

            panels.append(
                PanelSample(
                    panel_id=panel_id,
                    order=panel_order,
                    box=panel_box,
                    bubbles=tuple(sorted(bubbles, key=lambda item: item.order)),
                )
            )

        panels = sorted(panels, key=lambda panel: panel.order)
        if not panels:
            skipped["missing_panels"] += 1
            continue
        if not any(panel.bubbles for panel in panels):
            skipped["missing_bubbles"] += 1
            continue

        pages.append(
            PageSample(
                page_id=page_id,
                width=width,
                height=height,
                panels=tuple(panels),
            )
        )

    pages.sort(key=lambda page: page.page_id)
    return pages, skipped


def manifest_page_ids(manifest_path: Path) -> tuple[set[int], set[int]] | None:
    if not manifest_path.exists():
        return None
    manifest = read_json(manifest_path)
    splits = manifest.get("splits") or {}
    train_items = splits.get("train", {}).get("items") or []
    test_items = splits.get("test", {}).get("items") or []
    train_ids = {int(item["page_id"]) for item in train_items if "page_id" in item}
    test_ids = {int(item["page_id"]) for item in test_items if "page_id" in item}
    if not train_ids or not test_ids:
        return None
    return train_ids, test_ids


def split_pages(
    pages: Sequence[PageSample],
    manifest_path: Path | None,
    test_size: float,
    seed: int,
) -> tuple[list[PageSample], list[PageSample], str]:
    page_by_id = {page.page_id: page for page in pages}
    if manifest_path is not None:
        ids = manifest_page_ids(manifest_path)
        if ids is not None:
            train_ids, test_ids = ids
            train_pages = [page_by_id[page_id] for page_id in sorted(train_ids) if page_id in page_by_id]
            test_pages = [page_by_id[page_id] for page_id in sorted(test_ids) if page_id in page_by_id]
            if train_pages and test_pages:
                return train_pages, test_pages, str(manifest_path)

    shuffled = list(pages)
    random.Random(seed).shuffle(shuffled)
    test_count = int(round(len(shuffled) * test_size))
    test_count = max(1, min(len(shuffled) - 1, test_count))
    return shuffled[test_count:], shuffled[:test_count], "deterministic_random_split"


def build_panel_pairs(pages: Iterable[PageSample]) -> PairDataset:
    dataset = PairDataset(features=[], labels=[], groups=[])
    for page in pages:
        panels = list(page.panels)
        for i in range(len(panels)):
            for j in range(i + 1, len(panels)):
                a = panels[i]
                b = panels[j]
                label = 1 if a.order < b.order else 0
                dataset.features.append(pair_features(a.box, b.box, page.width, page.height))
                dataset.labels.append(label)
                dataset.groups.append(page.page_id)
                dataset.features.append(pair_features(b.box, a.box, page.width, page.height))
                dataset.labels.append(1 - label)
                dataset.groups.append(page.page_id)
    return dataset


def build_bubble_pairs(pages: Iterable[PageSample]) -> PairDataset:
    dataset = PairDataset(features=[], labels=[], groups=[])
    for page in pages:
        for panel in page.panels:
            bubbles = list(panel.bubbles)
            for i in range(len(bubbles)):
                for j in range(i + 1, len(bubbles)):
                    a = bubbles[i]
                    b = bubbles[j]
                    label = 1 if a.order < b.order else 0
                    dataset.features.append(
                        bubble_pair_features(a, b, page.width, page.height, panel.box)
                    )
                    dataset.labels.append(label)
                    dataset.groups.append(page.page_id)
                    dataset.features.append(
                        bubble_pair_features(b, a, page.width, page.height, panel.box)
                    )
                    dataset.labels.append(1 - label)
                    dataset.groups.append(page.page_id)
    return dataset


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-min(60.0, value))
        return 1.0 / (1.0 + z)
    z = math.exp(max(-60.0, value))
    return z / (1.0 + z)


class PairwiseLogisticRanker:
    def __init__(self, name: str) -> None:
        self.name = name
        self.feature_count = 0
        self.means: list[float] = []
        self.stds: list[float] = []
        self.weights: list[float] = []
        self.bias = 0.0

    def fit(
        self,
        dataset: PairDataset,
        epochs: int,
        learning_rate: float,
        l2: float,
        seed: int,
    ) -> dict[str, Any]:
        if not dataset.features:
            raise ValueError(f"No training pairs available for {self.name}.")

        self.feature_count = len(dataset.features[0])
        columns = list(zip(*dataset.features))
        self.means = [statistics.fmean(column) for column in columns]
        self.stds = [
            max(1e-6, statistics.pstdev(column))
            for column in columns
        ]
        self.weights = [0.0 for _ in range(self.feature_count)]
        self.bias = 0.0

        scaled_features = [self.scale(features) for features in dataset.features]
        indices = list(range(len(scaled_features)))
        rng = random.Random(seed)
        history: list[dict[str, float]] = []

        for epoch in range(epochs):
            rng.shuffle(indices)
            total_loss = 0.0
            correct = 0
            for index in indices:
                features = scaled_features[index]
                label = dataset.labels[index]
                score = self.raw_score_scaled(features)
                probability = sigmoid(score)
                error = probability - label
                total_loss += -(
                    label * math.log(max(probability, 1e-9))
                    + (1 - label) * math.log(max(1.0 - probability, 1e-9))
                )
                if (probability >= 0.5) == bool(label):
                    correct += 1

                for feature_index, value in enumerate(features):
                    gradient = error * value + l2 * self.weights[feature_index]
                    self.weights[feature_index] -= learning_rate * gradient
                self.bias -= learning_rate * error

            history.append(
                {
                    "epoch": epoch + 1,
                    "loss": total_loss / len(indices),
                    "accuracy": correct / len(indices),
                }
            )

        return {
            "epochs": epochs,
            "learning_rate": learning_rate,
            "l2": l2,
            "history_tail": history[-5:],
        }

    def scale(self, features: Sequence[float]) -> list[float]:
        return [
            clamp((features[index] - self.means[index]) / self.stds[index])
            for index in range(self.feature_count)
        ]

    def raw_score_scaled(self, scaled_features: Sequence[float]) -> float:
        return self.bias + sum(
            weight * value for weight, value in zip(self.weights, scaled_features)
        )

    def predict_proba(self, features: Sequence[float]) -> float:
        return sigmoid(self.raw_score_scaled(self.scale(features)))

    def to_json(self, metadata: dict[str, Any]) -> dict[str, Any]:
        return {
            "kind": "pairwise_logistic_ranker",
            "name": self.name,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "feature_count": self.feature_count,
            "means": self.means,
            "stds": self.stds,
            "weights": self.weights,
            "bias": self.bias,
            "metadata": metadata,
        }


class SklearnPairwiseRanker:
    def __init__(self, name: str, model_type: str, seed: int) -> None:
        if not SKLEARN_AVAILABLE:
            raise RuntimeError(
                "scikit-learn is required for --ranker values other than pure-logistic."
            )
        self.name = name
        self.model_type = model_type
        self.seed = seed
        self.estimator: Any = None

    def fit(
        self,
        dataset: PairDataset,
        epochs: int,
        learning_rate: float,
        l2: float,
        seed: int,
    ) -> dict[str, Any]:
        if not dataset.features:
            raise ValueError(f"No training pairs available for {self.name}.")

        if self.model_type == "extra-trees":
            self.estimator = ExtraTreesClassifier(
                n_estimators=160,
                max_depth=8,
                min_samples_leaf=1,
                class_weight="balanced",
                random_state=seed,
                n_jobs=1,
            )
        elif self.model_type == "hist-gradient-boosting":
            self.estimator = HistGradientBoostingClassifier(
                learning_rate=0.05,
                max_iter=300,
                max_leaf_nodes=15,
                l2_regularization=l2,
                random_state=seed,
            )
        elif self.model_type == "sklearn-logistic":
            self.estimator = make_pipeline(
                StandardScaler(),
                LogisticRegression(
                    C=1.0 / max(l2, 1e-6),
                    max_iter=max(epochs * 20, 1000),
                    class_weight="balanced",
                    random_state=seed,
                ),
            )
        else:
            raise ValueError(f"Unsupported sklearn ranker: {self.model_type}")

        self.estimator.fit(dataset.features, dataset.labels)
        return {
            "model_type": self.model_type,
            "samples": len(dataset.labels),
            "feature_count": len(dataset.features[0]),
            "sklearn_available": SKLEARN_AVAILABLE,
        }

    def predict_proba(self, features: Sequence[float]) -> float:
        probability = self.estimator.predict_proba([list(features)])[0][1]
        return float(probability)

    def to_json(self, metadata: dict[str, Any]) -> dict[str, Any]:
        return {
            "kind": "sklearn_pairwise_ranker",
            "name": self.name,
            "model_type": self.model_type,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "metadata": metadata,
        }

    def save_binary(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(self.estimator, path)


def create_ranker(name: str, ranker_type: str, seed: int):
    if ranker_type == "pure-logistic":
        return PairwiseLogisticRanker(name)
    return SklearnPairwiseRanker(name, ranker_type, seed=seed)


def write_model_artifacts(model: Any, metadata_path: Path, metadata: dict[str, Any]) -> None:
    write_json(metadata_path, model.to_json(metadata))
    if hasattr(model, "save_binary"):
        model.save_binary(metadata_path.with_suffix(".joblib"))


def export_linear_probability_onnx(
    model: Any,
    path: Path,
    metadata: dict[str, Any],
) -> Path | None:
    if isinstance(model, PairwiseLogisticRanker):
        feature_count = model.feature_count
        mean = np.asarray(model.means, dtype=np.float32)
        scale = np.asarray(model.stds, dtype=np.float32)
        coef = np.asarray(model.weights, dtype=np.float32).reshape(feature_count, 1)
        intercept = np.asarray([model.bias], dtype=np.float32)
    elif isinstance(model, SklearnPairwiseRanker) and model.model_type == "sklearn-logistic":
        scaler = model.estimator.named_steps["standardscaler"]
        classifier = model.estimator.named_steps["logisticregression"]
        feature_count = int(classifier.coef_.shape[1])
        mean = scaler.mean_.astype(np.float32)
        scale = scaler.scale_.astype(np.float32)
        coef = classifier.coef_[0].astype(np.float32).reshape(feature_count, 1)
        intercept = classifier.intercept_.astype(np.float32)
    else:
        return None

    path.parent.mkdir(parents=True, exist_ok=True)
    inputs = [
        helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, feature_count])
    ]
    outputs = [
        helper.make_tensor_value_info("probability", TensorProto.FLOAT, [None, 1])
    ]
    initializers = [
        numpy_helper.from_array(mean, name="mean"),
        numpy_helper.from_array(scale, name="scale"),
        numpy_helper.from_array(coef, name="coef"),
        numpy_helper.from_array(intercept, name="intercept"),
    ]
    nodes = [
        helper.make_node("Sub", ["features", "mean"], ["centered"], name="center_features"),
        helper.make_node("Div", ["centered", "scale"], ["scaled"], name="scale_features"),
        helper.make_node("MatMul", ["scaled", "coef"], ["logit"], name="linear_score"),
        helper.make_node("Add", ["logit", "intercept"], ["biased_logit"], name="add_bias"),
        helper.make_node("Sigmoid", ["biased_logit"], ["probability"], name="probability"),
    ]
    graph = helper.make_graph(
        nodes,
        f"{metadata['name']}_graph",
        inputs,
        outputs,
        initializer=initializers,
    )
    onnx_model = helper.make_model(
        graph,
        producer_name="poneglyph-reading-order",
        opset_imports=[helper.make_opsetid("", 13)],
    )
    onnx_model.ir_version = 8
    onnx_model.metadata_props.extend(
        [
            onnx.StringStringEntryProto(key="name", value=str(metadata["name"])),
            onnx.StringStringEntryProto(key="ranker", value=str(metadata["ranker"])),
            onnx.StringStringEntryProto(
                key="created_at",
                value=datetime.now(timezone.utc).isoformat(),
            ),
            onnx.StringStringEntryProto(
                key="feature_count",
                value=str(feature_count),
            ),
        ]
    )
    onnx.checker.check_model(onnx_model)
    onnx.save(onnx_model, path)

    # Runtime parity check against the Python ranker.
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    sample = np.zeros((1, feature_count), dtype=np.float32)
    ort_probability = float(session.run(None, {"features": sample})[0][0][0])
    py_probability = float(model.predict_proba(sample[0].tolist()))
    if abs(ort_probability - py_probability) > 1e-5:
        raise ValueError(
            f"ONNX parity check failed for {metadata['name']}: "
            f"python={py_probability}, onnx={ort_probability}"
        )
    return path


def pair_accuracy(model: PairwiseLogisticRanker, dataset: PairDataset) -> float | None:
    if not dataset.features:
        return None
    correct = 0
    for features, label in zip(dataset.features, dataset.labels):
        if (model.predict_proba(features) >= 0.5) == bool(label):
            correct += 1
    return correct / len(dataset.features)


def rank_items(items: Sequence[T], probability_before: Callable[[T, T], float]) -> list[T]:
    if len(items) <= 1:
        return list(items)
    scores: dict[int, float] = {index: 0.0 for index in range(len(items))}
    for i in range(len(items)):
        for j in range(len(items)):
            if i == j:
                continue
            scores[i] += probability_before(items[i], items[j])
    return [
        item
        for _, item in sorted(
            enumerate(items),
            key=lambda pair: (-scores[pair[0]], pair[0]),
        )
    ]


def predict_panel_order(
    page: PageSample,
    model: PairwiseLogisticRanker,
    heuristic_weight: float,
) -> list[PanelSample]:
    return rank_items(
        list(page.panels),
        lambda a, b: blend_probability(
            model.predict_proba(pair_features(a.box, b.box, page.width, page.height)),
            heuristic_probability_before(a.box, b.box),
            heuristic_weight,
        ),
    )


def predict_bubble_order(
    page: PageSample,
    panel: PanelSample,
    model: PairwiseLogisticRanker,
    heuristic_weight: float,
    vertical_override_gap: float | None,
) -> list[BubbleSample]:
    def probability_before(a: BubbleSample, b: BubbleSample) -> float:
        model_probability = model.predict_proba(
            bubble_pair_features(a, b, page.width, page.height, panel.box)
        )
        override_probability = vertical_override_probability(
            model_probability,
            a.box,
            b.box,
            vertical_override_gap,
        )
        if override_probability is not None:
            return override_probability
        return blend_probability(
            model_probability,
            heuristic_probability_before(a.box, b.box),
            heuristic_weight,
        )

    return rank_items(
        list(panel.bubbles),
        probability_before,
    )


def exact_accuracy(matches: Sequence[bool]) -> float | None:
    if not matches:
        return None
    return sum(1 for value in matches if value) / len(matches)


def evaluate_ordering(
    pages: Sequence[PageSample],
    panel_model: PairwiseLogisticRanker,
    bubble_model: PairwiseLogisticRanker,
    panel_heuristic_weight: float,
    bubble_heuristic_weight: float,
    bubble_vertical_override_gap: float | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    panel_exact: list[bool] = []
    bubble_panel_exact: list[bool] = []
    page_exact: list[bool] = []
    position_correct = 0
    position_total = 0
    predictions: list[dict[str, Any]] = []

    for page in pages:
        gt_panels = sorted(page.panels, key=lambda panel: panel.order)
        predicted_panels = predict_panel_order(page, panel_model, panel_heuristic_weight)
        panel_match = [panel.panel_id for panel in predicted_panels] == [
            panel.panel_id for panel in gt_panels
        ]
        panel_exact.append(panel_match)

        predicted_bubbles: list[BubbleSample] = []
        panel_details = []
        for panel in predicted_panels:
            gt_bubbles = sorted(panel.bubbles, key=lambda bubble: bubble.order)
            predicted_panel_bubbles = predict_bubble_order(
                page,
                panel,
                bubble_model,
                bubble_heuristic_weight,
                bubble_vertical_override_gap,
            )
            if len(panel.bubbles) > 1:
                bubble_panel_exact.append(
                    [bubble.bubble_id for bubble in predicted_panel_bubbles]
                    == [bubble.bubble_id for bubble in gt_bubbles]
                )
            predicted_bubbles.extend(predicted_panel_bubbles)
            panel_details.append(
                {
                    "panel_id": panel.panel_id,
                    "ground_truth_bubble_order": [bubble.bubble_id for bubble in gt_bubbles],
                    "predicted_bubble_order": [
                        bubble.bubble_id for bubble in predicted_panel_bubbles
                    ],
                }
            )

        gt_bubbles = sorted(page.bubbles, key=lambda bubble: bubble.order)
        gt_order = [bubble.bubble_id for bubble in gt_bubbles]
        pred_order = [bubble.bubble_id for bubble in predicted_bubbles]
        is_exact = pred_order == gt_order
        page_exact.append(is_exact)

        for predicted_id, expected_id in zip(pred_order, gt_order):
            position_total += 1
            if predicted_id == expected_id:
                position_correct += 1

        predictions.append(
            {
                "page_id": page.page_id,
                "full_accuracy_match": is_exact,
                "ground_truth_panel_order": [panel.panel_id for panel in gt_panels],
                "predicted_panel_order": [panel.panel_id for panel in predicted_panels],
                "ground_truth_bubble_order": gt_order,
                "predicted_bubble_order": pred_order,
                "panel_details": panel_details,
            }
        )

    metrics = {
        "panel_order_full_accuracy": exact_accuracy(panel_exact),
        "bubble_within_panel_full_accuracy": exact_accuracy(bubble_panel_exact),
        "page_full_accuracy": exact_accuracy(page_exact),
        "page_exact_matches": sum(1 for value in page_exact if value),
        "page_count": len(page_exact),
        "bubble_position_accuracy": (
            position_correct / position_total if position_total else None
        ),
        "bubble_position_correct": position_correct,
        "bubble_position_total": position_total,
    }
    return metrics, predictions


def parse_float_list(value: str) -> list[float]:
    candidates = []
    for raw_item in value.split(","):
        item = raw_item.strip()
        if not item:
            continue
        parsed = float(item)
        if parsed < 0 or parsed > 1:
            raise ValueError("--heuristic-weights values must be between 0 and 1.")
        candidates.append(parsed)
    if not candidates:
        raise ValueError("--heuristic-weights must contain at least one value.")
    return sorted(set(candidates))


def parse_gap_candidates(value: str) -> list[float | None]:
    candidates: list[float | None] = []
    for raw_item in value.split(","):
        item = raw_item.strip().lower()
        if not item:
            continue
        if item in {"off", "none", "null"}:
            candidates.append(None)
            continue
        parsed = float(item)
        if parsed < 0:
            raise ValueError("--vertical-override-gaps values must be positive or off.")
        candidates.append(parsed)

    if not candidates:
        raise ValueError("--vertical-override-gaps must contain at least one value.")

    deduped: list[float | None] = []
    for candidate in candidates:
        if candidate not in deduped:
            deduped.append(candidate)
    return deduped


def select_heuristic_weights(
    train_pages: Sequence[PageSample],
    panel_model: PairwiseLogisticRanker,
    bubble_model: PairwiseLogisticRanker,
    candidates: Sequence[float],
    vertical_override_candidates: Sequence[float | None],
) -> dict[str, Any]:
    best: dict[str, Any] | None = None
    for panel_weight in candidates:
        for bubble_weight in candidates:
            for vertical_override_gap in vertical_override_candidates:
                metrics, _ = evaluate_ordering(
                    train_pages,
                    panel_model,
                    bubble_model,
                    panel_heuristic_weight=panel_weight,
                    bubble_heuristic_weight=bubble_weight,
                    bubble_vertical_override_gap=vertical_override_gap,
                )
                score = (
                    metrics["page_full_accuracy"] or 0.0,
                    metrics["panel_order_full_accuracy"] or 0.0,
                    metrics["bubble_within_panel_full_accuracy"] or 0.0,
                    -(panel_weight + bubble_weight),
                    0.0 if vertical_override_gap is None else -1.0,
                    0.0 if vertical_override_gap is None else -vertical_override_gap,
                )
                candidate = {
                    "panel_heuristic_weight": panel_weight,
                    "bubble_heuristic_weight": bubble_weight,
                    "bubble_vertical_override_gap": vertical_override_gap,
                    "train_ordering": metrics,
                    "score": score,
                }
                if best is None or score > best["score"]:
                    best = candidate

    if best is None:
        raise ValueError("No heuristic blend candidate could be evaluated.")
    return best


def summarize_pages(pages: Sequence[PageSample]) -> dict[str, int]:
    return {
        "pages": len(pages),
        "panels": sum(len(page.panels) for page in pages),
        "bubbles": sum(len(page.bubbles) for page in pages),
        "multi_bubble_panels": sum(
            1 for page in pages for panel in page.panels if len(panel.bubbles) > 1
        ),
    }


def train_and_evaluate(args: argparse.Namespace) -> dict[str, Any]:
    annotations_path = args.annotations.resolve()
    output_dir = args.output_dir.resolve()
    manifest_path = args.split_manifest.resolve() if args.split_manifest else None

    pages, skipped = load_pages(annotations_path)
    if len(pages) < 2:
        raise ValueError("Need at least two usable annotated pages.")

    train_pages, test_pages, split_source = split_pages(
        pages=pages,
        manifest_path=manifest_path,
        test_size=args.test_size,
        seed=args.seed,
    )
    if not train_pages or not test_pages:
        raise ValueError("Train/test split produced an empty side.")

    train_panel_pairs = build_panel_pairs(train_pages)
    test_panel_pairs = build_panel_pairs(test_pages)
    train_bubble_pairs = build_bubble_pairs(train_pages)
    test_bubble_pairs = build_bubble_pairs(test_pages)

    panel_model = create_ranker("panel_order", args.ranker, seed=args.seed)
    panel_training = panel_model.fit(
        train_panel_pairs,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        l2=args.l2,
        seed=args.seed,
    )

    bubble_model = create_ranker("bubble_order", args.ranker, seed=args.seed + 17)
    bubble_training = bubble_model.fit(
        train_bubble_pairs,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        l2=args.l2,
        seed=args.seed + 17,
    )

    heuristic_candidates = parse_float_list(args.heuristic_weights)
    vertical_override_candidates = parse_gap_candidates(args.vertical_override_gaps)
    selected_blend = select_heuristic_weights(
        train_pages,
        panel_model,
        bubble_model,
        candidates=heuristic_candidates,
        vertical_override_candidates=vertical_override_candidates,
    )
    panel_heuristic_weight = selected_blend["panel_heuristic_weight"]
    bubble_heuristic_weight = selected_blend["bubble_heuristic_weight"]
    bubble_vertical_override_gap = selected_blend["bubble_vertical_override_gap"]

    train_order_metrics, _ = evaluate_ordering(
        train_pages,
        panel_model,
        bubble_model,
        panel_heuristic_weight=panel_heuristic_weight,
        bubble_heuristic_weight=bubble_heuristic_weight,
        bubble_vertical_override_gap=bubble_vertical_override_gap,
    )
    test_order_metrics, predictions = evaluate_ordering(
        test_pages,
        panel_model,
        bubble_model,
        panel_heuristic_weight=panel_heuristic_weight,
        bubble_heuristic_weight=bubble_heuristic_weight,
        bubble_vertical_override_gap=bubble_vertical_override_gap,
    )

    metrics = {
        "kind": "reading_order_training_metrics",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "annotations": str(annotations_path),
        "split_source": split_source,
        "seed": args.seed,
        "test_size": args.test_size,
        "ranker": args.ranker,
        "uses_ground_truth_boxes": True,
        "note": (
            "Final page_full_accuracy evaluates ordering only: ground-truth panel "
            "and bubble boxes/assignments are used, then the trained panel and "
            "bubble rankers predict order. Optional manga RTL/top-to-bottom "
            "priors and clear-vertical bubble overrides are selected only on "
            "training pages; selected values are recorded in heuristic_blend."
        ),
        "skipped_pages": skipped,
        "dataset": {
            "all": summarize_pages(pages),
            "train": summarize_pages(train_pages),
            "test": summarize_pages(test_pages),
        },
        "train_page_ids": [page.page_id for page in train_pages],
        "test_page_ids": [page.page_id for page in test_pages],
        "pairs": {
            "panel_train": len(train_panel_pairs.labels),
            "panel_test": len(test_panel_pairs.labels),
            "bubble_train": len(train_bubble_pairs.labels),
            "bubble_test": len(test_bubble_pairs.labels),
        },
        "heuristic_blend": {
            "candidate_weights": heuristic_candidates,
            "vertical_override_candidates": vertical_override_candidates,
            "selected_panel_weight": panel_heuristic_weight,
            "selected_bubble_weight": bubble_heuristic_weight,
            "selected_bubble_vertical_override_gap": bubble_vertical_override_gap,
            "selection_metric": (
                "train page_full_accuracy, tie-broken by panel accuracy, "
                "bubble accuracy, lower total blend weight, and no/smaller override"
            ),
            "selected_train_ordering": selected_blend["train_ordering"],
        },
        "panel_order": {
            "training": panel_training,
            "train_pair_accuracy": pair_accuracy(panel_model, train_panel_pairs),
            "test_pair_accuracy": pair_accuracy(panel_model, test_panel_pairs),
        },
        "bubble_order": {
            "training": bubble_training,
            "train_pair_accuracy": pair_accuracy(bubble_model, train_bubble_pairs),
            "test_pair_accuracy": pair_accuracy(bubble_model, test_bubble_pairs),
        },
        "train_ordering": train_order_metrics,
        "test_ordering": test_order_metrics,
        "primary_metric": {
            "name": "page_full_accuracy",
            "value": test_order_metrics["page_full_accuracy"],
            "exact_matches": test_order_metrics["page_exact_matches"],
            "page_count": test_order_metrics["page_count"],
        },
    }

    model_metadata = {
        "annotations": str(annotations_path),
        "split_source": split_source,
        "seed": args.seed,
        "train_page_count": len(train_pages),
        "test_page_count": len(test_pages),
        "heuristic_blend": {
            "panel_weight": panel_heuristic_weight,
            "bubble_weight": bubble_heuristic_weight,
            "bubble_vertical_override_gap": bubble_vertical_override_gap,
        },
    }
    panel_model_path = output_dir / "models" / "panel_order_model.json"
    bubble_model_path = output_dir / "models" / "bubble_order_model.json"
    write_model_artifacts(
        panel_model,
        panel_model_path,
        {**model_metadata, "training": panel_training},
    )
    write_model_artifacts(
        bubble_model,
        bubble_model_path,
        {**model_metadata, "training": bubble_training},
    )
    panel_onnx = export_linear_probability_onnx(
        panel_model,
        output_dir / "models" / "panel_order.onnx",
        {"name": "panel_order", "ranker": args.ranker},
    )
    bubble_onnx = export_linear_probability_onnx(
        bubble_model,
        output_dir / "models" / "bubble_order.onnx",
        {"name": "bubble_order", "ranker": args.ranker},
    )
    metrics["onnx_models"] = {
        "panel_order": str(panel_onnx) if panel_onnx else None,
        "bubble_order": str(bubble_onnx) if bubble_onnx else None,
    }
    write_json(output_dir / "metrics" / "reading_order_metrics.json", metrics)
    write_json(output_dir / "predictions" / "test_page_orders.json", predictions)
    return metrics


def print_summary(metrics: dict[str, Any]) -> None:
    primary = metrics["primary_metric"]
    test = metrics["test_ordering"]
    print()
    print("=" * 72)
    print("  Reading Order Training Summary")
    print("=" * 72)
    print(f"  Split source:       {metrics['split_source']}")
    print(
        f"  Train/Test pages:   {metrics['dataset']['train']['pages']} / "
        f"{metrics['dataset']['test']['pages']}"
    )
    print(f"  Ranker:             {metrics['ranker']}")
    print(
        f"  Panel pairs:        {metrics['pairs']['panel_train']} train / "
        f"{metrics['pairs']['panel_test']} test"
    )
    print(
        f"  Bubble pairs:       {metrics['pairs']['bubble_train']} train / "
        f"{metrics['pairs']['bubble_test']} test"
    )
    print()
    print(
        f"  Heuristic blend:   panel={metrics['heuristic_blend']['selected_panel_weight']:.2f}, "
        f"bubble={metrics['heuristic_blend']['selected_bubble_weight']:.2f}"
    )
    print(
        "  Bubble override:   "
        f"{metrics['heuristic_blend']['selected_bubble_vertical_override_gap']}"
    )
    print(f"  Panel pair acc:     {metrics['panel_order']['test_pair_accuracy']:.4f}")
    print(f"  Bubble pair acc:    {metrics['bubble_order']['test_pair_accuracy']:.4f}")
    print(f"  Panel exact order:  {test['panel_order_full_accuracy']:.4f}")
    print(f"  Bubble exact order: {test['bubble_within_panel_full_accuracy']:.4f}")
    print(
        f"  Page full accuracy: {primary['value']:.4f} "
        f"({primary['exact_matches']}/{primary['page_count']})"
    )
    print("=" * 72)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Train panel and in-panel bubble reading-order rankers, then evaluate "
            "page-level full accuracy on held-out pages."
        )
    )
    parser.add_argument("--annotations", type=Path, default=DEFAULT_ANNOTATIONS)
    parser.add_argument("--split-manifest", type=Path, default=DEFAULT_SPLIT_MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--learning-rate", type=float, default=0.03)
    parser.add_argument("--l2", type=float, default=0.0001)
    parser.add_argument(
        "--ranker",
        choices=[
            "extra-trees",
            "hist-gradient-boosting",
            "sklearn-logistic",
            "pure-logistic",
        ],
        default="sklearn-logistic",
    )
    parser.add_argument(
        "--heuristic-weights",
        default="0",
        help="Comma-separated blend weights evaluated on training pages only.",
    )
    parser.add_argument(
        "--vertical-override-gaps",
        default="off,0.5,0.75,1.0,1.25",
        help=(
            "Comma-separated clear-vertical-gap factors for train-only selection; "
            "use off to disable."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    metrics = train_and_evaluate(args)
    print_summary(metrics)


if __name__ == "__main__":
    main()
