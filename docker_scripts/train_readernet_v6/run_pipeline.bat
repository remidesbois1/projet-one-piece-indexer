@echo off
docker run --gpus all --shm-size=8g -v "%cd%\dataset:/app/dataset" --env-file .env readernet-v6-train
pause
