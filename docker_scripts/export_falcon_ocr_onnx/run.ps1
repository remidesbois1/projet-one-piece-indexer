[CmdletBinding()]
param([string]$Python = 'python', [string]$Source, [string]$Output)
$ErrorActionPreference = 'Stop'
if (-not $Source) { $Source = Join-Path $PSScriptRoot '../finetune_falcon_ocr/outputs/release' }
if (-not $Output) { $Output = Join-Path $PSScriptRoot '../../frontend/public/models/falcon-ocr' }
& $Python -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Installation des dépendances ONNX impossible.' }
& $Python (Join-Path $PSScriptRoot 'export_onnx.py') --source $Source --output $Output
if ($LASTEXITCODE -ne 0) { throw 'Export ONNX interrompu.' }
