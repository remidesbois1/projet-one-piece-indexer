# CUDA 12.8 / PyTorch 2.7 is the same Blackwell-compatible base used by the
# existing RTX 5090 fine-tuning containers.
FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel

ENV CUDA_HOME=/usr/local/cuda
ENV PATH=${CUDA_HOME}/bin:${PATH}
ENV LD_LIBRARY_PATH=${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/workspace/hf-cache
ENV YOLO_CONFIG_DIR=/workspace/Ultralytics
ENV POLYGON_DATASET_DIR=/app/dataset
ENV POLYGON_OUTPUT_DIR=/workspace/outputs_polygon_panel
ENV HF_REPO=Remidesbois/Yolo11-seg-Panel-Poneglyph
ENV TRAINING_PROVIDER=runpod
ENV PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
ENV POLYGON_BATCH=-1
ENV POLYGON_WORKERS=12
ENV POLYGON_CACHE_RAM=1

RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    git-lfs \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

COPY docker_scripts/train_polygon_panel/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts/polygon_case_annotator/train_polygon.py ./train_polygon.py
COPY scripts/polygon_case_annotator/dataset ./dataset
COPY docker_scripts/common_training ./common_training
COPY docker_scripts/train_polygon_panel/run_pipeline.py ./run_pipeline.py

CMD ["python", "-u", "run_pipeline.py"]
