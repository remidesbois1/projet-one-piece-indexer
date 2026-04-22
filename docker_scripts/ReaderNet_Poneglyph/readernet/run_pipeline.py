from export_dataset import main as export_main
from train_readernet import train
from compare_models import compare
from uploader import upload
from pathlib import Path


def run():
    export_main()
    onnx_path = train()

    if onnx_path and Path(onnx_path).exists():
        is_better = compare()
        if is_better:
            upload(onnx_path)


if __name__ == "__main__":
    run()
