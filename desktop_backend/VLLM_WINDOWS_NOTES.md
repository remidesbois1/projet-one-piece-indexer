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

## Production app path

The desktop app now auto-detects this per-user runtime before global Python:

```text
%LOCALAPPDATA%\poneglyph\vllm-windows\Scripts\python.exe
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
