import argparse
import json
import os
import time
from pathlib import Path

import torch

from train_surya_bubble_ocr import (
    MODEL_ID,
    OUTPUT_DIR,
    TRAIN_FILE,
    SuryaBubbleCollator,
    SuryaOCRTrainer,
    configure_generation,
    configure_processor,
    configure_torch_runtime,
    configure_trainable_model,
    load_model,
    prepare_dataset,
    validate_training_runtime,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Measure one real Surya OCR training step on the local GPU."
    )
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument(
        "--sample-mode",
        choices=("median", "p95", "worst"),
        default="worst",
        help="Select a length-grouped batch representative of the requested cost slice.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_DIR / "rtx3090_training_step_benchmark.json",
    )
    return parser.parse_args()


def select_batch(dataset, batch_size, sample_mode):
    ordered = sorted(range(len(dataset)), key=lambda index: dataset[index]["length"])
    if sample_mode == "worst":
        selected = ordered[-batch_size:]
    else:
        quantile = 0.50 if sample_mode == "median" else 0.95
        center = min(round((len(ordered) - 1) * quantile), len(ordered) - 1)
        start = min(max(center - batch_size // 2, 0), len(ordered) - batch_size)
        selected = ordered[start : start + batch_size]
    return [dataset[index] for index in selected]


def move_to_device(batch, device):
    return {
        key: value.to(device, non_blocking=True) if torch.is_tensor(value) else value
        for key, value in batch.items()
    }


def gib(value):
    return round(value / (1024**3), 3)


def main():
    args = parse_args()
    if args.batch_size <= 0 or args.steps < 2:
        raise ValueError("--batch-size must be positive and --steps must be at least 2.")

    os.environ["SURYA_TRAIN_BATCH"] = str(args.batch_size)
    configure_torch_runtime()
    runtime = validate_training_runtime(require_fast_path=True)
    processor = configure_processor(MODEL_ID)
    dataset = prepare_dataset(TRAIN_FILE, "train", processor)
    examples = select_batch(dataset, args.batch_size, args.sample_mode)
    collator = SuryaBubbleCollator(processor, training=True)
    batch = move_to_device(collator(examples), "cuda")

    model = load_model(MODEL_ID)
    configure_generation(model, processor)
    model, train_mode = configure_trainable_model(model)
    model.config.use_cache = False
    model.train()

    trainable_parameters = [
        parameter for parameter in model.parameters() if parameter.requires_grad
    ]
    optimizer = torch.optim.AdamW(
        trainable_parameters,
        lr=float(os.getenv("SURYA_LR", "1.2e-5")),
        weight_decay=float(os.getenv("SURYA_WEIGHT_DECAY", "0.05")),
        fused=True,
    )

    measurements = []
    for step in range(args.steps):
        optimizer.zero_grad(set_to_none=True)
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            loss = SuryaOCRTrainer.compute_loss(None, model, batch)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(
            trainable_parameters,
            float(os.getenv("SURYA_MAX_GRAD_NORM", "1.0")),
        )
        optimizer.step()
        torch.cuda.synchronize()
        measurements.append(
            {
                "step": step + 1,
                "seconds": round(time.perf_counter() - started, 4),
                "loss": round(float(loss.detach().cpu()), 6),
                "max_memory_allocated_gib": gib(torch.cuda.max_memory_allocated()),
                "max_memory_reserved_gib": gib(torch.cuda.max_memory_reserved()),
            }
        )
        print(json.dumps(measurements[-1]), flush=True)

    payload = {
        "runtime": runtime,
        "model_id": MODEL_ID,
        "train_mode": train_mode,
        "batch_size": args.batch_size,
        "sample_mode": args.sample_mode,
        "sequence_shape": list(batch["input_ids"].shape),
        "supervised_tokens": batch["labels"].ne(-100).sum(dim=1).tolist(),
        "trainable_parameters": sum(
            parameter.numel() for parameter in trainable_parameters
        ),
        "measurements": measurements,
        "steady_state": measurements[-1],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Benchmark saved to {args.output}", flush=True)


if __name__ == "__main__":
    main()
