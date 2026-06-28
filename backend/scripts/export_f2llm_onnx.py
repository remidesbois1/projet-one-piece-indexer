#!/usr/bin/env python3
"""
Export F2LLM-v2-160M, including a local fine-tuned checkpoint, to a
Transformers.js-style ONNX folder.

Run from the repository root or backend folder:

    python backend/scripts/export_f2llm_onnx.py --model-id scripts/embed/f2llm_v2_160m_finetuned_full --output backend/models/f2llm-v2-160m-one-piece-retrieval

The backend expects:

    backend/models/f2llm-v2-160m-one-piece-retrieval/onnx/model.onnx
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from huggingface_hub import snapshot_download


DEFAULT_MODEL_ID = "codefuse-ai/F2LLM-v2-160M"
BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = BACKEND_DIR / "models" / "f2llm-v2-160m"


def copy_tree_contents(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def resolve_model_files(model_id: str) -> Path:
    local_path = Path(model_id).expanduser()
    if local_path.exists():
        return local_path.resolve()

    print(f"Downloading tokenizer/config files for {model_id}...")
    return Path(
        snapshot_download(
            model_id,
            allow_patterns=[
                "*.json",
                "*.txt",
                "*.model",
                "*.jinja",
                "README.md",
                "1_Pooling/*",
                "2_Normalize/*",
            ],
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Export F2LLM-v2-160M to ONNX for local backend search.")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--sequence-length", type=int, default=512)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    output_dir = args.output.resolve()
    if output_dir.exists() and args.force:
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    model_files_path = resolve_model_files(args.model_id)
    copy_tree_contents(model_files_path, output_dir)

    with tempfile.TemporaryDirectory(prefix="f2llm_onnx_export_") as tmp:
        tmp_dir = Path(tmp)
        export_dir = tmp_dir / "export"
        cmd = [
            sys.executable,
            "-m",
            "optimum.exporters.onnx",
            "--model",
            args.model_id,
            "--task",
            "feature-extraction",
            "--library-name",
            "transformers",
            "--opset",
            str(args.opset),
            "--sequence_length",
            str(args.sequence_length),
            str(export_dir),
        ]
        print("Running:", " ".join(cmd))
        subprocess.run(cmd, check=True)

        onnx_files = sorted(export_dir.glob("*.onnx"))
        if not onnx_files:
            onnx_files = sorted(export_dir.rglob("*.onnx"))
        if not onnx_files:
            raise RuntimeError("Optimum export completed but no .onnx file was produced.")

        onnx_dir = output_dir / "onnx"
        onnx_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(onnx_files[0], onnx_dir / "model.onnx")

        for extra_file in export_dir.iterdir():
            if extra_file.is_file() and extra_file.suffix != ".onnx":
                shutil.copy2(extra_file, output_dir / extra_file.name)

    print(f"F2LLM ONNX export ready at {output_dir}")
    print(f"Set F2LLM_MODEL_PATH={output_dir} or use the backend default path.")


if __name__ == "__main__":
    main()
