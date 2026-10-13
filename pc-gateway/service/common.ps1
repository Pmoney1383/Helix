# Shared helpers for install.ps1 and update.ps1 (dot-sourced).

# The gateway's port from ..\.env (HELIX_PORT), or the default.
function Get-HelixPort([string]$gateway) {
    $envFile = Join-Path $gateway ".env"
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match '^\s*HELIX_PORT\s*=\s*(\d+)' } | Select-Object -First 1
        if ($line -and $line -match '=\s*(\d+)') { return [int]$Matches[1] }
    }
    return 7777
}

# Waits up to $seconds for /health to answer and prints it.
function Show-HelixHealth([int]$port, [int]$seconds = 20) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try { Write-Host (Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 3 | ConvertTo-Json -Compress); return } catch { Start-Sleep 1 }
    }
    Write-Host "The gateway did not answer on http://127.0.0.1:$port/health within $seconds s. Check data\logs." -ForegroundColor Yellow
}
