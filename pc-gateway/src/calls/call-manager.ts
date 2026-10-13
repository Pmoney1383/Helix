import { randomUUID } from "node:crypto";
import type { ApnsClient } from "../notifications/apns.js";
import type { DeviceTokens } from "../notifications/devices.js";
import type { Notifier } from "../notifications/escalation.js";
import type { Notice } from "../notifications/escalation.js";
import type { ApprovalService } from "../permissions/approvals.js";
import type { RouterService } from "../router/router.js";
import { GatewayError, type EventBus, type SessionManager } from "../sessions/manager.js";
import type { Db } from "../storage/sqlite.js";
import type { Call, CallStatus, ProviderName } from "../types.js";
import { voiceSeverityFor } from "../persona/clamp.js";
import type { PersonaService } from "../persona/service.js";
import { approvalScript, conversationPrimer, eventScript } from "./composer.js";

export interface RingContext {
  severity: Call["severity"];
  title: string;
  summary: string;
  sessionId?: string;
  approvalId?: string;
}

interface Row {
  id: string; direction: Call["direction"]; status: CallStatus; severity: Call["severity"]; title: string; summary: string;
  script: string; expects: Call["expects"]; session_id: string | null; approval_id: string | null; route_id: string | null;
  device_id: string | null; created_at: string; answered_at: string | null; ended_at: string | null; end_reason: string | null;
}

const toCall = (r: Row): Call => ({
  id: r.id, direction: r.direction, status: r.status, severity: r.severity, title: r.title, summary: r.summary, script: r.script,
  expects: r.expects, sessionId: r.session_id ?? undefined, approvalId: r.approval_id ?? undefined, routeId: r.route_id ?? undefined,
  deviceId: r.device_id ?? undefined, createdAt: r.created_at, answeredAt: r.answered_at ?? undefined, endedAt: r.ended_at ?? undefined,
  endReason: r.end_reason ?? undefined,
});

export interface CallManagerOptions {
  /** How long the phone rings before the call counts as missed. */
  ringTimeoutMs?: number;
  now?: () => number;
  /** 0..1, for the ringback length (tests pin it). */
  random?: () => number;
}

/** How long the phone plays ringback before an outgoing call starts talking: 1 to 3 seconds, a different one each time. */
export const RINGBACK_MIN_MS = 1000;
export const RINGBACK_MAX_MS = 3000;

/**
 * Phone calls between Helix and the user.
 *
 *  - Incoming (Helix rings you): a VoIP push wakes the app, which shows the native call screen. Answering
 *    opens a conversation primed with why Helix is calling, or, for an approval call, asks for a spoken
 *    approve/reject that the phone interprets itself (see decide()).
 *  - Outgoing (you call Helix): the call is created already answered, with a route to talk into.
 *
 * Approvals are deliberately NOT interpreted by a language model: the phone does yes/no keyword matching
 * and calls POST /calls/:id/decision, so nothing an agent writes can talk its way into an approval.
 */
