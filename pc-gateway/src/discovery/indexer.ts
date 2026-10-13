import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventBus } from "../sessions/manager.js";
import type { Db } from "../storage/sqlite.js";
import type { AgentSessionInfo, ProviderName } from "../types.js";
import { type LiveSession, type PidAlive, inferCodexLive, pidAlive, readClaudeLive } from "./live.js";
import {
  type SessionAgg, applyClaudeLine, applyCodexLine, emptyAgg, fallbackTitle,
} from "./parsers.js";
import type { RunningTurn, SessionEvent, SessionRef } from "../monitoring/session-activity.js";
import { type TranscriptMessage, readTranscript } from "./transcript.js";

export interface AgentHomes { claudeHome: string; codexHome: string }

export function defaultHomes(env: NodeJS.ProcessEnv = process.env): AgentHomes {
  const home = os.homedir();
  return {
    claudeHome: env.HELIX_CLAUDE_HOME ?? path.join(home, ".claude"),
    codexHome: env.HELIX_CODEX_HOME ?? path.join(home, ".codex"),
  };
}

export interface IndexerOptions {
  homes: AgentHomes;
  now?: () => number;
  alive?: PidAlive;
  log?: { error: (o: object, m: string) => void };
  /** Seconds a Codex transcript may be quiet before it stops counting as live. */
  codexLiveSec?: number;
}

export interface ListFilter {
  provider?: ProviderName;
  live?: boolean;
  /** Matches title, project, and the latest prompt/reply. */
  q?: string;
  project?: string;
  /** Hide sessions with fewer messages (default 1: nothing was ever said). */
  minMessages?: number;
  limit?: number;
  offset?: number;
}

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CHUNK = 4 * 1024 * 1024;
const HEAD_BYTES = 512;

interface Row {
  key: string; provider: ProviderName; provider_session_id: string; title: string | null; project_path: string | null;
  git_branch: string | null; model: string | null; cli_version: string | null; created_at: string | null;
  last_activity_at: string | null; message_count: number; first_user: string | null; last_user: string | null; last_user_at: string | null;
  last_assistant: string | null; task_state: string | null; source_file: string; file_size: number; file_mtime_ms: number;
  parsed_bytes: number; head_len: number; head_hash: string | null; live: number; live_status: string | null; live_pid: number | null; live_name: string | null;
  live_kind: string | null; live_since_ms: number | null; helix_session_id?: string | null;
}

/**
 * Finds every Claude Code and Codex session on this machine by reading the transcripts those tools
 * already write, so sessions started in a terminal or an IDE are visible without anyone telling Helix.
 * Strictly read-only against the tools' own files.
 */
export class SessionIndexer {
  private timers: NodeJS.Timeout[] = [];
  private scanning?: Promise<{ files: number; updated: number }>;
  private ready = false;
  private transitionListeners: ((e: SessionEvent) => void)[] = [];
  private codexTitles = new Map<string, string>();
  private codexTitlesMtime = 0;
  private readonly now: () => number;
  private readonly alive: PidAlive;

  constructor(private readonly db: Db, private readonly bus: EventBus, private readonly opts: IndexerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.alive = opts.alive ?? pidAlive;
  }

  /** Where Claude/Codex keep their data (for features that talk to live sessions). */
  homes(): AgentHomes { return this.opts.homes; }

