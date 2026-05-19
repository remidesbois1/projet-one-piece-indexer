<#
    Poneglyph native Windows vLLM runtime installer.

    This installs the unofficial SystemPanic/vllm-windows CUDA wheel into a
    stable per-user runtime folder that the Tauri app auto-detects before the
    global Python on PATH.
#>

param(
    [string]$PythonVersion = "3.12",
    [string]$RuntimeDir = "",
    [switch]$SetEnv = $false
)

$ErrorActionPreference = "Stop"

if (($env:OS -ne "Windows_NT") -and (-not $IsWindows)) {
    throw "This setup script is only for native Windows."
}

$WheelUrl = "https://github.com/SystemPanic/vllm-windows/releases/download/v0.21.0/vllm-0.21.0%2Bcu132-cp312-cp312-win_amd64.whl"
$TorchIndexUrl = "https://download.pytorch.org/whl/cu130"

if (-not $RuntimeDir) {
    $baseDir = $env:LOCALAPPDATA
    if (-not $baseDir) {
        $baseDir = $env:APPDATA
    }
    if (-not $baseDir) {
        throw "LOCALAPPDATA/APPDATA is unavailable; pass -RuntimeDir explicitly."
    }
    $RuntimeDir = Join-Path $baseDir "poneglyph\vllm-windows"
}

$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
    throw "uv is required. Install it first from https://docs.astral.sh/uv/ or run this from a shell where uv is on PATH."
}

Write-Host "Installing Python $PythonVersion with uv..." -ForegroundColor Cyan
& $uv.Source python install $PythonVersion
if ($LASTEXITCODE -ne 0) {
    throw "uv python install failed."
}

$pythonExe = Join-Path $RuntimeDir "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
    Write-Host "Creating vLLM runtime: $RuntimeDir" -ForegroundColor Cyan
    & $uv.Source venv $RuntimeDir --python $PythonVersion
    if ($LASTEXITCODE -ne 0) {
        throw "uv venv failed."
    }
}

Write-Host "Installing native Windows vLLM wheel..." -ForegroundColor Cyan
& $uv.Source pip install --python $pythonExe $WheelUrl --extra-index-url $TorchIndexUrl --index-strategy unsafe-best-match
if ($LASTEXITCODE -ne 0) {
    throw "vLLM Windows wheel install failed."
}

Write-Host "Installing local OCR backend dependencies..." -ForegroundColor Cyan
$backendDeps = @(
    "fastapi[standard]",
    "uvicorn",
    "accelerate",
    "huggingface_hub",
    "Pillow",
    "pydantic"
)
& $uv.Source pip install --python $pythonExe @backendDeps
if ($LASTEXITCODE -ne 0) {
    throw "Backend dependency install failed."
}

Write-Host "Verifying vLLM, CUDA, Torch, and LightOnOCR imports..." -ForegroundColor Cyan
$verifyCode = @'
import sys
from vllm import LLM, SamplingParams
from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor
import torch

if not torch.cuda.is_available():
    raise SystemExit("CUDA is not available to Torch")

print("python=" + sys.executable)
print("vllm=ok")
print("torch=" + torch.__version__)
print("cuda=" + str(torch.version.cuda))
print("gpu=" + torch.cuda.get_device_name(0))
'@
$verifyScript = New-TemporaryFile
try {
    Set-Content -LiteralPath $verifyScript -Value $verifyCode -Encoding UTF8
    & $pythonExe $verifyScript
} finally {
    Remove-Item -LiteralPath $verifyScript -Force -ErrorAction SilentlyContinue
}
if ($LASTEXITCODE -ne 0) {
    throw "vLLM runtime verification failed."
}

if ($SetEnv) {
    Write-Host "Persisting PONEGLYPH_PYTHON for older desktop builds..." -ForegroundColor Cyan
    & setx PONEGLYPH_PYTHON $pythonExe
    if ($LASTEXITCODE -ne 0) {
        throw "setx PONEGLYPH_PYTHON failed."
    }
}

Write-Host ""
Write-Host "Native Windows vLLM runtime is ready." -ForegroundColor Green
Write-Host "Runtime: $RuntimeDir"
Write-Host "Python:  $pythonExe"
Write-Host "The current desktop app auto-detects this runtime before global Python."
