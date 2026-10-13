// Plain functions behind the MCP tools. No MCP or policy knowledge in here, so they stay testable.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

const MAX_OUTPUT = 200_000;

export function run(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file, args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          stdout: clip(stdout),
          stderr: clip(stderr || (e && typeof e.code === "string" ? e.message : "")),
          code: e ? (typeof e.code === "number" ? e.code : null) : 0,
          timedOut: !!e?.killed,
        });
      }
    );
  });
}

const clip = (s: string, max = MAX_OUTPUT): string => (s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s);
const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/* ---------- observe ---------- */

export async function getPcStatus() {
  const sample = () => os.cpus().map((c) => c.times);
  const a = sample();
  await new Promise((r) => setTimeout(r, 300));
  const b = sample();
  let idle = 0, total = 0;
  b.forEach((t, i) => {
    const p = a[i]!;
    const d = (k: keyof typeof t) => t[k] - p[k];
    idle += d("idle");
    total += d("user") + d("nice") + d("sys") + d("idle") + d("irq");
  });
  const disks: { drive: string; totalGB: number; freeGB: number }[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    try {
      const s = fs.statfsSync(`${letter}:\\`);
      disks.push({ drive: `${letter}:`, totalGB: gb(s.blocks * s.bsize), freeGB: gb(s.bavail * s.bsize) });
    } catch { /* drive not present */ }
  }
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
    cpu: { model: os.cpus()[0]?.model.trim(), cores: os.cpus().length, usagePercent: total ? Math.round((1 - idle / total) * 100) : null },
    memory: { totalGB: gb(os.totalmem()), freeGB: gb(os.freemem()) },
    disks,
  };
}

export async function getGpuStatus() {
  const fields = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw";
  const r = await run("nvidia-smi", [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"]);
  if (r.code !== 0 || !r.stdout.trim()) return { available: false, error: r.stderr || "nvidia-smi not available" };
  const gpus = r.stdout.trim().split(/\r?\n/).map((line) => {
    const [index, name, util, memUsed, memTotal, temp, power] = line.split(",").map((x) => x.trim());
    return {
      index: Number(index), name, utilizationPercent: Number(util), memoryUsedMB: Number(memUsed),
      memoryTotalMB: Number(memTotal), temperatureC: Number(temp), powerW: Number(power),
    };
  });
  return { available: true, gpus };
}

export interface ProcInfo { name: string; pid: number; memoryMB: number }

export async function listProcesses(filter?: string, limit = 30): Promise<ProcInfo[]> {
  const r = await run("tasklist", ["/fo", "csv", "/nh"]);
  const procs: ProcInfo[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","(\d+)","[^"]*","\d+","([\d,.\s]+) K"/);
    if (!m) continue;
    procs.push({ name: m[1]!, pid: Number(m[2]), memoryMB: Math.round(Number(m[3]!.replace(/[^\d]/g, "")) / 1024) });
  }
  const f = filter?.toLowerCase();
  return procs
    .filter((p) => !f || p.name.toLowerCase().includes(f))
    .sort((x, y) => y.memoryMB - x.memoryMB)
    .slice(0, limit);
}

/** Every process with its parent and start time (needed to see which ones an agent started). */
export async function processSnapshot(): Promise<{ pid: number; ppid: number; name: string; cmd: string; createdMs: number }[]> {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; " +
    "c = $_.CommandLine; t = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } } } | ConvertTo-Json -Compress";
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 20_000 });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim() || "could not list processes");
  const raw = JSON.parse(r.stdout) as { p: number; pp: number; n: string; c: string | null; t: number }[] | { p: number; pp: number; n: string; c: string | null; t: number };
  return (Array.isArray(raw) ? raw : [raw]).map((x) => ({ pid: x.p, ppid: x.pp, name: x.n ?? "", cmd: (x.c ?? "").slice(0, 400), createdMs: x.t }));
}

export async function getProcessStatus(opts: { pid?: number; name?: string }) {
  const all = await listProcesses(opts.name, 500);
  const matches = opts.pid !== undefined ? all.filter((p) => p.pid === opts.pid) : all;
  return { running: matches.length > 0, processes: matches.slice(0, 20) };
}

