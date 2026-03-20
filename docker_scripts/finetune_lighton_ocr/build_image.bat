@echo off
echo ==========================================================
echo 🛠️  Building Docker Image (lighton-ocr-finetune)...
echo ==========================================================
echo.

docker build -t lighton-ocr-finetune .

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Build failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ✅ Build successful! Image 'lighton-ocr-finetune' is ready.
echo.
pause
