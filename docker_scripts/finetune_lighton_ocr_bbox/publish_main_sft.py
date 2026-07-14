"""Recover, benchmark and publish the best main-SFT bbox checkpoint.

This deliberately skips hard-example SFT. Use --force only when the operator
has decided the already-trained main SFT is the model to publish.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from huggingface_hub import HfApi, login


ROOT = Path(__file__).resolve().parent
OUTPUT = Path(os.getenv("LIGHTON_BBOX_OUTPUT_DIR", ROOT / "outputs_lighton_bbox"))
CANDIDATE = OUTPUT / "candidate_lora_merged"
FINAL = OUTPUT / "final_lora_merged"
REPO = os.getenv("HF_REPO", "Remidesbois/LightonOCR-2-1b-poneglyph-bbox")


def run(*args):
    subprocess.run([sys.executable, *args], cwd=ROOT, env={**os.environ, "PYTHONUNBUFFERED": "1"}, check=True)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_model_card(benchmark, forced):
    metrics = benchmark.get("metrics") or {}
    strict = metrics.get("strict") or {}
    gate = read_json(CANDIDATE / "quality_gate.json")
    (FINAL / "README.md").write_text(
        """---\n"""
        f"library_name: transformers\n"
        f"base_model: lightonai/LightOnOCR-2-1B-bbox-base\n"
        "pipeline_tag: image-text-to-text\n"
        "tags:\n- lightonocr\n- ocr\n- bounding-box\n- manga\n---\n\n"
        "# LightOnOCR Poneglyph BBox\n\n"
        "Merged main-SFT adapter for full manga pages. Images are resized with a "
        "1500 px longest side. Greedy deterministic decoding is used.\n\n"
        "## Evaluation\n\n"
        f"- CER: `{strict.get('cer', metrics.get('cer'))}`\n"
        f"- WER: `{strict.get('wer', metrics.get('wer'))}`\n"
        f"- Exact match: `{strict.get('exact_match', metrics.get('exact_match'))}`\n"
        f"- BBox F1@0.5: `{metrics.get('f1_50')}`\n"
        f"- Quality gate: `{gate.get('release_ready', False)}`\n"
        f"- Published with operator override: `{forced}`\n\n"
        "## Reproducibility\n\n"
        "The frozen train/validation/test split and benchmark JSON are included "
        "alongside this model.\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="publish even if the automatic gate is false")
    parser.add_argument("--skip-upload", action="store_true")
    args = parser.parse_args()

    # Merge the best checkpoint selected by trainer_state.json. No training occurs.
    run("train_lighton_bbox.py", "--merge-only")
    run("train_lighton_bbox.py", "--benchmark-only", "--model-path", "/app/outputs_lighton_bbox/candidate_lora_merged")

    benchmark = read_json(CANDIDATE / "benchmark_test.json")
    gate = read_json(CANDIDATE / "quality_gate.json")
    if not gate.get("release_ready") and not args.force:
        raise RuntimeError("Automatic gate failed; rerun with --force only after reviewing candidate/quality_gate.json")

    if FINAL.exists():
        shutil.rmtree(FINAL)
    shutil.copytree(CANDIDATE, FINAL)
    write_model_card(benchmark, args.force)

    token = os.getenv("HF_TOKEN")
    if args.skip_upload:
        print(f"Merged model ready locally: {FINAL}", flush=True)
        return
    if not token:
        raise RuntimeError("HF_TOKEN is required for upload (or pass --skip-upload)")
    login(token=token)
    HfApi(token=token).create_repo(repo_id=REPO, repo_type="model", exist_ok=True)
    HfApi(token=token).upload_folder(
        folder_path=str(FINAL),
        repo_id=REPO,
        repo_type="model",
        commit_message="Publish merged LightOnOCR bbox main SFT",
    )
    print(f"Published {REPO}", flush=True)


if __name__ == "__main__":
    main()
