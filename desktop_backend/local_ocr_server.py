import argparse
import base64
import binascii
import contextlib
import gc
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


BBOX_MODEL_KEY = "bbox"
TEXT_MODEL_KEY = "base"
DEFAULT_MODEL_KEY = BBOX_MODEL_KEY
MODEL_CONFIGS = {
    BBOX_MODEL_KEY: {
        "id": "Remidesbois/LightonOCR-2-1b-poneglyph-bbox",
        "dir_name": "lighton-ocr-poneglyph-bbox",
        "label": "Poneglyph BBox",
        "max_new_tokens": 2048,
    },
    TEXT_MODEL_KEY: {
        "id": "Remidesbois/LightonOCR-2-1b-poneglyph",
        "dir_name": "lighton-ocr-poneglyph",
        "label": "Poneglyph OCR",
        "max_new_tokens": 128,
    },
}
TEXT_USER_PROMPT = os.getenv(
    "LIGHTON_USER_PROMPT",
    "\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :",
)
MAX_IMAGE_SIZE = (1540, 1540)

def make_download_state():
    return {
        "active": False,
        "ok": None,
        "error": None,
        "total_bytes": None,
        "downloaded_bytes": 0,
        "started_at": None,
        "finished_at": None,
    }


model_states = {
    model_key: {
        "processor": None,
        "model": None,
        "device": None,
        "dtype": None,
        "loading": False,
        "last_error": None,
        "download": make_download_state(),
        "model_lock": threading.Lock(),
        "download_lock": threading.Lock(),
    }
    for model_key in MODEL_CONFIGS
}

inference_lock = threading.Lock()

app = FastAPI(title="Poneglyph Local OCR Backend")


class OcrRequest(BaseModel):
    image_bytes_base64: str


def normalize_model_key(model_key: str) -> str:
    if model_key not in MODEL_CONFIGS:
        raise ValueError(f"Modele local inconnu: {model_key}")
    return model_key


def get_model_state(model_key: str):
    return model_states[normalize_model_key(model_key)]


def default_app_model_dir(model_key: str = DEFAULT_MODEL_KEY) -> str:
    model_key = normalize_model_key(model_key)
    system = platform.system().lower()
    home = Path.home()

    if system == "darwin":
        base_dir = home / "Library" / "Application Support" / "poneglyph"
    elif system == "windows":
        base_dir = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "poneglyph"
    else:
        base_dir = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share")) / "poneglyph"

    return str(base_dir / "models" / MODEL_CONFIGS[model_key]["dir_name"])


def get_model_dir(model_key: str = DEFAULT_MODEL_KEY) -> str:
    model_key = normalize_model_key(model_key)
    if model_key == BBOX_MODEL_KEY:
        return (
            os.environ.get("PONEGLYPH_BBOX_MODEL_DIR")
            or os.environ.get("PONEGLYPH_MODEL_DIR")
            or default_app_model_dir(model_key)
        )

    return os.environ.get("PONEGLYPH_BASE_MODEL_DIR") or default_app_model_dir(model_key)


def model_is_installed(model_key: str = DEFAULT_MODEL_KEY) -> bool:
    return os.path.exists(os.path.join(get_model_dir(model_key), "config.json"))


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


def clear_torch_cache(torch_module) -> None:
    gc.collect()
    try:
        if torch_module.cuda.is_available():
            torch_module.cuda.empty_cache()
    except Exception:
        pass

    try:
        mps_module = getattr(torch_module, "mps", None)
        if mps_module and hasattr(mps_module, "empty_cache"):
            mps_module.empty_cache()
    except Exception:
        pass


def generation_autocast_context(torch_module, selected_device: str, selected_dtype):
    if selected_device == "cuda" and selected_dtype in {torch_module.float16, torch_module.bfloat16}:
        return torch_module.autocast(device_type="cuda", dtype=selected_dtype)

    return contextlib.nullcontext()


def model_dir_size_bytes(model_key: str = DEFAULT_MODEL_KEY) -> int:
    model_dir = get_model_dir(model_key)
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


def get_model_total_bytes(model_key: str = DEFAULT_MODEL_KEY) -> Optional[int]:
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(
            MODEL_CONFIGS[normalize_model_key(model_key)]["id"],
            files_metadata=True,
            token=os.environ.get("HF_TOKEN"),
        )
        return int(sum(sibling.size or 0 for sibling in info.siblings))
    except Exception:
        return None


def update_download_state(model_key: str, **updates) -> None:
    state = get_model_state(model_key)
    with state["download_lock"]:
        state["download"].update(updates)


def download_status_snapshot(model_key: str = DEFAULT_MODEL_KEY):
    model_state = get_model_state(model_key)
    with model_state["download_lock"]:
        state = dict(model_state["download"])

    downloaded_bytes = model_dir_size_bytes(model_key)
    total_bytes = state.get("total_bytes")
    if total_bytes:
        downloaded_bytes = min(downloaded_bytes, total_bytes)

    with model_state["download_lock"]:
        model_state["download"]["downloaded_bytes"] = downloaded_bytes
        state = dict(model_state["download"])

    return state


