import fs from "node:fs";
import * as pc from "../mcp/pc-tools.js";
import { shortCommand, trackAgentProcesses, type TrackedProc } from "./agent-processes.js";
import type { SessionActivity } from "./session-activity.js";
import type { Severity, Watch } from "./watch-types.js";

/** A yes/no condition the watch tracks over time (process gone, log stale, ...). Fires on transitions. */
export interface Condition {
  key: string;
  active: boolean;
  severity: Severity;
  /** Describes the problem when active; shown on trigger. */
  summary: string;
  /** Describes the healthy state; shown when it recovers. */
  okSummary: string;
  detail?: string;
  /**
   * For "tell me when X finishes" conditions: becoming active is just the normal "still going" state and
   * stays quiet. The recovery is the news, delivered at `resolvedSeverity`, and also fires at once if the
   * condition was already inactive the first time it was checked.
   */
  notifyOnClear?: { severity: Severity };
}

/** A one-off occurrence (a log line matched). Fires every time, subject to dedupe/rate limits. */
export interface Match {
  severity: Severity;
  summary: string;
  detail?: string;
}

export interface CheckOutput {
  conditions: Condition[];
  matches: Match[];
  /** New per-watch state to persist (offsets etc.). */
  state: Record<string, any>;
}

/** Everything a check touches outside its own state, injectable so checks can be tested deterministically. */
export interface CheckDeps {
  now: () => number;
  getProcessStatus: typeof pc.getProcessStatus;
  getGpuStatus: typeof pc.getGpuStatus;
  processSnapshot: typeof pc.processSnapshot;
  runCommand: typeof pc.runCommand;
  fetch: typeof fetch;
  /** Needed only by session watches; absent in contexts that don't track sessions. */
  sessions?: Pick<SessionActivity, "running" | "oldPendingApprovals">;
  /** Process ids already covered by an explicit process watch. */
  coveredPids?: () => Set<number>;
  /** Display names for agent processes by pid (the live session's title). */
  agentPidTitles?: () => Map<number, string>;
}

export const realDeps: CheckDeps = {
  now: () => Date.now(),
  getProcessStatus: pc.getProcessStatus,
  getGpuStatus: pc.getGpuStatus,
  processSnapshot: pc.processSnapshot,
  runCommand: pc.runCommand,
  fetch: (...a) => fetch(...a),
};

const MAX_READ_PER_TICK = 1024 * 1024;
const MAX_CARRY = 4096;
const MAX_MATCHES_PER_TICK = 50;

export async function runCheck(w: Watch, deps: CheckDeps = realDeps): Promise<CheckOutput> {
  switch (w.type) {
    case "process": return checkProcess(w, deps);
    case "log": return checkLog(w, deps);
    case "file": return checkFile(w, deps);
    case "command": return checkCommand(w, deps);
    case "http": return checkHttp(w, deps);
    case "gpu": return checkGpu(w, deps);
    case "git": return checkGit(w);
    case "session": return checkSession(w, deps);
    case "agentprocs": return checkAgentProcs(w, deps);
  }
}

/* ---------------- process ---------------- */

async function checkProcess(w: Watch, deps: CheckDeps): Promise<CheckOutput> {
  const c = w.config as { pid?: number; name?: string; expect: "running" | "stopped" };
  const what = c.pid !== undefined ? `process ${c.pid}` : `"${c.name}"`;
  const r = await deps.getProcessStatus({ pid: c.pid, name: c.name });
  const expectRunning = c.expect === "running";
  return {
    conditions: [{
      key: "process",
      active: expectRunning ? !r.running : r.running,
      severity: w.severity,
      summary: expectRunning ? `${what} is no longer running` : `${what} is running`,
      okSummary: expectRunning ? `${what} is running again` : `${what} has stopped`,
      notifyOnClear: expectRunning ? undefined : { severity: w.severity },
    }],
    matches: [],
    state: w.state,
  };
}

/* ---------------- log ---------------- */

interface LogPattern { regex: string; severity: Severity; label?: string }

