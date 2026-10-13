// The PC voice (Chatterbox) as an on-demand child process. It is OFF unless enabled, starts only when something asks it to
// speak, refuses to start while the GPU or RAM is busy (for example while a model is training), and stops itself when
// idle so it never holds the GPU. See docs/LOCAL-TTS.md.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TtsStyle = "normal" | "serious";
export type TtsState = "off" | "starting" | "running" | "stopping";
export type TtsUnavailableReason = "disabled" | "not_configured" | "gpu_busy" | "gpu_unknown" | "ram_low" | "start_failed" | "speech_failed";

/** The voice cannot speak right now. The reason says why, and the caller falls back to Apple's voice on the phone. */
export class TtsUnavailable extends Error {
  constructor(readonly reason: TtsUnavailableReason, message: string) {
    super(message);
  }
}

export interface TtsOptions {
  enabled: boolean;
  engine: "qwen3" | "qwen3stream" | "chatterbox" | "fake";
  python?: string;
  /** Chatterbox only: the ~10 s reference clip. */
  reference?: string;
  /** Qwen3 only: the workspace holding models/ and ref/ref.json (the zero-shot clone). */
  qwenRoot?: string;
  /** "qwen3stream" only: runs inside WSL2 (Linux python and workspace paths), where Triton and the compiled kernels work. */
  wsl?: { distro: string; python: string; qwenRoot: string };
  hfHome?: string;
  port: number;
  /** The gateway stops the process after this long without a request. */
  idleSec: number;
  minFreeVramMb: number;
  minFreeRamMb: number;
  /** Overridable for tests. */
  script?: string;
  startTimeoutMs?: number;
}

