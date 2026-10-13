import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../mcp/scopes.js";
import { viewerProbeHtml } from "./viewer-probe-ui.js";
import { registerRemoteProbe } from "./viewer-remote.js";

export const VIEWER_PROBE_URI = "ui://helix/viewer-probe/v3.html";
const TTL = 5 * 60_000;

/** Synthetic diagnostics only: no capture, input, controlId, or frameId access. */
export class ViewerProbe {
  private readonly tickets = new Map<string, { identity: string; expires: number }>();
  private sockets = 0;
  constructor(private readonly allowed: (identity: string) => boolean, private readonly now = Date.now) {}
  issue(identity: string): string {
    if (!this.allowed(identity)) throw new Error("Desktop access is disabled.");
    for (const [key, ticket] of this.tickets) if (ticket.expires <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 32) this.tickets.delete(this.tickets.keys().next().value!);
    const key = randomBytes(32).toString("base64url");
    this.tickets.set(key, { identity, expires: this.now() + TTL });
    return key;
  }
  valid(key: unknown): boolean {
    if (typeof key !== "string") return false;
    const ticket = this.tickets.get(key);
    return !!ticket && ticket.expires > this.now() && this.allowed(ticket.identity);
  }
  registerRoutes(app: FastifyInstance): void {
    registerRemoteProbe(app, ticket => this.valid(ticket));
    const key = (req: FastifyRequest) => (req.query as { ticket?: string }).ticket;
    // No cookie credentials; the short-lived ticket permits synthetic diagnostics only.
    app.get("/mcp/viewer-probe/ping", { logLevel: "silent" }, async (req, reply) => {
      reply.header("access-control-allow-origin", "*").header("cache-control", "no-store");
      if (!this.valid(key(req))) return reply.code(401).send({ error: "Probe expired or access revoked. Open a new viewer test." });
      return { synthetic: true, serverTime: this.now() };
    });
    app.get("/mcp/viewer-probe/stream", {
      websocket: true, logLevel: "silent",
      preValidation: async (req, reply) => {
        if (!this.valid(key(req))) return reply.code(401).send({ error: "Probe expired or access revoked." });
        if (this.sockets >= 4) return reply.code(429).send({ error: "Too many viewer tests." });
      },
    }, (socket, req) => {
      this.sockets++;
      let seq = 0, messages = 0;
      const started = this.now();
      const timer = setInterval(() => {
        messages = 0;
        if (!this.valid(key(req)) || this.now() - started >= 30_000) { socket.close(1000, "Probe ended"); return; }
        if (socket.bufferedAmount > 4096) { socket.close(1008, "Slow viewer"); return; }
        socket.send(JSON.stringify({ type: "tick", seq: ++seq }));
      }, 250);
      socket.on("message", (bytes) => {
        if (!this.valid(key(req)) || ++messages > 4 || bytes.toString().length > 128) { socket.close(1008, "Invalid probe message"); return; }
        try {
          const message = JSON.parse(bytes.toString());
          if (message.type === "ping" && Number.isFinite(message.id)) socket.send(JSON.stringify({ type: "pong", id: message.id }));
        } catch { socket.close(1008, "Invalid JSON"); }
      });
      socket.once("close", () => { clearInterval(timer); this.sockets--; });
      socket.on("error", () => socket.terminate());
    });
  }
}

export function registerViewerProbe(server: McpServer, ctx: McpContext, probe?: ViewerProbe, publicUrl?: string): void {
  if (!probe || !ctx.desktopAllowed || !ctx.desktopIdentity) return;
  const origin = publicUrl ? new URL(publicUrl).origin : undefined;
  const wsOrigin = origin?.replace(/^http/, "ws");
  server.registerResource("helix-viewer-probe", VIEWER_PROBE_URI, {}, async () => ({ contents: [{
    uri: VIEWER_PROBE_URI, mimeType: "text/html;profile=mcp-app", text: viewerProbeHtml(),
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: origin ? [origin, wsOrigin!] : [], resourceDomains: [] } },
      "openai/widgetCSP": { connect_domains: origin ? [origin, wsOrigin!] : [], resource_domains: [] },
      "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "inline" },
      "openai/widgetDescription": "Helix synthetic viewer compatibility test. No actual desktop video. Results require the user to run the test.",
    },
  }] }));
  server.registerTool("test_desktop_viewer", {
    title: "Test Helix Live Desktop Viewer",
    description: "Open a small synthetic viewer compatibility test in ChatGPT. Tests the embedded UI, gateway HTTPS/WebSocket connectivity, and local WebRTC video playback. Does not capture or control the PC. Does not verify remote WebRTC or desktop latency. Ask the user to press Run test and report the results on web and mobile.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    // The card calls this tool itself on every Run to get a fresh ticket.
    _meta: { ui: { resourceUri: VIEWER_PROBE_URI, visibility: ["model", "app"] }, "openai/outputTemplate": VIEWER_PROBE_URI, "openai/widgetAccessible": true },
  }, async () => ({
    content: [{ type: "text", text: "Viewer test ready. Press Run test in the Helix card. This uses synthetic video only; it has not yet tested this client. Repeat on web and mobile. Network timings are round trips, not desktop video latency." }],
    structuredContent: { synthetic: true, durationSeconds: 20, networkConfigured: !!origin },
    _meta: { viewerProbe: { origin, ticket: probe.issue(ctx.desktopIdentity!) } },
  }));
}
