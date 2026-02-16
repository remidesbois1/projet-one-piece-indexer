# Deploying Fine-Tuning Job to RunPod

This guide explains how to deploy the fine-tuning pipeline to a RunPod GPU instance. The container is configured to automatically download data, train the model, upload the results to Hugging Face, and then **terminate the pod** to minimize costs.

## Prerequisites

1.  **Docker Account**: [Docker Hub](https://hub.docker.com/) (or another registry).
2.  **RunPod Account**: [RunPod.io](https://www.runpod.io/).
3.  **Hugging Face Token**: Write access token.
4.  **Supabase Credentials**: URL and Service Role Key.

## Step 1: Build and Push Docker Image

First, you need to build the Docker image and push it to a public registry so RunPod can pull it.

Navigate to this directory (`docker_scripts/finetune_trocr`) and run:

```bash
# Login to Docker Hub
docker login

# Build the image (replace 'yourusername' with your Docker Hub username)
docker build -t yourusername/trocr-finetune:latest .

# Push the image
docker push yourusername/trocr-finetune:latest
```

## Step 2: Get RunPod API Key

1.  Go to [RunPod Settings](https://www.runpod.io/console/user/settings).
2.  Create an **API Key**. Copy it.

## Step 3: Launch on RunPod

1.  Go to **RunPod Console** -> **Pods** -> **Deploy**.
2.  Choose a GPU (e.g., **NVIDIA A40** or **L40S** are good cost/performance for this).
3.  Click **Customize Deployment** (or Select Template -> Customize).
4.  **Container Image**: Enter your image: `yourusername/trocr-finetune:latest`
5.  **Container Disk**: Ensure it's large enough (e.g., 20GB or 30GB) to hold the dataset and model checkpoints.
6.  **Environment Variables**: You **MUST** set these:

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
3.  **Logs**: You can view the logs in the RunPod console (click "Logs" on the pod) to monitor progress.
4.  **Completion**:
    - Once training and upload are complete, the script sends a signal to RunPod to `podTerminate`.
    - The pod will be destroyed, and billing will stop immediately.
5.  **Results**: Check your Hugging Face repository (`Remidesbois/trocr-onepiece-fr`) for the new model.

## Troubleshooting

-   **Pod didn't terminate?**: Check if `RUNPOD_API_KEY` was set correctly. If not, you must manually terminate the pod to stop billing.
-   **Training failed?**: Check the logs. The script also attempts to terminate on failure, so if it crashed early, the pod might already be gone. If you want to debug, you might want to launch *without* `RUNPOD_API_KEY` so it stays alive after failure.
