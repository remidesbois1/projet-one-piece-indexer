import argparse
import base64
import binascii
import contextlib
import gc
import hashlib
import io
import json
import os
import platform
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


BBOX_MODEL_KEY = "bbox"
TEXT_MODEL_KEY = "base"
SURYA_MODEL_KEY = "surya"
SURYA_BBOX_MODEL_KEY = "surya_bbox"
DEFAULT_MODEL_KEY = BBOX_MODEL_KEY
MODEL_REGISTRY_PATH = Path(__file__).with_name("model_registry.json")
MODEL_REGISTRY_SHA256 = "af553149bde39a0600da38a63c859eb535d0b1a0e2134f1ccab8bbb41acfa8b0"
UNSAFE_MODEL_DIR_OVERRIDE_ENV = "PONEGLYPH_ALLOW_UNVERIFIED_MODEL_DIRS"
MODEL_INSTALL_METADATA_FILENAME = ".poneglyph-model.json"
RUNTIME_MODEL_FILES = frozenset(
    {
        "chat_template.jinja",
        "config.json",
        "generation_config.json",
        "model.safetensors",
        "processor_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
    }
)
FORBIDDEN_UNMANIFESTED_SUFFIXES = frozenset(
    {".bat", ".cmd", ".dll", ".dylib", ".exe", ".pyd", ".py", ".ps1", ".sh", ".so"}
)


class ModelIntegrityError(RuntimeError):
    pass


