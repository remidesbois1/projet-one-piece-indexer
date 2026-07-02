from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATASET_PATH = SCRIPT_DIR / "panel_annotation_dataset" / "dataset.json"
DEFAULT_PANEL_ANNOTATIONS_PATH = SCRIPT_DIR / "panel_annotation_dataset" / "annotations.json"
DEFAULT_OUTPUT_PATH = SCRIPT_DIR / "panel_annotation_dataset" / "panel_annotations.json"


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


def bbox_from_item(item: dict[str, Any]) -> dict[str, int]:
    bbox = item.get("bbox") if isinstance(item.get("bbox"), dict) else item
    return {
        "x": to_int(bbox.get("x")),
        "y": to_int(bbox.get("y")),
        "w": max(0, to_int(bbox.get("w"))),
        "h": max(0, to_int(bbox.get("h"))),
    }


def bbox_from_panel(panel: dict[str, Any]) -> dict[str, int]:
    bbox = panel.get("bbox") if isinstance(panel.get("bbox"), dict) else {}
    width = max(0, to_int(bbox.get("w")))
    height = max(0, to_int(bbox.get("h")))

    if "x" in bbox and "y" in bbox:
        return {"x": to_int(bbox.get("x")), "y": to_int(bbox.get("y")), "w": width, "h": height}

    if "x_center" in bbox and "y_center" in bbox:
        x_center = float(bbox.get("x_center") or 0)
        y_center = float(bbox.get("y_center") or 0)
        return {
            "x": to_int(x_center - width / 2),
            "y": to_int(y_center - height / 2),
            "w": width,
            "h": height,
        }

    keypoints = panel.get("keypoints") if isinstance(panel.get("keypoints"), list) else []
    xs = [to_int(point.get("x")) for point in keypoints if isinstance(point, dict)]
    ys = [to_int(point.get("y")) for point in keypoints if isinstance(point, dict)]
    if xs and ys:
        x1, x2 = min(xs), max(xs)
        y1, y2 = min(ys), max(ys)
        return {"x": x1, "y": y1, "w": max(0, x2 - x1), "h": max(0, y2 - y1)}

    return {"x": 0, "y": 0, "w": width, "h": height}


def rect_area(bbox: dict[str, int]) -> int:
    return max(0, bbox["w"]) * max(0, bbox["h"])


def intersection_area(a: dict[str, int], b: dict[str, int]) -> int:
    x1 = max(a["x"], b["x"])
    y1 = max(a["y"], b["y"])
    x2 = min(a["x"] + a["w"], b["x"] + b["w"])
    y2 = min(a["y"] + a["h"], b["y"] + b["h"])
    return max(0, x2 - x1) * max(0, y2 - y1)


def contains_point(bbox: dict[str, int], x: float, y: float) -> bool:
    return bbox["x"] <= x <= bbox["x"] + bbox["w"] and bbox["y"] <= y <= bbox["y"] + bbox["h"]


def bubble_is_inside_case(
    bubble: dict[str, Any], case_bbox: dict[str, int], min_overlap: float = 0.60
) -> bool:
    bubble_bbox = bbox_from_item(bubble)
    center_x = bubble_bbox["x"] + bubble_bbox["w"] / 2
    center_y = bubble_bbox["y"] + bubble_bbox["h"] / 2
    if contains_point(case_bbox, center_x, center_y):
        return True
    area = rect_area(bubble_bbox)
    if area <= 0:
        return False
    return intersection_area(bubble_bbox, case_bbox) / area >= min_overlap


def bubble_sort_key(bubble: dict[str, Any]) -> tuple[int, int, int]:
    order = bubble.get("order")
    bubble_id = to_int(bubble.get("id"))
    if order is None:
        return (1, 10**9, bubble_id)
    return (0, to_int(order), bubble_id)


def page_file_key(value: str | None) -> str:
    return Path(value or "").name


