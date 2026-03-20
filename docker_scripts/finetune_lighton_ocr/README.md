# LightOnOCR-2-1B Fine-tuning for One Piece Indexer

This directory contains the scripts needed to fine-tune LightOnOCR-2-1B on the manga dataset and export it to GGUF for the frontend.

## Requirements
- Nvidia RTX 3090 or higher (24GB VRAM recommended)
- Docker with NVIDIA Container Toolkit

## Setup
1. Copy your `.env` to the project root with:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `HF_TOKEN`
   - `HF_REPO` (e.g., `Remidesbois/lighton-ocr-2-1b-manga-gguf`)

## Usage

### Local (Nvidia GPU with Docker)
1. Ensure your `.env` is at the root of the project with:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `HF_TOKEN`
   - `HF_REPO` (e.g., `Remidesbois/lighton-ocr-2-1b-manga-gguf`)
2. Run `build_image.bat` to build the Docker image.
3. Run `run_pipeline.bat` to start the fine-tuning.

### Remote (RunPod / Cloud GPU)
1. Run `build_and_push.bat` to push the image to Docker Hub (edit `DOCKER_USER` in the bat file first).
2. Deploy a pod using the image `DOCKER_USER/lighton-ocr-finetune:latest`.
3. Set environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HF_TOKEN`, `RUNPOD_API_KEY`, `RUNPOD_POD_ID`.

The pipeline will:
1. Export the validated bubbles from Supabase.
2. Fine-tune the model using LoRA.
3. Merge weights and export to GGUF (f16 and Q4_K_M).
4. Push the GGUF files to Hugging Face.
5. Auto-terminate the pod if `RUNPOD_API_KEY` is provided.