def load_model_registry(path: Path = MODEL_REGISTRY_PATH):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Registre de modeles illisible: {exc}") from exc

    canonical_payload = json.dumps(
        payload,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if hashlib.sha256(canonical_payload).hexdigest() != MODEL_REGISTRY_SHA256:
        raise RuntimeError("Le registre de modeles ne correspond pas a l'ancre integree.")

    if payload.get("schema_version") != 1:
        raise RuntimeError("Version de registre de modeles non prise en charge.")

    models = payload.get("models")
    expected_keys = {
        BBOX_MODEL_KEY,
        TEXT_MODEL_KEY,
        SURYA_MODEL_KEY,
        SURYA_BBOX_MODEL_KEY,
    }
    if not isinstance(models, dict) or set(models) != expected_keys:
        raise RuntimeError("Le registre doit definir exactement les quatre modeles locaux.")

    sha_pattern = re.compile(r"^[0-9a-f]{64}$")
    revision_pattern = re.compile(r"^[0-9a-f]{40}$")
    for model_key, entry in models.items():
        if not isinstance(entry, dict):
            raise RuntimeError(f"Entree de registre invalide pour {model_key}.")
        if not isinstance(entry.get("repo_id"), str) or entry["repo_id"].count("/") != 1:
            raise RuntimeError(f"Depot Hugging Face invalide pour {model_key}.")
        if not revision_pattern.fullmatch(str(entry.get("revision", ""))):
            raise RuntimeError(f"Revision immuable invalide pour {model_key}.")
        dir_name = entry.get("dir_name")
        if (
            not isinstance(dir_name, str)
            or not dir_name.strip()
            or PurePosixPath(dir_name).name != dir_name
            or PureWindowsPath(dir_name).name != dir_name
        ):
            raise RuntimeError(f"Dossier de modele invalide pour {model_key}.")
        if entry.get("trust_remote_code") is not False:
            raise RuntimeError(f"Le code distant doit rester desactive pour {model_key}.")

        files = entry.get("files")
        if not isinstance(files, list) or not files:
            raise RuntimeError(f"Manifeste de fichiers absent pour {model_key}.")

        seen_paths = set()
        for file_entry in files:
            if not isinstance(file_entry, dict):
                raise RuntimeError(f"Fichier de registre invalide pour {model_key}.")
            raw_path = file_entry.get("path")
            relative_path = PurePosixPath(str(raw_path))
            if (
                not isinstance(raw_path, str)
                or raw_path != relative_path.as_posix()
                or relative_path.is_absolute()
                or ".." in relative_path.parts
                or PureWindowsPath(raw_path).is_absolute()
                or PureWindowsPath(raw_path).drive
                or ".." in PureWindowsPath(raw_path).parts
                or "\\" in raw_path
                or raw_path in seen_paths
            ):
                raise RuntimeError(f"Chemin de fichier non sur pour {model_key}: {raw_path}")
            if not isinstance(file_entry.get("size"), int) or file_entry["size"] <= 0:
                raise RuntimeError(f"Taille de fichier invalide pour {model_key}: {raw_path}")
            if not sha_pattern.fullmatch(str(file_entry.get("sha256", ""))):
                raise RuntimeError(f"SHA256 invalide pour {model_key}: {raw_path}")
            seen_paths.add(raw_path)

        if seen_paths != RUNTIME_MODEL_FILES:
            raise RuntimeError(
                f"Le manifeste runtime de {model_key} doit contenir exactement "
                f"{sorted(RUNTIME_MODEL_FILES)}."
            )

    return models


MODEL_REGISTRY = load_model_registry()
MODEL_RUNTIME_CONFIGS = {
    BBOX_MODEL_KEY: {
        "label": "Poneglyph-BBox",
        "max_new_tokens": 768,
        "family": "lighton_bbox",
        "model_dir_envs": ("PONEGLYPH_BBOX_MODEL_DIR", "PONEGLYPH_MODEL_DIR"),
        "max_new_tokens_envs": ("PONEGLYPH_BBOX_MAX_NEW_TOKENS",),
    },
    TEXT_MODEL_KEY: {
        "label": "Poneglyph",
        "max_new_tokens": 128,
        "family": "lighton_text",
        "model_dir_envs": ("PONEGLYPH_BASE_MODEL_DIR",),
        "max_new_tokens_envs": ("PONEGLYPH_TEXT_MAX_NEW_TOKENS",),
    },
    SURYA_MODEL_KEY: {
        "label": "Surya OCR",
        "max_new_tokens": 256,
        "family": "surya_text",
        "model_dir_envs": ("PONEGLYPH_SURYA_MODEL_DIR", "SURYA_MODEL_DIR"),
        "max_new_tokens_envs": ("PONEGLYPH_SURYA_MAX_NEW_TOKENS", "SURYA_MAX_NEW_TOKENS"),
    },
    SURYA_BBOX_MODEL_KEY: {
        "label": "Surya-BBox",
        "max_new_tokens": 2048,
        "family": "surya_bbox",
        "model_dir_envs": ("PONEGLYPH_SURYA_BBOX_MODEL_DIR", "SURYA_BBOX_MODEL_DIR"),
        "max_new_tokens_envs": ("PONEGLYPH_SURYA_BBOX_MAX_NEW_TOKENS", "SURYA_BBOX_MAX_NEW_TOKENS"),
    },
}
MODEL_CONFIGS = {
    model_key: {
        **runtime_config,
        "id": MODEL_REGISTRY[model_key]["repo_id"],
        "revision": MODEL_REGISTRY[model_key]["revision"],
        "dir_name": MODEL_REGISTRY[model_key]["dir_name"],
    }
    for model_key, runtime_config in MODEL_RUNTIME_CONFIGS.items()
}
TEXT_OCR_MODEL_KEYS = {TEXT_MODEL_KEY, SURYA_MODEL_KEY}
BBOX_OCR_MODEL_KEYS = {BBOX_MODEL_KEY, SURYA_BBOX_MODEL_KEY}
SURYA_MODEL_KEYS = {SURYA_MODEL_KEY, SURYA_BBOX_MODEL_KEY}
TEXT_USER_PROMPT = os.getenv(
    "LIGHTON_USER_PROMPT",
    "\nTranscription OCR (uniquement le texte de la bulle, pas de suite) :",
)
SURYA_USER_PROMPT = os.getenv(
    "PONEGLYPH_SURYA_USER_PROMPT",
    os.getenv(
        "SURYA_USER_PROMPT",
        "Transcris exactement le texte visible dans cette bulle. Ne rajoute rien.",
    ),
)
SURYA_BBOX_USER_PROMPT = os.getenv(
    "PONEGLYPH_SURYA_BBOX_USER_PROMPT",
    os.getenv(
        "SURYA_BBOX_USER_PROMPT",
        "Extrais le texte des bulles de cette page de manga dans l'ordre de lecture japonais, "
        "avec leurs bbox normalisees entre 0 et 1000. Format strict: Texte [x1,y1,x2,y2].",
    ),
)
MAX_IMAGE_SIZE = (1540, 1540)
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_BASE64_CHARS = ((MAX_IMAGE_BYTES + 2) // 3) * 4
BACKEND_TRANSFORMERS = "transformers"
BACKEND_NOT_LOADED = "not_loaded"
GENERATION_ENGINE_TRANSFORMERS = "transformers_generate"
GENERATION_ENGINE_LIGHTON_FLASH_KV = "lighton_flash_kvcache"
GENERATION_ENGINE_SURYA_HYBRID_FLASH = "surya_hybrid_flash_kvcache"


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


def env_choice(name: str, default: str, choices: set[str]) -> str:
    value = os.environ.get(name, default).strip().lower()
    return value if value in choices else default


def get_requested_backend() -> str:
    return BACKEND_TRANSFORMERS


def get_max_new_tokens(model_key: str) -> int:
    model_key = normalize_model_key(model_key)
    default = MODEL_CONFIGS[model_key]["max_new_tokens"]
    for env_name in MODEL_CONFIGS[model_key].get("max_new_tokens_envs", ()):
        if os.environ.get(env_name) not in {None, ""}:
            return env_int(env_name, default, minimum=1)
    return default


def perf_options_payload():
    return {
        "torch_compile": env_bool("PONEGLYPH_TORCH_COMPILE", False),
        "flash_attn": env_bool("PONEGLYPH_FLASH_ATTN", True),
        "tf32": env_bool("PONEGLYPH_TF32", True),
        "warmup": env_bool("PONEGLYPH_WARMUP", True),
        "lighton_fast_decode": env_bool("PONEGLYPH_LIGHTON_FAST_DECODE", True),
        "lighton_fast_compile_mode": env_choice(
            "PONEGLYPH_LIGHTON_FAST_COMPILE_MODE",
            "autotune",
            {"safe", "autotune"},
        ),
        "lighton_fast_eos_interval": env_int(
            "PONEGLYPH_LIGHTON_FAST_EOS_INTERVAL",
            8,
            minimum=1,
        ),
        "lighton_text_fast_eos_interval": env_int(
            "PONEGLYPH_LIGHTON_TEXT_FAST_EOS_INTERVAL",
            1,
            minimum=1,
        ),
        "lighton_text_fast_cache_length": env_int(
            "PONEGLYPH_LIGHTON_TEXT_FAST_CACHE_LENGTH",
            512,
            minimum=1,
        ),
        "lighton_fast_num_splits": env_int(
            "PONEGLYPH_LIGHTON_FAST_NUM_SPLITS",
            4,
            minimum=1,
        ),
        "lighton_fast_prefill_num_splits": env_int(
            "PONEGLYPH_LIGHTON_FAST_PREFILL_NUM_SPLITS",
            1,
            minimum=1,
        ),
        "surya_fast_decode": env_bool(
            "PONEGLYPH_SURYA_FAST_DECODE",
            True,
        ),
        "surya_fast_compile": env_bool(
            "PONEGLYPH_SURYA_FAST_COMPILE",
            True,
        ),
        "surya_fast_fused_mlp": env_bool(
            "PONEGLYPH_SURYA_FAST_FUSED_MLP",
            True,
        ),
        "surya_fast_dynamic_prefill": env_bool(
            "PONEGLYPH_SURYA_FAST_DYNAMIC_PREFILL",
            True,
        ),
        "surya_fast_eos_interval": env_int(
            "PONEGLYPH_SURYA_FAST_EOS_INTERVAL",
            8,
            minimum=1,
        ),
        "surya_text_fast_eos_interval": env_int(
            "PONEGLYPH_SURYA_TEXT_FAST_EOS_INTERVAL",
            1,
            minimum=1,
        ),
        "surya_fast_num_splits": env_int(
            "PONEGLYPH_SURYA_FAST_NUM_SPLITS",
            4,
            minimum=1,
        ),
        "surya_fast_prefill_num_splits": env_int(
            "PONEGLYPH_SURYA_FAST_PREFILL_NUM_SPLITS",
            1,
            minimum=1,
        ),
        "surya_fast_cache_length": env_int(
            "PONEGLYPH_SURYA_FAST_CACHE_LENGTH",
            4608,
            minimum=1,
        ),
        "surya_text_fast_cache_length": env_int(
            "PONEGLYPH_SURYA_TEXT_FAST_CACHE_LENGTH",
            768,
            minimum=1,
        ),
        "text_max_new_tokens": get_max_new_tokens(TEXT_MODEL_KEY),
        "bbox_max_new_tokens": get_max_new_tokens(BBOX_MODEL_KEY),
        "surya_max_new_tokens": get_max_new_tokens(SURYA_MODEL_KEY),
        "surya_bbox_max_new_tokens": get_max_new_tokens(SURYA_BBOX_MODEL_KEY),
    }


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
        "warmup_timings_ms": [],
        "optimized_engine": None,
        "optimized_engine_error": None,
        "generation_engine": GENERATION_ENGINE_TRANSFORMERS,
        "last_generation_profile": None,
        "loading": False,
        "last_error": None,
        "integrity_error": None,
        "download": make_download_state(),
        "download_staging_dir": None,
        "model_lock": threading.RLock(),
        "download_lock": threading.Lock(),
    }
    for model_key in MODEL_CONFIGS
}

