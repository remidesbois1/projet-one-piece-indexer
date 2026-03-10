@echo off
echo ==========================================================
echo 🛠️  Building Docker Image (firered-auto-pipeline)...
echo ==========================================================
echo.

docker build -t firered-auto-pipeline .

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Build failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ✅ Build successful! Image 'firered-auto-pipeline' is ready.
echo.
pause
