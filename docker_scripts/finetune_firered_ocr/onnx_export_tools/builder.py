# Copyright (C)  [2026]  Advanced Micro Devices, Inc. All rights reserved. Portions of this file consist of AI generated content.
"""
Export Qwen3-VL ONNX models for native onnxruntime-genai pipeline.

This script keeps everything inside the onnxruntime-genai repo:
1) text decoder export via onnxruntime_genai.models.builder
2) vision encoder export
3) embedding merger export
4) genai_config wiring for multimodal processor() inference
"""

import argparse
import json
import os
from pathlib import Path

import torch
import torch.nn as nn
from transformers import AutoConfig, AutoProcessor
from transformers.dynamic_module_utils import get_class_from_dynamic_module

from onnxruntime_genai.models.builder import create_model


def prepare_model(input_dir, reference_dir):
    """Load HF model/processor from local path."""
    print("\n[1/4] Preparing model...")
    config = AutoConfig.from_pretrained(input_dir, trust_remote_code=True)
    processor = AutoProcessor.from_pretrained(input_dir, trust_remote_code=True)

    Qwen3VLForConditionalGeneration = get_class_from_dynamic_module(
        "modeling_qwen3_vl.Qwen3VLForConditionalGeneration",
        reference_dir,
    )

    model = Qwen3VLForConditionalGeneration.from_pretrained(
        input_dir,
        torch_dtype=torch.float32,
        trust_remote_code=True,
        attn_implementation="eager",
    ).to("cpu")
    model.eval()

    print("  [OK] Model loaded")
    return config, processor, model


def export_vision_model(model, output_dir):
    """Export vision encoder."""
    print("\n[2/4] Exporting vision encoder...")
    
    class VisionWrapper(nn.Module):
        def __init__(self, visual_model):
            super().__init__()
            self.visual_model = visual_model

        def forward(self, pixel_values, image_grid_thw):
            # Keep image_grid_thw as a true dynamic runtime input.
            outputs = self.visual_model(pixel_values, grid_thw=image_grid_thw, return_dict=True)
            if hasattr(outputs, "pooler_output"):
                return outputs.pooler_output
            if isinstance(outputs, dict):
                return outputs["pooler_output"]
            # HF returns tuple where first entry is pooled tensor.
            return outputs[0]

    wrapper = VisionWrapper(model.model.visual)

    # Export with a representative single image grid; runtime grid_thw remains dynamic.
    num_patches = 576
    patch_dim = 1536
    pixel_values = torch.randn(num_patches, patch_dim)
    image_grid_thw = torch.tensor([[1, 24, 24]], dtype=torch.int64)

    output_path = os.path.join(output_dir, "qwen3vl-vision.onnx")

    torch.onnx.export(
        wrapper,
        (pixel_values, image_grid_thw),
        output_path,
        input_names=["pixel_values", "image_grid_thw"],
        output_names=["pooled_embeds"],
        dynamic_axes={
            "pixel_values": {0: "num_patches"},
            "image_grid_thw": {0: "num_images"},  # preserved for runtime input contract
            "pooled_embeds": {0: "sequence"}
        },
        opset_version=18
    )
    
    print(f"  [OK] Vision model: {output_path}")


