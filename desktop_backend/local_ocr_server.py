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
BACKEND_AUTO = "auto"
BACKEND_TRANSFORMERS = "transformers"
BACKEND_VLLM = "vllm"
BACKEND_NOT_LOADED = "not_loaded"
VALID_INFERENCE_BACKENDS = {BACKEND_AUTO, BACKEND_TRANSFORMERS, BACKEND_VLLM}
VLLM_LIGHTONOCR_ARCHITECTURES = {
    "LightOnOCRForConditionalGeneration",
    "LightOnOcrForConditionalGeneration",
}


def env_bool(name: str, default: bool) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() not in {"0", "false", "no", "off", ""}


def env_int(name: str, default: int, minimum: Optional[int] = None) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None or raw_value.strip() == "":
        return default
    try:
        value = int(raw_value)
    except ValueError:
        return default
    if minimum is not None and value < minimum:
        return default
    return value


def env_optional_int(name: str, minimum: Optional[int] = None) -> Optional[int]:
    raw_value = os.environ.get(name)
    if raw_value is None or raw_value.strip() == "":
        return None
    try:
        value = int(raw_value)
    except ValueError:
        return None
    if minimum is not None and value < minimum:
        return None
    return value


def env_float(
    name: str,
    default: float,
    minimum: Optional[float] = None,
    maximum: Optional[float] = None,
) -> float:
    raw_value = os.environ.get(name)
    if raw_value is None or raw_value.strip() == "":
        return default
    try:
        value = float(raw_value)
    except ValueError:
        return default
    if minimum is not None and value < minimum:
        return default
    if maximum is not None and value > maximum:
        return default
    return value


def get_requested_backend() -> str:
    requested_backend = os.environ.get("PONEGLYPH_INFERENCE_BACKEND", BACKEND_AUTO)
    requested_backend = requested_backend.strip().lower()
    if requested_backend not in VALID_INFERENCE_BACKENDS:
        return BACKEND_AUTO
    return requested_backend


def get_max_new_tokens(model_key: str) -> int:
    model_key = normalize_model_key(model_key)
    env_name = (
        "PONEGLYPH_BBOX_MAX_NEW_TOKENS"
        if model_key == BBOX_MODEL_KEY
        else "PONEGLYPH_TEXT_MAX_NEW_TOKENS"
    )
    return env_int(env_name, MODEL_CONFIGS[model_key]["max_new_tokens"], minimum=1)


def perf_options_payload():
    return {
        "torch_compile": env_bool("PONEGLYPH_TORCH_COMPILE", False),
        "flash_attn": env_bool("PONEGLYPH_FLASH_ATTN", True),
        "tf32": env_bool("PONEGLYPH_TF32", True),
        "warmup": env_bool("PONEGLYPH_WARMUP", True),
        "text_max_new_tokens": get_max_new_tokens(TEXT_MODEL_KEY),
        "bbox_max_new_tokens": get_max_new_tokens(BBOX_MODEL_KEY),
        "vllm_gpu_memory_utilization": env_float(
            "PONEGLYPH_VLLM_GPU_MEMORY_UTILIZATION",
            0.85,
            minimum=0.01,
            maximum=1.0,
        ),
        "vllm_max_model_len": env_optional_int("PONEGLYPH_VLLM_MAX_MODEL_LEN", minimum=1),
        "vllm_enforce_eager": env_bool("PONEGLYPH_VLLM_ENFORCE_EAGER", False),
    }


def backend_attempt_order(requested_backend: str, selected_device: str):
    if requested_backend == BACKEND_TRANSFORMERS:
        return [BACKEND_TRANSFORMERS]
    if requested_backend == BACKEND_VLLM:
        return [BACKEND_VLLM, BACKEND_TRANSFORMERS]
    if selected_device == "cuda":
        return [BACKEND_VLLM, BACKEND_TRANSFORMERS]
    return [BACKEND_TRANSFORMERS]


def format_backend_fallback_reason(exc: Exception) -> str:
    return f"vLLM unavailable, using transformers fallback: {exc}"

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
        "requested_backend": None,
        "active_backend": None,
        "backend_fallback_reason": None,
        "backend_error": None,
        "attention_implementation": None,
        "compiled": False,
        "compile_error": None,
        "warmup_error": None,
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


