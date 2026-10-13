# Rebuilds the gateway and restarts the Windows service so it runs the latest code.
# Run it from a normal PowerShell; it asks for admin (UAC) because restarting a service needs it.
#   powershell -ExecutionPolicy Bypass -File service\update.ps1
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

try {
    $gateway = Split-Path $PSScriptRoot -Parent
    Set-Location $gateway
    Write-Host "Building..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }

    Write-Host "Restarting the service..."
    & "$PSScriptRoot\helix-gateway.exe" restart
    Write-Host "`nStatus: $(& "$PSScriptRoot\helix-gateway.exe" status)"
    Show-HelixHealth (Get-HelixPort $gateway)
}
catch {
    Write-Host "`nERROR: $_" -ForegroundColor Red
}
Read-Host "`nPress Enter to close"
