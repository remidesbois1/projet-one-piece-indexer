"""Export Falcon-OCR's exact architecture with portable ONNX WebGPU operators.

No Triton, FlexAttention, complex tensors, quantization, or custom ORT kernels.
The BF16 training RMS epsilon is explicit; storage/matmuls use browser FP16.
"""

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto as T
from onnx import external_data_helper, numpy_helper
from onnx import helper as h
from safetensors.numpy import load_file


class Graph:
    def __init__(self, directory):
        self.nodes, self.initializers = [], []
        self.serial = 0
        self.stream = (directory / "decoder.onnx.data").open("wb")

    def constant(self, value, name=None, dtype=None):
        name = name or self.name("constant")
        tensor = numpy_helper.from_array(np.asarray(value, dtype=dtype), name)
        if len(tensor.raw_data) > 4096:
            offset = self.stream.tell()
            self.stream.write(tensor.raw_data)
            external_data_helper.set_external_data(
                tensor, "decoder.onnx.data", offset, len(tensor.raw_data)
            )
            tensor.ClearField("raw_data")
            tensor.data_location = T.EXTERNAL
        self.initializers.append(tensor)
        return name

    def name(self, prefix):
        self.serial += 1
        return f"{prefix}_{self.serial}"

    def op(self, kind, *inputs, **attrs):
        output = self.name(kind.lower())
        self.nodes.append(
            h.make_node(kind, list(inputs), [output], name=output, **attrs)
        )
        return output

    def shape(self, x, shape):
        return self.op("Reshape", x, self.constant(shape, dtype=np.int64))

    def cast(self, x, dtype):
        return self.op("Cast", x, to=dtype)

    def norm(self, x, eps):
        f = self.cast(x, T.FLOAT)
        mean = self.op("ReduceMean", self.op("Mul", f, f), axes=[-1], keepdims=1)
        denom = self.op(
            "Sqrt", self.op("Add", mean, self.constant(eps, dtype=np.float32))
        )
        return self.cast(self.op("Div", f, denom), T.FLOAT16)

    def unsqueeze(self, x, axes):
        return self.op("Unsqueeze", x, self.constant(axes, dtype=np.int64))

    def gather(self, x, index, axis=0):
        return self.op("Gather", x, self.constant(index, dtype=np.int64), axis=axis)

    def rope(self, x):
        x = self.shape(self.cast(x, T.FLOAT), [1, -1, 16, 32, 2])
        even, odd = self.gather(x, 0, 4), self.gather(x, 1, 4)
        a = self.op(
            "Sub", self.op("Mul", even, "rope_cos"), self.op("Mul", odd, "rope_sin")
        )
        b = self.op(
            "Add", self.op("Mul", even, "rope_sin"), self.op("Mul", odd, "rope_cos")
        )
        pairs = self.op(
            "Concat", self.unsqueeze(a, [-1]), self.unsqueeze(b, [-1]), axis=-1
        )
        return self.cast(self.shape(pairs, [1, -1, 16, 64]), T.FLOAT16)


