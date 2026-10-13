# Reports how long the keyboard and mouse have been idle to the Helix gateway, every 15 seconds.
#
# It has to run in YOUR desktop session: the gateway is a Windows service, and a service cannot see
# your input. `helix connect` installs this to start at logon (Startup folder, no admin needed);
# `helix disconnect` removes it. It reads the gateway URL and token from ~/.helix/local.json and does
# nothing visible. If the gateway is down it just keeps trying.
param([int]$IntervalSec = 15)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HelixIdle {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    public static uint IdleSeconds() {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info)) return 0;
        // Tick counts wrap every ~49 days; unsigned subtraction handles that correctly.
        return ((uint)Environment.TickCount - info.dwTime) / 1000;
    }
}
"@

$home_ = if ($env:HELIX_HOME) { $env:HELIX_HOME } else { Join-Path $env:USERPROFILE ".helix" }
$cfgPath = Join-Path $home_ "local.json"

while ($true) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $body = @{ idleSec = [int][HelixIdle]::IdleSeconds() } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post -Uri "$($cfg.url)/v1/presence/idle" -Headers @{ Authorization = "Bearer $($cfg.token)" } `
            -ContentType "application/json" -Body $body -TimeoutSec 5 | Out-Null
    } catch { }
    Start-Sleep -Seconds $IntervalSec
}
