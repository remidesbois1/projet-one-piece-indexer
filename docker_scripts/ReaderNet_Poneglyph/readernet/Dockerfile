FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-devel

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libavif-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --force-reinstall --no-cache-dir pillow==10.4.0 pillow-avif-plugin==1.4.3

COPY . .

CMD ["python", "run_pipeline.py"]
