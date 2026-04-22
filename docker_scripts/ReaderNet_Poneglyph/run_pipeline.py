import sys
from pathlib import Path

# Add panel_detector to path
sys.path.insert(0, str(Path(__file__).resolve().parent / "panel_detector"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "readernet"))

from panel_detector.export_dataset_yolo import main as export_yolo_main
from panel_detector.train_yolo import train as train_yolo
from panel_detector.compare_models import compare as compare_yolo
from panel_detector.export_dataset_reading_order import main as export_ro_main
from panel_detector.train_reading_order import train as train_ro
from panel_detector.compare_reading_order import compare as compare_ro
from panel_detector.uploader import upload as upload_panel
from readernet.export_dataset import main as export_readernet_main
from readernet.train_readernet import train as train_readernet
from readernet.compare_models import compare as compare_readernet
from readernet.uploader import upload as upload_readernet


def run():
    print("=" * 60)
    print("ReaderNet Poneglyph - Full Training Pipeline")
    print("=" * 60)

    # Step 1: Panel Detector
    print("\n[1/6] Exporting panel detector dataset...")
    export_yolo_main()

    print("\n[2/6] Training panel detector...")
    onnx_path_yolo = train_yolo()

    print("\n[3/6] Training panel reading order model...")
    export_ro_main()
    onnx_path_ro = train_ro()

    print("\n[4/6] Comparing and uploading panel models...")
    is_better_yolo = compare_yolo()
    is_better_ro = compare_ro()
    if is_better_yolo and onnx_path_yolo:
        upload_panel(onnx_path_yolo, path_in_repo="panel_detector.onnx")
    if is_better_ro and onnx_path_ro:
        upload_panel(onnx_path_ro, path_in_repo="reading_order.onnx")

    # Step 2: ReaderNet
    print("\n[5/6] Exporting ReaderNet dataset (panel-aware)...")
    export_readernet_main()

    print("\n[6/6] Training ReaderNet Poneglyph...")
    onnx_path_readernet = train_readernet()

    print("\nComparing and uploading ReaderNet model...")
    is_better_readernet = compare_readernet()
    if is_better_readernet and onnx_path_readernet:
        upload_readernet(onnx_path_readernet)

    print("\n" + "=" * 60)
    print("Pipeline complete!")
    print("=" * 60)


if __name__ == "__main__":
    run()
