# Runs ONE desktop action inside the user's interactive Windows session and writes the answer next to the job file.
# The Helix gateway is a Windows service (session 0, no desktop), so anything that must appear on, or be read from, the
# real desktop is handed to this script through a one-shot scheduled task (see src/mcp/desktop.ts).
#
#   job file   {"op":"open","appId":"..."} | {"op":"windows"} | {"op":"close","hwnds":[123,456]} | {"op":"peer","pipe":"\\.\pipe\LOCAL\cc-msg-<32 hex>","lines":["<json>"]}
#   result     <job>.result  {"ok":true,...} or {"ok":false,"error":"..."}
param([Parameter(Mandatory = $true)][string]$Job)
$ErrorActionPreference = 'Stop'
$resultPath = "$Job.result"

function Write-Result($obj) {
  $tmp = "$resultPath.tmp"
  $obj | ConvertTo-Json -Compress -Depth 6 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $resultPath -Force
}

try {
  $j = Get-Content -Raw -LiteralPath $Job | ConvertFrom-Json
  $session = (Get-Process -Id $PID).SessionId

  Add-Type -TypeDefinition @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class HxWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  public static List<string> List() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      int n = GetWindowTextLength(h); if (n == 0) return true;
      var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      r.Add(h.ToInt64() + "|" + pid + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@

  switch ($j.op) {
    'computer_start' {
      $helper = Join-Path $PSScriptRoot 'computer-helper.ps1'
      $boot = [IO.Path]::GetFullPath([string]$j.bootstrap)
      if (-not (Test-Path -LiteralPath $boot -PathType Leaf)) { throw 'missing computer bootstrap' }
      if ($boot.Contains('"')) { throw 'invalid bootstrap path' }
      $proc = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $helper + '"'), '-Bootstrap', ('"' + $boot + '"'))
      Write-Result @{ ok = $true; session = $session; helperPid = $proc.Id }
    }
    'open' {
      # The id must be one Windows itself lists for this user; nothing else is ever launched.
      $known = Get-StartApps | Where-Object { $_.AppID -eq $j.appId }
      if (-not $known) { throw "not a Start menu app" }
      Start-Process -FilePath 'explorer.exe' -ArgumentList ("shell:AppsFolder\" + $j.appId)
      Write-Result @{ ok = $true; session = $session }
    }
    'windows' {
      $wins = @([HxWin]::List() | ForEach-Object {
        $p = $_ -split '\|', 3
        $proc = Get-Process -Id ([int]$p[1]) -ErrorAction SilentlyContinue
        if ($proc) { @{ hwnd = [int64]$p[0]; id = [int]$p[1]; title = $p[2]; processName = $proc.ProcessName } }
      })
      Write-Result @{ ok = $true; session = $session; windows = $wins }
    }
    'close' {
      # WM_CLOSE = clicking the X: the app may still ask about unsaved work. Never a forced kill.
      foreach ($h in @($j.hwnds)) { [void][HxWin]::PostMessage([IntPtr][int64]$h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
      Write-Result @{ ok = $true; session = $session }
    }
    'peer' {
      # Drop JSON lines into a Claude Code session's inbox pipe. Only a pipe named like one of its inboxes is ever opened.
      if ($j.pipe -notmatch '^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$') { throw "not a Claude session inbox" }
      $name = $j.pipe.Substring('\\.\pipe\'.Length)
      $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::Out)
      try {
        $c.Connect(3000)
        $w = New-Object System.IO.StreamWriter($c, (New-Object System.Text.UTF8Encoding($false)))
        foreach ($l in @($j.lines)) { $w.Write($l + "`n") }
        $w.Flush()
      } finally { $c.Dispose() }
      Write-Result @{ ok = $true; session = $session }
    }
    default { throw "unknown op" }
  }
}
catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
}
