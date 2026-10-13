import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { basename } from "node:path";
import type { Escalation } from "../notifications/escalation.js";
import { classify } from "../permissions/classifier.js";
import { GatewayError, type EventBus } from "../sessions/manager.js";
import type { Db } from "../storage/sqlite.js";
import { type CheckDeps, type Condition, type Match, realDeps, runCheck } from "./checks.js";
import type { SessionActivity, SessionEvent } from "./session-activity.js";
import {
  type Severity, type Watch, type WatchEvent, type WatchInput, WatchInputSchema, configSchemas,
} from "./watch-types.js";

export const MAX_WATCHES = 100;
const MAX_MATCH_EVENTS_PER_CHECK = 5;
const SEVERITY_RANK: Record<Severity, number> = { info: 0, important: 1, critical: 2 };

interface Row {
  id: string; name: string; type: Watch["type"]; config: string; interval_sec: number; severity: Severity;
  session_id: string | null; enabled: number; state: string; wake: string | null; notify_on_resolve: number;
  repeat_min: number | null; created_at: string; last_checked_at: string | null; last_event_at: string | null;
  last_status: Watch["lastStatus"] | null; last_error: string | null;
}

const toWatch = (r: Row): Watch => ({
  id: r.id, name: r.name, type: r.type, config: JSON.parse(r.config), intervalSec: r.interval_sec, severity: r.severity,
  sessionId: r.session_id ?? undefined, enabled: r.enabled === 1, state: JSON.parse(r.state),
  wake: r.wake ? JSON.parse(r.wake) : undefined, notifyOnResolve: r.notify_on_resolve === 1, repeatMin: r.repeat_min ?? undefined,
  createdAt: r.created_at, lastCheckedAt: r.last_checked_at ?? undefined, lastEventAt: r.last_event_at ?? undefined,
  lastStatus: r.last_status ?? undefined, lastError: r.last_error ?? undefined,
});

/** Bookkeeping the manager keeps inside Watch.state, separate from whatever the check stores. */
interface Tracked {
  conditions: Record<string, { since: number; lastFiredAt: number; summary: string }>;
  /** Condition keys evaluated at least once (lets "tell me when it stops" fire if it had already stopped). */
  seen: Record<string, true>;
  errors: number;
  errorNotified: boolean;
}

export interface WatcherDeps {
  db: Db;
  bus: EventBus;
  escalation: Escalation;
  activity: SessionActivity;
  /** Hands an event to an agent session. Returns false if the session is busy or missing. */
  wake?: (sessionId: string, text: string) => boolean;
  sessionExists: (id: string) => boolean;
  checkDeps?: Partial<CheckDeps>;
  log?: { error: (o: object, m: string) => void; info?: (o: object, m: string) => void };
}

export interface WatcherOptions {
  tickMs?: number;
  now?: () => number;
  /** Identical-looking log matches within this window are collapsed into one event. */
  dedupeMs?: number;
}

export interface RunSummary {
  status: "ok" | "triggered" | "error";
  fired: number;
  error?: string;
}

/**
 * Runs deterministic checks on timers, turns state *changes* into events, and hands them to the
 * escalation policy. No model is involved unless a watch is configured to wake an agent.
 */
export class WatcherManager {
  private timer?: NodeJS.Timeout;
  private readonly inFlight = new Set<string>();
  private readonly recent = new Map<string, { at: number; suppressed: number }>();
  private readonly lastWake = new Map<string, number>();
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly dedupeMs: number;
  private readonly checkDeps: CheckDeps;

