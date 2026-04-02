import subprocess
import sys


def run(cmd):
    print(f"\n>>> {cmd}")
    result = subprocess.run(cmd, shell=True)
    if result.returncode != 0:
        print(f"FAILED: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    # Step 1: Export dataset from Supabase (stratified split)
    run(f"{sys.executable} export_dataset.py")

    # Step 2: Train ReaderNet V6
    run(f"{sys.executable} train_readernet_v6.py")

    # Step 3: Export to ONNX
    run(f"{sys.executable} train_readernet_v6.py export")

    # Step 4: Upload to HuggingFace
    run(f"{sys.executable} uploader.py")
