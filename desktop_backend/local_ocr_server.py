import argparse
import base64
import binascii
import io
import os
import platform
import re
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel


MODEL_ID = "Remidesbois/LightonOCR-2-1b-poneglyph-bbox"
MODEL_DIR_NAME = "lighton-ocr-poneglyph-bbox"
MAX_IMAGE_SIZE = (1540, 1540)

processor = None
model = None
device = None
dtype = None
model_loading = False
last_error: Optional[str] = None
download_state = {
    "active": False,
    "ok": None,
    "error": None,
    "total_bytes": None,
    "downloaded_bytes": 0,
    "started_at": None,
    "finished_at": None,
}

model_lock = threading.Lock()
inference_lock = threading.Lock()
download_lock = threading.Lock()

app = FastAPI(title="Poneglyph Local OCR Backend")


class OcrRequest(BaseModel):
    image_bytes_base64: str


def default_app_model_dir() -> str:
    system = platform.system().lower()
    home = Path.home()

    if system == "darwin":
        base_dir = home / "Library" / "Application Support" / "poneglyph"
    elif system == "windows":
        base_dir = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "poneglyph"
    else:
        base_dir = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share")) / "poneglyph"

    return str(base_dir / "models" / MODEL_DIR_NAME)


def get_model_dir() -> str:
    return os.environ.get("PONEGLYPH_MODEL_DIR") or default_app_model_dir()


def model_is_installed() -> bool:
    return os.path.exists(os.path.join(get_model_dir(), "config.json"))


def get_torch():
    import torch

    return torch


def pick_device(torch_module) -> str:
    if torch_module.cuda.is_available():
        return "cuda"

    mps_backend = getattr(torch_module.backends, "mps", None)
    if mps_backend and mps_backend.is_available():
        return "mps"

    return "cpu"


def pick_dtype(torch_module, selected_device: str):
    if selected_device == "cuda":
        if getattr(torch_module.cuda, "is_bf16_supported", lambda: False)():
            return torch_module.bfloat16
        return torch_module.float16

    if selected_device == "mps":
        return torch_module.float16

    return torch_module.float32


def dtype_name(selected_dtype) -> str:
    return str(selected_dtype).replace("torch.", "")


def model_dir_size_bytes() -> int:
    model_dir = get_model_dir()
    total = 0
    if not os.path.exists(model_dir):
        return total

    for root, _dirs, files in os.walk(model_dir):
        for file_name in files:
            if file_name.endswith(".lock"):
                continue
            file_path = os.path.join(root, file_name)
            try:
                total += os.path.getsize(file_path)
            except OSError:
                pass

    return total


def get_model_total_bytes() -> Optional[int]:
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(
            MODEL_ID,
            files_metadata=True,
            token=os.environ.get("HF_TOKEN"),
        )
        return int(sum(sibling.size or 0 for sibling in info.siblings))
    except Exception:
        return None


def update_download_state(**updates) -> None:
    with download_lock:
        download_state.update(updates)


def download_status_snapshot():
    with download_lock:
        state = dict(download_state)

    downloaded_bytes = model_dir_size_bytes()
    total_bytes = state.get("total_bytes")
    if total_bytes:
        downloaded_bytes = min(downloaded_bytes, total_bytes)

    with download_lock:
        download_state["downloaded_bytes"] = downloaded_bytes
        state = dict(download_state)

    return state


