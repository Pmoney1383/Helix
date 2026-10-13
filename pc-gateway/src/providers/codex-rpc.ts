import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";

/** A message the Codex app-server sends us that is not a reply: a notification or a request for a decision. */
export interface RpcNotification { method: string; params: any }
export interface RpcServerRequest extends RpcNotification { id: number | string }

export type ServerRequestHandler = (req: RpcServerRequest) => Promise<unknown> | unknown;

export interface CodexServerOptions {
  /** Executable and arguments that start the app-server speaking JSON-RPC on stdio. */
  bin: string;
  args?: string[];
  /** Environment for the child; a function is evaluated on every (re)start. */
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  clientName?: string;
  version?: string;
  log?: { debug?: (o: object, m: string) => void; warn?: (o: object, m: string) => void };
  /** How long to wait for any one request to be answered. */
  requestTimeoutMs?: number;
}

/**
 * One long-lived `codex app-server` child, spoken to over stdio as newline-delimited JSON-RPC.
 * Owned by the gateway (a private instance, not the Codex desktop app's shared daemon), shared by
 * every Codex session Helix runs: notifications are routed by thread id.
 */
export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private readonly listeners = new Map<string, Set<(n: RpcNotification) => void>>();
  private readonly handlers = new Map<string, ServerRequestHandler>();
  private stderrTail = "";

  constructor(private readonly opts: CodexServerOptions) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** Starts the server (and handshakes) if it is not already up. Safe to call concurrently. */
  async ensure(): Promise<void> {
    if (this.running) return;
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    await this.starting;
  }

  private async start(): Promise<void> {
    const child = spawn(this.opts.bin, this.opts.args ?? ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: (typeof this.opts.env === "function" ? this.opts.env() : this.opts.env) ?? process.env,
    });
    this.child = child;

    child.stderr.on("data", (c: Buffer) => { this.stderrTail = (this.stderrTail + c.toString()).slice(-3000); });
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (e) => reject(new Error(`could not start codex: ${e.message}`)));
    });
    child.once("exit", (code) => this.onExit(code));
    child.stdin.on("error", () => { /* surfaced through exit */ });

    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));

    const handshake = (async () => {
      await this.request("initialize", {
        clientInfo: { name: this.opts.clientName ?? "helix", title: "Helix", version: this.opts.version ?? "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized");
    })();
    await Promise.race([handshake, failed]);
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }

  /* ---------------- calls ---------------- */

  request<T = any>(method: string, params?: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.child || !this.running) return reject(new Error("codex app-server is not running"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /* ---------------- incoming ---------------- */

  /** Notifications for one thread (the unit of routing). Returns an unsubscribe function. */
  subscribe(threadId: string, fn: (n: RpcNotification) => void): () => void {
    const set = this.listeners.get(threadId) ?? new Set();
    set.add(fn);
    this.listeners.set(threadId, set);
    return () => { set.delete(fn); if (set.size === 0) this.listeners.delete(threadId); };
  }

  /** How requests for decisions (approvals) on one thread are answered. */
  setHandler(threadId: string, fn: ServerRequestHandler): () => void {
    this.handlers.set(threadId, fn);
    return () => { if (this.handlers.get(threadId) === fn) this.handlers.delete(threadId); };
  }

  private onLine(line: string): void {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }

    if (m.id !== undefined && m.method === undefined) { // a reply to one of our requests
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) { void this.onServerRequest(m as RpcServerRequest); return; }
    if (m.method) {
      const threadId = m.params?.threadId ?? m.params?.thread?.id;
      if (typeof threadId === "string") for (const fn of this.listeners.get(threadId) ?? []) fn({ method: m.method, params: m.params });
    }
  }

  private async onServerRequest(req: RpcServerRequest): Promise<void> {
    const threadId = req.params?.threadId ?? req.params?.conversationId;
    const handler = typeof threadId === "string" ? this.handlers.get(threadId) : undefined;
    try {
      if (!handler) throw Object.assign(new Error(`no handler for ${req.method}`), { code: -32601 });
      this.write({ id: req.id, result: await handler(req) });
    } catch (err) {
      const e = err as Error & { code?: number };
      this.write({ id: req.id, error: { code: e.code ?? -32603, message: e.message } });
    }
  }

  private onExit(code: number | null): void {
    this.child = undefined;
    const why = this.stderrTail.trim().split("\n").pop() ?? "";
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`codex exited (code ${code})${why ? `: ${why}` : ""}`));
      this.pending.delete(id);
    }
    // Tell every thread listener so in-flight turns end instead of hanging forever.
    for (const set of this.listeners.values()) for (const fn of set) fn({ method: "helix/serverExited", params: { code, detail: why } });
    this.opts.log?.warn?.({ code }, "codex app-server exited");
  }

  private write(obj: unknown): void {
    if (this.child && this.running) this.child.stdin.write(JSON.stringify(obj) + "\n");
  }
}
