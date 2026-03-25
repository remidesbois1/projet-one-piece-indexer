@echo off
if not exist .env (
    copy ..\..\.env .env
)
if not exist runs mkdir runs
if not exist dataset mkdir dataset
if not exist dataset_nano mkdir dataset_nano
docker run --gpus all --shm-size=8g --env-file .env -v "%cd%:/app" -v "%cd%/runs:/app/runs" -v "%cd%/dataset:/app/dataset" nano-max-train
if %ERRORLEVEL% NEQ 0 (
    pause
    exit /b %ERRORLEVEL%
)
pause
