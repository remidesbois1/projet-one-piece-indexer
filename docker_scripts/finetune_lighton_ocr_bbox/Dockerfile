FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel

ENV CUDA_HOME=/usr/local/cuda
ENV PATH=${CUDA_HOME}/bin:${PATH}
ENV LD_LIBRARY_PATH=${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128
ENV PYTHONUNBUFFERED=1
ENV LIGHTON_IMAGE_LONGEST_EDGE=1500
ENV LIGHTON_HARDWARE_PROFILE=rtx5090
ENV LIGHTON_AUTO_BATCH=1

RUN apt-get update && apt-get install -y \
    build-essential cmake git wget curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

COPY finetune_lighton_ocr_bbox/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY finetune_lighton_ocr_bbox/ /app/
COPY finetune_lighton_ocr/train_lighton_ocr.py /app/lighton_crop_engine.py
COPY common_training/ /app/common_training/

CMD ["python", "run_pipeline.py"]
