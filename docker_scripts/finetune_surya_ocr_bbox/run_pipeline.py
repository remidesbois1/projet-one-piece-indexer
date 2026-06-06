import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from huggingface_hub import HfApi, login


os.environ["PYTHONUNBUFFERED"] = "1"
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent
os.chdir(SCRIPT_DIR)

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

DEFAULT_HF_REPO = "Remidesbois/surya-ocr-2-poneglyph-bbox"


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def parse_args():
    parser = argparse.ArgumentParser(description="Run the Surya bbox fine-tune pipeline.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate env, writable paths, parser, and processor loading without exporting or training.",
    )
    parser.add_argument(
        "--check-remote",
        action="store_true",
        help="With --dry-run, also validate Supabase query access and Hugging Face token.",
    )
    return parser.parse_args()


def dataset_dir():
    return Path(
        os.getenv("SURYA_BBOX_DATASET_DIR", str(SCRIPT_DIR / "surya_bbox_dataset"))
    )


def output_dir():
    return Path(
        os.getenv("SURYA_BBOX_OUTPUT_DIR", str(SCRIPT_DIR / "outputs_surya_bbox"))
    )


def final_model_dir():
    return output_dir() / "final_merged"


def hf_repo_id():
    return os.getenv("HF_REPO", DEFAULT_HF_REPO)


def missing_required_env():
    required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    missing = [name for name in required if not os.getenv(name)]
    if env_bool("SURYA_BBOX_REQUIRE_UPLOAD", False) and not os.getenv("HF_TOKEN"):
        missing.append("HF_TOKEN")
    return missing


def required_env():
    missing = missing_required_env()
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", flush=True)
        sys.exit(1)


def terminate_runpod(is_error=False):
    pod_id = os.getenv("RUNPOD_POD_ID")
    api_key = os.getenv("RUNPOD_API_KEY")
    if not pod_id or not api_key or not env_bool("RUNPOD_TERMINATE_ON_EXIT", True):
        print("RunPod auto-termination skipped.", flush=True)
        return

    if is_error:
        delay = int(os.getenv("RUNPOD_ERROR_SHUTDOWN_DELAY_SECONDS", "600"))
        print(f"Pipeline failed. Waiting {delay}s before RunPod termination.", flush=True)
        time.sleep(delay)

    print(f"Terminating RunPod pod: {pod_id}", flush=True)
    url = f"https://api.runpod.io/graphql?api_key={api_key}"
    query = f'mutation {{ podTerminate(input: {{podId: "{pod_id}"}}) }}'
    try:
        response = requests.post(url, json={"query": query}, timeout=30)
        print(f"RunPod termination response: {response.text}", flush=True)
    except Exception as exc:
        print(f"RunPod termination failed: {exc}", flush=True)


def run_step(label, script, *args):
    print("", flush=True)
    print(label, flush=True)
    result = subprocess.run(
        [sys.executable, "-u", script, *args],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    if result.returncode != 0:
        print(f"{script} failed with exit code {result.returncode}.", flush=True)
        terminate_runpod(is_error=True)
        sys.exit(result.returncode)


def run_probe(label, command):
    print("", flush=True)
    print(label, flush=True)
    return subprocess.run(
        command,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    ).returncode


def dataset_is_ready(path: Path):
    return all((path / split / "metadata.jsonl").exists() for split in ("train", "val", "test"))


def final_model_is_ready(path: Path):
    return (path / "config.json").exists()


def benchmark_is_ready(path: Path):
    return (path / "benchmark_surya_bbox.json").exists()


def comparison_is_ready(path: Path):
    return (path / "comparison_lighton_bbox.json").exists()


def assert_writable_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)
    probe = path / ".poneglyph_write_test"
    probe.write_text("ok", encoding="utf-8")
    probe.unlink(missing_ok=True)


def print_env_presence():
    keys = [
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "HF_TOKEN",
        "HF_REPO",
        "SURYA_BBOX_REQUIRE_UPLOAD",
        "SURYA_BBOX_COMPARE_LIGHTON",
        "SURYA_BBOX_REQUIRE_LIGHTON_COMPARISON",
        "RUNPOD_API_KEY",
        "RUNPOD_POD_ID",
        "RUNPOD_TERMINATE_ON_EXIT",
    ]
    print("Environment presence:", flush=True)
    for key in keys:
        value = hf_repo_id() if key == "HF_REPO" else os.getenv(key)
        status = "present" if value else "missing"
        if key == "HF_REPO" and value == DEFAULT_HF_REPO and not os.getenv("HF_REPO"):
            status = f"default ({DEFAULT_HF_REPO})"
        if key.startswith("SURYA_BBOX_") and value:
            status = value
        print(f"  {key}: {status}", flush=True)


def check_supabase_access():
    from supabase import create_client

    status_value = os.getenv("SURYA_BBOX_STATUS_VALUE", "Valid\u00e9")
    client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    response = (
        client.table("bulles")
        .select("id, x, y, w, h, texte_propose, order, id_page, pages(url_image)")
        .eq("statut", status_value)
        .limit(1)
        .execute()
    )
    sample_count = len(response.data or [])
    print(f"Supabase query access ok; sample rows returned: {sample_count}", flush=True)


def check_hf_access():
    token = os.getenv("HF_TOKEN")
    if not token:
        print("HF_TOKEN missing; skipping Hugging Face token check.", flush=True)
        return
    api = HfApi(token=token)
    whoami = api.whoami()
    username = whoami.get("name") or whoami.get("fullname") or "authenticated"
    print(f"Hugging Face token ok for: {username}", flush=True)


