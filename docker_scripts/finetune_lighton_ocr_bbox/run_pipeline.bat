@echo off
chcp 65001 >nul
echo ==========================================================
echo Starting LightOnOCR-2-1B BBox pipeline - RTX 5090
echo ==========================================================
echo.
echo Resolution fixe : 1500 px cote long
echo Requis : ../../.env avec SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY
echo.

docker run --gpus all --ipc=host --shm-size 16g --env-file ../../.env ^
    -v "%cd%\lighton_bbox_dataset:/app/lighton_bbox_dataset" ^
    -v "%cd%\outputs_lighton_bbox:/app/outputs_lighton_bbox" ^
    -v "%cd%\logs:/app/logs" ^
    lighton-ocr-bbox-finetune

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Pipeline execution failed or was interrupted!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Pipeline termine. Le modele n'est publie que si le quality gate passe.
echo.
pause
