import argparse
import collections
import csv
import json
import re
from pathlib import Path

import editdistance


TOKEN_RE = re.compile(r"[^\W\d_]+(?:['\u2019][^\W\d_]+)?", re.UNICODE)


def iter_label_texts(label_path: Path):
    for raw in label_path.read_text(encoding="utf-8").splitlines():
        if raw.strip():
            _, text = raw.split("\t", 1)
            yield text


def build_rules(label_path: Path, min_count: int, min_ratio: float, max_lower_ratio: float) -> dict:
    counts: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for text in iter_label_texts(label_path):
        for match in TOKEN_RE.finditer(text):
            token = match.group(0)
            counts[token.casefold()][token] += 1

    lexicon = {}
    for key, variants in sorted(counts.items()):
        total = sum(variants.values())
        best, best_count = variants.most_common(1)[0]
        lower_ratio = variants.get(key, 0) / max(total, 1)
        best_ratio = best_count / max(total, 1)
        lexicon[key] = {
            "best": best,
            "total": total,
            "best_ratio": round(best_ratio, 6),
            "lower_ratio": round(lower_ratio, 6),
        }

    return {
        "enabled": True,
        "type": "ppocrv6_train_lexicon_spacing_v1",
        "token_regex": "unicode_letters_with_optional_apostrophe",
        "min_count": min_count,
        "min_ratio": min_ratio,
        "max_lower_ratio": max_lower_ratio,
        "sentence_start": True,
        "lexicon": lexicon,
    }


def is_weird_case(token: str) -> bool:
    letters = [char for char in token if char.isalpha()]
    if len(letters) < 2:
        return False
    has_upper = any(char.isupper() for char in letters)
    has_lower = any(char.islower() for char in letters)
    if not (has_upper and has_lower):
        return False
    return not (token[:1].isupper() and token[1:].lower() == token[1:])


def fix_spacing(text: str) -> str:
    text = (text or "").strip().replace("\u2026", "...")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s*\.\s*\.\s*\.", "<ELLIPSIS>", text)
    text = re.sub(r"\s+([,.])", r"\1", text)
    text = re.sub(r"([,.])(\S)", r"\1 \2", text)
    text = re.sub(r"\s*([!?;:]+)", r" \1", text)
    text = text.replace("<ELLIPSIS>", "...")
    return re.sub(r"\s+", " ", text).strip()


def postprocess_text(text: str, rules: dict) -> str:
    text = fix_spacing(text)
    lexicon = rules.get("lexicon") or {}
    min_count = int(rules.get("min_count") or 1)
    min_ratio = float(rules.get("min_ratio") or 1.0)
    max_lower_ratio = float(rules.get("max_lower_ratio") or 0.0)
    sentence_start = bool(rules.get("sentence_start"))

    def replace(match: re.Match) -> str:
        token = match.group(0)
        key = token.casefold()
        entry = lexicon.get(key)
        if not entry:
            return token
        best = str(entry.get("best") or token)
        if is_weird_case(token):
            return best
        total = int(entry.get("total") or 0)
        best_ratio = float(entry.get("best_ratio") or 0.0)
        lower_ratio = float(entry.get("lower_ratio") or 0.0)
        if total >= min_count and best_ratio >= min_ratio and lower_ratio <= max_lower_ratio and best != key:
            if token.islower() or (sentence_start and match.start() == 0):
                return best
        return token

    return TOKEN_RE.sub(replace, text)


def compute_metrics(rows: list[dict], prediction_key: str) -> dict:
    distance = 0
    total_chars = 0
    exact = 0
    for row in rows:
        reference = row.get("reference") or ""
        prediction = row.get(prediction_key) or ""
        distance += editdistance.eval(prediction, reference)
        total_chars += len(reference)
        exact += prediction == reference
    return {
        "samples": len(rows),
        "cer": distance / max(total_chars, 1),
        "exact_match": exact / max(len(rows), 1),
    }


def evaluate_predictions(path: Path, rules: dict) -> dict:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row["postprocessed_prediction"] = postprocess_text(row.get("prediction") or "", rules)
    return {
        "predictions_csv": str(path),
        "raw": compute_metrics(rows, "prediction"),
        "postprocessed": compute_metrics(rows, "postprocessed_prediction"),
        "fixed_exact": sum(
            1
            for row in rows
            if row.get("prediction") != row.get("reference")
            and row.get("postprocessed_prediction") == row.get("reference")
        ),
        "broken_exact": sum(
            1
            for row in rows
            if row.get("prediction") == row.get("reference")
            and row.get("postprocessed_prediction") != row.get("reference")
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build PP-OCRv6 browser postprocess rules from train labels.")
    parser.add_argument("--train-labels", type=Path, required=True)
    parser.add_argument("--output-rules", type=Path, required=True)
    parser.add_argument("--inject-manifest", type=Path, default=None)
    parser.add_argument("--metrics-output", type=Path, default=None)
    parser.add_argument("--predictions-csv", type=Path, action="append", default=[])
    parser.add_argument("--min-count", type=int, default=2)
    parser.add_argument("--min-ratio", type=float, default=0.85)
    parser.add_argument("--max-lower-ratio", type=float, default=0.15)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rules = build_rules(args.train_labels, args.min_count, args.min_ratio, args.max_lower_ratio)
    args.output_rules.parent.mkdir(parents=True, exist_ok=True)
    args.output_rules.write_text(json.dumps(rules, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.inject_manifest:
        manifest = json.loads(args.inject_manifest.read_text(encoding="utf-8"))
        manifest["postprocess"] = rules
        args.inject_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    reports = [evaluate_predictions(path, rules) for path in args.predictions_csv]
    if args.metrics_output:
        args.metrics_output.parent.mkdir(parents=True, exist_ok=True)
        args.metrics_output.write_text(json.dumps({"reports": reports}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"rules": str(args.output_rules), "reports": reports}, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
