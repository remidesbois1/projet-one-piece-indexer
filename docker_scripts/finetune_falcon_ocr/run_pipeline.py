"""Export → GPU preflight → select → test → refit all → report → Hub commit."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

from config import Config, same_training_identity
from data import export_dataset, write_json
from dotenv import load_dotenv
from filelock import FileLock
from report import create_artifacts, model_card
from rich.console import Console
from rich.panel import Panel

SCRIPT_DIR = Path(__file__).resolve().parent
console = Console()


def release_hashes(directory):
    hashes = {}
    for path in sorted(directory.rglob("*")):
        if path.is_file() and path.name != "release_ready.json":
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                    digest.update(chunk)
            hashes[path.relative_to(directory).as_posix()] = digest.hexdigest()
    return hashes


def publish(config):
    from huggingface_hub import HfApi

    release = config.output / "release"
    marker = json.loads((release / "release_ready.json").read_text(encoding="utf-8"))
    if not marker["complete"] or marker["hashes"] != release_hashes(release):
        raise RuntimeError("Release incomplete or modified; refusing upload")
    api = HfApi(token=os.environ["HF_TOKEN"])
    api.create_repo(config.repo_id, repo_type="model", exist_ok=True)
    # A single commit prevents a new README from advertising incomplete weights.
    result = api.upload_folder(
        repo_id=config.repo_id,
        repo_type="model",
        folder_path=str(release),
        commit_message="Falcon-OCR Poneglyph: trained weights and reproducible OCR analysis",
    )
    write_json(
        config.output / "upload_result.json",
        {"repo_id": config.repo_id, "commit_url": result.commit_url},
    )
    console.print(f"[bold green]Publié : {result.commit_url}[/]")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate configuration and credential presence only",
    )
    actions.add_argument("--export-only", action="store_true")
    actions.add_argument(
        "--smoke",
        action="store_true",
        help="Export + real GPU backward/parity/reload; no training/upload",
    )
    actions.add_argument(
        "--publish-only",
        action="store_true",
        help="Retry a completed, hash-verified publication",
    )
    args = parser.parse_args()
    for path in (
        SCRIPT_DIR / ".env",
        SCRIPT_DIR.parent / ".env",
        SCRIPT_DIR.parent.parent / ".env",
        SCRIPT_DIR.parent.parent / "backend" / ".env",
    ):
        load_dotenv(path, override=False)
    c = Config.from_env()
    console.print(
        Panel(
            "[bold]Falcon-OCR × Poneglyph[/]\nRTX 5090 · BF16 · full fine-tuning · validation CER · all-data refit",
            border_style="cyan",
        )
    )
    console.print_json(json.dumps(asdict(c)))
    missing = []
    if not args.publish_only and not (Path(c.dataset_dir) / "manifest.json").exists():
        missing += [
            key
            for key in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
            if not os.getenv(key)
        ]
    wants_upload = args.publish_only or (
        c.upload and not (args.export_only or args.smoke)
    )
    if wants_upload and not os.getenv("HF_TOKEN"):
        missing.append("HF_TOKEN")
    if missing:
        raise RuntimeError("Missing environment variables: " + ", ".join(missing))
    if args.dry_run:
        console.print(
            "Configuration OK. Aucun export, entraînement ou upload effectué."
        )
        return
    c.output.mkdir(parents=True, exist_ok=True)
    with FileLock(str(c.output / "pipeline.lock"), timeout=0):
        if args.publish_only:
            publish(c)
            return
        if wants_upload:
            from huggingface_hub import HfApi

            HfApi(token=os.environ["HF_TOKEN"]).whoami()  # fail early on invalid token
        dataset_path = Path(c.dataset_dir)
        dataset_path.mkdir(parents=True, exist_ok=True)
        with FileLock(str(dataset_path / ".export.lock"), timeout=0):
            splits, fingerprint, dataset_report = export_dataset(c)
        console.print(
            "Corpus: "
            + ", ".join(f"{key}={len(value)}" for key, value in splits.items())
        )
        if args.export_only:
            return
        identity_path = c.output / "run_identity.json"
        identity = {"fingerprint": fingerprint, "config": asdict(c)}
        for key in ("upload", "repo_id", "output_dir", "dataset_dir"):
            identity["config"].pop(key)
        if identity_path.exists() and not same_training_identity(
            json.loads(identity_path.read_text(encoding="utf-8")), identity
        ):
            raise RuntimeError("Run identity changed. Choose a new output directory.")
        write_json(identity_path, identity)
        if (c.output / "release" / "release_ready.json").exists() and not args.smoke:
            console.print(
                "Entraînement déjà terminé; réutilisation de la release vérifiée."
            )
            if c.upload:
                publish(c)
            return
        from train import run_training

        result = run_training(c, splits, fingerprint, smoke_only=args.smoke)
        if args.smoke:
            return
        release, summary, test, baseline, history = result
        create_artifacts(release, history, baseline, test, splits["test"])
        write_json(release / "run_config.json", asdict(c))
        write_json(release / "dataset_report.json", dataset_report)
        shutil.copy2(c.output / "calibration.json", release / "calibration.json")
        shutil.copy2(c.output / "smoke_report.json", release / "smoke_report.json")
        shutil.copy2(
            c.output / "selection_history.json", release / "selection_history.json"
        )
        for name in (
            "quality_gate.json",
            "benchmark_base_validation.json",
            "benchmark_validation.json",
            "refit_history.json",
        ):
            if (c.output / name).exists():
                shutil.copy2(c.output / name, release / name)
        # Include only an explicit source allowlist; never .env, caches, raw pages,
        # optimizer states or source storage URLs in the public artifact folder.
        code_dir = release / "training_code"
        code_dir.mkdir(exist_ok=True)
        for pattern in (
            "*.py",
            "*.ps1",
            "*.bat",
            "requirements.txt",
            "Dockerfile",
            ".dockerignore",
            "README.md",
            "THIRD_PARTY_NOTICES.md",
        ):
            for path in SCRIPT_DIR.glob(pattern):
                shutil.copy2(path, code_dir / path.name)
        for name in ("inference.py", "model.py", "config.py", "data.py"):
            shutil.copy2(SCRIPT_DIR / name, release / name)
        environment = subprocess.check_output(
            [sys.executable, "-m", "pip", "freeze"], text=True
        )
        (release / "environment.txt").write_text(environment, encoding="utf-8")
        model_card(c, summary, test, release)
        write_json(
            release / "release_ready.json",
            {"complete": True, "hashes": release_hashes(release)},
        )
        console.print(f"[bold green]Release complète : {release}[/]")
        if c.upload:
            publish(c)


if __name__ == "__main__":
    main()
