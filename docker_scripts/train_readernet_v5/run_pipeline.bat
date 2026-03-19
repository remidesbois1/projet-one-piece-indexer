@echo off
if not exist .env (
    copy ..\..\backend\.env .env
)
if not exist dataset mkdir dataset
docker run --gpus all --shm-size=4g --env-file .env -v "%cd%:/app" -v "%cd%/dataset:/app/dataset" readernet-v5-train
if %ERRORLEVEL% NEQ 0 (
    pause
    exit /b %ERRORLEVEL%
)
pause