def cuda_memory_mb(torch_module, device_index: int, value_name: str) -> Optional[int]:
    try:
        value = getattr(torch_module.cuda, value_name)(device_index)
        return int(value // (1024 * 1024))
    except Exception:
        return None


def download_model(model_key: str = DEFAULT_MODEL_KEY) -> None:
    from huggingface_hub import snapshot_download

    model_key = normalize_model_key(model_key)
    model_dir = get_model_dir(model_key)
    os.makedirs(model_dir, exist_ok=True)
    snapshot_download(
        repo_id=MODEL_CONFIGS[model_key]["id"],
        local_dir=model_dir,
        token=os.environ.get("HF_TOKEN"),
        local_dir_use_symlinks=False,
    )


def download_model_worker(model_key: str) -> None:
    state = get_model_state(model_key)
    try:
        total_bytes = get_model_total_bytes(model_key)
        update_download_state(
            model_key,
            total_bytes=total_bytes,
            downloaded_bytes=model_dir_size_bytes(model_key),
        )
        download_model(model_key)
        downloaded_bytes = model_dir_size_bytes(model_key)
        if total_bytes:
            downloaded_bytes = min(downloaded_bytes, total_bytes)
        update_download_state(
            model_key,
            active=False,
            ok=True,
            error=None,
            downloaded_bytes=downloaded_bytes,
            finished_at=time.time(),
        )
        state["last_error"] = None
    except Exception as exc:
        message = str(exc)
        update_download_state(
            model_key,
            active=False,
            ok=False,
            error=message,
            downloaded_bytes=model_dir_size_bytes(model_key),
            finished_at=time.time(),
        )
        state["last_error"] = message


def start_model_download(model_key: str = DEFAULT_MODEL_KEY) -> bool:
    state = get_model_state(model_key)
    with state["download_lock"]:
        if state["download"]["active"]:
            return False

        if model_is_installed(model_key):
            state["download"].update(
                active=False,
                ok=True,
                error=None,
                downloaded_bytes=model_dir_size_bytes(model_key),
                finished_at=time.time(),
            )
            return False

        state["download"].update(
            active=True,
            ok=None,
            error=None,
            total_bytes=None,
            downloaded_bytes=model_dir_size_bytes(model_key),
            started_at=time.time(),
            finished_at=None,
        )

    thread = threading.Thread(target=download_model_worker, args=(model_key,), daemon=True)
    thread.start()
    return True


def load_model(model_key: str = DEFAULT_MODEL_KEY) -> None:
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)

    if state["processor"] is not None and state["model"] is not None:
        return

    with state["model_lock"]:
        if state["processor"] is not None and state["model"] is not None:
            return

        if not model_is_installed(model_key):
            raise RuntimeError(
                "Le modele local n'est pas installe. Lancez d'abord le telechargement."
            )

        state["loading"] = True
        try:
            torch = get_torch()
            from transformers import (
                LightOnOcrForConditionalGeneration,
                LightOnOcrProcessor,
            )

            model_dir = get_model_dir(model_key)
            loaded_processor = LightOnOcrProcessor.from_pretrained(model_dir)
            loaded_processor.image_processor.default_to_square = False
            if model_key == TEXT_MODEL_KEY:
                loaded_processor.tokenizer.padding_side = "left"

            selected_device = pick_device(torch)
            selected_dtype = pick_dtype(torch, selected_device)

            load_kwargs = {"torch_dtype": selected_dtype}

            loaded_model = LightOnOcrForConditionalGeneration.from_pretrained(
                model_dir,
                **load_kwargs,
            ).eval()

            loaded_model.to(device=selected_device, dtype=selected_dtype)

            state["processor"] = loaded_processor
            state["model"] = loaded_model
            state["device"] = selected_device
            state["dtype"] = selected_dtype
            state["last_error"] = None
        except Exception as exc:
            state["processor"] = None
            state["model"] = None
            state["last_error"] = str(exc)
            try:
                clear_torch_cache(torch)
            except Exception:
                pass
            raise
        finally:
            state["loading"] = False


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


def model_status_payload(model_key: str = DEFAULT_MODEL_KEY):
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)
    installed = model_is_installed(model_key)
    loaded = state["processor"] is not None and state["model"] is not None
    return {
        "installed": installed,
        "loaded": loaded,
        "loading": state["loading"],
        "ready": installed and loaded and not state["loading"] and state["last_error"] is None,
        "model_dir": get_model_dir(model_key),
        "device": state["device"],
        "dtype": dtype_name(state["dtype"]) if state["dtype"] is not None else None,
        "error": state["last_error"],
        "download": download_status_snapshot(model_key),
    }


def loaded_models_payload():
    return {model_key: model_status_payload(model_key) for model_key in MODEL_CONFIGS}