def sort_cases_rtl(cases: list[dict[str, Any]]) -> None:
    if not cases:
        return
    heights = sorted(case["bbox"]["h"] for case in cases)
    median_height = heights[len(heights) // 2]
    row_band = max(40, int(median_height * 0.6))

    def key(case: dict[str, Any]) -> tuple[int, int]:
        bbox = case["bbox"]
        center_y = bbox["y"] + bbox["h"] / 2
        center_x = bbox["x"] + bbox["w"] / 2
        return (int(center_y // row_band), -int(center_x))

    cases.sort(key=key)


def output_bubble(bubble: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": to_int(bubble.get("id")),
        "order": bubble.get("order"),
        "bbox": bbox_from_item(bubble),
        "text": bubble.get("text"),
    }


def convert(
    dataset_path: Path,
    panel_annotations_path: Path,
    output_path: Path,
    sort_rtl: bool,
) -> dict[str, Any]:
    dataset = read_json(dataset_path)
    raw_annotations = read_json(panel_annotations_path)
    annotations = raw_annotations.get("annotations") or {}
    dataset_pages = {
        page_file_key(page.get("image_file")): page for page in dataset.get("pages") or []
    }

    output_pages: list[dict[str, Any]] = []
    stats = {
        "source_annotation_pages": len(annotations),
        "matched_pages": 0,
        "missing_dataset_pages": 0,
        "panel_count": 0,
        "bubble_count": 0,
        "assigned_bubble_count": 0,
        "unassigned_bubble_count": 0,
        "empty_panel_count": 0,
    }

    for image_name in sorted(annotations):
        page = dataset_pages.get(page_file_key(image_name))
        if page is None:
            stats["missing_dataset_pages"] += 1
            continue

        raw_panels = annotations.get(image_name, {}).get("panels") or []
        cases = [
            {
                "case_id": f"case_{index}",
                "order": index,
                "bbox": bbox_from_panel(panel),
                "bubble_ids": [],
            }
            for index, panel in enumerate(raw_panels, start=1)
        ]
        if sort_rtl:
            sort_cases_rtl(cases)

        bubbles = page.get("bubbles") or []
        bubble_by_id = {to_int(bubble.get("id")): bubble for bubble in bubbles}
        for bubble in bubbles:
            bubble_id = to_int(bubble.get("id"))
            candidates = []
            for index, case in enumerate(cases):
                if bubble_is_inside_case(bubble, case["bbox"]):
                    candidates.append((rect_area(case["bbox"]), index, case))
            if candidates:
                _, _, best_case = min(candidates)
                best_case["bubble_ids"].append(bubble_id)

        assigned_ids: set[int] = set()
        output_cases = []
        for index, case in enumerate(cases, start=1):
            bubble_ids = [
                bubble_id
                for bubble_id in case.get("bubble_ids") or []
                if bubble_id in bubble_by_id and bubble_id not in assigned_ids
            ]
            bubble_ids.sort(key=lambda bubble_id: bubble_sort_key(bubble_by_id[bubble_id]))
            assigned_ids.update(bubble_ids)
            output_cases.append(
                {
                    "case_id": case.get("case_id") or f"case_{index}",
                    "order": index,
                    "bbox": case["bbox"],
                    "bubble_ids": bubble_ids,
                    "bubbles": [output_bubble(bubble_by_id[bubble_id]) for bubble_id in bubble_ids],
                }
            )

        all_bubble_ids = {to_int(bubble.get("id")) for bubble in bubbles}
        unassigned_bubble_ids = sorted(all_bubble_ids - assigned_ids)
        stats["matched_pages"] += 1
        stats["panel_count"] += len(output_cases)
        stats["bubble_count"] += len(bubbles)
        stats["assigned_bubble_count"] += len(assigned_ids)
        stats["unassigned_bubble_count"] += len(unassigned_bubble_ids)
        stats["empty_panel_count"] += sum(1 for case in output_cases if not case["bubbles"])

        output_pages.append(
            {
                "page_id": page.get("page_id"),
                "image_file": page.get("image_file"),
                "width": page.get("width"),
                "height": page.get("height"),
                "numero_page": page.get("numero_page"),
                "chapitre": page.get("chapitre"),
                "tome": page.get("tome"),
                "manga": page.get("manga"),
                "cases": output_cases,
                "unassigned_bubble_ids": unassigned_bubble_ids,
            }
        )

    output = {
        "version": 1,
        "kind": "panel_case_annotations",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_file": str(dataset_path),
        "source_annotations_file": str(panel_annotations_path),
        "conversion": {
            "bubble_assignment": "smallest containing panel; center point or >=60% overlap",
            "case_order": "rtl_sort" if sort_rtl else "source_order",
        },
        "page_count": len(output_pages),
        "stats": stats,
        "pages": output_pages,
    }
    write_json(output_path, output)
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert external panel boxes plus Supabase bubbles to panel_annotations.json."
    )
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET_PATH)
    parser.add_argument("--panels", type=Path, default=DEFAULT_PANEL_ANNOTATIONS_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    parser.add_argument(
        "--sort-rtl",
        action="store_true",
        help="Sort panels right-to-left/top-to-bottom instead of preserving source order.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = convert(
        dataset_path=args.dataset.resolve(),
        panel_annotations_path=args.panels.resolve(),
        output_path=args.output.resolve(),
        sort_rtl=args.sort_rtl,
    )
    stats = output["stats"]
    print(f"Wrote {args.output}")
    print(f"Pages: {output['page_count']} matched / {stats['source_annotation_pages']} annotated")
    print(f"Panels: {stats['panel_count']}")
    print(
        "Bubbles: "
        f"{stats['assigned_bubble_count']} assigned / {stats['bubble_count']} total "
        f"({stats['unassigned_bubble_count']} unassigned)"
    )
    if stats["empty_panel_count"]:
        print(f"Empty panels: {stats['empty_panel_count']}")


if __name__ == "__main__":
    main()
