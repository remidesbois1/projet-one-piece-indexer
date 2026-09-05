# Blackwell SM 12.0, native BF16 and the AuxRequest API used by pinned Falcon.
FROM pytorch/pytorch:2.11.0-cuda13.0-cudnn9-devel

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/cache/huggingface \
    TORCHINDUCTOR_CACHE_DIR=/cache/inductor \
    TRITON_CACHE_DIR=/cache/triton \
    PYTORCH_ALLOC_CONF=expandable_segments:True \
    TOKENIZERS_PARALLELISM=false \
    OMP_NUM_THREADS=8 \
    PYTHONUTF8=1 \
    MPLCONFIGDIR=/cache/matplotlib

RUN apt-get update && apt-get install -y --no-install-recommends python3-venv fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv --system-site-packages /opt/falcon-venv
ENV VIRTUAL_ENV=/opt/falcon-venv
ENV PATH=/opt/falcon-venv/bin:${PATH}

WORKDIR /app
# The base includes PyTorch's developer CLI spin, whose Click constraint
# conflicts with the Hub CLI. It is not a runtime/training dependency.
RUN /usr/bin/python3 -m pip uninstall --break-system-packages -y spin
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && python -m pip check \
    && python -c "import torch; from torch.nn.attention.flex_attention import AuxRequest; assert torch.__version__.startswith('2.11.'); assert 'sm_120' in torch.cuda.get_arch_list() or not torch.cuda.is_available()"
COPY *.py *.ps1 *.bat Dockerfile .dockerignore README.md THIRD_PARTY_NOTICES.md ./
RUN python -m unittest discover -s . -p "test_*.py" -v
ENTRYPOINT ["python", "run_pipeline.py"]
