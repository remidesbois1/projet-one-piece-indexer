@echo off
setlocal

if not exist .env copy ..\..\.env .env >nul
if not exist runs mkdir runs
if not exist dataset mkdir dataset

echo ========================================
echo   YOLO26n Bubble Detector - Pipeline
echo ========================================
echo.

docker run --rm --gpus all --shm-size=2g ^
    --env-file .env ^
    -v "%cd%:/app" ^
    -v "%cd%/runs:/app/runs" ^
    -v "%cd%/dataset:/app/dataset" ^
    bubble-detector-train ^
    %*

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Pipeline failed with exit code %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)

echo.
pause