async function checkLog(w: Watch, deps: CheckDeps): Promise<CheckOutput> {
  const c = w.config as { path: string; patterns: LogPattern[]; startAt: "end" | "start"; staleAfterSec?: number; staleSeverity: Severity };
  const state = { ...w.state };
  const conditions: Condition[] = [];
  const matches: Match[] = [];

  let stat: fs.Stats;
  try {
    stat = fs.statSync(c.path);
  } catch {
    conditions.push({
      key: "missing", active: true, severity: w.severity,
      summary: `log file not found: ${c.path}`, okSummary: `log file is back: ${c.path}`,
    });
    return { conditions, matches, state };
  }
  conditions.push({ key: "missing", active: false, severity: w.severity, summary: "", okSummary: `log file is back: ${c.path}` });

  let offset: number = typeof state.offset === "number" ? state.offset : c.startAt === "end" ? stat.size : 0;
  if (stat.size < offset) { offset = 0; state.carry = ""; } // truncated or rotated: start over

  if (stat.size > offset && c.patterns.length > 0) {
    const len = Math.min(stat.size - offset, MAX_READ_PER_TICK);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(c.path, "r");
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    offset += len;

    const text = String(state.carry ?? "") + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    state.carry = (lines.pop() ?? "").slice(-MAX_CARRY); // trailing partial line waits for its newline

    const compiled = c.patterns.map((p) => ({ p, re: new RegExp(p.regex, "i") }));
    const window: string[] = [];
    for (const line of lines) {
      window.push(line);
      if (window.length > 6) window.shift();
      if (!line.trim()) continue;
      const clipped = line.length > 2000 ? line.slice(0, 2000) : line; // bound regex work on pathological lines
      const hit = compiled.find(({ re }) => re.test(clipped));
      if (hit && matches.length < MAX_MATCHES_PER_TICK) {
        matches.push({
          severity: hit.p.severity,
          summary: `${hit.p.label ?? hit.p.regex}: ${clipped.trim().slice(0, 200)}`,
          detail: window.join("\n").slice(-1500),
        });
      }
    }
  } else if (stat.size > offset) {
    offset = stat.size; // nothing to match against; just keep the offset current
  }
  state.offset = offset;

  if (c.staleAfterSec !== undefined) {
    const idleSec = Math.round((deps.now() - stat.mtimeMs) / 1000);
    conditions.push({
      key: "stale",
      active: idleSec > c.staleAfterSec,
      severity: c.staleSeverity,
      summary: `log has not been written for ${fmtDuration(idleSec)} (${c.path})`,
      okSummary: `log is being written again (${c.path})`,
    });
  }
  return { conditions, matches, state };
}

/* ---------------- file ---------------- */

async function checkFile(w: Watch, deps: CheckDeps): Promise<CheckOutput> {
  const c = w.config as { path: string; mode: "exists" | "missing" | "modified" | "stale"; staleAfterSec?: number };
  const state = { ...w.state };
  let stat: fs.Stats | undefined;
  try { stat = fs.statSync(c.path); } catch { /* absent */ }

  const matches: Match[] = [];
  const conditions: Condition[] = [];
  if (c.mode === "exists") {
    conditions.push({ key: "file", active: !!stat, severity: w.severity, summary: `${c.path} exists`, okSummary: `${c.path} is gone` });
  } else if (c.mode === "missing") {
    conditions.push({ key: "file", active: !stat, severity: w.severity, summary: `${c.path} is missing`, okSummary: `${c.path} is back` });
  } else if (c.mode === "stale") {
    const idleSec = stat ? Math.round((deps.now() - stat.mtimeMs) / 1000) : Infinity;
    conditions.push({
      key: "file", active: !stat || idleSec > (c.staleAfterSec ?? 0), severity: w.severity,
      summary: stat ? `${c.path} has not changed for ${fmtDuration(idleSec)}` : `${c.path} is missing`,
      okSummary: `${c.path} is being updated again`,
    });
  } else if (stat) {
    const m = stat.mtimeMs;
    if (typeof state.mtime === "number" && m !== state.mtime) {
      matches.push({ severity: w.severity, summary: `${c.path} was modified` });
    }
    state.mtime = m;
  }
  return { conditions, matches, state };
}

/* ---------------- command ---------------- */

