@echo off
if not exist .env (
    copy ..\..\.env .env
)
if not exist panel_detector\runs mkdir panel_detector\runs
if not exist panel_detector\runs_reading_order mkdir panel_detector\runs_reading_order
if not exist panel_detector\dataset mkdir panel_detector\dataset
if not exist panel_detector\dataset_yolo mkdir panel_detector\dataset_yolo
if not exist panel_detector\dataset_reading_order mkdir panel_detector\dataset_reading_order
if not exist readernet\dataset mkdir readernet\dataset
if not exist readernet\dataset\train\images mkdir readernet\dataset\train\images
if not exist readernet\dataset\val\images mkdir readernet\dataset\val\images

docker run --gpus all --shm-size=4g --env-file .env -v "%cd%:/app" readernet-poneglyph-train

if %ERRORLEVEL% NEQ 0 (
    pause
    exit /b %ERRORLEVEL%
)
pause
