import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { desktop } from "../mcp/desktop.js";
import { run } from "../mcp/pc-tools.js";

export interface NativeResult { ok: boolean; error?: string; [key: string]: unknown }
export interface ComputerBridge {
  onControlStopped?: () => void;
  request(command: Record<string, unknown>): Promise<NativeResult>;
  close(): void;
}

/** A single authenticated connection to a same-user, local-only Windows named pipe. No HTTP desktop endpoint. */
export class WindowsComputerBridge implements ComputerBridge {
  onControlStopped?: () => void;
  private socket?: net.Socket;
  private starting?: Promise<void>;
  private closed = false;
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (r: NativeResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly dataDir = path.join(os.tmpdir(), "helix")) {}

  private disconnect(message: string): void {
    this.socket?.destroy(); this.socket = undefined; this.buffer = "";
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
    this.onControlStopped?.();
  }
  close(): void { this.closed = true; this.disconnect("Desktop connection closed; input may already have executed. Do not retry with a new request ID."); }

  private async start(): Promise<void> {
    if (process.platform !== "win32") throw new Error("Desktop control requires Windows.");
    const pipe = `helix-computer-${randomUUID()}`;
    const secret = randomBytes(32).toString("hex");
    const dir = path.join(this.dataDir, "computer");
    fs.mkdirSync(dir, { recursive: true });
    // Restrict this directory BEFORE writing a connection secret.
    const escaped = dir.replace(/'/g, "''");
    const secured = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; $p='${escaped}'; $s=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); $a.SetOwner($s); $r=New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`], { timeoutMs: 10_000 });
    if (secured.code !== 0) throw new Error("Could not restrict desktop helper credentials to your Windows account.");
    const bootstrap = path.join(dir, `${pipe}.json`);
    fs.writeFileSync(bootstrap, JSON.stringify({ pipe, secret }), { flag: "wx" });
    try {
      const started = await desktop({ op: "computer_start", bootstrap }, { dataDir: this.dataDir });
      if (!started.ok) throw new Error(started.error);
      const until = Date.now() + 20_000;
      let socket: net.Socket | undefined;
      while (!this.closed && Date.now() < until) {
        socket = await new Promise<net.Socket | undefined>((resolve) => {
          const s = net.createConnection(`\\\\.\\pipe\\${pipe}`);
          s.once("error", () => { s.destroy(); resolve(undefined); });
          s.once("connect", () => resolve(s));
        });
        if (socket) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!socket || this.closed) { socket?.destroy(); throw new Error("Desktop helper unavailable. Log in to Windows and unlock your desktop."); }
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        if (this.buffer.length > 24 * 1024 * 1024) { this.disconnect("Desktop image exceeded the transport limit."); return; }
        let i: number;
        while ((i = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
          try {
            const result = JSON.parse(line) as NativeResult & { id: string };
            if (result.event === "control_stopped") { this.onControlStopped?.(); continue; }
            const p = this.pending.get(result.id);
            if (p) { this.pending.delete(result.id); clearTimeout(p.timer); p.resolve(result); }
          } catch { this.disconnect("Invalid desktop helper response."); return; }
        }
      });
      socket.on("error", () => { if (this.socket === socket) this.disconnect("Desktop helper connection failed; input outcome may be unknown."); });
      socket.on("close", () => { if (this.socket === socket) this.disconnect("Desktop helper disconnected; control has stopped."); });
      const hello = await this.send({ op: "hello", secret });
      if (!hello.ok) throw new Error("Desktop helper authentication failed.");
    } finally { fs.rmSync(bootstrap, { force: true }); }
  }

  private send(command: Record<string, unknown>): Promise<NativeResult> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) { reject(new Error("Desktop helper disconnected.")); return; }
      const id = randomUUID();
      const timer = setTimeout(() => this.disconnect("Desktop request timed out; input may already have executed. Inspect before retrying."), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  async request(command: Record<string, unknown>): Promise<NativeResult> {
    if (this.closed) throw new Error("Desktop bridge closed.");
    if (!this.socket) {
      this.starting ??= this.start().catch((e) => { this.disconnect("Desktop startup failed."); throw e; }).finally(() => { this.starting = undefined; });
      await this.starting;
    }
    return this.send(command);
  }
}