async function checkCommand(w: Watch, deps: CheckDeps): Promise<CheckOutput> {
  const c = w.config as { command: string; cwd?: string; timeoutSec: number; expectExitCode: number; expectStdoutRegex?: string };
  const r = await deps.runCommand(c.command, c.cwd, c.timeoutSec);
  let problem: string | undefined;
  if (r.timedOut) problem = `timed out after ${c.timeoutSec}s`;
  else if (r.exitCode !== c.expectExitCode) problem = `exit code ${r.exitCode} (expected ${c.expectExitCode})`;
  else if (c.expectStdoutRegex && !new RegExp(c.expectStdoutRegex, "i").test(r.stdout)) problem = `output did not match /${c.expectStdoutRegex}/`;
  return {
    conditions: [{
      key: "command", active: !!problem, severity: w.severity,
      summary: `check "${w.name}" failed: ${problem}`, okSummary: `check "${w.name}" is passing again`,
      detail: (r.stdout + "\n" + r.stderr).trim().slice(-1500),
    }],
    matches: [],
    state: w.state,
  };
}

/* ---------------- http ---------------- */

async function checkHttp(w: Watch, deps: CheckDeps): Promise<CheckOutput> {
  const c = w.config as { url: string; timeoutSec: number; expectStatus?: number; failAfter: number };
  const state = { ...w.state };
  let problem: string | undefined;
  try {
    const res = await deps.fetch(c.url, { signal: AbortSignal.timeout(c.timeoutSec * 1000), redirect: "manual" });
    const okStatus = c.expectStatus !== undefined ? res.status === c.expectStatus : res.status >= 200 && res.status < 400;
    if (!okStatus) problem = `HTTP ${res.status}`;
    await res.body?.cancel().catch(() => undefined);
  } catch (err) {
    problem = err instanceof Error && err.name === "TimeoutError" ? `no response in ${c.timeoutSec}s` : `unreachable (${err instanceof Error ? err.message : err})`;
  }
  state.fails = problem ? (Number(state.fails) || 0) + 1 : 0;
  return {
    conditions: [{
      key: "http", active: Number(state.fails) >= c.failAfter, severity: w.severity,
      summary: `${c.url} is failing: ${problem ?? "recovering"} (${state.fails} checks in a row)`,
      okSummary: `${c.url} is healthy again`,
    }],
    matches: [],
    state,
  };
}

/* ---------------- gpu ---------------- */

async function checkGpu(w: Watch, deps: CheckDeps): Promise<CheckOutput> {
  const c = w.config as { tempAboveC?: number; memAbovePercent?: number; idleBelowPercent?: number; idleForSec: number };
  const state = { ...w.state };
  const g = await deps.getGpuStatus();
  if (!g.available || !("gpus" in g) || !g.gpus) throw new Error(("error" in g && g.error) || "GPU status unavailable");
  const gpus = g.gpus;
  const conditions: Condition[] = [];

  if (c.tempAboveC !== undefined) {
    const hot = gpus.find((x) => x.temperatureC > c.tempAboveC!);
    conditions.push({
      key: "temp", active: !!hot, severity: w.severity,
      summary: hot ? `GPU ${hot.index} is at ${hot.temperatureC}°C (limit ${c.tempAboveC}°C)` : "",
      okSummary: "GPU temperature is back to normal",
    });
  }
  if (c.memAbovePercent !== undefined) {
    const full = gpus.find((x) => (x.memoryUsedMB / x.memoryTotalMB) * 100 > c.memAbovePercent!);
    conditions.push({
      key: "mem", active: !!full, severity: w.severity,
      summary: full ? `GPU ${full.index} VRAM is ${Math.round((full.memoryUsedMB / full.memoryTotalMB) * 100)}% full` : "",
      okSummary: "GPU memory is back below the limit",
    });
  }
  if (c.idleBelowPercent !== undefined) {
    const busy = gpus.some((x) => x.utilizationPercent >= c.idleBelowPercent!);
    if (busy) delete state.idleSince;
    else state.idleSince ??= deps.now();
    const idleSec = state.idleSince ? Math.round((deps.now() - Number(state.idleSince)) / 1000) : 0;
    conditions.push({
      key: "idle", active: !busy && idleSec >= c.idleForSec, severity: w.severity,
      summary: `GPU has been idle (<${c.idleBelowPercent}%) for ${fmtDuration(idleSec)}`,
      okSummary: "GPU is busy again",
    });
  }
  return { conditions, matches: [], state };
}

/* ---------------- git ---------------- */

