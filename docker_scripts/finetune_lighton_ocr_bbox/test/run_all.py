import os
import sys
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def run_step(label, script):
    print(f"\n{'=' * 70}")
    print(f"  {label}")
    print(f"{'=' * 70}")
    result = subprocess.run(
        [sys.executable, "-u", str(SCRIPT_DIR / script)],
        cwd=str(SCRIPT_DIR),
    )
    if result.returncode != 0:
        print(f"FAILED: {script}")
        sys.exit(1)


if __name__ == "__main__":
    print("PONEGLYPH BBOX - FULL BENCHMARK PIPELINE")
    print("=" * 70)

    run_step("Step 1/3 - Downloading test dataset", "download_dataset.py")
    run_step("Step 2/3 - Running benchmark (base + fine-tuned)", "benchmark.py")
    run_step("Step 3/3 - Generating graphs", "generate_graphs.py")

    print(f"\n{'=' * 70}")
    print(f"  ALL DONE!")
    print(f"  Results: {SCRIPT_DIR / 'output' / 'metrics.json'}")
    print(f"  Graphs:  {SCRIPT_DIR / 'output' / 'graphs' / ''}")
    print(f"{'=' * 70}")
