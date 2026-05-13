<#
    Poneglyph Desktop - Build Script
    ================================
    Builds a production Tauri desktop app (.exe installer).
    The app loads https://poneglyph.fr with local OCR support.

    Prerequisites:
    - Rust toolchain (https://rustup.rs)
    - Node.js 22+
    - Python 3.10+ with PyTorch (for local OCR backend)
    - pypyinstaller (optional, for standalone backend exe)

    Usage:
      .\build_desktop.ps1               # Full build
      .\build_desktop.ps1 -SkipFrontend # Skip npm install
      .\build_desktop.ps1 -PyInstaller  # Also build PyInstaller backend
#>

param(
    [switch]$SkipFrontend = $false,
    [switch]$PyInstaller = $false
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Poneglyph Desktop - Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# --- Check prerequisites ---
Write-Host "[1/5] Checking prerequisites..." -ForegroundColor Yellow

$cargoPath = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoPath) {
    $cargoPath = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (Test-Path $cargoPath) {
        $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
        Write-Host "  Rust found at $cargoPath" -ForegroundColor Green
    } else {
        Write-Host "  ERROR: Rust not found. Install from https://rustup.rs" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  Rust: $($cargoPath.Source)" -ForegroundColor Green
}

$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) {
    Write-Host "  ERROR: Node.js not found." -ForegroundColor Red
    exit 1
}
Write-Host "  Node: $($nodePath.Source)" -ForegroundColor Green

# --- Frontend dependencies ---
if (-not $SkipFrontend) {
    Write-Host ""
    Write-Host "[2/5] Installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location (Join-Path $RepoRoot "frontend")
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: npm install failed." -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
    Write-Host "  Done." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[2/5] Skipping frontend dependencies." -ForegroundColor Gray
}

# --- PyInstaller backend (optional) ---
if ($PyInstaller) {
    Write-Host ""
    Write-Host "[3/5] Building PyInstaller backend..." -ForegroundColor Yellow

    $backendDir = Join-Path $RepoRoot "desktop_backend"
    Push-Location $backendDir

    $pythonCmd = $env:PONEGLYPH_PYTHON
    if (-not $pythonCmd) {
        $pythonCmd = "python"
    }

    $pyinstallerCheck = & $pythonCmd -m PyInstaller --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Installing PyInstaller..." -ForegroundColor Gray
        & $pythonCmd -m pip install pyinstaller
    }

    Write-Host "  Building local_ocr_server.exe..." -ForegroundColor Gray
    & $pythonCmd -m PyInstaller `
        --onefile `
        --name local_ocr_server `
        --hidden-import uvicorn.logging `
        --hidden-import uvicorn.loops `
        --hidden-import uvicorn.loops.auto `
        --hidden-import uvicorn.protocols `
        --hidden-import uvicorn.protocols.http `
        --hidden-import uvicorn.protocols.http.auto `
        --hidden-import uvicorn.protocols.websockets `
        --hidden-import uvicorn.protocols.websockets.auto `
        --hidden-import uvicorn.lifespan `
        --hidden-import uvicorn.lifespan.on `
        --hidden-import transformers `
        --hidden-import huggingface_hub `
        --collect-all transformers `
        local_ocr_server.py

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARNING: PyInstaller build failed. Falling back to Python interpreter." -ForegroundColor Yellow
    } else {
        $exePath = Join-Path $backendDir "dist\local_ocr_server.exe"
        if (Test-Path $exePath) {
            Copy-Item $exePath $backendDir -Force
            Write-Host "  PyInstaller exe built: $backendDir\local_ocr_server.exe" -ForegroundColor Green
        }
    }

    Pop-Location
} else {
    Write-Host ""
    Write-Host "[3/5] Skipping PyInstaller (use -PyInstaller flag to build standalone backend)." -ForegroundColor Gray
}

# --- Tauri build ---
Write-Host ""
Write-Host "[4/5] Building Tauri application..." -ForegroundColor Yellow

Push-Location (Join-Path $RepoRoot "frontend")

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri build -- --bundles nsis

if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Tauri build failed." -ForegroundColor Red
    Pop-Location
    exit 1
}

Pop-Location
Write-Host "  Build succeeded." -ForegroundColor Green

# --- Output ---
Write-Host ""
Write-Host "[5/5] Build output:" -ForegroundColor Yellow

$bundleDir = Join-Path $RepoRoot "frontend\src-tauri\target\release\bundle"
$nsisDir = Join-Path $bundleDir "nsis"

if (Test-Path $nsisDir) {
    $installer = Get-ChildItem $nsisDir -Filter "*.exe" | Select-Object -First 1
    if ($installer) {
        $sizeMB = [math]::Round($installer.Length / 1MB, 1)
        Write-Host ""
        Write-Host "  Installer: $($installer.FullName)" -ForegroundColor Green
        Write-Host "  Size: ${sizeMB} MB" -ForegroundColor Green
        Write-Host ""
        Write-Host "  Double-click the installer to install Poneglyph Desktop." -ForegroundColor Cyan
    }
} else {
    $releaseExe = Join-Path $RepoRoot "frontend\src-tauri\target\release\Poneglyph.exe"
    if (Test-Path $releaseExe) {
        $sizeMB = [math]::Round((Get-Item $releaseExe).Length / 1MB, 1)
        Write-Host "  Portable exe: $releaseExe" -ForegroundColor Green
        Write-Host "  Size: ${sizeMB} MB" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Build complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
