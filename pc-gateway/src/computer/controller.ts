import { createHash, randomUUID } from "node:crypto";
import { WindowsComputerBridge, type ComputerBridge, type NativeResult } from "./bridge.js";

export interface CaptureOptions { monitorId?: string; maxEdge?: number; format?: "png" | "jpeg"; crop?: { x: number; y: number; width: number; height: number } }
export interface Frame {
  frameId: string; width: number; height: number; bounds: { x: number; y: number; width: number; height: number };
  layout: string; capturedAt: string; activeWindow: { handle: string }; monitorId: string;
}
export interface Action {
  kind: "click" | "double_click" | "right_click" | "move_mouse" | "type_text" | "press_key" | "scroll" | "drag";
  controlId: string; requestId: string; frameId: string; x?: number; y?: number; x2?: number; y2?: number; endFrameId?: string;
  text?: string; key?: string; delta?: number; horizontal?: boolean; settleMs?: number; screenshot?: boolean;
}
export function imagePoint(frame: Frame, x: number | undefined, y: number | undefined): { x: number; y: number } {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x! < 0 || y! < 0 || x! >= frame.width || y! >= frame.height) throw new Error("Coordinates must be pixels inside the referenced screenshot.");
  return { x: frame.bounds.x + Math.min(frame.bounds.width - 1, Math.floor((x! + 0.5) * frame.bounds.width / frame.width)),
    y: frame.bounds.y + Math.min(frame.bounds.height - 1, Math.floor((y! + 0.5) * frame.bounds.height / frame.height)) };
}

/** Owned by the gateway, not by an individual stateless MCP request. */
export class ComputerController {
  private readonly stopListeners = new Set<(controlId: string) => void>();
  onStopped(listener: (controlId: string) => void): () => void { this.stopListeners.add(listener); return () => { this.stopListeners.delete(listener); }; }
  isActive(identity: string, controlId: string): boolean {
    return !this.closed && !!this.owner && this.owner.identity === identity && this.owner.controlId === controlId && this.allowed(identity) && this.now() - this.owner.lastUse <= 120_000;
  }
  /** The control session this identity currently holds, if any. Read-only: it never renews the lease. */
  activeControlId(identity: string): string | undefined {
    return this.owner && this.isActive(identity, this.owner.controlId) ? this.owner.controlId : undefined;
  }
  async startViewer(identity: string, controlId: string, port: number, format: 'rtp' | 'jpeg' = 'rtp'): Promise<NativeResult> {
    if (!this.isActive(identity, controlId)) throw new Error("Desktop control ended.");
    return this.native({ op: "viewer_start", port, format });
  }
  async stopViewer(identity: string, controlId: string): Promise<void> {
    if (this.isActive(identity, controlId)) await this.native({ op: "viewer_stop" });
  }
  async viewerStatus(identity: string, controlId: string): Promise<NativeResult> {
    if (!this.isActive(identity, controlId)) throw new Error("Desktop control ended.");
    return this.native({ op: "viewer_status" });
  }
  private bridge?: ComputerBridge;
  private owner?: { identity: string; controlId: string; lastUse: number };
  private readonly frames = new Map<string, Frame>();
  private readonly requests = new Map<string, { hash: string; result: NativeResult }>();
  private busy = false;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private disconnect(): void { this.bridge?.close(); this.bridge = undefined; this.clear(); }
  constructor(private readonly allowed: (identity: string) => boolean, private readonly makeBridge: () => ComputerBridge = () => new WindowsComputerBridge(), private readonly now = Date.now) {}