inference_lock = threading.Lock()

app = FastAPI(title="Poneglyph Local OCR Backend")


class OcrRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_bytes_base64: str = Field(
        min_length=4,
        max_length=MAX_IMAGE_BASE64_CHARS,
    )


def normalize_model_key(model_key: str) -> str:
    if model_key not in MODEL_CONFIGS:
        raise ValueError(f"Modele local inconnu: {model_key}")
    return model_key


def normalize_text_ocr_model_key(model_key: str) -> str:
    model_key = normalize_model_key(model_key)
    if model_key not in TEXT_OCR_MODEL_KEYS:
        raise ValueError(f"Le modele {model_key} ne fournit pas d'OCR texte classique.")
    return model_key


def normalize_bbox_ocr_model_key(model_key: str) -> str:
    model_key = normalize_model_key(model_key)
    if model_key not in BBOX_OCR_MODEL_KEYS:
        raise ValueError(f"Le modele {model_key} ne fournit pas d'OCR bbox full-page.")
    return model_key


def model_family(model_key: str) -> str:
    return MODEL_CONFIGS[normalize_model_key(model_key)]["family"]


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


def normalized_absolute_path(path_value: str) -> str:
    return os.path.normcase(os.path.abspath(os.path.expanduser(path_value)))


def configured_model_dir_override(model_key: str):
    model_key = normalize_model_key(model_key)
    default_dir = default_app_model_dir(model_key)
    for env_name in MODEL_CONFIGS[model_key].get("model_dir_envs", ()):
        env_value = os.environ.get(env_name)
        if not env_value:
            continue
        if normalized_absolute_path(env_value) == normalized_absolute_path(default_dir):
            return env_value, False
        if not env_bool(UNSAFE_MODEL_DIR_OVERRIDE_ENV, False):
            raise RuntimeError(
                f"Le chemin {env_name} est un override local non verifie. "
                f"Reserve au developpement: activez explicitement "
                f"{UNSAFE_MODEL_DIR_OVERRIDE_ENV}=1."
            )
        return env_value, True
    return None, False


def get_model_dir(model_key: str = DEFAULT_MODEL_KEY) -> str:
    model_key = normalize_model_key(model_key)
    override_dir, _unsafe = configured_model_dir_override(model_key)
    return override_dir or default_app_model_dir(model_key)


def model_uses_unsafe_dir_override(model_key: str = DEFAULT_MODEL_KEY) -> bool:
    _override_dir, unsafe = configured_model_dir_override(model_key)
    return unsafe


def model_registry_entry(model_key: str = DEFAULT_MODEL_KEY):
    return MODEL_REGISTRY[normalize_model_key(model_key)]


def registry_file_paths(model_key: str = DEFAULT_MODEL_KEY):
    return [entry["path"] for entry in model_registry_entry(model_key)["files"]]


def registry_total_bytes(model_key: str = DEFAULT_MODEL_KEY) -> int:
    return sum(entry["size"] for entry in model_registry_entry(model_key)["files"])


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def verify_snapshot_against_manifest(
    model_dir,
    manifest_entry,
    *,
    verify_hashes: bool = True,
    reject_unexpected: bool = False,
) -> None:
    root = Path(model_dir)
    if not root.is_dir():
        raise ModelIntegrityError(f"Dossier de modele absent: {root}")

    expected_paths = set()
    for file_entry in manifest_entry["files"]:
        relative_path = file_entry["path"]
        expected_paths.add(relative_path)
        file_path = root.joinpath(*PurePosixPath(relative_path).parts)
        if file_path.is_symlink() or not file_path.is_file():
            raise ModelIntegrityError(f"Fichier de modele absent ou non regulier: {relative_path}")
        actual_size = file_path.stat().st_size
        if actual_size != file_entry["size"]:
            raise ModelIntegrityError(
                f"Taille invalide pour {relative_path}: {actual_size} au lieu de {file_entry['size']}."
            )
        if verify_hashes:
            actual_hash = sha256_file(file_path)
            if actual_hash != file_entry["sha256"]:
                raise ModelIntegrityError(f"SHA256 invalide pour {relative_path}.")

    actual_files = [
        file_path
        for file_path in root.rglob("*")
        if file_path.is_file() or file_path.is_symlink()
    ]
    unexpected_files = [
        file_path
        for file_path in actual_files
        if file_path.relative_to(root).as_posix()
        not in expected_paths | {MODEL_INSTALL_METADATA_FILENAME}
    ]
    forbidden_paths = sorted(
        file_path.relative_to(root).as_posix()
        for file_path in unexpected_files
        if file_path.is_symlink() or file_path.suffix.lower() in FORBIDDEN_UNMANIFESTED_SUFFIXES
    )
    if forbidden_paths:
        raise ModelIntegrityError(
            "Fichiers executables non manifestes interdits: " + ", ".join(forbidden_paths)
        )

    if reject_unexpected:
        actual_paths = {file_path.relative_to(root).as_posix() for file_path in actual_files}
        allowed_paths = expected_paths | {MODEL_INSTALL_METADATA_FILENAME}
        unexpected_paths = sorted(actual_paths - allowed_paths)
        if unexpected_paths:
            raise ModelIntegrityError(
                "Fichiers inattendus dans le snapshot: " + ", ".join(unexpected_paths)
            )


