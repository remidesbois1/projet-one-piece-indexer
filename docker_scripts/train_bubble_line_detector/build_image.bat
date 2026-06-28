@echo off
setlocal

pushd "%~dp0"

echo ============================================
echo   YOLO26n Bubble Line Detector - Build
echo ============================================
echo.
docker build -t bubble-line-detector-train .
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed.
    pause
    popd
    exit /b %ERRORLEVEL%
)
echo.
echo Build successful!
popd
pause