def configure_torch_runtime(torch_module) -> None:
    if not env_bool("PONEGLYPH_TF32", True):
        return

    try:
        if not torch_module.cuda.is_available():
            return
    except Exception:
        return

    try:
        torch_module.backends.cuda.matmul.allow_tf32 = True
    except Exception:
        pass

    try:
        torch_module.backends.cudnn.allow_tf32 = True
    except Exception:
        pass

    try:
        torch_module.set_float32_matmul_precision("high")
    except Exception:
        pass


def get_torch():
    import torch

    configure_torch_runtime(torch)
    return torch


def inspect_vllm_availability(selected_device: str):
    if selected_device != "cuda":
        return False, f"vLLM backend requires CUDA; selected device is {selected_device}"

    try:
        import vllm  # noqa: F401
    except Exception as exc:
        return False, f"vLLM import failed: {exc}"

    return True, None


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
    if selected_dtype is None:
        return None
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


def model_is_loaded_for_request(model_key: str, requested_backend: str) -> bool:
    state = get_model_state(model_key)
    return (
        state["processor"] is not None
        and state["model"] is not None
        and state["requested_backend"] == requested_backend
    )


def clear_loaded_model_state(state) -> None:
    state["processor"] = None
    state["model"] = None
    state["device"] = None
    state["dtype"] = None
    state["requested_backend"] = None
    state["active_backend"] = None
    state["backend_fallback_reason"] = None
    state["backend_error"] = None
    state["attention_implementation"] = None
    state["compiled"] = False
    state["compile_error"] = None
    state["warmup_error"] = None


def load_processor(model_key: str):
    from transformers import LightOnOcrProcessor

    model_dir = get_model_dir(model_key)
    loaded_processor = LightOnOcrProcessor.from_pretrained(model_dir)
    loaded_processor.image_processor.default_to_square = False
    if model_key == TEXT_MODEL_KEY:
        loaded_processor.tokenizer.padding_side = "left"
    return loaded_processor


def transformer_attention_attempts(selected_device: str):
    attempts = []
    if selected_device == "cuda" and env_bool("PONEGLYPH_FLASH_ATTN", True):
        attempts.append(("flash_attention_2", {"attn_implementation": "flash_attention_2"}))
    attempts.append(("sdpa", {"attn_implementation": "sdpa"}))
    attempts.append(("default", {}))
    return attempts


def load_transformers_model(model_key: str, selected_device: str, selected_dtype):
    from transformers import LightOnOcrForConditionalGeneration

    model_dir = get_model_dir(model_key)
    errors = []
    for attention_name, attention_kwargs in transformer_attention_attempts(selected_device):
        try:
            model = LightOnOcrForConditionalGeneration.from_pretrained(
                model_dir,
                torch_dtype=selected_dtype,
                **attention_kwargs,
            ).eval()
            return model, attention_name
        except Exception as exc:
            errors.append(f"{attention_name}: {exc}")
            try:
                clear_torch_cache(get_torch())
            except Exception:
                pass

    raise RuntimeError(
        "Impossible de charger le modele transformers avec les implementations "
        f"d'attention disponibles: {' | '.join(errors)}"
    )


def maybe_compile_transformers_model(torch_module, model, selected_device: str):
    if selected_device != "cuda" or not env_bool("PONEGLYPH_TORCH_COMPILE", False):
        return model, False, None

    compile_fn = getattr(torch_module, "compile", None)
    if compile_fn is None:
        return model, False, "torch.compile indisponible dans cette version de PyTorch."

    try:
        return compile_fn(model, mode="reduce-overhead", fullgraph=False), True, None
    except Exception as exc:
        return model, False, f"torch.compile a echoue, modele non compile: {exc}"


