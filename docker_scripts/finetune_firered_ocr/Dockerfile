FROM pytorch/pytorch:2.2.0-cuda12.1-cudnn8-devel

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Install Python requirements
RUN pip install --no-cache-dir -r requirements.txt

# Install flash-attention using a precompiled wheel (cu122 works perfectly on cu121 and bypasses the 2 hours build!)
RUN pip install --no-cache-dir https://github.com/Dao-AILab/flash-attention/releases/download/v2.5.6/flash_attn-2.5.6%2Bcu122torch2.2cxx11abiFALSE-cp310-cp310-linux_x86_64.whl

COPY . /app

CMD ["python", "run_pipeline.py"]
