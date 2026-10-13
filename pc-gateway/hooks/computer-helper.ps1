# Persistent desktop worker. Started on demand through desktop-runner.ps1 in the interactive session.
param([Parameter(Mandatory=$true)][string]$Bootstrap, [switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'computer-helper.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
    if ($CompileOnly) { Write-Output 'Desktop helper compiled.'; exit 0 }
    $config = Get-Content -LiteralPath $Bootstrap -Raw | ConvertFrom-Json
    [HelixComputer.Worker]::Run([string]$config.pipe, [string]$config.secret)
} catch {
    # No commands or screenshots in logs. Bootstrap errors are returned to the gateway via its startup timeout.
    Write-Error $_
    exit 1
}
