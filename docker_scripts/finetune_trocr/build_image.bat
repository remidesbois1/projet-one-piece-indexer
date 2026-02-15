@echo off
echo ==========================================================
echo 🛠️  Building Docker Image (trocr-auto-pipeline)...
echo ==========================================================
echo.

docker build -t trocr-auto-pipeline .

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Build failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ✅ Build successful! Image 'trocr-auto-pipeline' is ready.
echo.
pause
