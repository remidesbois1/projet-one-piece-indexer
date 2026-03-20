@echo off
echo ==========================================================
echo 🚀 Starting LightOnOCR-2-1B Fine-Tuning Pipeline
echo ==========================================================
echo.
echo Requis : .env avec SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HF_TOKEN
echo.

docker run --gpus all --env-file ../../.env -v "%cd%\lighton_dataset:/app/lighton_dataset" lighton-ocr-finetune

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
