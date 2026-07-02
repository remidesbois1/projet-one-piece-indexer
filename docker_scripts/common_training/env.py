from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - local dry installs may omit python-dotenv.
    load_dotenv = None


VALID_TRAINING_PROVIDERS = {"local", "runpod", "modal"}


def load_training_dotenv(script_dir: Path) -> None:
    """Load package, docker_scripts, and project .env files when available."""
    if load_dotenv is None:
        return
    script_dir = Path(script_dir)
    docker_scripts_dir = script_dir.parent
    project_root = docker_scripts_dir.parent
    load_dotenv(script_dir / ".env")
    load_dotenv(docker_scripts_dir / ".env")
    load_dotenv(project_root / ".env")


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def training_provider() -> str:
    provider = os.getenv("TRAINING_PROVIDER", "local").strip().lower()
    if provider not in VALID_TRAINING_PROVIDERS:
        allowed = ", ".join(sorted(VALID_TRAINING_PROVIDERS))
        raise ValueError(f"TRAINING_PROVIDER must be one of: {allowed}")
    return provider


def training_job_id() -> str | None:
    value = os.getenv("TRAINING_JOB_ID") or os.getenv("PONEGLYPH_TRAINING_JOB_ID")
    value = (value or "").strip()
    return value or None

