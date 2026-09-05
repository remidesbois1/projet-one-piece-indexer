"""Optional CPU integration check against the real pinned upstream source.

Usage: python verify_upstream_cpu.py /path/to/source-snapshot
No model weights are needed. GPU kernels are substituted by dense CPU math;
the architecture, positions and tokenizer/processor come from the snapshot.
Run this script in its own process, never import it into a training process.
"""

import argparse
import importlib
import importlib.machinery
import sys
import types
from pathlib import Path

import torch
import torch._dynamo
from transformers import (  # noqa: F401 -- preload before Triton stubs
    AutoTokenizer,
    PreTrainedModel,
)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("snapshot", type=Path)
args = parser.parse_args()
root = args.snapshot.resolve()
from config import Config
from model import FalconEngine, hybrid_mask

# CPU verification of the actual pinned model, substituting only inference GPU
# kernels by independent dense math. This is not a CUDA compatibility test.
package = types.ModuleType("falcon_fixture")
package.__path__ = [str(root)]
sys.modules[package.__name__] = package
triton = types.ModuleType("triton")
triton.__spec__ = importlib.machinery.ModuleSpec("triton", loader=None)
triton.jit = lambda fn: fn
tl = types.ModuleType("triton.language")
tl.constexpr = object
triton.language = tl
sys.modules["triton"] = triton
sys.modules["triton.language"] = tl
attention = types.ModuleType("falcon_fixture.attention")


def dense_attention(q, k, v, block_mask, **kwargs):
    scores = (q @ k.transpose(-1, -2) / q.shape[-1] ** 0.5).masked_fill(
        ~block_mask.allowed, -torch.inf
    )
    # Avoid all-masked padding rows; their output is unused.
    scores = torch.where(
        torch.isfinite(scores).any(-1, keepdim=True), scores, torch.zeros_like(scores)
    )
    return scores.softmax(-1) @ v, types.SimpleNamespace(lse=scores.logsumexp(-1))


attention.compiled_flex_attn_decode = attention.compiled_flex_attn_prefill = (
    dense_attention
)
attention.create_batch_attention_mask = lambda *a, **kw: None
attention.offset_mask_mod = lambda *a, **kw: None
sys.modules[attention.__name__] = attention
upstream = importlib.import_module("falcon_fixture.modeling_falcon_ocr")
rope = importlib.import_module("falcon_fixture.rope")
processing = importlib.import_module("falcon_fixture.processing_falcon_ocr")
configuration = importlib.import_module("falcon_fixture.configuration_falcon_ocr")
upstream.squared_relu_gate = lambda packed, hidden_dim: (
    packed[..., ::2].relu().square() * packed[..., 1::2]
)
config = configuration.FalconOCRConfig(
    dim=32,
    n_layers=2,
    n_heads=2,
    head_dim=16,
    n_kv_heads=1,
    vocab_size=512,
    ffn_dim=48,
    max_seq_len=256,
)
torch.manual_seed(5)
model = upstream.FalconOCRForCausalLM(config)
model.freqs_cis_golden.normal_()
for layer in model.layers.values():
    layer.attention.sinks.data.normal_()
model._ensure_device_buffers()
engine = FalconEngine.__new__(FalconEngine)
engine.model, engine.config, engine.pad_id = model, Config(), 0
engine.rope = rope
tokens = torch.tensor([[2, 244, 245, 246, 247, 248, 227, 230, 20, 30, 31, 11]])
pixels = torch.randn(1, 1, 16, 16, 3)
pixel_mask = torch.ones(1, 1, 16, 16, dtype=torch.long)
pos_t, pos_hw = processing.get_pos_thw(tokens, pixel_mask, config, 16, pad_token_id=0)
labels = torch.full_like(tokens, -100)
labels[:, -3:] = tokens[:, -3:]
batch = {
    "tokens": tokens,
    "pixel_values": pixels,
    "pixel_mask": pixel_mask,
    "pos_t": pos_t,
    "pos_hw": pos_hw,
    "labels": labels,
}
model.eval()


class Cache:
    def get_pos(self):
        return 0

    def insert_kv(self, layer, k, v, **kwargs):
        return k, v


mask = types.SimpleNamespace(allowed=hybrid_mask(tokens, config, 0))
native = model(tokens, mask, Cache(), pos_t, pos_hw, pixels, pixel_mask)
trained = model.output(engine.hidden(batch))
torch.testing.assert_close(trained, native, rtol=1e-4, atol=1e-5)
print(
    "Pinned model training/native FP32 logits match. Max error:",
    (trained - native).abs().max().item(),
)
del native, trained
model.train()
loss = engine.loss(batch)
loss.backward()
missing = [
    n
    for n, p in model.named_parameters()
    if p.grad is None or not torch.isfinite(p.grad).all()
]
assert not missing, missing
for name in [
    "img_projector.weight",
    "layers.0.attention.sinks",
    "layers.0.feed_forward.w13.weight",
]:
    assert model.get_parameter(name).grad.abs().sum() > 0, name
print(
    "Actual upstream blocks: checkpointed backward reaches all parameters. Loss:",
    float(loss.detach()),
)
optimizer = torch.optim.AdamW(model.parameters(), lr=0.001)
initial = float(loss.detach())
for i in range(6):
    optimizer.zero_grad()
    loss = engine.loss(batch)
    loss.backward()
    optimizer.step()
final = float(engine.loss(batch).detach())
assert final < initial, (initial, final)
print("Tiny real-architecture overfit:", initial, "->", final)
from PIL import Image

engine.tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True)
engine.processing = processing
engine.pad_id = engine.tokenizer.convert_tokens_to_ids("<|pad|>")
engine.eos = engine.tokenizer.convert_tokens_to_ids("<|end_of_query|>")
engine.model.config.max_seq_len = 8192
path = root / "fixture.png"
Image.new("RGB", (64, 80), "white").save(path)
rows = [
    {"id": "a", "text": "Bonjour !", "image_path": str(path)},
    {"id": "b", "text": "A", "image_path": str(path)},
]
supervised = engine.collate(rows)
for row, labels in zip(rows, supervised["labels"]):
    assert labels[labels != -100].tolist() == engine.target_ids(row)
prompt = engine.collate([{"image_path": str(path)}], supervised=False)
assert "labels" not in prompt
assert engine.eos not in prompt["tokens"][0].tolist()
print(
    "Actual tokenizer/processor: exact target+stop supervision; prompt-only inference accepts no reference."
)
