import { randomBytes, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { MediaStreamTrack, RTCPeerConnection, RtpPacket, useH264, type RTCIceServer } from "werift";
import type { ComputerController } from "./controller.js";
import { liveViewerHtml } from "./live-viewer-ui.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const LIVE_VIEWER_URI = "ui://helix/live-desktop/v4.html";
/** The independent "Helix Live" thread panel: opened by the user, not by a tool call the model made. */
export const LIVE_PANEL_URI = "ui://helix/live-panel/v1.html";
export const LIVE_PANEL_TOOL = "helix_live_panel";
/** Deliberately omit addresses, SDP and ICE credentials. */
export function transportHealth(pc: RTCPeerConnection) {
  return { ice: pc.iceConnectionState, connection: pc.connectionState, transports: pc.iceTransports.map(t => {
    const pair = t.connection.nominated;
    return { state: t.state, selected: !!pair, localType: pair?.localCandidate.type, remoteType: pair?.remoteCandidate.type,
      protocol: pair?.localCandidate.transport, consentRequests: pair?.consentRequestsSent,
      responsesReceived: pair?.responsesReceived, packetsSent: pair?.packetsSent, packetsReceived: pair?.packetsReceived };
  }) };
}
/** Error text only: never log raw request URLs, SDP, ICE candidates or tool arguments. */
export function viewerError(value: unknown): string {
  return (value instanceof Error ? `${value.name}: ${value.message}` : String(value))
    .replace(/(?:https?|wss?|turns?|stuns?|rtp):\/\/[^\s"']+/gi, '[endpoint]')
    .replace(/(ticket|token|credential|password|secret)([=:\s]+)[^\s,;"']+/gi, '$1$2[redacted]')
    .replace(/(["'](?:ticket|token|credential|password|secret)["']\s*:\s*)["'][^"']*["']/gi, '$1"[redacted]"')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '[user]')
    .replace(/(?:^|\n)[a-z]=[^\n]*/g, '\n[SDP redacted]')
    .slice(0, 4096);
}
/** `seat` counts the cards issued for this session: the highest one is the card the user can currently see. */
interface Session { identity: string; controlId: string; seat: number; socket?: WebSocket; cleanup?: () => void; pinnedSeat?: number; pinOwner?: "panel"; panelKeys?: Set<string>; pinTimer?: NodeJS.Timeout }
/** Close code telling a card a newer card took the stream over: stop quietly, never reconnect. */
export const VIEWER_REPLACED = 4410;
/** Close code telling a newer card the stream stays with the card the user popped out: show a note, never reconnect. */
export const VIEWER_POPPED_OUT = 4411;
/** How long a popped-out card may be gone (reconnecting) before newer cards can take the stream again. */
const PIN_GRACE_MS = 15_000;
/** Shown by a card that is turned away because the stream is already somewhere the user chose. */
/** Close code for a panel claim that was not issued by the app-only panel tool. */
export const VIEWER_FORBIDDEN = 4403;
const POPOUT_NOTE = "Live desktop is playing in the pop-out window.";
const PANEL_NOTE = "Live desktop is playing in the Helix Live panel.";
export interface ViewerControl {
  isActive(identity: string, controlId: string): boolean;
  /** The control session this identity holds right now, without renewing it. */
  activeControlId?(identity: string): string | undefined;
  onStopped(listener: (controlId: string) => void): () => void;
  startViewer(identity: string, controlId: string, port: number, format?: 'rtp' | 'jpeg'): Promise<{ ok: boolean; error?: string }>;
  stopViewer(identity: string, controlId: string): Promise<void>;
  viewerStatus?(identity: string, controlId: string): Promise<{ ok: boolean; running?: unknown; exitCode?: unknown; stderr?: unknown; error?: string }>;
}

/** A spectator capability is valid only for the control session that created it. */
export class LiveDesktopViewer {
  private readonly sessions = new Map<string, Session>();
  private readonly unsubscribe: () => void;
  constructor(private readonly control: ViewerControl | ComputerController, readonly iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }]) {
    this.unsubscribe = control.onStopped(id => {
      for (const [ticket, session] of this.sessions) if (session.controlId === id) {
        if (session.socket) this.log?.("VIEWER_ENDED_WITH_CONTROL", { reason: "desktop control stopped" });
        this.sessions.delete(ticket);
        this.send(session.socket, { type: "ended" });
        session.cleanup?.();
      }
    });
  }
  issue(identity: string, controlId: string): { ticket: string; seat: number; iceServers: RTCIceServer[] } {
    if (!this.control.isActive(identity, controlId)) throw new Error("Desktop control ended.");
    for (const [ticket, session] of this.sessions) {
      if (session.identity === identity && session.controlId === controlId) return { ticket, seat: ++session.seat, iceServers: this.iceServers };
      if (!this.control.isActive(session.identity, session.controlId)) { session.cleanup?.(); this.sessions.delete(ticket); }
    }
    const ticket = randomBytes(32).toString("base64url");
    this.sessions.set(ticket, { identity, controlId, seat: 1 });
    return { ticket, seat: 1, iceServers: this.iceServers };
  }
  /**
   * What the Helix Live panel asks for: a viewer ticket for the control session this identity already holds. It never
   * starts control, never renews the lease, and starts no capture: with no active session there is nothing to see.
   */
  /** Whether this identity holds a control session. Issues nothing: no ticket, no key, no seat. */
  hasActiveControl(identity: string): boolean { return !!this.control.activeControlId?.(identity); }
  issuePanel(identity: string): { active: false } | { active: true; ticket: string; seat: number; panelKey: string; iceServers: RTCIceServer[] } {
    const controlId = this.control.activeControlId?.(identity);
    if (!controlId) return { active: false };
    try {
      const issued = this.issue(identity, controlId);
      // Panel priority is something only this app-only tool can hand out: a random key the socket must present. A tool card's
      // ticket and seat are not enough, and a query flag alone means nothing. Issuing never moves the stream; only a connect does.
      const session = this.sessions.get(issued.ticket)!, panelKey = randomBytes(16).toString("base64url");
      session.panelKeys ??= new Set();
      session.panelKeys.add(panelKey);
      if (session.panelKeys.size > 8) session.panelKeys.delete(session.panelKeys.values().next().value as string);
      return { active: true, ...issued, panelKey };
    } catch { return { active: false }; }
  }
  /**
   * The newest card owns the stream. ChatGPT hides a card when the model makes its next call and shows the new call's
   * card, so the new one takes over; an older card (lower seat) is turned away for good, so the two never fight.
   */
  /** What the card says happened to it: tells "ChatGPT tore it down / hid it" apart from "Helix dismissed it". */
  private cardEvent(app: FastifyInstance, diagnosticId: string, m: { event?: unknown; detail?: unknown }): void {
    if (typeof m.event !== "string") return;
    app.log.info({ component: "live-desktop", diagnosticId, code: "CARD_EVENT", event: m.event.slice(0, 40), detail: viewerError(m.detail ?? "").slice(0, 200) }, "Live desktop card");
  }
  private log?: (code: string, detail: Record<string, unknown>) => void;
  private async claim(session: Session, seat: number, socket: WebSocket, panelKey?: string): Promise<boolean> {
    const panel = panelKey !== undefined;
    if (panel && !session.panelKeys?.has(panelKey)) {
      this.log?.("PANEL_CLAIM_REFUSED", { seat });
      socket.close(VIEWER_FORBIDDEN, "Not a Helix Live panel ticket"); return false;
    }
    if (panel) {
      // The user's own panel owns the stream. Only a newer panel can take it; tool cards never do.
      if (session.pinOwner === "panel" && session.pinnedSeat !== undefined && seat < session.pinnedSeat && session.socket) {
        this.log?.("VIEWER_REFUSED_OLDER", { seat, latest: session.pinnedSeat, owner: "panel" });
        socket.close(VIEWER_POPPED_OUT, PANEL_NOTE); return false;
      }
      session.pinnedSeat = seat; session.pinOwner = "panel"; clearTimeout(session.pinTimer);
      this.log?.("PANEL_OWNS_STREAM", { seat });
    }
    // A card the user popped out keeps the stream until they close the pop-out or control ends.
    if (session.pinnedSeat !== undefined && seat !== session.pinnedSeat) {
      this.log?.("VIEWER_KEPT_POPOUT", { seat, pinnedSeat: session.pinnedSeat, owner: session.pinOwner ?? "card" });
      socket.close(VIEWER_POPPED_OUT, session.pinOwner === "panel" ? PANEL_NOTE : POPOUT_NOTE); return false;
    }
    if (seat < session.seat && seat !== session.pinnedSeat) { this.log?.("VIEWER_REFUSED_OLDER", { seat, latest: session.seat }); socket.close(VIEWER_REPLACED, "Replaced by a newer viewer"); return false; }
    const old = session.socket;
    if (old && old !== socket) {
      this.log?.("VIEWER_REPLACED", { bySeat: seat });
      old.close(panel ? VIEWER_POPPED_OUT : VIEWER_REPLACED, panel ? PANEL_NOTE : "Replaced by a newer viewer"); session.cleanup?.();
      // The old encoder must stop before a new one starts.
      for (let i = 0; i < 50 && session.socket; i++) await new Promise(r => setTimeout(r, 100));
    }
    if (session.pinnedSeat !== undefined && seat !== session.pinnedSeat) { socket.close(VIEWER_POPPED_OUT, session.pinOwner === "panel" ? PANEL_NOTE : POPOUT_NOTE); return false; }
    if (seat < session.seat && seat !== session.pinnedSeat) { socket.close(VIEWER_REPLACED, "Replaced by a newer viewer"); return false; }
    if (session.pinnedSeat === seat) clearTimeout(session.pinTimer);
    return true;
  }
  /** pin: the card was popped out. unpin: the pop-out was closed. Anything else is not a pin message. */
  private pinMessage(session: Session, seat: number, m: { type?: unknown }): boolean {
    // The panel's ownership is not the card's to take or give back.
    if ((m.type === "pin" || m.type === "unpin") && session.pinOwner === "panel" && session.pinnedSeat !== seat) return true;
    if (m.type === "pin") { session.pinnedSeat = seat; clearTimeout(session.pinTimer); this.log?.("VIEWER_POPPED_OUT", { seat }); return true; }
    if (m.type === "unpin") { if (session.pinnedSeat === seat) { session.pinnedSeat = undefined; session.pinOwner = undefined; } this.log?.("VIEWER_POP_OUT_CLOSED", { seat }); return true; }
    return false;
  }
  /** A popped-out card that drops gets a short grace to reconnect; if it never does, newer cards may take over. */
  private pinDropped(session: Session, seat: number): void {
    if (session.pinnedSeat !== seat) return;
    clearTimeout(session.pinTimer);
    session.pinTimer = setTimeout(() => {
      if (session.pinnedSeat === seat && !session.socket) { session.pinnedSeat = undefined; session.pinOwner = undefined; this.log?.("VIEWER_POP_OUT_LOST", { seat }); }
    }, PIN_GRACE_MS);
    session.pinTimer.unref();
  }
  private get(ticket: unknown): Session | undefined {
    if (typeof ticket !== "string") return;
    const session = this.sessions.get(ticket);
    return session && this.control.isActive(session.identity, session.controlId) ? session : undefined;
  }
  private send(socket: WebSocket | undefined, value: unknown): void {
    if (socket?.readyState === 1 && socket.bufferedAmount < 65_536) socket.send(JSON.stringify(value));
  }
  registerRoutes(app: FastifyInstance): void {
    this.log = (code, detail) => app.log.info({ component: "live-desktop", code, ...detail }, "Live desktop viewer");
    this.registerCompatibilityRoute(app);
    app.get("/mcp/live-desktop/signal", {
      websocket: true, logLevel: "silent",
      preValidation: async (req, reply) => {
        const session = this.get((req.query as { ticket?: string }).ticket);
        if (req.headers.upgrade?.toLowerCase() === 'websocket') return; // Explicit lifecycle message instead of an opaque browser handshake error.
        if (!session) return reply.code(410).send({ error: "Desktop control ended." });
        if (session.socket) return reply.code(409).send({ error: "Viewer already connected." });
      },
    }, async (socket, req) => {
      const query = req.query as { ticket?: string; seat?: string; panel?: string };
      const first = this.get(query.ticket);
      if (!first) { this.send(socket, { type: "ended" }); socket.close(4404, "Desktop control ended"); return; }
      const seat = query.seat === undefined ? first.seat : Number(query.seat);
      if (!(await this.claim(first, seat, socket, query.panel))) return;
      this.log?.("VIEWER_CONNECTED", { seat, stream: "webrtc" });
      const session = this.get(query.ticket);
      if (!session) { this.send(socket, { type: "ended" }); socket.close(4404, "Desktop control ended"); return; }
      if (session.socket) { this.send(socket, { type: "error", code: "VIEWER_BUSY", message: "Previous viewer connection is still closing." }); socket.close(4409, "Viewer busy"); return; }
      const diagnosticId = randomUUID();
      const log = (code: string, message: string, detail?: unknown) => app.log.warn({ component: 'live-desktop', diagnosticId, code, message, ...(detail === undefined ? {} : { detail: viewerError(detail) }) }, 'Live desktop diagnostic');
      session.socket = socket;
      const pc = new RTCPeerConnection({ codecs: { video: [useH264({ payloadType: 96 })] }, iceServers: this.iceServers });
      const track = new MediaStreamTrack({ kind: "video" });
      const sender = pc.addTrack(track);
      const connectedAt = Date.now();
      let captureTask: Promise<void> | undefined;
      let udp: dgram.Socket | undefined, closed = false, starting = false, started = false, lastPacket = Date.now(), messages = 0, source: number | undefined, inFlight = 0;
      const cleanup = () => {
        if (closed) return; closed = true; clearInterval(timer);
        try { udp?.close(); } catch { /* already closed */ }
        track.stop(); void pc.close().catch(() => {}); socket.close(1000, "Viewer closed");
        // Do not allow a reconnect to start a new encoder until this encoder has stopped.
        void Promise.resolve(captureTask).then(async () => {
          if (started || starting) await this.control.stopViewer(session.identity, session.controlId);
        }).catch(() => {}).finally(() => {
          if (session.socket === socket) { session.socket = undefined; session.cleanup = undefined; this.pinDropped(session, seat); }
        });
      };
      const fail = (message: string, code = 'VIEWER_FAILURE', detail?: unknown) => {
        if (closed) return;
        const error = { type: "error", code, diagnosticId, message, ...(detail === undefined ? {} : { detail: viewerError(detail) }) };
        app.log.error({ component: 'live-desktop', diagnosticId, code, message, ...(detail === undefined ? {} : { detail: viewerError(detail) }) }, 'Live desktop failure');
        this.send(socket, error); cleanup();
      };
      session.cleanup = cleanup;
      let inspecting = false, statusTicks = 0, encoderDetail = '';
      const timer = setInterval(() => {
        messages = 0;
        if (!this.control.isActive(session.identity, session.controlId)) { this.send(socket, { type: "ended" }); cleanup(); return; }
        if (started && Date.now() - lastPacket > 15_000) { fail("Desktop encoder produced no RTP packets for 15 seconds.", 'ENCODER_STALLED', encoderDetail || 'Encoder stderr is empty.'); return; }
        if (started && this.control.viewerStatus && !inspecting && ++statusTicks % 2 === 0) {
          inspecting = true;
          void this.control.viewerStatus(session.identity, session.controlId).then(result => {
            if (closed) return;
            encoderDetail = typeof result.stderr === 'string' ? result.stderr : '';
            if (!result.ok || result.running === false) fail(`Desktop encoder stopped${typeof result.exitCode === 'number' ? ` (exit ${result.exitCode})` : ''}.`, 'ENCODER_EXIT', result.stderr || result.error || 'No encoder stderr was returned.');
          }).catch(e => fail('Cannot inspect desktop encoder.', 'ENCODER_STATUS', e)).finally(() => { inspecting = false; });
        }
        if (!started && Date.now() - connectedAt > 30_000) { fail("Video connection timed out. A TURN relay may be required on this network."); return; }
        this.send(socket, { type: "active" });
      }, 1000);
      timer.unref();
      const startCapture = async () => {
        if (starting || started || closed) return; starting = true;
        try {
          const receiver = udp = dgram.createSocket("udp4");
          receiver.on("error", e => fail("Desktop video transport failed.", 'RTP_TRANSPORT', e));
          receiver.on("message", (bytes, remote) => {
            if (closed || remote.address !== "127.0.0.1" || !this.control.isActive(session.identity, session.controlId) || inFlight >= 64) return;
            try {
              const packet = RtpPacket.deSerialize(bytes);
              if (packet.header.payloadType !== 96) return;
              if (source !== undefined && source !== packet.header.ssrc) sender.replaceRTP(packet.header, true, 3000);
              source = packet.header.ssrc; lastPacket = Date.now(); inFlight++;
              void sender.sendRtp(packet).catch(e => fail("Desktop video delivery failed.", 'RTP_SEND', e)).finally(() => inFlight--);
            } catch { /* reject malformed local packets */ }
          });
          await new Promise<void>((resolve, reject) => { receiver.once("error", reject); receiver.bind(0, "127.0.0.1", () => { receiver.removeListener("error", reject); resolve(); }); });
          if (closed) return;
          const result = await this.control.startViewer(session.identity, session.controlId, receiver.address().port);
          if (!result.ok) throw new Error(result.error ?? "Desktop capture unavailable.");
          started = true; lastPacket = Date.now();
        } catch (e) { fail("Desktop capture unavailable.", 'ENCODER_START', e); }
        finally { starting = false; }
      };
      pc.connectionStateChange.subscribe(state => {
        if (closed) return;
        app.log.info({ component: 'live-desktop', diagnosticId, code: 'TRANSPORT_STATE', health: transportHealth(pc) }, 'Live desktop transport');
        if (state === "connected") captureTask ??= startCapture();
        if (state === "failed" || state === "closed") fail(`WebRTC connection state: ${state}.`, 'WEBRTC_FAILED', JSON.stringify(transportHealth(pc)));
      });
      pc.onIceCandidate.subscribe(candidate => { if (!closed && candidate) this.send(socket, { type: "candidate", candidate: candidate.toJSON() }); });
      let queue = Promise.resolve(), answered = false;
      socket.on("message", bytes => {
        if (Buffer.byteLength(bytes.toString()) > 65_536 || ++messages > 80) { fail("Invalid viewer signaling."); return; }
        queue = queue.then(async () => {
          if (closed || !this.control.isActive(session.identity, session.controlId)) return;
          const message = JSON.parse(bytes.toString());
          if (message.type === 'ping') { this.send(socket, { type: 'active' }); return; }
          if (message.type === 'card_event') { this.cardEvent(app, diagnosticId, message); return; }
          if (this.pinMessage(session, seat, message)) return;
          if (message.type === 'client_error' && typeof message.message === 'string') { log('CLIENT_ERROR', 'Viewer browser reported an error.', message.message); return; }
          if (message.type === "answer" && typeof message.sdp === "string" && !answered) { answered = true; await pc.setRemoteDescription({ type: "answer", sdp: message.sdp }); }
          else if (message.type === "candidate" && message.candidate && typeof message.candidate.candidate === "string") await pc.addIceCandidate(message.candidate);
          else throw new Error("Invalid viewer signaling");
        }).catch(e => fail("Video negotiation failed.", 'NEGOTIATION', e));
      });
      socket.once("close", (code) => { if (!closed) log('SIGNAL_CLOSED', `Signaling socket closed (code ${code}).`); cleanup(); });
      socket.on("error", e => { if (!closed) log('SIGNAL_ERROR', 'Signaling socket error.', e); cleanup(); });
      void (async () => {
        const offer = await pc.createOffer();
        this.send(socket, { type: "offer", sdp: offer.sdp });
        await pc.setLocalDescription(offer);
      })().catch(e => fail("Cannot initialize desktop video.", 'INITIALIZE', e));
    });
  }
  /** Low-bandwidth fallback through the already authenticated WSS tunnel; no new public listener. */
  private registerCompatibilityRoute(app: FastifyInstance): void {
    app.get('/mcp/live-desktop/frames', { websocket: true, logLevel: 'silent' }, async (socket, req) => {
      const query = req.query as { ticket?: string; seat?: string; panel?: string };
      const first = this.get(query.ticket);
      if (!first) { this.send(socket, { type: 'ended' }); socket.close(4404, 'Desktop control ended'); return; }
      const seat = query.seat === undefined ? first.seat : Number(query.seat);
      if (!(await this.claim(first, seat, socket, query.panel))) return;
      this.log?.("VIEWER_CONNECTED", { seat, stream: "jpeg fallback" });
      const session = this.get(query.ticket);
      if (!session) { this.send(socket, { type: 'ended' }); socket.close(4404, 'Desktop control ended'); return; }
      if (session.socket) { this.send(socket, { type: 'error', code: 'VIEWER_BUSY', message: 'Previous viewer connection is still closing.' }); socket.close(4409, 'Viewer busy'); return; }
      const diagnosticId = randomUUID(); session.socket = socket;
      let closed = false, ready = false, encoder: net.Socket | undefined, pending = Buffer.alloc(0), lastFrame = Date.now(), inspecting = false;
      let startup: Promise<void>;
      const tcp = net.createServer(client => {
        if (closed || (encoder && !encoder.destroyed && !encoder.readableEnded)) { client.destroy(); return; } encoder = client;
        // Switching monitors restarts FFmpeg, which reconnects to this same loopback listener.
        client.once('close', () => { if (encoder === client) { encoder = undefined; pending = Buffer.alloc(0); } });
        client.on('error', e => fail('JPEG encoder transport failed.', 'JPEG_TRANSPORT', e));
        client.on('data', bytes => {
          if (closed || encoder !== client || !this.control.isActive(session.identity, session.controlId)) return;
          try {
            pending = Buffer.concat([pending, typeof bytes === 'string' ? Buffer.from(bytes) : bytes]);
            if (pending.length > 2 * 1024 * 1024) { fail('JPEG encoder exceeded the frame-size limit.', 'JPEG_OVERSIZE'); return; }
            while (pending.length) {
              const end = pending.indexOf(Buffer.from([0xff, 0xd9])); if (end < 0) break;
              const frame = pending.subarray(0, end + 2); pending = pending.subarray(end + 2);
              if (frame[0] !== 0xff || frame[1] !== 0xd8) { fail('Invalid JPEG encoder output.', 'JPEG_FORMAT'); return; }
              lastFrame = Date.now();
              // Drop frames instead of building latency on slow/mobile connections.
              if (socket.readyState === 1 && socket.bufferedAmount < 256_000) socket.send(frame, { binary: true });
            }
          } catch (e) { fail('Cannot forward JPEG frame.', 'JPEG_FORWARD', e); }
        });
      });
      const cleanup = () => {
        if (closed) return; closed = true; clearInterval(timer); encoder?.destroy(); pending = Buffer.alloc(0);
        try { tcp.close(); } catch { /* not listening yet */ } socket.close(1000, 'Viewer closed');
        void Promise.resolve(startup).then(() => this.control.stopViewer(session.identity, session.controlId)).catch(() => {}).finally(() => {
          if (session.socket === socket) { session.socket = undefined; session.cleanup = undefined; this.pinDropped(session, seat); }
        });
      };
      const fail = (message: string, code: string, detail?: unknown) => {
        if (closed) return;
        const error = { code, diagnosticId, message, ...(detail === undefined ? {} : { detail: viewerError(detail) }) };
        app.log.error({ component: 'live-desktop', ...error }, 'Live desktop failure'); this.send(socket, { type: 'error', ...error }); cleanup();
      };
      session.cleanup = cleanup;
      const timer = setInterval(() => {
        if (!this.control.isActive(session.identity, session.controlId)) { this.send(socket, { type: 'ended' }); cleanup(); return; }
        this.send(socket, { type: 'active' });
        if (Date.now() - lastFrame > 20_000) { fail('Compatibility encoder produced no frames for 20 seconds.', 'JPEG_STALLED'); return; }
        if (ready && this.control.viewerStatus && !inspecting) {
          inspecting = true;
          void this.control.viewerStatus(session.identity, session.controlId).then(r => {
            if (r.running === false || !r.ok) fail(`Compatibility encoder stopped${typeof r.exitCode === 'number' ? ` (exit ${r.exitCode})` : ''}.`, 'ENCODER_EXIT', r.stderr || r.error);
          }).catch(e => fail('Cannot inspect compatibility encoder.', 'ENCODER_STATUS', e)).finally(() => { inspecting = false; });
        }
      }, 2000); timer.unref();
      socket.on('error', e => fail('Compatibility WebSocket failed.', 'JPEG_SOCKET', e));
      socket.once('close', cleanup);
      // This socket only receives heartbeat messages. It cannot issue desktop input.
      socket.on('message', bytes => {
        if (Buffer.byteLength(bytes.toString()) > 1024) { socket.close(1008, 'Invalid heartbeat'); cleanup(); return; }
        try { const m = JSON.parse(bytes.toString()); if (m?.type === 'card_event') this.cardEvent(app, diagnosticId, m); else if (m) this.pinMessage(session, seat, m); } catch { /* heartbeat */ }
      });
      startup = (async () => {
        await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', () => { tcp.removeListener('error', reject); resolve(); }); });
        if (closed) { tcp.close(); return; }
        const result = await this.control.startViewer(session.identity, session.controlId, (tcp.address() as net.AddressInfo).port, 'jpeg');
        if (!result.ok) throw new Error(result.error ?? 'Compatibility capture failed.');
        ready = true;
        app.log.info({ component: 'live-desktop', diagnosticId, code: 'JPEG_FALLBACK_STARTED' }, 'Compatibility viewer started');
      })().catch(e => fail('Cannot start compatibility stream.', 'JPEG_START', e));
      tcp.on('error', e => fail('Compatibility listener failed.', 'JPEG_LISTENER', e));
    });
  }
  close(): void { this.unsubscribe(); for (const session of this.sessions.values()) { this.send(session.socket, { type: "ended" }); session.cleanup?.(); } this.sessions.clear(); }
}

export function registerLivePanelResource(server: McpServer, origin: string): void {
  const domains = [new URL(origin).origin, new URL(origin).origin.replace(/^http/, "ws")];
  server.registerResource("helix-live-panel", LIVE_PANEL_URI, {}, async () => ({ contents: [{
    uri: LIVE_PANEL_URI, mimeType: "text/html;profile=mcp-app", text: liveViewerHtml({ panel: true }),
    _meta: {
      ui: { prefersBorder: false, csp: { connectDomains: domains, resourceDomains: [] } },
      "openai/widgetCSP": { connect_domains: domains, resource_domains: [] },
      "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
      "openai/widgetDescription": "Helix Live: a spectator view of the desktop Helix is controlling, opened by the user. Read-only.",
    },
  }] }));
}

export function registerLiveViewerResource(server: McpServer, origin: string): void {
  const domains = [new URL(origin).origin, new URL(origin).origin.replace(/^http/, "ws")];
  server.registerResource("helix-live-desktop", LIVE_VIEWER_URI, {}, async () => ({ contents: [{
    uri: LIVE_VIEWER_URI, mimeType: "text/html;profile=mcp-app", text: liveViewerHtml(),
    _meta: {
      ui: { prefersBorder: false, csp: { connectDomains: domains, resourceDomains: [] } },
      "openai/widgetCSP": { connect_domains: domains, resource_domains: [] },
      "openai/ui": { availableDisplayModes: ["inline", "pip", "fullscreen"], preferredDisplayMode: "inline" },
      "openai/widgetDescription": "Live spectator video of the monitor Helix is controlling. Automatically ends with desktop control.",
    },
  }] }));
}