export class CallManager {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly now: () => number;
  private readonly random: () => number;
  /** How long after the goodbye reply arrives the line stays open, so it can be spoken first (a few seconds; tests shorten it). */
  speechDelayMs: (chars: number) => number = (chars) => Math.min(20_000, Math.max(1_500, chars * 65)) + 1_500;
  /** Calls that will be hung up once the reply being prepared has been spoken. */
  private readonly hangups = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly deps: {
      devices: DeviceTokens;
      apns?: ApnsClient;
      router: RouterService;
      manager: SessionManager;
      approvals: ApprovalService;
      /** Used to tell the user about a call they missed. */
      push?: Notifier;
      /** Wording for what is said first. Routine updates get a light touch; urgent ones and approvals never do. */
      persona?: PersonaService;
    },
    private readonly opts: CallManagerOptions = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    // A hang-up was asked for: end the call once the reply that follows has had time to be spoken.
    bus.subscribe((e) => {
      if (e.type === "agent.output.final") {
        for (const [callId, fallback] of [...this.hangups]) {
          const call = this.get(callId);
          const route = call?.routeId ? this.deps.router.get(call.routeId) : undefined;
          if (!call || !route || e.sessionId !== route.currentSessionId) continue;
          clearTimeout(fallback);
          const speechMs = this.speechDelayMs((e.spoken ?? e.text).length);
          const t = setTimeout(() => this.finishHangup(callId), speechMs);
          t.unref();
          this.hangups.set(callId, t);
        }
      } else if (e.type === "call.ended") {
        const t = this.hangups.get(e.call.id);
        if (t) { clearTimeout(t); this.hangups.delete(e.call.id); }
      }
    });
    // Approved/rejected from the app while the phone is still ringing: the call has no reason left to exist.
    bus.subscribe((e) => {
      if (e.type !== "approval.resolved") return;
      const open = this.db.prepare("SELECT id FROM calls WHERE approval_id = ? AND status IN ('ringing', 'answered')").all(e.approval.id) as { id: string }[];
      for (const c of open) this.finish(c.id, "ended", `approval ${e.approval.status} elsewhere`, ["ringing", "answered"]);
    });
    // A ringing call cannot survive a restart: nothing is left to ring.
    this.db.prepare("UPDATE calls SET status = 'ended', ended_at = ?, end_reason = 'gateway restarted' WHERE status IN ('ringing', 'answered')")
      .run(new Date().toISOString());
  }

  get available(): boolean {
    return !!this.deps.apns;
  }

  /* ---------------- incoming ---------------- */

  /** Ring the user's phone(s). Throws if nothing could be rung; the escalation policy records that as a failed channel. */
  async ringIncoming(ctx: RingContext): Promise<Call> {
    if (!this.deps.apns) throw new Error("calls need Apple push notifications, which are not configured");
    const tokens = this.deps.devices.tokensFor("voip");
    if (tokens.length === 0) throw new Error("no phone has registered for calls");

    const expects: Call["expects"] = ctx.approvalId ? "approval" : "conversation";
    const script = ctx.approvalId
      ? approvalScript(ctx.summary || ctx.title)
      : eventScript(ctx.title, ctx.summary, this.deps.persona?.flavor({ severity: ctx.severity, title: ctx.title }) ?? {});
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO calls (id, direction, status, severity, title, summary, script, expects, session_id, approval_id, created_at)
       VALUES (?, 'incoming', 'ringing', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ctx.severity, ctx.title, ctx.summary, script, expects, ctx.sessionId ?? null, ctx.approvalId ?? null, new Date(this.now()).toISOString());

    const payload = {
      helix: { callId: id, expects, severity: ctx.severity, approvalId: ctx.approvalId, sessionId: ctx.sessionId },
      callId: id, caller: "Claude", title: ctx.title.slice(0, 80), expects,
    };
    let rang = 0;
    const reasons: string[] = [];
    await Promise.all(tokens.map(async (t) => {
      const r = await this.deps.apns!.send({ token: t.token, environment: t.environment, kind: "voip", payload });
      if (r.ok) rang++;
      else { if (r.invalidToken) this.deps.devices.invalidate(t.token); reasons.push(`${r.status || "network"} ${r.reason ?? ""}`.trim()); }
    }));
    if (rang === 0) {
      this.finish(id, "failed", `could not ring: ${reasons.join("; ")}`, ["ringing"]);
      throw new Error(`call not delivered: ${reasons.join("; ")}`);
    }

    const call = this.mustGet(id);
    this.bus.publish({ type: "call.ringing", call });
    this.armRingTimer(id);
    return call;
  }

  /** The phone answers. First device to answer wins. */
  async answer(id: string, deviceId: string): Promise<Call> {
    const claimed = this.db.prepare("UPDATE calls SET status = 'answered', answered_at = ?, device_id = ? WHERE id = ? AND status = 'ringing'")
      .run(new Date(this.now()).toISOString(), deviceId, id).changes;
    if (claimed !== 1) {
      const c = this.get(id);
      if (!c) throw new GatewayError(404, "call not found");
      throw new GatewayError(409, `call is no longer ringing (${c.status})`);
    }
    this.clearTimer(id);

    let call = this.mustGet(id);
    if (call.expects === "conversation") {
      try {
        const route = await this.deps.router.createRoute(`Call: ${call.title}`.slice(0, 100));
        const related = call.sessionId ? this.deps.manager.registry.get(call.sessionId) : undefined;
        this.deps.router.setContext(route.id, conversationPrimer({
          title: call.title, summary: call.summary, script: call.script, relatedSessionId: related?.id, relatedTitle: related?.title,
        }));
        this.deps.router.setVoiceSeverity(route.id, voiceSeverityFor({ severity: call.severity }));
        this.db.prepare("UPDATE calls SET route_id = ? WHERE id = ?").run(route.id, id);
      } catch (err) {
        // Without a conversation the call can still be heard (the script) and ended; do not drop it.
        this.db.prepare("UPDATE calls SET end_reason = ? WHERE id = ?").run(`no conversation: ${err instanceof Error ? err.message : err}`, id);
      }
      call = this.mustGet(id);
    }
    this.bus.publish({ type: "call.answered", call });
    return call;
  }

  decline(id: string, deviceId?: string): Call {
    if (!this.finish(id, "declined", "declined on the phone", ["ringing"], deviceId)) throw this.notRinging(id);
    return this.mustGet(id);
  }

  end(id: string, reason = "ended"): Call {
    const c = this.get(id);
    if (!c) throw new GatewayError(404, "call not found");
    if (c.status === "ringing" || c.status === "answered") this.finish(id, "ended", reason, ["ringing", "answered"]);
    return this.mustGet(id);
  }

  /**
   * The spoken approve/reject, already interpreted by the phone. Only valid on an answered approval call,
   * and only once: the approval itself enforces that a decision cannot be changed afterwards.
   */
  async decide(id: string, approve: boolean, deviceId: string): Promise<{ call: Call; approvalStatus: string }> {
    const call = this.get(id);
    if (!call) throw new GatewayError(404, "call not found");
    if (call.expects !== "approval" || !call.approvalId) throw new GatewayError(400, "this call is not asking for an approval");
    if (call.status !== "answered") throw new GatewayError(409, `call is ${call.status}; answer it first`);
    const result = this.deps.approvals.resolve(call.approvalId, approve, deviceId, "decided by phone call");
    if (!result) throw new GatewayError(404, "approval no longer exists");
    this.finish(id, "ended", result.status === "approved" || result.status === "rejected" ? `decided: ${result.status}` : `approval was already ${result.status}`, ["answered"]);
    return { call: this.mustGet(id), approvalStatus: result.status };
  }

  /* ---------------- outgoing ---------------- */

  /** The user calls Helix. Already connected: returns the route to speak into. */
  async startOutgoing(opts: { sessionId?: string; title?: string; provider?: ProviderName }, deviceId: string): Promise<Call> {
    const chat = opts.provider === "codex";
    const route = await this.deps.router.createRoute(opts.title ?? (chat ? "Astra" : "General Claude"), opts.provider);
    let title = opts.title ?? (chat ? "Call Astra" : "Call Claude");
    if (opts.sessionId) {
      const h = await this.deps.router.handoff(route.id, { session: opts.sessionId });
      title = `Call ${h.session.title}`;
    }
    const id = randomUUID();
    const now = new Date(this.now()).toISOString();
    // For an outgoing call the "script" is the greeting to say once connected (in the user's chosen personality).
    const greeting = this.deps.persona?.greeting() ?? "";
    this.db.prepare(
      `INSERT INTO calls (id, direction, status, severity, title, summary, script, expects, session_id, route_id, device_id, created_at, answered_at)
       VALUES (?, 'outgoing', 'answered', 'info', ?, '', ?, 'conversation', ?, ?, ?, ?, ?)`
    ).run(id, title, greeting, opts.sessionId ?? null, route.id, deviceId, now, now);
    const call = { ...this.mustGet(id), ringbackMs: this.ringbackMs() };
    this.bus.publish({ type: "call.answered", call });
    return call;
  }

  ringbackMs(): number {
    return Math.round(RINGBACK_MIN_MS + this.random() * (RINGBACK_MAX_MS - RINGBACK_MIN_MS));
  }

  /** The call this conversation is on, if it is on one right now. */
  activeCallForRoute(routeId: string): Call | undefined {
    const r = this.db.prepare("SELECT * FROM calls WHERE route_id = ? AND status = 'answered' ORDER BY created_at DESC LIMIT 1").get(routeId) as Row | undefined;
    return r && toCall(r);
  }

  /**
   * The call an agent is speaking on. A Helix-run session is found by being the conversation's current session; a terminal
   * session has no identity of its own on the shared credential, so it is the user's most recent answered conversation call.
   */
  activeCallForSession(sessionId?: string): Call | undefined {
    if (sessionId) {
      for (const call of this.answeredConversations()) {
        const route = call.routeId ? this.deps.router.get(call.routeId) : undefined;
        if (route && (route.currentSessionId === sessionId || route.routerSessionId === sessionId)) return call;
      }
      return undefined;
    }
    return this.answeredConversations()[0];
  }

  private answeredConversations(): Call[] {
    return (this.db.prepare("SELECT * FROM calls WHERE status = 'answered' AND expects = 'conversation' AND route_id IS NOT NULL ORDER BY created_at DESC").all() as Row[]).map(toCall);
  }

  /**
   * Hang up once the next reply has been spoken ("goodbye, talk later" -> "Bye!" -> the line goes quiet). The phone is told
   * so it can finish speaking and end the call itself; the gateway ends it too after a short while, whichever comes first.
   */
  hangUpAfterReply(callId: string): boolean {
    const call = this.get(callId);
    if (!call || call.status !== "answered") return false;
    if (this.hangups.has(callId)) return true;
    // No reply at all (the agent is stuck or silent): do not leave the line open for ever.
    const fallback = setTimeout(() => this.finishHangup(callId), 90_000);
    fallback.unref();
    this.hangups.set(callId, fallback);
    this.bus.publish({ type: "call.hangup", call, afterSpeech: true });
    return true;
  }

  private finishHangup(callId: string): void {
    const t = this.hangups.get(callId);
    if (t) clearTimeout(t);
    this.hangups.delete(callId);
    this.end(callId, "hung up after goodbye");
  }

  /* ---------------- queries ---------------- */

  get(id: string): Call | undefined {
    const r = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as Row | undefined;
    return r && toCall(r);
  }

  mustGet(id: string): Call {
    const c = this.get(id);
    if (!c) throw new GatewayError(404, "call not found");
    return c;
  }

  list(limit = 50): Call[] {
    return (this.db.prepare("SELECT * FROM calls ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(toCall);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.hangups.values()) clearTimeout(t);
    this.timers.clear();
    this.hangups.clear();
  }

  /* ---------------- internals ---------------- */

  private notRinging(id: string): GatewayError {
    const c = this.get(id);
    return c ? new GatewayError(409, `call is no longer ringing (${c.status})`) : new GatewayError(404, "call not found");
  }

  /** Atomic status change; only moves a call out of one of the allowed states. Returns whether it changed. */
  private finish(id: string, status: CallStatus, reason: string, from: CallStatus[], deviceId?: string): boolean {
    const marks = from.map(() => "?").join(",");
    const changed = this.db.prepare(
      `UPDATE calls SET status = ?, ended_at = ?, end_reason = ?, device_id = COALESCE(device_id, ?) WHERE id = ? AND status IN (${marks})`
    ).run(status, new Date(this.now()).toISOString(), reason, deviceId ?? null, id, ...from).changes === 1;
    if (changed) {
      this.clearTimer(id);
      this.bus.publish({ type: "call.ended", call: this.mustGet(id) });
    }
    return changed;
  }

  private armRingTimer(id: string): void {
    const t = setTimeout(() => {
      this.timers.delete(id);
      if (!this.finish(id, "missed", "not answered", ["ringing"])) return;
      const c = this.mustGet(id);
      // Tell them by ordinary push so a missed call is never silently lost.
      void this.deps.push?.deliver({
        severity: "important", title: `Missed call: ${c.title}`.slice(0, 80), body: c.summary, sessionId: c.sessionId,
        dedupeKey: `missed:${id}`, approvalId: c.approvalId, kind: "missed_call",
      } satisfies Notice).catch(() => undefined);
    }, this.opts.ringTimeoutMs ?? 30_000);
    t.unref();
    this.timers.set(id, t);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }
}

/** The "call" channel of the escalation policy. */
export class CallNotifier implements Notifier {
  constructor(private readonly calls: CallManager) {}
  async deliver(n: Notice): Promise<void> {
    await this.calls.ringIncoming({ severity: n.severity, title: n.title, summary: n.body, sessionId: n.sessionId, approvalId: n.approvalId });
  }
}
