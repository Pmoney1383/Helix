import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PersonaService } from "../persona/service.js";
import { voiceOptions } from "../voice/voice-opts.js";
import { VOICE_SEVERITIES } from "../persona/types.js";
import type { RouterService } from "../router/router.js";
import type { SessionManager } from "../sessions/manager.js";
import { GatewayError } from "../sessions/manager.js";
import type { LiveDevices } from "../notifications/live-devices.js";
import type { AuthService } from "./auth.js";
import { requireDevice } from "./auth.js";

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), sessionId: z.string(), confirmHeavy: z.boolean().optional(), text: z.string().min(1).max(100_000), clientId: z.string().optional(), voice: z.boolean().optional(), voiceSeverity: z.enum(VOICE_SEVERITIES as [string, ...string[]]).optional(), engine: z.enum(["apple", "pc"]).optional() }),
  z.object({ type: z.literal("interrupt"), sessionId: z.string() }),
  z.object({ type: z.literal("route.send"), routeId: z.string(), text: z.string().min(1).max(100_000), clientId: z.string().optional(), voice: z.boolean().optional(), voiceSeverity: z.enum(VOICE_SEVERITIES as [string, ...string[]]).optional(), engine: z.enum(["apple", "pc"]).optional() }),
  z.object({ type: z.literal("route.interrupt"), routeId: z.string() }),
  z.object({ type: z.literal("ping") }),
]);

/**
 * One socket per device. The server pushes every gateway event to every connected device
 * (single-user system), and accepts send/interrupt commands. History for reconnects comes
 * from GET /v1/conversations/:id/messages?after=<seq>.
 */
export function registerWebSocket(app: FastifyInstance, auth: AuthService, manager: SessionManager, router?: RouterService, persona?: PersonaService, live?: LiveDevices): void {
  app.get("/v1/ws", { websocket: true, preValidation: requireDevice(auth) }, (socket, req) => {
    const device = req.device!;
    let ended = false;
    let unsubscribeBus = () => {};
    let disconnect = () => {};
    let unsubscribeAuth = () => {};
    let closeTimer: NodeJS.Timeout | undefined;
    const unsubscribe = () => {
      if (ended) return;
      ended = true;
      unsubscribeBus(); disconnect(); unsubscribeAuth();
    };
    const invalidate = () => {
      unsubscribe();
      socket.close(1008, "Device authorization changed; reconnect.");
      closeTimer ??= setTimeout(() => socket.terminate(), 1000);
      closeTimer.unref();
    };
    const authorized = () => {
      if (ended) return false;
      try { if (auth.isCurrentDevice(device)) return true; } catch { /* database unavailable: fail closed */ }
      invalidate();
      return false;
    };
    const send = (obj: unknown) => {
      if (authorized() && socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    socket.on("close", () => { if (closeTimer) clearTimeout(closeTimer); unsubscribe(); });
    socket.on("error", unsubscribe);
    unsubscribeAuth = auth.onDeviceChanged((id) => { if (id === device.id) invalidate(); });
    // Trust may have changed between upgrade validation and installing this connection's listeners.
    if (!authorized()) return;
    send({ type: "hello", deviceId: device.id });
    unsubscribeBus = manager.bus.subscribe((event) => send(event));
    // While this socket is open the phone can be notified and rung through it (Android has no Apple push).
    disconnect = live?.connect(device.id, device.platform) ?? (() => {});

    socket.on("message", (raw) => {
      if (!authorized()) return;
      let parsed: z.infer<typeof clientMessage>;
      try {
        parsed = clientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        send({ type: "error", error: "invalid message" });
        return;
      }
      try {
        if (parsed.type === "ping") send({ type: "pong" });
        else if (parsed.type === "route.send" || parsed.type === "route.interrupt") {
          if (!router) throw new GatewayError(501, "routing is not enabled");
          if (parsed.type === "route.interrupt") router.interrupt(parsed.routeId);
          else {
            const accepted = router.send(parsed.routeId, parsed.text, voiceOptions(persona, parsed, router.voiceSeverity(parsed.routeId)));
            auth.audit(device?.id, "route.message", { routeId: parsed.routeId, sessionId: accepted.sessionId, chars: parsed.text.length });
            send({ type: "send.accepted", clientId: parsed.clientId, routeId: parsed.routeId, ...accepted });
          }
        } else if (parsed.type === "interrupt") {
          const interrupted = manager.interrupt(parsed.sessionId);
          auth.audit(device?.id, "session.interrupt", { sessionId: parsed.sessionId, interrupted });
        } else {
          const accepted = manager.send(parsed.sessionId, parsed.text, voiceOptions(persona, parsed, "normal", "session"), parsed.confirmHeavy === true);
          auth.audit(device?.id, "session.message", { sessionId: parsed.sessionId, chars: parsed.text.length });
          send({ type: "send.accepted", clientId: parsed.clientId, ...accepted });
        }
      } catch (err) {
        const status = err instanceof GatewayError ? err.statusCode : 500;
        send({ type: "error", status, error: err instanceof Error ? err.message : "error", ...(err instanceof GatewayError ? err.details : {}), clientId: "clientId" in parsed ? parsed.clientId : undefined });
      }
    });
  });
}