def verify_unsafe_local_model_dir(model_key: str, model_dir) -> None:
    required_files = ("config.json", "model.safetensors")
    missing = [name for name in required_files if not Path(model_dir, name).is_file()]
    if missing:
        raise ModelIntegrityError(
            f"Override local incomplet pour {model_key}: {', '.join(missing)}."
        )


def recover_interrupted_model_promotion(model_key: str = DEFAULT_MODEL_KEY) -> bool:
    model_key = normalize_model_key(model_key)
    if model_uses_unsafe_dir_override(model_key):
        return False

    model_dir = Path(default_app_model_dir(model_key))
    state = get_model_state(model_key)
    with state["model_lock"]:
        if model_dir.exists():
            return False

        candidates = sorted(
            model_dir.parent.glob(f".{model_dir.name}.backup-*"),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
        for backup_dir in candidates:
            try:
                verify_snapshot_against_manifest(
                    backup_dir,
                    model_registry_entry(model_key),
                    verify_hashes=True,
                    # Legacy installs can contain documentation or benchmark files.
                    # Restoring them only recovers the pre-promotion state; normal
                    # integrity checks will still require a minimal exact snapshot.
                    reject_unexpected=False,
                )
            except (ModelIntegrityError, OSError):
                continue
            os.replace(backup_dir, model_dir)
            return True
    return False


def ensure_model_integrity(model_key: str = DEFAULT_MODEL_KEY, *, verify_hashes: bool = True) -> None:
    model_key = normalize_model_key(model_key)
    model_dir = get_model_dir(model_key)
    if model_uses_unsafe_dir_override(model_key):
        verify_unsafe_local_model_dir(model_key, model_dir)
        return
    if not Path(model_dir).exists():
        recover_interrupted_model_promotion(model_key)
    verify_snapshot_against_manifest(
        model_dir,
        model_registry_entry(model_key),
        verify_hashes=verify_hashes,
        reject_unexpected=True,
    )


def model_is_installed(model_key: str = DEFAULT_MODEL_KEY, *, verify_hashes: bool = False) -> bool:
    try:
        ensure_model_integrity(model_key, verify_hashes=verify_hashes)
        return True
    except (ModelIntegrityError, OSError):
        return False


def configure_torch_runtime(torch_module) -> None:
    try:
        if not torch_module.cuda.is_available():
            return
    except Exception:
        return

    cuda_backends = getattr(torch_module.backends, "cuda", None)
    if cuda_backends is not None:
        for flag_name in ("enable_flash_sdp", "enable_mem_efficient_sdp", "enable_math_sdp"):
            flag = getattr(cuda_backends, flag_name, None)
            if callable(flag):
                try:
                    flag(True)
                except Exception:
                    pass

    cudnn_backend = getattr(torch_module.backends, "cudnn", None)
    if cudnn_backend is not None:
        try:
            cudnn_backend.benchmark = True
        except Exception:
            pass

    if env_bool("PONEGLYPH_TF32", True):
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


def directory_size_bytes(model_dir) -> int:
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


def model_dir_size_bytes(model_key: str = DEFAULT_MODEL_KEY) -> int:
    return directory_size_bytes(get_model_dir(model_key))


def get_model_total_bytes(model_key: str = DEFAULT_MODEL_KEY) -> int:
    return registry_total_bytes(model_key)


def update_download_state(model_key: str, **updates) -> None:
    state = get_model_state(model_key)
    with state["download_lock"]:
        state["download"].update(updates)


def download_status_snapshot(model_key: str = DEFAULT_MODEL_KEY):
    model_state = get_model_state(model_key)
    with model_state["download_lock"]:
        state = dict(model_state["download"])
        staging_dir = model_state.get("download_staging_dir")

    downloaded_bytes = (
        directory_size_bytes(staging_dir)
        if state.get("active") and staging_dir
        else model_dir_size_bytes(model_key)
    )
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


def write_model_install_metadata(model_key: str, model_dir: Path) -> None:
    entry = model_registry_entry(model_key)
    metadata = {
        "schema_version": 1,
        "model_key": model_key,
        "repo_id": entry["repo_id"],
        "revision": entry["revision"],
        "verified_files": len(entry["files"]),
    }
    model_dir.joinpath(MODEL_INSTALL_METADATA_FILENAME).write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def promote_staged_model(staging_dir: Path, model_dir: Path) -> None:
    model_dir.parent.mkdir(parents=True, exist_ok=True)
    backup_dir = None
    if model_dir.exists():
        backup_dir = model_dir.with_name(f".{model_dir.name}.backup-{time.time_ns()}")
        os.replace(model_dir, backup_dir)

    try:
        os.replace(staging_dir, model_dir)
    except Exception:
        if backup_dir is not None and backup_dir.exists() and not model_dir.exists():
            os.replace(backup_dir, model_dir)
        raise

    if backup_dir is not None and backup_dir.exists():
        try:
            shutil.rmtree(backup_dir)
        except OSError:
            pass


def download_model(model_key: str = DEFAULT_MODEL_KEY) -> None:
    model_key = normalize_model_key(model_key)
    if model_uses_unsafe_dir_override(model_key):
        raise RuntimeError(
            "Le telechargement Hub est desactive pour un override local non verifie. "
            "Installez manuellement le modele de developpement dans ce dossier."
        )

    from huggingface_hub import snapshot_download

    entry = model_registry_entry(model_key)
    model_dir = Path(default_app_model_dir(model_key))
    model_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(
        tempfile.mkdtemp(
            prefix=f".{model_dir.name}.staging-",
            dir=model_dir.parent,
        )
    )
    state = get_model_state(model_key)
    with state["download_lock"]:
        state["download_staging_dir"] = str(staging_dir)

    try:
        snapshot_download(
            repo_id=entry["repo_id"],
            revision=entry["revision"],
            local_dir=str(staging_dir),
            allow_patterns=registry_file_paths(model_key),
            token=os.environ.get("HF_TOKEN"),
        )
        download_cache_dir = staging_dir / ".cache"
        if download_cache_dir.exists():
            shutil.rmtree(download_cache_dir)
        verify_snapshot_against_manifest(
            staging_dir,
            entry,
            verify_hashes=True,
            reject_unexpected=False,
        )
        write_model_install_metadata(model_key, staging_dir)
        verify_snapshot_against_manifest(
            staging_dir,
            entry,
            verify_hashes=False,
            reject_unexpected=True,
        )
        with state["model_lock"]:
            promote_staged_model(staging_dir, model_dir)
            state["integrity_error"] = None
    finally:
        with state["download_lock"]:
            state["download_staging_dir"] = None
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)


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
        downloaded_bytes = total_bytes or model_dir_size_bytes(model_key)
        update_download_state(
            model_key,
            active=False,
            ok=True,
            error=None,
            downloaded_bytes=downloaded_bytes,
            finished_at=time.time(),
        )
        state["last_error"] = None
        state["integrity_error"] = None
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
    model_key = normalize_model_key(model_key)
    if model_uses_unsafe_dir_override(model_key):
        raise RuntimeError(
            "Le telechargement Hub est desactive pour un override local non verifie."
        )
    state = get_model_state(model_key)
    with state["download_lock"]:
        if state["download"]["active"]:
            return False

        if model_is_installed(model_key, verify_hashes=True):
            state["integrity_error"] = None
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
            total_bytes=get_model_total_bytes(model_key),
            downloaded_bytes=model_dir_size_bytes(model_key),
            started_at=time.time(),
            finished_at=None,
        )

    thread = threading.Thread(target=download_model_worker, args=(model_key,), daemon=True)
    thread.start()
    return True


