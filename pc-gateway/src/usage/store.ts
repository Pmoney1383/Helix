import type Database from "better-sqlite3";

export interface TurnUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd?: number;
  model?: string;
}

/** What each turn Helix ran actually consumed, so a drain can be seen and attributed instead of guessed. */
export class UsageStore {
  constructor(private readonly db: Database.Database) {}

  record(sessionId: string, provider: string, u: TurnUsage): void {
    this.db.prepare(
      `INSERT INTO turn_usage (session_id, provider, model, input, cache_read, cache_write, output, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, provider, u.model ?? null, u.input, u.cacheRead, u.cacheWrite, u.output, u.costUsd ?? null, new Date().toISOString());
  }

  /** Totals per session over the last `hours`, biggest first. */
  summary(hours: number): { sessionId: string; turns: number; cacheWrite: number; cacheRead: number; output: number; costUsd: number }[] {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return this.db.prepare(
      `SELECT session_id AS sessionId, COUNT(*) AS turns, SUM(cache_write) AS cacheWrite, SUM(cache_read) AS cacheRead,
              SUM(output) AS output, COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM turn_usage WHERE created_at >= ? GROUP BY session_id ORDER BY cacheWrite DESC LIMIT 50`
    ).all(since) as any;
  }
}
