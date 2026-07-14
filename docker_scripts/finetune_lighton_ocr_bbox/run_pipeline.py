import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv
from huggingface_hub import HfApi, login


SCRIPT_DIR = Path(__file__).resolve().parent
os.chdir(SCRIPT_DIR)
load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(SCRIPT_DIR.parent.parent / ".env")
os.environ["PYTHONUNBUFFERED"] = "1"

DATASET_DIR = Path(os.getenv("LIGHTON_BBOX_DATASET_DIR", SCRIPT_DIR / "lighton_bbox_dataset"))
OUTPUT_DIR = Path(os.getenv("LIGHTON_BBOX_OUTPUT_DIR", SCRIPT_DIR / "outputs_lighton_bbox"))
FINAL_DIR = OUTPUT_DIR / "final_lora_merged"
HF_REPO = os.getenv("HF_REPO", "Remidesbois/LightonOCR-2-1b-poneglyph-bbox")


def env_bool(name, default=False):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_args():
    parser = argparse.ArgumentParser(description="LightOnOCR bbox GPU-optimized pipeline")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def run_step(label, script, *args):
    print(f"\n{label}", flush=True)
    result = subprocess.run(
        [sys.executable, "-u", script, *args],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    if result.returncode:
        raise RuntimeError(f"{script} failed with exit code {result.returncode}")


def dataset_ready():
    return (DATASET_DIR / "split_manifest.json").exists() and all(
        (DATASET_DIR / split / "metadata.jsonl").exists()
        for split in ("train", "val", "test")
    )


def read_gate(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def upload_if_accepted():
    if env_bool("LIGHTON_SKIP_UPLOAD", False):
        print("Hugging Face upload disabled by LIGHTON_SKIP_UPLOAD=1.", flush=True)
        return
    current_gate = read_gate(OUTPUT_DIR / "last_quality_gate.json")
    final_gate = read_gate(FINAL_DIR / "quality_gate.json")
    if (
        not current_gate.get("release_ready")
        or not final_gate.get("release_ready")
    ) and not env_bool("LIGHTON_ALLOW_FAILED_GATE_UPLOAD", False):
        print("Candidate not uploaded: bbox quality/speed gate did not pass.", flush=True)
        return
    token = os.getenv("HF_TOKEN")
    if not token:
        if env_bool("LIGHTON_REQUIRE_UPLOAD", False):
            raise RuntimeError("HF_TOKEN is required for upload")
        print("HF_TOKEN missing; optional upload skipped.", flush=True)
        return
    login(token=token)
    api = HfApi(token=token)
    api.create_repo(repo_id=HF_REPO, exist_ok=True, private=env_bool("HF_PRIVATE", False))
    api.upload_folder(
        folder_path=str(FINAL_DIR),
        repo_id=HF_REPO,
        repo_type="model",
        commit_message="Upload gated LightOnOCR Poneglyph bbox model",
    )
    print(f"Accepted model uploaded to {HF_REPO}.", flush=True)


def write_summary(status, error=None):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    default_profile = (
        "3090_profile.json"
        if os.getenv("LIGHTON_HARDWARE_PROFILE", "rtx5090").lower() == "rtx3090"
        else "5090_profile.json"
    )
    profile_filename = os.getenv("LIGHTON_PROFILE_FILENAME", default_profile)
    profile = read_gate(OUTPUT_DIR / profile_filename)
    gate = read_gate(OUTPUT_DIR / "last_quality_gate.json")
    payload = {
        "status": status,
        "error": error,
        "training_kind": "lighton_ocr_bbox",
        "dataset_dir": str(DATASET_DIR),
        "output_dir": str(OUTPUT_DIR),
        "final_model_dir": str(FINAL_DIR),
        "benchmark_path": str(FINAL_DIR / "benchmark_test.json"),
        "hf_repo": HF_REPO,
        "image_longest_edge": 1500,
        "hardware_profile": os.getenv("LIGHTON_HARDWARE_PROFILE", "rtx5090"),
        "profile": profile,
        "quality_gate": gate,
    }
    (OUTPUT_DIR / "pipeline_summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def dry_run():
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    run_step("Checking pinned imports and processor", "smoke_check.py")
    print("BBox dry run passed (fixed 1500 px configuration).", flush=True)


def main():
    args = parse_args()
    if args.dry_run or env_bool("LIGHTON_DRY_RUN", False):
        dry_run()
        return
    missing = [
        name
        for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
        if not os.getenv(name)
    ]
    if missing:
        raise RuntimeError(f"Missing environment variables: {', '.join(missing)}")
    try:
        hardware = os.getenv("LIGHTON_HARDWARE_PROFILE", "rtx5090").upper()
        print(f"Starting LightOnOCR bbox pipeline for {hardware} (1500 px).", flush=True)
        if dataset_ready() and not env_bool("LIGHTON_FORCE_EXPORT", False):
            print("Frozen bbox dataset already exists; export skipped.", flush=True)
        else:
            run_step("Step 1: exporting frozen train/val/test page splits", "export_dataset.py")

        trained_candidate = False
        if (
            (FINAL_DIR / "config.json").exists()
            and (FINAL_DIR / "benchmark_test.json").exists()
            and read_gate(FINAL_DIR / "quality_gate.json").get("release_ready")
            and not env_bool("LIGHTON_FORCE_TRAIN", False)
        ):
            print("Existing final model already passed its gate; training skipped.", flush=True)
        else:
            run_step("Step 2: optimized bbox SFT + hard-page SFT + benchmark", "train_lighton_bbox.py")
            trained_candidate = True
        if trained_candidate:
            upload_if_accepted()
        write_summary("complete")
    except Exception as exc:
        write_summary("failed", str(exc))
        print(f"LightOnOCR bbox pipeline failed: {exc}", flush=True)
        raise


if __name__ == "__main__":
    main()
