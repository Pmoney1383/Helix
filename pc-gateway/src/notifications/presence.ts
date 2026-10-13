import type { Db } from "../storage/sqlite.js";

export type PresenceMode = "auto" | "away" | "home";

export interface PresenceStatus {
  mode: PresenceMode;
  /** The answer the notification policy uses. */
  away: boolean;
  /** Why: shown in the app so the behaviour is never mysterious. */
  reason: string;
  idleSec?: number;
  reporterActive: boolean;
  awayAfterMin: number;
}

const KEY = "presence_mode";
/** The helper reports every ~15 s; a longer silence means it is not running. */
const REPORTER_STALE_MS = 90_000;

/**
 * Is the user at the PC? Decides whether phone alerts (push, calls) are worth sending.
 *
 *  - "away":  always notify (the manual "I'm out" switch).
 *  - "home":  never push or ring; messages still land in the app.
 *  - "auto":  notify when the keyboard and mouse have been idle for `awayAfterMin`.
 *
 * Idle time is reported by a small helper running in the user's own desktop session, because the
 * gateway runs as a Windows service and cannot see the user's input. If that helper is not running we
 * cannot know, and not knowing means "away": a missed alert is worse than an unneeded buzz.
 */
export class PresenceService {
  private idleSec?: number;
  private reportedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly opts: { awayAfterMin?: number; now?: () => number } = {}
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get awayAfterMin(): number {
    return this.opts.awayAfterMin ?? 5;
  }

  mode(): PresenceMode {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return row?.value === "away" || row?.value === "home" ? row.value : "auto";
  }

  setMode(mode: PresenceMode): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, mode);
  }

  /** Called by the desktop helper with the seconds since the last keyboard/mouse input. */
  reportIdle(idleSec: number): void {
    this.idleSec = Math.max(0, Math.round(idleSec));
    this.reportedAt = this.now();
  }

  isAway(): boolean {
    return this.status().away;
  }

  status(): PresenceStatus {
    const mode = this.mode();
    const reporterActive = this.reportedAt > 0 && this.now() - this.reportedAt < REPORTER_STALE_MS;
    const base = { mode, reporterActive, idleSec: reporterActive ? this.idleSec : undefined, awayAfterMin: this.awayAfterMin };
    if (mode === "away") return { ...base, away: true, reason: "set to away" };
    if (mode === "home") return { ...base, away: false, reason: "set to home: alerts stay in the app" };
    if (!reporterActive) return { ...base, away: true, reason: "no desktop helper reporting, assuming you are away" };
    const idleMin = (this.idleSec ?? 0) / 60;
    return idleMin >= this.awayAfterMin
      ? { ...base, away: true, reason: `idle for ${Math.floor(idleMin)} min` }
      : { ...base, away: false, reason: "you are at the PC" };
  }
}
