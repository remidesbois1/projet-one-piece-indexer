import os
from huggingface_hub import HfApi

print("Upload du décodeur quantizé Poneglyph vers HuggingFace...")

DEST_REPO = "Remidesbois/LightonOCR-2-1b-poneglyph-ONNX"
TOKEN = ""

api = HfApi(token=TOKEN)

quantized_dir = "quantized_poneglyph"
files_to_upload = [
    "decoder_model_merged_quantized.onnx",
    "decoder_model_merged_quantized.onnx_data" # or .onnx.data
]

uploaded = 0
for file in os.listdir(quantized_dir):
    if file.startswith("decoder_model_merged") and (file.endswith(".onnx") or file.endswith(".onnx_data") or file.endswith(".data")):
        local_path = os.path.join(quantized_dir, file)
        # Rename it dynamically to fit HuggingFace convention _quantized if it's named otherwise
        repo_name = file
        if "decoder_model_merged.onnx_quantized" in file:
             repo_name = file.replace(".onnx_quantized", "_quantized")
             
        # transformers.js expects _quantized.onnx and _quantized.onnx_data
        if "decoder_model_merged_quantized.onnx" not in repo_name and repo_name == "decoder_model_merged.onnx":
            repo_name = "decoder_model_merged_quantized.onnx"
        if "decoder_model_merged_quantized.onnx_data" not in repo_name and (repo_name.endswith(".onnx_data") or repo_name.endswith(".data")):
            repo_name = "decoder_model_merged_quantized.onnx_data"
            
        repo_path = f"onnx/{repo_name}"
        
        print(f"Uploading {local_path} as {repo_path}...")
        api.upload_file(
            path_or_fileobj=local_path,
            path_in_repo=repo_path,
            repo_id=DEST_REPO,
            commit_message="Fix Missing input_ids error by injecting Poneglyph weights into proper multimodal decoder ONNX graph structure."
        )
        uploaded += 1

print(f"\n🎉 Succès ! {uploaded} fichiers uploadés sur ton repo HF.")
