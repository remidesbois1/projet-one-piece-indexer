import argparse
import csv
import html
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, median


try:
    import editdistance
except Exception:  # noqa: BLE001
    editdistance = None


PUNCT_TRANSLATION = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201a": "'",
        "\u201b": "'",
        "\u2032": "'",
        "\u00b4": "'",
        "\u0060": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201e": '"',
        "\u201f": '"',
        "\u2033": '"',
        "\u00ab": '"',
        "\u00bb": '"',
        "\u2010": "-",
        "\u2011": "-",
        "\u2012": "-",
        "\u2013": "-",
        "\u2014": "-",
        "\u2026": "...",
        "\u00a0": " ",
        "\u202f": " ",
    }
)


def read_json(path: Path | None) -> dict:
    if not path or not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def levenshtein(left: str, right: str) -> int:
    if editdistance is not None:
        return int(editdistance.eval(left, right))
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, left_char in enumerate(left, start=1):
        current = [i]
        for j, right_char in enumerate(right, start=1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def align_ops(reference: str, prediction: str) -> list[tuple[str, str, str]]:
    rows = len(reference) + 1
    cols = len(prediction) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            dp[i][j] = min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (reference[i - 1] != prediction[j - 1]),
            )

    ops = []
    i = len(reference)
    j = len(prediction)
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (reference[i - 1] != prediction[j - 1]):
            if reference[i - 1] != prediction[j - 1]:
                ops.append(("substitution", reference[i - 1], prediction[j - 1]))
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            ops.append(("deletion", reference[i - 1], ""))
            i -= 1
        else:
            ops.append(("insertion", "", prediction[j - 1]))
            j -= 1
    ops.reverse()
    return ops


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = text.translate(PUNCT_TRANSLATION)
    text = text.replace("\u0153", "oe").replace("\u0152", "OE")
    text = re.sub(r"\s+", " ", text.strip())
    text = re.sub(r"\s+([?!.,;:])", r"\1", text)
    text = re.sub(r"([([{])\s+", r"\1", text)
    text = re.sub(r"\s+([])}])", r"\1", text)
    return text


def strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(char for char in decomposed if unicodedata.category(char) != "Mn")


def has_alnum(text: str) -> bool:
    return any(char.isalnum() for char in text)


