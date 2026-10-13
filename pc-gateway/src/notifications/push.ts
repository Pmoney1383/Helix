import type { ApnsClient } from "./apns.js";
import type { DeviceTokens } from "./devices.js";
import type { Notice, Notifier } from "./escalation.js";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";

/**
 * The "push" channel: a visible notification on every registered phone. Only a short preview travels
 * through Apple (title and the first line of the detail); the full text lives in the app, fetched from the
 * gateway after the user opens it.
 */
export class PushNotifier implements Notifier {
  constructor(
    private readonly apns: ApnsClient,
    private readonly devices: DeviceTokens,
    private readonly log?: { warn?: (o: object, m: string) => void }
  ) {}

  async deliver(n: Notice): Promise<void> {
    const tokens = this.devices.tokensFor("alert");
    if (tokens.length === 0) throw new Error("no phone has registered for push notifications");

    const payload = {
      aps: {
        alert: { title: clip(n.title, 80), body: clip(firstLine(n.body), 140) },
        sound: "default",
        "thread-id": n.sessionId ?? "helix",
        // time-sensitive breaks through Focus without needing Apple's critical-alert entitlement
        "interruption-level": n.severity === "critical" ? "time-sensitive" : "active",
        // the app registers this category with Approve / Reject buttons for the lock screen
        ...(n.kind === "approval" ? { category: "helix.approval" } : {}),
      },
      helix: { kind: n.kind ?? "event", severity: n.severity, eventId: n.eventId, sessionId: n.sessionId, approvalId: n.approvalId },
    };

    const failures: string[] = [];
    let delivered = 0;
    await Promise.all(tokens.map(async (t) => {
      const r = await this.apns.send({
        token: t.token, environment: t.environment, kind: "alert", payload,
        priority: n.severity === "info" ? 5 : 10, collapseId: n.approvalId ? `approval-${n.approvalId}`.slice(0, 64) : undefined, ttlSeconds: 3600,
      });
      if (r.ok) { delivered++; return; }
      if (r.invalidToken) this.devices.invalidate(t.token);
      failures.push(`${r.status || "network"} ${r.reason ?? ""}`.trim());
      this.log?.warn?.({ status: r.status, reason: r.reason }, "push failed");
    }));
    if (delivered === 0) throw new Error(`push not delivered: ${failures.join("; ")}`);
  }
}
