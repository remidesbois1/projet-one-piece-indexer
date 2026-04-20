from export_dataset_yolo import main as export_main
from train_yolo import train
from compare_models import compare
from uploader import upload


def run():
    export_main()
    onnx_path = train()
    is_better = compare()

    if is_better:
        upload(onnx_path)


if __name__ == "__main__":
    run()
