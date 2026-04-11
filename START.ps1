# Avvio unico stack G1: HTTPS 8443 + MuJoCo + WebSocket + pagina WebXR (stesso processo).
# Prima volta: .\SETUP.ps1
# Uso: Set-ExecutionPolicy -Scope Process Bypass; .\START.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path .\.venv\Scripts\python.exe)) {
    Write-Error "Manca .venv. Esegui prima: .\SETUP.ps1"
}

Remove-Item Env:HTTP_ONLY -ErrorAction SilentlyContinue

$conns = Get-NetTCPConnection -LocalPort 8443, 8000 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $conns | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "G1-local (tutto in uno: sim + sito + wss)" -ForegroundColor Green
Write-Host "  PC:    https://127.0.0.1:8443/" -ForegroundColor Cyan
Write-Host "  Quest: https://<IP-PC>:8443/  (stessa Wi-Fi, firewall TCP 8443)" -ForegroundColor Cyan
Write-Host ""

& .\.venv\Scripts\python.exe server.py
