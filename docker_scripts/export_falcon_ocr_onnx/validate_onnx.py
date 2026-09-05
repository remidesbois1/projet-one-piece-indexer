"""Run a complete cached ONNX transcription from an independently made fixture."""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--model", type=Path, required=True)
args = parser.parse_args()
p = args.model
manifest = json.loads((p / "browser_manifest.json").read_text())
meta = json.loads((p / "fixtures/native-inputs.json").read_text())
reference = json.loads((p / "fixtures/examples.json").read_text(encoding="utf-8"))[0]
inputs = dict(np.load(p / "fixtures/native-inputs.npz"))
inputs["sink_template"] = np.zeros((1, 16, inputs["input_ids"].shape[1], 1), np.float16)
options = ort.SessionOptions()
options.intra_op_num_threads = 8
session = ort.InferenceSession(
    str(p / "decoder.onnx"), options, providers=["CPUExecutionProvider"]
)
tokenizer = Tokenizer.from_file(str(p / "tokenizer.json"))
ids = []
start = time.perf_counter()
for step in range(manifest["max_new_tokens"]):
    token, cache, logits = session.run(
        ["next_token", "present_key_values", "logits"], inputs
    )
    if not np.isfinite(logits).all():
        raise RuntimeError("Non-finite ONNX logits")
    token = int(token[0, 0])
    if token in manifest["stop_ids"]:
        break
    ids.append(token)
    angles = np.zeros((1, 1, 16, 32), np.float32)
    angles[:, :, :, :16] = (meta["last_pos"] + step + 1) / (
        10000 ** (np.arange(16, dtype=np.float32) * 2 / 32)
    )
    inputs = {
        "input_ids": np.array([[token]], np.int64),
        "pixel_values": np.zeros((1, 1, 768), np.float16),
        "pixel_mask": np.zeros((1, 1, 1), bool),
        "rope_cos": np.cos(angles),
        "rope_sin": np.sin(angles),
        "attention_mask": np.zeros((1, 1, 1, cache.shape[-2] + 1), np.float16),
        "sink_template": np.zeros((1, 16, 1, 1), np.float16),
        "past_key_values": cache,
    }
prediction = tokenizer.decode(ids, skip_special_tokens=False).strip()
report = {
    "prediction": prediction,
    "native": reference["native"],
    "reference": reference["reference"],
    "exact": prediction == reference["native"],
    "tokens": len(ids),
    "seconds": time.perf_counter() - start,
}
(p / "fixtures/onnx_validation.json").write_text(
    json.dumps(report, indent=2), encoding="utf-8"
)
print(json.dumps(report), flush=True)
if not report["exact"]:
    raise RuntimeError("ONNX differs from native on the control image")
