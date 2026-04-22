@echo off
if not exist .env (
    copy ..\..\.env .env
)
if not exist dataset mkdir dataset
if not exist dataset\train mkdir dataset\train\images
if not exist dataset\val mkdir dataset\val\images
docker run --gpus all --shm-size=4g --env-file .env -v "%cd%:/app/readernet" -v "%cd%/../panel_detector:/app/panel_detector" readernet-poneglyph-train
if %ERRORLEVEL% NEQ 0 (
    pause
    exit /b %ERRORLEVEL%
)
pause
