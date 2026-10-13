import { randomUUID } from "node:crypto";
import type { Db } from "../storage/sqlite.js";
import type { Approval, ApprovalStatus } from "../types.js";
import type { EventBus } from "../sessions/manager.js";
import type { MessageStore } from "../sessions/registry.js";

interface Row {
  id: string; session_id: string | null; source: Approval["source"]; tool: string; summary: string;
  reasons: string; status: ApprovalStatus; created_at: string; expires_at: string;
  resolved_at: string | null; resolved_by: string | null; note: string | null;
}

const toApproval = (r: Row): Approval => ({
  id: r.id,
  sessionId: r.session_id ?? undefined,
  source: r.source,
  tool: r.tool,
  summary: r.summary,
  reasons: JSON.parse(r.reasons) as string[],
  status: r.status,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  resolvedAt: r.resolved_at ?? undefined,
  resolvedBy: r.resolved_by ?? undefined,
  note: r.note ?? undefined,
});

export interface ApprovalRequest {
  sessionId?: string;
  source: Approval["source"];
  tool: string;
  summary: string;
  reasons?: string[];
  /** Aborting (agent turn interrupted, MCP call cancelled) withdraws the request. */
  signal?: AbortSignal;
}

export interface ApprovalOutcome {
  approved: boolean;
  status: ApprovalStatus;
  note?: string;
}

interface Waiter {
  resolve: (o: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Human approval for destructive actions. A request blocks the caller (the agent) until the phone
 * approves or rejects, it expires, or the caller goes away. Each ID can be resolved exactly once;
 * a replayed approve/reject on a settled ID is a no-op that reports the settled state.
 * Anything not approved counts as a rejection, so expiry and crashes fail closed.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly messages: MessageStore,
    private readonly ttlMs = 30 * 60 * 1000
  ) {
    // Whatever was pending when the gateway died can never be answered: the agent process is gone.
    this.db
      .prepare("UPDATE approvals SET status = 'expired', resolved_at = ?, note = 'gateway restarted' WHERE status = 'pending'")
      .run(new Date().toISOString());
  }

  request(req: ApprovalRequest): { approval: Approval; outcome: Promise<ApprovalOutcome> } {
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, source, tool, summary, reasons, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(id, req.sessionId ?? null, req.source, req.tool, req.summary, JSON.stringify(req.reasons ?? []), now.toISOString(), expiresAt);
    const approval = this.mustGet(id);

    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(id, "expired", undefined, "no response before expiry"), this.ttlMs);
      timer.unref(); // a pending approval must not keep the process alive on shutdown
      this.waiters.set(id, { resolve, timer });
      if (req.signal) {
        const onAbort = () => this.settle(id, "cancelled", undefined, "request withdrawn");
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    this.bus.publish({ type: "approval.requested", approval });
    if (req.sessionId) {
      const m = this.messages.add({
        conversationId: req.sessionId, sessionId: req.sessionId, sender: "system", type: "approval", severity: "important",
        text: `Approval needed: ${req.summary}`, metadata: { approvalId: id },
      });
      this.bus.publish({ type: "message.created", message: m });
    }
    return { approval, outcome };
  }

  /** Called from the phone. Returns the approval's final state, or undefined if the ID is unknown. */
  resolve(id: string, approve: boolean, deviceId?: string, note?: string): Approval | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    if (current.status !== "pending") return current; // replay or late answer: report, don't change
    if (new Date(current.expiresAt).getTime() <= Date.now()) return this.settle(id, "expired", deviceId, "expired") ?? this.get(id);
    return this.settle(id, approve ? "approved" : "rejected", deviceId, note) ?? this.get(id);
  }

  get(id: string): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return r && toApproval(r);
  }

  list(status?: ApprovalStatus, limit = 100): Approval[] {
    const rows = status
      ? (this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) as Row[])
      : (this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]);
    return rows.map(toApproval);
  }

  private mustGet(id: string): Approval {
    const a = this.get(id);
    if (!a) throw new Error(`approval ${id} missing`);
    return a;
  }

  /** Atomic pending -> final transition. Only the first caller wins. */
  private settle(id: string, status: Exclude<ApprovalStatus, "pending">, by?: string, note?: string): Approval | undefined {
    const changed = this.db
      .prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, note = ? WHERE id = ? AND status = 'pending'")
      .run(status, new Date().toISOString(), by ?? null, note ?? null, id).changes;
    if (changed !== 1) return undefined;

    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({ approved: status === "approved", status, note });
    }
    const approval = this.mustGet(id);
    this.bus.publish({ type: "approval.resolved", approval });
    return approval;
  }
}
