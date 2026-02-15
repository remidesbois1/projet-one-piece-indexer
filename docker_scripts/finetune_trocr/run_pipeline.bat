@echo off
echo ==========================================================
echo 🚀 Starting Automated Fine-Tuning Pipeline (Docker)
echo ==========================================================
echo.
echo Make sure your .env file is correctly set up with:
echo - SUPABASE_URL
echo - SUPABASE_SERVICE_ROLE_KEY
echo - HF_TOKEN
echo.

docker run --gpus all --env-file .env trocr-auto-pipeline

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
