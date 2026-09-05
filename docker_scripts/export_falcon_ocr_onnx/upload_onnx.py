"""Publish only the verified ONNX artifacts; never fixtures, crops or secrets."""

import argparse
import hashlib
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from huggingface_hub import HfApi

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--directory", type=Path, required=True)
parser.add_argument("--repo-id", default="Remidesbois/Falcon-OCR-Poneglyph")
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
load_dotenv(root / ".env")
load_dotenv(root / "backend" / ".env")
manifest = json.loads(
    (args.directory / "browser_manifest.json").read_text(encoding="utf-8")
)
for name, expected in manifest["files"].items():
    path = args.directory / name
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != expected["sha256"] or path.stat().st_size != expected["bytes"]:
        raise RuntimeError(f"Artifact changed: {name}")
files = [
    "decoder.onnx",
    "decoder.onnx.data",
    "browser_manifest.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "README.md",
]
api = HfApi(token=os.environ["HF_TOKEN"])
result = api.upload_folder(
    repo_id=args.repo_id,
    repo_type="model",
    folder_path=str(args.directory),
    path_in_repo="onnx",
    allow_patterns=files,
    commit_message="Add Falcon OCR ONNX with GPU KV cache, verified in Chrome WebGPU",
)
print(json.dumps({"commit_url": result.commit_url, "oid": result.oid}), flush=True)
