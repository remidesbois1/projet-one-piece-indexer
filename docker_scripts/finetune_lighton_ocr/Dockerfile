# 1. Reproducible Ampere image for RTX 3090 (24 GB, BF16/TF32)
FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel

# 2. Stable environment setup
ENV CUDA_HOME=/usr/local/cuda
ENV PATH=${CUDA_HOME}/bin:${PATH}
ENV LD_LIBRARY_PATH=${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128
# Force unbuffered Python output for real-time RunPod logs
ENV PYTHONUNBUFFERED=1
ENV LIGHTON_IMAGE_LONGEST_EDGE=700
ENV LIGHTON_AUTO_BATCH=1

# 3. System dependencies (Stable layer)
RUN apt-get update && apt-get install -y \
    build-essential cmake git wget curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 4. Pre-install Python tools (Stable layer)
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# 5. Dependency management (Cached layer)
COPY finetune_lighton_ocr/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 6. Final application code (Fastest changing layer)
COPY finetune_lighton_ocr/ /app/
COPY common_training/ /app/common_training/

CMD ["python", "run_pipeline.py"]
