"""Shared prompt loading for Python training and inference scripts."""

import json
import os
from pathlib import Path


PROMPT_FILE_ENV = "PONEGLYPH_PROMPTS_FILE"


def _prompt_file() -> Path:
    configured = os.getenv(PROMPT_FILE_ENV)
    candidates = []
    if configured:
        candidates.append(Path(configured))

    here = Path(__file__).resolve()
    candidates.extend(
        (
            here.parents[2] / "packages" / "shared" / "src" / "llm-prompts.json",
            here.parents[1] / "packages" / "shared" / "src" / "llm-prompts.json",
        )
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("Shared LLM prompt registry not found")


def get_prompt(key: str, *env_names: str) -> str:
    """Return an environment override or the shared JSON prompt."""

    for env_name in env_names:
        value = os.getenv(env_name)
        if value and value.strip():
            return value.strip()

    with _prompt_file().open("r", encoding="utf-8") as stream:
        prompts = json.load(stream)
    for prompt in prompts:
        if prompt.get("key") == key:
            content = str(prompt.get("content", "")).strip()
            if content:
                return content
    raise KeyError(f"Unknown shared prompt: {key}")