def export_embedding_model(model, output_dir):
    """Export embedding model."""
    print("\n[3/4] Exporting embedding model...")
    
    class EmbeddingWrapper(nn.Module):
        def __init__(self, embed_tokens, image_token_id):
            super().__init__()
            self.embed_tokens = embed_tokens
            self.image_token_id = image_token_id
        
        def forward(self, input_ids, vision_hidden_states):
            inputs_embeds = self.embed_tokens(input_ids)

            B, N, C = inputs_embeds.shape
            inputs_embeds = inputs_embeds.reshape(B * N, C)

            # Replace <|image_pad|> token positions with vision features.
            # This must match the runtime prompt expansion in Qwen3VLImageProcessor.
            vision_mask = (input_ids.view(-1) == self.image_token_id).unsqueeze(-1).expand(-1, C)
            inputs_embeds = inputs_embeds.masked_scatter(vision_mask, vision_hidden_states.reshape(-1))

            inputs_embeds = inputs_embeds.reshape(B, N, C)
            return inputs_embeds

    image_token_id = getattr(model.config, "image_token_id", 151655)
    wrapper = EmbeddingWrapper(model.model.language_model.embed_tokens, image_token_id)

    input_ids = torch.randint(0, 1000, (1, 200), dtype=torch.long)
    input_ids[0, 20:164] = image_token_id
    hidden_size = model.model.language_model.embed_tokens.embedding_dim
    vision_hidden_states = torch.randn(144, hidden_size)

    output_path = os.path.join(output_dir, "qwen3vl-embedding.onnx")

    torch.onnx.export(
        wrapper,
        (input_ids, vision_hidden_states),
        output_path,
        input_names=["input_ids", "vision_hidden_states"],
        output_names=["inputs_embeds"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "vision_hidden_states": {0: "vision_sequence"},
            "inputs_embeds": {0: "batch", 1: "sequence"}
        },
        opset_version=18
    )
    
    print(f"  [OK] Embedding model: {output_path}")


def export_text_model(input_dir, output_dir, precision="int4"):
    """Export text decoder using OGA builder."""
    print(f"\n[4/4] Exporting text decoder ({precision.upper()})...")
    
    config_path = os.path.join(input_dir, "config.json")
    with open(config_path, "r", encoding="utf-8") as f:
        orig_config = json.load(f)
        
    patched_config = orig_config.copy()
    if "text_config" in patched_config:
        for k, v in patched_config["text_config"].items():
            if k not in patched_config or patched_config[k] is None:
                patched_config[k] = v
        patched_config.pop("text_config", None)
    patched_config.pop("vision_config", None)
    patched_config["architectures"] = ["Qwen3ForCausalLM"]
    patched_config["model_type"] = "qwen3"
    
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(patched_config, f, indent=2)
        
    try:
        create_model("qwen3-vl", input_dir, output_dir, precision, "cpu", os.path.join(output_dir, ".cache"), exclude_embeds=True)
    finally:
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(orig_config, f, indent=2)
    
    print(f"  [OK] Text model: {os.path.join(output_dir, 'model.onnx')}")


def create_vision_processor_config(output_dir):
    """Create vision_processor.json with always-dynamic image preprocessing."""
    transforms = [
        {
            "operation": {
                "name": "decode_image",
                "type": "DecodeImage",
                "attrs": {
                    "color_space": "RGB"
                }
            }
        }
    ]
    transforms.extend(
        [
            {
                "operation": {
                    "name": "rescale",
                    "type": "Rescale"
                }
            },
            {
                "operation": {
                    "name": "normalize",
                    "type": "Normalize",
                    "attrs": {
                        # Match qwen3 preprocessor_config defaults.
                        "mean": [0.5, 0.5, 0.5],
                        "std": [0.5, 0.5, 0.5]
                    }
                }
            }
        ]
    )
    config = {
        "processor": {
            "name": "qwen3_vl_vision_processor",
            "transforms": transforms
        }
    }

    config_path = os.path.join(output_dir, "vision_processor.json")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

    print(f"  [OK] Created: vision_processor.json")


def update_genai_config(output_dir):
    """Update genai_config.json with vision and embedding sections."""
    config_path = os.path.join(output_dir, "genai_config.json")
    
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    config["model"]["type"] = "qwen3_vl"

    config["model"]["vision"] = {
        "filename": "qwen3vl-vision.onnx",
        "config_filename": "vision_processor.json",
        "inputs": {
            "pixel_values": "pixel_values",
            "image_grid_thw": "image_grid_thw"
        },
        "outputs": {
            "image_features": "pooled_embeds"
        },
        "spatial_merge_size": 2
    }

    config["model"]["embedding"] = {
        "filename": "qwen3vl-embedding.onnx",
        "inputs": {
            "input_ids": "input_ids",
            "image_features": "vision_hidden_states"
        },
        "outputs": {
            "inputs_embeds": "inputs_embeds"
        }
    }

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

    print(f"  [OK] Updated: genai_config.json")


