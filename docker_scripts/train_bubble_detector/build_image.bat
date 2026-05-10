@echo off
echo ========================================
echo   YOLO26n Bubble Detector - Build
echo ========================================
echo.
docker build -t bubble-detector-train .
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo Build successful!
pause
