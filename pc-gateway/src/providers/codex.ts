import { CodexAppServer, type CodexServerOptions, type RpcNotification, type RpcServerRequest } from "./codex-rpc.js";
import type { AgentEvent, AgentProvider, ApprovalAsk, RoutingSetup, SendOptions } from "./provider.js";

/** Name of the MCP server entry a Codex router talks to (tools appear to Codex as mcp__helix_router__<tool>). */
export const ROUTER_MCP_SERVER = "helix_router";

export interface CodexProviderOptions {
  /** Starts the app-server. Defaults to `codex app-server --stdio`. */
  server: CodexServerOptions;
  /**
   * What Codex may do without asking. "untrusted" asks about anything that is not a known-safe command,
   * which is what lets Helix's approval gate see destructive commands; the sandbox still confines the rest.
   */
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  model?: string;
}

/** A small async queue so notifications can be consumed with `for await`. */
class Queue<T> {
  private items: T[] = [];
  private waiter?: (v: T) => void;
  push(v: T): void {
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(v); } else this.items.push(v);
  }
  next(): Promise<T> {
    const v = this.items.shift();
    return v !== undefined ? Promise.resolve(v) : new Promise<T>((r) => { this.waiter = r; });
  }
}

const isDelete = (kind: unknown): boolean =>
  kind === "delete" || (typeof kind === "object" && kind !== null && (kind as { type?: string }).type === "delete");

/**
 * Codex through its app-server protocol. Compared with shelling out per turn, the app-server gives
 * structured streaming, interrupts, and the one thing that matters most here: approval requests as
 * calls we answer, so Codex's destructive actions go through the same Helix gate as Claude's.
 *
 * One app-server child serves every Codex session; threads are the unit of routing. Sessions are
 * ordinary Codex threads, stored in ~/.codex like any other, so they also show up in the Codex app.
 */
export class CodexProvider implements AgentProvider {
  readonly name = "codex" as const;
  private readonly server: CodexAppServer;
  /** Threads this server process already has loaded (resuming one that was only just created would fail). */
  private loaded = new Set<string>();

  constructor(private readonly opts: CodexProviderOptions) {
    this.server = new CodexAppServer(opts.server);
  }

  private async ready(): Promise<CodexAppServer> {
    if (!this.server.running) this.loaded.clear(); // a restarted server has loaded nothing
    await this.server.ensure();
    return this.server;
  }

  private threadParams(projectPath?: string, routing?: RoutingSetup) {
    return {
      cwd: projectPath ?? null,
      approvalPolicy: this.opts.approvalPolicy ?? "untrusted",
      // A router only talks and routes: whatever the gateway's default sandbox is, it never gets more than read-only.
      sandbox: routing ? "read-only" : this.opts.sandbox ?? "workspace-write",
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(routing ? {
        developerInstructions: routing.instructions,
        // Its own MCP server entry, carrying a credential that only allows the routing tools (scope pc.router).
        config: { mcp_servers: { [ROUTER_MCP_SERVER]: { url: routing.mcp.url, http_headers: { Authorization: `Bearer ${routing.mcp.token}` } } } },
      } : {}),
    };
  }

  async createSession(o: { projectPath?: string; routing?: RoutingSetup } = {}): Promise<{ providerSessionId: string }> {
    const server = await this.ready();
    const r = await server.request("thread/start", this.threadParams(o.projectPath, o.routing));
    this.loaded.add(r.thread.id);
    return { providerSessionId: r.thread.id };
  }

  async forkSession(from: string, o: { projectPath?: string } = {}): Promise<{ providerSessionId: string }> {
    const server = await this.ready();
    const r = await server.request("thread/fork", { threadId: from, ...this.threadParams(o.projectPath) });
    this.loaded.add(r.thread.id);
    return { providerSessionId: r.thread.id };
  }

  close(): void {
    this.server.stop();
  }

