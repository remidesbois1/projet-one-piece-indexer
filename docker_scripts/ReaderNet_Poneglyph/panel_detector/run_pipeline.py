from export_dataset_yolo import main as export_yolo_main
from export_dataset_reading_order import main as export_ro_main
from train_yolo import train as train_yolo
from train_reading_order import train as train_ro
from compare_models import compare as compare_yolo
from compare_reading_order import compare as compare_ro
from uploader import upload


def run():
    print("Exporting datasets...")
    export_yolo_main()
    export_ro_main()

    print("\nTraining panel detector (YOLO)...")
    onnx_path_yolo = train_yolo()

    print("\nTraining reading order model...")
    onnx_path_ro = train_ro()

    print("\nComparing models...")
    is_better_yolo = compare_yolo()
    is_better_ro = compare_ro()

    if is_better_yolo:
        print("Uploading new panel detector...")
        upload(onnx_path_yolo, path_in_repo="panel_detector.onnx")
    if is_better_ro:
        print("Uploading new reading order model...")
        upload(onnx_path_ro, path_in_repo="reading_order.onnx")


if __name__ == "__main__":
    run()