  start(scanEveryMs = 30_000, liveEveryMs = 3_000): void {
    if (this.timers.length) return;
    void this.scan().catch((err) => this.opts.log?.error({ err }, "initial session scan failed"));
    const a = setInterval(() => void this.scan().catch((err) => this.opts.log?.error({ err }, "session scan failed")), scanEveryMs);
    const b = setInterval(() => { try { this.refreshLive(); } catch (err) { this.opts.log?.error({ err }, "live refresh failed"); } }, liveEveryMs);
    a.unref(); b.unref();
    this.timers = [a, b];
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /* ---------------- scanning ---------------- */

  /** Index new/changed transcripts. Concurrent calls share one scan. */
  scan(): Promise<{ files: number; updated: number }> {
    this.scanning ??= this.doScan().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  private async doScan(): Promise<{ files: number; updated: number }> {
    this.loadCodexTitles();
    const files = [...this.claudeFiles(), ...this.codexFiles()];
    let updated = 0;
    for (const f of files) {
      try {
        if (await this.indexFile(f.provider, f.id, f.file)) updated++;
      } catch (err) {
        this.opts.log?.error({ err, file: f.file }, "could not index transcript");
      }
      await new Promise((r) => setImmediate(r)); // never hog the event loop on a big first scan
    }
    this.refreshLive();
    const first = !this.ready;
    this.ready = true;
    return { files: files.length, updated: first ? 0 : updated };
  }

  private *claudeFiles(): Generator<{ provider: "claude"; id: string; file: string }> {
    const root = path.join(this.opts.homes.claudeHome, "projects");
    for (const dir of safeReaddir(root)) {
      const full = path.join(root, dir);
      for (const name of safeReaddir(full)) {
        const m = UUID_TAIL.exec(name);
        if (m && name.endsWith(".jsonl")) yield { provider: "claude", id: m[1]!.toLowerCase(), file: path.join(full, name) };
      }
    }
  }

  private *codexFiles(): Generator<{ provider: "codex"; id: string; file: string }> {
    const root = path.join(this.opts.homes.codexHome, "sessions");
    for (const y of safeReaddir(root)) for (const mo of safeReaddir(path.join(root, y))) for (const d of safeReaddir(path.join(root, y, mo))) {
      const dir = path.join(root, y, mo, d);
      for (const name of safeReaddir(dir)) {
        const m = UUID_TAIL.exec(name);
        if (m && name.startsWith("rollout-")) yield { provider: "codex", id: m[1]!.toLowerCase(), file: path.join(dir, name) };
      }
    }
  }

  private loadCodexTitles(): void {
    const file = path.join(this.opts.homes.codexHome, "session_index.jsonl");
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs === this.codexTitlesMtime) return;
      this.codexTitlesMtime = st.mtimeMs;
      this.codexTitles.clear();
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (typeof j.id === "string" && typeof j.thread_name === "string") this.codexTitles.set(j.id.toLowerCase(), j.thread_name);
        } catch { /* skip */ }
      }
    } catch { /* no index file */ }
  }

  /** Returns true if the row changed. Only the bytes appended since last time are parsed. */
  private async indexFile(provider: ProviderName, id: string, file: string): Promise<boolean> {
    const stat = fs.statSync(file);
    const key = `${provider}:${id}`;
    const prev = this.db.prepare("SELECT * FROM discovered_sessions WHERE key = ?").get(key) as Row | undefined;
    const codexTitle = provider === "codex" ? this.codexTitles.get(id) : undefined;

    if (prev && stat.size === prev.parsed_bytes && stat.mtimeMs === prev.file_mtime_ms) {
      if (codexTitle && codexTitle !== prev.title) {
        this.db.prepare("UPDATE discovered_sessions SET title = ? WHERE key = ?").run(codexTitle, key);
        return true;
      }
      return false;
    }

    let agg: SessionAgg = emptyAgg();
    let offset = 0;
    let headLen = 0;
    let headDigest: string | null = null;

    const fd = fs.openSync(file, "r");
    try {
      // Transcripts are append-only. If the start of the file is no longer what we parsed last time
      // (replaced, truncated and regrown), resuming from the old offset would parse garbage: start over.
      if (prev && stat.size >= prev.parsed_bytes && headHash(fd, prev.head_len) === prev.head_hash) {
        agg = aggFromRow(prev);
        offset = prev.parsed_bytes;
      }

      let carry = Buffer.alloc(0);
      while (offset + carry.length < stat.size) {
        const want = Math.min(CHUNK, stat.size - offset - carry.length);
        const buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, offset + carry.length);
        const data = carry.length ? Buffer.concat([carry, buf]) : buf;
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl === -1) { carry = data; continue; } // one enormous line; keep reading until it ends
        for (const line of data.subarray(0, lastNl).toString("utf8").split("\n")) {
          if (!line) continue;
          let j: unknown;
          try { j = JSON.parse(line); } catch { continue; }
          if (provider === "claude") applyClaudeLine(agg, j); else applyCodexLine(agg, j);
        }
        offset += lastNl + 1;
        carry = data.subarray(lastNl + 1);
        await new Promise((r) => setImmediate(r));
      }
      headLen = Math.min(offset, HEAD_BYTES);
      headDigest = headHash(fd, headLen);
    } finally {
      fs.closeSync(fd);
    }

    if (codexTitle) agg.title = codexTitle;
    this.db.prepare(
      `INSERT INTO discovered_sessions
         (key, provider, provider_session_id, title, project_path, git_branch, model, cli_version, created_at, last_activity_at,
          message_count, first_user, last_user, last_user_at, last_assistant, task_state, source_file, file_size, file_mtime_ms, parsed_bytes, head_len, head_hash, indexed_at)
       VALUES (@key, @provider, @id, @title, @project, @branch, @model, @ver, @created, @last,
               @count, @first, @lastUser, @lastUserAt, @lastAsst, @task, @file, @size, @mtime, @parsed, @headLen, @headHash, @now)
       ON CONFLICT(key) DO UPDATE SET
         title=@title, project_path=@project, git_branch=@branch, model=@model, cli_version=@ver, created_at=@created,
         last_activity_at=@last, message_count=@count, first_user=@first, last_user=@lastUser, last_user_at=@lastUserAt, last_assistant=@lastAsst,
         task_state=@task, source_file=@file, file_size=@size, file_mtime_ms=@mtime, parsed_bytes=@parsed, head_len=@headLen, head_hash=@headHash, indexed_at=@now`
    ).run({
      key, provider, id, title: agg.title ?? null, project: agg.projectPath ?? null, branch: agg.gitBranch ?? null,
      model: agg.model ?? null, ver: agg.cliVersion ?? null, created: agg.createdAt ?? null,
      last: agg.lastActivityAt ?? new Date(stat.mtimeMs).toISOString(),
      count: agg.messageCount, first: agg.firstUser ?? null, lastUser: agg.lastUser ?? null, lastUserAt: agg.lastUserAt ?? null, lastAsst: agg.lastAssistant ?? null,
      task: agg.taskState ?? null, file, size: stat.size, mtime: stat.mtimeMs, parsed: offset, headLen, headHash: headDigest, now: new Date(this.now()).toISOString(),
    });
    if (this.ready) this.announce(key);
    return true;
  }

  /* ---------------- live status ---------------- */

  /** Cheap (reads a handful of tiny files): runs every few seconds. Announces status transitions. */
  refreshLive(): void {
    const live: LiveSession[] = readClaudeLive(this.opts.homes.claudeHome, this.alive);
    const codexRows = this.db.prepare("SELECT provider_session_id AS id, file_mtime_ms AS m, task_state AS t FROM discovered_sessions WHERE provider = 'codex'")
      .all() as { id: string; m: number; t: string | null }[];
    live.push(...inferCodexLive(
      codexRows.map((r) => ({ providerSessionId: r.id, fileMtimeMs: r.m, taskState: r.t ?? undefined })),
      this.now(), (this.opts.codexLiveSec ?? 120) * 1000
    ));

    const liveKeys = new Map(live.map((l) => [`${l.provider}:${l.providerSessionId.toLowerCase()}`, l]));
    const rows = this.db.prepare("SELECT key, live, live_status, live_pid, live_since_ms FROM discovered_sessions WHERE live = 1 OR key IN (" +
      (liveKeys.size ? [...liveKeys.keys()].map(() => "?").join(",") : "''") + ")").all(...liveKeys.keys()) as
      { key: string; live: number; live_status: string | null; live_pid: number | null; live_since_ms: number | null }[];
    const transitions: { key: string; kind: "finished" | "failed"; durationSec: number }[] = [];

    const upd = this.db.prepare(
      "UPDATE discovered_sessions SET live = ?, live_status = ?, live_pid = ?, live_name = ?, live_kind = ?, live_since_ms = ? WHERE key = ?");
    for (const r of rows) {
      const l = liveKeys.get(r.key);
      const changed = (l ? 1 : 0) !== r.live || (l?.status ?? null) !== r.live_status || (l?.pid ?? null) !== r.live_pid;
      if (!changed) continue;
      upd.run(l ? 1 : 0, l?.status ?? null, l?.pid ?? null, l?.name ?? null, l?.kind ?? null, l?.statusSinceMs ?? null, r.key);
      if (this.ready) this.announce(r.key);

      // A session that was working and is now idle just finished a turn; one that was working and
      // vanished died mid-task (terminal closed, crash, killed). This needs no hooks and no cooperation.
      if (this.ready && r.live === 1 && r.live_status === "busy") {
        const durationSec = r.live_since_ms ? Math.max(0, Math.round((this.now() - r.live_since_ms) / 1000)) : 0;
        if (l && l.status === "idle") transitions.push({ key: r.key, kind: "finished", durationSec });
        else if (!l) transitions.push({ key: r.key, kind: "failed", durationSec });
      }
    }
    for (const t of transitions) void this.emitTransition(t);
  }

  /** Subscribe to "a session finished / died" derived from live-status changes (sessions Helix does not run itself). */
  onTransition(fn: (e: SessionEvent) => void): void {
    this.transitionListeners.push(fn);
  }

  private async emitTransition(t: { key: string; kind: "finished" | "failed"; durationSec: number }): Promise<void> {
    const [provider, id] = t.key.split(":") as [ProviderName, string];
    try {
      const file = this.sourceFile(provider, id);
      if (file) await this.indexFile(provider, id, file); // pick up the final reply before describing it
    } catch { /* describe it with what we have */ }
    const info = this.get(provider, id);
    if (!info || info.managed) return; // sessions Helix runs report through the gateway's own events
    const session = refOf(info);
    const e: SessionEvent = t.kind === "finished"
      ? { kind: "finished", session, durationSec: t.durationSec, resultText: info.lastAssistant }
      : { kind: "failed", session, durationSec: t.durationSec, reason: "The session ended while it was working (terminal closed, crashed, or was killed)." };
    for (const fn of this.transitionListeners) {
      try { fn(e); } catch { /* a listener must not break indexing */ }
    }
  }

  /** Live agent process id -> its session title, so notifications can say which session started something. */
  livePidTitles(): Map<number, string> {
    const rows = this.db.prepare("SELECT live_pid AS pid, title, first_user, project_path FROM discovered_sessions WHERE live = 1 AND live_pid IS NOT NULL AND live_pid > 0")
      .all() as { pid: number; title: string | null; first_user: string | null; project_path: string | null }[];
    return new Map(rows.map((r) => [r.pid, `Claude "${r.title ?? r.first_user?.slice(0, 50) ?? (r.project_path ? path.basename(r.project_path) : "session")}"`]));
  }

  /** Sessions open elsewhere that are mid-turn, for stall detection. */
  externalRunning(): RunningTurn[] {
    const rows = this.db.prepare(
      `SELECT d.key, d.provider, d.provider_session_id AS id, d.title, d.first_user, d.project_path, d.live_since_ms, d.file_mtime_ms
         FROM discovered_sessions d LEFT JOIN sessions s ON s.provider = d.provider AND s.provider_session_id = d.provider_session_id
        WHERE d.live = 1 AND d.live_status = 'busy' AND s.id IS NULL`
    ).all() as { key: string; provider: string; id: string; title: string | null; first_user: string | null; project_path: string | null; live_since_ms: number | null; file_mtime_ms: number }[];
    return rows.map((r) => ({
      sessionId: r.key, provider: r.provider,
      title: r.title ?? (r.first_user ? r.first_user.slice(0, 60) : r.project_path ? path.basename(r.project_path) : "session"),
      startedAt: r.live_since_ms ?? r.file_mtime_ms,
      lastActivityAt: Math.max(r.file_mtime_ms, r.live_since_ms ?? 0),
    }));
  }

  /** Re-read one transcript right now (used when a hook tells us something just happened). */
  async refreshSession(provider: ProviderName, id: string, file?: string): Promise<AgentSessionInfo | undefined> {
    const f = file ?? this.sourceFile(provider, id);
    if (f && fs.existsSync(f)) {
      try { await this.indexFile(provider, id.toLowerCase(), f); } catch { /* unreadable right now */ }
    }
    return this.get(provider, id);
  }

  private announce(key: string): void {
    const s = this.get(...(key.split(":") as [ProviderName, string]));
    if (s) this.bus.publish({ type: "agent.session.changed", session: s });
  }

  /* ---------------- queries ---------------- */

  list(f: ListFilter = {}): AgentSessionInfo[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.provider) { where.push("d.provider = ?"); args.push(f.provider); }
    if (f.live !== undefined) { where.push("d.live = ?"); args.push(f.live ? 1 : 0); }
    if (f.project) { where.push("d.project_path LIKE ?"); args.push(`%${f.project}%`); }
    // Every word must appear somewhere (title, project, or recent text): "cat training" finds "Cat model training".
    for (const word of (f.q ?? "").split(/\s+/).filter(Boolean).slice(0, 6)) {
      where.push("(d.title LIKE ? OR d.project_path LIKE ? OR d.last_user LIKE ? OR d.last_assistant LIKE ? OR d.first_user LIKE ?)");
      for (let i = 0; i < 5; i++) args.push(`%${word}%`);
    }
    where.push("d.message_count >= ?"); args.push(f.minMessages ?? 1);
    where.push("(s.role IS NULL OR s.role != 'router')"); // the General Claude front door is plumbing, not a session to browse
    const rows = this.db.prepare(
      `SELECT d.*, s.id AS helix_session_id FROM discovered_sessions d
         LEFT JOIN sessions s ON s.provider = d.provider AND s.provider_session_id = d.provider_session_id
        WHERE ${where.join(" AND ")}
        ORDER BY d.live DESC, d.last_activity_at DESC
        LIMIT ? OFFSET ?`
    ).all(...args, Math.min(f.limit ?? 100, 500), f.offset ?? 0) as Row[];
    return rows.map(toInfo);
  }

  get(provider: ProviderName, id: string): AgentSessionInfo | undefined {
    const r = this.db.prepare(
      `SELECT d.*, s.id AS helix_session_id FROM discovered_sessions d
         LEFT JOIN sessions s ON s.provider = d.provider AND s.provider_session_id = d.provider_session_id
        WHERE d.key = ?`
    ).get(`${provider}:${id.toLowerCase()}`) as Row | undefined;
    return r && toInfo(r);
  }

  /** Projects that have sessions, most recently active first: what a router picks from to start new work. */
  projects(limit = 30): { path: string; name: string; sessions: number; liveSessions: number; lastActivityAt?: string }[] {
    const rows = this.db.prepare(
      `SELECT d.project_path AS p, COUNT(*) AS n, SUM(d.live) AS live, MAX(d.last_activity_at) AS last
         FROM discovered_sessions d LEFT JOIN sessions s ON s.provider = d.provider AND s.provider_session_id = d.provider_session_id
        WHERE d.project_path IS NOT NULL AND d.message_count >= 1 AND (s.role IS NULL OR s.role != 'router')
        GROUP BY d.project_path ORDER BY last DESC LIMIT ?`
    ).all(Math.min(limit, 100)) as { p: string; n: number; live: number; last: string | null }[];
    return rows.map((r) => ({ path: r.p, name: path.basename(r.p), sessions: r.n, liveSessions: r.live ?? 0, lastActivityAt: r.last ?? undefined }));
  }

  /** Where a session lives on disk. Internal: not exposed through the API. */
  sourceFile(provider: ProviderName, id: string): string | undefined {
    const r = this.db.prepare("SELECT source_file FROM discovered_sessions WHERE key = ?").get(`${provider}:${id.toLowerCase()}`) as { source_file: string } | undefined;
    return r?.source_file;
  }

  /** Newest-last page of the readable conversation. `before` is an ordinal cursor for paging backwards. */
  transcript(provider: ProviderName, id: string, opts: { before?: number; limit?: number } = {}):
    { messages: TranscriptMessage[]; total: number; hasMore: boolean } | undefined {
    const file = this.sourceFile(provider, id);
    if (!file || !fs.existsSync(file)) return undefined;
    const all = readTranscript(provider, file);
    const end = Math.min(opts.before ?? all.length, all.length);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), total: all.length, hasMore: start > 0 };
  }
}