def cuda_memory_mb(torch_module, device_index: int, value_name: str) -> Optional[int]:
    try:
        value = getattr(torch_module.cuda, value_name)(device_index)
        return int(value // (1024 * 1024))
    except Exception:
        return None


def download_model() -> None:
    from huggingface_hub import snapshot_download

    model_dir = get_model_dir()
    os.makedirs(model_dir, exist_ok=True)
    snapshot_download(
        repo_id=MODEL_ID,
        local_dir=model_dir,
        token=os.environ.get("HF_TOKEN"),
        local_dir_use_symlinks=False,
    )


def download_model_worker() -> None:
    global last_error

    try:
        total_bytes = get_model_total_bytes()
        update_download_state(
            total_bytes=total_bytes,
            downloaded_bytes=model_dir_size_bytes(),
        )
        download_model()
        downloaded_bytes = model_dir_size_bytes()
        if total_bytes:
            downloaded_bytes = min(downloaded_bytes, total_bytes)
        update_download_state(
            active=False,
            ok=True,
            error=None,
            downloaded_bytes=downloaded_bytes,
            finished_at=time.time(),
        )
        last_error = None
    except Exception as exc:
        message = str(exc)
        update_download_state(
            active=False,
            ok=False,
            error=message,
            downloaded_bytes=model_dir_size_bytes(),
            finished_at=time.time(),
        )
        last_error = message


def start_model_download() -> bool:
    with download_lock:
        if download_state["active"]:
            return False

        if model_is_installed():
            download_state.update(
                active=False,
                ok=True,
                error=None,
                downloaded_bytes=model_dir_size_bytes(),
                finished_at=time.time(),
            )
            return False

        download_state.update(
            active=True,
            ok=None,
            error=None,
            total_bytes=None,
            downloaded_bytes=model_dir_size_bytes(),
            started_at=time.time(),
            finished_at=None,
        )

    thread = threading.Thread(target=download_model_worker, daemon=True)
    thread.start()
    return True


def load_model() -> None:
    global processor, model, device, dtype, model_loading, last_error

    if processor is not None and model is not None:
        return

    with model_lock:
        if processor is not None and model is not None:
            return

        if not model_is_installed():
            raise RuntimeError(
                "Le modele local n'est pas installe. Lancez d'abord le telechargement."
            )

        model_loading = True
        try:
            torch = get_torch()
            from transformers import (
                LightOnOcrForConditionalGeneration,
                LightOnOcrProcessor,
            )

            model_dir = get_model_dir()
            processor = LightOnOcrProcessor.from_pretrained(model_dir)
            processor.image_processor.default_to_square = False

            device = pick_device(torch)
            dtype = pick_dtype(torch, device)

            load_kwargs = {"torch_dtype": dtype}
            if device == "cuda":
                load_kwargs["device_map"] = "auto"

            model = LightOnOcrForConditionalGeneration.from_pretrained(
                model_dir,
                **load_kwargs,
            ).eval()

            if device != "cuda":
                model.to(device)

            last_error = None
        except Exception as exc:
            processor = None
            model = None
            last_error = str(exc)
            raise
        finally:
            model_loading = False


def parse_bubbles(output_text: str):
    pattern = re.compile(r"(.+?)\s*\[(\d+),(\d+),(\d+),(\d+)\]")
    bubbles = []

    for line in output_text.strip().split("\n"):
        match = pattern.match(line.strip())
        if match:
            content = match.group(1).strip()
            coords = [int(match.group(i)) for i in range(2, 6)]
            bubbles.append({"content": content, "bbox": coords})

    return bubbles


@app.get("/health")
def health():
    try:
        torch = get_torch()
        cuda_available = bool(torch.cuda.is_available())
        mps_backend = getattr(torch.backends, "mps", None)
        mps_available = bool(mps_backend and mps_backend.is_available())
        selected_device = pick_device(torch)

        gpu_name = None
        gpu_memory_total_mb = None
        gpu_memory_allocated_mb = None
        gpu_memory_reserved_mb = None
        if cuda_available:
            try:
                device_index = torch.cuda.current_device()
                gpu_name = torch.cuda.get_device_name(device_index)
                gpu_memory_total_mb = int(
                    torch.cuda.get_device_properties(device_index).total_memory // (1024 * 1024)
                )
                gpu_memory_allocated_mb = cuda_memory_mb(torch, device_index, "memory_allocated")
                gpu_memory_reserved_mb = cuda_memory_mb(torch, device_index, "memory_reserved")
            except Exception as exc:
                gpu_name = f"CUDA visible, details unavailable: {exc}"

        return {
            "ok": True,
            "python_available": True,
            "torch_available": True,
            "cuda_available": cuda_available,
            "mps_available": mps_available,
            "device": selected_device,
            "torch_version": getattr(torch, "__version__", None),
            "cuda_version": getattr(getattr(torch, "version", None), "cuda", None),
            "gpu_name": gpu_name,
            "gpu_memory_total_mb": gpu_memory_total_mb,
            "gpu_memory_allocated_mb": gpu_memory_allocated_mb,
            "gpu_memory_reserved_mb": gpu_memory_reserved_mb,
            "model_loaded": processor is not None and model is not None,
        }
    except Exception as exc:
        return {
            "ok": False,
            "python_available": True,
            "torch_available": False,
            "cuda_available": False,
            "mps_available": False,
            "error": str(exc),
            "model_loaded": processor is not None and model is not None,
        }


@app.get("/model/status")
def model_status():
    installed = model_is_installed()
    loaded = processor is not None and model is not None
    return {
        "installed": installed,
        "loaded": loaded,
        "loading": model_loading,
        "ready": installed and loaded and not model_loading and last_error is None,
        "model_dir": get_model_dir(),
        "device": device,
        "dtype": dtype_name(dtype) if dtype is not None else None,
        "error": last_error,
        "download": download_status_snapshot(),
    }


@app.post("/model/load")
def model_load():
    global last_error

    try:
        load_model()
        return model_status()
    except Exception as exc:
        last_error = str(exc)
        status = model_status()
        status["error"] = str(exc)
        return JSONResponse(status_code=500, content=status)


@app.post("/model/download")
def model_download():
    try:
        started = start_model_download()
        return {
            "ok": True,
            "model_dir": get_model_dir(),
            "started": started,
            "download": download_status_snapshot(),
        }
    except Exception as exc:
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "model_dir": get_model_dir(),
                "error": str(exc),
                "download": download_status_snapshot(),
            },
        )


