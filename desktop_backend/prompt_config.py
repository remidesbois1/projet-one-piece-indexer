"""Shared prompt loading for the bundled local OCR backend."""

import json
import os
from pathlib import Path


def _prompt_file() -> Path:
    configured = os.getenv("PONEGLYPH_PROMPTS_FILE")
    candidates = []
    if configured:
        candidates.append(Path(configured))

    here = Path(__file__).resolve()
    candidates.extend(
        (
            here.parent / "llm-prompts.json",
            here.parent.parent / "packages" / "shared" / "src" / "llm-prompts.json",
        )
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("Shared LLM prompt registry not found")


def get_prompt(key: str, *env_names: str) -> str:
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
