import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import type { AgentEvent, AgentProvider, SendOptions } from "./provider.js";

export type Attempt = { kind: "new" } | { kind: "resume" } | { kind: "fork"; from: string };

/**
 * The exact command line for one Claude turn. Pure, so it can be tested: the live router once failed because
 * this named a tool the router's narrow scope does not have, which no fake provider could have caught.
 */
export function claudeArgs(o: SendOptions, attempt: Attempt, permissionMode: string): string[] {
  const sessionArgs =
    attempt.kind === "fork" ? ["--resume", attempt.from, "--fork-session", "--session-id", o.providerSessionId]
    : attempt.kind === "resume" ? ["--resume", o.providerSessionId]
    : ["--session-id", o.providerSessionId];
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", permissionMode,
    ...sessionArgs,
  ];
  const system = [o.appendSystemPrompt, o.voiceStyle].filter(Boolean).join("\n\n");
  if (system) args.push("--append-system-prompt", system);
  if (o.routingOnly) args.push("--tools", "", "--strict-mcp-config", "--disable-slash-commands");
  if (o.mcp) {
    const config = { mcpServers: { helix: { type: "http", url: o.mcp.url, headers: { Authorization: `Bearer ${o.mcp.token}` } } } };
    args.push("--mcp-config", JSON.stringify(config));
    if (o.routingOnly) {
      // No shell, no editor: nothing can need approval, and the router has no permission tool. Just let it use
      // its own routing tools.
      args.push("--allowedTools", "mcp__helix");
    } else {
      // Anything Claude would normally ask permission for goes to the gateway, which auto-allows
      // normal actions and holds destructive ones for the user's approval.
      args.push("--permission-prompt-tool", "mcp__helix__permission_prompt");
    }
  }
  return args;
}

/** "Session ID ... is already in use." / "No conversation found with session ID ..." */
const SESSION_STATE_MISMATCH = /already in use|No conversation found/i;

export interface ClaudeProviderOptions {
  bin: string;
  permissionMode: string;
  /** How long an MCP tool call (i.e. a pending approval) may block, in ms. */
  toolTimeoutMs?: number;
}

/**
 * Drives the Claude Code CLI in headless stream-json mode, one process per turn.
 * Conversation continuity comes from --session-id (first turn) / --resume (later turns),
 * so a stopped session is resumed simply by sending to it again.
 */
export class ClaudeProvider implements AgentProvider {
  readonly name = "claude" as const;

  constructor(private readonly opts: ClaudeProviderOptions) {}

  async createSession(): Promise<{ providerSessionId: string }> {
    return { providerSessionId: randomUUID() };
  }

  async *send(o: SendOptions): AsyncGenerator<AgentEvent> {
    // The gateway's "has this session started?" bookkeeping can drift (e.g. a first turn that died
    // after the CLI had already claimed the ID). The CLI tells us when we guessed wrong; flip once.
    // A fork that already exists (an earlier attempt got as far as creating it) is continued, not re-forked.
    const attempts: Attempt[] = o.forkFrom
      ? [{ kind: "fork", from: o.forkFrom }, { kind: "resume" }]
      : [{ kind: o.resume ? "resume" : "new" }, { kind: o.resume ? "new" : "resume" }];
    let yielded = false;
    for (const [i, attempt] of attempts.entries()) {
      let retry = false;
      for await (const ev of this.runOnce(o, attempt)) {
        if (ev.type === "error" && !yielded && !retry && i === 0 && SESSION_STATE_MISMATCH.test(ev.message)) {
          retry = true;
          continue;
        }
        yielded = true;
        yield ev;
      }
      if (!retry) return;
    }
  }

  private async *runOnce(o: SendOptions, attempt: Attempt): AsyncGenerator<AgentEvent> {
    const args = claudeArgs(o, attempt, this.opts.permissionMode);

    const child = spawn(this.opts.bin, args, {
      cwd: o.projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // An approval can take a while; don't let Claude's default MCP timeout kill the wait.
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(this.opts.toolTimeoutMs ?? 2 * 60 * 60 * 1000) },
    });

    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-4000); });

    let spawnError: Error | undefined;
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", (e) => { spawnError = e; resolve(null); });
      child.once("close", (code) => resolve(code));
    });

    const kill = () => killTree(child.pid);
    if (o.signal.aborted) kill();
    else o.signal.addEventListener("abort", kill, { once: true });

    // Prompt goes via stdin: no command-line length limit, no quoting problems.
    child.stdin.on("error", () => { /* process died early; surfaced via exit code */ });
    child.stdin.end(o.text);

    let streamed = "";
    let finished = false;

    try {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        const msg = parseLine(line);
        if (!msg) continue;

        if (msg.type === "stream_event" && msg.parent_tool_use_id == null) {
          const ev = msg.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            streamed += ev.delta.text;
            yield { type: "delta", text: ev.delta.text };
          } else if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
            yield { type: "tool", name: String(ev.content_block.name ?? "tool") };
          }
        } else if (msg.type === "result") {
          finished = true;
          if (msg.is_error) {
            yield { type: "error", message: String(msg.result ?? msg.subtype ?? "agent error") };
          } else {
            const u = msg.usage;
            yield {
              type: "final", text: String(msg.result ?? streamed), costUsd: msg.total_cost_usd,
              usage: u ? { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, model: msg.modelUsage ? Object.keys(msg.modelUsage)[0] : undefined } : undefined,
            };
          }
        }
      }
    } finally {
      o.signal.removeEventListener("abort", kill);
    }

    const code = await exited;
    if (spawnError) {
      yield { type: "error", message: `could not start "${this.opts.bin}": ${(spawnError as Error).message}` };
      return;
    }
    if (!finished && !o.signal.aborted) {
      yield code === 0 && streamed
        ? { type: "final", text: streamed }
        : { type: "error", message: stderr.trim() || `claude exited with code ${code}` };
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseLine(line: string): any | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    // claude.exe spawns child processes (shell tools); /T takes the whole tree down.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
}