  constructor(private readonly d: WatcherDeps, opts: WatcherOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.tickMs = opts.tickMs ?? 2000;
    this.dedupeMs = opts.dedupeMs ?? 5 * 60_000;
    this.checkDeps = { ...realDeps, now: this.now, sessions: d.activity, coveredPids: () => this.coveredPids(), ...d.checkDeps };
    d.activity.onSessionEvent((e) => void this.onSessionEvent(e));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /* ---------------- CRUD ---------------- */

  create(input: WatchInput): Watch {
    const data = WatchInputSchema.parse(input);
    if ((this.d.db.prepare("SELECT COUNT(*) AS n FROM watches").get() as { n: number }).n >= MAX_WATCHES) {
      throw new GatewayError(409, `watch limit (${MAX_WATCHES}) reached`);
    }
    const config = configSchemas[data.type].parse(data.config) as Record<string, any>;
    this.validate(data.type, config);
    for (const sid of [data.sessionId, data.wake?.sessionId]) {
      if (sid && !this.d.sessionExists(sid)) throw new GatewayError(400, `session ${sid} not found`);
    }

    // Anchor "from now on" at creation so nothing written between create and the first check is missed or replayed.
    const state: Record<string, any> = {};
    try {
      if (data.type === "log" && config.startAt === "end") state.offset = fs.statSync(config.path).size;
      if (data.type === "file") state.mtime = fs.statSync(config.path).mtimeMs;
    } catch { /* absent file: handled by the check */ }

    const id = randomUUID();
    this.d.db.prepare(
      `INSERT INTO watches (id, name, type, config, interval_sec, severity, session_id, enabled, state, wake, notify_on_resolve, repeat_min, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(
      id, data.name, data.type, JSON.stringify(config), data.intervalSec, data.severity, data.sessionId ?? null,
      JSON.stringify(state), data.wake ? JSON.stringify(data.wake) : null, data.notifyOnResolve ? 1 : 0, data.repeatMin ?? null,
      new Date(this.now()).toISOString()
    );
    return this.mustGet(id);
  }

  list(): Watch[] {
    return (this.d.db.prepare("SELECT * FROM watches ORDER BY created_at").all() as Row[]).map(toWatch);
  }

  get(id: string): Watch | undefined {
    const r = this.d.db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as Row | undefined;
    return r && toWatch(r);
  }

  remove(id: string): boolean {
    return this.d.db.prepare("DELETE FROM watches WHERE id = ?").run(id).changes === 1;
  }

  setEnabled(id: string, enabled: boolean): Watch | undefined {
    this.d.db.prepare("UPDATE watches SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  events(watchId: string, limit = 50): WatchEvent[] {
    return (this.d.db.prepare("SELECT * FROM watch_events WHERE watch_id = ? ORDER BY rowid DESC LIMIT ?").all(watchId, limit) as any[])
      .map((r) => ({ id: r.id, watchId: r.watch_id, ts: r.ts, kind: r.kind, severity: r.severity, summary: r.summary, detail: r.detail ?? undefined }));
  }

  /** Process ids that an explicit process watch already reports on. */
  private coveredPids(): Set<number> {
    return new Set(this.list().filter((w) => w.enabled && w.type === "process" && typeof w.config.pid === "number").map((w) => w.config.pid as number));
  }

  /** Creates the always-on "agent tasks" watch once, so finished/failed/stalled agent work reaches the phone with zero setup. */
  ensureDefaults(): void {
    const seed = (key: string, make: () => void) => {
      if (this.d.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key)) return;
      make();
      this.d.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, new Date(this.now()).toISOString());
    };
    seed("default_session_watch", () => this.create({
      name: "Agent tasks", type: "session", intervalSec: 30, severity: "important",
      config: { stalledAfterSec: 900, approvalWaitingAfterSec: 300 },
    }));
    seed("default_agentproc_watch", () => this.create({
      name: "Agent processes", type: "agentprocs", intervalSec: 15, severity: "info", config: {},
    }));
  }

  /* ---------------- scheduling ---------------- */

  async tick(): Promise<void> {
    const now = this.now();
    const due = this.list().filter((w) =>
      w.enabled && !this.inFlight.has(w.id) &&
      (!w.lastCheckedAt || new Date(w.lastCheckedAt).getTime() + w.intervalSec * 1000 <= now));
    await Promise.all(due.map((w) => this.runNow(w.id)));
  }

  /** Runs one watch immediately (also used by tests and the "check now" API). */
  async runNow(id: string): Promise<RunSummary> {
    const w = this.get(id);
    if (!w) throw new GatewayError(404, "watch not found");
    if (this.inFlight.has(id)) return { status: w.lastStatus ?? "ok", fired: 0 };
    this.inFlight.add(id);
    try {
      return await this.evaluate(w);
    } catch (err) {
      this.d.log?.error({ err, watchId: id }, "watch evaluation crashed");
      return { status: "error", fired: 0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async evaluate(w: Watch): Promise<RunSummary> {
    const { _t, ...checkState } = w.state as { _t?: Tracked } & Record<string, any>;
    const tracked: Tracked = { conditions: {}, seen: {}, errors: 0, errorNotified: false, ..._t };
    let fired = 0;

    let out;
    try {
      out = await runCheck({ ...w, state: checkState }, this.checkDeps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tracked.errors += 1;
      this.save(w.id, { ...checkState, _t: tracked }, "error", msg);
      // One or two failed attempts can be a blip; sustained failure means the watch is blind and the user should know.
      if (tracked.errors >= 3 && !tracked.errorNotified) {
        tracked.errorNotified = true;
        this.save(w.id, { ...checkState, _t: tracked }, "error", msg);
        await this.fire(w, "error", "important", `watch cannot run: ${msg}`);
        fired++;
      }
      return { status: "error", fired, error: msg };
    }

    if (tracked.errorNotified) {
      await this.fire(w, "resolved", "info", "watch is working again");
      fired++;
    }
    tracked.errors = 0;
    tracked.errorNotified = false;

    const now = this.now();
    let anyActive = false;
    for (const c of out.conditions) {
      const prev = tracked.conditions[c.key];
      const firstLook = !tracked.seen[c.key];
      tracked.seen[c.key] = true;
      if (c.active) {
        anyActive = true;
        if (!prev) {
          tracked.conditions[c.key] = { since: now, lastFiredAt: now, summary: c.summary };
          if (!c.notifyOnClear) {
            await this.fire(w, "triggered", c.severity, c.summary, c.detail);
            fired++;
          }
        } else if (w.repeatMin && now - prev.lastFiredAt >= w.repeatMin * 60_000) {
          prev.lastFiredAt = now;
          prev.summary = c.summary;
          await this.fire(w, "triggered", c.severity, `still: ${c.summary}`, c.detail);
          fired++;
        } else {
          prev.summary = c.summary;
        }
      } else if (prev) {
        delete tracked.conditions[c.key];
        if (c.notifyOnClear) {
          await this.fire(w, "resolved", c.notifyOnClear.severity, c.okSummary);
          fired++;
        } else if (w.notifyOnResolve) {
          await this.fire(w, "resolved", "info", c.okSummary);
          fired++;
        }
      } else if (firstLook && c.notifyOnClear) {
        await this.fire(w, "resolved", c.notifyOnClear.severity, c.okSummary);
        fired++;
      }
    }

    fired += await this.fireMatches(w, out.matches);
    this.save(w.id, { ...out.state, _t: tracked }, anyActive ? "triggered" : "ok", null);
    return { status: anyActive ? "triggered" : "ok", fired };
  }

  /** Highest severity first so a flood of low-value lines can't push a critical one past the cap. */
  private async fireMatches(w: Watch, matches: Match[]): Promise<number> {
    if (matches.length === 0) return 0;
    const sorted = [...matches].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    let fired = 0;
    let overflow = 0;
    let overflowSeverity: Severity = "info";
    for (const m of sorted) {
      const key = `${w.id}|${m.summary.toLowerCase().replace(/\d+/g, "#").slice(0, 160)}`;
      const seen = this.recent.get(key);
      const at = this.now();
      if (seen && at - seen.at < this.dedupeMs) { seen.suppressed++; continue; }
      if (fired >= MAX_MATCH_EVENTS_PER_CHECK) {
        overflow++;
        if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[overflowSeverity]) overflowSeverity = m.severity;
        continue;
      }
      const extra = seen && seen.suppressed > 0 ? ` (+${seen.suppressed} similar earlier)` : "";
      this.recent.set(key, { at, suppressed: 0 });
      await this.fire(w, "match", m.severity, m.summary + extra, m.detail);
      fired++;
    }
    if (overflow > 0) {
      await this.fire(w, "match", overflowSeverity, `${overflow} more matching lines in the same check (not listed individually)`);
      fired++;
    }
    return fired;
  }

  private async onSessionEvent(e: SessionEvent): Promise<void> {
    const watches = this.list().filter((w) =>
      w.enabled && w.type === "session" &&
      (!w.config.sessionId || w.config.sessionId === e.session.id || w.config.sessionId === e.session.providerSessionId));
    const where = e.session.projectPath ? ` (${basename(e.session.projectPath)})` : "";
    for (const w of watches) {
      try {
        if (e.kind === "finished" && w.config.notifyOnFinish && e.durationSec >= (w.config.minDurationSec ?? 0)) {
          await this.fire(w, "match", w.config.finishSeverity,
            `${cap(e.session.provider)} finished "${e.session.title}"${where} after ${humanSeconds(e.durationSec)}`,
            e.resultText?.slice(0, 800), e.session.id);
        } else if (e.kind === "failed" && w.config.notifyOnError) {
          await this.fire(w, "match", w.config.errorSeverity,
            `${cap(e.session.provider)} task "${e.session.title}"${where} failed after ${humanSeconds(e.durationSec)}`,
            e.reason?.slice(0, 800), e.session.id);
        } else if (e.kind === "needs_input" && w.config.notifyOnNeedsInput) {
          await this.fire(w, "match", w.config.needsInputSeverity,
            `${cap(e.session.provider)} needs you: "${e.session.title}"${where}`, e.message?.slice(0, 400), e.session.id);
        }
      } catch (err) {
        this.d.log?.error({ err, watchId: w.id }, "session watch notification failed");
      }
    }
  }

  /* ---------------- firing ---------------- */

  private async fire(w: Watch, kind: WatchEvent["kind"], severity: Severity, summary: string, detail?: string, sessionOverride?: string): Promise<void> {
    const event: WatchEvent = {
      id: randomUUID(), watchId: w.id, ts: new Date(this.now()).toISOString(), kind, severity, summary, detail,
    };
    this.d.db.prepare("INSERT INTO watch_events (id, watch_id, ts, kind, severity, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, w.id, event.ts, kind, severity, summary, detail ?? null);
    this.d.db.prepare("UPDATE watches SET last_event_at = ? WHERE id = ?").run(event.ts, w.id);

    const sessionId = sessionOverride ?? w.sessionId;
    const payload = { watch: { id: w.id, name: w.name, type: w.type, sessionId }, event: { id: event.id, kind, severity, summary, detail, ts: event.ts } };
    this.d.bus.publish(kind === "resolved" ? { type: "watch.resolved", ...payload } : { type: "watch.triggered", ...payload });

    try {
      await this.d.escalation.notify({
        severity, title: `${w.name}: ${summary}`, body: detail ?? "", sessionId: this.d.sessionExists(sessionId ?? "") ? sessionId : undefined,
        dedupeKey: w.id, eventId: event.id,
      });
    } catch (err) {
      this.d.log?.error({ err, watchId: w.id }, "escalation failed");
    }

    if (kind !== "resolved" && SEVERITY_RANK[severity] >= SEVERITY_RANK.important) this.wakeAgent(w, event);
  }

  /** The only place a watch can spend model tokens, and only when asked to, at most once per cooldown. */
  private wakeAgent(w: Watch, event: WatchEvent): void {
    if (!w.wake || !this.d.wake) return;
    const last = this.lastWake.get(w.id);
    const now = this.now();
    if (last !== undefined && now - last < w.wake.cooldownMin * 60_000) return;
    const prompt = [
      `[Helix watcher "${w.name}" fired (${event.severity})]`,
      event.summary,
      event.detail ? `\nContext:\n${event.detail}` : "",
      `\n${w.wake.instruction ?? "Look into what happened using your tools and tell me concisely what is wrong and what you recommend. Do not take destructive actions without asking."}`,
    ].join("\n");
    if (this.d.wake(w.wake.sessionId, prompt)) this.lastWake.set(w.id, now);
  }

  /* ---------------- helpers ---------------- */

  private save(id: string, state: Record<string, any>, status: Watch["lastStatus"], error: string | null): void {
    this.d.db.prepare("UPDATE watches SET state = ?, last_checked_at = ?, last_status = ?, last_error = ? WHERE id = ?")
      .run(JSON.stringify(state), new Date(this.now()).toISOString(), status ?? null, error, id);
  }

  private mustGet(id: string): Watch {
    const w = this.get(id);
    if (!w) throw new Error(`watch ${id} missing`);
    return w;
  }

  private validate(type: Watch["type"], config: Record<string, any>): void {
    if (type === "command") {
      // A watch command runs unattended on a timer, so there is no human to approve it: refuse anything destructive up front.
      const c = classify({ tool: "run_command", input: { command: config.command } });
      if (c.destructive) throw new GatewayError(400, `watch commands must not be destructive or opaque (${c.reasons.join("; ")})`);
      if (config.expectStdoutRegex) this.compile(config.expectStdoutRegex);
    }
    if (type === "log") for (const p of config.patterns as { regex: string }[]) this.compile(p.regex);
  }

  private compile(regex: string): void {
    try { new RegExp(regex, "i"); } catch (e) { throw new GatewayError(400, `invalid regex /${regex}/: ${(e as Error).message}`); }
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const humanSeconds = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);

export type { Condition };
