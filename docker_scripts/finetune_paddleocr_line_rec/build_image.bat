@echo off
setlocal

pushd "%~dp0"

if "%IMAGE_NAME%"=="" set IMAGE_NAME=paddleocr-line-rec-finetune

echo ============================================
echo   PP-OCRv6 Bubble Line Recognition - Build
echo ============================================
echo.
docker build -t %IMAGE_NAME% .
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed.
    popd
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Build successful: %IMAGE_NAME%
popd
pause
