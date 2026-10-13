# Installs and starts the Helix gateway Windows service.
#   powershell -ExecutionPolicy Bypass -File service\install.ps1
# Re-launches itself elevated (UAC prompt), downloads WinSW if it is missing (checksum-verified),
# writes helix-gateway.xml from the template, then WinSW asks for the Windows account
# (use .\<your user>) and password. The password goes to WinSW/Windows only.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

# WinSW v2.12.0 x64, the official release: https://github.com/winsw/winsw/releases/tag/v2.12.0
$WinSWUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
$WinSWSha256 = "05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

try {
    Set-Location $PSScriptRoot
    $gateway = Split-Path $PSScriptRoot -Parent
    foreach ($f in @("..\dist\src\index.js", "..\.env")) {
        if (-not (Test-Path (Join-Path $PSScriptRoot $f))) { throw "missing $f (run 'npm run build' in $gateway, and copy .env.example to .env)" }
    }
    New-Item -ItemType Directory -Force (Join-Path $gateway "data\logs") | Out-Null

    $exe = Join-Path $PSScriptRoot "helix-gateway.exe"
    if (-not (Test-Path $exe)) {
        Write-Host "Downloading WinSW v2.12.0..."
        $tmp = "$exe.download"
        Invoke-WebRequest $WinSWUrl -OutFile $tmp -UseBasicParsing
        $hash = (Get-FileHash $tmp -Algorithm SHA256).Hash
        if ($hash -ne $WinSWSha256) { Remove-Item $tmp; throw "WinSW checksum mismatch ($hash); not installing" }
        Move-Item $tmp $exe
    }

    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "node was not found on PATH (install Node.js 24)" }
    $xml = (Get-Content (Join-Path $PSScriptRoot "helix-gateway.xml.template") -Raw).Replace("{{NODE}}", $node).Replace("{{GATEWAY}}", $gateway)
    Set-Content (Join-Path $PSScriptRoot "helix-gateway.xml") $xml -Encoding UTF8
    Write-Host "Wrote helix-gateway.xml (node: $node, gateway: $gateway)"

    # Grant "Log on as a service" to the current user. WinSW's own prompt doesn't reliably do this,
    # and Windows Home has no secpol.msc. Uses secedit to edit the local user-rights assignment.
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $sid = ([Security.Principal.NTAccount]$user).Translate([Security.Principal.SecurityIdentifier]).Value
    $cfg = Join-Path $env:TEMP "helix-rights.inf"
    $db = Join-Path $env:TEMP "helix-rights.sdb"
    secedit /export /cfg $cfg /areas USER_RIGHTS | Out-Null
    $lines = [System.Collections.Generic.List[string]](Get-Content $cfg)
    $mine = { param($tok) $tok -eq "*$sid" -or $tok -ieq $user.Split('\')[-1] -or $tok -ieq $user }
    $svcIdx = $lines.FindIndex({ param($l) $l -match '^SeServiceLogonRight\s*=' })
    if ($svcIdx -ge 0) {
        $tokens = ($lines[$svcIdx] -split '=', 2)[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        if (-not ($tokens | Where-Object { & $mine $_ })) { $lines[$svcIdx] = "SeServiceLogonRight = " + (($tokens + "*$sid") -join ',') }
    } else {
        $hdr = $lines.FindIndex({ param($l) $l -match '^\[Privilege Rights\]' })
        $lines.Insert($hdr + 1, "SeServiceLogonRight = *$sid")
    }
    $denyIdx = $lines.FindIndex({ param($l) $l -match '^SeDenyServiceLogonRight\s*=' })
    if ($denyIdx -ge 0) {
        $tokens = ($lines[$denyIdx] -split '=', 2)[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        $kept = $tokens | Where-Object { -not (& $mine $_) }
        if (@($kept).Count -ne @($tokens).Count) {
            Write-Host "Removing $user from 'Deny log on as a service'."
            $lines[$denyIdx] = "SeDenyServiceLogonRight = " + ($kept -join ',')
        }
    }
    Set-Content $cfg $lines -Encoding Unicode
    secedit /configure /db $db /cfg $cfg /areas USER_RIGHTS | Out-Null
    Remove-Item $cfg, $db -ErrorAction SilentlyContinue
    Write-Host "Granted 'Log on as a service' to $user"

    $existing = & .\helix-gateway.exe status
    if ($existing -notmatch "NonExistent") {
        Write-Host "Service already installed ($existing); reinstalling."
        & .\helix-gateway.exe stop 2>$null
        & .\helix-gateway.exe uninstall
    }

    Write-Host "`nEnter the Windows account the service should run as (e.g. .\$($user.Split('\')[-1])) and its password."
    & .\helix-gateway.exe install /p
    if ($LASTEXITCODE -ne 0) { throw "install failed" }
    & .\helix-gateway.exe start
    Write-Host "`nStatus: $(& .\helix-gateway.exe status)"
    Show-HelixHealth (Get-HelixPort $gateway)
}
catch {
    Write-Host "`nERROR: $_" -ForegroundColor Red
}
Read-Host "`nPress Enter to close"
