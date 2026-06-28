FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel

ENV PYTHONUNBUFFERED=1
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128
ENV HF_HOME=/workspace/hf-cache
ENV YOLO_CONFIG_DIR=/tmp/Ultralytics
ENV PPOCR_LINE_SOURCE_DIR=/workspace/bubble_line_dataset
ENV PPOCR_LINE_DETECTOR=/workspace/line_detector/best.pt
ENV PPOCR_LINE_OUTPUT_DIR=/workspace/outputs_paddleocr_line_rec

RUN apt-get update && apt-get install -y \
    git \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENTRYPOINT ["python", "run_pipeline.py"]