def run_e2e_smoke(output_dir, prompt):
    """Optional quick in-process smoke using processor() API."""
    from onnxruntime_genai import onnxruntime_genai as og

    print("\n[5/5] Running processor() text-only smoke...")
    config = og.Config(output_dir)
    config.clear_providers()
    config.append_provider("cpu")
    model = og.Model(config)
    processor = model.create_multimodal_processor()
    stream = processor.create_stream()

    chat_prompt = f"<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
    inputs = processor(chat_prompt)

    params = og.GeneratorParams(model)
    params.set_search_options(max_length=256)
    generator = og.Generator(model, params)
    generator.set_inputs(inputs)
    print("Generated:", end=" ", flush=True)
    while not generator.is_done():
        generator.generate_next_token()
        token = generator.get_next_tokens()[0]
        print(stream.decode(token), end="", flush=True)
    print()


def main():
    parser = argparse.ArgumentParser(description="Export Qwen3-VL for OGA Integration")
    parser.add_argument(
        "--input",
        type=str,
        default="./pytorch",
        help="Input PyTorch model directory"
    )
    parser.add_argument(
        "--reference",
        type=str,
        default="./pytorch_reference",
        help="Directory containing local export-patched modeling_qwen3_vl.py"
    )
    parser.add_argument(
        "--output",
        type=str,
        default="./qwen3vl-oga-fp32-int4",
        help="Output directory for ONNX models"
    )
    parser.add_argument(
        "--precision",
        type=str,
        default="int4",
        choices=["fp32", "fp16", "int4"],
        help="Text model precision"
    )
    parser.add_argument(
        "--run-e2e",
        action="store_true",
        help="Run quick processor() text-only smoke after export",
    )
    parser.add_argument(
        "--prompt",
        type=str,
        default="Say hello in one short sentence.",
        help="Prompt used by --run-e2e",
    )
    
    args = parser.parse_args()
    
    # Resolve paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Handle relative paths
    if not os.path.isabs(args.input):
        input_dir = os.path.normpath(os.path.join(script_dir, args.input))
    else:
        input_dir = args.input

    if not os.path.isabs(args.reference):
        reference_dir = os.path.normpath(os.path.join(script_dir, args.reference))
    else:
        reference_dir = args.reference
    
    if not os.path.isabs(args.output):
        output_dir = os.path.normpath(os.path.join(script_dir, args.output))
    else:
        output_dir = args.output
    
    print("=" * 80)
    print("Qwen3-VL ONNX Export for OGA Integration")
    print("=" * 80)
    print(f"\nInput:  {input_dir}")
    print(f"Reference: {reference_dir}")
    print(f"Output: {output_dir}")
    print(f"Text precision: {args.precision.upper()}")
    print("Dynamic image size: True")
    
    # Create output directory
    os.makedirs(output_dir, exist_ok=True)
    
    # Prepare model
    _config, _processor, model = prepare_model(input_dir, reference_dir)
    
    # Export models
    export_vision_model(model, output_dir)
    export_embedding_model(model, output_dir)
    export_text_model(input_dir, output_dir, args.precision)
    
    # Create configuration files
    print("\n[4/4] Creating configuration files...")
    create_vision_processor_config(output_dir)
    update_genai_config(output_dir)

    if args.run_e2e:
        run_e2e_smoke(output_dir, args.prompt)
    
    print("\n" + "=" * 80)
    print("[SUCCESS] Export completed successfully!")
    print("=" * 80)
    print(f"\nAll files in: {output_dir}")
    print("\nExported models:")
    print("  - qwen3vl-vision.onnx       (FP32, vision encoder)")
    print("  - qwen3vl-embedding.onnx    (FP32, embedding injector)")
    print(f"  - model.onnx                ({args.precision.upper()}, text decoder)")
    print("\nConfiguration files:")
    print("  - genai_config.json         (OGA configuration)")
    print("  - vision_processor.json     (vision preprocessing)")
    print("  - tokenizer.json            (tokenizer)")
    print("\nNext steps:")
    print(f"  python ./qwen3vl-oga-inference.py -m {output_dir}")
    print()


if __name__ == "__main__":
    main()