async function checkGit(w: Watch): Promise<CheckOutput> {
  const c = w.config as { repo: string; notifyOnCommit: boolean; notifyOnBranchChange: boolean };
  const state = { ...w.state };
  const [head, branch] = await Promise.all([
    pc.run("git", ["-C", c.repo, "rev-parse", "HEAD"]),
    pc.run("git", ["-C", c.repo, "rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  if (head.code !== 0) throw new Error(head.stderr.trim() || "not a git repository");
  const sha = head.stdout.trim();
  const br = branch.stdout.trim();
  const matches: Match[] = [];

  if (typeof state.head === "string" && state.head !== sha) {
    const log = await pc.run("git", ["-C", c.repo, "log", "-n3", "--pretty=format:%h %s", `${state.head}..${sha}`]);
    if (br === state.branch && c.notifyOnCommit) {
      const subject = (log.stdout.trim().split(/\r?\n/)[0] ?? sha.slice(0, 7)).replace(/^[0-9a-f]{7,40} /, "");
      matches.push({ severity: "info", summary: `New commit on ${br}: ${subject}`, detail: log.stdout.trim() || undefined });
    }
  }
  if (typeof state.branch === "string" && state.branch !== br && c.notifyOnBranchChange) {
    matches.push({ severity: "info", summary: `Branch changed: ${state.branch} -> ${br}` });
  }
  state.head = sha;
  state.branch = br;
  return { conditions: [], matches, state };
}

/* ---------------- agent processes ---------------- */

async function checkAgentProcs(w: Watch, deps: CheckDeps): Promise<CheckOutput> {
  const c = w.config as { minRuntimeSec: number; importantAfterSec: number; notifyOnStart: boolean };
  const snapshot = await deps.processSnapshot();
  const r = trackAgentProcesses({
    snapshot, tracked: (w.state.tracked ?? {}) as Record<string, TrackedProc>, now: deps.now(), minRuntimeMs: c.minRuntimeSec * 1000,
    covered: deps.coveredPids?.() ?? new Set(), ownerNames: deps.agentPidTitles?.() ?? new Map(),
  });
  const matches: Match[] = [];
  const first = w.state.tracked === undefined;
  for (const t of r.started) {
    if (c.notifyOnStart && !first) matches.push({ severity: "info", summary: `${t.owner} started ${shortCommand(t.name, t.cmd)}` });
  }
  for (const t of r.ended) {
    const sec = Math.round(t.runMs / 1000);
    matches.push({
      severity: sec >= c.importantAfterSec ? "important" : "info",
      summary: `${shortCommand(t.name, t.cmd)} (started by ${t.owner}) ended after ${fmtDuration(sec)}`,
    });
  }
  return { conditions: [], matches, state: { ...w.state, tracked: r.tracked } };
}

/* ---------------- session (polling half; finish/fail are event-driven in the manager) ---------------- */

async function checkSession(w: Watch, deps: CheckDeps): Promise<CheckOutput> {
  const c = w.config as { sessionId?: string; stalledAfterSec?: number; approvalWaitingAfterSec?: number };
  const conditions: Condition[] = [];
  if (!deps.sessions) return { conditions, matches: [], state: w.state };

  if (c.stalledAfterSec !== undefined) {
    const now = deps.now();
    const stuck = deps.sessions.running()
      .filter((t) => (!c.sessionId || t.sessionId === c.sessionId) && now - t.lastActivityAt > c.stalledAfterSec! * 1000)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
    conditions.push({
      key: "stalled", active: !!stuck, severity: w.severity,
      summary: stuck ? `${cap(stuck.provider)} task "${stuck.title}" has produced no output for ${fmtDuration(Math.round((now - stuck.lastActivityAt) / 1000))}` : "",
      okSummary: "a stalled agent task is moving again",
    });
  }
  if (c.approvalWaitingAfterSec !== undefined) {
    const waiting = deps.sessions.oldPendingApprovals(c.approvalWaitingAfterSec * 1000, c.sessionId);
    conditions.push({
      key: "approval", active: waiting.length > 0, severity: w.severity,
      summary: waiting[0] ? `${waiting.length} approval request(s) waiting on you, oldest: ${waiting[0].summary.slice(0, 160)}` : "",
      okSummary: "no approvals are waiting",
    });
  }
  return { conditions, matches: [], state: w.state };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function fmtDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec)) return "a long time";
  if (totalSec < 90) return `${totalSec}s`;
  const m = Math.round(totalSec / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
