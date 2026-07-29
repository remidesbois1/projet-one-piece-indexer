import argparse
import base64
import hashlib
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


def run_benchmark(client, endpoint, model_key, image_payload, runs):
    timings = []
    last_response = None
    for run_index in range(runs):
        started_at = time.perf_counter()
        response = client.post(
            endpoint,
            params={"model_key": model_key},
            json={"image_bytes_base64": image_payload},
        )
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        if response.status_code >= 400:
            raise RuntimeError(f"transformers run {run_index + 1} failed: {response.text}")
        timings.append(elapsed_ms)
        last_response = response.json()
        profile = last_response.get("generation_profile") or {}
        raw_text = last_response.get("raw_text") or last_response.get("text") or ""
        print(
            f"run {run_index + 1}: total={elapsed_ms:.1f}ms "
            f"server_generate={last_response.get('generate_ms')}ms "
            f"prefill={profile.get('prefill_ms')}ms "
            f"decode={profile.get('decode_ms')}ms "
            f"tokens={profile.get('generated_tokens')} "
            f"bubbles={len(last_response.get('bubbles') or [])} "
            f"sha256={hashlib.sha256(raw_text.encode('utf-8')).hexdigest()[:12]} "
            f"engine={last_response.get('generation_engine')}"
        )

    active_backend = last_response.get("active_backend")
    device = last_response.get("device")
    dtype = last_response.get("dtype")
    print(
        f"transformers: runs={runs} "
        f"mean={statistics.mean(timings):.1f}ms "
        f"p50={statistics.median(timings):.1f}ms "
        f"p95={percentile(timings, 95):.1f}ms "
        f"active_backend={active_backend} device={device} dtype={dtype}"
    )


def parse_args():
    parser = argparse.ArgumentParser(description="Benchmark the local Poneglyph OCR FastAPI app.")
    parser.add_argument("--image", required=True, help="Path to a local image.")
    parser.add_argument("--endpoint", default="/ocr/text", choices=["/ocr", "/ocr/text"])
    parser.add_argument(
        "--model-key",
        choices=[
            server.BBOX_MODEL_KEY,
            server.TEXT_MODEL_KEY,
            server.SURYA_MODEL_KEY,
            server.SURYA_BBOX_MODEL_KEY,
        ],
    )
    parser.add_argument("--runs", type=int, default=5)
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

    model_key = args.model_key or (
        server.BBOX_MODEL_KEY if args.endpoint == "/ocr" else server.TEXT_MODEL_KEY
    )
    if args.endpoint == "/ocr":
        server.normalize_bbox_ocr_model_key(model_key)
    else:
        server.normalize_text_ocr_model_key(model_key)
    load_started = time.perf_counter()
    load_response = client.post(f"/model/load?model_key={model_key}")
    load_ms = (time.perf_counter() - load_started) * 1000
    if load_response.status_code >= 400:
        raise RuntimeError(f"model load failed: {load_response.text}")
    load_status = load_response.json()
    print(
        f"model load: {load_ms:.1f}ms "
        f"engine={load_status.get('generation_engine')} "
        f"warmups={load_status.get('warmup_timings_ms')} "
        f"fast_error={load_status.get('optimized_engine_error')}"
    )
    run_benchmark(client, args.endpoint, model_key, image_payload, args.runs)


if __name__ == "__main__":
    main()
