from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

import modal
from modal import current_function_call_id


APP_NAME = os.getenv("PONEGLYPH_MODAL_APP_NAME", "poneglyph-training")
VOLUME_NAME = os.getenv("PONEGLYPH_MODAL_VOLUME_NAME", "poneglyph-datasets")
VOLUME_MOUNT = PurePosixPath("/mnt/poneglyph_datasets")
REMOTE_ROOT = PurePosixPath("/app")
REMOTE_DOCKER_SCRIPTS = REMOTE_ROOT / "docker_scripts"
LOCAL_REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_DOCKER_SCRIPTS = LOCAL_REPO_ROOT / "docker_scripts"

ALLOWED_GPUS = {"A100-80GB", "L40S", "H100", "H200", "B200"}

for module_root in (str(REMOTE_DOCKER_SCRIPTS), str(LOCAL_DOCKER_SCRIPTS)):
    if module_root not in sys.path:
        sys.path.insert(0, module_root)

TRAINING_KINDS: dict[str, dict[str, str]] = {
    "surya_bubble_ocr": {
        "script_dir": "finetune_surya_bubble_ocr",
        "dataset_env": "SURYA_DATASET_DIR",
        "output_env": "SURYA_OUTPUT_DIR",
        "clean_env": "SURYA_CLEAN_DATASET",
        "require_upload_env": "SURYA_REQUIRE_UPLOAD",
        "skip_upload_env": "SURYA_SKIP_UPLOAD",
        "default_hf_repo": "Remidesbois/surya-bubble-ocr-poneglyph",
        "benchmark_file": "benchmark_test.json",
        "final_dir_name": "final_merged",
        "env_prefix": "SURYA",
        "volume_kind": "surya_bubble_ocr",
    },
    "surya_bbox": {
        "script_dir": "finetune_surya_ocr_bbox",
        "dataset_env": "SURYA_BBOX_DATASET_DIR",
        "output_env": "SURYA_BBOX_OUTPUT_DIR",
        "clean_env": "SURYA_BBOX_CLEAN_DATASET",
        "require_upload_env": "SURYA_BBOX_REQUIRE_UPLOAD",
        "skip_upload_env": "SURYA_BBOX_SKIP_UPLOAD",
        "default_hf_repo": "Remidesbois/surya-ocr-2-poneglyph-bbox",
        "benchmark_file": "benchmark_surya_bbox.json",
        "final_dir_name": "final_merged",
        "env_prefix": "SURYA_BBOX",
        "volume_kind": "surya_bbox",
    },
    "lighton_ocr": {
        "script_dir": "finetune_lighton_ocr",
        "dataset_env": "LIGHTON_DATASET_DIR",
        "output_env": "LIGHTON_OUTPUT_DIR",
        "clean_env": "LIGHTON_CLEAN_DATASET",
        "require_upload_env": "LIGHTON_REQUIRE_UPLOAD",
        "skip_upload_env": "LIGHTON_SKIP_UPLOAD",
        "default_hf_repo": "Remidesbois/LightonOCR-2-1b-poneglyph",
        "benchmark_file": "benchmark_test.json",
        "final_dir_name": "final_lora_merged",
        "env_prefix": "LIGHTON",
        "volume_kind": "lighton_ocr",
    },
    "ppocrv6_bubble_line": {
        "script_dir": "finetune_paddleocr_line_rec",
        "dataset_env": "PPOCR_LINE_DATASET_DIR",
        "output_env": "PPOCR_LINE_OUTPUT_DIR",
        "clean_env": "PPOCR_LINE_CLEAN_DATASET",
        "require_upload_env": "PPOCR_REQUIRE_UPLOAD",
        "skip_upload_env": "PPOCR_SKIP_UPLOAD",
        "default_hf_repo": "Remidesbois/pp-ocrv6-one-piece-bubble-line-rec",
        "benchmark_file": "training_metrics.json",
        "final_dir_name": "onnx",
        "env_prefix": "PPOCR",
        "volume_kind": "ppocrv6_bubble_line",
    },
}

