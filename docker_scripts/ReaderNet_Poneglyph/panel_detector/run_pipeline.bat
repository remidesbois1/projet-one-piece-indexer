@echo off
if not exist .env (
    copy ..\..\.env .env
)
if not exist runs mkdir runs
if not exist runs_reading_order mkdir runs_reading_order
if not exist dataset_yolo mkdir dataset_yolo
if not exist dataset_reading_order mkdir dataset_reading_order
docker run --gpus all --shm-size=2g --env-file .env -v "%cd%:/app" -v "%cd%/runs:/app/runs" -v "%cd%/runs_reading_order:/app/runs_reading_order" -v "%cd%/dataset:/app/dataset" -v "%cd%/dataset_yolo:/app/dataset_yolo" -v "%cd%/dataset_reading_order:/app/dataset_reading_order" panel-detector-train
if %ERRORLEVEL% NEQ 0 (
    pause
    exit /b %ERRORLEVEL%
)
pause
