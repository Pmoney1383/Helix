import { execFile } from "node:child_process";
import type { Notice } from "../notifications/escalation.js";

/**
 * Keeps the hosted connectors (ChatGPT, claude.ai) reachable: those only work while Tailscale Funnel serves /mcp, /oauth and
 * /.well-known on the public address. Every few minutes this asks the PUBLIC address for the OAuth discovery document (a real
 * round trip through the internet, which is what a connector does). When that fails it works out why, puts the three Funnel
 * paths back if they are gone (the same commands as docs/HOSTED.md), and tells the user if it cannot fix it.
 */

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface ProbeResult { ok: boolean; status?: number; error?: string }

export interface FunnelDeps {
  probe(url: string): Promise<ProbeResult>;
  tailscale(args: string[]): Promise<CommandResult>;
  notify(n: Notice): Promise<unknown>;
  now?: () => number;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

export interface FunnelOptions {
  /** HELIX_PUBLIC_URL, e.g. https://pc.tailnet.ts.net */
  publicUrl: string;
  /** The loopback port the gateway listens on (the Funnel paths point at it). */
  port: number;
  intervalMs?: number;
  /** Consecutive failed checks (after any repair) before the user is told. */
  failThreshold?: number;
  /** Fewest ms between two repair attempts. */
  repairCooldownMs?: number;
  /** Put the Funnel paths back when they are missing. */
  repair?: boolean;
  /** Re-tell the user about a continuing outage this often. */
  renotifyMs?: number;
}

export interface FunnelStatus {
  state: "unknown" | "up" | "down";
  lastCheckAt?: number;
  lastOkAt?: number;
  downSince?: number;
  consecutiveFailures: number;
  lastProblem?: string;
  lastRepairAt?: number;
}

const PATHS = ["/mcp", "/oauth", "/.well-known"] as const;

/** What `tailscale funnel status` says is missing or off, as text for the user; undefined when it looks right. */
export function funnelProblem(statusText: string, host: string): string | undefined {
  const text = statusText.replace(/\r/g, "");
  if (!text.includes(host)) return "Funnel is not serving this address";
  if (!/\(Funnel on\)/i.test(text)) return "Funnel is switched off for this address";
  const missing = PATHS.filter((p) => !new RegExp(`^\\|--\\s+${p.replace(/[./]/g, "\\$&")}\\s`, "m").test(text));
  return missing.length ? `Funnel is missing ${missing.join(", ")}` : undefined;
}

export class FunnelWatchdog {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastNotifyAt = 0;
  private readonly s: FunnelStatus = { state: "unknown", consecutiveFailures: 0 };
  private readonly intervalMs: number;
  private readonly failThreshold: number;
  private readonly repairCooldownMs: number;
  private readonly renotifyMs: number;
  private readonly now: () => number;
  private readonly host: string;

  constructor(private readonly deps: FunnelDeps, private readonly opts: FunnelOptions) {
    this.intervalMs = opts.intervalMs ?? 120_000;
    this.failThreshold = opts.failThreshold ?? 2;
    this.repairCooldownMs = opts.repairCooldownMs ?? 10 * 60_000;
    this.renotifyMs = opts.renotifyMs ?? 6 * 3_600_000;
    this.now = deps.now ?? (() => Date.now());
    this.host = new URL(opts.publicUrl).host;
  }

  status(): FunnelStatus { return { ...this.s }; }

