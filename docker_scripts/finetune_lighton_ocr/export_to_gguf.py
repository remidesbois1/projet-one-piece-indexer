import os
import subprocess
import sys
from pathlib import Path

# Paths
LLAMA_CPP_PATH = Path("/app/llama.cpp") # Inside container
MODEL_DIR = Path("./outputs_lighton_manga/final_lora_merged")
GGUF_OUTPUT = Path("./outputs_lighton_manga/lighton-ocr-2-1b-manga.gguf")
QUANTI_LEVEL = "Q4_K_M"
GGUF_QUANTI_OUTPUT = Path(f"./outputs_lighton_manga/lighton-ocr-2-1b-manga-{QUANTI_LEVEL}.gguf")

def main():
    if not MODEL_DIR.exists():
        print(f"❌ Model dir {MODEL_DIR} not found.")
        sys.exit(1)

    print("\n📦 Converting to GGUF (f16)...")
    # Using convert_hf_to_gguf.py from llama.cpp
    convert_cmd = [
        sys.executable,
        str(LLAMA_CPP_PATH / "convert_hf_to_gguf.py"),
        str(MODEL_DIR),
        "--outfile", str(GGUF_OUTPUT),
        "--outtype", "f16"
    ]
    
    result = subprocess.run(convert_cmd)
    if result.returncode != 0:
        print("❌ GGUF conversion failed.")
        sys.exit(1)

    print(f"✅ GGUF (f16) saved to : {GGUF_OUTPUT}")

    print(f"\n💎 Quantizing to {QUANTI_LEVEL}...")
    # Using llama-quantize binary (compiled during build in Dockerfile)
    # Note: llama-quantize should be in llama.cpp/llama-quantize or build/bin/llama-quantize
    quant_exe = str(LLAMA_CPP_PATH / "llama-quantize")
    if not os.path.exists(quant_exe):
        # Fallback to build folder if using cmake
        quant_exe = str(LLAMA_CPP_PATH / "build" / "bin" / "llama-quantize")

    quant_cmd = [
        quant_exe,
        str(GGUF_OUTPUT),
        str(GGUF_QUANTI_OUTPUT),
        QUANTI_LEVEL
    ]
    
    result = subprocess.run(quant_cmd)
    if result.returncode != 0:
        print("❌ Quantization failed.")
        sys.exit(1)

    print(f"✅ Quantized GGUF saved to : {GGUF_QUANTI_OUTPUT}")

if __name__ == "__main__":
    main()
