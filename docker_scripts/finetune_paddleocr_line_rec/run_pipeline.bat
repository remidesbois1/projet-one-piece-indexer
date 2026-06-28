@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%..\.."
set "SOURCE_DIR=%REPO_ROOT%\scripts\bubble_line_dataset"
set "DETECTOR_DIR=%REPO_ROOT%\docker_scripts\train_bubble_line_detector\runs\yolo26n_bubble_line\weights"
set "ENV_FILE=%REPO_ROOT%\.env"
if "%IMAGE_NAME%"=="" set IMAGE_NAME=paddleocr-line-rec-finetune

pushd "%SCRIPT_DIR%"
if not exist outputs mkdir outputs

if not exist "%SOURCE_DIR%\manifest.json" (
    echo [ERROR] Missing bubble source manifest:
    echo         %SOURCE_DIR%\manifest.json
    popd
    pause
    exit /b 1
)

if not exist "%DETECTOR_DIR%\best.pt" (
    echo [ERROR] Missing trained YOLO line detector:
    echo         %DETECTOR_DIR%\best.pt
    popd
    pause
    exit /b 1
)

echo ============================================
echo   PP-OCRv6 Bubble Line Recognition Pipeline
echo ============================================
echo Source:   Supabase via %ENV_FILE%
echo Debug source_dir mount: %SOURCE_DIR%
echo Detector: %DETECTOR_DIR%\best.pt
echo.

docker run --rm --gpus all --shm-size=8g ^
    --env-file "%ENV_FILE%" ^
    -v "%SOURCE_DIR%:/workspace/bubble_line_dataset:ro" ^
    -v "%DETECTOR_DIR%:/workspace/line_detector:ro" ^
    -v "%cd%\outputs:/workspace/outputs_paddleocr_line_rec" ^
    -v "%USERPROFILE%\.cache\huggingface:/workspace/hf-cache" ^
    %IMAGE_NAME% ^
    %*

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Pipeline failed with exit code %ERRORLEVEL%
    popd
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Pipeline complete.
popd
pause
