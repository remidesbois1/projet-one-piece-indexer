import json
import math
import os
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_OUTPUT = Path(
    os.getenv("LIGHTON_OUTPUT_DIR", str(SCRIPT_DIR / "outputs_lighton_manga"))
)
STEPS = int(os.getenv("LIGHTON_PROFILE_STEPS", "200"))


def run_profile(name, overrides):
    output_dir = ROOT_OUTPUT / f"profile_{name}"
    env = {
        **os.environ,
        "LIGHTON_OUTPUT_DIR": str(output_dir),
        "LIGHTON_MAX_STEPS": str(STEPS),
        "LIGHTON_PROFILE_ONLY": "1",
        "LIGHTON_HARD_EXAMPLE_SFT": "0",
        **overrides,
    }
    print(f"Running {name} profile for {STEPS} optimizer steps...", flush=True)
    subprocess.run(
        [sys.executable, "-u", str(SCRIPT_DIR / "train_lighton_ocr.py")],
        cwd=SCRIPT_DIR,
        env=env,
        check=True,
    )
    with open(output_dir / "3090_profile.json", "r", encoding="utf-8") as handle:
        return json.load(handle)


def main():
    legacy = run_profile(
        "legacy",
        {
            "LIGHTON_AUTO_BATCH": "0",
            "LIGHTON_TRAIN_BATCH": "8",
            "LIGHTON_EFFECTIVE_BATCH": "16",
            "LIGHTON_GRADIENT_CHECKPOINTING": "1",
            "LIGHTON_IMAGE_LONGEST_EDGE": "1540",
            "LIGHTON_LORA_R": "65",
            "LIGHTON_LORA_ALPHA": "130",
            "LIGHTON_LORA_DROPOUT": "0.01",
            "LIGHTON_USE_DORA": "1",
            "LIGHTON_USE_RSLORA": "0",
            "LIGHTON_LORA_LM_HEAD": "1",
        },
    )
    optimized = run_profile(
        "optimized",
        {
            "LIGHTON_AUTO_BATCH": "1",
            "LIGHTON_IMAGE_LONGEST_EDGE": "700",
            "LIGHTON_LORA_R": "64",
            "LIGHTON_LORA_ALPHA": "128",
            "LIGHTON_LORA_DROPOUT": "0",
            "LIGHTON_USE_DORA": "0",
            "LIGHTON_USE_RSLORA": "1",
            "LIGHTON_LORA_LM_HEAD": "0",
        },
    )
    legacy_seconds = legacy.get("main_sft_seconds")
    optimized_seconds = optimized.get("main_sft_seconds")
    train_samples = int(legacy.get("train_samples") or optimized.get("train_samples") or 0)
    legacy_profile_steps = int(legacy.get("main_sft_steps") or STEPS)
    legacy_total_steps = math.ceil(train_samples / 16) * 8 if train_samples else None
    legacy_estimated_full_seconds = (
        legacy_seconds / legacy_profile_steps * legacy_total_steps
        if legacy_seconds and legacy_profile_steps and legacy_total_steps
        else None
    )
    comparison = {
        "steps": STEPS,
        "legacy": legacy,
        "optimized": optimized,
        "speedup": (
            legacy_seconds / optimized_seconds
            if legacy_seconds and optimized_seconds
            else None
        ),
        "legacy_estimated_full_steps": legacy_total_steps,
        "legacy_estimated_full_seconds": legacy_estimated_full_seconds,
    }
    ROOT_OUTPUT.mkdir(parents=True, exist_ok=True)
    path = ROOT_OUTPUT / "3090_comparison.json"
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(comparison, handle, ensure_ascii=False, indent=2)
    print(f"Comparison saved to {path}", flush=True)


if __name__ == "__main__":
    main()