def dry_run(check_remote=False):
    print("Surya bbox RunPod dry run.", flush=True)
    print_env_presence()

    failures = []
    missing = missing_required_env()
    if missing:
        failures.append(f"missing env: {', '.join(sorted(set(missing)))}")

    for label, path in (("dataset_dir", dataset_dir()), ("output_dir", output_dir())):
        try:
            assert_writable_dir(path)
            print(f"Writable {label}: {path}", flush=True)
        except Exception as exc:
            failures.append(f"{label} not writable: {path} ({exc})")

    smoke_status = run_probe(
        "Running Surya bbox smoke check...",
        [sys.executable, "-u", "smoke_check.py"],
    )
    if smoke_status != 0:
        failures.append(f"smoke_check.py failed with exit code {smoke_status}")

    if check_remote:
        print("", flush=True)
        print("Checking remote credentials and query access...", flush=True)
        try:
            check_supabase_access()
        except Exception as exc:
            failures.append(f"Supabase query check failed: {exc}")
        try:
            check_hf_access()
        except Exception as exc:
            failures.append(f"Hugging Face token check failed: {exc}")

    if failures:
        print("", flush=True)
        print("Dry run failed:", flush=True)
        for failure in failures:
            print(f"  - {failure}", flush=True)
        return 1

    print("", flush=True)
    print("Dry run passed. Launch without --dry-run to export, train, benchmark, compare, and upload.", flush=True)
    return 0


def write_pipeline_summary(status: str):
    summary = {
        "status": status,
        "dataset_dir": str(dataset_dir()),
        "output_dir": str(output_dir()),
        "final_model_dir": str(final_model_dir()),
        "benchmark_path": str(final_model_dir() / "benchmark_surya_bbox.json"),
        "comparison_path": str(final_model_dir() / "comparison_lighton_bbox.json"),
        "hf_repo": hf_repo_id(),
    }
    summary_path = output_dir() / "pipeline_summary.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"Pipeline summary saved to {summary_path}", flush=True)


def write_model_card():
    run_step("Step 3: writing Hugging Face README model card", "write_hf_readme.py")


def maybe_upload_to_hf():
    if env_bool("SURYA_BBOX_SKIP_UPLOAD", False):
        print("Skipping Hugging Face upload because SURYA_BBOX_SKIP_UPLOAD=1.", flush=True)
        return

    token = os.getenv("HF_TOKEN")
    repo_id = hf_repo_id()
    if not token:
        message = "HF_TOKEN missing; skipping optional Hugging Face upload."
        if env_bool("SURYA_BBOX_REQUIRE_UPLOAD", False):
            raise RuntimeError(message)
        print(message, flush=True)
        return

    login(token=token)
    api = HfApi()
    api.create_repo(repo_id=repo_id, exist_ok=True, private=env_bool("HF_PRIVATE", False))
    print(f"Uploading final model to Hugging Face: {repo_id}", flush=True)
    api.upload_folder(
        folder_path=str(final_model_dir()),
        repo_id=repo_id,
        repo_type="model",
        commit_message="Upload Surya OCR 2 Poneglyph bbox fine-tuned model",
    )
    print("Hugging Face upload complete.", flush=True)


def main():
    args = parse_args()
    if args.dry_run or env_bool("SURYA_BBOX_DRY_RUN", False):
        sys.exit(dry_run(check_remote=args.check_remote or env_bool("SURYA_BBOX_DRY_RUN_CHECK_REMOTE", False)))

    required_env()
    print("Starting Surya OCR 2 Poneglyph bbox pipeline.", flush=True)
    print(f"Dataset directory: {dataset_dir()}", flush=True)
    print(f"Output directory:  {output_dir()}", flush=True)
    print(f"Hugging Face repo: {hf_repo_id()}", flush=True)

    if dataset_is_ready(dataset_dir()) and not env_bool("SURYA_BBOX_FORCE_EXPORT", False):
        print("Dataset already exists. Skipping export.", flush=True)
    else:
        run_step("Step 1: exporting Supabase full-page bbox dataset", "export_dataset.py")

    model_ready = final_model_is_ready(final_model_dir())
    benchmark_ready = benchmark_is_ready(final_model_dir())
    comparison_ready = comparison_is_ready(final_model_dir())
    need_comparison = env_bool("SURYA_BBOX_COMPARE_LIGHTON", True)

    if (
        model_ready
        and benchmark_ready
        and (comparison_ready or not need_comparison)
        and not env_bool("SURYA_BBOX_FORCE_TRAIN", False)
    ):
        print("Final model, benchmark, and comparison already exist. Skipping training.", flush=True)
    elif model_ready and not env_bool("SURYA_BBOX_FORCE_TRAIN", False):
        print("Final model exists but benchmark/comparison is missing.", flush=True)
        run_step(
            "Step 2: benchmarking existing final model",
            "train_surya_bbox.py",
            "--benchmark-only",
        )
    else:
        run_step("Step 2: fine-tuning Surya OCR 2 bbox model", "train_surya_bbox.py")

    write_model_card()

    try:
        maybe_upload_to_hf()
    except Exception as exc:
        print(f"Hugging Face upload failed: {exc}", flush=True)
        terminate_runpod(is_error=True)
        sys.exit(1)

    write_pipeline_summary("complete")
    print("Surya bbox pipeline complete.", flush=True)
    terminate_runpod(is_error=False)


if __name__ == "__main__":
    main()