def percentile(values: list[int], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = (len(ordered) - 1) * ratio
    low = int(index)
    high = min(low + 1, len(ordered) - 1)
    if low == high:
        return float(ordered[low])
    weight = index - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


def label_length_distribution(values: list[int]) -> dict:
    if not values:
        return {"min": 0, "p25": 0, "median": 0, "p75": 0, "p90": 0, "max": 0, "mean": 0}
    return {
        "min": min(values),
        "p25": percentile(values, 0.25),
        "median": median(values),
        "p75": percentile(values, 0.75),
        "p90": percentile(values, 0.90),
        "max": max(values),
        "mean": mean(values),
    }


def top_counter(counter: Counter, limit: int) -> list[dict[str, int | str]]:
    return [{"pattern": pattern, "count": count} for pattern, count in counter.most_common(limit)]


class MetricBucket:
    def __init__(self) -> None:
        self.samples = 0
        self.raw_distance = 0
        self.raw_chars = 0
        self.raw_exact = 0
        self.normalized_distance = 0
        self.normalized_chars = 0
        self.normalized_exact = 0
        self.casefold_distance = 0
        self.casefold_chars = 0
        self.casefold_exact = 0

    def add(self, reference: str, prediction: str) -> None:
        norm_ref = normalize_text(reference)
        norm_pred = normalize_text(prediction)
        case_ref = norm_ref.casefold()
        case_pred = norm_pred.casefold()

        self.samples += 1
        self.raw_distance += levenshtein(reference, prediction)
        self.raw_chars += len(reference)
        self.raw_exact += int(reference == prediction)
        self.normalized_distance += levenshtein(norm_ref, norm_pred)
        self.normalized_chars += len(norm_ref)
        self.normalized_exact += int(norm_ref == norm_pred)
        self.casefold_distance += levenshtein(case_ref, case_pred)
        self.casefold_chars += len(case_ref)
        self.casefold_exact += int(case_ref == case_pred)

    def as_dict(self) -> dict:
        return {
            "samples": self.samples,
            "raw_cer": self.raw_distance / max(self.raw_chars, 1),
            "raw_exact_match": self.raw_exact / max(self.samples, 1),
            "normalized_cer": self.normalized_distance / max(self.normalized_chars, 1),
            "normalized_exact_match": self.normalized_exact / max(self.samples, 1),
            "casefold_normalized_cer": self.casefold_distance / max(self.casefold_chars, 1),
            "casefold_normalized_exact_match": self.casefold_exact / max(self.samples, 1),
        }


def classify_error(reference: str, prediction: str) -> str:
    if reference == prediction:
        return "exact"
    if not prediction:
        return "empty_prediction"

    norm_ref = normalize_text(reference)
    norm_pred = normalize_text(prediction)
    if norm_ref == norm_pred:
        return "spacing_or_punctuation_variant_only"
    if norm_ref.casefold() == norm_pred.casefold():
        return "case_only"

    accent_ref = strip_accents(norm_ref).casefold()
    accent_pred = strip_accents(norm_pred).casefold()
    if accent_ref == accent_pred:
        return "accent_only"

    if not has_alnum(reference):
        return "punctuation_only_label"

    if len(prediction) <= max(1, len(reference) // 2):
        return "deletion_heavy"
    if len(prediction) >= max(2, int(len(reference) * 1.5)):
        return "insertion_heavy"
    return "recognition_error"


def row_buckets(row: dict, short_max_len: int, medium_max_len: int) -> set[str]:
    reference = row["reference"]
    length = len(reference)
    buckets = {"all"}
    if length <= short_max_len:
        buckets.add("short")
    elif length <= medium_max_len:
        buckets.add("medium")
    else:
        buckets.add("dialogue")
    if not has_alnum(reference):
        buckets.add("punctuation_only")
    if not row["prediction"]:
        buckets.add("empty_prediction")
    if row.get("line_count", 0) <= 1:
        buckets.add("single_line")
    else:
        buckets.add("multi_line")
    return buckets


def parse_int(value: str | int | None) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def load_predictions(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = []
        for raw in reader:
            reference = raw.get("reference") or ""
            prediction = raw.get("prediction") or ""
            row = dict(raw)
            row["reference"] = reference
            row["prediction"] = prediction
            row["line_count"] = parse_int(raw.get("line_count"))
            row["ref_len"] = len(reference)
            row["pred_len"] = len(prediction)
            rows.append(row)
    return rows


def summarize_rows(rows: list[dict], args: argparse.Namespace) -> tuple[dict, list[dict]]:
    buckets: dict[str, MetricBucket] = defaultdict(MetricBucket)
    error_types = Counter()
    substitutions = Counter()
    deletions = Counter()
    insertions = Counter()
    enriched = []

    for row in rows:
        reference = row["reference"]
        prediction = row["prediction"]
        norm_ref = normalize_text(reference)
        norm_pred = normalize_text(prediction)
        category = classify_error(reference, prediction)
        error_types[category] += 1

        for bucket in row_buckets(row, args.short_max_len, args.medium_max_len):
            buckets[bucket].add(reference, prediction)

        for op, left, right in align_ops(reference, prediction):
            if op == "substitution":
                substitutions[f"{left} -> {right}"] += 1
            elif op == "deletion":
                deletions[left] += 1
            elif op == "insertion":
                insertions[right] += 1

        raw_distance = levenshtein(reference, prediction)
        normalized_distance = levenshtein(norm_ref, norm_pred)
        enriched_row = {
            **row,
            "raw_distance": raw_distance,
            "raw_cer": raw_distance / max(len(reference), 1),
            "normalized_reference": norm_ref,
            "normalized_prediction": norm_pred,
            "normalized_distance": normalized_distance,
            "normalized_cer": normalized_distance / max(len(norm_ref), 1),
            "normalized_exact": norm_ref == norm_pred,
            "casefold_normalized_exact": norm_ref.casefold() == norm_pred.casefold(),
            "error_category": category,
        }
        enriched.append(enriched_row)

    enriched.sort(key=lambda item: (float(item["raw_cer"]), int(item["raw_distance"])), reverse=True)
    lengths = [len(row["reference"]) for row in rows]
    max_target_len = args.max_target_len or 0
    too_long = sum(length > max_target_len for length in lengths) if max_target_len else 0

    summary = {
        "run_name": args.run_name,
        "split": args.split,
        "predictions_csv": str(args.predictions_csv),
        "samples": len(rows),
        "buckets": {name: bucket.as_dict() for name, bucket in sorted(buckets.items())},
        "empty_predictions": sum(1 for row in rows if not row["prediction"]),
        "label_length_distribution": label_length_distribution(lengths),
        "ctc_max_target_len": max_target_len or None,
        "examples_over_ctc_max_target_len": too_long if max_target_len else None,
        "error_types": dict(error_types.most_common()),
        "character_confusions": {
            "substitutions": top_counter(substitutions, args.top_k),
            "deletions": top_counter(deletions, args.top_k),
            "insertions": top_counter(insertions, args.top_k),
        },
        "worst": [
            {
                key: item.get(key)
                for key in (
                    "image",
                    "reference",
                    "prediction",
                    "raw_cer",
                    "raw_distance",
                    "ref_len",
                    "pred_len",
                    "line_count",
                    "error_category",
                    "page_id",
                    "bubble_id",
                    "source_page_url",
                )
            }
            for item in enriched[: args.max_worst]
        ],
        "source_metrics": {
            "training_metrics": read_json(args.training_metrics),
            "dataset_stats": read_json(args.dataset_stats),
            "summary_json": read_json(args.summary_json),
        },
    }
    return summary, enriched


def write_enriched_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def image_cell(dataset_dir: Path | None, rel_path: str) -> str:
    if not dataset_dir:
        return html.escape(rel_path)
    image_path = dataset_dir / rel_path
    if not image_path.exists():
        return html.escape(rel_path)
    data = image_path.read_bytes()
    import base64

    encoded = base64.b64encode(data).decode("ascii")
    return f"<img src='data:image/png;base64,{encoded}' alt='{html.escape(rel_path)}'>"


def write_html(path: Path, summary: dict, rows: list[dict], dataset_dir: Path | None, max_rows: int) -> None:
    table_rows = []
    for item in rows[:max_rows]:
        table_rows.append(
            "<tr>"
            f"<td>{image_cell(dataset_dir, item.get('image', ''))}</td>"
            f"<td>{float(item['raw_cer']):.3f}</td>"
            f"<td>{html.escape(str(item.get('error_category', '')))}</td>"
            f"<td><code>{html.escape(item.get('reference', ''))}</code></td>"
            f"<td><code>{html.escape(item.get('prediction', ''))}</code></td>"
            f"<td>{html.escape(str(item.get('line_count', '')))}</td>"
            f"<td>{html.escape(str(item.get('bubble_id', '')))}</td>"
            "</tr>"
        )
    all_bucket = summary["buckets"].get("all", {})
    document = f"""<!doctype html>
<meta charset="utf-8">
<title>{html.escape(summary['run_name'])} {html.escape(summary['split'])} OCR errors</title>
<style>
body {{ font-family: Arial, sans-serif; margin: 24px; color: #171717; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #ddd; padding: 6px; vertical-align: top; }}
img {{ max-width: 560px; background: #f7f7f7; }}
code {{ white-space: pre-wrap; }}
.metrics {{ margin-bottom: 18px; }}
</style>
<h1>{html.escape(summary['run_name'])} - {html.escape(summary['split'])}</h1>
<div class="metrics">
Samples: {summary['samples']} |
Raw CER: {all_bucket.get('raw_cer', 0):.6f} |
Raw exact: {all_bucket.get('raw_exact_match', 0):.3f} |
Normalized exact: {all_bucket.get('normalized_exact_match', 0):.3f}
</div>
<table>
<thead><tr><th>Image</th><th>CER</th><th>Category</th><th>Reference</th><th>Prediction</th><th>Lines</th><th>Bubble</th></tr></thead>
<tbody>
{''.join(table_rows)}
</tbody>
</table>
"""
    path.write_text(document, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create rich OCR error reports from prediction CSV files.")
    parser.add_argument("--predictions-csv", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--run-name", required=True)
    parser.add_argument("--split", default="val")
    parser.add_argument("--dataset-dir", type=Path, default=None)
    parser.add_argument("--training-metrics", type=Path, default=None)
    parser.add_argument("--dataset-stats", type=Path, default=None)
    parser.add_argument("--summary-json", type=Path, default=None)
    parser.add_argument("--short-max-len", type=int, default=12)
    parser.add_argument("--medium-max-len", type=int, default=40)
    parser.add_argument("--max-target-len", type=int, default=0)
    parser.add_argument("--top-k", type=int, default=40)
    parser.add_argument("--max-worst", type=int, default=80)
    parser.add_argument("--max-html", type=int, default=120)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows = load_predictions(args.predictions_csv)
    summary, enriched = summarize_rows(rows, args)
    (args.output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_enriched_csv(args.output_dir / "predictions_enriched.csv", enriched)
    write_html(args.output_dir / "worst.html", summary, enriched, args.dataset_dir, args.max_html)
    print(json.dumps({"summary": str(args.output_dir / "summary.json"), "samples": len(rows)}, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
