@echo off
echo ==========================================================
echo 🛠️  Building Docker Image (trocr-large-pipeline)...
echo ==========================================================
echo.

docker build -t trocr-large-pipeline .

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Build failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ✅ Build successful! Image 'trocr-large-pipeline' is ready.
echo.
pause
