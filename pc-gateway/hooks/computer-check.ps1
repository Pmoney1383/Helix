# Safe default: report monitor metadata only. -Exercise opens a disposable scratch form and tests input + gold borders.
param([switch]$Exercise, [switch]$PreviewOnly, [switch]$ViewerOnly, [string]$PreviewPath = '')
$ErrorActionPreference = 'Stop'
Add-Type -Path @((Join-Path $PSScriptRoot 'computer-helper.cs'), (Join-Path $PSScriptRoot '../test/fixtures/computer-native-check.cs')) -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
if ($PreviewOnly) { [HelixComputer.NativeCheck]::Preview($PreviewPath) }
else { [HelixComputer.NativeCheck]::Run([bool]$Exercise, $PreviewPath, [bool]$ViewerOnly) }