def decode_image_request(request: OcrRequest):
    try:
        return base64.b64decode(request.image_bytes_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        return JSONResponse(
            status_code=400,
            content={"error": f"Image base64 invalide: {exc}"},
        )


def generate_with_model(model_key: str, image, messages):
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)
    torch = get_torch()
    loaded_processor = state["processor"]
    loaded_model = state["model"]
    selected_device = state["device"]
    selected_dtype = state["dtype"]

    text_prompt = loaded_processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=False,
    )

    inputs = loaded_processor(
        text=[text_prompt],
        images=[image],
        return_tensors="pt",
    )
    inputs = {
        key: value.to(device=selected_device, dtype=selected_dtype)
        if value.is_floating_point()
        else value.to(selected_device)
        for key, value in inputs.items()
    }

    with torch.inference_mode(), generation_autocast_context(torch, selected_device, selected_dtype):
        output_ids = loaded_model.generate(
            **inputs,
            max_new_tokens=MODEL_CONFIGS[model_key]["max_new_tokens"],
            do_sample=False,
        )

    gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    if model_key == TEXT_MODEL_KEY:
        return loaded_processor.tokenizer.decode(gen_ids, skip_special_tokens=True).strip()
    return loaded_processor.decode(gen_ids, skip_special_tokens=True).strip()


def record_runtime_error(model_key: str, exc: RuntimeError) -> str:
    message = str(exc)
    if "out of memory" in message.lower():
        try:
            torch = get_torch()
            clear_torch_cache(torch)
        except Exception:
            pass
        message = "Memoire GPU insuffisante pour l'inference locale."
    get_model_state(model_key)["last_error"] = message
    return message


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
            "model_loaded": get_model_state(BBOX_MODEL_KEY)["processor"] is not None
            and get_model_state(BBOX_MODEL_KEY)["model"] is not None,
            "models": loaded_models_payload(),
        }
    except Exception as exc:
        return {
            "ok": False,
            "python_available": True,
            "torch_available": False,
            "cuda_available": False,
            "mps_available": False,
            "error": str(exc),
            "model_loaded": get_model_state(BBOX_MODEL_KEY)["processor"] is not None
            and get_model_state(BBOX_MODEL_KEY)["model"] is not None,
            "models": loaded_models_payload(),
        }


@app.get("/model/status")
def model_status(model_key: str = DEFAULT_MODEL_KEY):
    try:
        return model_status_payload(model_key)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/model/load")
def model_load(model_key: str = DEFAULT_MODEL_KEY):
    try:
        model_key = normalize_model_key(model_key)
        with inference_lock:
            load_model(model_key)
        return model_status_payload(model_key)
    except Exception as exc:
        if model_key in MODEL_CONFIGS:
            get_model_state(model_key)["last_error"] = str(exc)
            status = model_status_payload(model_key)
        else:
            status = {"error": str(exc)}
        status["error"] = str(exc)
        return JSONResponse(status_code=500, content=status)


@app.post("/model/download")
def model_download(model_key: str = DEFAULT_MODEL_KEY):
    try:
        model_key = normalize_model_key(model_key)
        started = start_model_download(model_key)
        return {
            "ok": True,
            "model_dir": get_model_dir(model_key),
            "started": started,
            "download": download_status_snapshot(model_key),
        }
    except Exception as exc:
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "model_dir": get_model_dir(model_key) if model_key in MODEL_CONFIGS else "",
                "error": str(exc),
                "download": download_status_snapshot(model_key) if model_key in MODEL_CONFIGS else None,
            },
        )


@app.post("/ocr")
def ocr(request: OcrRequest):
    start = time.perf_counter()
    model_key = BBOX_MODEL_KEY
    try:
        image_bytes = decode_image_request(request)
        if isinstance(image_bytes, JSONResponse):
            return image_bytes

        from PIL import Image

        with inference_lock:
            load_model(model_key)
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

            output_text = generate_with_model(model_key, image, messages)

        elapsed_ms = int((time.perf_counter() - start) * 1000)
        get_model_state(model_key)["last_error"] = None
        return {
            "bubbles": parse_bubbles(output_text),
            "raw_text": output_text,
            "elapsed_ms": elapsed_ms,
        }
    except RuntimeError as exc:
        message = record_runtime_error(model_key, exc)
        return JSONResponse(status_code=500, content={"error": message})
    except Exception as exc:
        get_model_state(model_key)["last_error"] = str(exc)
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.post("/ocr/text")
def text_ocr(request: OcrRequest):
    start = time.perf_counter()
    model_key = TEXT_MODEL_KEY
    try:
        image_bytes = decode_image_request(request)
        if isinstance(image_bytes, JSONResponse):
            return image_bytes

        from PIL import Image

        with inference_lock:
            load_model(model_key)
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image"},
                        {"type": "text", "text": TEXT_USER_PROMPT},
                    ],
                }
            ]
            output_text = generate_with_model(model_key, image, messages)

        text = output_text.split("\n")[0].strip() if "\n" in output_text else output_text.strip()
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        get_model_state(model_key)["last_error"] = None
        return {
            "text": text,
            "raw_text": output_text,
            "elapsed_ms": elapsed_ms,
        }
    except RuntimeError as exc:
        message = record_runtime_error(model_key, exc)
        return JSONResponse(status_code=500, content={"error": message})
    except Exception as exc:
        get_model_state(model_key)["last_error"] = str(exc)
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