  async *send(o: SendOptions): AsyncGenerator<AgentEvent> {
    let server: CodexAppServer;
    try { server = await this.ready(); }
    catch (err) { yield { type: "error", message: err instanceof Error ? err.message : String(err) }; return; }

    const threadId = o.providerSessionId;
    const q = new Queue<RpcNotification>();
    const fileItems = new Map<string, { changes?: { path: string; kind: unknown }[] }>();
    const unsubscribe = server.subscribe(threadId, (n) => {
      // Record what a file change touches as soon as it is announced, not when the loop below gets to it: Codex's request to
      // approve that change can be answered before the loop catches up, and the approval decision depends on this list.
      const it = n.method === "item/started" ? n.params?.item : undefined;
      if (it?.type === "fileChange" && typeof it.id === "string") fileItems.set(it.id, it);
      q.push(n);
    });
    const unsetHandler = server.setHandler(threadId, (req) => this.answer(req, o, fileItems, (text) => q.push({ method: "helix/note", params: { text } })));

    let turnId: string | undefined;
    const interrupt = () => { if (turnId) void server.request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => undefined); };
    const onAbort = () => interrupt();
    o.signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (!this.loaded.has(threadId)) {
        // A router thread that is being loaded again (after a restart) gets a fresh credential and its instructions back.
        const routing = o.routingOnly && o.mcp && o.appendSystemPrompt ? { mcp: o.mcp, instructions: o.appendSystemPrompt } : undefined;
        await server.request("thread/resume", { threadId, ...this.threadParams(o.projectPath, routing) });
        this.loaded.add(threadId);
      }
      // Codex has no per-turn system prompt, so the style rides in front of the message, clearly marked as not the user's.
      const text = o.voiceStyle ? `${o.voiceStyle}\n\nUser's message:\n${o.text}` : o.text;
      const started = await server.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
      turnId = started.turn.id as string;
      if (o.signal.aborted) interrupt();

      let finalText: string | undefined;
      let lastAgentText: string | undefined;
      let failure: string | undefined;

      for (;;) {
        const n = await q.next();
        const p = n.params ?? {};
        if (n.method === "helix/serverExited") { yield { type: "error", message: `codex exited unexpectedly${p.detail ? `: ${p.detail}` : ""}` }; return; }
        if (n.method === "helix/note") { yield { type: "delta", text: String(p.text) }; continue; }
        if (p.turnId && p.turnId !== turnId) continue; // a different turn on the same thread (should not happen, but never mix them)

        switch (n.method) {
          case "item/agentMessage/delta":
            yield { type: "delta", text: String(p.delta) };
            break;
          case "item/started": {
            const it = p.item ?? {};
            if (it.type === "commandExecution") yield { type: "tool", name: "shell" };
            else if (it.type === "fileChange") { fileItems.set(it.id, it); yield { type: "tool", name: "apply_patch" }; }
            else if (it.type === "mcpToolCall") yield { type: "tool", name: `mcp__${it.server}__${it.tool}` };
            else if (it.type === "webSearch") yield { type: "tool", name: "web_search" };
            break;
          }
          case "item/completed": {
            const it = p.item ?? {};
            if (it.type === "agentMessage" && typeof it.text === "string") {
              lastAgentText = it.text;
              if (it.phase === "final_answer") finalText = it.text;
            }
            break;
          }
          case "error":
            if (!p.willRetry) failure = p.error?.message ?? "codex reported an error";
            break;
          case "turn/completed": {
            const turn = p.turn ?? {};
            if (turn.status === "interrupted") return;
            if (turn.status === "failed") { yield { type: "error", message: failure ?? turn.error?.message ?? "the turn failed" }; return; }
            const fromItems = (turn.items ?? []).filter((i: any) => i.type === "agentMessage" && typeof i.text === "string");
            const finalFromItems = fromItems.filter((i: any) => i.phase === "final_answer").pop() ?? fromItems.pop();
            yield { type: "final", text: finalText ?? finalFromItems?.text ?? lastAgentText ?? "" };
            return;
          }
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    } finally {
      o.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      unsetHandler();
    }
  }