def export(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    config = json.loads((source / "config.json").read_text(encoding="utf-8"))
    assert (
        config["dim"],
        config["n_heads"],
        config["head_dim"],
        config["n_kv_heads"],
    ) == (768, 16, 64, 8)
    weights = load_file(source / "model.safetensors")
    g = Graph(destination)

    def weight(name, transpose=False, dtype=np.float16):
        a = weights[name]
        return g.constant((a.T if transpose else a).astype(dtype), name)

    def linear(x, name):
        return g.op("MatMul", x, weight(name, True))

    hidden = g.op("Gather", weight("tok_embeddings.weight"), "input_ids", axis=0)
    visual = linear("pixel_values", "img_projector.weight")
    hidden = g.cast(g.op("Where", "pixel_mask", visual, hidden), T.FLOAT)
    caches = []
    for layer in range(config["n_layers"]):
        print(f"Export block {layer + 1}/{config['n_layers']}", flush=True)
        prefix = f"layers.{layer}."
        packed = linear(g.norm(hidden, 1 / 128), prefix + "attention.wqkv.weight")
        q, k, v = [g.name("qkv") for _ in range(3)]
        g.nodes.append(
            h.make_node(
                "Split",
                [packed, g.constant([1024, 512, 512], dtype=np.int64)],
                [q, k, v],
                axis=-1,
            )
        )
        q = g.norm(g.shape(q, [1, -1, 16, 64]), 1 / 128)
        k = g.norm(g.shape(k, [1, -1, 8, 64]), 1 / 128)
        repeat = [i // 2 for i in range(16)]
        k = g.gather(k, repeat, 2)
        v = g.gather(g.shape(v, [1, -1, 8, 64]), repeat, 2)
        q, k = g.rope(q), g.rope(k)
        q, k, v = [g.op("Transpose", x, perm=[0, 2, 1, 3]) for x in (q, k, v)]
        past = g.gather("past_key_values", layer)
        k = g.op("Concat", g.gather(past, 0), k, axis=2)
        v = g.op("Concat", g.gather(past, 1), v, axis=2)
        cache = g.op("Concat", g.unsqueeze(k, [0]), g.unsqueeze(v, [0]), axis=0)
        caches.append(g.unsqueeze(cache, [0]))
        scores = g.op("MatMul", q, g.op("Transpose", k, perm=[0, 1, 3, 2]))
        scores = g.op("Mul", scores, g.constant(0.125, dtype=np.float16))
        scores = g.op("Add", scores, "attention_mask")
        sinks = g.shape(weight(prefix + "attention.sinks"), [1, 16, 1, 1])
        sinks = g.op("Add", sinks, "sink_template")
        probabilities = g.op(
            "Softmax", g.cast(g.op("Concat", scores, sinks, axis=-1), T.FLOAT), axis=-1
        )
        probabilities = g.op(
            "Slice",
            probabilities,
            g.constant([0], dtype=np.int64),
            g.constant([-1], dtype=np.int64),
            g.constant([-1], dtype=np.int64),
        )
        attended = g.op("MatMul", g.cast(probabilities, T.FLOAT16), v)
        attended = g.shape(
            g.op("Transpose", attended, perm=[0, 2, 1, 3]), [1, -1, 1024]
        )
        hidden = g.op(
            "Add",
            hidden,
            g.cast(linear(attended, prefix + "attention.wo.weight"), T.FLOAT),
        )
        ff = linear(g.norm(hidden, 1 / 128), prefix + "feed_forward.w13.weight")
        ff = g.shape(g.cast(ff, T.FLOAT), [1, -1, config["ffn_dim"], 2])
        gate, up = g.gather(ff, 0, 3), g.gather(ff, 1, 3)
        gate = g.op("Relu", gate)
        ff = g.op("Mul", g.op("Mul", gate, gate), up)
        ff = g.op(
            "MatMul", ff, weight(prefix + "feed_forward.w2.weight", True, np.float32)
        )
        hidden = g.op("Add", hidden, ff)
    hidden = g.op("Mul", g.norm(hidden, config["norm_eps"]), weight("norm.weight"))
    last = g.op(
        "Slice",
        hidden,
        g.constant([-1], dtype=np.int64),
        g.constant([2**63 - 1], dtype=np.int64),
        g.constant([1], dtype=np.int64),
    )
    logits = g.cast(linear(last, "output.weight"), T.FLOAT)
    token = g.op("ArgMax", logits, axis=-1, keepdims=0)
    present = g.op("Concat", *caches, axis=0)
    for name, value in [
        ("logits", logits),
        ("next_token", token),
        ("present_key_values", present),
    ]:
        g.nodes.append(h.make_node("Identity", [value], [name]))
    inputs = [
        h.make_tensor_value_info("input_ids", T.INT64, [1, "sequence"]),
        h.make_tensor_value_info("pixel_values", T.FLOAT16, [1, "sequence", 768]),
        h.make_tensor_value_info("pixel_mask", T.BOOL, [1, "sequence", 1]),
        h.make_tensor_value_info("rope_cos", T.FLOAT, [1, "sequence", 16, 32]),
        h.make_tensor_value_info("rope_sin", T.FLOAT, [1, "sequence", 16, 32]),
        h.make_tensor_value_info(
            "attention_mask", T.FLOAT16, [1, 1, "sequence", "total_sequence"]
        ),
        h.make_tensor_value_info("sink_template", T.FLOAT16, [1, 16, "sequence", 1]),
        h.make_tensor_value_info(
            "past_key_values",
            T.FLOAT16,
            [config["n_layers"], 2, 1, 16, "past_sequence", 64],
        ),
    ]
    outputs = [
        h.make_tensor_value_info("logits", T.FLOAT, [1, 1, 65536]),
        h.make_tensor_value_info("next_token", T.INT64, [1, 1]),
        h.make_tensor_value_info(
            "present_key_values",
            T.FLOAT16,
            [config["n_layers"], 2, 1, 16, "total_sequence", 64],
        ),
    ]
    graph = h.make_graph(
        g.nodes, "Falcon-OCR-Poneglyph-WebGPU", inputs, outputs, g.initializers
    )
    model = h.make_model(
        graph,
        opset_imports=[h.make_opsetid("", 17)],
        producer_name="poneglyph-falcon-webgpu",
        ir_version=9,
    )
    g.stream.close()
    onnx.save(model, destination / "decoder.onnx")
    onnx.checker.check_model(str(destination / "decoder.onnx"))
    prompt = "<|image|>Extract the text content from this image.\n<|OCR_PLAIN|>"
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(source / "tokenizer.json"))
    chunks = [tokenizer.encode(s).ids for s in prompt.split("<|image|>")]
    manifest = {
        "schema": 1,
        "model_id": "Remidesbois/Falcon-OCR-Poneglyph",
        "source_sha256": hashlib.file_digest(
            (source / "model.safetensors").open("rb"), "sha256"
        ).hexdigest(),
        "format": "mixed-fp16-fp32",
        "rms_epsilon": 1 / 128,
        "config": config,
        "prompt_chunks": chunks,
        "max_new_tokens": 256,
        "min_dimension": 64,
        "max_dimension": 896,
        "stop_ids": [config["eos_id"], tokenizer.token_to_id("<|end_of_query|>")],
        "golden_frequencies": weights["freqs_cis_golden"].tolist(),
        "files": {
            name: {
                "bytes": (destination / name).stat().st_size,
                "sha256": hashlib.file_digest(
                    (destination / name).open("rb"), "sha256"
                ).hexdigest(),
            }
            for name in ("decoder.onnx", "decoder.onnx.data")
        },
    }
    (destination / "browser_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    for name in ("tokenizer.json", "tokenizer_config.json"):
        shutil.copy2(source / name, destination / name)
    shutil.copy2(Path(__file__).with_name("README.md"), destination / "README.md")
    print(
        json.dumps(
            {k: v for k, v in manifest.items() if k in ("source_sha256", "files")}
        ),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    export(args.source, args.output)