@app.post("/ocr")
def ocr(request: OcrRequest):
    global last_error

    start = time.perf_counter()
    try:
        try:
            image_bytes = base64.b64decode(request.image_bytes_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            return JSONResponse(
                status_code=400,
                content={"error": f"Image base64 invalide: {exc}"},
            )

        load_model()

        torch = get_torch()
        from PIL import Image

        with inference_lock:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            image.thumbnail(MAX_IMAGE_SIZE, Image.Resampling.LANCZOS)

            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image"},
                    ],
                }
            ]

            text_prompt = processor.apply_chat_template(
                messages,
                add_generation_prompt=True,
                tokenize=False,
            )

            inputs = processor(
                text=[text_prompt],
                images=[image],
                return_tensors="pt",
            )
            inputs = {
                key: value.to(device=device, dtype=dtype)
                if value.is_floating_point()
                else value.to(device)
                for key, value in inputs.items()
            }

            with torch.no_grad():
                output_ids = model.generate(
                    **inputs,
                    max_new_tokens=2048,
                    do_sample=False,
                )

            gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
            output_text = processor.decode(gen_ids, skip_special_tokens=True).strip()

        elapsed_ms = int((time.perf_counter() - start) * 1000)
        last_error = None
        return {
            "bubbles": parse_bubbles(output_text),
            "raw_text": output_text,
            "elapsed_ms": elapsed_ms,
        }
    except RuntimeError as exc:
        message = str(exc)
        if "out of memory" in message.lower():
            try:
                torch = get_torch()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            message = "Memoire GPU insuffisante pour l'inference locale."
        last_error = message
        return JSONResponse(status_code=500, content={"error": message})
    except Exception as exc:
        last_error = str(exc)
        return JSONResponse(status_code=500, content={"error": str(exc)})


def parse_args():
    parser = argparse.ArgumentParser(description="Poneglyph local OCR backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("The local OCR backend must only bind to 127.0.0.1.")

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
