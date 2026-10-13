import type { ProviderName } from "../types.js";

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "final"; text: string; costUsd?: number; usage?: { input: number; cacheRead: number; cacheWrite: number; output: number; model?: string } }
  | { type: "error"; message: string };

/** A decision the agent needs before it acts, described in the terms Helix's destructive-action policy understands. */
export interface ApprovalAsk {
  /** "shell", "apply_patch", "delete_file", "permissions", ... (see permissions/classifier.ts). */
  tool: string;
  input: Record<string, unknown>;
}

/**
 * How a router (the General Claude / Astra) is wired up when the agent is configured per thread rather than
 * per turn (Codex): its own MCP server entry with a router-scoped credential, and the router's instructions.
 */
export interface RoutingSetup {
  mcp: { url: string; token: string };
  instructions: string;
}

export interface SendOptions {
  providerSessionId: string;
  /**
   * First turn of a fork: continue from this provider session but write to `providerSessionId` as a new
   * branch, leaving the original untouched (it may still be open in a terminal).
   */
  forkFrom?: string;
  /**
   * For agents that ask the client for approval over their own protocol (Codex): decide whether this may proceed.
   * Claude does not need it; its prompts reach the gateway through MCP instead.
   */
  approve?: (ask: ApprovalAsk) => Promise<{ allow: boolean; reason?: string }>;
  /** Gateway session ID, for providers that need to correlate callbacks. */
  sessionId?: string;
  projectPath?: string;
  /**
   * Style instruction for a reply that will be spoken (Helix's voice personality). Wording only: providers must
   * apply it without letting it change behaviour. Claude: appended to the system prompt. Codex: a note ahead of the message.
   */
  voiceStyle?: string;
  /** Extra instructions appended to the agent's system prompt (used by the router). */
  appendSystemPrompt?: string;
  /** Run with no built-in tools (shell, editor, ...) and only the gateway's MCP server (used by the router). */
  routingOnly?: boolean;
  /** When set, the agent connects back to the gateway's MCP endpoint and routes permission prompts through it. */
  mcp?: { url: string; token: string };
  text: string;
  /** false on the very first turn of a new session, true afterwards or for imported sessions. */
  resume: boolean;
  /** Aborting must stop the underlying agent process. */
  signal: AbortSignal;
}

/**
 * Designed for a per-turn execution model: there is no
 * long-lived agent process between turns, so start/resume collapse into
 * "allocate an ID" + send(resume), and interrupt is an AbortSignal.
 */
export interface AgentProvider {
  readonly name: ProviderName;
  createSession(opts?: { projectPath?: string; routing?: RoutingSetup }): Promise<{ providerSessionId: string }>;
  /**
   * Branch an existing session right now, for providers that cannot defer the fork to the first turn
   * (Claude can, via flags; Codex needs the new thread's id up front).
   */
  forkSession?(fromProviderSessionId: string, opts: { projectPath?: string }): Promise<{ providerSessionId: string }>;
  /** Release anything long-lived (child processes) when the gateway shuts down. */
  close?(): void;
  send(options: SendOptions): AsyncIterable<AgentEvent>;
}
