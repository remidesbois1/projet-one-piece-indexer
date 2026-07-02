import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import numpy_helper
from transformers import AutoProcessor
from transformers.models.pp_ocrv6_small_rec.modeling_pp_ocrv6_small_rec import (
    PPOCRV6SmallRecForTextRecognition,
)


def load_onnx_initializers(onnx_path: Path) -> list[tuple[str, np.ndarray]]:
    model = onnx.load(str(onnx_path), load_external_data=False)
    return [(item.name, numpy_helper.to_array(item)) for item in model.graph.initializer]


def to_state_tensor(array: np.ndarray, like: torch.Tensor) -> torch.Tensor:
    tensor = torch.from_numpy(np.ascontiguousarray(array).copy())
    if like.dtype.is_floating_point:
        tensor = tensor.to(dtype=like.dtype)
    return tensor


def recover_checkpoint(args: argparse.Namespace) -> dict:
    base_model_dir = Path(args.base_model_dir)
    onnx_dir = Path(args.onnx_dir)
    output_dir = Path(args.output_dir)
    onnx_path = onnx_dir / args.onnx_name

    output_dir.mkdir(parents=True, exist_ok=True)

    model = PPOCRV6SmallRecForTextRecognition.from_pretrained(
        base_model_dir,
        trust_remote_code=True,
    )
    state = model.state_dict()
    recovered = {key: value.detach().clone() for key, value in state.items()}

    initializers = load_onnx_initializers(onnx_path)
    used_initializers: set[str] = set()
    direct_matches = []

    for name, array in initializers:
        key = name[len("model.") :] if name.startswith("model.") else name
        if key in state and tuple(state[key].shape) == tuple(array.shape):
            recovered[key] = to_state_tensor(array, state[key])
            used_initializers.add(name)
            direct_matches.append(key)

    generic_conv = [
        (name, array)
        for name, array in initializers
        if name.startswith("onnx::Conv") and name not in used_initializers
    ]
    if len(generic_conv) % 2:
        raise ValueError(f"Expected Conv initializers in weight/bias pairs, got {len(generic_conv)}")

    conv_weight_keys = [
        key
        for key in state
        if key.endswith(".convolution.weight")
        and f"{key[: -len('.convolution.weight')]}.normalization.weight" in state
    ]
    conv_pairs = [(generic_conv[i], generic_conv[i + 1]) for i in range(0, len(generic_conv), 2)]
    if len(conv_pairs) != len(conv_weight_keys):
        raise ValueError(
            f"Conv mapping mismatch: {len(conv_pairs)} ONNX pairs for {len(conv_weight_keys)} PyTorch conv+norm blocks"
        )

    conv_matches = []
    for conv_key, ((weight_name, weight_array), (bias_name, bias_array)) in zip(conv_weight_keys, conv_pairs):
        if tuple(state[conv_key].shape) != tuple(weight_array.shape):
            raise ValueError(f"Shape mismatch for {conv_key}: ONNX {weight_array.shape}, state {tuple(state[conv_key].shape)}")

        base = conv_key[: -len(".convolution.weight")]
        norm_base = f"{base}.normalization"
        norm_module = model.get_submodule(f"{base}.normalization")
        eps = float(getattr(norm_module, "eps", 1e-5))

        recovered[conv_key] = to_state_tensor(weight_array, state[conv_key])
        recovered[f"{norm_base}.weight"] = torch.full_like(state[f"{norm_base}.weight"], math.sqrt(1.0 + eps))
        recovered[f"{norm_base}.bias"] = to_state_tensor(bias_array, state[f"{norm_base}.bias"])
        recovered[f"{norm_base}.running_mean"] = torch.zeros_like(state[f"{norm_base}.running_mean"])
        recovered[f"{norm_base}.running_var"] = torch.ones_like(state[f"{norm_base}.running_var"])
        num_batches_key = f"{norm_base}.num_batches_tracked"
        if num_batches_key in state:
            recovered[num_batches_key] = torch.zeros_like(state[num_batches_key])

        used_initializers.update({weight_name, bias_name})
        conv_matches.append(conv_key)

    generic_matmul = [
        (name, array)
        for name, array in initializers
        if name.startswith("onnx::MatMul") and name not in used_initializers
    ]
    linear_weight_keys = [
        key
        for key in state
        if key.endswith(".weight")
        and key.startswith("head.")
        and len(state[key].shape) == 2
        and key not in direct_matches
    ]
    if len(generic_matmul) != len(linear_weight_keys):
        raise ValueError(
            f"MatMul mapping mismatch: {len(generic_matmul)} ONNX weights for {len(linear_weight_keys)} PyTorch linear weights"
        )

    matmul_matches = []
    for linear_key, (name, array) in zip(linear_weight_keys, generic_matmul):
        transposed = array.T
        if tuple(state[linear_key].shape) != tuple(transposed.shape):
            raise ValueError(
                f"Shape mismatch for {linear_key}: ONNX {array.shape} transposed to {transposed.shape}, "
                f"state {tuple(state[linear_key].shape)}"
            )
        recovered[linear_key] = to_state_tensor(transposed, state[linear_key])
        used_initializers.add(name)
        matmul_matches.append(linear_key)

    missing = [name for name, _ in initializers if name not in used_initializers]
    model.load_state_dict(recovered)
    model.save_pretrained(output_dir, safe_serialization=True)

    processor_source = onnx_dir if (onnx_dir / "preprocessor_config.json").exists() else base_model_dir
    processor = AutoProcessor.from_pretrained(processor_source, trust_remote_code=True)
    processor.save_pretrained(output_dir)

    for name in ("config.json", "preprocessor_config.json"):
        source = onnx_dir / name
        if source.exists():
            shutil.copy2(source, output_dir / name)

    summary = {
        "base_model_dir": str(base_model_dir),
        "onnx_path": str(onnx_path),
        "output_dir": str(output_dir),
        "initializers": len(initializers),
        "direct_matches": len(direct_matches),
        "conv_blocks_recovered": len(conv_matches),
        "matmul_weights_recovered": len(matmul_matches),
        "unmapped_initializers": missing,
    }
    (output_dir / "onnx_recovery_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Recover a trainable PP-OCRv6 checkpoint from a browser ONNX export.")
    parser.add_argument("--base-model-dir", required=True, help="Compatible PP-OCRv6 Transformers checkpoint.")
    parser.add_argument("--onnx-dir", required=True, help="Directory containing the release ONNX and processor files.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--onnx-name", default="ppocrv6_bubble_line_rec.onnx")
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(recover_checkpoint(parse_args()), ensure_ascii=False, indent=2), flush=True)
