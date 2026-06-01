@echo off
setlocal

if "%IMAGE_NAME%"=="" set IMAGE_NAME=surya-bubble-ocr-finetune
if "%TAG%"=="" set TAG=latest
set ENV_FILE=../../.env
if exist ".env" set ENV_FILE=.env

echo ==========================================================
echo Running Surya bubble OCR pipeline in Docker
echo ==========================================================
echo.
echo Requires ..\..\.env or a local .env with Supabase credentials.
echo.

docker run --gpus all --ipc=host --shm-size 32g --env-file %ENV_FILE% ^
    -v "%cd%\surya_bubble_dataset:/workspace/surya_bubble_dataset" ^
    -v "%cd%\outputs_surya_bubble_ocr:/workspace/outputs_surya_bubble_ocr" ^
    -v "%USERPROFILE%\.cache\huggingface:/root/.cache/huggingface" ^
    %IMAGE_NAME%:%TAG%

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Pipeline failed or was interrupted.
    exit /b %ERRORLEVEL%
)

echo.
echo Pipeline complete.
echo.
