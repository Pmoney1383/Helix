import type { Db } from "../storage/sqlite.js";

export type Channel = "message" | "push" | "call";
export type NoticeSeverity = "info" | "important" | "critical";

export interface Notice {
  severity: NoticeSeverity;
  title: string;
  body: string;
  sessionId?: string;
  /** Identifies "the same problem" for rate limiting (e.g. the watch id). */
  dedupeKey: string;
  eventId?: string;
  /** Set when the notice is an approval request: calls then ask for a spoken approve/reject. */
  approvalId?: string;
  kind?: "event" | "approval" | "missed_call";
}

export interface Notifier {
  deliver(notice: Notice): Promise<void>;
}

/** Thrown by a notifier that has nothing to deliver to right now (no phone set up or connected): recorded as "unavailable". */
export class ChannelUnavailable extends Error {}

export type DeliveryStatus = "delivered" | "unavailable" | "suppressed" | "failed";
export interface Delivery { channel: Channel; status: DeliveryStatus; reason?: string }

export type EscalationPolicy = Record<NoticeSeverity, Channel[]>;

/**
 * INFO       -> in-app message only (no buzz)
 * IMPORTANT  -> message + visible push
 * CRITICAL   -> message + push + incoming call
 * Push and calls reach an iPhone through Apple push and an Android phone through its live connection. With neither
 * available they are recorded as "unavailable" so the policy is already in force and visible in the log.
 */
export const DEFAULT_POLICY: EscalationPolicy = {
  info: ["message"],
  important: ["message", "push"],
  critical: ["message", "push", "call"],
};

export interface EscalationOptions {
  policy?: EscalationPolicy;
  /**
   * When set, phone calls are only placed while the user is away from the PC.
   * In-app messages and pushes are always delivered, wherever the user is. Without it, everything is sent.
   */
  presence?: { isAway(): boolean; status(): { reason: string } };
  /** A given problem may ring at most once per this window. */
  callCooldownMs?: number;
  /** Across all problems, at most this many calls per rolling hour. */
  maxCallsPerHour?: number;
  now?: () => number;
}

export class Escalation {
  private readonly policy: EscalationPolicy;
  private readonly callCooldownMs: number;
  private readonly maxCallsPerHour: number;
  private readonly now: () => number;
  private readonly presence?: EscalationOptions["presence"];
  private readonly lastCall = new Map<string, number>();
  private callTimes: number[] = [];

  constructor(
    private readonly db: Db,
    private readonly channels: Partial<Record<Channel, Notifier>>,
    opts: EscalationOptions = {}
  ) {
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.callCooldownMs = opts.callCooldownMs ?? 15 * 60_000;
    this.maxCallsPerHour = opts.maxCallsPerHour ?? 3;
    this.now = opts.now ?? (() => Date.now());
    this.presence = opts.presence;
  }

  /** `skip` omits channels the caller has already covered (e.g. an in-app message that was posted separately). */
  async notify(n: Notice, opts: { skip?: Channel[] } = {}): Promise<Delivery[]> {
    const results: Delivery[] = [];
    for (const channel of this.policy[n.severity]) {
      if (opts.skip?.includes(channel)) continue;
      const d = await this.deliverOne(channel, n);
      results.push(d);
      this.record(n, d);
    }
    return results;
  }

  private async deliverOne(channel: Channel, n: Notice): Promise<Delivery> {
    const notifier = this.channels[channel];
    if (!notifier) return { channel, status: "unavailable", reason: `${channel} channel is not configured yet` };
    // Only the ring is presence-gated: a push is silent enough to send even while the user sits at the PC.
    if (channel === "call" && this.presence && !this.presence.isAway()) {
      return { channel, status: "suppressed", reason: `not sent: ${this.presence.status().reason}` };
    }

    if (channel === "call") {
      const now = this.now();
      this.callTimes = this.callTimes.filter((t) => now - t < 3_600_000);
      const last = this.lastCall.get(n.dedupeKey);
      if (last !== undefined && now - last < this.callCooldownMs) {
        return { channel, status: "suppressed", reason: "already called about this recently" };
      }
      if (this.callTimes.length >= this.maxCallsPerHour) {
        return { channel, status: "suppressed", reason: `call limit (${this.maxCallsPerHour}/hour) reached` };
      }
      this.lastCall.set(n.dedupeKey, now);
      this.callTimes.push(now);
    }

    try {
      await notifier.deliver(n);
      return { channel, status: "delivered" };
    } catch (err) {
      if (err instanceof ChannelUnavailable) return { channel, status: "unavailable", reason: err.message };
      return { channel, status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private record(n: Notice, d: Delivery): void {
    this.db
      .prepare("INSERT INTO notifications (ts, event_id, channel, status, severity, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(new Date(this.now()).toISOString(), n.eventId ?? null, d.channel, d.status, n.severity, n.title, d.reason ?? null);
  }
}
