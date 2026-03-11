import os
import subprocess
import argparse
from huggingface_hub import hf_hub_download, snapshot_download

def download_onnx_tools():
    tools_dir = "onnx_export_tools"
    ref_dir = os.path.join(tools_dir, "pytorch_reference")
    
    if os.path.exists(tools_dir) and os.path.exists(os.path.join(tools_dir, "builder.py")):
        print("ONNX export tools already downloaded. Skipping download.")
        return tools_dir, ref_dir

    print("Downloading ONNX export tools from onnx-community...")
    os.makedirs(tools_dir, exist_ok=True)
    
    # Files to download from the Qwen3 ONNX community repo
    repo_id = "onnx-community/Qwen3-4B-VL-ONNX"
    
    # Download modeling_qwen3_vl.py (patched)
    hf_hub_download(repo_id=repo_id, filename="pytorch_reference/modeling_qwen3_vl.py", local_dir=tools_dir)
    
    # Download builder.py and inference script
    hf_hub_download(repo_id=repo_id, filename="builder.py", local_dir=tools_dir)
    hf_hub_download(repo_id=repo_id, filename="qwen3vl-oga-inference.py", local_dir=tools_dir)
    
    return tools_dir, ref_dir

def download_model(model_name: str, local_dir: str):
    if os.path.exists(local_dir) and os.path.exists(os.path.join(local_dir, "config.json")):
        print(f"Model {model_name} already exists in {local_dir}. Skipping download.")
        return

    print(f"Downloading model {model_name} to {local_dir}...")
    snapshot_download(repo_id=model_name, local_dir=local_dir)

def export_to_onnx(tools_dir: str, ref_dir: str, input_model_dir: str, output_dir: str, precision: str):
    print(f"Exporting model to ONNX ({precision})...")
    builder_script = os.path.join(tools_dir, "builder.py")
    
    # Build the command based on the builder.py from onnx-community
    cmd = [
        "python", builder_script,
        "--input", os.path.abspath(input_model_dir),
        "--reference", os.path.abspath(ref_dir),
        "--output", os.path.abspath(output_dir),
        "--precision", precision
    ]
    
    print("Running command:", " ".join(cmd))
    subprocess.run(cmd, check=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export FireRed-OCR to ONNX Web format")
    parser.add_argument("--model", type=str, default="Remidesbois/firered-ocr-onepiece", help="Hugging Face model ID to export")
    parser.add_argument("--precision", type=str, choices=["int4", "int8", "fp32"], default="int4", help="Quantization precision")
    args = parser.parse_args()

    # 1. Download export scripts
    tools_dir, ref_dir = download_onnx_tools()
    
    # 2. Download the model locally
    model_safe_name = args.model.replace("/", "_")
    input_model_dir = os.path.join(tools_dir, model_safe_name)
    download_model(args.model, input_model_dir)
    
    # 3. Export to ONNX
    output_onnx_dir = f"./firered-ocr-onnx-{args.precision}"
    export_to_onnx(tools_dir, ref_dir, input_model_dir, output_onnx_dir, args.precision)
    
    print(f"\n[SUCCESS] Export complete! ONNX model is saved in: {output_onnx_dir}")
    print("\nYou can test it using the downloaded inference script:")
    print(f"python {tools_dir}/qwen3vl-oga-inference.py -m {output_onnx_dir} -e follow_config --non-interactive -pr \"Describe this image.\"")
