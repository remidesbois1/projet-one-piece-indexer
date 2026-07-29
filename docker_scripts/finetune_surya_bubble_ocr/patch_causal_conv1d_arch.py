import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Restrict causal-conv1d 1.6.2.post1 CUDA code generation to one "
            "explicit compute capability."
        )
    )
    parser.add_argument("setup_py", type=Path)
    parser.add_argument(
        "--compute-capability",
        default="86",
        help="CUDA compute capability without punctuation, for example 86 or 120.",
    )
    args = parser.parse_args()

    compute_capability = args.compute_capability.replace(".", "")
    if not compute_capability.isdigit():
        raise ValueError("--compute-capability must contain only digits.")

    path = args.setup_py
    source = path.read_text(encoding="utf-8")
    anchor = source.index("# Check, if CUDA11 is installed")
    block_start = source.index("        cc_flag.append", anchor)
    block_end = source.index("\n\n    # HACK:", block_start)
    architecture_block = source[block_start:block_end]
    for expected in ("compute_75", "compute_120", "compute_121"):
        if expected not in architecture_block:
            raise RuntimeError(
                f"Unexpected causal-conv1d setup.py: missing {expected} in CUDA architecture block."
            )

    replacement = (
        "        # Projet Poneglyph builds one GPU architecture per image.\n"
        f'        cc_flag.extend(["-gencode", "arch=compute_{compute_capability},'
        f'code=sm_{compute_capability}"])'
    )
    path.write_text(
        source[:block_start] + replacement + source[block_end:],
        encoding="utf-8",
    )
    print(
        f"Patched causal-conv1d CUDA architectures: sm_{compute_capability} only.",
        flush=True,
    )


if __name__ == "__main__":
    main()