GPU_TRAINING_PRESETS: dict[str, dict[str, dict[str, int | float]]] = {
    "surya_bubble_ocr": {
        "L40S": {"epochs": 6, "batch_size": 2, "grad_accum": 8, "learning_rate": 0.00005, "lora_rank": 64, "max_eval_samples": 0, "gen_eval_samples": 96, "eval_steps": 300, "eval_batch_size": 1, "dataloader_workers": 2, "early_stopping_patience": 4, "save_total_limit": 4},
        "A100-80GB": {"epochs": 6, "batch_size": 4, "grad_accum": 4, "learning_rate": 0.00005, "lora_rank": 64, "max_eval_samples": 0, "gen_eval_samples": 128, "eval_steps": 300, "eval_batch_size": 2, "dataloader_workers": 4, "early_stopping_patience": 4, "save_total_limit": 4},
        "H100": {"epochs": 6, "batch_size": 4, "grad_accum": 4, "learning_rate": 0.00005, "lora_rank": 96, "max_eval_samples": 0, "gen_eval_samples": 160, "eval_steps": 300, "eval_batch_size": 2, "dataloader_workers": 4, "early_stopping_patience": 4, "save_total_limit": 4},
        "H200": {"epochs": 6, "batch_size": 6, "grad_accum": 3, "learning_rate": 0.00005, "lora_rank": 96, "max_eval_samples": 0, "gen_eval_samples": 192, "eval_steps": 300, "eval_batch_size": 3, "dataloader_workers": 6, "early_stopping_patience": 4, "save_total_limit": 4},
        "B200": {"epochs": 6, "batch_size": 8, "grad_accum": 2, "learning_rate": 0.00005, "lora_rank": 128, "max_eval_samples": 0, "gen_eval_samples": 224, "eval_steps": 300, "eval_batch_size": 4, "dataloader_workers": 8, "early_stopping_patience": 4, "save_total_limit": 4},
    },
    "surya_bbox": {
        "L40S": {"epochs": 6, "batch_size": 1, "grad_accum": 8, "learning_rate": 0.00005, "lora_rank": 64, "max_eval_samples": 0, "gen_eval_samples": 24, "eval_steps": 250, "eval_batch_size": 1, "dataloader_workers": 2, "early_stopping_patience": 4, "save_total_limit": 4},
        "A100-80GB": {"epochs": 6, "batch_size": 2, "grad_accum": 4, "learning_rate": 0.00005, "lora_rank": 64, "max_eval_samples": 0, "gen_eval_samples": 32, "eval_steps": 250, "eval_batch_size": 1, "dataloader_workers": 4, "early_stopping_patience": 4, "save_total_limit": 4},
        "H100": {"epochs": 6, "batch_size": 2, "grad_accum": 4, "learning_rate": 0.00005, "lora_rank": 96, "max_eval_samples": 0, "gen_eval_samples": 40, "eval_steps": 250, "eval_batch_size": 2, "dataloader_workers": 4, "early_stopping_patience": 4, "save_total_limit": 4},
        "H200": {"epochs": 6, "batch_size": 3, "grad_accum": 3, "learning_rate": 0.00005, "lora_rank": 96, "max_eval_samples": 0, "gen_eval_samples": 48, "eval_steps": 250, "eval_batch_size": 2, "dataloader_workers": 6, "early_stopping_patience": 4, "save_total_limit": 4},
        "B200": {"epochs": 6, "batch_size": 4, "grad_accum": 2, "learning_rate": 0.00005, "lora_rank": 128, "max_eval_samples": 0, "gen_eval_samples": 64, "eval_steps": 250, "eval_batch_size": 2, "dataloader_workers": 8, "early_stopping_patience": 4, "save_total_limit": 4},
    },
    "lighton_ocr": {
        "L40S": {"epochs": 8, "batch_size": 2, "grad_accum": 8, "learning_rate": 0.00005, "lora_rank": 64, "max_eval_samples": 0, "gen_eval_samples": 96, "eval_steps": 300, "eval_batch_size": 1, "dataloader_workers": 2, "early_stopping_patience": 4, "save_total_limit": 4},
        "A100-80GB": {"epochs": 8, "batch_size": 4, "grad_accum": 4, "learning_rate": 0.00005, "lora_rank": 64, "max_eval_samples": 0, "gen_eval_samples": 128, "eval_steps": 300, "eval_batch_size": 2, "dataloader_workers": 4, "early_stopping_patience": 4, "save_total_limit": 4},
        "H100": {"epochs": 8, "batch_size": 4, "grad_accum": 4, "learning_rate": 0.00005, "lora_rank": 96, "max_eval_samples": 0, "gen_eval_samples": 160, "eval_steps": 300, "eval_batch_size": 2, "dataloader_workers": 4, "early_stopping_patience": 4, "save_total_limit": 4},
        "H200": {"epochs": 8, "batch_size": 6, "grad_accum": 3, "learning_rate": 0.00005, "lora_rank": 96, "max_eval_samples": 0, "gen_eval_samples": 192, "eval_steps": 300, "eval_batch_size": 3, "dataloader_workers": 6, "early_stopping_patience": 4, "save_total_limit": 4},
        "B200": {"epochs": 8, "batch_size": 8, "grad_accum": 2, "learning_rate": 0.00005, "lora_rank": 128, "max_eval_samples": 0, "gen_eval_samples": 224, "eval_steps": 300, "eval_batch_size": 4, "dataloader_workers": 8, "early_stopping_patience": 4, "save_total_limit": 4},
    },
    "ppocrv6_bubble_line": {
        "L40S": {"epochs": 10, "batch_size": 2, "grad_accum": 8, "learning_rate": 0.00002, "max_eval_samples": 0, "eval_steps": 1, "dataloader_workers": 0, "early_stopping_patience": 20, "save_total_limit": 3, "yolo_epochs": 120, "yolo_batch_size": 16, "yolo_imgsz": 960, "yolo_patience": 30, "yolo_workers": 2, "image_width": 960, "train_backbone": True, "short_oversample": 3, "short_loss_weight": 2.5, "backbone_learning_rate": 0.000002, "lr_scheduler": "cosine", "warmup_ratio": 0.05},
        "A100-80GB": {"epochs": 12, "batch_size": 4, "grad_accum": 4, "learning_rate": 0.00002, "max_eval_samples": 0, "eval_steps": 1, "dataloader_workers": 0, "early_stopping_patience": 25, "save_total_limit": 3, "yolo_epochs": 140, "yolo_batch_size": 24, "yolo_imgsz": 1024, "yolo_patience": 35, "yolo_workers": 4, "image_width": 960, "train_backbone": True, "short_oversample": 3, "short_loss_weight": 2.5, "backbone_learning_rate": 0.000002, "lr_scheduler": "cosine", "warmup_ratio": 0.05},
        "H100": {"epochs": 14, "batch_size": 16, "grad_accum": 1, "learning_rate": 0.00002, "max_eval_samples": 0, "eval_steps": 1, "dataloader_workers": 8, "early_stopping_patience": 30, "save_total_limit": 3, "yolo_epochs": 160, "yolo_batch_size": 96, "yolo_imgsz": 1024, "yolo_patience": 40, "yolo_workers": 8, "image_width": 960, "train_backbone": True, "pin_memory": True, "short_oversample": 3, "short_loss_weight": 2.5, "backbone_learning_rate": 0.000002, "lr_scheduler": "cosine", "warmup_ratio": 0.05},
        "H200": {"epochs": 14, "batch_size": 6, "grad_accum": 3, "learning_rate": 0.00002, "max_eval_samples": 0, "eval_steps": 1, "dataloader_workers": 0, "early_stopping_patience": 30, "save_total_limit": 3, "yolo_epochs": 180, "yolo_batch_size": 40, "yolo_imgsz": 1024, "yolo_patience": 45, "yolo_workers": 8, "image_width": 960, "train_backbone": True, "short_oversample": 3, "short_loss_weight": 2.5, "backbone_learning_rate": 0.000002, "lr_scheduler": "cosine", "warmup_ratio": 0.05},
        "B200": {"epochs": 16, "batch_size": 8, "grad_accum": 2, "learning_rate": 0.00002, "max_eval_samples": 0, "eval_steps": 1, "dataloader_workers": 0, "early_stopping_patience": 30, "save_total_limit": 3, "yolo_epochs": 200, "yolo_batch_size": 48, "yolo_imgsz": 1280, "yolo_patience": 50, "yolo_workers": 8, "image_width": 960, "train_backbone": True, "short_oversample": 3, "short_loss_weight": 2.5, "backbone_learning_rate": 0.000002, "lr_scheduler": "cosine", "warmup_ratio": 0.05},
    },
}

