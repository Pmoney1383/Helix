import type { EventBus } from "../sessions/manager.js";
import type { Approval } from "../types.js";
import type { Escalation } from "./escalation.js";

export interface ApprovalEscalatorOptions {
  /** If nobody has answered after this long, escalate from a push to a phone call. */
  callAfterMs?: number;
}

/**
 * Gets approval requests to the user wherever they are, in two steps:
 *   1. immediately: an in-app message (when the approval has no conversation of its own) and a push;
 *   2. if still unanswered after `callAfterMs`: a phone call that asks for a spoken approve/reject.
 * Both steps go through the escalation policy, so presence (at the PC = stay quiet), the per-problem call
 * cooldown and the hourly call cap all still apply.
 */
export class ApprovalEscalator {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(bus: EventBus, private readonly escalation: Escalation, private readonly opts: ApprovalEscalatorOptions = {}) {
    bus.subscribe((e) => {
      if (e.type === "approval.requested") this.requested(e.approval);
      else if (e.type === "approval.resolved") this.clear(e.approval.id);
    });
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private requested(a: Approval): void {
    const project = /\[([^\]]+)\]\s*$/.exec(a.summary)?.[1];
    const title = `Approval needed${project ? ` [${project}]` : ""}`;
    const base = { title, body: a.summary, sessionId: a.sessionId, approvalId: a.id, kind: "approval" as const };

    // An approval inside a Helix conversation already posted its own message; one from a terminal session did not.
    void this.escalation.notify({ ...base, severity: "important", dedupeKey: `approval:${a.id}` }, { skip: a.sessionId ? ["message"] : [] }).catch(() => undefined);

    const after = this.opts.callAfterMs ?? 5 * 60_000;
    if (after <= 0) return;
    const t = setTimeout(() => {
      this.timers.delete(a.id);
      void this.escalation.notify({ ...base, severity: "critical", dedupeKey: `approval-call:${a.id}` }, { skip: ["message", "push"] }).catch(() => undefined);
    }, after);
    t.unref();
    this.timers.set(a.id, t);
  }

  private clear(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }
}
