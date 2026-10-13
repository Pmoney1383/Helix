# Makes the launcher icons from the iPhone's app icon (ios/Helix/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png).
#   powershell -ExecutionPolicy Bypass -File android\scripts\make-icons.ps1
# Writes mipmap-*/ic_launcher_art.png (the full-bleed layer of the adaptive icon, 108 dp) and mipmap-*/ic_launcher.png
# (the legacy square icon, 48 dp) for each density.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$source = [System.Drawing.Image]::FromFile((Join-Path $root "ios\Helix\Resources\Assets.xcassets\AppIcon.appiconset\AppIcon.png"))
$res = Join-Path $root "android\app\src\main\res"
$densities = @{ "mdpi" = 1.0; "hdpi" = 1.5; "xhdpi" = 2.0; "xxhdpi" = 3.0; "xxxhdpi" = 4.0 }

function Save-Scaled([int]$size, [string]$path) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($source, 0, 0, $size, $size)
    $g.Dispose()
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

foreach ($d in $densities.GetEnumerator()) {
    $dir = Join-Path $res "mipmap-$($d.Key)"
    New-Item -ItemType Directory -Force $dir | Out-Null
    Save-Scaled ([int](108 * $d.Value)) (Join-Path $dir "ic_launcher_art.png")
    Save-Scaled ([int](48 * $d.Value)) (Join-Path $dir "ic_launcher.png")
}
$source.Dispose()
Write-Host "Wrote launcher icons to $res"