def load_transformers_backend(
    model_key: str,
    loaded_processor,
    selected_device: str,
    selected_dtype,
    requested_backend: str,
    fallback_reason: Optional[str] = None,
) -> None:
    state = get_model_state(model_key)
    torch = get_torch()

    loaded_model, attention_implementation = load_transformers_model(
        model_key,
        selected_device,
        selected_dtype,
    )
    loaded_model.to(device=selected_device, dtype=selected_dtype)
    loaded_model, compiled, compile_error = maybe_compile_transformers_model(
        torch,
        loaded_model,
        selected_device,
    )

    state["processor"] = loaded_processor
    state["model"] = loaded_model
    state["device"] = selected_device
    state["dtype"] = selected_dtype
    state["requested_backend"] = requested_backend
    state["active_backend"] = BACKEND_TRANSFORMERS
    state["backend_fallback_reason"] = fallback_reason
    state["backend_error"] = fallback_reason
    state["attention_implementation"] = attention_implementation
    state["compiled"] = compiled
    state["compile_error"] = compile_error
    state["last_error"] = None


def model_architectures(model_dir: str):
    try:
        from transformers import AutoConfig

        config = AutoConfig.from_pretrained(
            model_dir,
            local_files_only=True,
            trust_remote_code=True,
        )
        return list(getattr(config, "architectures", []) or [])
    except Exception as exc:
        raise RuntimeError(f"Impossible d'inspecter l'architecture du modele pour vLLM: {exc}") from exc


def ensure_vllm_model_supported(model_dir: str) -> None:
    architectures = model_architectures(model_dir)
    if not architectures:
        return

    # vLLM has a native LightOnOCR runner in recent releases. Older builds still
    # fail during registry/engine initialization, which is handled as fallback.
    if any(architecture in VLLM_LIGHTONOCR_ARCHITECTURES for architecture in architectures):
        return

    # Surface this exact class of failure in status instead of pretending that
    # an arbitrary multimodal processor can run through vLLM.
    raise RuntimeError(
        "vLLM unavailable/unsupported for this architecture: "
        f"{', '.join(architectures)}"
    )


def vllm_load_kwargs(model_dir: str):
    kwargs = {
        "model": model_dir,
        "trust_remote_code": True,
        "gpu_memory_utilization": env_float(
            "PONEGLYPH_VLLM_GPU_MEMORY_UTILIZATION",
            0.85,
            minimum=0.01,
            maximum=1.0,
        ),
        "limit_mm_per_prompt": {"image": 1},
    }

    max_model_len = env_optional_int("PONEGLYPH_VLLM_MAX_MODEL_LEN", minimum=1)
    if max_model_len is not None:
        kwargs["max_model_len"] = max_model_len

    if env_bool("PONEGLYPH_VLLM_ENFORCE_EAGER", False):
        kwargs["enforce_eager"] = True

    return kwargs


def load_vllm_backend(
    model_key: str,
    loaded_processor,
    selected_device: str,
    requested_backend: str,
) -> None:
    available, reason = inspect_vllm_availability(selected_device)
    if not available:
        raise RuntimeError(reason)

    model_dir = get_model_dir(model_key)
    ensure_vllm_model_supported(model_dir)

    from vllm import LLM

    loaded_model = LLM(**vllm_load_kwargs(model_dir))
    state = get_model_state(model_key)
    state["processor"] = loaded_processor
    state["model"] = loaded_model
    state["device"] = selected_device
    state["dtype"] = "auto"
    state["requested_backend"] = requested_backend
    state["active_backend"] = BACKEND_VLLM
    state["backend_fallback_reason"] = None
    state["backend_error"] = None
    state["attention_implementation"] = None
    state["compiled"] = False
    state["compile_error"] = None
    state["last_error"] = None


def messages_for_model(model_key: str):
    if model_key == TEXT_MODEL_KEY:
        return [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": TEXT_USER_PROMPT},
                ],
            }
        ]

    return [
        {
            "role": "user",
            "content": [
                {"type": "image"},
            ],
        }
    ]


def maybe_warmup_model(model_key: str) -> None:
    state = get_model_state(model_key)
    state["warmup_error"] = None
    if state["device"] != "cuda" or not env_bool("PONEGLYPH_WARMUP", True):
        return

    try:
        from PIL import Image

        warmup_image = Image.new("RGB", (64, 64), (240, 240, 240))
        generate_with_model(
            model_key,
            warmup_image,
            messages_for_model(model_key),
            max_new_tokens_override=1,
        )
    except Exception as exc:
        state["warmup_error"] = f"Warmup ignore: {exc}"


