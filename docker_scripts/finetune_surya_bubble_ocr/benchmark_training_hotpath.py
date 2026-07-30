import argparse
import json
import statistics
import time
from pathlib import Path

import torch
from PIL import Image

from train_surya_bubble_ocr import (
    MODEL_ID,
    SuryaBubbleCollator,
    apply_template,
    configure_processor,
    messages_for_entry,
    prepare_dataset,
    resolve_image_path,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Compare the former multi-pass Surya collator with the optimized one."
    )
    parser.add_argument(
        "--metadata",
        type=Path,
        required=True,
        help="Path to a train/val/test metadata.jsonl file.",
    )
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def legacy_process(features, processor):
    full_texts = []
    prompt_texts = []
    images = []
    for feature in features:
        image_path = resolve_image_path(feature, feature.get("split"))
        if image_path is None:
            raise FileNotFoundError(feature.get("image_file"))
        with Image.open(image_path) as image_file:
            image = image_file.convert("RGB")
        full_texts.append(
            apply_template(
                processor,
                messages_for_entry(image_path, str(feature.get("text") or "")),
                add_generation_prompt=False,
            )
        )
        prompt_texts.append(
            apply_template(
                processor,
                messages_for_entry(image_path, None),
                add_generation_prompt=True,
            )
        )
        images.append(image)

    output = processor(
        text=full_texts,
        images=images,
        padding=True,
        return_tensors="pt",
    )
    labels = output["input_ids"].clone()
    for index, (full_text, prompt_text, image) in enumerate(
        zip(full_texts, prompt_texts, images)
    ):
        prompt_length = processor(
            text=[prompt_text],
            images=[image],
            return_tensors="pt",
        )["input_ids"].shape[1]
        full_length = processor(
            text=[full_text],
            images=[image],
            return_tensors="pt",
        )["input_ids"].shape[1]
        assistant_length = full_length - prompt_length
        labels[index, : labels.shape[1] - assistant_length] = -100
        labels[index, output["input_ids"][index] == processor.tokenizer.pad_token_id] = -100
    output["labels"] = labels
    return output


def timed(function, repeats):
    durations = []
    output = None
    for _ in range(repeats):
        started = time.perf_counter()
        output = function()
        durations.append(time.perf_counter() - started)
    return durations, output


def supervised_tokens(labels):
    return [
        [int(token) for token in row[row.ne(-100)]]
        for row in labels
    ]


def main():
    args = parse_args()
    processor = configure_processor(args.model_id)
    split_name = args.metadata.parent.name
    dataset = prepare_dataset(args.metadata, split_name)
    batch_size = min(max(args.batch_size, 1), len(dataset))
    features = [dataset[index] for index in range(batch_size)]
    optimized_collator = SuryaBubbleCollator(processor, training=False)

    legacy_process(features[:1], processor)
    optimized_collator(features[:1])
    legacy_times, legacy_output = timed(
        lambda: legacy_process(features, processor),
        args.repeats,
    )
    optimized_times, optimized_output = timed(
        lambda: optimized_collator(features),
        args.repeats,
    )
    legacy_median = statistics.median(legacy_times)
    optimized_median = statistics.median(optimized_times)
    report = {
        "model_id": args.model_id,
        "metadata": str(args.metadata.resolve()),
        "batch_size": batch_size,
        "repeats": args.repeats,
        "legacy_seconds": legacy_times,
        "optimized_seconds": optimized_times,
        "legacy_median_seconds": legacy_median,
        "optimized_median_seconds": optimized_median,
        "speedup": legacy_median / optimized_median,
        "supervised_tokens_exact_match": (
            supervised_tokens(legacy_output["labels"])
            == supervised_tokens(optimized_output["labels"])
        ),
        "torch": torch.__version__,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered, flush=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
