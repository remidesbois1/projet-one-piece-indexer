import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    output_dir = Path("/tmp/ppocr_line_smoke")
    if output_dir.exists():
        subprocess.run(["rm", "-rf", str(output_dir)], check=False)

    command = [
        sys.executable,
        "run_pipeline.py",
        "--source-mode",
        "source_dir",
        "--limit",
        "8",
        "--output-dir",
        str(output_dir),
        "--dry-run-train",
        "--allow-training-blocked",
    ]
    result = subprocess.run(command)
    if result.returncode != 0:
        return result.returncode

    stats_path = output_dir / "bubble_single_line_rec_dataset" / "dataset_stats.json"
    if not stats_path.exists():
        print(f"Missing smoke stats: {stats_path}", flush=True)
        return 1
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    if stats.get("single_line_images", 0) <= 0:
        print(f"Smoke export produced no stitched bubble images: {stats}", flush=True)
        return 1
    print(f"SMOKE_OK single_line_images={stats['single_line_images']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
