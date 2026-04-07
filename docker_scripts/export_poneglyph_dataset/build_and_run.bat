@echo off
set IMAGE_NAME=poneglyph-dataset-exporter

echo Building Docker Image...
docker build -t %IMAGE_NAME% .

echo Starting Export and Upload to Hugging Face...
docker run --rm --env-file "../../.env" -v "%cd%\poneglyph_dataset:/app/poneglyph_dataset" %IMAGE_NAME%

echo Done!
pause
