import path from "node:path";
import type { Escalation } from "../notifications/escalation.js";
import type { PresenceService } from "../notifications/presence.js";
import { classify, describeAction } from "../permissions/classifier.js";
import type { ApprovalService } from "../permissions/approvals.js";
import type { SessionActivity, SessionRef } from "../monitoring/session-activity.js";
import type { SessionRegistry } from "../sessions/registry.js";
import type { Db } from "../storage/sqlite.js";
import type { SessionIndexer } from "./indexer.js";

export interface AgentEventInput {
  provider: "claude" | "codex";
  event: string;
  payload: Record<string, unknown>;
}

export interface IngestResult { accepted: boolean; outcome: string }

export interface PermissionInput { provider: "claude" | "codex"; payload: Record<string, unknown>; signal?: AbortSignal }
export interface PermissionDecision {
  /** "none" = Helix has no opinion; the agent proceeds exactly as it would have without Helix. */
  decision: "allow" | "deny" | "none";
  reason?: string;
  approvalId?: string;
}

/** What the permission gate needs; absent when approvals are not wired (then it never has an opinion). */
export interface PermissionGate {
  approvals: ApprovalService;
  presence: PresenceService;
  escalation: Escalation;
}

const KEEP_ROWS = 1000;

/**
 * Receives what the Claude Code hooks report (a turn ended, Claude needs permission or input) from
 * sessions running in a terminal or IDE, and turns it into the same events Helix's own sessions produce.
 * This is the part that works even when the model never mentions Helix.
 */
export class AgentEvents {
  constructor(
    private readonly db: Db,
    private readonly activity: SessionActivity,
    private readonly registry: SessionRegistry,
    private readonly indexer?: SessionIndexer,
    private readonly gate?: PermissionGate,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Terminal and IDE sessions often run with permission prompts off, so nothing stops a destructive command.
   * While the user is away, such a command waits here for approval from their phone. At the PC, or for anything
   * that is not destructive, or for sessions Helix runs itself (they have their own gate), Helix stays out of the way.
   * Fails open: if this is unreachable the agent just carries on, because Helix must never be able to block work.
   */
  async checkPermission(input: PermissionInput): Promise<PermissionDecision> {
    const p = input.payload ?? {};
    const sid = typeof p.session_id === "string" ? p.session_id.toLowerCase() : undefined;
    const tool = typeof p.tool_name === "string" ? p.tool_name : undefined;
    const toolInput = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
    const cwd = typeof p.cwd === "string" ? p.cwd : undefined;

    const none = (why: string): PermissionDecision => { this.record(input.provider, "pretooluse", sid, cwd, tool, `no opinion: ${why}`); return { decision: "none", reason: why }; };
    if (!this.gate) return none("permission gate not configured");
    if (!sid || !tool) return none("incomplete request");
    if (this.registry.findByProviderId(input.provider, sid)) return none("managed by Helix");
    if (!this.gate.presence.isAway()) return none("you are at the PC");

    const action = { tool, input: toolInput };
    const c = classify(action);
    if (!c.destructive) return none("not destructive");

    const project = cwd ? path.basename(cwd) : undefined;
    const summary = describeAction(action) + (project ? `  [${project}]` : "");
    const { approval, outcome } = this.gate.approvals.request({
      source: "agent", tool, summary, reasons: c.reasons, signal: input.signal,
    });
    // Getting the request to the user (message, push, and a call if it waits) is the approval escalator's job.
    const result = await outcome;
    this.record(input.provider, "pretooluse", sid, cwd, summary, result.approved ? "approved from phone" : `denied (${result.status})`);
    if (result.approved) return { decision: "allow", reason: "Approved by the user from Helix.", approvalId: approval.id };
    const why = result.status === "rejected" ? "The user rejected this action from Helix."
      : result.status === "expired" ? "No one approved this action in time, so it was not run."
      : "The approval request was withdrawn.";
    return { decision: "deny", reason: `${why} Do not retry it; ask the user how to proceed.`, approvalId: approval.id };
  }

  async ingest(input: AgentEventInput): Promise<IngestResult> {
    const event = input.event.toLowerCase();
    const p = input.payload ?? {};
    const sid = typeof p.session_id === "string" ? p.session_id.toLowerCase() : undefined;
    const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
    const message = typeof p.message === "string" ? p.message : undefined;

    const outcome = await this.handle(input.provider, event, sid, cwd, message, typeof p.transcript_path === "string" ? p.transcript_path : undefined);
    this.record(input.provider, event, sid, cwd, message, outcome);
    return { accepted: true, outcome };
  }

  recent(limit = 50) {
    return (this.db.prepare("SELECT * FROM agent_events ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
      ts: r.ts, provider: r.provider, event: r.event, sessionId: r.session_id ?? undefined, cwd: r.cwd ?? undefined,
      message: r.message ?? undefined, outcome: r.outcome ?? undefined,
    }));
  }

  private async handle(provider: "claude" | "codex", event: string, sid?: string, cwd?: string, message?: string, transcript?: string): Promise<string> {
    if (!sid) return "ignored: no session id";
    if (event !== "stop" && event !== "notification") return `ignored: event "${event}" is not used`;

    // Sessions Helix runs already report through the gateway; their own `claude -p` also fires user hooks.
    if (this.registry.findByProviderId(provider, sid)) return "ignored: managed by Helix";

    const info = this.indexer ? await this.indexer.refreshSession(provider, sid, transcript) : undefined;
    const ref: SessionRef = {
      id: info?.helixSessionId ?? `${provider}:${sid}`, providerSessionId: sid, provider,
      title: info?.title ?? (cwd ? path.basename(cwd) : "session"), projectPath: info?.projectPath ?? cwd, external: true,
    };

    if (event === "stop") {
      const startedAt = info?.lastUserAt ? Date.parse(info.lastUserAt) : NaN;
      const durationSec = Number.isFinite(startedAt) ? Math.max(0, Math.round((this.now() - startedAt) / 1000)) : 0;
      this.activity.emitExternal({ kind: "finished", session: ref, durationSec, resultText: info?.lastAssistant });
      return `finished after ${durationSec}s`;
    }
    if (!message?.trim()) return "ignored: empty notification";
    this.activity.emitExternal({ kind: "needs_input", session: ref, message });
    return "needs input";
  }

  private record(provider: string, event: string, sid: string | undefined, cwd: string | undefined, message: string | undefined, outcome: string): void {
    this.db.prepare("INSERT INTO agent_events (ts, provider, event, session_id, cwd, message, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(new Date(this.now()).toISOString(), provider, event, sid ?? null, cwd ?? null, message?.slice(0, 500) ?? null, outcome);
    this.db.prepare("DELETE FROM agent_events WHERE id <= (SELECT MAX(id) FROM agent_events) - ?").run(KEEP_ROWS);
  }
}