def model_is_loaded(model_key: str) -> bool:
    state = get_model_state(model_key)
    return state["processor"] is not None and state["model"] is not None


def clear_loaded_model_state(state) -> None:
    optimized_engine = state.get("optimized_engine")
    if optimized_engine is not None:
        try:
            optimized_engine.restore_model()
        except Exception:
            pass
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
    state["warmup_timings_ms"] = []
    state["optimized_engine"] = None
    state["optimized_engine_error"] = None
    state["generation_engine"] = GENERATION_ENGINE_TRANSFORMERS
    state["last_generation_profile"] = None


def configure_processor(model_key: str, loaded_processor):
    image_processor = getattr(loaded_processor, "image_processor", None)
    if image_processor is not None and hasattr(image_processor, "default_to_square"):
        image_processor.default_to_square = False

    tokenizer = getattr(loaded_processor, "tokenizer", None)
    if (model_key in TEXT_OCR_MODEL_KEYS or model_key in SURYA_MODEL_KEYS) and tokenizer is not None:
        tokenizer.padding_side = "left"
        if getattr(tokenizer, "pad_token_id", None) is None and getattr(tokenizer, "eos_token", None):
            tokenizer.pad_token = tokenizer.eos_token

    return loaded_processor


def load_processor(model_key: str):
    model_dir = get_model_dir(model_key)
    if model_key in SURYA_MODEL_KEYS:
        from transformers import AutoProcessor

        loaded_processor = AutoProcessor.from_pretrained(
            model_dir,
            trust_remote_code=False,
            local_files_only=True,
        )
    else:
        from transformers import LightOnOcrProcessor

        loaded_processor = LightOnOcrProcessor.from_pretrained(
            model_dir,
            trust_remote_code=False,
            local_files_only=True,
        )
    return configure_processor(model_key, loaded_processor)


def valid_token_id(token_id, tokenizer) -> bool:
    if token_id is None or tokenizer is None:
        return False
    try:
        token_count = len(tokenizer)
    except Exception:
        return isinstance(token_id, int)
    if isinstance(token_id, int):
        return 0 <= token_id < token_count
    if isinstance(token_id, (list, tuple)):
        return all(isinstance(item, int) and 0 <= item < token_count for item in token_id)
    return False


def configure_model_generation(model_key: str, model, loaded_processor) -> None:
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = True

    generation_config = getattr(model, "generation_config", None)
    if generation_config is None:
        return

    generation_config.do_sample = False
    generation_config.max_new_tokens = get_max_new_tokens(model_key)
    if model_key in SURYA_MODEL_KEYS:
        generation_config.temperature = None
        generation_config.top_p = None
        generation_config.top_k = None

    tokenizer = getattr(loaded_processor, "tokenizer", None)
    eos_token_id = getattr(tokenizer, "eos_token_id", None) if tokenizer is not None else None
    pad_token_id = getattr(tokenizer, "pad_token_id", None) if tokenizer is not None else None
    if valid_token_id(eos_token_id, tokenizer):
        generation_config.eos_token_id = eos_token_id
        if hasattr(model.config, "eos_token_id"):
            model.config.eos_token_id = eos_token_id
    if valid_token_id(pad_token_id, tokenizer):
        generation_config.pad_token_id = pad_token_id
        if hasattr(model.config, "pad_token_id"):
            model.config.pad_token_id = pad_token_id


