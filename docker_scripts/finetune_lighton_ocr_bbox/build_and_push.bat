@echo off
chcp 65001 >nul
set DOCKER_USER=remidesbois
set IMAGE_NAME=lighton-ocr-bbox-finetune
set TAG=latest

docker build -f "%~dp0Dockerfile" -t %DOCKER_USER%/%IMAGE_NAME%:%TAG% "%~dp0.."
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

docker push %DOCKER_USER%/%IMAGE_NAME%:%TAG%
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

echo Image pushed successfully.
pause
