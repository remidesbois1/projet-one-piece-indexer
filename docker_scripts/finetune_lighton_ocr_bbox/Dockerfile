FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel

ENV CUDA_HOME=/usr/local/cuda
ENV PATH=${CUDA_HOME}/bin:${PATH}
ENV LD_LIBRARY_PATH=${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu128
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    build-essential cmake git wget curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

RUN SITE=$(python -c "import site; print(site.getsitepackages()[0])") && \
    rm -rf ${SITE}/transformers* ${SITE}/peft* ${SITE}/accelerate* ${SITE}/evaluate* ${SITE}/tokenizers* && \
    pip uninstall -y transformers peft accelerate evaluate tokenizers 2>/dev/null || true

COPY requirements.txt .
RUN pip install --no-cache-dir --force-reinstall --no-deps -r requirements.txt && \
    pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "run_pipeline.py"]
