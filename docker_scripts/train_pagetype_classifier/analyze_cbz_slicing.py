#!/usr/bin/env python3
"""Run the local page-type ONNX model on a CBZ and propose chapter slicing.

The script is deliberately non-destructive: it only writes an analysis report.
The proposal treats a confident ``cover`` as a chapter boundary and a confident
``annexe`` as a page to exclude from the chapter reading sequence.  Low
confidence pages are retained and explicitly sent to review.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageOps


LABELS = ("cover", "story_page", "annexe")
IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"}
MODEL_IMAGE_SIZE = 224
MODEL_RESIZE_SIZE = 256
MODEL_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
MODEL_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def preprocess(image: Image.Image) -> np.ndarray:
    image = ImageOps.exif_transpose(image).convert("RGB")
    width, height = image.size
    scale = MODEL_RESIZE_SIZE / min(width, height)
    resized = image.resize((round(width * scale), round(height * scale)), Image.Resampling.BILINEAR)
    left = (resized.width - MODEL_IMAGE_SIZE) // 2
    top = (resized.height - MODEL_IMAGE_SIZE) // 2
    cropped = resized.crop((left, top, left + MODEL_IMAGE_SIZE, top + MODEL_IMAGE_SIZE))
    pixels = np.asarray(cropped, dtype=np.float32) / 255.0
    normalized = (pixels - MODEL_MEAN) / MODEL_STD
    return np.ascontiguousarray(normalized.transpose(2, 0, 1)[None], dtype=np.float32)


@dataclass
class PageResult:
    index: int
    archive_path: str
    width: int
    height: int
    predicted_label: str
    confidence: float
    probabilities: dict[str, float]
    action: str
    review: bool


def predict_all(cbz_path: Path, model_path: Path, cover_threshold: float, annexe_threshold: float) -> list[PageResult]:
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    with zipfile.ZipFile(cbz_path) as archive:
        members = sorted(
            (item for item in archive.infolist() if not item.is_dir() and Path(item.filename).suffix.casefold() in IMAGE_EXTENSIONS),
            key=lambda item: natural_key(item.filename),
        )
        results: list[PageResult] = []
        for index, member in enumerate(members, start=1):
            with archive.open(member) as source, Image.open(io.BytesIO(source.read())) as raw:
                image = raw.copy()
            logits = np.asarray(session.run([output_name], {input_name: preprocess(image)})[0][0], dtype=np.float32)
            shifted = logits - logits.max()
            values = np.exp(shifted) / np.exp(shifted).sum()
            label_index = int(values.argmax())
            label = LABELS[label_index]
            confidence = float(values[label_index])
            probabilities = {name: float(values[position]) for position, name in enumerate(LABELS)}
            if label == "annexe" and confidence >= annexe_threshold:
                action, review = "exclude_annexe", False
            elif label == "cover" and confidence >= cover_threshold:
                action, review = "chapter_boundary", False
            else:
                action = "keep_story"
                review = (label != "story_page") or confidence < 0.90
            results.append(
                PageResult(index, member.filename, image.width, image.height, label, confidence, probabilities, action, review)
            )
    return results


def chapter_ranges(results: list[PageResult], cover_merge_gap: int) -> list[dict[str, Any]]:
    """Merge nearby cover candidates and retain the final title page of each group.

    A volume can contain an outer cover, a decorative chapter illustration and
    the actual page carrying the chapter title in a small span.  Keeping each
    candidate would create artificial one-page chapters.  The last candidate
    is the most useful delimiter for the reading sequence; all earlier pages
    remain available for manual review in the JSON/contact sheet.
    """
    candidates = [page.index for page in results if page.action == "chapter_boundary"]
    groups: list[list[int]] = []
    for candidate in candidates:
        if not groups or candidate - groups[-1][-1] > cover_merge_gap:
            groups.append([candidate])
        else:
            groups[-1].append(candidate)
    boundaries = [group[-1] for group in groups]
    kept = [page.index for page in results if page.action != "exclude_annexe"]
    ranges: list[dict[str, Any]] = []
    for number, start in enumerate(boundaries, start=1):
        next_start = boundaries[number] if number < len(boundaries) else len(results) + 1
        pages = [index for index in kept if start <= index < next_start]
        ranges.append(
            {
                "chapter_number": number,
                "start_page": start,
                "end_page": next_start - 1,
                "cover_candidate_pages": groups[number - 1],
                "kept_pages": pages,
            }
        )
    return ranges


def write_contact_sheet(cbz_path: Path, results: list[PageResult], destination: Path) -> None:
    """Save each boundary/exclusion plus its immediate neighbours for visual QA."""
    selected = {page.index for page in results if page.action != "keep_story" or page.review}
    expanded = sorted({index + delta for index in selected for delta in (-1, 0, 1) if 1 <= index + delta <= len(results)})
    by_index = {page.index: page for page in results}
    width, height, columns = 260, 380, 5
    rows = max(1, (len(expanded) + columns - 1) // columns)
    canvas = Image.new("RGB", (columns * width, rows * height), "#161616")
    draw = ImageDraw.Draw(canvas)
    with zipfile.ZipFile(cbz_path) as archive:
        for position, page_index in enumerate(expanded):
            page = by_index[page_index]
            with archive.open(page.archive_path) as source, Image.open(io.BytesIO(source.read())) as raw:
                image = ImageOps.exif_transpose(raw).convert("RGB")
            image.thumbnail((width - 16, height - 62), Image.Resampling.LANCZOS)
            x = (position % columns) * width + (width - image.width) // 2
            y = (position // columns) * height + 8
            canvas.paste(image, (x, y))
            color = "#ffbd59" if page.action == "chapter_boundary" else "#ff6666" if page.action == "exclude_annexe" else "#e5e5e5"
            text = f"{page.index:03d}  {page.predicted_label} {page.confidence:.3f}\n{page.action}"
            draw.multiline_text(((position % columns) * width + 8, (position // columns) * height + height - 50), text, fill=color, spacing=2)
    canvas.save(destination, quality=92)


def write_report(
    output_dir: Path,
    cbz_path: Path,
    model_path: Path,
    results: list[PageResult],
    cover_threshold: float,
    annexe_threshold: float,
    cover_merge_gap: int,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    chapters = chapter_ranges(results, cover_merge_gap)
    payload = {
        "source_cbz": str(cbz_path.resolve()),
        "model": str(model_path.resolve()),
        "thresholds": {"cover": cover_threshold, "annexe": annexe_threshold, "cover_merge_gap": cover_merge_gap},
        "pages": [asdict(page) for page in results],
        "proposed_chapters": chapters,
    }
    (output_dir / "slicing_analysis.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    excluded = [page for page in results if page.action == "exclude_annexe"]
    review = [page for page in results if page.review]
    lines = [
        "# Analyse de découpage CBZ",
        "",
        f"- Source : `{cbz_path.name}` ({len(results)} pages)",
        f"- Modèle : `{model_path.name}`",
        f"- Seuils : cover ≥ {cover_threshold:.2f}, annexe ≥ {annexe_threshold:.2f}; regroupement des covers à {cover_merge_gap} pages.",
        f"- Proposition : {len(chapters)} chapitres, {len(excluded)} pages annexes à exclure, {len(review)} pages à revoir.",
        "",
        "## Débuts de chapitres proposés",
        "",
    ]
    lines.extend(
        f"- Page {chapter['start_page']} — candidats regroupés : {chapter['cover_candidate_pages']}"
        for chapter in chapters
    )
    lines.extend(["", "## Annexes proposées à exclure", ""])
    lines.extend(f"- Page {page.index} — P(annexe)={page.probabilities['annexe']:.3f}" for page in excluded)
    lines.extend(["", "## Revue manuelle", ""])
    lines.extend(f"- Page {page.index} — {page.predicted_label}, confiance={page.confidence:.3f}" for page in review)
    (output_dir / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    write_contact_sheet(cbz_path, results, output_dir / "review_contact_sheet.jpg")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cbz", type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--cover-threshold", type=float, default=0.80)
    parser.add_argument("--annexe-threshold", type=float, default=0.80)
    parser.add_argument("--cover-merge-gap", type=int, default=3)
    args = parser.parse_args()
    if not args.cbz.is_file() or not args.model.is_file():
        parser.error("Le CBZ et le modèle ONNX doivent exister.")
    if not 0.0 <= args.cover_threshold <= 1.0 or not 0.0 <= args.annexe_threshold <= 1.0:
        parser.error("Les seuils doivent être compris entre 0 et 1.")
    if args.cover_merge_gap < 0:
        parser.error("La fenêtre de regroupement doit être positive.")
    results = predict_all(args.cbz, args.model, args.cover_threshold, args.annexe_threshold)
    write_report(
        args.output_dir,
        args.cbz,
        args.model,
        results,
        args.cover_threshold,
        args.annexe_threshold,
        args.cover_merge_gap,
    )
    print(f"Analyse écrite dans {args.output_dir.resolve()}")


if __name__ == "__main__":
    main()
