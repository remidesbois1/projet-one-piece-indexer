# Surya Bubble OCR ONNX Integration

This folder contains the FP32-first Surya OCR 2 export, validation, upload, and
browser integration path for Projet Poneglyph.

Source model:

- `Remidesbois/surya-bubble-ocr-poneglyph`

Intended ONNX package repository:

- `Remidesbois/surya-bubble-ocr-poneglyph-onnx`

## Why This Uses A Dedicated Runtime

Surya OCR 2 is a Qwen3.5 VLM-style model. Its processor emits patch tensors,
`image_grid_thw`, image token spans, and M-RoPE metadata, so it needs its own
export and browser runtime assumptions.

## Working FP32 Export

The working exporter is the forked static split exporter:

```bash
python export_onnx_static_fp32.py \
  --model-id Remidesbois/surya-bubble-ocr-poneglyph \
  --output-dir ./exported/surya-bubble-ocr-poneglyph-fp32 \
  --sample-image ./test_images/square.png \
  --device cuda \
  --opset 17 \
  --max-context-tokens 1536
```

It writes:

- `onnx/vision_encoder.onnx`
- `onnx/decoder_model.onnx`
- tokenizer, processor, config, and `preprocessor_config.json`
- `surya_runtime_manifest.json`

Runtime contract:

- vision graph: dynamic patch count from `pixel_values`
- decoder graph: fixed right-padded 1536-token no-cache context
- decoder output: `next_logits` for the supplied `logit_index`
- generation: greedy loop reruns the padded decoder context each token

The original `export_onnx_fp32.py` is kept as a diagnostic top-level exporter.
It currently records the upstream-style blockers in `export_error.json` and is
not the accepted runtime package path.

## Validation

Create references:

```bash
python create_reference_outputs.py \
  --model-id Remidesbois/surya-bubble-ocr-poneglyph \
  --images ./test_images \
  --out ./reference_outputs \
  --device cuda
```

Validate the exported split graphs:

```bash
python validate_static_onnx.py \
  --model-id Remidesbois/surya-bubble-ocr-poneglyph \
  --onnx-dir ./exported/surya-bubble-ocr-poneglyph-fp32/onnx \
  --images ./test_images \
  --out ./reference_outputs/static_onnx_validation.json \
  --device cuda \
  --max-context-tokens 1536
```

Current validation evidence: 12 image cases pass with the same ONNX sessions,
including 256x256, 320x768, 768x320, a high-resolution crop, and a page-style
crop. All next-token argmax values match PyTorch.

## Upload

```bash
HF_TOKEN=... python upload_to_hf.py \
  --source-dir ./exported/surya-bubble-ocr-poneglyph-fp32 \
  --repo-id Remidesbois/surya-bubble-ocr-poneglyph-onnx \
  --commit-message "Add Surya OCR 2 FP32 ONNX export"
```

The upload script validates required package files and every external-data shard
listed in `surya_runtime_manifest.json` before uploading.

## Browser Integration

The frontend exposes `Surya OCR 2 FP32` as its own local OCR backend. The worker uses:

- Transformers.js `AutoProcessor` and `AutoTokenizer`
- `onnxruntime-web` for `vision_encoder.onnx` and `decoder_model.onnx`
- project runtime glue in `frontend/src/lib/ocr/surya/`

Native Transformers.js model loading is not assumed. The package is
Transformers.js-compatible for tokenizer/processor loading, while model
execution uses the project wrapper because the exported graph layout is custom.

Runtime notes:

- WebGPU is the intended browser backend for FP32.
- Browser/WASM is not the default; the FP32 decoder package is too large for the
  practical WASM path in local testing.
- The decoder context is fixed-padded rather than truly dynamic because the
  Qwen3.5 GatedDeltaNet PyTorch fallback unrolls 64-token chunks during tracing.

## Optimization

Do not add FP16, INT8, Q8, or Q4 variants until this FP32 package is uploaded
and tested from the webapp. Quantized variants must be benchmarked against the
FP32 validation set before becoming default.