def load_model(model_key: str = DEFAULT_MODEL_KEY) -> None:
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)
    requested_backend = get_requested_backend()

    if model_is_loaded_for_request(model_key, requested_backend):
        return

    with state["model_lock"]:
        if model_is_loaded_for_request(model_key, requested_backend):
            return

        if not model_is_installed(model_key):
            raise RuntimeError(
                "Le modele local n'est pas installe. Lancez d'abord le telechargement."
            )

        state["loading"] = True
        clear_loaded_model_state(state)
        try:
            torch = get_torch()
            selected_device = pick_device(torch)
            selected_dtype = pick_dtype(torch, selected_device)
            loaded_processor = load_processor(model_key)
            fallback_reason = None

            for backend_name in backend_attempt_order(requested_backend, selected_device):
                try:
                    if backend_name == BACKEND_VLLM:
                        load_vllm_backend(
                            model_key,
                            loaded_processor,
                            selected_device,
                            requested_backend,
                        )
                    else:
                        load_transformers_backend(
                            model_key,
                            loaded_processor,
                            selected_device,
                            selected_dtype,
                            requested_backend,
                            fallback_reason=fallback_reason,
                        )
                    maybe_warmup_model(model_key)
                    return
                except Exception as exc:
                    if backend_name == BACKEND_VLLM:
                        fallback_reason = format_backend_fallback_reason(exc)
                        state["backend_fallback_reason"] = fallback_reason
                        state["backend_error"] = fallback_reason
                        continue

                    if fallback_reason:
                        raise RuntimeError(
                            f"{fallback_reason}; transformers fallback failed: {exc}"
                        ) from exc
                    raise

            raise RuntimeError("Aucun backend d'inference local disponible.")
        except Exception as exc:
            clear_loaded_model_state(state)
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
        "requested_backend": get_requested_backend(),
        "active_backend": state["active_backend"] or BACKEND_NOT_LOADED,
        "backend_fallback_reason": state["backend_fallback_reason"],
        "backend_error": state["backend_error"],
        "perf_options": perf_options_payload(),
        "max_new_tokens": get_max_new_tokens(model_key),
        "attention_implementation": state["attention_implementation"],
        "compiled": state["compiled"],
        "compile_error": state["compile_error"],
        "warmup_error": state["warmup_error"],
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


def runtime_metadata_payload(model_key: str):
    state = get_model_state(model_key)
    return {
        "device": state["device"],
        "dtype": dtype_name(state["dtype"]) if state["dtype"] is not None else None,
        "active_backend": state["active_backend"] or BACKEND_NOT_LOADED,
        "requested_backend": get_requested_backend(),
        "backend_fallback_reason": state["backend_fallback_reason"],
    }


def render_prompt(loaded_processor, messages):
    return loaded_processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=False,
    )


def move_inputs_to_device(inputs, selected_device: str, selected_dtype):
    moved_inputs = {}
    for key, value in inputs.items():
        if not hasattr(value, "to"):
            moved_inputs[key] = value
            continue

        to_kwargs = {"device": selected_device}
        try:
            if value.is_floating_point():
                to_kwargs["dtype"] = selected_dtype
        except Exception:
            pass

        try:
            moved_inputs[key] = value.to(**to_kwargs, non_blocking=True)
        except TypeError:
            moved_inputs[key] = value.to(**to_kwargs)

    return moved_inputs


def transformers_generate(model_key: str, image, messages, max_new_tokens_override: Optional[int]):
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)
    torch = get_torch()
    loaded_processor = state["processor"]
    loaded_model = state["model"]
    selected_device = state["device"]
    selected_dtype = state["dtype"]

    text_prompt = render_prompt(loaded_processor, messages)
    inputs = loaded_processor(
        text=[text_prompt],
        images=[image],
        return_tensors="pt",
    )
    inputs = move_inputs_to_device(inputs, selected_device, selected_dtype)

    with torch.inference_mode(), generation_autocast_context(torch, selected_device, selected_dtype):
        output_ids = loaded_model.generate(
            **inputs,
            max_new_tokens=max_new_tokens_override or get_max_new_tokens(model_key),
            do_sample=False,
        )

    gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    if model_key == TEXT_MODEL_KEY:
        return loaded_processor.tokenizer.decode(gen_ids, skip_special_tokens=True).strip()
    return loaded_processor.decode(gen_ids, skip_special_tokens=True).strip()


