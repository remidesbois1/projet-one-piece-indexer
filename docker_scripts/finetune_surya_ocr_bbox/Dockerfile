# PyTorch 2.7 + CUDA 12.8 supports RTX 5090 / Blackwell.
FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel

ENV CUDA_HOME=/usr/local/cuda
ENV PATH=${CUDA_HOME}/bin:${PATH}
ENV LD_LIBRARY_PATH=${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}
ENV PYTHONUNBUFFERED=1
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128
ENV HF_HOME=/workspace/hf-cache
ENV SURYA_BBOX_DATASET_DIR=/workspace/surya_bbox_dataset
ENV SURYA_BBOX_OUTPUT_DIR=/workspace/outputs_surya_bbox

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    curl \
    git \
    git-lfs \
    libgl1 \
    libglib2.0-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "run_pipeline.py"]
