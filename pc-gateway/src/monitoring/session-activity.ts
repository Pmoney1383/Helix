import type { ApprovalService } from "../permissions/approvals.js";
import type { EventBus } from "../sessions/manager.js";
import type { AgentSession, GatewayEvent } from "../types.js";

export interface RunningTurn {
  sessionId: string;
  title: string;
  provider: string;
  startedAt: number;
  lastActivityAt: number;
}

/** Enough about a session to describe it in a notification, wherever it is running. */
export interface SessionRef {
  /** Helix session id when Helix manages it, otherwise "<provider>:<providerSessionId>". */
  id: string;
  providerSessionId: string;
  provider: string;
  title: string;
  projectPath?: string;
  /** Not run by Helix (a terminal or IDE session). */
  external: boolean;
}

export type SessionEvent =
  | { kind: "finished"; session: SessionRef; durationSec: number; resultText?: string }
  | { kind: "failed"; session: SessionRef; durationSec: number; reason?: string }
  | { kind: "needs_input"; session: SessionRef; message?: string };

const refOf = (s: AgentSession): SessionRef => ({
  id: s.id, providerSessionId: s.providerSessionId, provider: s.provider, title: s.title, projectPath: s.projectPath, external: false,
});

/**
 * Tracks what agent sessions are doing and announces turns ending. Two sources, one stream:
 *  - sessions Helix runs: from the event bus (no polling, no model);
 *  - sessions running anywhere else on the PC: pushed in by the indexer (live-status changes) and by hooks.
 * Provider-agnostic: Claude today, Codex through the same events later.
 */
export class SessionActivity {
  private readonly turns = new Map<string, RunningTurn>();
  private readonly finalText = new Map<string, string>();
  private readonly lastSystemText = new Map<string, string>();
  private readonly recentExternal = new Map<string, number>();
  private listeners: ((e: SessionEvent) => void)[] = [];
  private externalRunning: () => RunningTurn[] = () => [];

  constructor(
    bus: EventBus,
    private readonly approvals: ApprovalService,
    private readonly now: () => number = () => Date.now()
  ) {
    bus.subscribe((e) => this.onEvent(e));
  }

  onSessionEvent(fn: (e: SessionEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Where to find mid-turn sessions Helix does not run (the indexer). */
  setExternalRunning(fn: () => RunningTurn[]): void {
    this.externalRunning = fn;
  }

  running(): RunningTurn[] {
    return [...this.turns.values(), ...this.externalRunning()];
  }

  /**
   * An event about a session Helix does not run. The same turn can be reported twice (live-status
   * transition and a hook); the second report within a short window is dropped.
   */
  emitExternal(e: SessionEvent): void {
    const key = `${e.kind}:${e.session.providerSessionId}`;
    const at = this.now();
    const last = this.recentExternal.get(key);
    if (last !== undefined && at - last < 15_000) return;
    this.recentExternal.set(key, at);
    for (const [k, t] of this.recentExternal) if (at - t > 60_000) this.recentExternal.delete(k);
    this.emit(e);
  }

  /** Pending approvals older than `olderThanMs`, optionally for one session. */
  oldPendingApprovals(olderThanMs: number, sessionId?: string) {
    const cutoff = this.now() - olderThanMs;
    return this.approvals.list("pending").filter((a) =>
      new Date(a.createdAt).getTime() <= cutoff && (!sessionId || a.sessionId === sessionId));
  }

  private onEvent(e: GatewayEvent): void {
    const now = this.now();
    switch (e.type) {
      case "session.state": {
        const s = e.session;
        const open = this.turns.get(s.id);
        if (s.status === "running" && !open) {
          this.turns.set(s.id, { sessionId: s.id, title: s.title, provider: s.provider, startedAt: now, lastActivityAt: now });
          this.finalText.delete(s.id);
          this.lastSystemText.delete(s.id);
        } else if (s.status !== "running" && open) {
          this.turns.delete(s.id);
          const durationSec = Math.round((now - open.startedAt) / 1000);
          const result = this.finalText.get(s.id);
          const reason = this.lastSystemText.get(s.id);
          this.finalText.delete(s.id);
          this.lastSystemText.delete(s.id);
          if (s.status === "error") this.emit({ kind: "failed", session: refOf(s), durationSec, reason });
          else if (result !== undefined) this.emit({ kind: "finished", session: refOf(s), durationSec, resultText: result });
          // idle without a final answer means the turn was interrupted: not a result worth announcing.
        }
        break;
      }
      case "agent.output.delta":
      case "agent.tool": {
        const t = this.turns.get(e.sessionId);
        if (t) t.lastActivityAt = now;
        break;
      }
      case "agent.output.final":
        this.finalText.set(e.sessionId, e.text);
        break;
      case "message.created": {
        // Failure reasons arrive as system messages just before the session flips to error.
        const m = e.message;
        if (m.sessionId && m.sender === "system" && m.type === "status") this.lastSystemText.set(m.sessionId, m.text);
        break;
      }
      default:
        break;
    }
  }

  private emit(e: SessionEvent): void {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* a listener must not break tracking */ }
    }
  }
}
