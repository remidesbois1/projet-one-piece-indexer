import argparse
import base64
import os
import statistics
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import local_ocr_server as server  # noqa: E402


def percentile(values, percent):
    if not values:
        return 0.0
    sorted_values = sorted(values)
    index = (len(sorted_values) - 1) * (percent / 100.0)
    lower = int(index)
    upper = min(lower + 1, len(sorted_values) - 1)
    if lower == upper:
        return sorted_values[lower]
    weight = index - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def run_benchmark(client, endpoint, image_payload, backend, runs):
    if backend:
        os.environ["PONEGLYPH_INFERENCE_BACKEND"] = backend

    timings = []
    last_response = None
    for run_index in range(runs):
        started_at = time.perf_counter()
        response = client.post(endpoint, json={"image_bytes_base64": image_payload})
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        if response.status_code >= 400:
            raise RuntimeError(f"{backend or 'current'} run {run_index + 1} failed: {response.text}")
        timings.append(elapsed_ms)
        last_response = response.json()

    active_backend = last_response.get("active_backend")
    device = last_response.get("device")
    dtype = last_response.get("dtype")
    print(
        f"{backend or 'current'}: runs={runs} "
        f"mean={statistics.mean(timings):.1f}ms "
        f"p50={statistics.median(timings):.1f}ms "
        f"p95={percentile(timings, 95):.1f}ms "
        f"active_backend={active_backend} device={device} dtype={dtype}"
    )


def parse_args():
    parser = argparse.ArgumentParser(description="Benchmark the local Poneglyph OCR FastAPI app.")
    parser.add_argument("--image", required=True, help="Path to a local image.")
    parser.add_argument("--endpoint", default="/ocr/text", choices=["/ocr", "/ocr/text"])
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--backend", choices=["transformers", "vllm", "auto"])
    parser.add_argument(
        "--compare",
        action="store_true",
        help="Run transformers then vLLM in the same process.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    image_path = Path(args.image)
    if not image_path.exists():
        raise SystemExit(f"Image not found: {image_path}")
    if args.runs < 1:
        raise SystemExit("--runs must be >= 1")

    image_payload = base64.b64encode(image_path.read_bytes()).decode("ascii")
    client = TestClient(server.app)

    backends = ["transformers", "vllm"] if args.compare else [args.backend]
    for backend in backends:
        run_benchmark(client, args.endpoint, image_payload, backend, args.runs)


if __name__ == "__main__":
    main()
