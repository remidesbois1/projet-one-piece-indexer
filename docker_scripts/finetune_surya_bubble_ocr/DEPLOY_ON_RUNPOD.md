# RunPod deployment

This folder is designed to run as a one-shot RunPod training container:

1. export validated Poneglyph bubbles from Supabase,
2. crop each bubble from the source page,
3. split strictly by `id_page`,
4. fine-tune `datalab-to/surya-ocr-2`,
5. run deterministic prompt-only validation and final held-out test benchmark,
6. optionally upload the merged model to Hugging Face,
7. optionally terminate the RunPod pod.

## Build and push

From `docker_scripts/finetune_surya_bubble_ocr`:

```bash
docker build --pull \
  -f Dockerfile \
  -t remidesbois/surya-bubble-ocr-finetune:latest \
  ..
docker push remidesbois/surya-bubble-ocr-finetune:latest
```

Le contexte parent est volontaire : l'image copie à la fois ce package et
`docker_scripts/common_training`.

On Windows:

```bat
build_and_push.bat
```

Set `DOCKER_USER`, `IMAGE_NAME`, or `TAG` before running the batch file if you need a different registry tag.

## RunPod pod settings

Recommended pod:

- GPU: RTX 3090 24 GB for the default local Ampere profile.
- Container image: `remidesbois/surya-bubble-ocr-finetune:latest`.
- Container disk: 80 GB minimum.
- Volume disk: 100 GB+ recommended, mounted at `/workspace`.
- Docker args: `--ipc=host --shm-size 32g`.

Optional preflight before launching a paid pod:

```bash
docker run --rm remidesbois/surya-bubble-ocr-finetune:latest python smoke_check.py
```

This does not download full model weights. It verifies the processor batch path,
assistant-token boundary, `eval_cer` selection, and the Qwen3.5 fast
linear-attention dependencies.

After wiring env vars and volume mounts, run the container entrypoint in dry-run mode once:

```bash
python run_pipeline.py --dry-run
```

It checks required env presence, writable `/workspace` paths, and the Surya smoke check without exporting from Supabase or training.

Use the remote preflight when you want to verify credentials before the full run:

```bash
python run_pipeline.py --dry-run --check-remote
```

This performs one read-only Supabase query against `bulles` with the production select shape and validates the Hugging Face token. It does not create a repo, export images, train, or upload weights.

Environment variables:

```text
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
HF_TOKEN=...
HF_REPO=Remidesbois/surya-bubble-ocr-poneglyph
SURYA_REQUIRE_UPLOAD=1
RUNPOD_API_KEY=...
RUNPOD_POD_ID=...
RUNPOD_TERMINATE_ON_EXIT=1
```

The Dockerfile defaults keep data and outputs under `/workspace`:

```text
SURYA_DATASET_DIR=/workspace/surya_bubble_dataset
SURYA_OUTPUT_DIR=/workspace/outputs_surya_bubble_ocr
HF_HOME=/workspace/hf-cache
```

The image is based on PyTorch 2.8.0 + CUDA 12.8 and sets
`SURYA_REQUIRE_FAST_LINEAR_ATTENTION=1`. It fails early instead of silently
training through the slow Qwen3.5 reference implementation. CUDA 12.8 is used
deliberately for compatibility with the local RTX 3090 and current NVIDIA
drivers.

After the dataset export, the full setup can be validated without taking an
optimizer step:

```bash
python train_surya_bubble_ocr.py --validate-setup
```

Default RTX 3090 training profile:

```text
SURYA_TRAIN_MODE=hybrid
SURYA_TRAIN_BATCH=16
SURYA_EVAL_BATCH=16
SURYA_GRAD_ACCUM=2
SURYA_GEN_EVAL_BATCH=8
SURYA_GRADIENT_CHECKPOINTING=0
SURYA_VISION_TRAIN_LAST_BLOCKS=4
```

## Resume and rerun controls

- `SURYA_FORCE_EXPORT=1`: re-export the dataset.
- `SURYA_CLEAN_DATASET=1`: delete the existing dataset before export.
- `SURYA_FORCE_TRAIN=1`: train again even if a final model exists.
- `SURYA_SKIP_UPLOAD=1`: do not upload to Hugging Face.
- `RUNPOD_ERROR_SHUTDOWN_DELAY_SECONDS=600`: keep a failed pod alive long enough to read logs.

## Expected artifacts

After a successful run:

```text
/workspace/surya_bubble_dataset/
  dataset_report.json
  train/metadata.jsonl
  val/metadata.jsonl
  test/metadata.jsonl

/workspace/outputs_surya_bubble_ocr/final_merged/
  config.json
  model*.safetensors
  tokenizer / processor files
  benchmark_test.json

/workspace/outputs_surya_bubble_ocr/pipeline_summary.json
```

`benchmark_test.json` is the acceptance artifact for the held-out test set. It contains global metrics, length-bucket metrics, slice metrics, baseline comparisons when available, all samples, and the top 20 worst errors.
