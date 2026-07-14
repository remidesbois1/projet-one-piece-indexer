"""Compare the legacy bbox path with the RTX 5090 optimized path."""

import json
import os
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_OUTPUT = Path(
    os.getenv("LIGHTON_BBOX_OUTPUT_DIR", SCRIPT_DIR / "outputs_lighton_bbox")
)
STEPS = int(os.getenv("LIGHTON_PROFILE_STEPS", "200"))


def run_profile(name, overrides):
    output_dir = ROOT_OUTPUT / f"profile_5090_{name}"
    profile_filename = f"5090_{name}_profile.json"
    env = {
        **os.environ,
        "LIGHTON_HARDWARE_PROFILE": "rtx5090",
        "LIGHTON_BBOX_OUTPUT_DIR": str(output_dir),
        "LIGHTON_PROFILE_FILENAME": profile_filename,
        "LIGHTON_MAX_STEPS": str(STEPS),
        "LIGHTON_PROFILE_ONLY": "1",
        "LIGHTON_HARD_EXAMPLE_SFT": "0",
        **overrides,
    }
    subprocess.run(
        [sys.executable, "-u", str(SCRIPT_DIR / "train_lighton_bbox.py")],
        cwd=SCRIPT_DIR,
        env=env,
        check=True,
    )
    return json.loads((output_dir / profile_filename).read_text(encoding="utf-8"))


def main():
    legacy = run_profile(
        "legacy",
        {
            "LIGHTON_AUTO_BATCH": "0",
            "LIGHTON_TRAIN_BATCH": "1",
            "LIGHTON_EFFECTIVE_BATCH": "8",
            "LIGHTON_GRADIENT_CHECKPOINTING": "1",
            "LIGHTON_BBOX_SELECTIVE_LOGITS": "0",
            "LIGHTON_LORA_DROPOUT": "0.01",
            "LIGHTON_USE_DORA": "1",
            "LIGHTON_USE_RSLORA": "0",
            "LIGHTON_LORA_LM_HEAD": "1",
            "LIGHTON_GROUP_BY_LENGTH": "0",
        },
    )
    optimized = run_profile(
        "optimized",
        {
            "LIGHTON_AUTO_BATCH": "1",
            "LIGHTON_EFFECTIVE_BATCH": "8",
            "LIGHTON_CALIBRATION_REQUIRE_CHECKPOINTING": "0",
            "LIGHTON_BBOX_SELECTIVE_LOGITS": "1",
            "LIGHTON_USE_DORA": "0",
            "LIGHTON_USE_RSLORA": "1",
            "LIGHTON_LORA_LM_HEAD": "0",
            "LIGHTON_LORA_DROPOUT": "0",
            "LIGHTON_GROUP_BY_LENGTH": "1",
        },
    )
    legacy_seconds = legacy.get("main_sft_seconds")
    optimized_seconds = optimized.get("main_sft_seconds")
    comparison = {
        "gpu_profile": "rtx5090",
        "steps": STEPS,
        "image_longest_edge": 1500,
        "legacy": legacy,
        "optimized": optimized,
        "speedup": (
            legacy_seconds / optimized_seconds
            if legacy_seconds and optimized_seconds
            else None
        ),
    }
    ROOT_OUTPUT.mkdir(parents=True, exist_ok=True)
    path = ROOT_OUTPUT / "5090_comparison.json"
    path.write_text(json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"RTX 5090 comparison saved to {path}", flush=True)


if __name__ == "__main__":
    main()
