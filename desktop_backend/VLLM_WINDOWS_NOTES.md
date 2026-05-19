# Native Windows vLLM Trace

Date: 2026-05-19

Goal: run the local OCR backend with vLLM natively on Windows, without WSL.

## Runtime choice

- Official vLLM still documents Windows as unsupported for native CUDA installs.
- Tested fork: https://github.com/SystemPanic/vllm-windows
- Wheel installed successfully:
  `https://github.com/SystemPanic/vllm-windows/releases/download/v0.21.0/vllm-0.21.0%2Bcu132-cp312-cp312-win_amd64.whl`
- Python: CPython 3.12.12 from `uv python install 3.12`
- Torch installed by the fork wheel resolution: `2.11.0+cu130`
- CUDA visible from Torch: `True`
- GPU detected: `NVIDIA GeForce RTX 3090`
- Windows runtime/cache root:
  `%LOCALAPPDATA%\poneglyph`

## Commands used during validation

```powershell
uv python install 3.12
uv venv .venv-vllm-windows --python 3.12
uv pip install --python .\.venv-vllm-windows\Scripts\python.exe "https://github.com/SystemPanic/vllm-windows/releases/download/v0.21.0/vllm-0.21.0%2Bcu132-cp312-cp312-win_amd64.whl" --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match
.\.venv-vllm-windows\Scripts\python.exe -c "from vllm import LLM, SamplingParams; import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
.\.venv-vllm-windows\Scripts\python.exe -c "from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor; print('LightOnOCR ok')"
.\.venv-vllm-windows\Scripts\python.exe -c "import sys; sys.path.insert(0, 'desktop_backend'); import local_ocr_server as s; print(s.inspect_vllm_availability('cuda'))"
```

Observed verification:

```text
vllm ok
torch 2.11.0+cu130
cuda True
NVIDIA GeForce RTX 3090
LightOnOCR ok
(True, None)
```

## Real model-load result

After routing caches to `%LOCALAPPDATA%\poneglyph\cache`, a real bbox model
load/warmup was tested with `PONEGLYPH_INFERENCE_BACKEND=vllm`.

Observed status:

```json
{
  "loaded": true,
  "ready": true,
  "device": "cuda",
  "dtype": "auto",
  "requested_backend": "vllm",
  "active_backend": "vllm",
  "backend_fallback_reason": null,
  "backend_error": null,
  "warmup_error": null,
  "error": null
}
```

Cold start note: vLLM captured CUDA graphs and took roughly 3.5 minutes on the
first load. It also logged that LightOnOCR resolves through
`TransformersMultiModalForCausalLM`; this means the Windows fork runs the vLLM
engine path, but this model does not yet have a dedicated native vLLM
implementation.

## Production app path

The desktop app now auto-detects this per-user runtime before global Python:

```text
%LOCALAPPDATA%\poneglyph\vllm-windows\Scripts\python.exe
```

The Python backend also routes vLLM/FlashInfer caches away from `~\.cache`:

```text
XDG_CACHE_HOME=%LOCALAPPDATA%\poneglyph\cache
VLLM_CACHE_ROOT=%LOCALAPPDATA%\poneglyph\cache\vllm
FLASHINFER_WORKSPACE_BASE=%LOCALAPPDATA%\poneglyph\cache
```

Use this setup script to recreate it on a native Windows machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\desktop_backend\setup_vllm_windows.ps1
```

The older global Python error was:

```text
No module named 'vllm._C'
```

That happened because the global environment had a Python package named `vllm`
without the compiled CUDA extension. The dedicated runtime avoids that by using
the Windows fork wheel and by being selected before the global `python`.