def vllm_generate(model_key: str, image, messages, max_new_tokens_override: Optional[int]):
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)
    loaded_processor = state["processor"]
    loaded_model = state["model"]
    text_prompt = render_prompt(loaded_processor, messages)

    from vllm import SamplingParams

    sampling_params = SamplingParams(
        temperature=0,
        max_tokens=max_new_tokens_override or get_max_new_tokens(model_key),
    )
    outputs = loaded_model.generate(
        {
            "prompt": text_prompt,
            "multi_modal_data": {"image": image},
        },
        sampling_params=sampling_params,
    )
    return outputs[0].outputs[0].text.strip()


def fallback_vllm_generation_to_transformers(model_key: str, reason: str) -> None:
    state = get_model_state(model_key)
    torch = get_torch()
    selected_device = pick_device(torch)
    selected_dtype = pick_dtype(torch, selected_device)
    loaded_processor = state["processor"] or load_processor(model_key)
    load_transformers_backend(
        model_key,
        loaded_processor,
        selected_device,
        selected_dtype,
        get_requested_backend(),
        fallback_reason=reason,
    )


def generate_with_model(
    model_key: str,
    image,
    messages,
    max_new_tokens_override: Optional[int] = None,
):
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)
    active_backend = state["active_backend"]

    if active_backend == BACKEND_VLLM:
        try:
            return vllm_generate(model_key, image, messages, max_new_tokens_override)
        except Exception as exc:
            reason = format_backend_fallback_reason(exc)
            fallback_vllm_generation_to_transformers(model_key, reason)
            return transformers_generate(model_key, image, messages, max_new_tokens_override)

    if active_backend == BACKEND_TRANSFORMERS:
        return transformers_generate(model_key, image, messages, max_new_tokens_override)

    raise RuntimeError("Aucun modele local charge pour l'inference.")


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
    default_state = get_model_state(BBOX_MODEL_KEY)
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
            "requested_backend": get_requested_backend(),
            "active_backend": default_state["active_backend"] or BACKEND_NOT_LOADED,
            "backend_fallback_reason": default_state["backend_fallback_reason"],
            "perf_options": perf_options_payload(),
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
            "requested_backend": get_requested_backend(),
            "active_backend": default_state["active_backend"] or BACKEND_NOT_LOADED,
            "backend_fallback_reason": default_state["backend_fallback_reason"],
            "perf_options": perf_options_payload(),
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

            preprocess_start = time.perf_counter()
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            image.thumbnail(MAX_IMAGE_SIZE, Image.Resampling.LANCZOS)
            messages = messages_for_model(model_key)
            preprocess_ms = int((time.perf_counter() - preprocess_start) * 1000)

            generate_start = time.perf_counter()
            output_text = generate_with_model(model_key, image, messages)
            generate_ms = int((time.perf_counter() - generate_start) * 1000)

        postprocess_start = time.perf_counter()
        bubbles = parse_bubbles(output_text)
        postprocess_ms = int((time.perf_counter() - postprocess_start) * 1000)
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        get_model_state(model_key)["last_error"] = None
        return {
            "bubbles": bubbles,
            "raw_text": output_text,
            "elapsed_ms": elapsed_ms,
            "preprocess_ms": preprocess_ms,
            "generate_ms": generate_ms,
            "postprocess_ms": postprocess_ms,
            **runtime_metadata_payload(model_key),
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

            preprocess_start = time.perf_counter()
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            messages = messages_for_model(model_key)
            preprocess_ms = int((time.perf_counter() - preprocess_start) * 1000)

            generate_start = time.perf_counter()
            output_text = generate_with_model(model_key, image, messages)
            generate_ms = int((time.perf_counter() - generate_start) * 1000)

        postprocess_start = time.perf_counter()
        text = output_text.split("\n")[0].strip() if "\n" in output_text else output_text.strip()
        postprocess_ms = int((time.perf_counter() - postprocess_start) * 1000)
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        get_model_state(model_key)["last_error"] = None
        return {
            "text": text,
            "raw_text": output_text,
            "elapsed_ms": elapsed_ms,
            "preprocess_ms": preprocess_ms,
            "generate_ms": generate_ms,
            "postprocess_ms": postprocess_ms,
            **runtime_metadata_payload(model_key),
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
