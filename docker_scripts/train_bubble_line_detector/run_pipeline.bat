@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%..\.."
set "DATASET_DIR=%REPO_ROOT%\scripts\bubble_line_dataset\dataset"

pushd "%SCRIPT_DIR%"

if not exist runs mkdir runs

if not exist "%DATASET_DIR%\data.yaml" (
    echo [ERROR] Dataset not found:
    echo         %DATASET_DIR%
    pause
    popd
    exit /b 1
)

echo ============================================
echo   YOLO26n Bubble Line Detector - Pipeline
echo ============================================
echo Dataset: %DATASET_DIR%
echo.

docker run --rm --gpus all --shm-size=2g ^
    -v "%cd%:/app" ^
    -v "%cd%/runs:/app/runs" ^
    -v "%DATASET_DIR%:/app/dataset:ro" ^
    bubble-line-detector-train ^
    %*

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Pipeline failed with exit code %ERRORLEVEL%
    pause
    popd
    exit /b %ERRORLEVEL%
)

echo.
popd
pause
