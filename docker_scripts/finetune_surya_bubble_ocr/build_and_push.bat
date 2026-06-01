@echo off
setlocal

if "%DOCKER_USER%"=="" set DOCKER_USER=remidesbois
if "%IMAGE_NAME%"=="" set IMAGE_NAME=surya-bubble-ocr-finetune
if "%TAG%"=="" set TAG=latest

set FULL_IMAGE=%DOCKER_USER%/%IMAGE_NAME%:%TAG%

echo ==========================================================
echo Building and pushing %FULL_IMAGE%
echo ==========================================================
echo.

docker build --pull -t %FULL_IMAGE% .

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Build failed.
    exit /b %ERRORLEVEL%
)

echo.
echo Pushing %FULL_IMAGE%
docker push %FULL_IMAGE%

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Push failed.
    exit /b %ERRORLEVEL%
)

echo.
echo Image pushed: %FULL_IMAGE%
echo.
