# RunPod quickstart

Use this image in RunPod:

```text
remidesbois/surya-bubble-ocr-finetune:latest
```

For a pinned digest, use the value in `RUNPOD_IMAGE.txt`.

## Required env

```text
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
HF_TOKEN=...
HF_REPO=Remidesbois/surya-bubble-ocr-poneglyph
SURYA_REQUIRE_UPLOAD=1
```

Optional auto-termination:

```text
RUNPOD_API_KEY=...
RUNPOD_POD_ID=...
RUNPOD_TERMINATE_ON_EXIT=1
```

If `HF_REPO` is omitted, the pipeline defaults to:

```text
Remidesbois/surya-bubble-ocr-poneglyph
```

## Recommended RunPod settings

```text
GPU: RTX 5090 or 32 GB+ VRAM GPU
Container disk: 80 GB minimum
Volume: 100 GB+ mounted at /workspace
Docker args: --ipc=host --shm-size 32g
```

The image defaults to:

```text
SURYA_DATASET_DIR=/workspace/surya_bubble_dataset
SURYA_OUTPUT_DIR=/workspace/outputs_surya_bubble_ocr
HF_HOME=/workspace/hf-cache
```

## Preflight

In the pod terminal:

```bash
python run_pipeline.py --dry-run --check-remote
```

This validates env presence, writable `/workspace` mounts, the Surya model/processor API, the Supabase query shape, and the HF token. It does not export images, train, create repos, or upload weights.

## Full run

The container starts the full run by default. If you are in a shell:

```bash
python run_pipeline.py
```

Expected final artifacts:

```text
/workspace/surya_bubble_dataset/dataset_report.json
/workspace/outputs_surya_bubble_ocr/final_merged/benchmark_test.json
/workspace/outputs_surya_bubble_ocr/pipeline_summary.json
```