def transformer_attention_attempts(selected_device: str):
    attempts = []
    attempts.append(("sdpa", {"attn_implementation": "sdpa"}))
    attempts.append(("default", {}))
    return attempts


def load_transformers_model(
    model_key: str,
    loaded_processor,
    selected_device: str,
    selected_dtype,
):
    model_dir = get_model_dir(model_key)
    errors = []
    for attention_name, attention_kwargs in transformer_attention_attempts(selected_device):
        try:
            if model_key in SURYA_MODEL_KEYS:
                from transformers import AutoModelForImageTextToText

                model = AutoModelForImageTextToText.from_pretrained(
                    model_dir,
                    torch_dtype=selected_dtype,
                    trust_remote_code=False,
                    local_files_only=True,
                    low_cpu_mem_usage=True,
                    use_safetensors=True,
                    **attention_kwargs,
                ).eval()
            else:
                from transformers import LightOnOcrForConditionalGeneration

                model = LightOnOcrForConditionalGeneration.from_pretrained(
                    model_dir,
                    torch_dtype=selected_dtype,
                    trust_remote_code=False,
                    local_files_only=True,
                    low_cpu_mem_usage=True,
                    use_safetensors=True,
                    **attention_kwargs,
                ).eval()
            configure_model_generation(model_key, model, loaded_processor)
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


def lighton_fast_decode_requested(
    model_key: str,
    torch_module,
    selected_device: str,
    selected_dtype,
) -> bool:
    return (
        model_key in {BBOX_MODEL_KEY, TEXT_MODEL_KEY}
        and selected_device == "cuda"
        and selected_dtype == torch_module.bfloat16
        and env_bool("PONEGLYPH_FLASH_ATTN", True)
        and env_bool("PONEGLYPH_LIGHTON_FAST_DECODE", True)
    )


def disable_optimized_engine(model_key: str, reason: str) -> None:
    state = get_model_state(model_key)
    engine = state.get("optimized_engine")
    if engine is not None:
        try:
            engine.restore_model()
        except Exception as restore_exc:
            reason = f"{reason} | restauration: {restore_exc}"
    state["optimized_engine"] = None
    state["optimized_engine_error"] = reason
    state["generation_engine"] = GENERATION_ENGINE_TRANSFORMERS
    try:
        clear_torch_cache(get_torch())
    except Exception:
        pass


def maybe_enable_lighton_fast_engine(
    model_key: str,
    torch_module,
    selected_device: str,
    selected_dtype,
) -> bool:
    state = get_model_state(model_key)
    state["optimized_engine"] = None
    state["optimized_engine_error"] = None
    state["generation_engine"] = GENERATION_ENGINE_TRANSFORMERS
    if not lighton_fast_decode_requested(
        model_key,
        torch_module,
        selected_device,
        selected_dtype,
    ):
        return False

    try:
        from lighton_flash_kvcache import FlashKVGreedyEngine

        state["optimized_engine"] = FlashKVGreedyEngine(
            state["model"],
            max_new_tokens=get_max_new_tokens(model_key),
            compile_mode=env_choice(
                "PONEGLYPH_LIGHTON_FAST_COMPILE_MODE",
                "autotune",
                {"safe", "autotune"},
            ),
            eos_check_interval=env_int(
                (
                    "PONEGLYPH_LIGHTON_FAST_EOS_INTERVAL"
                    if model_key == BBOX_MODEL_KEY
                    else "PONEGLYPH_LIGHTON_TEXT_FAST_EOS_INTERVAL"
                ),
                8 if model_key == BBOX_MODEL_KEY else 1,
                minimum=1,
            ),
            num_splits=env_int(
                "PONEGLYPH_LIGHTON_FAST_NUM_SPLITS",
                4,
                minimum=1,
            ),
            prefill_num_splits=env_int(
                "PONEGLYPH_LIGHTON_FAST_PREFILL_NUM_SPLITS",
                1,
                minimum=1,
            ),
            minimum_cache_len=(
                0
                if model_key == BBOX_MODEL_KEY
                else env_int(
                    "PONEGLYPH_LIGHTON_TEXT_FAST_CACHE_LENGTH",
                    512,
                    minimum=1,
                )
            ),
        )
        state["generation_engine"] = GENERATION_ENGINE_LIGHTON_FLASH_KV
        return True
    except Exception as exc:
        disable_optimized_engine(
            model_key,
            f"Optimisation Flash KV indisponible, fallback Transformers: {exc}",
        )
        return False


def surya_fast_decode_requested(
    model_key: str,
    torch_module,
    selected_device: str,
    selected_dtype,
) -> bool:
    return (
        model_key in SURYA_MODEL_KEYS
        and selected_device == "cuda"
        and selected_dtype == torch_module.bfloat16
        and env_bool("PONEGLYPH_FLASH_ATTN", True)
        and env_bool("PONEGLYPH_SURYA_FAST_DECODE", True)
    )


