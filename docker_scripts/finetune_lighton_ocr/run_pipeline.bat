@echo off
chcp 65001 >nul
echo ==========================================================
echo 🚀 Starting LightOnOCR-2-1B Fine-Tuning Pipeline
echo ==========================================================
echo.
echo Requis : .env avec SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HF_TOKEN
echo.

docker run --gpus all --ipc=host --shm-size 16g --env-file ../../.env ^
    -v "%cd%\lighton_dataset:/app/lighton_dataset" ^
    -v "%cd%\outputs_lighton_manga:/app/outputs_lighton_manga" ^
    -v "%cd%\logs:/app/logs" ^
    lighton-ocr-finetune

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Pipeline execution failed or was interrupted!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo 🎉 JOB DONE! Everything should be on Hugging Face.
echo.
pause
