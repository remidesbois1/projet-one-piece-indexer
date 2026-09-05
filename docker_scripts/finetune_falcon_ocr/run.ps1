[CmdletBinding()]
param(
    [ValidateSet('train', 'smoke', 'export', 'publish', 'check', 'dashboard')]
    [string]$Action = 'train',
    [string]$EnvFile,
    [string]$Image = 'poneglyph/falcon-ocr:5090',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 does not populate PSScriptRoot in parameter defaults.
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $PSScriptRoot '../../.env'
}
& docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop ne démarre pas. Corrigez son moteur WSL2 puis relancez la même commande.'
}
if (-not $SkipBuild) {
    # Keep a named reference to the large base image so BuildKit garbage
    # collection cannot evict it between dependency/build retries.
    $baseImage = 'pytorch/pytorch:2.11.0-cuda13.0-cudnn9-devel'
    $baseImageId = & docker images --quiet $baseImage
    if (-not $baseImageId) {
        & docker pull $baseImage
        if ($LASTEXITCODE -ne 0) { throw 'Échec du téléchargement de la base CUDA.' }
    }
    & docker build --tag $Image $PSScriptRoot
    if ($LASTEXITCODE -ne 0) { throw 'Échec de construction Docker.' }
}
$datasetPath = Join-Path $PSScriptRoot 'dataset'
$outputPath = Join-Path $PSScriptRoot 'outputs'
New-Item -ItemType Directory -Force -Path $datasetPath, $outputPath | Out-Null
$dockerArgs = @('run', '--rm', '--init', '--shm-size', '16g',
    '--mount', "type=bind,source=$outputPath,target=/workspace/outputs_falcon_ocr",
    '--mount', "type=bind,source=$datasetPath,target=/workspace/falcon_dataset",
    '--mount', 'type=volume,source=poneglyph-falcon-cache,target=/cache')
# Rich needs a terminal to refresh progress before an epoch has finished.
if (-not [Console]::IsOutputRedirected) { $dockerArgs += '--tty' }
if ($Action -eq 'dashboard') {
    $dockerArgs += @('-p', '127.0.0.1:6006:6006', '--entrypoint', 'tensorboard', $Image,
        '--logdir', '/workspace/outputs_falcon_ocr/tensorboard', '--host', '0.0.0.0')
} else {
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw "Fichier .env absent : $EnvFile" }
    $backendEnvFile = Join-Path $PSScriptRoot '../../backend/.env'
    if (Test-Path -LiteralPath $backendEnvFile) {
        $dockerArgs += @('--env-file', (Resolve-Path -LiteralPath $backendEnvFile).Path)
    }
    $dockerArgs += @('--env-file', (Resolve-Path -LiteralPath $EnvFile).Path)
    if ($Action -in @('train', 'smoke')) { $dockerArgs += @('--gpus', 'device=0') }
    # Explicit Falcon overrides from this PowerShell session win over .env.
    Get-ChildItem Env:FALCON_* | ForEach-Object { $dockerArgs += @('-e', $_.Name) }
    $dockerArgs += $Image
    switch ($Action) {
        'smoke' { $dockerArgs += '--smoke' }
        'export' { $dockerArgs += '--export-only' }
        'publish' { $dockerArgs += '--publish-only' }
        'check' { $dockerArgs += '--dry-run' }
    }
}
& docker @dockerArgs
if ($LASTEXITCODE -ne 0) { throw "Pipeline interrompu (code $LASTEXITCODE). Les données et checkpoints sont conservés." }
