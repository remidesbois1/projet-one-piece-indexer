@echo off
chcp 65001 >nul
echo ==========================================================
echo 🛠️  Building Docker Image (lighton-ocr-finetune)...
echo ==========================================================
echo.

docker build -f "%~dp0Dockerfile" -t lighton-ocr-finetune "%~dp0.."

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
