"""One explicit, serializable configuration; secrets never enter run artifacts."""

import os
from dataclasses import asdict, dataclass
from pathlib import Path

BASE_MODEL = "tiiuae/Falcon-OCR"
BASE_REVISION = "42ec56b72a23984ac059e7c8a6d397a8529423fe"
PROMPT = "<|image|>Extract the text content from this image.\n<|OCR_PLAIN|>"


def same_training_identity(saved, current):
    """Allow memory/input throughput tuning without changing optimization/data."""

    def normalized(identity):
        identity = dict(identity)
        identity["config"] = dict(identity["config"])
        for name in ("eval_batch", "checkpoint_token_budget", "prefetch_batches"):
            identity["config"].pop(name, None)
        return identity

    return normalized(saved) == normalized(current)


@dataclass(frozen=True)
class Config:
    dataset_dir: str = "/workspace/falcon_dataset"
    output_dir: str = "/workspace/outputs_falcon_ocr"
    repo_id: str = "Remidesbois/Falcon-OCR-Poneglyph"
    revision: str = BASE_REVISION
    seed: int = 42
    epochs: int = 8
    patience: int = 2
    lr: float = 1e-5
    weight_decay: float = 0.01
    effective_batch: int = 32
    micro_batch: int = 0  # 0: probe a real forward/backward/optimizer step
    eval_batch: int = 32
    max_dimension: int = 896
    min_dimension: int = 64
    max_new_tokens: int = 256
    gradient_checkpointing: bool = True
    checkpoint_token_budget: int = 8192
    prefetch_batches: bool = True
    refit_all: bool = True
    upload: bool = True
    augment: bool = True

    @classmethod
    def from_env(cls):
        defaults = cls()
        values = {}
        for name, default in asdict(defaults).items():
            raw = os.getenv("FALCON_" + name.upper())
            if raw is not None:
                if isinstance(default, bool):
                    if raw.lower() not in {"0", "1", "true", "false"}:
                        raise ValueError(
                            f"FALCON_{name.upper()}: expected 0/1/true/false"
                        )
                    values[name] = raw.lower() in {"1", "true"}
                else:
                    values[name] = type(default)(raw)
        config = cls(**values)
        if not 64 <= config.min_dimension <= config.max_dimension <= 896:
            raise ValueError("Image dimensions must satisfy 64 <= min <= max <= 896")
        if (
            min(
                config.epochs,
                config.patience,
                config.effective_batch,
                config.eval_batch,
                config.max_new_tokens,
            )
            < 1
            or config.micro_batch < 0
            or config.checkpoint_token_budget < 0
            or config.lr <= 0
        ):
            raise ValueError("Invalid training budget")
        if config.micro_batch and config.effective_batch % config.micro_batch:
            raise ValueError("effective_batch must be divisible by micro_batch")
        if config.max_new_tokens > 2048:
            raise ValueError("max_new_tokens must be <= 2048")
        return config

    @property
    def output(self):
        return Path(self.output_dir)
