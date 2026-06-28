import argparse
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from PIL import Image
from transformers import AutoProcessor
from transformers.models.pp_ocrv6_small_rec.modeling_pp_ocrv6_small_rec import (
    PPOCRV6SmallRecForTextRecognition,
)


class PPOCRV6RecOnnxWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, pixel_values):
        return self.model(pixel_values=pixel_values).last_hidden_state


def decode_ctc(probs, character_list):
    ids = np.asarray(probs).argmax(axis=-1).reshape(-1).tolist()
    chars = []
    previous = None
    for idx in ids:
        if idx != 0 and idx != previous and idx < len(character_list):
            chars.append(character_list[idx])
        previous = idx
    return "".join(chars)


def load_sample_images(paths, limit):
    samples = []
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_dir():
            for candidate in sorted(path.glob("*.png"))[:limit]:
                samples.append(candidate)
        elif path.exists():
            samples.append(path)
        if len(samples) >= limit:
            break
    return samples[:limit]


def export_model(args):
    model_dir = Path(args.model_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    onnx_path = output_dir / args.onnx_name
    manifest_path = output_dir / "browser_manifest.json"

    processor = AutoProcessor.from_pretrained(model_dir)
    processor.size = {"height": args.image_height, "width": args.image_width}
    processor.pad_size = {"height": args.image_height, "width": args.image_width}

    model = PPOCRV6SmallRecForTextRecognition.from_pretrained(model_dir)
    model.eval()
    wrapper = PPOCRV6RecOnnxWrapper(model).eval()

    dummy = torch.zeros(1, 3, args.image_height, args.image_width, dtype=torch.float32)
    torch.onnx.export(
        wrapper,
        (dummy,),
        onnx_path,
        input_names=["pixel_values"],
        output_names=["logits"],
        dynamic_axes={
            "pixel_values": {0: "batch", 3: "width"},
            "logits": {0: "batch", 1: "sequence"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
    )

    onnx_model = onnx.load(onnx_path)
    onnx.checker.check_model(onnx_model)

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

    parity = []
    sample_images = load_sample_images(args.sample_image, args.max_samples)
    with torch.no_grad():
        for image_path in sample_images:
            image = Image.open(image_path).convert("RGB")
            inputs = processor(images=[image], return_tensors="pt")
            pixel_values = inputs["pixel_values"].float()
            torch_out = wrapper(pixel_values).detach().cpu().numpy()
            ort_out = session.run(["logits"], {"pixel_values": pixel_values.cpu().numpy()})[0]
            abs_diff = np.abs(torch_out - ort_out)
            parity.append(
                {
                    "image": str(image_path),
                    "max_abs_diff": float(abs_diff.max()),
                    "mean_abs_diff": float(abs_diff.mean()),
                    "torch_text": decode_ctc(torch_out[0], processor.character_list),
                    "onnx_text": decode_ctc(ort_out[0], processor.character_list),
                    "match": decode_ctc(torch_out[0], processor.character_list)
                    == decode_ctc(ort_out[0], processor.character_list),
                }
            )

    (output_dir / "preprocessor_config.json").write_text(
        (model_dir / "preprocessor_config.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (output_dir / "config.json").write_text(
        (model_dir / "config.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )

    manifest = {
        "name": "ppocrv6-one-piece-bubble-line-rec-onnx",
        "base_model": "PaddlePaddle/PP-OCRv6_medium_rec_safetensors",
        "source_model": "Remidesbois/pp-ocrv6-one-piece-bubble-line-rec",
        "recognizer_onnx": args.onnx_name,
        "input_name": "pixel_values",
        "output_name": "logits",
        "input_shape": [1, 3, args.image_height, args.image_width],
        "dynamic_width": True,
        "image_height": args.image_height,
        "min_image_width": args.image_width,
        "max_image_width": int(getattr(processor, "max_image_width", 3200)),
        "rescale_factor": 1.0 / 255.0,
        "image_mean": [0.5, 0.5, 0.5],
        "image_std": [0.5, 0.5, 0.5],
        "channel_order": "BGR",
        "resize": "height_48_preserve_aspect_then_pad_to_min_width",
        "blank_token_id": 0,
        "character_list": processor.character_list,
        "ctc_decode": "collapse_repeats_remove_blank",
        "parity": {
            "samples": len(parity),
            "all_text_match": all(item["match"] for item in parity),
            "max_abs_diff": max((item["max_abs_diff"] for item in parity), default=None),
            "mean_abs_diff": float(np.mean([item["mean_abs_diff"] for item in parity])) if parity else None,
            "items": parity,
        },
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "onnx": str(onnx_path),
        "manifest": str(manifest_path),
        "samples": len(parity),
        "all_text_match": manifest["parity"]["all_text_match"],
        "max_abs_diff": manifest["parity"]["max_abs_diff"],
    }, ensure_ascii=False, indent=2))


def parse_args():
    parser = argparse.ArgumentParser(description="Export the fine-tuned PP-OCRv6 recognizer to ONNX.")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--onnx-name", default="ppocrv6_bubble_line_rec.onnx")
    parser.add_argument("--image-height", type=int, default=48)
    parser.add_argument("--image-width", type=int, default=960)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--sample-image", action="append", default=[])
    parser.add_argument("--max-samples", type=int, default=8)
    return parser.parse_args()


if __name__ == "__main__":
    export_model(parse_args())
