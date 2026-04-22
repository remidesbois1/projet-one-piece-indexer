"""
Export the current best PyTorch checkpoint to ONNX.
Uses the simplified model.
"""

import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent / "readernet"))
from train_readernet import (
    SimpleReaderNet,
    MODEL_INPUT_H,
    MODEL_INPUT_W,
    BUBBLE_CROP_SIZE,
)


def export():
    script_dir = Path(__file__).resolve().parent
    ckpt_path = script_dir / "readernet" / "dataset" / "readernet_poneglyph.pt"
    onnx_path = script_dir / "readernet" / "dataset" / "readernet_poneglyph.onnx"

    if not ckpt_path.exists():
        print(f"Checkpoint not found: {ckpt_path}")
        sys.exit(1)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = SimpleReaderNet().to(device)

    ckpt = torch.load(str(ckpt_path), map_location=device, weights_only=False)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()
    print(f"Loaded checkpoint from epoch {ckpt.get('epoch', '?')}")

    dummy_imgs = torch.randn(1, 1, MODEL_INPUT_H, MODEL_INPUT_W).to(device)
    dummy_panels = torch.tensor([[[0.1, 0.1, 0.4, 0.4], [0.5, 0.1, 0.4, 0.4]]]).to(
        device
    )
    dummy_geoms = torch.tensor(
        [[[0.2, 0.2, 0.1, 0.1], [0.3, 0.3, 0.1, 0.1], [0.6, 0.2, 0.1, 0.1]]]
    ).to(device)
    dummy_crops = torch.randn(1, 3, 1, BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE).to(device)
    dummy_bubble_panels = torch.tensor([[0, 0, 1]]).to(device)
    dummy_panel_mask = torch.zeros(1, 2, dtype=torch.bool).to(device)
    dummy_bubble_mask = torch.zeros(1, 3, dtype=torch.bool).to(device)

    torch.onnx.export(
        model,
        (
            dummy_imgs,
            dummy_panels,
            dummy_geoms,
            dummy_bubble_panels,
            dummy_crops,
            dummy_panel_mask,
            dummy_bubble_mask,
        ),
        str(onnx_path),
        input_names=[
            "images",
            "panels",
            "bubbles",
            "bubble_panels",
            "bubble_crops",
            "panel_mask",
            "bubble_mask",
        ],
        output_names=["scores"],
        dynamic_axes={
            "images": {0: "batch"},
            "panels": {0: "batch", 1: "num_panels"},
            "bubbles": {0: "batch", 1: "num_bubbles"},
            "bubble_panels": {0: "batch", 1: "num_bubbles"},
            "bubble_crops": {0: "batch", 1: "num_bubbles"},
            "panel_mask": {0: "batch", 1: "num_panels"},
            "bubble_mask": {0: "batch", 1: "num_bubbles"},
            "scores": {0: "batch", 1: "num_bubbles"},
        },
    )
    print(f"ONNX model exported to: {onnx_path}")


if __name__ == "__main__":
    export()