export interface TtsDeps {
  /** Free GPU memory in MB, or undefined if it cannot be read. */
  gpuFreeMb?: () => Promise<number | undefined>;
  /** Available RAM in MB (free plus reclaimable cache). */
  freeRamMb?: () => number;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface TtsStatus {
  enabled: boolean;
  configured: boolean;
  engine: string;
  state: TtsState;
  lastUsedAt?: string;
  /** Seconds until the idle timer stops it, while it is running. */
  stopsInSec?: number;
  lastError?: string;
}

/** C:\\a\\b becomes /mnt/c/a/b (how WSL sees a Windows file). */
export function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}` : p.replace(/\\/g, "/");
}

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("cannot locate the pc-gateway package root");
}

/** Free GPU memory via nvidia-smi (first GPU). */
export function nvidiaFreeMb(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      const n = err ? NaN : Number.parseInt(String(stdout).split(/\r?\n/)[0] ?? "", 10);
      resolve(Number.isFinite(n) ? n : undefined);
    });
  });
}

/** A timer that never keeps the process alive on its own: waiting is never a reason for the gateway not to exit. */
const sleep = (ms: number) => new Promise((r) => { const t = setTimeout(r, ms); t.unref(); });

export class TtsManager {
  private child?: ChildProcess;
  private state: TtsState = "off";
  private starting?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private idleAt?: number;
  private lastUsed?: number;
  private lastError?: string;
  private stderrTail: string[] = [];
  private spawns = 0;
  private readonly gpuFreeMb: () => Promise<number | undefined>;
  private readonly freeRamMb: () => number;

  constructor(private readonly opts: TtsOptions, deps: TtsDeps = {}, private readonly log = deps.log) {
    this.gpuFreeMb = deps.gpuFreeMb ?? nvidiaFreeMb;
    this.freeRamMb = deps.freeRamMb ?? (() => os.freemem() / 1024 / 1024);
  }

  private get python(): string {
    return this.opts.python ?? "python";
  }

  private get configured(): boolean {
    if (this.opts.engine === "fake") return true;
    if (this.opts.engine === "qwen3stream") return !!this.opts.wsl;
    return !!(this.opts.python && (this.opts.engine === "qwen3" ? this.opts.qwenRoot : this.opts.reference));
  }

  /** True when the voice sends audio while it is still being generated (so there is no need to hold or fill the wait). */
  get streams(): boolean {
    return this.opts.engine === "qwen3stream";
  }

  /** The process id while it runs (for tests and diagnostics). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  status(): TtsStatus {
    return {
      enabled: this.opts.enabled, configured: this.configured, engine: this.opts.engine, state: this.state,
      lastUsedAt: this.lastUsed ? new Date(this.lastUsed).toISOString() : undefined,
      stopsInSec: this.state === "running" && this.idleAt ? Math.max(0, Math.round((this.idleAt - Date.now()) / 1000)) : undefined,
      lastError: this.lastError,
    };
  }

  /** Everything that must be true before the process may start. Cheap checks first; nothing is started here. */
  async checkGuards(): Promise<void> {
    if (!this.opts.enabled) throw new TtsUnavailable("disabled", "The PC voice is turned off (HELIX_TTS_ENABLED).");
    if (!this.configured) throw new TtsUnavailable("not_configured", this.opts.engine === "qwen3stream" ? "The streaming PC voice needs HELIX_TTS_WSL_PYTHON and HELIX_TTS_WSL_QWEN_ROOT to be set." : `The PC voice needs HELIX_TTS_PYTHON and ${this.opts.engine === "qwen3" ? "HELIX_TTS_QWEN_ROOT" : "HELIX_TTS_REFERENCE"} to be set.`);
    const ram = this.freeRamMb();
    if (ram < this.opts.minFreeRamMb) {
      throw new TtsUnavailable("ram_low", `Not starting the PC voice: only ${Math.round(ram)} MB of RAM is available (needs ${this.opts.minFreeRamMb}). Something heavy is running.`);
    }
    if (this.opts.engine !== "fake") {
      const free = await this.gpuFreeMb();
      if (free === undefined) throw new TtsUnavailable("gpu_unknown", "Not starting the PC voice: the GPU's free memory could not be read (is nvidia-smi available?).");
      if (free < this.opts.minFreeVramMb) {
        throw new TtsUnavailable("gpu_busy", `Not starting the PC voice: only ${free} MB of GPU memory is free (needs ${this.opts.minFreeVramMb}). Something else is using the GPU.`);
      }
    }
  }

  /** Start it in the background (for when a voice call begins), unless a guard says no. Does not wait for the model to load. */
  async warm(): Promise<TtsStatus> {
    if (this.state === "off" && !this.starting) await this.checkGuards(); // so a "no" reaches the caller instead of failing in the background
    this.ensureRunning().catch((err) => this.log?.warn({ err: String(err) }, "tts warm-up failed"));
    return this.status();
  }

  /**
   * Make sure the process is running. The FIRST caller claims the start at once (before any await), so callers that arrive
   * while it is starting all wait on the same start. Starting a second process here would put a second copy of the model on
   * the GPU.
   */
  ensureRunning(): Promise<void> {
    if (this.state === "running" && this.child && this.child.exitCode === null) return Promise.resolve();
    if (!this.starting) {
      this.state = this.state === "stopping" ? "stopping" : "starting";
      this.starting = (async () => {
        try {
          if (this.state === "stopping") await this.waitUntilStopped();
          await this.checkGuards();
          await this.start();
        } catch (err) {
          if (!this.child) this.state = "off";
          throw err;
        } finally {
          this.starting = undefined;
        }
      })();
    }
    return this.starting;
  }

  /** How many processes this manager has ever launched (diagnostics, and a test that two requests never start two). */
  get spawnCount(): number {
    return this.spawns;
  }

  private async waitUntilStopped(): Promise<void> {
    for (let i = 0; i < 100 && this.state === "stopping"; i++) await sleep(100);
  }

  private async start(): Promise<void> {
    this.state = "starting";
    this.lastError = undefined;
    this.stderrTail = [];
    const script = this.opts.script ?? path.join(packageRoot(), "tts", "helix_tts_server.py");
    const wsl = this.opts.engine === "qwen3stream" ? this.opts.wsl : undefined;
    const common = ["--port", String(this.opts.port), "--engine", this.opts.engine, "--idle-exit", String(this.opts.idleSec + 60)];
    // In WSL the server runs from the same file on the Windows disk (/mnt/c/...). python -u: wsl.exe does not pass PYTHONUNBUFFERED on.
    const command = wsl ? "wsl.exe" : this.python;
    const args = wsl
      // The compile cache goes on disk next to the model: WSL's /tmp is RAM and is lost whenever the WSL VM shuts down, which
      // would cost a ~95 s recompile on the next start instead of ~40 s.
      ? ["-d", wsl.distro, "--", "env", `TORCHINDUCTOR_CACHE_DIR=${wsl.qwenRoot}/inductor-cache`, wsl.python, "-u", toWslPath(script), ...common, "--qwen-root", wsl.qwenRoot]
      : [script, ...common];
    if (!wsl && this.opts.reference) args.push("--reference", this.opts.reference);
    if (!wsl && this.opts.qwenRoot) args.push("--qwen-root", this.opts.qwenRoot);
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", HF_HUB_DISABLE_SYMLINKS_WARNING: "1" };
    if (this.opts.hfHome) env.HF_HOME = this.opts.hfHome;

    // stdin stays open on purpose: if this process (the gateway) ever dies, the pipe closes and the voice process exits,
    // so a crash can never leave a model sitting on the GPU.
    const child = spawn(command, args, { env, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    this.spawns++;
    this.child = child;
    this.log?.info({ pid: child.pid, engine: this.opts.engine }, "tts: starting");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 25) this.stderrTail.shift();
      }
    });
    child.stdin?.on("error", () => undefined);
    const exited = new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(new TtsUnavailable("start_failed", `Could not start the PC voice process: ${err.message}`)));
      child.once("exit", (code) => {
        const tail = this.stderrTail.slice(-4).join(" | ");
        reject(new TtsUnavailable("start_failed", `The PC voice process exited while starting (code ${code}). ${tail}`.trim()));
      });
    });
    child.once("exit", () => {
      if (this.child === child) { this.child = undefined; this.state = "off"; this.clearIdle(); this.log?.info({ pid: child.pid }, "tts: stopped"); }
    });

    const stopWaiting = new AbortController();
    try {
      await Promise.race([this.waitReady(stopWaiting.signal), exited]);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      stopWaiting.abort(); // the readiness poll must not keep running against a process that is gone
      await this.kill(child);
      this.state = "off";
      throw err instanceof TtsUnavailable ? err : new TtsUnavailable("start_failed", this.lastError);
    }
    stopWaiting.abort();
    exited.catch(() => undefined); // from here a later exit is normal, not a failed start
    this.state = "running";
    this.touch();
  }

  private async waitReady(stop: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 240_000);
    while (!stop.aborted && Date.now() < deadline) {
      try {
        const r = await fetch(this.url("/health"), { signal: AbortSignal.timeout(2000) });
        if (r.ok && ((await r.json()) as { ready?: boolean }).ready) return;
      } catch { /* not listening yet */ }
      await sleep(400);
    }
    throw new TtsUnavailable("start_failed", "The PC voice did not become ready in time.");
  }

  private url(p: string): string {
    return `http://127.0.0.1:${this.opts.port}${p}`;
  }

  /** Speak one sentence. Starts the process if needed. Throws TtsUnavailable when it cannot. */
  async speak(text: string, style: TtsStyle = "normal"): Promise<{ pcm: Buffer; sampleRate: number }> {
    await this.ensureRunning();
    let res: Response;
    try {
      res = await fetch(this.url("/speak"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, style }), signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw new TtsUnavailable("speech_failed", `The PC voice did not answer: ${this.lastError}`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      this.lastError = body.error ?? `HTTP ${res.status}`;
      throw new TtsUnavailable("speech_failed", `The PC voice could not speak: ${this.lastError}`);
    }
    const pcm = Buffer.from(await res.arrayBuffer());
    this.touch();
    return { pcm, sampleRate: Number(res.headers.get("x-sample-rate") ?? 24000) };
  }

  /**
   * Speak one sentence, handing the audio over as it is generated (needs the streaming engine for real incremental audio; other
   * engines send the finished sentence in pieces). `onChunk` gets whole 16-bit samples. Throws TtsUnavailable when it cannot.
   */
  async stream(text: string, style: TtsStyle, onChunk: (pcm: Buffer, sampleRate: number) => void): Promise<void> {
    await this.ensureRunning();
    let res: Response;
    try {
      res = await fetch(this.url("/stream"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, style }), signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw new TtsUnavailable("speech_failed", `The PC voice did not answer: ${this.lastError}`);
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      this.lastError = body.error ?? `HTTP ${res.status}`;
      throw new TtsUnavailable("speech_failed", `The PC voice could not speak: ${this.lastError}`);
    }
    const rate = Number(res.headers.get("x-sample-rate") ?? 24000);
    let carry: Buffer = Buffer.alloc(0);
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        const buf = carry.length ? Buffer.concat([carry, part]) : Buffer.from(part);
        const whole = buf.length - (buf.length % 2);
        if (whole > 0) onChunk(buf.subarray(0, whole), rate);
        carry = buf.subarray(whole);
        this.touch();
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw new TtsUnavailable("speech_failed", `The PC voice stream was cut: ${this.lastError}`);
    }
    this.touch();
  }

  /** Keep a running voice loaded (the idle stop pushed back) without counting it as a use. Does nothing when it is not running. */
  async keepLoaded(): Promise<void> {
    if (this.state !== "running" || !this.child || this.child.exitCode !== null) return;
    try { await fetch(this.url("/keepalive"), { method: "POST", signal: AbortSignal.timeout(2000) }); } catch { return; }
    this.rearmIdle();
  }

  /** A request just happened: push the idle stop back. */
  private touch(): void {
    this.lastUsed = Date.now();
    this.rearmIdle();
  }

  private rearmIdle(): void {
    this.clearIdle();
    this.idleAt = Date.now() + this.opts.idleSec * 1000;
    this.idleTimer = setTimeout(() => { void this.stop("idle"); }, this.opts.idleSec * 1000);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.idleAt = undefined;
  }

  /** Stop the process and free the GPU. Safe to call at any time, including when it is already off. */
  async stop(reason = "requested"): Promise<void> {
    const child = this.child;
    this.clearIdle();
    if (!child || child.exitCode !== null) { this.state = "off"; return; }
    this.state = "stopping";
    this.log?.info({ pid: child.pid, reason }, "tts: stopping");
    try { await fetch(this.url("/shutdown"), { method: "POST", signal: AbortSignal.timeout(2000) }); } catch { /* it may already be going */ }
    await this.kill(child);
    if (this.child === child) this.child = undefined;
    this.state = "off";
  }

  /** End stdin (the polite signal), then wait; force-kill if it does not leave. */
  private async kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    const gone = new Promise<void>((r) => child.once("exit", () => r()));
    try { child.stdin?.end(); } catch { /* already closed */ }
    const timedOut = await Promise.race([gone.then(() => false), sleep(6000).then(() => true)]);
    if (timedOut && child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([gone, sleep(3000)]);
    }
  }
}
