# 1. Base Image - PyTorch 2.5.1 required for modern transformers
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel

# 2. Stable environment setup
ENV CUDA_HOME=/usr/local/cuda
ENV PATH=${CUDA_HOME}/bin:${PATH}
ENV LD_LIBRARY_PATH=${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}
# Set PyTorch global index to ALWAYS use CUDA whl (cu124 for PyTorch 2.5.1)
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu124

# 3. System dependencies (Stable layer)
RUN apt-get update && apt-get install -y \
    build-essential cmake git wget curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 4. Pre-install Python tools (Stable layer)
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# 5. External tools (llama.cpp) (Stable layer)
# We do this before COPY . to avoid re-cloning on every code change
RUN git clone https://github.com/ggerganov/llama.cpp.git /app/llama.cpp \
    && cd /app/llama.cpp \
    && pip install --no-cache-dir -r requirements.txt

# 6. Dependency management (Cached layer)
# We copy ONLY the requirements file first to take advantage of layer caching
COPY requirements.txt .
# We use --no-deps for transformers OR pin torch to avoid re-downloading 2.6.0+cpu
RUN pip install --no-cache-dir -r requirements.txt

# 7. Final application code (Fastest changing layer)
# We skip flash-attn build as it's too slow and PyTorch's native SDPA is already very efficient on RTX 3090/4090.
COPY . .

CMD ["python", "run_pipeline.py"]
