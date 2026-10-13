import fs from "node:fs";
import path from "node:path";

export interface LiveSession {
  provider: "claude" | "codex";
  providerSessionId: string;
  pid: number;
  /** "busy" while a turn is running, "idle" while waiting for the user. */
  status: "busy" | "idle";
  name?: string;
  kind?: string;
  /** Epoch ms of the last status change, when the tool records it. */
  statusSinceMs?: number;
}

export type PidAlive = (pid: number) => boolean;

export const pidAlive: PidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, just not ours to signal
  }
};

/**
 * Claude Code keeps a registry of running sessions in ~/.claude/sessions/<pid>.json
 * ({pid, sessionId, cwd, name, status, statusUpdatedAt, kind, ...}). Entries left behind by a
 * crashed process are filtered by checking the pid is still alive.
 *
 * Undocumented and version-specific: if the directory or fields are missing we simply report
 * nothing live rather than failing.
 */
export function readClaudeLive(claudeHome: string, alive: PidAlive = pidAlive): LiveSession[] {
  const dir = path.join(claudeHome, "sessions");
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }

  const out: LiveSession[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (typeof j.sessionId !== "string" || typeof j.pid !== "number") continue;
      if (!alive(j.pid)) continue;
      out.push({
        provider: "claude",
        providerSessionId: j.sessionId,
        pid: j.pid,
        status: j.status === "busy" ? "busy" : "idle",
        name: typeof j.name === "string" ? j.name : undefined,
        kind: typeof j.kind === "string" ? j.kind : undefined,
        statusSinceMs: typeof j.statusUpdatedAt === "number" ? j.statusUpdatedAt : undefined,
      });
    } catch { /* half-written or foreign file */ }
  }
  return out;
}

/**
 * Codex has no per-process registry file. A session counts as live when its transcript was written
 * very recently, and busy when the transcript says a turn is in flight. This is an inference
 * (labelled as such by callers); the authoritative source is the Codex app-server (Phase 9).
 */
export function inferCodexLive(
  sessions: { providerSessionId: string; fileMtimeMs: number; taskState?: string }[],
  now: number,
  recentMs = 120_000
): LiveSession[] {
  return sessions
    .filter((s) => now - s.fileMtimeMs < recentMs)
    .map((s) => ({
      provider: "codex" as const,
      providerSessionId: s.providerSessionId,
      pid: 0,
      status: s.taskState === "running" ? ("busy" as const) : ("idle" as const),
      statusSinceMs: s.fileMtimeMs,
    }));
}
