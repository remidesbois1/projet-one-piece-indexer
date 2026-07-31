# Local OCR backend

The Tauri application starts `local_ocr_server.py` automatically. On CUDA BF16,
Poneglyph-BBox uses the optimized single-page LightOnOCR engine by default:

- community FlashAttention KV cache with GQA head-group packing;
- Triton BF16 QKV and LM-head GEMV;
- an eight-token CUDA Graph decode block;
- persistent compiled engine and KV cache between requests;
- three load-time warmups.

Surya-BBox also has a CUDA BF16 batch-one engine enabled by default:

- static hybrid cache for Qwen3.5's 18 Gated DeltaNet and six attention layers;
- packed FlashAttention KV cache for the four GQA head groups;
- fused Triton SwiGLU input projection for all 24 MLPs;
- compiled eight-token CUDA Graph decode blocks;
- two load-time warmups that compile and capture the engine before readiness.

The same architecture-specific engines are enabled for the cropped-bubble
`Poneglyph` and `Surya OCR` text models. Their warmups use a representative
320x640 bubble and smaller caches, so compilation still happens during model
loading without imposing full-page cache sizes on every crop.

Only one page is decoded at a time. If a required kernel is unavailable or the
optimized path fails, the server restores the model and continues with standard
Transformers `generate`.

Install the Python dependencies with:

```powershell
python -m pip install -r desktop_backend/requirements.txt
```

Run the same FastAPI path used by the application:

```powershell
python desktop_backend/benchmark_local_ocr.py `
  --image path/to/page.jpg `
  --endpoint /ocr `
  --model-key surya_bbox `
  --runs 3
```

The model status and OCR responses expose `generation_engine`,
`optimized_engine_error`, warmup timings, and the latest prefill/decode profile.

On the RTX 3090 cropped-bubble benchmark, the text engines measured 3.877x for
LightOn and 4.305x for Surya over 24 samples, with 24/24 outputs identical to
standard Transformers.

## Model integrity

Desktop downloads are pinned by full Hugging Face commit SHA in
`model_registry.json`. Only the runtime files listed in that registry are
downloaded. Every file is checked for its exact size and SHA256 in a staging
directory before the verified snapshot replaces the active model directory.
Model loading is offline-only, uses safetensors, and never enables Transformers
remote code.

The backend embeds the canonical SHA256 of the registry itself and refuses a
modified external registry before reading any repository or revision from it.

The optional FlashAttention CUDA kernel is loaded only from the local Hub cache
at one embedded commit SHA. If that exact build is absent, inference falls back
to standard SDPA without downloading executable code during model loading.

All direct Python runtime dependencies in `requirements.txt` are pinned to the
versions used by the integrity and backend verification suite.

The normal application model directories remain under the platform data
directory. A custom `PONEGLYPH_*_MODEL_DIR` is accepted only when
`PONEGLYPH_ALLOW_UNVERIFIED_MODEL_DIRS=1` is explicitly set. This escape hatch
is for local development only: Hub downloads are disabled while such an
override is active.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PONEGLYPH_ALLOW_UNVERIFIED_MODEL_DIRS` | `0` | Development-only opt-in for custom local model directories; disables Hub downloads |
| `PONEGLYPH_LIGHTON_FAST_DECODE` | `1` | Enable the optimized Poneglyph-BBox path |
| `PONEGLYPH_LIGHTON_FAST_COMPILE_MODE` | `autotune` | `autotune` or faster-compiling `safe` mode |
| `PONEGLYPH_LIGHTON_FAST_EOS_INTERVAL` | `8` | Dependent decode steps per CUDA Graph replay |
| `PONEGLYPH_LIGHTON_TEXT_FAST_EOS_INTERVAL` | `1` | CUDA Graph block for short cropped-bubble output |
| `PONEGLYPH_LIGHTON_TEXT_FAST_CACHE_LENGTH` | `512` | Reserved cache capacity for cropped-bubble LightOn |
| `PONEGLYPH_LIGHTON_FAST_NUM_SPLITS` | `4` | Flash KV decode split count |
| `PONEGLYPH_LIGHTON_FAST_PREFILL_NUM_SPLITS` | `1` | Flash KV prefill split count |
| `PONEGLYPH_LIGHTON_FAST_WARMUP_REPEATS` | `3` | Load-time warmup repetitions |
| `PONEGLYPH_LIGHTON_FAST_WARMUP_TOKENS` | `32` | Token ceiling for each warmup |
| `PONEGLYPH_BBOX_MAX_NEW_TOKENS` | `768` | Full-page generation guard |
| `PONEGLYPH_SURYA_FAST_DECODE` | `1` | Enable the optimized Surya-BBox path |
| `PONEGLYPH_SURYA_FAST_COMPILE` | `1` | Compile the specialized decode step before CUDA Graph capture |
| `PONEGLYPH_SURYA_FAST_FUSED_MLP` | `1` | Enable the Triton SwiGLU input kernel |
| `PONEGLYPH_SURYA_FAST_DYNAMIC_PREFILL` | `1` | Prefill dynamically, then copy into the reserved decode cache |
| `PONEGLYPH_SURYA_FAST_EOS_INTERVAL` | `8` | Dependent decode steps per CUDA Graph replay |
| `PONEGLYPH_SURYA_TEXT_FAST_EOS_INTERVAL` | `1` | CUDA Graph block for short cropped-bubble output |
| `PONEGLYPH_SURYA_FAST_NUM_SPLITS` | `4` | Flash KV decode split count |
| `PONEGLYPH_SURYA_FAST_PREFILL_NUM_SPLITS` | `1` | Flash KV prefill split count |
| `PONEGLYPH_SURYA_FAST_CACHE_LENGTH` | `4608` | Cache capacity reserved during model loading |
| `PONEGLYPH_SURYA_TEXT_FAST_CACHE_LENGTH` | `768` | Reserved cache capacity for cropped-bubble Surya |
| `PONEGLYPH_SURYA_FAST_WARMUP_REPEATS` | `2` | Load-time compile/capture and hot validation runs |
| `PONEGLYPH_SURYA_FAST_WARMUP_TOKENS` | `32` | Token ceiling for each load-time warmup |
| `PONEGLYPH_SURYA_BBOX_MAX_NEW_TOKENS` | `2048` | Full-page generation guard |

Set `PONEGLYPH_LIGHTON_FAST_DECODE=0` or
`PONEGLYPH_SURYA_FAST_DECODE=0` to force the corresponding Transformers path.
