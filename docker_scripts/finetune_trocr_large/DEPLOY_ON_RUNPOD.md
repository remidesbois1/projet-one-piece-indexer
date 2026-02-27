# Deploying Fine-Tuning Job to RunPod (LARGE Model)

This guide explains how to deploy the **trocr-large-printed** fine-tuning pipeline to a RunPod GPU instance. The container is configured to automatically download data, train the model, upload the results to Hugging Face, and then **terminate the pod** to minimize costs.

## What's different from the base version?

| Parameter | Base | Large |
| :--- | :--- | :--- |
| Model | `trocr-base-printed` | `trocr-large-printed` |
| Batch size | 24 | 8 (x3 gradient accum) |
| `no_repeat_ngram_size` | 3 | 0 |
| `length_penalty` | 2.0 | 1.0 |
| `label_smoothing_factor` | — | 0.1 |
| `weight_decay` | — | 0.05 |
| `lr_scheduler_type` | linear | cosine |
| `warmup_ratio` | — | 0.1 |
| Evaluation | every 300 steps | every epoch |
| HF Repo | `trocr-onepiece-fr` | `trocr-onepiece-fr-large` |

## Prerequisites

1.  **Docker Account**: [Docker Hub](https://hub.docker.com/) (or another registry).
2.  **RunPod Account**: [RunPod.io](https://www.runpod.io/).
3.  **Hugging Face Token**: Write access token.
4.  **Supabase Credentials**: URL and Service Role Key.

## Step 1: Build and Push Docker Image

Navigate to this directory (`docker_scripts/finetune_trocr_large`) and run:

```bash
docker login
docker build -t yourusername/trocr-finetune-large:latest .
docker push yourusername/trocr-finetune-large:latest
```

## Step 2: Get RunPod API Key

1.  Go to [RunPod Settings](https://www.runpod.io/console/user/settings).
2.  Create an **API Key**. Copy it.

## Step 3: Launch on RunPod

1.  Go to **RunPod Console** -> **Pods** -> **Deploy**.
2.  Choose a GPU with **>= 24GB VRAM** (e.g., **RTX 4090**, **A40**, or **L40S**).
3.  Click **Customize Deployment**.
4.  **Container Image**: `yourusername/trocr-finetune-large:latest`
5.  **Container Disk**: 30GB+ recommended (the large model weights are heavier).
6.  **Environment Variables**:

    | Key | Value |
    | :--- | :--- |
    | `SUPABASE_URL` | Your Supabase URL |
    | `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase Service Role Key |
    | `HF_TOKEN` | Your Hugging Face Token (Write) |
    | `RUNPOD_API_KEY` | **Your RunPod API Key** (Crucial for auto-termination) |

7.  **Start Container**.

## What Happens Next?

1.  The pod initializes and pulls your Docker image.
2.  The script `run_pipeline.py` starts automatically.
3.  **Logs**: You can view the logs in the RunPod console.
4.  **Completion**: The pod auto-terminates and billing stops.
5.  **Results**: Check `Remidesbois/trocr-onepiece-fr-large` on Hugging Face.

## VRAM Note

The large model uses significantly more VRAM. If you see OOM errors:
- Reduce `per_device_train_batch_size` from 8 to 4 in `finetunescript.py`
- Increase `gradient_accumulation_steps` from 3 to 6 to keep the effective batch size the same
