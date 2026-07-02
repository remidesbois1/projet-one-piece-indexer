import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv
from huggingface_hub import HfApi, login


os.environ["PYTHONUNBUFFERED"] = "1"
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
DOCKER_SCRIPTS_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = DOCKER_SCRIPTS_DIR.parent
os.chdir(SCRIPT_DIR)
sys.path.insert(0, str(DOCKER_SCRIPTS_DIR))

load_dotenv(SCRIPT_DIR / ".env")
load_dotenv(DOCKER_SCRIPTS_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

from common_training.artifacts import standard_pipeline_summary, write_json
from common_training.env import env_bool, training_job_id, training_provider
from common_training.provider import provider_from_env

DEFAULT_HF_REPO = "Remidesbois/surya-bubble-ocr-poneglyph"


def required_env():
    missing = missing_required_env()
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", flush=True)
        sys.exit(1)


def missing_required_env():
    required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    missing = [name for name in required if not os.getenv(name)]

    if env_bool("SURYA_REQUIRE_UPLOAD", False) and not os.getenv("HF_TOKEN"):
        missing.append("HF_TOKEN")
    return missing


def parse_args():
    parser = argparse.ArgumentParser(description="Run the Surya bubble OCR pipeline.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate env, writable paths, and Surya API without exporting or training.",
    )
    parser.add_argument(
        "--check-remote",
        action="store_true",
        help="With --dry-run, also validate Supabase query access and Hugging Face token.",
    )
    return parser.parse_args()


def run_step(label, script, *args):
    print("", flush=True)
    print(label, flush=True)
    result = subprocess.run(
        [sys.executable, "-u", script, *args],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    if result.returncode != 0:
        print(f"{script} failed with exit code {result.returncode}.", flush=True)
        raise RuntimeError(f"{script} failed with exit code {result.returncode}")


def run_probe(label, command):
    print("", flush=True)
    print(label, flush=True)
    return subprocess.run(
        command,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    ).returncode


def dataset_dir():
    return Path(os.getenv("SURYA_DATASET_DIR", str(SCRIPT_DIR / "surya_bubble_dataset")))


def output_dir():
    return Path(os.getenv("SURYA_OUTPUT_DIR", str(SCRIPT_DIR / "outputs_surya_bubble_ocr")))


def final_model_dir():
    return output_dir() / "final_merged"


def dataset_is_ready(path: Path):
    return all((path / split / "metadata.jsonl").exists() for split in ("train", "val", "test"))


def final_model_is_ready(path: Path):
    return (path / "config.json").exists()


def assert_writable_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)
    probe = path / ".poneglyph_write_test"
    probe.write_text("ok", encoding="utf-8")
    probe.unlink(missing_ok=True)


def print_env_presence():
    keys = [
        "TRAINING_PROVIDER",
        "TRAINING_JOB_ID",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "HF_TOKEN",
        "HF_REPO",
        "SURYA_REQUIRE_UPLOAD",
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
        if key in {"SURYA_REQUIRE_UPLOAD", "RUNPOD_TERMINATE_ON_EXIT"} and value:
            status = value
        print(f"  {key}: {status}", flush=True)


def check_supabase_access():
    from supabase import create_client

    client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    response = (
        client.table("bulles")
        .select("id, x, y, w, h, texte_propose, id_page, pages(url_image)")
        .eq("statut", "Validé")
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
    print(f"Surya bubble OCR dry run on provider: {training_provider()}.", flush=True)
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
        "Running Surya API smoke check...",
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
    print("Dry run passed. Launch without --dry-run to export, train, benchmark, and upload.", flush=True)
    return 0


def write_pipeline_summary(status: str, error_message: str | None = None):
    summary = standard_pipeline_summary(
        status=status,
        training_kind="surya_bubble_ocr",
        provider=training_provider(),
        dataset_dir=dataset_dir(),
        output_dir=output_dir(),
        final_model_dir=final_model_dir(),
        benchmark_path=final_model_dir() / "benchmark_test.json",
        hf_repo=hf_repo_id(),
        error_message=error_message,
    )
    summary.update({
        "status": status,
        "dataset_dir": str(dataset_dir()),
        "output_dir": str(output_dir()),
        "final_model_dir": str(final_model_dir()),
        "benchmark_path": str(final_model_dir() / "benchmark_test.json"),
        "hf_repo": hf_repo_id(),
    })
    summary_path = output_dir() / "pipeline_summary.json"
    write_json(summary_path, summary)
    print(f"Pipeline summary saved to {summary_path}", flush=True)
    return summary


def maybe_upload_to_hf():
    if env_bool("SURYA_SKIP_UPLOAD", False):
        print("Skipping Hugging Face upload because SURYA_SKIP_UPLOAD=1.", flush=True)
        return

    token = os.getenv("HF_TOKEN")
    repo_id = hf_repo_id()
    if not token:
        message = "HF_TOKEN missing; skipping optional Hugging Face upload."
        if env_bool("SURYA_REQUIRE_UPLOAD", False):
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
        commit_message="Upload Surya bubble OCR fine-tuned model",
    )
    print("Hugging Face upload complete.", flush=True)


def hf_repo_id():
    return os.getenv("HF_REPO", DEFAULT_HF_REPO)


def main():
    args = parse_args()
    if args.dry_run or env_bool("SURYA_DRY_RUN", False):
        sys.exit(dry_run(check_remote=args.check_remote or env_bool("SURYA_DRY_RUN_CHECK_REMOTE", False)))

    hooks = provider_from_env(job_id=training_job_id(), kind="surya_bubble_ocr")
    try:
        required_env()
        hooks.on_start(
            status="running",
            hf_repo=hf_repo_id(),
            modal_volume_name=os.getenv("PONEGLYPH_MODAL_VOLUME_NAME"),
            runpod_pod_id=os.getenv("RUNPOD_POD_ID"),
        )
        print(f"Starting Surya bubble OCR pipeline on provider: {training_provider()}.", flush=True)
        print(f"Dataset directory: {dataset_dir()}", flush=True)
        print(f"Output directory:  {output_dir()}", flush=True)

        if dataset_is_ready(dataset_dir()) and not env_bool("SURYA_FORCE_EXPORT", False):
            print("Dataset already exists. Skipping export.", flush=True)
        else:
            hooks.set_status("preparing_dataset")
            run_step("Step 1: exporting Supabase bubble dataset", "export_dataset.py")
            hooks.set_status("dataset_ready")

        model_ready = final_model_is_ready(final_model_dir())
        benchmark_ready = (final_model_dir() / "benchmark_test.json").exists()
        hooks.set_status("running")
        if model_ready and benchmark_ready and not env_bool("SURYA_FORCE_TRAIN", False):
            print("Final model and benchmark already exist. Skipping training.", flush=True)
        elif model_ready and not env_bool("SURYA_FORCE_TRAIN", False):
            print("Final model exists but benchmark is missing.", flush=True)
            hooks.set_status("benchmarking")
            run_step(
                "Step 2: benchmarking existing final model",
                "train_surya_bubble_ocr.py",
                "--benchmark-only",
            )
        else:
            run_step("Step 2: fine-tuning Surya OCR 2", "train_surya_bubble_ocr.py")

        hooks.set_status("uploading")
        maybe_upload_to_hf()
    except Exception as exc:
        print(f"Surya bubble OCR pipeline failed: {exc}", flush=True)
        write_pipeline_summary("failed", error_message=str(exc))
        hooks.on_error(str(exc))
        sys.exit(1)

    summary = write_pipeline_summary("complete")
    print("Surya bubble OCR pipeline complete.", flush=True)
    hooks.on_complete(summary)


if __name__ == "__main__":
    main()
