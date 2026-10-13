import type { EventBus } from "../sessions/manager.js";
import type { MessageStore } from "../sessions/registry.js";
import type { Notice, Notifier } from "./escalation.js";

/** In-app delivery: stored in the conversation and pushed to connected devices over the WebSocket. */
export class MessageNotifier implements Notifier {
  constructor(private readonly messages: MessageStore, private readonly bus: EventBus) {}

  async deliver(n: Notice): Promise<void> {
    const m = this.messages.add({
      conversationId: n.sessionId ?? "general",
      sessionId: n.sessionId,
      sender: "system",
      type: "event",
      severity: n.severity,
      text: n.body ? `${n.title}\n${n.body}` : n.title,
      metadata: n.eventId ? { eventId: n.eventId } : undefined,
    });
    this.bus.publish({ type: "message.created", message: m });
  }
}
