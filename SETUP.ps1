# Esecuzione (prima volta):  Set-ExecutionPolicy -Scope Process Bypass; .\SETUP.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
 Write-Error "Installa Git for Windows e riprova."
}

if (-not (Test-Path .venv)) {
  py -3 -m venv .venv
}
& .\.venv\Scripts\pip.exe install -r requirements.txt

$scene = "vendor\mujoco_menagerie\unitree_g1\scene.xml"
if (-not (Test-Path $scene)) {
  git clone --depth 1 --filter=blob:none --sparse `
    https://github.com/google-deepmind/mujoco_menagerie.git vendor/mujoco_menagerie
  Push-Location vendor/mujoco_menagerie
  git sparse-checkout set unitree_g1
  Pop-Location
}

Write-Host ""
Write-Host "Setup OK. Avvio tutto (consigliato):" -ForegroundColor Green
Write-Host "  .\START.ps1" -ForegroundColor Cyan
Write-Host "Oppure: .\.venv\Scripts\python.exe server.py" -ForegroundColor DarkGray
