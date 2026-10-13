import type { EventBus } from "../sessions/manager.js";
import { ChannelUnavailable, type Notice, type Notifier } from "./escalation.js";
import type { LiveDevices } from "./live-devices.js";

/**
 * The "push" channel for Android phones: a `device.notification` event on the live connection, which the app's foreground
 * service shows as a notification. Delivered only when an Android phone is connected right now; otherwise unavailable.
 */
export class LivePushNotifier implements Notifier {
  constructor(private readonly bus: EventBus, private readonly live: LiveDevices) {}

  async deliver(n: Notice): Promise<void> {
    if (this.live.count("android") === 0) throw new ChannelUnavailable("no Android phone is connected");
    this.bus.publish({
      type: "device.notification",
      notification: { title: n.title, body: n.body, severity: n.severity, kind: n.kind ?? "event", sessionId: n.sessionId, approvalId: n.approvalId, eventId: n.eventId },
    });
  }
}

/**
 * Delivers to every notifier (Apple push and Android). Delivered when at least one of them delivered; unavailable when none
 * of them could even try; otherwise it failed, with every reason.
 */
export class FanOutNotifier implements Notifier {
  constructor(private readonly notifiers: Notifier[]) {}

  async deliver(n: Notice): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((x) => x.deliver(n)));
    if (results.some((r) => r.status === "fulfilled")) return;
    const errors = results.map((r) => (r as PromiseRejectedResult).reason);
    const reasons = errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    if (errors.every((e) => e instanceof ChannelUnavailable)) throw new ChannelUnavailable(reasons || "no channel is configured");
    throw new Error(reasons);
  }
}
