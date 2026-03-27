from export_dataset import main as export_main
from train_readernet import train
# uploader is optional if token and repo are not set up yet, but we include it.
from uploader import upload
from pathlib import Path

def run():
    print("--- Starting Pipeline for ReaderNet V6 ---")
    dataset_ann = Path(__file__).resolve().parent / "dataset" / "train" / "annotations.json"
    if dataset_ann.exists():
        print(f"Dataset already exists at {dataset_ann.parent}. Skipping export.")
    else:
        export_main()
    
    print("\n--- Starting Training ---")
    onnx_path = train()
    
    if onnx_path and Path(onnx_path).exists():
        upload(onnx_path)
    else:
        print(f"ONNX file not found or train failed.")

if __name__ == "__main__":
    run()