  /** First check shortly after start (Tailscale may still be coming up after a reboot), then on an interval. */
  start(firstCheckMs = 45_000): void {
    if (this.timer) return;
    const loop = (delay: number) => {
      this.timer = setTimeout(() => { void this.tick().finally(() => { if (this.timer) loop(this.intervalMs); }); }, delay);
      this.timer.unref?.();
    };
    loop(firstCheckMs);
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  /** One check. Never throws. */
  async tick(): Promise<FunnelStatus> {
    if (this.running) return this.status();
    this.running = true;
    try { await this.check(); } catch (err) { this.deps.log?.warn({ err: String(err) }, "funnel watchdog check failed"); } finally { this.running = false; }
    return this.status();
  }

  private probeUrl(): string { return `${this.opts.publicUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp`; }

  private async check(): Promise<void> {
    const now = this.now();
    this.s.lastCheckAt = now;
    let probe = await this.deps.probe(this.probeUrl());
    if (probe.ok) return this.recovered(now, false);

    // Not reachable: find out why and, when the Funnel paths are what is missing, put them back.
    const problem = (await this.diagnose()) ?? `the public address does not answer (${probe.error ?? `HTTP ${probe.status}`})`;
    this.s.lastProblem = problem;
    let repaired = false;
    if ((this.opts.repair ?? true) && problem.startsWith("Funnel") && now - (this.s.lastRepairAt ?? 0) >= this.repairCooldownMs) {
      this.s.lastRepairAt = now;
      repaired = await this.repair();
      if (repaired) {
        probe = await this.deps.probe(this.probeUrl());
        if (probe.ok) return this.recovered(now, true);
      }
    }

    this.s.consecutiveFailures += 1;
    this.deps.log?.warn({ problem, failures: this.s.consecutiveFailures, repaired }, "hosted access is not reachable");
    if (this.s.consecutiveFailures < this.failThreshold) return;
    const first = this.s.state !== "down";
    if (first) { this.s.state = "down"; this.s.downSince = now; }
    if (first || now - this.lastNotifyAt >= this.renotifyMs) {
      this.lastNotifyAt = now;
      await this.deps.notify({
        severity: "important",
        title: "ChatGPT / claude.ai cannot reach your PC",
        body: `${problem[0]!.toUpperCase()}${problem.slice(1)}.${repaired ? " I tried putting the Funnel paths back and it did not help." : ""} Hosted chats will fail until this is fixed; the phone app is not affected.`,
        dedupeKey: "funnel-watchdog:down",
      }).catch(() => undefined);
    }
  }

  private async recovered(now: number, fixed: boolean): Promise<void> {
    const wasDown = this.s.state === "down";
    this.s.state = "up";
    this.s.lastOkAt = now;
    this.s.consecutiveFailures = 0;
    this.s.lastProblem = undefined;
    const downFor = this.s.downSince ? Math.round((now - this.s.downSince) / 60_000) : 0;
    this.s.downSince = undefined;
    if (fixed) this.deps.log?.info({}, "funnel paths were missing and have been put back");
    if (wasDown) {
      await this.deps.notify({
        severity: "important", title: "ChatGPT / claude.ai can reach your PC again",
        body: downFor ? `Hosted access is back after about ${downFor} minute${downFor === 1 ? "" : "s"}.` : "Hosted access is back.",
        dedupeKey: "funnel-watchdog:up",
      }).catch(() => undefined);
    } else if (fixed) {
      await this.deps.notify({
        severity: "info", title: "Hosted access repaired",
        body: "The Tailscale Funnel paths for ChatGPT / claude.ai were missing, and the watchdog put them back.", dedupeKey: "funnel-watchdog:fixed",
      }).catch(() => undefined);
    }
  }

  /** Why the public address is unreachable, if Tailscale or Funnel is the reason. Undefined when they look fine. */
  private async diagnose(): Promise<string | undefined> {
    let st: CommandResult;
    try { st = await this.deps.tailscale(["status", "--json"]); } catch { return "Tailscale could not be run on the PC"; }
    if (st.code !== 0) return "Tailscale is not responding on the PC";
    try {
      const j = JSON.parse(st.stdout);
      if (j.BackendState && j.BackendState !== "Running") return `Tailscale is not running (${j.BackendState})`;
      if (j.Self && j.Self.Online === false) return "Tailscale is offline (no internet, or signed out)";
    } catch { /* unparseable status: carry on to the funnel check */ }
    let fs: CommandResult;
    try { fs = await this.deps.tailscale(["funnel", "status"]); } catch { return undefined; }
    return funnelProblem(`${fs.stdout}\n${fs.stderr}`, this.host);
  }

  /** The same three commands as docs/HOSTED.md. execFile with an argument list: no shell, so no path mangling. */
  private async repair(): Promise<boolean> {
    try {
      for (const p of PATHS) {
        const r = await this.deps.tailscale(["funnel", "--bg", "--https=443", `--set-path=${p}`, `http://127.0.0.1:${this.opts.port}${p}`]);
        if (r.code !== 0) { this.deps.log?.warn({ path: p, stderr: r.stderr.slice(0, 300) }, "funnel repair command failed"); return false; }
      }
      return true;
    } catch (err) {
      this.deps.log?.warn({ err: String(err) }, "funnel repair could not run");
      return false;
    }
  }
}

/** The real thing: the tailscale CLI and an HTTPS request to the public address. */
export function realFunnelDeps(tailscaleBin: string, notify: FunnelDeps["notify"], log?: FunnelDeps["log"]): FunnelDeps {
  return {
    log, notify,
    tailscale: (args) => new Promise((resolve, reject) => {
      execFile(tailscaleBin, args, { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : 1) : 0;
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    }),
    probe: async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "helix-funnel-watchdog" } });
        return { ok: r.status === 200, status: r.status };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err) };
      }
    },
  };
}