  private async native(command: Record<string, unknown>): Promise<NativeResult> {
    if (this.closed) throw new Error("Desktop controller closed.");
    if (!this.bridge) { this.bridge = this.makeBridge(); this.bridge.onControlStopped = () => this.clear(); }
    const result = await this.bridge.request(command);
    if (!this.timer) { this.timer = setInterval(() => { void this.tick(); }, 2000); this.timer.unref(); }
    return result;
  }
  private clear(): void {
    const id = this.owner?.controlId;
    this.owner = undefined; this.frames.clear(); this.requests.clear();
    if (id) for (const listener of this.stopListeners) { try { listener(id); } catch { /* spectator must not break input */ } }
  }
  private async tick(): Promise<void> {
    if (!this.bridge || this.closed) return;
    try {
      if (this.owner && (!this.allowed(this.owner.identity) || this.now() - this.owner.lastUse > 120_000)) {
        this.clear(); await this.bridge.request({ op: "stop" });
      }
      const result = await this.bridge.request({ op: "heartbeat" });
      if (result.active === false) this.clear();
    } catch { this.disconnect(); }
  }
  private access(identity: string): void { if (!this.allowed(identity)) throw new Error("Desktop access is disabled or this credential was revoked."); }
  private session(identity: string, controlId: string): void {
    this.access(identity);
    if (!this.owner || this.owner.identity !== identity || this.owner.controlId !== controlId) throw new Error("No matching active control session. Call start_desktop_control first.");
    if (this.now() - this.owner.lastUse > 120_000) throw new Error("Desktop control expired. Start a new session.");
    this.owner.lastUse = this.now();
  }
  private frame(id: string): Frame {
    const f = this.frames.get(id);
    if (!f || this.now() - Date.parse(f.capturedAt) > 120_000) throw new Error("Screenshot is stale or unknown. Take a fresh screenshot.");
    return f;
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("A desktop operation is already running. Wait for its result.");
    this.busy = true; try { return await fn(); } finally { this.busy = false; }
  }
  async info(identity: string): Promise<NativeResult> {
    this.access(identity); return this.exclusive(() => this.native({ op: "info" }));
  }
  async start(identity: string, label = false, pulse = true, signal?: AbortSignal): Promise<NativeResult> {
    this.access(identity);
    return this.exclusive(async () => {
      const held = this.owner && this.now() - this.owner.lastUse <= 120_000;
      if (held && this.owner!.identity !== identity) throw new Error("Another control session is active. Stop it or wait for its lease to expire.");
      if (signal?.aborted) throw new Error("Desktop start cancelled.");
      // The same caller starting again means it lost the earlier start's result (dropped response, timeout, UI
      // re-render) and has no controlId to use or stop it. Replace that session instead of locking the caller out.
      if (held) { this.clear(); if (this.bridge) await this.bridge.request({ op: "stop" }).catch(() => this.disconnect()); }
      this.clear();
      const abort = () => this.disconnect();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const r = await this.native({ op: "start", label, pulse });
        if (signal?.aborted) { this.disconnect(); throw new Error("Desktop start cancelled."); }
        if (!r.ok) return r;
        const controlId = randomUUID(); this.owner = { identity, controlId, lastUse: this.now() };
        const shot = await this.captureInternal({ monitorId: typeof r.monitorId === "string" ? r.monitorId : undefined });
        if (!shot.ok || signal?.aborted) {
          this.clear();
          if (this.bridge) await this.bridge.request({ op: "stop" });
          if (signal?.aborted) throw new Error("Desktop start cancelled.");
          return shot;
        }
        return { controlId, idleTimeoutSec: 120, stopShortcut: "Ctrl+Alt+Shift+F12", ...shot };
      } catch (e) {
        this.clear();
        if (this.bridge) await this.bridge.request({ op: "stop" }).catch(() => this.disconnect());
        throw e;
      } finally { signal?.removeEventListener("abort", abort); }
    });
  }
  /** Without a controlId, stops whatever session this caller holds: the way out when it never received the id. */
  async stop(identity: string, controlId?: string): Promise<NativeResult> {
    // Do not queue stop behind screenshot/input. Closing the pipe is a fallback if the helper cannot answer.
    this.access(identity);
    if (!this.owner) return { ok: true, stopped: true };
    if (controlId === undefined) { if (this.owner.identity !== identity) throw new Error("No control session of yours is active."); }
    else this.session(identity, controlId);
    this.clear();
    try { return await this.native({ op: "stop" }); }
    catch { this.bridge?.close(); this.bridge = undefined; return { ok: true, stopped: true }; }
  }
  private async captureInternal(options: CaptureOptions): Promise<NativeResult> {
    const r = await this.native({ op: "capture", ...options });
    if (!r.ok) return r;
    const frame = { ...r, frameId: randomUUID() } as unknown as Frame;
    const { image: _image, ...metadata } = r;
    this.frames.set(frame.frameId, { ...metadata, frameId: frame.frameId } as unknown as Frame);
    while (this.frames.size > 24) this.frames.delete(this.frames.keys().next().value!);
    return { ...r, frameId: frame.frameId, nextRequestId: randomUUID() };
  }
  async capture(identity: string, controlId: string, options: CaptureOptions): Promise<NativeResult> {
    return this.exclusive(async () => { this.session(identity, controlId); return this.captureInternal(options); });
  }
  async act(identity: string, action: Action, signal?: AbortSignal): Promise<NativeResult> {
    return this.exclusive(async () => {
      this.session(identity, action.controlId);
      const hash = createHash("sha256").update(JSON.stringify(action)).digest("hex");
      const prior = this.requests.get(action.requestId);
      if (prior) {
        if (prior.hash !== hash) throw new Error("requestId already used for different input.");
        return { ...prior.result, replayed: true, next: "No input repeated. Use take_screenshot to observe the current desktop." };
      }
      if (this.requests.size >= 1000) throw new Error("Session action limit reached. End control and start a new session.");
      const f = this.frame(action.frameId);
      const command: Record<string, unknown> = { op: "action", kind: action.kind, layout: f.layout, text: action.text, key: action.key,
        delta: action.delta, horizontal: action.horizontal, settleMs: action.settleMs };
      if (["click", "double_click", "right_click", "move_mouse", "drag", "scroll"].includes(action.kind)) Object.assign(command, imagePoint(f, action.x, action.y));
      if (action.kind === "drag") {
        const end = this.frame(action.endFrameId ?? action.frameId);
        if (end.layout !== f.layout) throw new Error("Drag screenshots have different monitor layouts.");
        const point = imagePoint(end, action.x2, action.y2); command.x2 = point.x; command.y2 = point.y;
      }
      if (action.kind === "type_text" || action.kind === "press_key") command.expectedWindow = f.activeWindow.handle;
      if (signal?.aborted) throw new Error("Desktop action cancelled before execution.");
      const uncertain: NativeResult = { ok: false, executed: "unknown", error: "Input outcome unknown. Inspect the desktop before deciding what to do next." };
      this.requests.set(action.requestId, { hash, result: uncertain });
      const abort = () => this.disconnect();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await this.native(command);
        this.requests.set(action.requestId, { hash, result });
        // A pre-action frame is consumed for input, even if the application did not visibly change.
        this.frames.clear();
        if (!signal?.aborted && action.screenshot !== false && this.owner?.controlId === action.controlId) {
          try {
            const shot = await this.captureInternal({ monitorId: typeof result.monitorId === "string" ? result.monitorId : f.monitorId });
            if (shot.ok) return { ...shot, ...result, frameId: shot.frameId };
            return { ...result, screenshotError: shot.error };
          } catch (e) { return { ...result, screenshotError: String(e) }; }
        }
        return result;
      } finally { signal?.removeEventListener("abort", abort); }
    });
  }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.bridge?.close(); this.clear(); }
}
