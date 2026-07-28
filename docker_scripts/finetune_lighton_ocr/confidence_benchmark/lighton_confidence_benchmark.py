"""Export and benchmark LightOnOCR-2 token confidence on Poneglyph ground truth.

The benchmark is deliberately isolated from the production OCR path. It exports
the frozen public test split from current validated Supabase rows, runs greedy
Transformers generation with per-step scores, aligns emitted token spans to
Levenshtein edits, and measures both discrimination and calibration.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import re
import statistics
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import Levenshtein
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import requests
import torch
from dotenv import load_dotenv
from huggingface_hub import model_info
from PIL import Image
from scipy.stats import mannwhitneyu, spearmanr
from sklearn.metrics import (
    average_precision_score,
    precision_recall_curve,
    roc_auc_score,
    roc_curve,
)
from supabase import Client, create_client
from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor

try:
    import pillow_avif  # noqa: F401
except ImportError:
    pillow_avif = None


SCRIPT_DIR = Path(__file__).resolve().parent
PARENT_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = PARENT_DIR.parent.parent
DATA_DIR = SCRIPT_DIR / "data"
IMAGE_DIR = DATA_DIR / "images"
PAGE_CACHE_DIR = DATA_DIR / "pages"
RESULTS_DIR = SCRIPT_DIR / "results"
GROUND_TRUTH_PATH = DATA_DIR / "ground_truth.jsonl"
EXPORT_REPORT_PATH = DATA_DIR / "export_report.json"
PREDICTIONS_PATH = RESULTS_DIR / "predictions.jsonl"
METRICS_PATH = RESULTS_DIR / "metrics.json"
SAMPLE_CSV_PATH = RESULTS_DIR / "sample_records.csv"
TOKEN_CSV_PATH = RESULTS_DIR / "token_records.csv"
WORD_CSV_PATH = RESULTS_DIR / "word_records.csv"
REPORT_PATH = RESULTS_DIR / "REPORT.md"

DEFAULT_MODEL_ID = "Remidesbois/LightonOCR-2-1b-poneglyph"
ENGINE_NAME = "LightOnOCR-2"
DEFAULT_BENCHMARK_URL = (
    "https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/"
    "resolve/main/benchmark_test.json"
)
DEFAULT_PROMPT = "\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :"
DEFAULT_STATUS = "Validé"
DEFAULT_SEED = 42


for env_path in (PARENT_DIR / ".env", PARENT_DIR.parent / ".env", PROJECT_ROOT / ".env"):
    load_dotenv(env_path)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_text(text: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(text or ""))).strip()


def json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Not JSON serializable: {type(value)!r}")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=json_default) + "\n",
        encoding="utf-8",
    )


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, default=json_default) + "\n")


def fetch_public_benchmark(url: str) -> dict[str, Any]:
    response = requests.get(url, timeout=90)
    response.raise_for_status()
    payload = response.json()
    if not payload.get("samples"):
        raise RuntimeError(f"Published benchmark has no samples: {url}")
    return payload


def fetch_validated_bubbles(
    supabase: Client, status: str, page_size: int = 1000
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        response = (
            supabase.table("bulles")
            .select("id,x,y,w,h,texte_propose,id_page,pages(url_image)")
            .eq("statut", status)
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = response.data or []
        rows.extend(batch)
        print(f"  Supabase: {len(rows)} bulles validées récupérées", flush=True)
        if len(batch) < page_size:
            break
        offset += page_size
    return rows


def page_url(row: dict[str, Any]) -> str | None:
    page = row.get("pages")
    if isinstance(page, list):
        page = page[0] if page else None
    return page.get("url_image") if isinstance(page, dict) else None


def download_page(page_id: str, url: str, timeout: int) -> Path:
    PAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(url.split("?", 1)[0]).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".avif"}:
        suffix = ".img"
    path = PAGE_CACHE_DIR / f"{page_id}{suffix}"
    if path.exists() and path.stat().st_size > 0:
        return path
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    path.write_bytes(response.content)
    return path


def crop_from_row(row: dict[str, Any], page_path: Path, output_path: Path) -> tuple[int, int]:
    with Image.open(page_path) as source:
        image = source.convert("RGB")
        image_width, image_height = image.size
        x = max(0, min(image_width, int(round(float(row["x"])))))
        y = max(0, min(image_height, int(round(float(row["y"])))))
        x2 = max(0, min(image_width, int(round(float(row["x"]) + float(row["w"])))))
        y2 = max(0, min(image_height, int(round(float(row["y"]) + float(row["h"])))))
        if x2 <= x or y2 <= y:
            raise ValueError(f"Invalid clipped bbox {(x, y, x2, y2)}")
        crop = image.crop((x, y, x2, y2))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        crop.save(output_path, format="PNG", optimize=True)
        return crop.size


def export_ground_truth(args: argparse.Namespace) -> dict[str, Any]:
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    print("Chargement du split test public figé...", flush=True)
    published = fetch_public_benchmark(args.benchmark_url)
    published_samples = sorted(
        published["samples"], key=lambda row: int(row.get("dataset_idx", 0))
    )
    if args.limit:
        published_samples = published_samples[: args.limit]
    published_by_id = {str(row["id"]): row for row in published_samples}

    print("Export des ground truths depuis Supabase...", flush=True)
    client = create_client(supabase_url, supabase_key)
    rows = fetch_validated_bubbles(client, args.status, args.supabase_page_size)
    matched_rows = {str(row["id"]): row for row in rows if str(row["id"]) in published_by_id}

    missing_ids = sorted(set(published_by_id) - set(matched_rows))
    ordered: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for sample in published_samples:
        row = matched_rows.get(str(sample["id"]))
        if row is not None:
            ordered.append((sample, row))

    urls_by_page: dict[str, str] = {}
    for _, row in ordered:
        url = page_url(row)
        if url:
            urls_by_page[str(row["id_page"])] = url

    print(f"Téléchargement de {len(urls_by_page)} pages sources...", flush=True)
    page_paths: dict[str, Path] = {}
    download_errors: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=args.download_workers) as pool:
        futures = {
            pool.submit(download_page, pid, url, args.request_timeout): pid
            for pid, url in urls_by_page.items()
        }
        for future in as_completed(futures):
            pid = futures[future]
            try:
                page_paths[pid] = future.result()
            except Exception as exc:
                download_errors[pid] = str(exc)

    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    crop_errors: dict[str, str] = {}
    drift: list[dict[str, Any]] = []
    for index, (published_sample, row) in enumerate(ordered, 1):
        sample_id = str(row["id"])
        pid = str(row["id_page"])
        if pid not in page_paths:
            crop_errors[sample_id] = f"source page unavailable: {download_errors.get(pid)}"
            continue
        try:
            image_path = IMAGE_DIR / f"{sample_id}.png"
            width, height = crop_from_row(row, page_paths[pid], image_path)
            reference = normalize_text(row.get("texte_propose"))
            published_reference = normalize_text(published_sample.get("reference"))
            if reference != published_reference:
                drift.append(
                    {
                        "id": row["id"],
                        "page_id": row["id_page"],
                        "published_reference": published_reference,
                        "supabase_reference": reference,
                        "levenshtein": Levenshtein.distance(
                            published_reference, reference
                        ),
                    }
                )
            records.append(
                {
                    "dataset_idx": published_sample.get("dataset_idx"),
                    "id": row["id"],
                    "page_id": row["id_page"],
                    "reference": reference,
                    "published_reference": published_reference,
                    "reference_changed_since_published_benchmark": (
                        reference != published_reference
                    ),
                    "bbox": [
                        int(row["x"]),
                        int(row["y"]),
                        int(row["w"]),
                        int(row["h"]),
                    ],
                    "image_file": str(image_path.relative_to(SCRIPT_DIR)).replace("\\", "/"),
                    "image_width": width,
                    "image_height": height,
                }
            )
        except Exception as exc:
            crop_errors[sample_id] = str(exc)
        if index % 100 == 0 or index == len(ordered):
            print(f"  crops: {index}/{len(ordered)}", flush=True)

    with GROUND_TRUTH_PATH.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    report = {
        "created_at": now_iso(),
        "source": {
            "table": "bulles",
            "status": args.status,
            "ground_truth_field": "texte_propose",
            "image_relation": "pages(url_image)",
        },
        "selection": {
            "method": "IDs from the frozen public held-out benchmark",
            "benchmark_url": args.benchmark_url,
            "published_sample_count": len(published_samples),
            "matched_validated_supabase_rows": len(ordered),
            "exported_crop_count": len(records),
            "missing_or_no_longer_validated_ids": missing_ids,
        },
        "ground_truth_drift": {
            "count": len(drift),
            "rows": drift,
        },
        "download_errors": download_errors,
        "crop_errors": crop_errors,
        "output": str(GROUND_TRUTH_PATH),
    }
    write_json(EXPORT_REPORT_PATH, report)
    print(
        f"Export terminé: {len(records)} crops, {len(drift)} références modifiées, "
        f"{len(missing_ids)} IDs absents.",
        flush=True,
    )
    return report


def build_prompt(processor: LightOnOcrProcessor, prompt: str) -> str:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    return processor.apply_chat_template(
        messages, add_generation_prompt=True, tokenize=False
    )


def model_dtype(model: torch.nn.Module) -> torch.dtype:
    for parameter in model.parameters():
        if parameter.is_floating_point():
            return parameter.dtype
    return torch.float32


def move_inputs(
    inputs: dict[str, torch.Tensor], device: torch.device, dtype: torch.dtype
) -> dict[str, torch.Tensor]:
    moved = {}
    for key, value in inputs.items():
        if value.is_floating_point():
            moved[key] = value.to(device=device, dtype=dtype)
        else:
            moved[key] = value.to(device=device)
    return moved


def decoded_pieces(
    tokenizer: Any, token_ids: list[int]
) -> tuple[list[str], str, bool]:
    pieces = [
        tokenizer.decode(
            [token_id],
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )
        for token_id in token_ids
    ]
    joined = "".join(pieces)
    full = tokenizer.decode(
        token_ids,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )
    return pieces, full, joined == full


def postprocess_prediction(text: str) -> str:
    normalized = unicodedata.normalize("NFC", str(text).strip())
    if "\n" in normalized:
        normalized = normalized.splitlines()[0].strip()
    return normalized


def token_details_from_generation(
    model: torch.nn.Module,
    processor: LightOnOcrProcessor,
    outputs: Any,
    top_k: int,
    batch_index: int = 0,
    transition_scores: torch.Tensor | None = None,
) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
    step_count = len(outputs.scores)
    if step_count == 0:
        return [], "", {"piece_decode_exact": True, "step_count": 0}
    generated_ids = (
        outputs.sequences[batch_index, -step_count:].detach().cpu().tolist()
    )
    if transition_scores is None:
        transition_scores = model.compute_transition_scores(
            outputs.sequences,
            outputs.scores,
            beam_indices=getattr(outputs, "beam_indices", None),
            normalize_logits=True,
        )
    transition = transition_scores[batch_index]

    eos_ids = processor.tokenizer.eos_token_id
    eos_set = set(eos_ids if isinstance(eos_ids, list) else [eos_ids])
    pad_id = processor.tokenizer.pad_token_id
    effective_ids: list[int] = []
    effective_steps: list[int] = []
    for step, token_id in enumerate(generated_ids):
        if token_id in eos_set or (pad_id is not None and token_id == pad_id):
            break
        effective_ids.append(int(token_id))
        effective_steps.append(step)

    pieces, decoded, piece_decode_exact = decoded_pieces(
        processor.tokenizer, effective_ids
    )
    tokens: list[dict[str, Any]] = []
    cursor = 0
    for token_position, (step, token_id, piece) in enumerate(
        zip(effective_steps, effective_ids, pieces)
    ):
        log_probability = float(transition[step].detach().cpu())
        probability = float(math.exp(max(log_probability, -100.0)))
        logits = outputs.scores[step][batch_index].float()
        log_probs = torch.log_softmax(logits, dim=-1)
        values, ids = torch.topk(log_probs, k=min(top_k + 1, log_probs.shape[-1]))
        alternatives = []
        top_probabilities = []
        for value, alternative_id in zip(
            values.detach().cpu().tolist(), ids.detach().cpu().tolist()
        ):
            alternative_probability = float(math.exp(max(float(value), -100.0)))
            top_probabilities.append(alternative_probability)
            if int(alternative_id) == token_id:
                continue
            alternatives.append(
                {
                    "token_id": int(alternative_id),
                    "text": processor.tokenizer.decode(
                        [int(alternative_id)],
                        skip_special_tokens=False,
                        clean_up_tokenization_spaces=False,
                    ),
                    "probability": alternative_probability,
                }
            )
            if len(alternatives) >= top_k:
                break
        top1 = top_probabilities[0] if top_probabilities else probability
        top2 = top_probabilities[1] if len(top_probabilities) > 1 else 0.0
        tokens.append(
            {
                "position": token_position,
                "token_id": token_id,
                "text": piece,
                "char_start": cursor,
                "char_end": cursor + len(piece),
                "log_probability": log_probability,
                "probability": probability,
                "top1_probability": top1,
                "top1_top2_margin": top1 - top2,
                "alternatives": alternatives,
            }
        )
        cursor += len(piece)
    metadata = {
        "piece_decode_exact": piece_decode_exact,
        "step_count": step_count,
        "effective_token_count": len(tokens),
    }
    return tokens, decoded, metadata


def confidence_aggregates(tokens: list[dict[str, Any]]) -> dict[str, Any]:
    probabilities = np.asarray([token["probability"] for token in tokens], dtype=float)
    log_probabilities = np.asarray(
        [token["log_probability"] for token in tokens], dtype=float
    )
    margins = np.asarray([token["top1_top2_margin"] for token in tokens], dtype=float)
    if not len(probabilities):
        return {
            "token_count": 0,
            "mean_confidence": 0.0,
            "geometric_mean_confidence": 0.0,
            "min_confidence": 0.0,
            "p10_confidence": 0.0,
            "mean_margin": 0.0,
            "min_margin": 0.0,
            "mean_negative_log_likelihood": float("inf"),
            "low_confidence_count_050": 0,
            "low_confidence_count_080": 0,
            "low_confidence_count_090": 0,
        }
    return {
        "token_count": int(len(probabilities)),
        "mean_confidence": float(probabilities.mean()),
        "geometric_mean_confidence": float(np.exp(log_probabilities.mean())),
        "min_confidence": float(probabilities.min()),
        "p10_confidence": float(np.quantile(probabilities, 0.10)),
        "mean_margin": float(margins.mean()),
        "min_margin": float(margins.min()),
        "mean_negative_log_likelihood": float(-log_probabilities.mean()),
        "low_confidence_count_050": int((probabilities < 0.50).sum()),
        "low_confidence_count_080": int((probabilities < 0.80).sum()),
        "low_confidence_count_090": int((probabilities < 0.90).sum()),
    }


def infer(args: argparse.Namespace) -> dict[str, Any]:
    if not GROUND_TRUTH_PATH.exists():
        raise FileNotFoundError(
            f"{GROUND_TRUTH_PATH} is missing; run the export command first"
        )
    samples = read_jsonl(GROUND_TRUTH_PATH)
    if args.limit:
        samples = samples[: args.limit]
    if not samples:
        raise RuntimeError("No ground-truth samples to infer")

    revision = args.revision
    if revision is None:
        revision = model_info(args.model_id).sha
    print(f"Modèle: {args.model_id}@{revision}", flush=True)

    processor = LightOnOcrProcessor.from_pretrained(
        args.model_id, revision=revision, token=os.getenv("HF_TOKEN")
    )
    processor.image_processor.default_to_square = False
    processor.image_processor.size = {"longest_edge": args.image_longest_edge}
    processor.tokenizer.padding_side = "left"
    if processor.tokenizer.pad_token_id is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token

    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
    print(f"Chargement en {dtype} sur {device}...", flush=True)
    model_kwargs: dict[str, Any] = {
        "revision": revision,
        "token": os.getenv("HF_TOKEN"),
        "torch_dtype": dtype,
        "attn_implementation": "sdpa",
        "low_cpu_mem_usage": True,
    }
    if device.type == "cuda":
        model_kwargs["device_map"] = {"": "cuda:0"}
    model = LightOnOcrForConditionalGeneration.from_pretrained(
        args.model_id, **model_kwargs
    )
    if device.type != "cuda":
        model.to(device)
    model.eval()
    model.config.use_cache = True
    prompt = build_prompt(processor, args.prompt)

    existing: dict[str, dict[str, Any]] = {}
    if args.resume and PREDICTIONS_PATH.exists():
        existing = {str(row["id"]): row for row in read_jsonl(PREDICTIONS_PATH)}
        print(f"Reprise: {len(existing)} prédictions déjà présentes.", flush=True)
    else:
        PREDICTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
        PREDICTIONS_PATH.write_text("", encoding="utf-8")

    pending_samples = [
        sample for sample in samples if str(sample["id"]) not in existing
    ]
    started_all = time.perf_counter()
    processed = 0
    for batch_start in range(0, len(pending_samples), args.batch_size):
        batch = pending_samples[batch_start : batch_start + args.batch_size]
        images = []
        for sample in batch:
            image_path = SCRIPT_DIR / sample["image_file"]
            with Image.open(image_path) as source:
                images.append(source.convert("RGB"))
        inputs = processor(
            text=[prompt] * len(batch),
            images=images,
            padding=True,
            truncation=True,
            max_length=args.max_sequence_length,
            size={"longest_edge": args.image_longest_edge},
            return_tensors="pt",
        )
        inputs = move_inputs(inputs, device, model_dtype(model))
        if device.type == "cuda":
            torch.cuda.reset_peak_memory_stats(device)
        started = time.perf_counter()
        with torch.inference_mode():
            outputs = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                return_dict_in_generate=True,
                output_scores=True,
            )
        elapsed = time.perf_counter() - started
        transition_scores = model.compute_transition_scores(
            outputs.sequences,
            outputs.scores,
            beam_indices=getattr(outputs, "beam_indices", None),
            normalize_logits=True,
        )
        peak_memory = (
            int(torch.cuda.max_memory_allocated(device))
            if device.type == "cuda"
            else None
        )
        for batch_index, sample in enumerate(batch):
            tokens, decoded, decode_meta = token_details_from_generation(
                model,
                processor,
                outputs,
                args.top_k,
                batch_index=batch_index,
                transition_scores=transition_scores,
            )
            prediction = postprocess_prediction(decoded)
            # The production post-processing keeps only the first line. Exclude
            # score-bearing tokens outside that displayed text from aggregation.
            displayed_tokens = [
                token for token in tokens if token["char_start"] < len(prediction)
            ]
            if (
                displayed_tokens
                and displayed_tokens[-1]["char_end"] > len(prediction)
            ):
                displayed_tokens[-1] = {
                    **displayed_tokens[-1],
                    "char_end": len(prediction),
                    "text": prediction[
                        displayed_tokens[-1]["char_start"] : len(prediction)
                    ],
                }
            reference = normalize_text(sample["reference"])
            distance = Levenshtein.distance(prediction, reference)
            record = {
                **sample,
                "model_id": args.model_id,
                "model_revision": revision,
                "prompt": args.prompt,
                "raw_prediction": decoded,
                "prediction": prediction,
                "exact_match": prediction == reference,
                "levenshtein": distance,
                "cer": distance / max(len(reference), 1),
                "generation_seconds": elapsed / len(batch),
                "generation_batch_seconds": elapsed,
                "generation_batch_size": len(batch),
                "peak_cuda_memory_bytes": peak_memory,
                "generation_metadata": decode_meta,
                "confidence": confidence_aggregates(displayed_tokens),
                "tokens": displayed_tokens,
            }
            append_jsonl(PREDICTIONS_PATH, record)
        del outputs, inputs
        if device.type == "cuda":
            torch.cuda.empty_cache()
        processed += len(batch)
        completed = len(existing) + processed
        if completed % max(args.batch_size * 4, 1) == 0 or completed == len(samples):
            elapsed_all = time.perf_counter() - started_all
            print(
                f"  inférence {completed}/{len(samples)} | "
                f"{elapsed_all / max(processed, 1):.2f}s/nouvel exemple",
                flush=True,
            )

    rows = read_jsonl(PREDICTIONS_PATH)
    wanted = {str(row["id"]) for row in samples}
    rows = [row for row in rows if str(row["id"]) in wanted]
    summary = {
        "created_at": now_iso(),
        "model_id": args.model_id,
        "model_revision": revision,
        "sample_count": len(rows),
        "new_inference_count": processed,
        "wall_seconds": time.perf_counter() - started_all,
        "prediction_path": str(PREDICTIONS_PATH),
    }
    write_json(RESULTS_DIR / "inference_report.json", summary)
    return summary


def profile_confidence_overhead(args: argparse.Namespace) -> dict[str, Any]:
    """Compare normal generation with chosen-token score extraction."""
    if not GROUND_TRUTH_PATH.exists():
        raise FileNotFoundError(
            f"{GROUND_TRUTH_PATH} is missing; run the export command first"
        )
    samples = read_jsonl(GROUND_TRUTH_PATH)[: args.profile_samples]
    if not samples:
        raise RuntimeError("No ground-truth samples to profile")

    revision = args.revision or model_info(args.model_id).sha
    processor = LightOnOcrProcessor.from_pretrained(
        args.model_id, revision=revision, token=os.getenv("HF_TOKEN")
    )
    processor.image_processor.default_to_square = False
    processor.image_processor.size = {"longest_edge": args.image_longest_edge}
    processor.tokenizer.padding_side = "left"
    if processor.tokenizer.pad_token_id is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token
    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
    kwargs: dict[str, Any] = {
        "revision": revision,
        "token": os.getenv("HF_TOKEN"),
        "torch_dtype": dtype,
        "attn_implementation": "sdpa",
        "low_cpu_mem_usage": True,
    }
    if device.type == "cuda":
        kwargs["device_map"] = {"": "cuda:0"}
    model = LightOnOcrForConditionalGeneration.from_pretrained(args.model_id, **kwargs)
    if device.type != "cuda":
        model.to(device)
    model.eval()
    model.config.use_cache = True
    prompt = build_prompt(processor, args.prompt)

    def prepare(batch: list[dict[str, Any]]) -> dict[str, torch.Tensor]:
        images = []
        for sample in batch:
            with Image.open(SCRIPT_DIR / sample["image_file"]) as source:
                images.append(source.convert("RGB"))
        inputs = processor(
            text=[prompt] * len(batch),
            images=images,
            padding=True,
            truncation=True,
            max_length=args.max_sequence_length,
            size={"longest_edge": args.image_longest_edge},
            return_tensors="pt",
        )
        return move_inputs(inputs, device, model_dtype(model))

    batches = [
        samples[start : start + args.batch_size]
        for start in range(0, len(samples), args.batch_size)
    ]
    # Warm both image-shape and CUDA kernels without recording the result.
    warm_inputs = prepare(batches[0])
    with torch.inference_mode():
        warm_output = model.generate(
            **warm_inputs,
            max_new_tokens=args.max_new_tokens,
            do_sample=False,
        )
    del warm_output, warm_inputs
    if device.type == "cuda":
        torch.cuda.empty_cache()

    timings: dict[str, list[float]] = {
        "baseline_generation_seconds": [],
        "scored_generation_seconds": [],
        "score_extraction_seconds": [],
    }
    peaks: dict[str, list[int | None]] = {"baseline": [], "scored": []}
    sequence_hashes: dict[str, list[str]] = {"baseline": [], "scored": []}

    def run_mode(mode: str, capture_hashes: bool) -> None:
        generation_seconds = 0.0
        extraction_seconds = 0.0
        if device.type == "cuda":
            torch.cuda.reset_peak_memory_stats(device)
        for batch in batches:
            inputs = prepare(batch)
            if device.type == "cuda":
                torch.cuda.synchronize(device)
            started = time.perf_counter()
            with torch.inference_mode():
                if mode == "baseline":
                    outputs = model.generate(
                        **inputs,
                        max_new_tokens=args.max_new_tokens,
                        do_sample=False,
                    )
                    sequences = outputs
                else:
                    outputs = model.generate(
                        **inputs,
                        max_new_tokens=args.max_new_tokens,
                        do_sample=False,
                        return_dict_in_generate=True,
                        output_scores=True,
                    )
                    sequences = outputs.sequences
            if device.type == "cuda":
                torch.cuda.synchronize(device)
            generation_seconds += time.perf_counter() - started
            if mode == "scored":
                extraction_started = time.perf_counter()
                transition = model.compute_transition_scores(
                    outputs.sequences,
                    outputs.scores,
                    beam_indices=getattr(outputs, "beam_indices", None),
                    normalize_logits=True,
                )
                # Materialize the selected probabilities as the production
                # confidence path would, but do not compute unused alternatives.
                _ = transition.exp().float().cpu()
                extraction_seconds += time.perf_counter() - extraction_started
            if capture_hashes:
                for row in sequences.detach().cpu().numpy():
                    sequence_hashes[mode].append(
                        hashlib.sha256(row.tobytes()).hexdigest()
                    )
            del outputs, sequences, inputs
        timings[f"{mode}_generation_seconds"].append(generation_seconds)
        if mode == "scored":
            timings["score_extraction_seconds"].append(extraction_seconds)
        peaks[mode].append(
            int(torch.cuda.max_memory_allocated(device))
            if device.type == "cuda"
            else None
        )
        if device.type == "cuda":
            torch.cuda.empty_cache()

    for repeat in range(args.profile_repeats):
        order = ("baseline", "scored") if repeat % 2 == 0 else ("scored", "baseline")
        for mode in order:
            print(
                f"  profil {repeat + 1}/{args.profile_repeats}: {mode}",
                flush=True,
            )
            run_mode(mode, capture_hashes=repeat == 0)

    baseline = float(statistics.median(timings["baseline_generation_seconds"]))
    scored = float(statistics.median(timings["scored_generation_seconds"]))
    extraction = float(statistics.median(timings["score_extraction_seconds"]))
    baseline_peak = max(value for value in peaks["baseline"] if value is not None)
    scored_peak = max(value for value in peaks["scored"] if value is not None)
    report = {
        "created_at": now_iso(),
        "model_id": args.model_id,
        "model_revision": revision,
        "device": str(device),
        "dtype": str(dtype),
        "sample_count": len(samples),
        "batch_size": args.batch_size,
        "repeats": args.profile_repeats,
        "timings_raw": timings,
        "median": {
            "baseline_generation_seconds": baseline,
            "scored_generation_seconds": scored,
            "score_extraction_seconds": extraction,
            "scored_total_seconds": scored + extraction,
            "baseline_samples_per_second": len(samples) / baseline,
            "scored_samples_per_second": len(samples) / (scored + extraction),
            "incremental_seconds": scored + extraction - baseline,
            "relative_time_overhead": (scored + extraction) / baseline - 1,
        },
        "cuda_memory": {
            "baseline_peak_bytes": baseline_peak,
            "scored_peak_bytes": scored_peak,
            "incremental_peak_bytes": scored_peak - baseline_peak,
            "relative_peak_overhead": scored_peak / baseline_peak - 1,
        },
        "sequence_equivalence": {
            "compared": len(sequence_hashes["baseline"]),
            "mismatch_count": sum(
                left != right
                for left, right in zip(
                    sequence_hashes["baseline"], sequence_hashes["scored"]
                )
            ),
        },
        "scope": (
            "output_scores=True plus compute_transition_scores for chosen tokens; "
            "top-k alternatives intentionally excluded"
        ),
    }
    write_json(RESULTS_DIR / "performance_profile.json", report)
    print(
        f"Profil terminé: temps +{report['median']['relative_time_overhead'] * 100:.2f} %, "
        f"VRAM +{report['cuda_memory']['incremental_peak_bytes'] / 2**20:.1f} Mio",
        flush=True,
    )
    return report


@dataclass
class EditMap:
    bad_source_positions: set[int]
    bad_source_intervals: list[tuple[int, int, str]]
    insertions: list[tuple[int, int, int]]
    opcodes: list[tuple[str, int, int, int, int]]


def edit_map(prediction: str, reference: str) -> EditMap:
    opcodes = Levenshtein.opcodes(prediction, reference)
    bad_positions: set[int] = set()
    intervals: list[tuple[int, int, str]] = []
    insertions: list[tuple[int, int, int]] = []
    for tag, i1, i2, j1, j2 in opcodes:
        if tag in {"replace", "delete"}:
            bad_positions.update(range(i1, i2))
            intervals.append((i1, i2, tag))
        elif tag == "insert":
            insertions.append((i1, j1, j2))
    return EditMap(bad_positions, intervals, insertions, opcodes)


def overlaps(start: int, end: int, left: int, right: int) -> bool:
    return max(start, left) < min(end, right)


def token_rows_for_sample(sample: dict[str, Any]) -> list[dict[str, Any]]:
    prediction = sample["prediction"]
    reference = normalize_text(sample["reference"])
    edits = edit_map(prediction, reference)
    rows: list[dict[str, Any]] = []
    tokens = sample.get("tokens", [])
    for token in tokens:
        start, end = int(token["char_start"]), int(token["char_end"])
        error_types = sorted(
            {
                tag
                for left, right, tag in edits.bad_source_intervals
                if overlaps(start, end, left, right)
            }
        )
        adjacent_insertions = [
            {"prediction_position": position, "reference_start": j1, "reference_end": j2}
            for position, j1, j2 in edits.insertions
            if (start <= position < end)
            or (position == len(prediction) and end == len(prediction))
        ]
        rows.append(
            {
                "id": sample["id"],
                "page_id": sample["page_id"],
                "token_position": token["position"],
                "token_id": token["token_id"],
                "token_text": token["text"],
                "char_start": start,
                "char_end": end,
                "probability": token["probability"],
                "log_probability": token["log_probability"],
                "margin": token["top1_top2_margin"],
                "token_error": bool(error_types),
                "error_types": ",".join(error_types),
                "adjacent_omission": bool(adjacent_insertions),
                "sample_error": not sample["exact_match"],
                "prediction": prediction,
                "reference": reference,
            }
        )
    return rows


def word_rows_for_sample(
    sample: dict[str, Any], token_rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    prediction = sample["prediction"]
    reference = normalize_text(sample["reference"])
    edits = edit_map(prediction, reference)
    rows = []
    for word_position, match in enumerate(re.finditer(r"\S+", prediction)):
        start, end = match.span()
        covered = [
            row
            for row in token_rows
            if overlaps(start, end, row["char_start"], row["char_end"])
        ]
        if not covered:
            continue
        probabilities = np.asarray([row["probability"] for row in covered])
        word_error = any(
            overlaps(start, end, left, right)
            for left, right, _ in edits.bad_source_intervals
        )
        adjacent_omission = any(start <= position <= end for position, _, _ in edits.insertions)
        rows.append(
            {
                "id": sample["id"],
                "page_id": sample["page_id"],
                "word_position": word_position,
                "word": match.group(),
                "char_start": start,
                "char_end": end,
                "mean_confidence": float(probabilities.mean()),
                "geometric_mean_confidence": float(
                    np.exp(np.log(np.clip(probabilities, 1e-12, 1)).mean())
                ),
                "min_confidence": float(probabilities.min()),
                "word_error": word_error,
                "adjacent_omission": adjacent_omission,
                "word_error_including_adjacent_omission": (
                    word_error or adjacent_omission
                ),
                "prediction": prediction,
                "reference": reference,
            }
        )
    return rows


SAMPLE_CONFIDENCE_SIGNALS = {
    "mean_confidence": False,
    "geometric_mean_confidence": False,
    "min_confidence": False,
    "p10_confidence": False,
    "mean_margin": False,
    "min_margin": False,
    "mean_negative_log_likelihood": True,
    "low_confidence_count_050": True,
    "low_confidence_count_080": True,
    "low_confidence_count_090": True,
}


def uncertainty_values(
    frame: pd.DataFrame, name: str, already_uncertainty: bool
) -> np.ndarray:
    values = frame[name].to_numpy(dtype=float)
    return values if already_uncertainty else -values


def safe_discrimination(labels: np.ndarray, scores: np.ndarray) -> dict[str, Any]:
    if len(np.unique(labels)) < 2:
        return {"roc_auc": None, "average_precision": None}
    return {
        "roc_auc": float(roc_auc_score(labels, scores)),
        "average_precision": float(average_precision_score(labels, scores)),
    }


def review_budgets(
    labels: np.ndarray, uncertainty: np.ndarray, budgets: Iterable[float]
) -> dict[str, Any]:
    order = np.argsort(-uncertainty, kind="stable")
    total_errors = int(labels.sum())
    result = {}
    for budget in budgets:
        count = max(1, int(math.ceil(len(labels) * budget)))
        reviewed = labels[order[:count]]
        captured = int(reviewed.sum())
        result[f"{budget:.2f}"] = {
            "review_count": count,
            "errors_captured": captured,
            "error_recall": captured / max(total_errors, 1),
            "review_precision": captured / count,
            "random_expected_error_recall": budget,
            "recall_uplift_over_random": (
                (captured / max(total_errors, 1)) / budget if budget else None
            ),
        }
    return result


def bootstrap_by_page(
    frame: pd.DataFrame,
    label_column: str,
    uncertainty: np.ndarray,
    iterations: int,
    seed: int,
) -> dict[str, Any]:
    work = frame[["page_id", label_column]].copy()
    work["uncertainty"] = uncertainty
    groups = {key: group for key, group in work.groupby("page_id", sort=False)}
    pages = list(groups)
    rng = np.random.default_rng(seed)
    aucs, aps, recalls10, recalls20 = [], [], [], []
    for _ in range(iterations):
        sampled = rng.choice(pages, size=len(pages), replace=True)
        replica = pd.concat([groups[page] for page in sampled], ignore_index=True)
        labels = replica[label_column].astype(int).to_numpy()
        scores = replica["uncertainty"].to_numpy()
        if len(np.unique(labels)) < 2:
            continue
        aucs.append(roc_auc_score(labels, scores))
        aps.append(average_precision_score(labels, scores))
        budgets = review_budgets(labels, scores, (0.10, 0.20))
        recalls10.append(budgets["0.10"]["error_recall"])
        recalls20.append(budgets["0.20"]["error_recall"])

    def interval(values: list[float]) -> list[float] | None:
        if not values:
            return None
        return [float(np.quantile(values, 0.025)), float(np.quantile(values, 0.975))]

    return {
        "iterations_requested": iterations,
        "iterations_valid": len(aucs),
        "resampling_unit": "page_id",
        "roc_auc_ci95": interval(aucs),
        "average_precision_ci95": interval(aps),
        "error_recall_at_10pct_review_ci95": interval(recalls10),
        "error_recall_at_20pct_review_ci95": interval(recalls20),
    }


def calibration(
    correctness: np.ndarray, confidence: np.ndarray, bins: int = 10
) -> dict[str, Any]:
    correctness = correctness.astype(float)
    confidence = np.clip(confidence.astype(float), 0.0, 1.0)
    edges = np.linspace(0.0, 1.0, bins + 1)
    rows = []
    ece = 0.0
    for index in range(bins):
        left, right = edges[index], edges[index + 1]
        mask = (confidence >= left) & (
            confidence <= right if index == bins - 1 else confidence < right
        )
        count = int(mask.sum())
        if not count:
            continue
        mean_conf = float(confidence[mask].mean())
        accuracy = float(correctness[mask].mean())
        ece += count / len(confidence) * abs(mean_conf - accuracy)
        rows.append(
            {
                "left": left,
                "right": right,
                "count": count,
                "mean_confidence": mean_conf,
                "empirical_accuracy": accuracy,
                "gap": mean_conf - accuracy,
            }
        )
    return {
        "sample_count": len(confidence),
        "bins": rows,
        "expected_calibration_error": float(ece),
        "brier_score": float(np.mean((confidence - correctness) ** 2)),
        "mean_confidence": float(confidence.mean()),
        "empirical_accuracy": float(correctness.mean()),
    }


def confidence_thresholds_for_recall(
    labels: np.ndarray, confidence: np.ndarray, targets=(0.80, 0.90, 0.95)
) -> dict[str, Any]:
    total_errors = int(labels.sum())
    candidates = sorted(set(float(value) for value in confidence))
    result = {}
    for target in targets:
        selected = None
        for threshold in candidates:
            reviewed = confidence <= threshold
            recall = int(labels[reviewed].sum()) / max(total_errors, 1)
            if recall >= target:
                selected = {
                    "confidence_at_or_below": threshold,
                    "review_count": int(reviewed.sum()),
                    "review_fraction": float(reviewed.mean()),
                    "error_recall": recall,
                    "review_precision": float(labels[reviewed].mean()),
                }
                break
        result[f"{target:.2f}"] = selected
    return result


def sample_frame(predictions: list[dict[str, Any]]) -> pd.DataFrame:
    rows = []
    for sample in predictions:
        confidence = sample["confidence"]
        reference = normalize_text(sample["reference"])
        prediction = sample["prediction"]

        def content_key(text: str) -> str:
            return "".join(
                character
                for character in unicodedata.normalize("NFC", text).casefold()
                if character.isalnum()
            )

        if prediction == reference:
            error_category = "exact"
        elif content_key(prediction) == content_key(reference):
            error_category = "typography_case_only"
        else:
            error_category = "substantive"
        rows.append(
            {
                "id": sample["id"],
                "page_id": sample["page_id"],
                "reference": reference,
                "prediction": prediction,
                "sample_error": not sample["exact_match"],
                "substantive_error": error_category == "substantive",
                "error_category": error_category,
                "cer": sample["cer"],
                "levenshtein": sample["levenshtein"],
                "generation_seconds": sample["generation_seconds"],
                "peak_cuda_memory_bytes": sample.get("peak_cuda_memory_bytes"),
                "reference_changed_since_published_benchmark": sample.get(
                    "reference_changed_since_published_benchmark", False
                ),
                **confidence,
            }
        )
    return pd.DataFrame(rows)


def plot_sample_analysis(
    sample_df: pd.DataFrame,
    best_signal: str,
    best_uncertainty: np.ndarray,
    metrics: dict[str, Any],
) -> None:
    labels = sample_df["sample_error"].astype(int).to_numpy()
    figure, axes = plt.subplots(2, 2, figsize=(15, 11))
    figure.suptitle(
        f"{ENGINE_NAME} — confiance et erreurs au niveau bulle", fontsize=16
    )

    correct = sample_df.loc[~sample_df["sample_error"], best_signal].to_numpy()
    errors = sample_df.loc[sample_df["sample_error"], best_signal].to_numpy()
    axes[0, 0].boxplot(
        [correct, errors],
        tick_labels=["Exact", "Erreur"],
        showfliers=True,
        widths=0.55,
    )
    axes[0, 0].set_title(f"Distribution du signal recommandé : {best_signal}")
    axes[0, 0].set_ylabel(best_signal)
    axes[0, 0].grid(axis="y", alpha=0.25)

    top_signals = sorted(
        metrics["sample_level"]["signals"].items(),
        key=lambda item: item[1]["roc_auc"] or -1,
        reverse=True,
    )[:4]
    for name, signal_metrics in top_signals:
        signal_scores = uncertainty_values(
            sample_df, name, SAMPLE_CONFIDENCE_SIGNALS[name]
        )
        false_positive, true_positive, _ = roc_curve(labels, signal_scores)
        axes[0, 1].plot(
            false_positive,
            true_positive,
            label=f"{name} (AUC={signal_metrics['roc_auc']:.3f})",
        )
    axes[0, 1].plot([0, 1], [0, 1], "--", color="gray", label="Hasard")
    axes[0, 1].set_title("ROC — détection des bulles erronées")
    axes[0, 1].set_xlabel("Taux de faux positifs")
    axes[0, 1].set_ylabel("Rappel des erreurs")
    axes[0, 1].legend(fontsize=8)
    axes[0, 1].grid(alpha=0.25)

    for name, signal_metrics in top_signals:
        signal_scores = uncertainty_values(
            sample_df, name, SAMPLE_CONFIDENCE_SIGNALS[name]
        )
        precision, recall, _ = precision_recall_curve(labels, signal_scores)
        axes[1, 0].plot(
            recall,
            precision,
            label=f"{name} (AP={signal_metrics['average_precision']:.3f})",
        )
    axes[1, 0].axhline(labels.mean(), ls="--", color="gray", label="Prévalence")
    axes[1, 0].set_title("Précision-rappel — classe rare « erreur »")
    axes[1, 0].set_xlabel("Rappel des erreurs")
    axes[1, 0].set_ylabel("Précision de la revue")
    axes[1, 0].legend(fontsize=8)
    axes[1, 0].grid(alpha=0.25)

    order = np.argsort(-best_uncertainty, kind="stable")
    cumulative = np.cumsum(labels[order]) / max(labels.sum(), 1)
    reviewed = np.arange(1, len(labels) + 1) / len(labels)
    axes[1, 1].plot(reviewed, cumulative, lw=2, label=best_signal)
    axes[1, 1].plot([0, 1], [0, 1], "--", color="gray", label="Ordre aléatoire")
    axes[1, 1].set_title("Erreurs capturées selon le budget de revue")
    axes[1, 1].set_xlabel("Fraction des bulles relues")
    axes[1, 1].set_ylabel("Fraction des erreurs capturées")
    axes[1, 1].legend()
    axes[1, 1].grid(alpha=0.25)

    figure.tight_layout(rect=(0, 0, 1, 0.96))
    figure.savefig(
        RESULTS_DIR / "lighton_confidence_sample_level.png",
        dpi=180,
        bbox_inches="tight",
    )
    plt.close(figure)


def plot_token_analysis(token_df: pd.DataFrame, token_calibration: dict[str, Any]) -> None:
    labels = token_df["token_error"].astype(int).to_numpy()
    confidence = token_df["probability"].to_numpy(dtype=float)
    figure, axes = plt.subplots(2, 2, figsize=(15, 11))
    figure.suptitle(
        f"{ENGINE_NAME} — confiance et erreurs au niveau token", fontsize=16
    )

    bins = np.linspace(0, 1, 41)
    axes[0, 0].hist(
        confidence[labels == 0],
        bins=bins,
        density=True,
        alpha=0.55,
        label=f"Tokens corrects (n={(labels == 0).sum()})",
    )
    axes[0, 0].hist(
        confidence[labels == 1],
        bins=bins,
        density=True,
        alpha=0.65,
        label=f"Tokens erronés (n={(labels == 1).sum()})",
    )
    axes[0, 0].set_yscale("log")
    axes[0, 0].set_title("Densité des probabilités du token choisi")
    axes[0, 0].set_xlabel("Probabilité softmax")
    axes[0, 0].set_ylabel("Densité (échelle log)")
    axes[0, 0].legend()
    axes[0, 0].grid(alpha=0.25)

    cal_rows = token_calibration["bins"]
    axes[0, 1].plot(
        [row["mean_confidence"] for row in cal_rows],
        [row["empirical_accuracy"] for row in cal_rows],
        "o-",
        label="Mesuré",
    )
    axes[0, 1].plot([0, 1], [0, 1], "--", color="gray", label="Calibration parfaite")
    axes[0, 1].set_title(
        "Calibration token "
        f"(ECE={token_calibration['expected_calibration_error']:.3f})"
    )
    axes[0, 1].set_xlabel("Confiance moyenne")
    axes[0, 1].set_ylabel("Exactitude empirique")
    axes[0, 1].legend()
    axes[0, 1].grid(alpha=0.25)

    quantile_count = 10
    binned = token_df.sort_values("probability", kind="stable").reset_index(drop=True)
    binned["confidence_decile"] = pd.qcut(
        np.arange(len(binned)),
        q=quantile_count,
        labels=np.arange(1, quantile_count + 1),
    )
    grouped = (
        binned.groupby("confidence_decile", observed=True)
        .agg(
            mean_confidence=("probability", "mean"),
            error_rate=("token_error", "mean"),
            count=("token_error", "size"),
        )
        .reset_index()
    )
    axes[1, 0].bar(
        grouped["confidence_decile"].astype(int),
        grouped["error_rate"],
        color="#2878B5",
        alpha=0.85,
    )
    for _, row in grouped.iterrows():
        axes[1, 0].annotate(
            f"{row['mean_confidence']:.4f}",
            (int(row["confidence_decile"]), row["error_rate"]),
            xytext=(0, 5),
            textcoords="offset points",
            ha="center",
            fontsize=7,
        )
    axes[1, 0].set_title(
        "Taux d'erreur par décile (nombre = confiance moyenne)"
    )
    axes[1, 0].set_xlabel("Décile de confiance : 1 = moins confiant")
    axes[1, 0].set_ylabel("Taux de tokens erronés")
    axes[1, 0].set_xticks(range(1, 11))
    axes[1, 0].grid(alpha=0.25)

    correct_margin = token_df.loc[~token_df["token_error"], "margin"].to_numpy()
    error_margin = token_df.loc[token_df["token_error"], "margin"].to_numpy()
    axes[1, 1].boxplot(
        [correct_margin, error_margin],
        tick_labels=["Exact", "Erreur"],
        showfliers=True,
        widths=0.55,
    )
    axes[1, 1].set_title("Marge top-1 − top-2")
    axes[1, 1].set_ylabel("Marge de probabilité")
    axes[1, 1].grid(axis="y", alpha=0.25)

    figure.tight_layout(rect=(0, 0, 1, 0.96))
    figure.savefig(
        RESULTS_DIR / "lighton_confidence_token_level.png",
        dpi=180,
        bbox_inches="tight",
    )
    plt.close(figure)


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    rendered = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    rendered.extend("| " + " | ".join(str(value) for value in row) + " |" for row in rows)
    return "\n".join(rendered)


def build_report(
    metrics: dict[str, Any],
    sample_df: pd.DataFrame,
    token_df: pd.DataFrame,
    word_df: pd.DataFrame,
) -> str:
    sample_metrics = metrics["sample_level"]
    token_metrics = metrics["token_level"]
    best_name = sample_metrics["best_signal_by_roc_auc"]
    recommended_name = sample_metrics["recommended_signal"]
    best = sample_metrics["signals"][recommended_name]
    budgets = sample_metrics["review_budgets"]
    recall20 = budgets["0.20"]["error_recall"]
    auc = best["roc_auc"] or 0.0
    if auc >= 0.80 and recall20 >= 0.60:
        verdict = (
            "Le signal est suffisamment discriminant pour justifier un prototype "
            "de priorisation de revue, sous réserve d'une calibration séparée."
        )
    elif auc >= 0.70 and recall20 >= 0.40:
        verdict = (
            "Le signal apporte une information réelle mais modérée. Il est pertinent "
            "comme facteur parmi d'autres, pas comme décision automatique unique."
        )
    else:
        verdict = (
            "Le signal seul est trop faible pour justifier une fonctionnalité de "
            "revue automatique. Il devrait rester un diagnostic ou être combiné à "
            "d'autres signaux."
        )

    signal_rows = []
    for name, values in sorted(
        sample_metrics["signals"].items(),
        key=lambda item: item[1]["roc_auc"] or -1,
        reverse=True,
    ):
        signal_rows.append(
            [
                name,
                f"{values['roc_auc']:.3f}" if values["roc_auc"] is not None else "n/a",
                (
                    f"{values['average_precision']:.3f}"
                    if values["average_precision"] is not None
                    else "n/a"
                ),
                f"{values['spearman_vs_error']:.3f}",
                f"{values['spearman_vs_cer']:.3f}",
            ]
        )

    budget_rows = []
    for budget, values in budgets.items():
        budget_rows.append(
            [
                f"{float(budget) * 100:.0f} %",
                values["review_count"],
                values["errors_captured"],
                f"{values['error_recall'] * 100:.1f} %",
                f"{values['review_precision'] * 100:.1f} %",
                f"×{values['recall_uplift_over_random']:.2f}",
            ]
        )

    error_examples = sample_df.sort_values(
        [recommended_name, "cer"],
        ascending=[
            not SAMPLE_CONFIDENCE_SIGNALS[recommended_name],
            False,
        ],
    )
    error_examples = error_examples[error_examples["sample_error"]].head(12)
    example_rows = [
        [
            row.id,
            f"{row.cer:.3f}",
            f"{getattr(row, recommended_name):.4f}",
            str(row.reference).replace("|", "\\|")[:90],
            str(row.prediction).replace("|", "\\|")[:90],
        ]
        for row in error_examples.itertuples()
    ]
    confident_errors = sample_df[sample_df["sample_error"]].sort_values(
        recommended_name, ascending=False
    ).head(10)
    confident_error_rows = [
        [
            row.id,
            row.error_category,
            f"{row.cer:.3f}",
            f"{getattr(row, recommended_name):.6f}",
            str(row.reference).replace("|", "\\|")[:80],
            str(row.prediction).replace("|", "\\|")[:80],
        ]
        for row in confident_errors.itertuples()
    ]

    ci = sample_metrics["bootstrap"]
    export_report = json.loads(EXPORT_REPORT_PATH.read_text(encoding="utf-8"))
    inference_report = json.loads(
        (RESULTS_DIR / "inference_report.json").read_text(encoding="utf-8")
    )
    performance_path = RESULTS_DIR / "performance_profile.json"
    performance = (
        json.loads(performance_path.read_text(encoding="utf-8"))
        if performance_path.exists()
        else None
    )
    changed_count = int(
        sample_df["reference_changed_since_published_benchmark"].sum()
    )
    omission_count = int(token_df["adjacent_omission"].sum())
    substantive = sample_metrics["substantive_errors"]
    dominant_calibration_bin = max(
        token_metrics["calibration"]["bins"], key=lambda row: row["count"]
    )
    performance_section: list[str] = []
    if performance:
        perf_median = performance["median"]
        perf_memory = performance["cuda_memory"]
        performance_section = [
            "",
            "## Coût de récupération des scores",
            "",
            (
                f"Profil A/B sur **{performance['sample_count']} crops**, batch "
                f"**{performance['batch_size']}**, avec **{performance['repeats']} "
                "répétitions** et ordre alterné :"
            ),
            "",
            markdown_table(
                ["Mesure", "Sans scores", "Avec scores choisis", "Surcoût"],
                [
                    [
                        "Temps médian",
                        f"{perf_median['baseline_generation_seconds']:.3f} s",
                        f"{perf_median['scored_total_seconds']:.3f} s",
                        f"{perf_median['relative_time_overhead'] * 100:+.2f} %",
                    ],
                    [
                        "Débit",
                        f"{perf_median['baseline_samples_per_second']:.2f} bulles/s",
                        f"{perf_median['scored_samples_per_second']:.2f} bulles/s",
                        "—",
                    ],
                    [
                        "Pic VRAM",
                        f"{perf_memory['baseline_peak_bytes'] / 2**30:.2f} Gio",
                        f"{perf_memory['scored_peak_bytes'] / 2**30:.2f} Gio",
                        f"{perf_memory['incremental_peak_bytes'] / 2**20:+.1f} Mio",
                    ],
                ],
            ),
            "",
            (
                f"Les séquences sont identiques dans "
                f"**{performance['sequence_equivalence']['compared']} / "
                f"{performance['sequence_equivalence']['compared']}** comparaisons "
                f"(mismatch : {performance['sequence_equivalence']['mismatch_count']}). "
                "Ce profil couvre `output_scores=True` et "
                "`compute_transition_scores`, sans calcul des alternatives top-k, "
                "puisque celles-ci n'améliorent pas le signal recommandé."
            ),
        ]
    lines = [
        "# Rapport — intérêt de la confiance LightOnOCR-2 dans Poneglyph",
        "",
        f"_Généré le {metrics['created_at']}._",
        "",
        "## Verdict",
        "",
        verdict,
        "",
        (
            f"Sur **{len(sample_df)} bulles**, le modèle commet une erreur sur "
            f"**{int(sample_df['sample_error'].sum())}** bulles "
            f"({sample_df['sample_error'].mean() * 100:.2f} %), avec un CER corpus de "
            f"**{metrics['text_quality']['cer'] * 100:.3f} %**. Le signal "
            f"opérationnel recommandé est `{recommended_name}` : ROC-AUC "
            f"**{best['roc_auc']:.3f}**, AP "
            f"**{best['average_precision']:.3f}** pour une prévalence d'erreur de "
            f"**{sample_df['sample_error'].mean():.3f}**."
        ),
        "",
        "## Protocole et provenance",
        "",
        (
            "Les IDs proviennent du benchmark test public figé, puis chaque ground "
            "truth et chaque crop sont réexportés depuis `bulles`/`pages` dans "
            "Supabase avec `statut = Validé`. Le modèle est évalué en greedy decoding "
            "avec le même prompt, la même résolution dynamique (700 px) et le même "
            "post-traitement première ligne que le benchmark de fine-tune."
        ),
        "",
        f"- Révision modèle : `{inference_report['model_revision']}`",
        f"- Ground truths exportés : {export_report['selection']['exported_crop_count']}",
        f"- Ground truths modifiés depuis le benchmark publié : {changed_count}",
        f"- Tokens analysés : {len(token_df)}",
        f"- Mots analysés : {len(word_df)}",
        "",
        (
            "Le split test est tenu à l'écart de l'entraînement par le pipeline de "
            "fine-tune. En revanche, la sélection du meilleur agrégat et des seuils "
            "est faite sur ce même benchmark exploratoire : leurs valeurs sont donc "
            "descriptives et devront être confirmées sur un futur lot de corrections."
        ),
        "",
        "## Qualité OCR observée",
        "",
        markdown_table(
            ["Mesure", "Valeur"],
            [
                ["Bulles", len(sample_df)],
                ["Erreurs bulle", int(sample_df["sample_error"].sum())],
                [
                    "Erreurs alphanumériques substantielles",
                    substantive["count"],
                ],
                [
                    "Écarts casse / ponctuation uniquement",
                    metrics["text_quality"]["error_categories"].get(
                        "typography_case_only", 0
                    ),
                ],
                ["Exact match", f"{metrics['text_quality']['exact_match'] * 100:.2f} %"],
                ["CER corpus", f"{metrics['text_quality']['cer'] * 100:.4f} %"],
                ["Éditions Levenshtein", metrics["text_quality"]["total_edits"]],
                [
                    "Temps moyen / bulle",
                    f"{sample_df['generation_seconds'].mean():.3f} s",
                ],
                [
                    "Pic mémoire CUDA max",
                    f"{sample_df['peak_cuda_memory_bytes'].max() / 2**30:.2f} Gio",
                ],
            ],
        ),
        *performance_section,
        "",
        "## Corrélation au niveau bulle",
        "",
        markdown_table(
            ["Signal", "ROC-AUC", "AP", "Spearman erreur", "Spearman CER"],
            signal_rows,
        ),
        "",
        (
            f"`{best_name}` obtient la meilleure AUC brute, mais son écart avec "
            f"`min_confidence` n'est que de "
            f"**{sample_metrics['signals'][best_name]['roc_auc'] - sample_metrics['signals']['min_confidence']['roc_auc']:.6f}** "
            "point d'AUC et son AP est légèrement inférieure. La recommandation est "
            "donc `min_confidence`, plus simple et ne nécessitant pas le top-2."
        ),
        "",
        (
            "ROC-AUC mesure l'ordre relatif entre bulles correctes et erronées. "
            "L'average precision (AP) est plus sévère ici car les erreurs sont rares. "
            "Une AP proche de la prévalence correspond à un tri peu utile."
        ),
        "",
        (
            f"Intervalle bootstrap par page pour `{recommended_name}` : ROC-AUC 95 % "
            f"**{ci['roc_auc_ci95']}**, AP 95 % **{ci['average_precision_ci95']}**. "
            "Le bootstrap se fait par page, et non par bulle, pour conserver la "
            "corrélation entre bulles issues d'une même page."
        ),
        "",
        (
            f"En retirant les écarts limités à la casse/ponctuation, il reste "
            f"**{substantive['count']} erreurs substantielles**. Le même signal donne "
            f"ROC-AUC **{substantive['recommended_signal_discrimination']['roc_auc']:.3f}** "
            f"et AP **{substantive['recommended_signal_discrimination']['average_precision']:.3f}**. "
            f"À 20 % de revue, il en capture "
            f"**{substantive['review_budgets']['0.20']['error_recall'] * 100:.1f} %**."
        ),
        "",
        "## Valeur opérationnelle : budget de revue",
        "",
        markdown_table(
            [
                "Bulles relues",
                "Nombre",
                "Erreurs trouvées",
                "Rappel erreurs",
                "Précision revue",
                "Gain vs hasard",
            ],
            budget_rows,
        ),
        "",
        (
            "Ces valeurs répondent à la question produit la plus concrète : combien "
            "d'erreurs retrouve-t-on si l'interface ne demande de vérifier qu'une "
            "fraction des bulles ? Elles sont plus directement actionnables qu'un "
            "coefficient de corrélation seul."
        ),
        "",
        "## Niveau token et localisation",
        "",
        (
            f"Parmi **{len(token_df)} tokens émis**, **"
            f"{int(token_df['token_error'].sum())}** chevauchent une substitution ou "
            f"une suppression dans l'alignement Levenshtein. La probabilité du token "
            f"donne ROC-AUC **{token_metrics['probability']['roc_auc']:.3f}** et AP "
            f"**{token_metrics['probability']['average_precision']:.3f}** pour les "
            "localiser."
        ),
        "",
        (
            f"Calibration brute token : confiance moyenne "
            f"**{token_metrics['calibration']['mean_confidence']:.4f}**, exactitude "
            f"empirique **{token_metrics['calibration']['empirical_accuracy']:.4f}**, "
            f"ECE **{token_metrics['calibration']['expected_calibration_error']:.4f}**, "
            f"Brier **{token_metrics['calibration']['brier_score']:.5f}**."
        ),
        "",
        (
            f"Attention : **{dominant_calibration_bin['count']} / {len(token_df)}** "
            "tokens sont dans la tranche 0,9–1,0. Le faible ECE global est donc "
            "largement dominé par cette masse de tokens faciles ; il ne suffit pas "
            "à valider un seuil dans la zone basse, où les effectifs sont petits."
        ),
        "",
        (
            f"**{omission_count} rattachements d'omission** ont été observés. Ils ne "
            "sont pas comptés comme erreurs token strictes : une lettre absente de la "
            "sortie n'a pas de logit choisi. Pour ces cas, seules la confiance globale, "
            "la relecture du mot voisin, le désaccord entre moteurs ou une seconde "
            "passe peuvent apporter un signal."
        ),
        "",
        "## Seuils exploratoires",
        "",
        "Seuils du signal recommandé, ajustés sur ce jeu (donc non encore généralisables) :",
        "",
        "```json",
        json.dumps(
            sample_metrics["thresholds_for_target_error_recall"],
            ensure_ascii=False,
            indent=2,
        ),
        "```",
        "",
        "## Exemples d'erreurs prioritaires",
        "",
        markdown_table(
            ["ID", "CER", recommended_name, "Référence", "Prédiction"],
            example_rows,
        ),
        "",
        "## Faux négatifs : erreurs très confiantes",
        "",
        (
            "Ces cas sont la raison pour laquelle la confiance ne doit jamais "
            "auto-valider seule une transcription :"
        ),
        "",
        markdown_table(
            [
                "ID",
                "Catégorie",
                "CER",
                recommended_name,
                "Référence",
                "Prédiction",
            ],
            confident_error_rows,
        ),
        "",
        "## Recommandation d'implémentation",
        "",
        (
            "Si le verdict est positif ou modéré, l'intégration conseillée est "
            "optionnelle : conserver les log-probabilités des tokens choisis, agréger "
            "au minimum par mot et par bulle, puis calibrer un score de revue propre à "
            "LightOnOCR. Il ne faut pas exposer directement la probabilité softmax "
            "comme « probabilité que le texte soit juste »."
        ),
        "",
        "Première version recommandée :",
        "",
        "1. score bulle fondé sur `min(token_probability)`, calibré sur un lot séparé ;",
        "2. surlignage mot avec `min(token_probability)` et moyenne géométrique ;",
        "3. raison explicite `low_local_confidence` plutôt qu'un verdict silencieux ;",
        "4. budget de revue configurable, au lieu d'un seuil universel fixe ;",
        "5. journalisation des confirmations/corrections pour recalibrer ;",
        "6. ajout ultérieur du désaccord inter-modèles pour couvrir les erreurs confiantes et omissions.",
        "",
        "## Limites",
        "",
        "- Un modèle peut être très confiant et faux : l'AUC mesure ce risque mais ne l'annule pas.",
        "- Le tokeniseur ne suit pas les frontières de mots ; le surlignage UI doit agréger les sous-tokens.",
        "- Les alternatives top-k sont locales au prochain token, pas des alternatives fiables au mot complet.",
        "- Les seuils sont sélectionnés sur le jeu analysé et doivent être validés hors échantillon.",
        "- Les corrections Supabase postérieures à la publication modifient légèrement la comparaison historique.",
        "- `output_scores=True` conserve les logits de chaque pas ; l'expérience utilise des batchs de 16 et a mesuré le pic VRAM.",
        "",
        "## Figures et données",
        "",
        "- `lighton_confidence_sample_level.png` : discrimination et rendement de revue ;",
        "- `lighton_confidence_token_level.png` : distributions, calibration et marges ;",
        "- `predictions.jsonl` : probabilités et top-k bruts ;",
        "- `sample_records.csv`, `token_records.csv`, `word_records.csv` : tables d'analyse ;",
        "- `metrics.json` : toutes les métriques et intervalles.",
        "",
    ]
    return "\n".join(lines)


def analyze(args: argparse.Namespace) -> dict[str, Any]:
    if not PREDICTIONS_PATH.exists():
        raise FileNotFoundError(
            f"{PREDICTIONS_PATH} is missing; run the infer command first"
        )
    predictions = read_jsonl(PREDICTIONS_PATH)
    if args.limit:
        predictions = predictions[: args.limit]
    if not predictions:
        raise RuntimeError("No predictions to analyze")
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    sample_df = sample_frame(predictions)
    token_rows: list[dict[str, Any]] = []
    word_rows: list[dict[str, Any]] = []
    for sample in predictions:
        current_tokens = token_rows_for_sample(sample)
        token_rows.extend(current_tokens)
        word_rows.extend(word_rows_for_sample(sample, current_tokens))
    token_df = pd.DataFrame(token_rows)
    word_df = pd.DataFrame(word_rows)
    sample_df.to_csv(SAMPLE_CSV_PATH, index=False, encoding="utf-8-sig")
    token_df.to_csv(TOKEN_CSV_PATH, index=False, encoding="utf-8-sig")
    word_df.to_csv(WORD_CSV_PATH, index=False, encoding="utf-8-sig")

    sample_labels = sample_df["sample_error"].astype(int).to_numpy()
    signal_metrics = {}
    for name, already_uncertainty in SAMPLE_CONFIDENCE_SIGNALS.items():
        uncertainty = uncertainty_values(sample_df, name, already_uncertainty)
        discrimination = safe_discrimination(sample_labels, uncertainty)
        rho_error = spearmanr(uncertainty, sample_labels).statistic
        rho_cer = spearmanr(uncertainty, sample_df["cer"].to_numpy()).statistic
        signal_metrics[name] = {
            **discrimination,
            "spearman_vs_error": float(rho_error),
            "spearman_vs_cer": float(rho_cer),
        }
    best_name = max(
        signal_metrics,
        key=lambda name: signal_metrics[name]["roc_auc"]
        if signal_metrics[name]["roc_auc"] is not None
        else -1,
    )
    # The microscopic AUC advantage of the top-1/top-2 margin does not justify
    # retaining alternatives in production. Minimum chosen-token probability is
    # the simpler operational signal and has slightly better AP on this dataset.
    recommended_name = "min_confidence"
    recommended_uncertainty = uncertainty_values(
        sample_df,
        recommended_name,
        SAMPLE_CONFIDENCE_SIGNALS[recommended_name],
    )
    recommended_confidence = (
        -recommended_uncertainty
        if SAMPLE_CONFIDENCE_SIGNALS[recommended_name]
        else sample_df[recommended_name].to_numpy(dtype=float)
    )
    substantive_labels = sample_df["substantive_error"].astype(int).to_numpy()
    substantive_discrimination = safe_discrimination(
        substantive_labels, recommended_uncertainty
    )
    substantive_budgets = review_budgets(
        substantive_labels,
        recommended_uncertainty,
        (0.05, 0.10, 0.20, 0.30, 0.50),
    )

    token_labels = token_df["token_error"].astype(int).to_numpy()
    token_confidence = token_df["probability"].to_numpy(dtype=float)
    token_margin = token_df["margin"].to_numpy(dtype=float)
    token_discrimination = safe_discrimination(token_labels, -token_confidence)
    margin_discrimination = safe_discrimination(token_labels, -token_margin)
    token_calibration = calibration(1 - token_labels, token_confidence)
    token_mwu = mannwhitneyu(
        token_confidence[token_labels == 0],
        token_confidence[token_labels == 1],
        alternative="two-sided",
    )

    word_labels = (
        word_df["word_error_including_adjacent_omission"].astype(int).to_numpy()
    )
    word_metrics = {}
    for name in (
        "mean_confidence",
        "geometric_mean_confidence",
        "min_confidence",
    ):
        word_metrics[name] = safe_discrimination(
            word_labels, -word_df[name].to_numpy(dtype=float)
        )

    total_chars = int(sample_df["reference"].str.len().sum())
    total_edits = int(sample_df["levenshtein"].sum())
    recommended_bootstrap = bootstrap_by_page(
        sample_df,
        "sample_error",
        recommended_uncertainty,
        args.bootstrap_iterations,
        args.seed,
    )
    budgets = review_budgets(
        sample_labels, recommended_uncertainty, (0.05, 0.10, 0.20, 0.30, 0.50)
    )
    metrics = {
        "created_at": now_iso(),
        "text_quality": {
            "sample_count": len(sample_df),
            "error_count": int(sample_labels.sum()),
            "error_prevalence": float(sample_labels.mean()),
            "exact_match": float(1 - sample_labels.mean()),
            "total_reference_characters": total_chars,
            "total_edits": total_edits,
            "cer": total_edits / max(total_chars, 1),
            "error_categories": {
                str(name): int(count)
                for name, count in sample_df["error_category"].value_counts().items()
            },
        },
        "sample_level": {
            "best_signal_by_roc_auc": best_name,
            "recommended_signal": recommended_name,
            "signals": signal_metrics,
            "review_budgets": budgets,
            "bootstrap": recommended_bootstrap,
            "thresholds_for_target_error_recall": confidence_thresholds_for_recall(
                sample_labels, recommended_confidence
            ),
            "substantive_errors": {
                "count": int(substantive_labels.sum()),
                "prevalence": float(substantive_labels.mean()),
                "recommended_signal_discrimination": substantive_discrimination,
                "review_budgets": substantive_budgets,
            },
        },
        "token_level": {
            "token_count": len(token_df),
            "error_token_count": int(token_labels.sum()),
            "error_token_prevalence": float(token_labels.mean()),
            "adjacent_omission_count": int(token_df["adjacent_omission"].sum()),
            "probability": token_discrimination,
            "margin": margin_discrimination,
            "spearman_uncertainty_vs_error": float(
                spearmanr(-token_confidence, token_labels).statistic
            ),
            "mann_whitney_u": float(token_mwu.statistic),
            "mann_whitney_p_value": float(token_mwu.pvalue),
            "calibration": token_calibration,
        },
        "word_level": {
            "word_count": len(word_df),
            "error_word_count": int(word_labels.sum()),
            "error_word_prevalence": float(word_labels.mean()),
            "signals": word_metrics,
        },
        "runtime": {
            "mean_seconds_per_sample": float(sample_df["generation_seconds"].mean()),
            "median_seconds_per_sample": float(
                sample_df["generation_seconds"].median()
            ),
            "max_peak_cuda_memory_bytes": int(
                sample_df["peak_cuda_memory_bytes"].dropna().max()
            )
            if sample_df["peak_cuda_memory_bytes"].notna().any()
            else None,
        },
    }
    write_json(METRICS_PATH, metrics)
    plot_sample_analysis(
        sample_df, recommended_name, recommended_uncertainty, metrics
    )
    plot_token_analysis(token_df, token_calibration)
    REPORT_PATH.write_text(
        build_report(metrics, sample_df, token_df, word_df), encoding="utf-8"
    )
    print(f"Analyse terminée: {REPORT_PATH}", flush=True)
    return metrics


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark de corrélation confiance/erreur pour LightOnOCR-2"
    )
    parser.add_argument(
        "command", choices=("export", "infer", "profile", "analyze", "all")
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--status", default=os.getenv("LIGHTON_STATUS_VALUE", DEFAULT_STATUS))
    parser.add_argument(
        "--benchmark-url",
        default=os.getenv("LIGHTON_BASELINE_BENCHMARK", DEFAULT_BENCHMARK_URL),
    )
    parser.add_argument("--supabase-page-size", type=int, default=1000)
    parser.add_argument("--download-workers", type=int, default=12)
    parser.add_argument("--request-timeout", type=int, default=45)
    parser.add_argument(
        "--model-id", default=os.getenv("HF_REPO", DEFAULT_MODEL_ID)
    )
    parser.add_argument("--revision", default=None)
    parser.add_argument("--prompt", default=os.getenv("LIGHTON_USER_PROMPT", DEFAULT_PROMPT))
    parser.add_argument("--image-longest-edge", type=int, default=700)
    parser.add_argument("--max-sequence-length", type=int, default=512)
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--profile-samples", type=int, default=128)
    parser.add_argument("--profile-repeats", type=int, default=3)
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--bootstrap-iterations", type=int, default=2000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    if args.command in {"export", "all"}:
        export_ground_truth(args)
    if args.command in {"infer", "all"}:
        infer(args)
    if args.command in {"profile", "all"}:
        profile_confidence_overhead(args)
    if args.command in {"analyze", "all"}:
        analyze(args)


if __name__ == "__main__":
    main()
