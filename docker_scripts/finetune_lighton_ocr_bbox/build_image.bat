@echo off
chcp 65001 >nul
docker build -f "%~dp0Dockerfile" -t lighton-ocr-bbox-finetune "%~dp0.."
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
echo Image lighton-ocr-bbox-finetune construite.