def maybe_enable_surya_fast_engine(
    model_key: str,
    torch_module,
    selected_device: str,
    selected_dtype,
) -> bool:
    state = get_model_state(model_key)
    state["optimized_engine"] = None
    state["optimized_engine_error"] = None
    state["generation_engine"] = GENERATION_ENGINE_TRANSFORMERS
    if not surya_fast_decode_requested(
        model_key,
        torch_module,
        selected_device,
        selected_dtype,
    ):
        return False

    try:
        from surya_hybrid_flash_kvcache import HybridFlashGreedyEngine

        state["optimized_engine"] = HybridFlashGreedyEngine(
            state["model"],
            max_new_tokens=get_max_new_tokens(model_key),
            eos_check_interval=env_int(
                (
                    "PONEGLYPH_SURYA_FAST_EOS_INTERVAL"
                    if model_key == SURYA_BBOX_MODEL_KEY
                    else "PONEGLYPH_SURYA_TEXT_FAST_EOS_INTERVAL"
                ),
                8 if model_key == SURYA_BBOX_MODEL_KEY else 1,
                minimum=1,
            ),
            num_splits=env_int(
                "PONEGLYPH_SURYA_FAST_NUM_SPLITS",
                4,
                minimum=1,
            ),
            prefill_num_splits=env_int(
                "PONEGLYPH_SURYA_FAST_PREFILL_NUM_SPLITS",
                1,
                minimum=1,
            ),
            use_delta_kernels=False,
            use_fused_mlp=env_bool(
                "PONEGLYPH_SURYA_FAST_FUSED_MLP",
                True,
            ),
            use_cuda_graph=True,
            compile_decode=env_bool(
                "PONEGLYPH_SURYA_FAST_COMPILE",
                True,
            ),
            minimum_cache_len=(
                env_int(
                    "PONEGLYPH_SURYA_FAST_CACHE_LENGTH",
                    4608,
                    minimum=1,
                )
                if model_key == SURYA_BBOX_MODEL_KEY
                else env_int(
                    "PONEGLYPH_SURYA_TEXT_FAST_CACHE_LENGTH",
                    768,
                    minimum=1,
                )
            ),
            use_dynamic_prefill=env_bool(
                "PONEGLYPH_SURYA_FAST_DYNAMIC_PREFILL",
                True,
            ),
        )
        state["generation_engine"] = GENERATION_ENGINE_SURYA_HYBRID_FLASH
        return True
    except Exception as exc:
        disable_optimized_engine(
            model_key,
            "Optimisation hybride Surya indisponible, fallback "
            f"Transformers: {exc}",
        )
        return False


def load_transformers_backend(
    model_key: str,
    loaded_processor,
    selected_device: str,
    selected_dtype,
) -> None:
    state = get_model_state(model_key)
    torch = get_torch()

    loaded_model, attention_implementation = load_transformers_model(
        model_key,
        loaded_processor,
        selected_device,
        selected_dtype,
    )
    loaded_model.to(device=selected_device, dtype=selected_dtype)

    state["processor"] = loaded_processor
    state["model"] = loaded_model
    state["device"] = selected_device
    state["dtype"] = selected_dtype
    state["requested_backend"] = BACKEND_TRANSFORMERS
    state["active_backend"] = BACKEND_TRANSFORMERS
    state["backend_fallback_reason"] = None
    state["backend_error"] = None
    state["attention_implementation"] = attention_implementation
    state["compiled"] = False
    state["compile_error"] = None
    state["last_error"] = None

    optimized = maybe_enable_lighton_fast_engine(
        model_key,
        torch,
        selected_device,
        selected_dtype,
    )
    if not optimized:
        optimized = maybe_enable_surya_fast_engine(
            model_key,
            torch,
            selected_device,
            selected_dtype,
        )
    if not optimized:
        loaded_model, compiled, compile_error = maybe_compile_transformers_model(
            torch,
            loaded_model,
            selected_device,
        )
        state["model"] = loaded_model
        state["compiled"] = compiled
        state["compile_error"] = compile_error


def messages_for_model(model_key: str):
    if model_key in TEXT_OCR_MODEL_KEYS:
        prompt = SURYA_USER_PROMPT if model_key == SURYA_MODEL_KEY else TEXT_USER_PROMPT
        return [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": prompt},
                ],
            }
        ]

    if model_key == SURYA_BBOX_MODEL_KEY:
        return [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": SURYA_BBOX_USER_PROMPT},
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
    state["warmup_timings_ms"] = []
    if state["device"] != "cuda" or not env_bool("PONEGLYPH_WARMUP", True):
        return

    try:
        from PIL import Image

        optimized = state.get("optimized_engine") is not None
        if optimized and model_key in SURYA_MODEL_KEYS:
            warmup_image_size = (
                (958, 1500)
                if model_key == SURYA_BBOX_MODEL_KEY
                else (320, 640)
            )
            repeat_count = env_int(
                "PONEGLYPH_SURYA_FAST_WARMUP_REPEATS",
                2,
                minimum=1,
            )
            warmup_tokens = min(
                get_max_new_tokens(model_key),
                env_int(
                    "PONEGLYPH_SURYA_FAST_WARMUP_TOKENS",
                    32,
                    minimum=2,
                ),
            )
        elif optimized:
            warmup_image_size = (
                (958, 1500)
                if model_key == BBOX_MODEL_KEY
                else (320, 640)
            )
            repeat_count = env_int(
                "PONEGLYPH_LIGHTON_FAST_WARMUP_REPEATS",
                3,
                minimum=1,
            )
            warmup_tokens = min(
                get_max_new_tokens(model_key),
                env_int(
                    "PONEGLYPH_LIGHTON_FAST_WARMUP_TOKENS",
                    32,
                    minimum=2,
                ),
            )
        else:
            warmup_image_size = (64, 64)
            repeat_count = 1
            warmup_tokens = 1
        warmup_image = Image.new(
            "RGB",
            warmup_image_size,
            (240, 240, 240),
        )
        for _ in range(repeat_count):
            started = time.perf_counter()
            generate_with_model(
                model_key,
                warmup_image,
                messages_for_model(model_key),
                max_new_tokens_override=warmup_tokens,
            )
            state["warmup_timings_ms"].append(
                round((time.perf_counter() - started) * 1000, 1)
            )
            if optimized and state.get("optimized_engine") is None:
                break
    except Exception as exc:
        state["warmup_error"] = f"Warmup ignore: {exc}"


def load_model(model_key: str = DEFAULT_MODEL_KEY) -> None:
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)

    if model_is_loaded(model_key):
        return

    with state["model_lock"]:
        if model_is_loaded(model_key):
            return

        if not model_is_installed(model_key):
            model_label = MODEL_CONFIGS[model_key]["label"]
            raise RuntimeError(
                f"Le modele {model_label} n'est pas installe. Lancez d'abord le telechargement."
            )

        try:
            ensure_model_integrity(model_key, verify_hashes=True)
        except ModelIntegrityError as exc:
            message = (
                f"Le modele {MODEL_CONFIGS[model_key]['label']} a echoue au controle "
                f"d'integrite: {exc} Relancez son telechargement."
            )
            state["integrity_error"] = str(exc)
            state["last_error"] = message
            raise RuntimeError(message) from exc

        state["integrity_error"] = None

        state["loading"] = True
        clear_loaded_model_state(state)
        torch = None
        try:
            torch = get_torch()
            selected_device = pick_device(torch)
            selected_dtype = pick_dtype(torch, selected_device)
            loaded_processor = load_processor(model_key)
            load_transformers_backend(
                model_key,
                loaded_processor,
                selected_device,
                selected_dtype,
            )
            maybe_warmup_model(model_key)
            return
        except Exception as exc:
            clear_loaded_model_state(state)
            state["last_error"] = str(exc)
            if torch is not None:
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
    configuration_error = None
    try:
        model_dir = get_model_dir(model_key)
    except RuntimeError as exc:
        model_dir = ""
        configuration_error = str(exc)

    installed = (
        configuration_error is None
        and state["integrity_error"] is None
        and model_is_installed(model_key)
    )
    loaded = state["processor"] is not None and state["model"] is not None
    status_error = configuration_error or state["last_error"]
    return {
        "installed": installed,
        "loaded": loaded,
        "loading": state["loading"],
        "ready": installed and loaded and not state["loading"] and status_error is None,
        "model_dir": model_dir,
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
        "generation_engine": state["generation_engine"],
        "optimized_engine_error": state["optimized_engine_error"],
        "last_generation_profile": state["last_generation_profile"],
        "warmup_error": state["warmup_error"],
        "warmup_timings_ms": state["warmup_timings_ms"],
        "error": status_error,
        "integrity_error": state["integrity_error"],
        "download": (
            download_status_snapshot(model_key)
            if configuration_error is None
            else dict(state["download"])
        ),
    }