/** Fingerprint of the first `len` bytes (what we have already parsed). */
function headHash(fd: number, len: number): string | null {
  if (len <= 0) return null;
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, 0);
  return n === len ? createHash("sha1").update(buf).digest("hex") : null;
}

function refOf(info: AgentSessionInfo): SessionRef {
  return { id: info.helixSessionId ?? info.key, providerSessionId: info.id, provider: info.provider, title: info.title, projectPath: info.projectPath, external: !info.managed };
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function aggFromRow(r: Row): SessionAgg {
  return {
    title: r.title ?? undefined, projectPath: r.project_path ?? undefined, gitBranch: r.git_branch ?? undefined,
    model: r.model ?? undefined, cliVersion: r.cli_version ?? undefined, createdAt: r.created_at ?? undefined,
    lastActivityAt: r.last_activity_at ?? undefined, messageCount: r.message_count, firstUser: r.first_user ?? undefined,
    lastUser: r.last_user ?? undefined, lastUserAt: r.last_user_at ?? undefined, lastAssistant: r.last_assistant ?? undefined,
    taskState: (r.task_state as SessionAgg["taskState"]) ?? undefined,
  };
}

function toInfo(r: Row): AgentSessionInfo {
  const projectName = r.project_path ? path.basename(r.project_path) : undefined;
  const agg = aggFromRow(r);
  return {
    key: r.key, provider: r.provider, id: r.provider_session_id,
    title: fallbackTitle(agg, projectName), projectPath: agg.projectPath, projectName,
    gitBranch: agg.gitBranch, model: agg.model, createdAt: agg.createdAt, lastActivityAt: agg.lastActivityAt,
    messageCount: r.message_count, preview: agg.lastAssistant ?? agg.lastUser, lastUser: agg.lastUser, lastUserAt: agg.lastUserAt, lastAssistant: agg.lastAssistant,
    live: r.live === 1, liveStatus: (r.live_status as "busy" | "idle" | null) ?? undefined, livePid: r.live_pid ?? undefined,
    liveName: r.live_name ?? undefined, liveKind: r.live_kind ?? undefined, liveSinceMs: r.live_since_ms ?? undefined,
    liveInferred: r.live === 1 && r.provider === "codex" ? true : undefined,
    managed: !!r.helix_session_id, helixSessionId: r.helix_session_id ?? undefined,
  };
}