  /**
   * A router (Astra) may call its own routing tools and nothing else. Codex cannot be started without its
   * built-in shell and editor, so the guarantee is enforced here: every request except a call to the router's own MCP
   * server is declined, with no prompt to the user, and the sandbox is read-only on top of that.
   */
  private answerRouter(req: RpcServerRequest): unknown {
    const p = req.params ?? {};
    switch (req.method) {
      case "mcpServer/elicitation/request":
        if (p._meta?.codex_approval_kind === "mcp_tool_call" && p.serverName === ROUTER_MCP_SERVER) return { action: "accept", content: {} };
        return { action: "decline" };
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: { fileSystem: null, network: null } };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: { denied: { rejection: "the router only routes" } } };
      case "item/tool/requestUserInput":
        return { answers: {} };
      default:
        throw Object.assign(new Error(`unsupported request ${req.method}`), { code: -32601 });
    }
  }

  /**
   * Codex asks; Helix's policy answers. Normal actions are accepted on the spot; destructive ones wait for the
   * user's approval (see permissions/policy.ts). Anything we do not understand is refused rather than guessed at.
   */
  private async answer(
    req: RpcServerRequest, o: SendOptions,
    fileItems: Map<string, { changes?: { path: string; kind: unknown }[] }>, note: (text: string) => void
  ): Promise<unknown> {
    if (o.routingOnly) return this.answerRouter(req);
    const approve = o.approve ?? (async () => ({ allow: true }));
    const p = req.params ?? {};

    switch (req.method) {
      case "item/commandExecution/requestApproval": {
        const inner = (p.commandActions ?? []).map((a: any) => a?.command).filter(Boolean).join(" ; ");
        const d = await approve({ tool: "shell", input: { command: inner || String(p.command ?? "") } });
        return { decision: d.allow ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const item = fileItems.get(p.itemId);
        const changes = item?.changes ?? [];
        const deletes = changes.filter((c) => isDelete(c.kind));
        // Not knowing what a patch touches must never read as "harmless": ask, as for a delete.
        const d = await approve(!item || !changes.length
          ? { tool: "delete_file", input: { paths: ["(Helix could not see which files this change touches)"] } }
          : deletes.length
          ? { tool: "delete_file", input: { paths: deletes.map((c) => c.path) } }
          : { tool: "apply_patch", input: { paths: changes.map((c) => c.path) } });
        return { decision: d.allow ? "accept" : "decline" };
      }
      case "item/permissions/requestApproval": {
        const d = await approve({ tool: "permissions", input: { permissions: p.permissions, reason: p.reason } });
        return d.allow ? { permissions: p.permissions } : { permissions: { fileSystem: null, network: null } };
      }
      case "execCommandApproval": { // older protocol flavour
        const d = await approve({ tool: "shell", input: { command: Array.isArray(p.command) ? p.command.join(" ") : String(p.command ?? "") } });
        return { decision: d.allow ? "approved" : { denied: { rejection: d.reason ?? "rejected" } } };
      }
      case "applyPatchApproval": {
        const entries = Object.entries(p.fileChanges ?? {}) as [string, { type?: string }][];
        const deletes = entries.filter(([, c]) => c?.type === "delete").map(([path]) => path);
        const d = await approve(!entries.length
          ? { tool: "delete_file", input: { paths: ["(Helix could not see which files this change touches)"] } }
          : deletes.length ? { tool: "delete_file", input: { paths: deletes } } : { tool: "apply_patch", input: { paths: entries.map(([f]) => f) } });
        return { decision: d.allow ? "approved" : { denied: { rejection: d.reason ?? "rejected" } } };
      }
      case "mcpServer/elicitation/request": {
        // Under an approval policy Codex asks before it runs ANY MCP tool. Answering "unsupported" here made every
        // MCP tool call (including Helix's own watch/notify tools) come back as "user rejected MCP tool call".
        if (p._meta?.codex_approval_kind !== "mcp_tool_call") return { action: "cancel" }; // a form asking the user for data: no channel for that yet
        const tool = p._meta?.tool_name ?? /tool "([^"]+)"/.exec(String(p.message ?? ""))?.[1] ?? "unknown";
        const d = await approve({ tool: `mcp__${p.serverName}__${tool}`, input: (p._meta?.tool_params ?? {}) as Record<string, unknown> });
        return d.allow ? { action: "accept", content: {} } : { action: "decline" };
      }
      case "item/tool/requestUserInput": {
        // Codex is asking the user a question. There is no channel for the answer yet, so say so plainly
        // instead of guessing on their behalf.
        const qs = (p.questions ?? []).map((q: any) => q.question).filter(Boolean);
        note(`\n(Codex asked a question I cannot answer from here: ${qs.join(" / ") || "unspecified"})\n`);
        return { answers: {} };
      }
      default:
        throw Object.assign(new Error(`unsupported request ${req.method}`), { code: -32601 });
    }
  }
}

export type { ApprovalAsk };