KIND_ALIASES = {
    "finetune_surya_bubble_ocr": "surya_bubble_ocr",
    "surya_bbox_ocr": "surya_bbox",
    "finetune_surya_ocr_bbox": "surya_bbox",
    "finetune_lighton_ocr": "lighton_ocr",
    "ppocrv6_line_rec": "ppocrv6_bubble_line",
    "paddleocr_line_rec": "ppocrv6_bubble_line",
}

COMMON_PIP_PACKAGES = [
    "git+https://github.com/huggingface/transformers",
    "accelerate",
    "bitsandbytes",
    "datasets",
    "huggingface_hub",
    "jiwer",
    "matplotlib",
    "numpy",
    "onnx",
    "onnxruntime",
    "opencv-python-headless",
    "peft",
    "pillow",
    "pillow-avif-plugin",
    "python-dotenv",
    "python-Levenshtein",
    "requests",
    "scikit-learn",
    "sentencepiece",
    "supabase",
    "tiktoken",
    "tokenizers",
    "tqdm",
    "editdistance",
    "ultralytics",
]


def _ignore_training_tree(path: Path) -> bool:
    parts = set(path.parts)
    name = path.name
    if name in {".env", ".DS_Store"}:
        return True
    if name.endswith((".pyc", ".pyo")):
        return True
    return bool(
        parts
        & {
            "__pycache__",
            "surya_bubble_dataset",
            "surya_bbox_dataset",
            "outputs_surya_bubble_ocr",
            "outputs_surya_bbox",
            "lighton_dataset",
            "outputs_lighton_manga",
            "outputs_paddleocr_line_rec",
            "reference_outputs",
            "runs",
            ".pytest_cache",
        }
    )


training_image = (
    modal.Image.from_registry("pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel")
    .apt_install("build-essential", "cmake", "curl", "git", "git-lfs", "libgl1", "libglib2.0-0", "wget")
    .pip_install(*COMMON_PIP_PACKAGES)
    .add_local_dir(LOCAL_DOCKER_SCRIPTS / "common_training", str(REMOTE_DOCKER_SCRIPTS / "common_training"))
    .add_local_dir(
        LOCAL_DOCKER_SCRIPTS / "finetune_surya_bubble_ocr",
        str(REMOTE_DOCKER_SCRIPTS / "finetune_surya_bubble_ocr"),
        ignore=_ignore_training_tree,
    )
    .add_local_dir(
        LOCAL_DOCKER_SCRIPTS / "finetune_surya_ocr_bbox",
        str(REMOTE_DOCKER_SCRIPTS / "finetune_surya_ocr_bbox"),
        ignore=_ignore_training_tree,
    )
    .add_local_dir(
        LOCAL_DOCKER_SCRIPTS / "finetune_lighton_ocr",
        str(REMOTE_DOCKER_SCRIPTS / "finetune_lighton_ocr"),
        ignore=_ignore_training_tree,
    )
    .add_local_dir(
        LOCAL_DOCKER_SCRIPTS / "train_bubble_line_detector",
        str(REMOTE_DOCKER_SCRIPTS / "train_bubble_line_detector"),
        ignore=_ignore_training_tree,
    )
    .add_local_dir(
        LOCAL_DOCKER_SCRIPTS / "finetune_paddleocr_line_rec",
        str(REMOTE_DOCKER_SCRIPTS / "finetune_paddleocr_line_rec"),
        ignore=_ignore_training_tree,
    )
    .add_local_dir(
        LOCAL_REPO_ROOT / "scripts" / "bubble_line_dataset" / "dataset",
        "/app/dataset",
    )
)

app = modal.App(APP_NAME)
dataset_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
modal_secrets = [
    modal.Secret.from_name("poneglyph-supabase"),
    modal.Secret.from_name("poneglyph-huggingface"),
    modal.Secret.from_name("poneglyph-admin"),
]


def normalize_kind(training_kind: str) -> str:
    key = (training_kind or "").strip()
    key = KIND_ALIASES.get(key, key)
    if key not in TRAINING_KINDS:
        supported = ", ".join(sorted(TRAINING_KINDS))
        raise ValueError(f"Unsupported training kind '{training_kind}'. Supported kinds: {supported}")
    return key


def gpu_from_params(params: dict[str, Any] | None) -> str:
    gpu = str((params or {}).get("gpu") or "L40S").strip()
    if gpu not in ALLOWED_GPUS:
        allowed = ", ".join(sorted(ALLOWED_GPUS))
        raise ValueError(f"Unsupported Modal GPU '{gpu}'. Allowed values: {allowed}")
    return gpu


def params_with_gpu_defaults(kind: str, params: dict[str, Any] | None) -> dict[str, Any]:
    params = dict(params or {})
    gpu = gpu_from_params(params)
    preset = dict(GPU_TRAINING_PRESETS.get(kind, {}).get(gpu, {}))
    preset.update({key: value for key, value in params.items() if value is not None})
    preset["gpu"] = gpu
    return preset


