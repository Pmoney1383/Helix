// Bridge to the user's real desktop. The gateway runs as a Windows service in session 0, which has no desktop: an app it
// launches appears nowhere, and it cannot see or close the windows you are looking at. So desktop actions run in the
// interactive session instead, through a one-shot scheduled task that runs as the same user ("only when logged on").
// The action itself is hooks/desktop-runner.ps1; this file only hands it a job file and waits for the answer.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./pc-tools.js";

export type DesktopJob =
  | { op: "computer_start"; bootstrap: string }
  | { op: "open"; appId: string }
  | { op: "windows" }
  | { op: "close"; hwnds: number[] }
  /** Write lines to a Claude session's inbox pipe from inside the user's session (session 0 cannot see those pipes). */
  | { op: "peer"; pipe: string; lines: string[] };

export interface DesktopWindow {
  hwnd: number;
  id: number;
  title: string;
  processName: string;
}

export interface DesktopResult {
  ok: boolean;
  error?: string;
  session?: number;
  windows?: DesktopWindow[];
}

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("cannot locate the pc-gateway package root");
}

let sessionId: Promise<number> | undefined;
/** Windows session this process runs in: 0 means a service with no desktop. Cached. */
export function currentSession(): Promise<number> {
  sessionId ??= run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "[System.Diagnostics.Process]::GetCurrentProcess().SessionId"], { timeoutMs: 15_000 })
    .then((r) => Number(r.stdout.trim()) || 0);
  return sessionId;
}

/** True when actions must hop into the interactive session: we are a service (session 0), or HELIX_DESKTOP_BRIDGE=task forces it for testing. */
const useBridge = async (): Promise<boolean> => process.env.HELIX_DESKTOP_BRIDGE === "task" || (await currentSession()) === 0;

const q = (s: string) => s.replace(/'/g, "''");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function desktop(job: DesktopJob, opts: { dataDir?: string; timeoutMs?: number } = {}): Promise<DesktopResult> {
  const dir = path.join(opts.dataDir ?? path.join(os.tmpdir(), "helix"), "desktop");
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const jobFile = path.join(dir, `${id}.json`);
  const resultFile = `${jobFile}.result`;
  const script = path.join(packageRoot(), "hooks", "desktop-runner.ps1");
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const taskName = `HelixDesktop-${id.slice(0, 8)}`;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  try {
    if (!(await useBridge())) {
      // Developing or testing from a normal terminal: we already are on the desktop.
      await run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Job", jobFile], { timeoutMs });
    } else {
      // headless conhost: no console window flashes on the desktop.
      const arg = `--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}" -Job "${jobFile}"`;
      const ps = [
        `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '${q(arg)}'`,
        `$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive`,
        `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Principal $p -Force | Out-Null`,
        `Start-ScheduledTask -TaskName '${taskName}'`,
      ].join("; ");
      const started = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 20_000 });
      if (started.code !== 0) return { ok: false, error: `could not start the desktop helper: ${started.stderr.trim().slice(0, 300) || "unknown error"}` };
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(resultFile)) {
        try { return JSON.parse(fs.readFileSync(resultFile, "utf8").replace(/^﻿/, "")) as DesktopResult; } catch { /* still being written */ }
      }
      await sleep(150);
    }
    return { ok: false, error: "the desktop helper did not answer (is the user logged in to Windows?)" };
  } finally {
    for (const f of [jobFile, resultFile, `${resultFile}.tmp`]) fs.rmSync(f, { force: true });
    if (await useBridge()) {
      void run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`], { timeoutMs: 15_000 });
    }
  }
}
