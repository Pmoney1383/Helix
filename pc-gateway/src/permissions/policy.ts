import type { Action } from "./classifier.js";
import { classify, describeAction } from "./classifier.js";
import type { ApprovalService } from "./approvals.js";

export interface AuthorizeContext {
  sessionId?: string;
  source: "agent" | "tool";
  signal?: AbortSignal;
}

export interface Decision {
  allowed: boolean;
  /** Why, in words an agent can relay to the user. */
  message: string;
  approvalId?: string;
}

/** Tools the gateway itself exposes. They enforce the policy internally, so the agent gate waves them through. */
const SELF_GATING_PREFIX = "mcp__helix__";

/**
 * The one rule: normal actions proceed without asking; destructive ones wait for a human.
 * Used by the Claude permission gate and by the control tools (run_command etc.), so a hosted
 * ChatGPT/Claude client gets the same protection as a local agent.
 */
export class PolicyEngine {
  constructor(private readonly approvals: ApprovalService) {}

  async authorize(action: Action, ctx: AuthorizeContext): Promise<Decision> {
    if (ctx.source === "agent" && action.tool.startsWith(SELF_GATING_PREFIX)) {
      return { allowed: true, message: "gateway tool; gated internally" };
    }
    const c = classify(action);
    if (!c.destructive) return { allowed: true, message: "allowed" };

    const { approval, outcome } = this.approvals.request({
      sessionId: ctx.sessionId,
      source: ctx.source,
      tool: action.tool,
      summary: describeAction(action),
      reasons: c.reasons,
      signal: ctx.signal,
    });
    const result = await outcome;
    if (result.approved) return { allowed: true, message: "approved by the user", approvalId: approval.id };

    const why =
      result.status === "rejected" ? "The user rejected this action."
      : result.status === "expired" ? "No one approved this action in time, so it was not run."
      : "The approval request was withdrawn.";
    return { allowed: false, message: `${why}${result.note ? ` Note: ${result.note}` : ""} Do not retry it; ask the user how to proceed.`, approvalId: approval.id };
  }
}