export function listDirectory(dir: string, limit = 200) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, limit).map((d) => {
    let size: number | undefined, modified: string | undefined;
    try { const s = fs.statSync(path.join(dir, d.name)); size = d.isFile() ? s.size : undefined; modified = s.mtime.toISOString(); } catch { /* unreadable */ }
    return { name: d.name, type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other", size, modified };
  });
  return { path: path.resolve(dir), count: entries.length, entries };
}

export function readFile(file: string, maxBytes = 100_000) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("not a file");
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { path: path.resolve(file), sizeBytes: stat.size, truncated: stat.size > len, content: buf.toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

export function tailFile(file: string, lines = 50) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("not a file");
  const window = Math.min(stat.size, Math.max(8_192, lines * 400));
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(window);
    fs.readSync(fd, buf, 0, window, stat.size - window);
    const all = buf.toString("utf8").split(/\r?\n/);
    if (stat.size > window) all.shift(); // first line is probably cut
    const tail = all.filter((l, i, a) => !(i === a.length - 1 && l === "")).slice(-lines);
    return {
      path: path.resolve(file), modified: stat.mtime.toISOString(),
      secondsSinceModified: Math.round((Date.now() - stat.mtimeMs) / 1000), lines: tail,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export async function gitStatus(repo: string) {
  const r = await run("git", ["-C", repo, "status", "--porcelain=v1", "-b"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git status failed");
  const [branch, ...changes] = r.stdout.trim().split(/\r?\n/);
  return { branch: branch?.replace(/^## /, ""), changes, clean: changes.filter(Boolean).length === 0 };
}

export async function gitLog(repo: string, count = 10) {
  const r = await run("git", ["-C", repo, "log", `-n${Math.min(Math.max(count, 1), 100)}`, "--pretty=format:%h\t%an\t%ar\t%s"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git log failed");
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const [hash, author, when, subject] = l.split("\t");
    return { hash, author, when, subject };
  });
}

export async function getServiceStatus(name: string) {
  if (!/^[\w .-]{1,80}$/.test(name)) throw new Error("invalid service name");
  const r = await run("sc", ["query", name]);
  const state = r.stdout.match(/STATE\s*:\s*\d+\s+(\w+)/)?.[1];
  return { name, found: !!state, state: state ?? "NOT_FOUND" };
}

/** Best-effort training summary: matching processes, GPU, log tail, and step/loss parsed from the log. */
export async function getTrainingStatus(opts: { logPath?: string; processName?: string; lines?: number }) {
  const [procs, gpu] = await Promise.all([getProcessStatus({ name: opts.processName ?? "python" }), getGpuStatus()]);
  let log: ReturnType<typeof tailFile> | undefined;
  let step: number | undefined, loss: number | undefined;
  if (opts.logPath) {
    log = tailFile(opts.logPath, opts.lines ?? 20);
    for (const line of [...log.lines].reverse()) {
      step ??= numberAfter(line, /\b(?:global[_ ]?)?step\b\s*[:=]?\s*/i);
      loss ??= numberAfter(line, /\bloss\b\s*[:=]?\s*/i);
      if (step !== undefined && loss !== undefined) break;
    }
  }
  const stale = log ? log.secondsSinceModified > 600 : undefined;
  return { processes: procs, gpu, log, latest: { step, loss }, logLooksStale: stale };
}

function numberAfter(line: string, prefix: RegExp): number | undefined {
  const m = line.match(new RegExp(prefix.source + "(-?\\d[\\d,]*\\.?\\d*(?:e-?\\d+)?)", "i"));
  return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
}

/* ---------- control ---------- */

export async function runCommand(command: string, cwd?: string, timeoutSec = 120) {
  const timeoutMs = Math.min(Math.max(timeoutSec, 1), 600) * 1000;
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, timeoutMs });
  return { exitCode: r.code, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr };
}

export function writeFile(file: string, content: string, createDirs = true) {
  if (Buffer.byteLength(content) > 1_000_000) throw new Error("content larger than 1 MB");
  if (createDirs) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, content, "utf8");
  return { path: path.resolve(file), bytes: Buffer.byteLength(content), overwrote: existed };
}

export async function stopProcess(pid: number) {
  if (!Number.isInteger(pid) || pid <= 4) throw new Error("refusing to stop system process");
  if (pid === process.pid) throw new Error("refusing to stop the gateway itself");
  const r = await run("taskkill", ["/pid", String(pid), "/T", "/F"]);
  return { stopped: r.code === 0, detail: (r.stdout || r.stderr).trim() };
}
