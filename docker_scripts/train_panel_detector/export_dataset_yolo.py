from __future__ import annotations

import argparse
import json
import random
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image
from tqdm import tqdm

try:
    import pillow_avif  # noqa: F401
except ImportError:
    pass


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ANNOTATIONS_PATH = SCRIPT_DIR / "panel_annotation_dataset" / "panel_annotations.json"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / "dataset"
CLASS_ID = 0
CLASS_NAME = "panel"


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp_path.replace(path)


def to_int(value: Any, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def resolve_image_base_dir(annotations_path: Path, annotations: dict[str, Any]) -> Path:
    dataset_file = annotations.get("dataset_file")
    if dataset_file:
        dataset_path = Path(dataset_file)
        if dataset_path.exists():
            return dataset_path.parent
    return annotations_path.parent


def get_bbox(item: dict[str, Any]) -> dict[str, int]:
    bbox = item.get("bbox") if isinstance(item.get("bbox"), dict) else item
    return {
        "x": to_int(bbox.get("x")),
        "y": to_int(bbox.get("y")),
        "w": max(0, to_int(bbox.get("w"))),
        "h": max(0, to_int(bbox.get("h"))),
    }


def clamp_bbox(
    bbox: dict[str, int], image_width: int, image_height: int
) -> dict[str, int] | None:
    x1 = max(0, min(image_width, bbox["x"]))
    y1 = max(0, min(image_height, bbox["y"]))
    x2 = max(0, min(image_width, bbox["x"] + bbox["w"]))
    y2 = max(0, min(image_height, bbox["y"] + bbox["h"]))
    if x2 <= x1 or y2 <= y1:
        return None
    return {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def bbox_to_yolo(
    bbox: dict[str, int], image_width: int, image_height: int
) -> tuple[float, float, float, float] | None:
    clamped = clamp_bbox(bbox, image_width, image_height)
    if clamped is None or image_width <= 0 or image_height <= 0:
        return None

    x_center = (clamped["x"] + clamped["w"] / 2) / image_width
    y_center = (clamped["y"] + clamped["h"] / 2) / image_height
    width = clamped["w"] / image_width
    height = clamped["h"] / image_height
    return x_center, y_center, width, height


def page_sort_key(page: dict[str, Any]) -> tuple[Any, ...]:
    manga = page.get("manga") or {}
    tome = page.get("tome") or {}
    chapitre = page.get("chapitre") or {}
    return (
        str(manga.get("slug") or ""),
        to_int(tome.get("numero"), 10**9),
        to_int(chapitre.get("numero"), 10**9),
        to_int(page.get("numero_page"), 10**9),
        to_int(page.get("page_id")),
    )


def prepare_pages(
    annotations_path: Path, min_cases: int
) -> tuple[list[dict[str, Any]], Path]:
    annotations = read_json(annotations_path)
    image_base_dir = resolve_image_base_dir(annotations_path, annotations)
    prepared_pages: list[dict[str, Any]] = []
    skipped = 0

    for page in annotations.get("pages") or []:
        cases = sorted(page.get("cases") or [], key=lambda case: to_int(case.get("order")))
        if len(cases) < min_cases:
            skipped += 1
            continue

        image_file = page.get("image_file")
        if not image_file:
            skipped += 1
            continue

        image_path = (image_base_dir / image_file).resolve()
        if not image_path.exists():
            skipped += 1
            continue

        width = to_int(page.get("width"))
        height = to_int(page.get("height"))
        if width <= 0 or height <= 0:
            with Image.open(image_path) as image:
                width, height = image.size

        yolo_labels = []
        normalized_cases = []
        for case in cases:
            bbox = get_bbox(case)
            yolo_bbox = bbox_to_yolo(bbox, width, height)
            if yolo_bbox is None:
                continue
            normalized_cases.append(case)
            yolo_labels.append(
                f"{CLASS_ID} "
                f"{yolo_bbox[0]:.6f} {yolo_bbox[1]:.6f} "
                f"{yolo_bbox[2]:.6f} {yolo_bbox[3]:.6f}"
            )

        if len(yolo_labels) < min_cases:
            skipped += 1
            continue

        prepared_pages.append(
            {
                **page,
                "cases": normalized_cases,
                "image_path": str(image_path),
                "width": width,
                "height": height,
                "yolo_labels": yolo_labels,
            }
        )

    prepared_pages.sort(key=page_sort_key)
    if skipped:
        print(f"Skipped pages without usable images/cases: {skipped}")
    return prepared_pages, image_base_dir


def split_pages(
    pages: list[dict[str, Any]], test_size: float, seed: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if len(pages) < 2:
        raise ValueError("Need at least 2 annotated pages to build a train/test split.")

    shuffled = pages[:]
    random.Random(seed).shuffle(shuffled)

    test_count = int(round(len(shuffled) * test_size))
    test_count = max(1, min(len(shuffled) - 1, test_count))
    test_pages = shuffled[:test_count]
    train_pages = shuffled[test_count:]
    return train_pages, test_pages


def clean_dataset_dir(output_dir: Path) -> None:
    output_dir = output_dir.resolve()
    forbidden_paths = {
        Path(output_dir.anchor).resolve(),
        SCRIPT_DIR.resolve(),
        SCRIPT_DIR.parent.resolve(),
        SCRIPT_DIR.parent.parent.resolve(),
    }
    if output_dir in forbidden_paths:
        raise ValueError(f"Refusing to clean unsafe output directory: {output_dir}")

    has_dataset_markers = any(
        (output_dir / marker).exists()
        for marker in ("data.yaml", "manifest.json", "train", "test")
    )
    if output_dir.exists() and output_dir.name != "dataset" and not has_dataset_markers:
        raise ValueError(
            "Refusing to clean an existing directory that does not look like a YOLO "
            f"dataset: {output_dir}"
        )

    if output_dir.exists():
        shutil.rmtree(output_dir)
    for split in ("train", "test"):
        (output_dir / split / "images").mkdir(parents=True, exist_ok=True)
        (output_dir / split / "labels").mkdir(parents=True, exist_ok=True)


def copy_split(split_name: str, pages: list[dict[str, Any]], output_dir: Path) -> dict[str, Any]:
    image_dir = output_dir / split_name / "images"
    label_dir = output_dir / split_name / "labels"
    page_records = []
    case_count = 0

    for page in tqdm(pages, desc=f"{split_name:>5}"):
        source_image = Path(page["image_path"])
        page_id = to_int(page.get("page_id"))
        suffix = source_image.suffix.lower() or ".jpg"
        stem = f"page_{page_id}"
        target_image = image_dir / f"{stem}{suffix}"
        target_label = label_dir / f"{stem}.txt"

        shutil.copy2(source_image, target_image)
        target_label.write_text("\n".join(page["yolo_labels"]) + "\n", encoding="utf-8")

        case_count += len(page["yolo_labels"])
        page_records.append(
            {
                "page_id": page_id,
                "image": target_image.relative_to(output_dir).as_posix(),
                "label": target_label.relative_to(output_dir).as_posix(),
                "width": page["width"],
                "height": page["height"],
                "case_count": len(page["yolo_labels"]),
            }
        )

    return {
        "pages": len(page_records),
        "cases": case_count,
        "items": page_records,
    }


def write_dataset_yaml(output_dir: Path) -> Path:
    yaml_path = output_dir / "data.yaml"
    yaml_content = (
        f"path: {output_dir.resolve().as_posix()}\n"
        "train: train/images\n"
        "val: test/images\n"
        "test: test/images\n"
        "\n"
        "names:\n"
        f"  {CLASS_ID}: {CLASS_NAME}\n"
    )
    yaml_path.write_text(yaml_content, encoding="utf-8")
    (output_dir / "classes.txt").write_text(f"{CLASS_NAME}\n", encoding="utf-8")
    return yaml_path


def export_dataset(
    annotations_path: Path = DEFAULT_ANNOTATIONS_PATH,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    test_size: float = 0.2,
    seed: int = 42,
    min_cases: int = 1,
) -> Path:
    annotations_path = annotations_path.resolve()
    output_dir = output_dir.resolve()

    if not annotations_path.exists():
        raise FileNotFoundError(f"Annotation JSON not found: {annotations_path}")
    if test_size <= 0 or test_size >= 1:
        raise ValueError("--test-size must be between 0 and 1.")

    print()
    print("=" * 60)
    print("  EXPORT YOLO DATASET - Panel Detector")
    print("=" * 60)
    print()
    print(f"  Annotations: {annotations_path}")
    print(f"  Output:      {output_dir}")
    print(f"  Test size:   {test_size:.0%}")
    print(f"  Seed:        {seed}")
    print()

    pages, image_base_dir = prepare_pages(annotations_path, min_cases=min_cases)
    if not pages:
        raise ValueError("No annotated page with usable panel boxes was found.")

    train_pages, test_pages = split_pages(pages, test_size=test_size, seed=seed)
    clean_dataset_dir(output_dir)

    train_stats = copy_split("train", train_pages, output_dir)
    test_stats = copy_split("test", test_pages, output_dir)
    yaml_path = write_dataset_yaml(output_dir)

    manifest = {
        "version": 1,
        "kind": "panel_yolo_dataset",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "annotations_file": str(annotations_path),
        "image_base_dir": str(image_base_dir),
        "test_size": test_size,
        "seed": seed,
        "class_names": {str(CLASS_ID): CLASS_NAME},
        "splits": {
            "train": train_stats,
            "test": test_stats,
        },
    }
    write_json(output_dir / "manifest.json", manifest)

    print()
    print("-" * 60)
    print("  DATASET SUMMARY")
    print("-" * 60)
    print(f"  Train pages: {train_stats['pages']:>5} | cases: {train_stats['cases']:>6}")
    print(f"  Test pages:  {test_stats['pages']:>5} | cases: {test_stats['cases']:>6}")
    print(f"  YAML:        {yaml_path}")
    print("=" * 60)
    return yaml_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert panel_annotations.json into a YOLO train/test dataset."
    )
    parser.add_argument("--annotations", type=Path, default=DEFAULT_ANNOTATIONS_PATH)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--min-cases",
        type=int,
        default=1,
        help="Minimum number of valid case boxes required for a page.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    export_dataset(
        annotations_path=args.annotations,
        output_dir=args.output_dir,
        test_size=args.test_size,
        seed=args.seed,
        min_cases=max(1, args.min_cases),
    )


if __name__ == "__main__":
    main()