def volume_dataset_dir(job_id: str, kind: str) -> Path:
    return Path(str(VOLUME_MOUNT / job_id / TRAINING_KINDS[kind]["volume_kind"]))


def volume_output_dir(job_id: str, kind: str) -> Path:
    return Path(str(VOLUME_MOUNT / job_id / TRAINING_KINDS[kind]["volume_kind"] / "outputs"))


def final_model_dir_for(kind: str, output_dir: Path) -> Path:
    return output_dir / TRAINING_KINDS[kind]["final_dir_name"]


def script_dir(kind: str) -> Path:
    return Path(str(REMOTE_DOCKER_SCRIPTS / TRAINING_KINDS[kind]["script_dir"]))


def params_to_env(kind: str, params: dict[str, Any] | None) -> dict[str, str]:
    params = params_with_gpu_defaults(kind, params)
    prefix = TRAINING_KINDS[kind]["env_prefix"]
    mapping = {
        "epochs": f"{prefix}_EPOCHS",
        "batch_size": f"{prefix}_TRAIN_BATCH",
        "grad_accum": f"{prefix}_GRAD_ACCUM",
        "learning_rate": f"{prefix}_LR",
        "lora_rank": f"{prefix}_LORA_R",
        "max_eval_samples": f"{prefix}_FINAL_TEST_MAX_SAMPLES",
        "gen_eval_samples": f"{prefix}_GEN_EVAL_MAX_SAMPLES",
        "eval_steps": f"{prefix}_EVAL_STEPS",
        "eval_batch_size": f"{prefix}_EVAL_BATCH",
        "dataloader_workers": f"{prefix}_DATALOADER_WORKERS",
        "early_stopping_patience": f"{prefix}_EARLY_STOPPING_PATIENCE",
        "save_total_limit": f"{prefix}_SAVE_TOTAL_LIMIT",
    }
    env: dict[str, str] = {}
    for param_key, env_key in mapping.items():
        value = params.get(param_key)
        if value is not None and str(value).strip() != "":
            env[env_key] = str(value)
    return env


def base_child_env(job_id: str, kind: str, params: dict[str, Any] | None) -> dict[str, str]:
    config = TRAINING_KINDS[kind]
    params = params_with_gpu_defaults(kind, params)
    env = os.environ.copy()
    env.update(
        {
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": str(REMOTE_DOCKER_SCRIPTS),
            "TRAINING_PROVIDER": "modal",
            "TRAINING_JOB_ID": job_id,
            "PONEGLYPH_TRAINING_JOB_ID": job_id,
            "PONEGLYPH_MODAL_VOLUME_NAME": VOLUME_NAME,
            "HF_REPO": str(params.get("hf_repo") or config["default_hf_repo"]),
        }
    )
    env.update(params_to_env(kind, params))
    return env


def apply_dry_run_env(env: dict[str, str], kind: str, params: dict[str, Any]) -> bool:
    if not params.get("dry_run"):
        return False
    if kind == "lighton_ocr":
        env["LIGHTON_DRY_RUN"] = "1"
        if params.get("check_remote"):
            env["LIGHTON_DRY_RUN_CHECK_REMOTE"] = "1"
    elif kind == "surya_bbox":
        env["SURYA_BBOX_DRY_RUN"] = "1"
        if params.get("check_remote"):
            env["SURYA_BBOX_DRY_RUN_CHECK_REMOTE"] = "1"
    else:
        env["SURYA_DRY_RUN"] = "1"
        if params.get("check_remote"):
            env["SURYA_DRY_RUN_CHECK_REMOTE"] = "1"
    env[TRAINING_KINDS[kind]["require_upload_env"]] = "0"
    return True


def _flush_log(job_id: str | None, lines: list[str]) -> None:
    if not lines:
        return
    try:
        from common_training.job_status import append_training_log

        append_training_log(job_id, "".join(lines))
    finally:
        lines.clear()


def run_child(command: list[str], *, cwd: Path, env: dict[str, str], job_id: str | None) -> None:
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    pending: list[str] = []
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="", flush=True)
        pending.append(line)
        if len(pending) >= 40 or sum(len(item) for item in pending) > 32_000:
            _flush_log(job_id, pending)
    return_code = process.wait()
    _flush_log(job_id, pending)
    if return_code != 0:
        raise RuntimeError(f"{' '.join(command)} failed with exit code {return_code}")


