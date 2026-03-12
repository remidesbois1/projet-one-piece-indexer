@echo off
if not exist .env (
    copy ..\..\.env .env
)
if not exist runs mkdir runs
if not exist dataset mkdir dataset
docker run --gpus all --shm-size=2g --env-file .env -v "%cd%:/app" -v "%cd%/runs:/app/runs" -v "%cd%/dataset:/app/dataset" bubble-detector-train
if %ERRORLEVEL% NEQ 0 (
    pause
    exit /b %ERRORLEVEL%
)
pause
