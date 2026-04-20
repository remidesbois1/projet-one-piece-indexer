@echo off
if not exist .env (
    copy ..\..\.env .env
)
if not exist runs mkdir runs
if not exist dataset_yolo mkdir dataset_yolo
docker run --gpus all --shm-size=2g --env-file .env -v "%cd%:/app" -v "%cd%/runs:/app/runs" -v "%cd%/dataset:/app/dataset" -v "%cd%/dataset_yolo:/app/dataset_yolo" panel-detector-train
if %ERRORLEVEL% NEQ 0 (
    pause
    exit /b %ERRORLEVEL%
)
pause
