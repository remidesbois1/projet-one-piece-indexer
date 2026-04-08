# 1. Base Image - PyTorch 2.7.0 + CUDA 12.8 for RTX 5090 (sm_120 / Blackwell)
FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel

# 2. Stable environment setup
ENV CUDA_HOME=/usr/local/cuda
ENV PATH=${CUDA_HOME}/bin:${PATH}
ENV LD_LIBRARY_PATH=${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128
# Force unbuffered Python output for real-time RunPod logs
ENV PYTHONUNBUFFERED=1

# 3. System dependencies (Stable layer)
RUN apt-get update && apt-get install -y \
    build-essential cmake git wget curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 4. Pre-install Python tools (Stable layer)
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# 5. Dependency management (Cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 6. Final application code (Fastest changing layer)
COPY . .

CMD ["python", "run_pipeline.py"]
