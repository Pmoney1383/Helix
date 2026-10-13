import { randomBytes } from "node:crypto";

export type Scope = "pc.hosted" | "pc.observe" | "pc.control" | "pc.agent.full" | "pc.agent.local" | "pc.router";

const OBSERVE = [
  "get_pc_status", "get_gpu_status", "list_processes", "get_process_status", "list_directory", "read_file", "tail_file",
  "git_status", "git_log", "get_service_status", "get_training_status", "list_agent_sessions", "send_user_message", "list_status_watches",
] as const;
/** Hosted ChatGPT/Claude: look around, and run small commands that pass the hosted safety rules (permissions/hosted-safety.ts). */
const HOSTED_EXEC = ["run_safe_command"] as const;
/** Open or politely close desktop apps by name (mcp/app-tools.ts). Narrow by construction, so hosted chats get them too. */
const APPS = ["list_apps", "open_app", "close_app"] as const;
/** Talk to the agents on this machine from a hosted chat: send them a message, read how the conversation is going. */
const AGENT_CHAT = ["send_agent_message", "read_agent_session", "search_agent_sessions"] as const;
const CONTROL = ["run_command", "write_file", "stop_process", "create_status_watch", "watch_job", "remove_status_watch"] as const;
const AGENT_ONLY = ["request_user_approval", "permission_prompt", "end_call"] as const;
/** The General Claude (router) can find sessions and connect the user to one, and nothing else. */
const ROUTER = [
  "search_agent_sessions", "get_session_summary", "list_projects", "start_agent_session",
  "resume_agent_session", "handoff_current_conversation", "list_status_watches", "end_call",
] as const;
/** Reaching the user is available to every agent scope (terminal agents included). */
const NOTIFY = ["notify_user"] as const;
/**
 * Terminal/IDE agents already have their own shell and editor, so Helix gives them only what they lack:
 * a way to watch long work and to reach the user. No raw command execution, no file writes.
 */
const LOCAL_AGENT = [
  "list_status_watches", "create_status_watch", "watch_job", "remove_status_watch",
  "notify_user", "request_user_approval", "list_agent_sessions", "end_call",
] as const;

export type ToolName =
  | (typeof OBSERVE)[number] | (typeof CONTROL)[number] | (typeof AGENT_ONLY)[number] | (typeof NOTIFY)[number] | (typeof LOCAL_AGENT)[number]
  | (typeof ROUTER)[number] | (typeof HOSTED_EXEC)[number] | (typeof APPS)[number] | (typeof AGENT_CHAT)[number];

const SCOPE_TOOLS: Record<Scope, ReadonlySet<string>> = {
  "pc.observe": new Set(OBSERVE),
  "pc.hosted": new Set([...OBSERVE, ...HOSTED_EXEC, ...APPS, ...AGENT_CHAT, ...NOTIFY]),
  "pc.control": new Set([...OBSERVE, ...CONTROL, ...APPS, ...NOTIFY, ...AGENT_CHAT]),
  "pc.agent.full": new Set([...OBSERVE, ...CONTROL, ...APPS, ...AGENT_ONLY, ...NOTIFY]),
  "pc.agent.local": new Set(LOCAL_AGENT),
  "pc.router": new Set(ROUTER),
};

export const scopeAllows = (scope: Scope, tool: ToolName): boolean => SCOPE_TOOLS[scope].has(tool);

export interface McpContext {
  scope: Scope;
  /** Explicit per-credential/client desktop grant; never implied by a legacy MCP scope. */
  desktopAllowed?: boolean;
  desktopIdentity?: string;
  /** Gateway session this connection belongs to (agent connections only). */
  sessionId?: string;
  /** Recorded in the audit log. */
  actor: string;
}

/**
 * Short-lived credentials for the Claude process the gateway itself spawns. One per turn,
 * bound to that session, revoked when the turn ends. They never leave the loopback interface.
 */
export class AgentTokens {
  private readonly tokens = new Map<string, McpContext>();

  issue(ctx: McpContext): string {
    const token = "hxa_" + randomBytes(24).toString("base64url");
    this.tokens.set(token, ctx);
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  lookup(token: string | undefined): McpContext | undefined {
    return token ? this.tokens.get(token) : undefined;
  }
}