def read_metrics(kind: str, output_dir: Path) -> dict[str, Any] | None:
    benchmark_path = final_model_dir_for(kind, output_dir) / TRAINING_KINDS[kind]["benchmark_file"]
    if not benchmark_path.exists():
        return None
    with open(benchmark_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    return payload.get("metrics") or payload


def read_summary(output_dir: Path) -> dict[str, Any] | None:
    summary_path = output_dir / "pipeline_summary.json"
    if not summary_path.exists():
        return None
    with open(summary_path, "r", encoding="utf-8") as f:
        return json.load(f)


def mark_training_job_failed(job_id: str | None, exc: Exception) -> None:
    try:
        from common_training.job_status import update_training_job, utc_now_iso

        update_training_job(job_id, status="failed", error_message=str(exc), finished_at=utc_now_iso())
    except Exception as update_exc:
        print(f"Training job failure update skipped: {update_exc}", flush=True)


def read_json_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def latest_bubble_line_run() -> Path:
    runs_dir = Path(str(REMOTE_DOCKER_SCRIPTS / "train_bubble_line_detector" / "runs"))
    candidates = sorted(runs_dir.glob("yolo26n_bubble_line*"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not candidates:
        raise FileNotFoundError(f"No YOLO bubble-line run found in {runs_dir}")
    return candidates[0]


def normalize_yolo_metrics(payload: dict[str, Any] | None) -> dict[str, Any]:
    raw = (payload or {}).get("metrics") or {}
    return {
        "map50": raw.get("metrics/mAP50(B)") or raw.get("map50"),
        "map50_95": raw.get("metrics/mAP50-95(B)") or raw.get("map50_95"),
        "precision": raw.get("metrics/precision(B)") or raw.get("precision"),
        "recall": raw.get("metrics/recall(B)") or raw.get("recall"),
        **raw,
    }


def summarize_ppocr_metrics(payload: dict[str, Any] | None) -> dict[str, Any]:
    payload = payload or {}
    epochs = payload.get("epochs") or []
    best_epoch = None
    if epochs:
        best_epoch = min(
            epochs,
            key=lambda item: item.get("val_cer", float("inf")) if isinstance(item, dict) else float("inf"),
        )
    summary = {
        "best_val_cer": payload.get("best_val_cer"),
        "epochs": len(epochs),
    }
    if isinstance(best_epoch, dict):
        summary.update(best_epoch)
    return summary


def write_ppocr_model_card(
    *,
    release_dir: Path,
    metrics: dict[str, Any],
    hf_repo: str,
    yolo_revision: str | None,
) -> None:
    yolo = metrics.get("yolo") or {}
    ppocr = metrics.get("ppocr") or {}
    onnx = metrics.get("onnx") or {}
    postprocess = metrics.get("postprocess") or {}
    postprocess_section = ""
    if postprocess:
        postprocess_section = f"""
## Browser postprocess metrics

- Validation CER after postprocess: `{postprocess.get("validation_cer")}`
- Validation exact match after postprocess: `{postprocess.get("validation_exact_match")}`
- Test CER after postprocess: `{postprocess.get("test_cer")}`
- Test exact match after postprocess: `{postprocess.get("test_exact_match")}`
"""
    readme = f"""---
pipeline_tag: image-to-text
license: apache-2.0
tags:
- ocr
- manga
- ppocrv6
- yolo
- onnx
---

# PP-OCRv6 One Piece Bubble Line Recognition

Browser-ready OCR package for Projet Poneglyph. The pipeline first detects text
lines inside a manga bubble with a freshly trained YOLO26n detector, stitches the
detected lines into one horizontal crop, then transcribes that crop with a
fine-tuned PP-OCRv6 recognizer.

## Latest Modal training result

- Hugging Face repo: `{hf_repo}`
- YOLO mAP50: `{yolo.get("map50")}`
- YOLO mAP50-95: `{yolo.get("map50_95")}`
- PP-OCRv6 best validation CER: `{ppocr.get("best_val_cer")}`
- PP-OCRv6 validation exact match: `{ppocr.get("val_exact_match")}`
- PP-OCRv6 short-text CER: `{ppocr.get("val_short_cer")}`
- PP-OCRv6 dialogue CER: `{ppocr.get("val_dialogue_cer")}`
- ONNX parity text match: `{onnx.get("all_text_match")}`
{postprocess_section}

## Files

- `onnx/bubble_line_detector_yolo26n.onnx`
- `onnx/ppocrv6_bubble_line_rec.onnx`
- `onnx/browser_manifest.json`
- `onnx/pipeline_manifest.json`
- `onnx/ppocrv6_postprocess_rules.json`
- `training_metrics.json`
- `yolo_metrics.json`

The frontend model key is `ppocrv6Line`.
"""
    if yolo_revision:
        readme += f"\nYOLO source revision: `{yolo_revision}`\n"
    (release_dir / "README.md").write_text(readme, encoding="utf-8")


def upload_ppocr_release(
    *,
    output_dir: Path,
    yolo_run_dir: Path,
    metrics: dict[str, Any],
    hf_repo: str,
    params: dict[str, Any],
) -> str | None:
    from huggingface_hub import HfApi

    release_dir = output_dir / "hf_release"
    if release_dir.exists():
        shutil.rmtree(release_dir)
    onnx_release_dir = release_dir / "onnx"
    onnx_release_dir.mkdir(parents=True, exist_ok=True)

    yolo_onnx = next((yolo_run_dir / "weights").glob("*.onnx"), None)
    if yolo_onnx is None:
        yolo_onnx = next(yolo_run_dir.glob("*.onnx"), None)
    if yolo_onnx is None:
        raise FileNotFoundError(f"YOLO ONNX export not found in {yolo_run_dir}")
    shutil.copy2(yolo_onnx, onnx_release_dir / "bubble_line_detector_yolo26n.onnx")

    ppocr_onnx_dir = output_dir / "onnx"
    for name in (
        "ppocrv6_bubble_line_rec.onnx",
        "browser_manifest.json",
        "preprocessor_config.json",
        "config.json",
        "ppocrv6_postprocess_rules.json",
    ):
        source = ppocr_onnx_dir / name
        if source.exists():
            shutil.copy2(source, onnx_release_dir / name)

    training_metrics_path = output_dir / "training_metrics.json"
    yolo_metrics_path = yolo_run_dir / "metrics.json"
    if training_metrics_path.exists():
        shutil.copy2(training_metrics_path, release_dir / "training_metrics.json")
    if yolo_metrics_path.exists():
        shutil.copy2(yolo_metrics_path, release_dir / "yolo_metrics.json")

    pipeline_manifest = {
        "training_kind": "ppocrv6_bubble_line",
        "hf_repo": hf_repo,
        "params": params,
        "metrics": metrics,
        "yolo_run_dir": str(yolo_run_dir),
        "ppocr_output_dir": str(output_dir),
        "files": {
            "detector": "onnx/bubble_line_detector_yolo26n.onnx",
            "recognizer": "onnx/ppocrv6_bubble_line_rec.onnx",
            "manifest": "onnx/browser_manifest.json",
        },
    }
    (onnx_release_dir / "pipeline_manifest.json").write_text(
        json.dumps(pipeline_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_ppocr_model_card(release_dir=release_dir, metrics=metrics, hf_repo=hf_repo, yolo_revision=None)

    api = HfApi()
    api.create_repo(repo_id=hf_repo, repo_type="model", exist_ok=True)
    commit_info = api.upload_folder(
        folder_path=str(release_dir),
        repo_id=hf_repo,
        repo_type="model",
        commit_message="Upload YOLO26n + PP-OCRv6 bubble-line Modal training result",
    )
    return getattr(commit_info, "oid", None)


def _train_ppocrv6_bubble_line_impl(
    *,
    job_id: str,
    params: dict[str, Any],
    dataset_dir: Path,
    output_dir: Path,
    env: dict[str, str],
    modal_function_name: str,
) -> dict[str, Any]:
    from common_training.job_status import create_model_version, update_training_job, utc_now_iso

    hf_repo = env["HF_REPO"]
    yolo_script_dir = Path(str(REMOTE_DOCKER_SCRIPTS / "train_bubble_line_detector"))
    ppocr_script_dir = Path(str(REMOTE_DOCKER_SCRIPTS / "finetune_paddleocr_line_rec"))

    update_training_job(
        job_id,
        status="running",
        provider="modal",
        modal_function_name=modal_function_name,
        modal_call_id=current_function_call_id(),
        hf_repo=hf_repo,
        started_at=utc_now_iso(),
        summary_json={"stage": "yolo_bubble_line", "dataset_dir": str(dataset_dir), "output_dir": str(output_dir)},
    )

    run_child(
        [
            sys.executable,
            "-u",
            "run_pipeline.py",
            "--model",
            str(params.get("yolo_model") or "yolo26n.pt"),
            "--imgsz",
            str(int(params.get("yolo_imgsz") or 1024)),
            "--epochs",
            str(int(params.get("yolo_epochs") or 160)),
            "--batch",
            str(int(params.get("yolo_batch_size") or 32)),
            "--patience",
            str(int(params.get("yolo_patience") or 40)),
            "--workers",
            str(int(params.get("yolo_workers") or 4)),
        ],
        cwd=yolo_script_dir,
        env=env,
        job_id=job_id,
    )

    yolo_run = latest_bubble_line_run()
    detector_dir = output_dir / "line_detector"
    detector_dir.mkdir(parents=True, exist_ok=True)
    yolo_best = yolo_run / "weights" / "best.pt"
    if not yolo_best.exists():
        raise FileNotFoundError(f"YOLO best.pt missing: {yolo_best}")
    shutil.copy2(yolo_best, detector_dir / "best.pt")
    if (output_dir / "yolo_run").exists():
        shutil.rmtree(output_dir / "yolo_run")
    shutil.copytree(yolo_run, output_dir / "yolo_run")

    update_training_job(
        job_id,
        status="running",
        summary_json={
            "stage": "ppocrv6_line_rec",
            "dataset_dir": str(dataset_dir),
            "output_dir": str(output_dir),
            "detector": str(detector_dir / "best.pt"),
            "yolo_run": str(yolo_run),
        },
    )

    ppocr_command = [
        sys.executable,
        "-u",
        "run_pipeline.py",
        "--source-mode",
        str(params.get("source_mode") or "supabase"),
        "--detector",
        str(detector_dir / "best.pt"),
        "--output-dir",
        str(output_dir),
        "--clean",
        "--train",
        "--epochs",
        str(int(params.get("epochs") or 14)),
        "--batch-size",
        str(int(params.get("batch_size") or 4)),
        "--learning-rate",
        str(float(params.get("learning_rate") or 0.00002)),
        "--backbone-learning-rate",
        str(float(params.get("backbone_learning_rate") or 0.000002)),
        "--lr-scheduler",
        str(params.get("lr_scheduler") or "cosine"),
        "--warmup-ratio",
        str(float(params.get("warmup_ratio") or 0.05)),
        "--image-width",
        str(int(params.get("image_width") or 960)),
        "--grad-accum-steps",
        str(int(params.get("grad_accum") or 4)),
        "--short-oversample",
        str(float(params.get("short_oversample") or 3)),
        "--short-loss-weight",
        str(float(params.get("short_loss_weight") or 2.5)),
        "--single-line-oversample",
        str(float(params.get("single_line_oversample") or 1.0)),
        "--single-line-loss-weight",
        str(float(params.get("single_line_loss_weight") or 1.0)),
        "--train-workers",
        str(int(params.get("dataloader_workers") or 0)),
    ]
    if params.get("train_backbone"):
        ppocr_command.append("--train-backbone")
    if params.get("pin_memory"):
        ppocr_command.append("--pin-memory")
    run_child(ppocr_command, cwd=ppocr_script_dir, env=env, job_id=job_id)

    best_dir = output_dir / "ppocrv6_medium_rec_line_finetune_best"
    if not best_dir.exists():
        raise FileNotFoundError(f"PP-OCRv6 best checkpoint missing: {best_dir}")
    onnx_dir = output_dir / "onnx"
    run_child(
        [
            sys.executable,
            "-u",
            "export_ppocrv6_onnx.py",
            "--model-dir",
            str(best_dir),
            "--output-dir",
            str(onnx_dir),
            "--image-width",
            str(int(params.get("image_width") or 960)),
            "--sample-image",
            str(output_dir / "bubble_single_line_rec_dataset" / "images" / "val"),
            "--max-samples",
            "8",
            "--postprocess-train-labels",
            str(output_dir / "bubble_single_line_rec_dataset" / "rec_gt_train.txt"),
        ],
        cwd=ppocr_script_dir,
        env=env,
        job_id=job_id,
    )

    yolo_metrics = normalize_yolo_metrics(read_json_file(output_dir / "yolo_run" / "metrics.json"))
    ppocr_raw_metrics = read_json_file(output_dir / "training_metrics.json") or {}
    ppocr_metrics = summarize_ppocr_metrics(ppocr_raw_metrics)
    onnx_manifest = read_json_file(onnx_dir / "browser_manifest.json") or {}
    metrics = {
        "yolo": yolo_metrics,
        "ppocr": ppocr_metrics,
        "onnx": {
            "all_text_match": (onnx_manifest.get("parity") or {}).get("all_text_match"),
            "max_abs_diff": (onnx_manifest.get("parity") or {}).get("max_abs_diff"),
            "samples": (onnx_manifest.get("parity") or {}).get("samples"),
        },
    }

    hf_revision = None
    if not params.get("skip_upload"):
        update_training_job(job_id, status="uploading", metrics_json=metrics)
        hf_revision = upload_ppocr_release(
            output_dir=output_dir,
            yolo_run_dir=output_dir / "yolo_run",
            metrics=metrics,
            hf_repo=hf_repo,
            params=params,
        )

    summary = {
        "status": "completed",
        "training_kind": "ppocrv6_bubble_line",
        "provider": "modal",
        "dataset_dir": str(dataset_dir),
        "output_dir": str(output_dir),
        "detector": str(output_dir / "onnx" / "bubble_line_detector_yolo26n.onnx"),
        "recognizer": str(output_dir / "onnx" / "ppocrv6_bubble_line_rec.onnx"),
        "hf_repo": hf_repo,
        "hf_revision": hf_revision,
        "finished_at": utc_now_iso(),
    }
    (output_dir / "pipeline_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    update_training_job(
        job_id,
        status="completed",
        metrics_json=metrics,
        summary_json=summary,
        hf_repo=hf_repo,
        finished_at=summary["finished_at"],
    )
    create_model_version(
        training_job_id=job_id,
        kind="ppocrv6_bubble_line",
        hf_repo=hf_repo,
        hf_revision=hf_revision,
        metrics_json=metrics,
        notes="Created automatically from combined Modal YOLO26n + PP-OCRv6 bubble-line training job.",
    )
    return {"job_id": job_id, "training_kind": "ppocrv6_bubble_line", "output_dir": str(output_dir), "hf_repo": hf_repo, "hf_revision": hf_revision}


@app.function(
    image=training_image,
    timeout=6 * 60 * 60,
    volumes={str(VOLUME_MOUNT): dataset_volume},
    secrets=modal_secrets,
)
def prepare_dataset(job_id: str, dataset_kind: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    from common_training.artifacts import write_dataset_manifest
    from common_training.job_status import update_training_job, utc_now_iso

    kind = normalize_kind(dataset_kind)
    params = params_with_gpu_defaults(kind, params)
    update_training_job(
        job_id,
        status="preparing_dataset",
        provider="modal",
        modal_function_name="prepare_dataset",
        modal_call_id=current_function_call_id(),
        modal_volume_name=VOLUME_NAME,
    )

    target_dir = volume_dataset_dir(job_id, kind)
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.parent.mkdir(parents=True, exist_ok=True)

    try:
        if kind == "ppocrv6_bubble_line":
            source_dataset = Path("/app/dataset")
            shutil.copytree(source_dataset, target_dir)
            manifest = write_dataset_manifest(
                target_dir,
                job_id=job_id,
                dataset_kind=kind,
                provider="modal",
                params=params,
                sharding_requested=False,
            )
            dataset_volume.commit()
            update_training_job(
                job_id,
                status="dataset_ready",
                summary_json={
                    "dataset_dir": str(target_dir),
                    "dataset_manifest": str(target_dir / "dataset_manifest.json"),
                    "yolo_dataset": str(manifest),
                },
            )
            return {"job_id": job_id, "dataset_kind": kind, "dataset_dir": str(target_dir)}

        with tempfile.TemporaryDirectory(prefix=f"poneglyph-{job_id}-") as tmp:
            tmp_dataset = Path(tmp) / TRAINING_KINDS[kind]["volume_kind"]
            env = base_child_env(job_id, kind, params)
            env[TRAINING_KINDS[kind]["dataset_env"]] = str(tmp_dataset)
            env[TRAINING_KINDS[kind]["clean_env"]] = "1"
            run_child([sys.executable, "-u", "export_dataset.py"], cwd=script_dir(kind), env=env, job_id=job_id)
            shutil.copytree(tmp_dataset, target_dir)
            write_dataset_manifest(
                target_dir,
                job_id=job_id,
                dataset_kind=kind,
                provider="modal",
                params=params,
                sharding_requested=bool(params.get("shard_dataset")),
            )

        dataset_volume.commit()
        update_training_job(
            job_id,
            status="dataset_ready",
            summary_json={"dataset_dir": str(target_dir), "dataset_manifest": str(target_dir / "dataset_manifest.json")},
        )
        return {"job_id": job_id, "dataset_kind": kind, "dataset_dir": str(target_dir)}
    except Exception as exc:
        mark_training_job_failed(job_id, exc)
        raise


def _train_model_impl(
    job_id: str,
    training_kind: str,
    params: dict[str, Any] | None = None,
    *,
    modal_function_name: str = "train_model",
) -> dict[str, Any]:
    from common_training.job_status import create_model_version, update_training_job

    kind = normalize_kind(training_kind)
    params = params_with_gpu_defaults(kind, params)
    try:
        dataset_volume.reload()

        dataset_dir = volume_dataset_dir(job_id, kind)
        output_dir = volume_output_dir(job_id, kind)
        output_dir.mkdir(parents=True, exist_ok=True)
        if not dataset_dir.exists():
            raise FileNotFoundError(f"Dataset not found in Modal Volume: {dataset_dir}")

        env = base_child_env(job_id, kind, params)
        if kind == "ppocrv6_bubble_line":
            env.setdefault("HF_HOME", str(VOLUME_MOUNT / "hf-cache"))
            return _train_ppocrv6_bubble_line_impl(
                job_id=job_id,
                params=params,
                dataset_dir=dataset_dir,
                output_dir=output_dir,
                env=env,
                modal_function_name=modal_function_name,
            )

        env[TRAINING_KINDS[kind]["dataset_env"]] = str(dataset_dir)
        env[TRAINING_KINDS[kind]["output_env"]] = str(output_dir)
        if params.get("skip_upload"):
            env[TRAINING_KINDS[kind]["require_upload_env"]] = "0"
            env[TRAINING_KINDS[kind]["skip_upload_env"]] = "1"
        else:
            env[TRAINING_KINDS[kind]["require_upload_env"]] = "1"
            env[TRAINING_KINDS[kind]["skip_upload_env"]] = "0"
        is_dry_run = apply_dry_run_env(env, kind, params)
        env.setdefault("HF_HOME", str(VOLUME_MOUNT / "hf-cache"))

        update_training_job(
            job_id,
            status="starting_gpu",
            provider="modal",
            modal_function_name=modal_function_name,
            modal_call_id=current_function_call_id(),
            hf_repo=env["HF_REPO"],
            summary_json={"dataset_dir": str(dataset_dir), "output_dir": str(output_dir), "gpu": gpu_from_params(params)},
        )
        run_child([sys.executable, "-u", "run_pipeline.py"], cwd=script_dir(kind), env=env, job_id=job_id)
        dataset_volume.commit()

        if is_dry_run:
            summary = {
                "status": "dry_run_complete",
                "dry_run": True,
                "dataset_dir": str(dataset_dir),
                "output_dir": str(output_dir),
                "gpu": gpu_from_params(params),
            }
            update_training_job(
                job_id,
                status="completed",
                summary_json=summary,
                hf_repo=env["HF_REPO"],
            )
            return {"job_id": job_id, "training_kind": kind, "dry_run": True, "output_dir": str(output_dir)}

        metrics = read_metrics(kind, output_dir)
        summary = read_summary(output_dir) or {}
        update_training_job(
            job_id,
            status="completed",
            metrics_json=metrics,
            summary_json=summary,
            hf_repo=env["HF_REPO"],
        )
        create_model_version(
            training_job_id=job_id,
            kind=kind,
            hf_repo=env["HF_REPO"],
            metrics_json=metrics,
            notes="Created automatically from Modal training job.",
        )
        return {"job_id": job_id, "training_kind": kind, "output_dir": str(output_dir), "hf_repo": env["HF_REPO"]}
    except Exception as exc:
        mark_training_job_failed(job_id, exc)
        raise


@app.function(
    image=training_image,
    timeout=24 * 60 * 60,
    volumes={str(VOLUME_MOUNT): dataset_volume},
    secrets=modal_secrets,
    gpu="L40S",
    name="train_model",
)
def train_model(job_id: str, training_kind: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return _train_model_impl(job_id, training_kind, params, modal_function_name="train_model")


@app.function(
    image=training_image,
    timeout=24 * 60 * 60,
    volumes={str(VOLUME_MOUNT): dataset_volume},
    secrets=modal_secrets,
    gpu="A100-80GB",
    name="train_model_a100_80gb",
)
def train_model_a100_80gb(job_id: str, training_kind: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return _train_model_impl(job_id, training_kind, params, modal_function_name="train_model_a100_80gb")


@app.function(
    image=training_image,
    timeout=24 * 60 * 60,
    volumes={str(VOLUME_MOUNT): dataset_volume},
    secrets=modal_secrets,
    gpu="H100",
    name="train_model_h100",
)
def train_model_h100(job_id: str, training_kind: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return _train_model_impl(job_id, training_kind, params, modal_function_name="train_model_h100")


@app.function(
    image=training_image,
    timeout=24 * 60 * 60,
    volumes={str(VOLUME_MOUNT): dataset_volume},
    secrets=modal_secrets,
    gpu="H200",
    name="train_model_h200",
)
def train_model_h200(job_id: str, training_kind: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return _train_model_impl(job_id, training_kind, params, modal_function_name="train_model_h200")


@app.function(
    image=training_image,
    timeout=24 * 60 * 60,
    volumes={str(VOLUME_MOUNT): dataset_volume},
    secrets=modal_secrets,
    gpu="B200",
    name="train_model_b200",
)
def train_model_b200(job_id: str, training_kind: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return _train_model_impl(job_id, training_kind, params, modal_function_name="train_model_b200")


TRAIN_MODEL_FUNCTIONS = {
    "L40S": train_model,
    "A100-80GB": train_model_a100_80gb,
    "H100": train_model_h100,
    "H200": train_model_h200,
    "B200": train_model_b200,
}


@app.function(image=training_image, timeout=24 * 60 * 60, secrets=modal_secrets)
def run_training_job(job_id: str, training_kind: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    from common_training.job_status import update_training_job, utc_now_iso

    kind = normalize_kind(training_kind)
    params = params_with_gpu_defaults(kind, params)
    try:
        update_training_job(
            job_id,
            status="queued",
            provider="modal",
            modal_function_name="run_training_job",
            modal_call_id=current_function_call_id(),
            modal_volume_name=VOLUME_NAME,
        )
        dataset_result = prepare_dataset.remote(job_id, kind, params)
        gpu = gpu_from_params(params)
        gpu_train_model = TRAIN_MODEL_FUNCTIONS[gpu]
        training_result = gpu_train_model.remote(job_id, kind, params)
        return {"dataset": dataset_result, "training": training_result}
    except Exception as exc:
        update_training_job(job_id, status="failed", error_message=str(exc), finished_at=utc_now_iso())
        raise


@app.local_entrypoint()
def main(job_id: str, training_kind: str = "surya_bubble_ocr", params_json: str = "{}") -> None:
    params = json.loads(params_json or "{}")
    result = run_training_job.remote(job_id, training_kind, params)
    print(json.dumps(result, ensure_ascii=False, indent=2))
