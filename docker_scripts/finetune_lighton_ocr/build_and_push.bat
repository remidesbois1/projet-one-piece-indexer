@echo off
set DOCKER_USER=remidesbois
set IMAGE_NAME=lighton-ocr-finetune
set TAG=latest

echo ==========================================================
echo 🛠️  Building and Pushing %DOCKER_USER%/%IMAGE_NAME%:%TAG%
echo ==========================================================
echo.

docker build -t %DOCKER_USER%/%IMAGE_NAME%:%TAG% .

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Build failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo 🚀 Pushing to Docker Hub...
docker push %DOCKER_USER%/%IMAGE_NAME%:%TAG%

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Push failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ✅ Image pushed successfully!
echo.
pause
