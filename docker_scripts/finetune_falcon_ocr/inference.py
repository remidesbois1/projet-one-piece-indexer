"""Benchmark-compatible local inference, including exact token caps."""

import argparse

from config import Config
from model import FalconEngine, autocast


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "model", help="Local downloaded model folder (root or evaluated/)"
    )
    parser.add_argument("images", nargs="+")
    args = parser.parse_args()
    import json
    from pathlib import Path

    config_path = Path(args.model) / "run_config.json"
    if not config_path.exists():
        config_path = Path(args.model).parent / "run_config.json"
    config = (
        Config(**json.loads(config_path.read_text(encoding="utf-8")))
        if config_path.exists()
        else Config()
    )
    engine = FalconEngine(config, source=args.model)
    engine.model.eval()
    for start in range(0, len(args.images), config.eval_batch):
        paths = args.images[start : start + config.eval_batch]
        with autocast():
            predictions = engine.generate([{"image_path": path} for path in paths])
        for path, prediction in zip(paths, predictions):
            print(json.dumps({"image": path, **prediction}, ensure_ascii=False))


if __name__ == "__main__":
    main()
