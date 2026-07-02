from __future__ import annotations

import argparse
from pathlib import Path
import json
import os
import sys
from typing import Any

import modal


DEFAULT_APP_NAME = os.getenv("PONEGLYPH_MODAL_APP_NAME", "poneglyph-training")
TRAIN_MODEL_FUNCTIONS = {
    "L40S": "train_model",
    "A100-80GB": "train_model_a100_80gb",
    "H100": "train_model_h100",
    "H200": "train_model_h200",
    "B200": "train_model_b200",
}


def parse_params(raw: str | None = None, params_file: str | None = None) -> dict[str, Any]:
    if params_file:
        raw = Path(params_file).read_text(encoding="utf-8-sig")
    if not raw:
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("params-json must decode to an object")
    return value


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def submit(args: argparse.Namespace, function_name: str) -> None:
    params = parse_params(args.params_json, args.params_file)
    if function_name == "train_model":
        gpu = str(params.get("gpu") or "L40S")
        function_name = TRAIN_MODEL_FUNCTIONS.get(gpu)
        if not function_name:
            allowed = ", ".join(sorted(TRAIN_MODEL_FUNCTIONS))
            raise ValueError(f"Unsupported Modal GPU '{gpu}'. Allowed values: {allowed}")
    fn = modal.Function.from_name(args.app_name, function_name)
    call = fn.spawn(args.job_id, args.training_kind, params)
    print_json(
        {
            "app_name": args.app_name,
            "function_name": function_name,
            "modal_call_id": call.object_id,
        }
    )


def cancel_call(args: argparse.Namespace) -> None:
    call = modal.FunctionCall.from_id(args.modal_call_id)
    call.cancel(terminate_containers=args.terminate_containers)
    print_json({"modal_call_id": args.modal_call_id, "cancelled": True})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Submit or control Poneglyph Modal training jobs.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_submit_parser(name: str, help_text: str) -> argparse.ArgumentParser:
        sub = subparsers.add_parser(name, help=help_text)
        sub.add_argument("--app-name", default=DEFAULT_APP_NAME)
        sub.add_argument("--job-id", required=True)
        sub.add_argument("--training-kind", required=True)
        sub.add_argument("--params-json", default="{}")
        sub.add_argument("--params-file", help="Read params JSON from a file to avoid shell quoting issues.")
        return sub

    add_submit_parser("submit-training-job", "Spawn the CPU orchestration function that prepares then trains.")
    add_submit_parser("submit-prepare-dataset", "Spawn only prepare_dataset.")
    add_submit_parser("submit-train-model", "Spawn only train_model.")

    cancel = subparsers.add_parser("cancel-call", help="Cancel an existing Modal FunctionCall.")
    cancel.add_argument("--modal-call-id", required=True)
    cancel.add_argument("--terminate-containers", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "submit-training-job":
        submit(args, "run_training_job")
    elif args.command == "submit-prepare-dataset":
        submit(args, "prepare_dataset")
    elif args.command == "submit-train-model":
        submit(args, "train_model")
    elif args.command == "cancel-call":
        cancel_call(args)
    else:
        parser.error(f"Unknown command: {args.command}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