def loaded_models_payload():
    return {model_key: model_status_payload(model_key) for model_key in MODEL_CONFIGS}


def global_active_backend() -> str:
    for model_key in MODEL_CONFIGS:
        backend = get_model_state(model_key).get("active_backend")
        if backend:
            return backend
    return BACKEND_NOT_LOADED


def decode_image_request(request: OcrRequest):
    try:
        decoded = base64.b64decode(request.image_bytes_base64, validate=True)
        if len(decoded) > MAX_IMAGE_BYTES:
            return JSONResponse(
                status_code=413,
                content={"error": "Image trop volumineuse."},
            )
        return decoded
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
        "generation_engine": state["generation_engine"],
        "optimized_engine_error": state["optimized_engine_error"],
        "generation_profile": state["last_generation_profile"],
    }


def render_prompt(loaded_processor, messages):
    return loaded_processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=False,
    )


def decode_generated_tokens(loaded_processor, token_ids):
    if hasattr(loaded_processor, "decode"):
        return loaded_processor.decode(token_ids, skip_special_tokens=True)
    tokenizer = getattr(loaded_processor, "tokenizer", None)
    if tokenizer is not None:
        return tokenizer.decode(token_ids, skip_special_tokens=True)
    raise RuntimeError("Le processor OCR ne fournit pas de decodeur de tokens.")


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

    optimized_engine = state.get("optimized_engine")
    if optimized_engine is not None:
        try:
            active_generation_engine = state["generation_engine"]
            optimized = optimized_engine.generate(
                inputs,
                max_new_tokens=max_new_tokens_override,
            )
            state["last_generation_profile"] = {
                "engine": active_generation_engine,
                "prefill_ms": round(optimized.prefill_ms, 2),
                "decode_ms": round(optimized.decode_ms, 2),
                "generated_tokens": optimized.generated_tokens,
                "decode_steps": optimized.decode_steps,
            }
            return decode_generated_tokens(
                loaded_processor,
                optimized.token_ids[0],
            ).strip()
        except Exception as exc:
            disable_optimized_engine(
                model_key,
                "Erreur moteur optimise pendant l'inference, fallback "
                f"Transformers: {exc}",
            )
            loaded_model = state["model"]

    generation_started = time.perf_counter()
    with torch.inference_mode(), generation_autocast_context(torch, selected_device, selected_dtype):
        output_ids = loaded_model.generate(
            **inputs,
            max_new_tokens=max_new_tokens_override or get_max_new_tokens(model_key),
            do_sample=False,
        )

    gen_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    state["last_generation_profile"] = {
        "engine": GENERATION_ENGINE_TRANSFORMERS,
        "generate_ms": round((time.perf_counter() - generation_started) * 1000, 2),
        "generated_tokens": len(gen_ids),
    }
    return decode_generated_tokens(loaded_processor, gen_ids).strip()


def generate_with_model(
    model_key: str,
    image,
    messages,
    max_new_tokens_override: Optional[int] = None,
):
    model_key = normalize_model_key(model_key)
    state = get_model_state(model_key)
    active_backend = state["active_backend"]

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
            "active_backend": global_active_backend(),
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
            "active_backend": global_active_backend(),
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
        failed_status = (
            model_status_payload(model_key) if model_key in MODEL_CONFIGS else None
        )
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "model_dir": failed_status["model_dir"] if failed_status else "",
                "error": str(exc),
                "download": failed_status["download"] if failed_status else None,
            },
        )


@app.post("/ocr")
def ocr(request: OcrRequest, model_key: str = BBOX_MODEL_KEY):
    start = time.perf_counter()
    try:
        model_key = normalize_bbox_ocr_model_key(model_key)
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
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except Exception as exc:
        get_model_state(model_key)["last_error"] = str(exc)
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.post("/ocr/text")
def text_ocr(request: OcrRequest, model_key: str = TEXT_MODEL_KEY):
    start = time.perf_counter()
    try:
        model_key = normalize_text_ocr_model_key(model_key)
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
        text = output_text.strip()
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
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
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
