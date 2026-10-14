import type { FastifyInstance } from "fastify";
import type { WebSocket as ServerSocket } from "ws";
import { browserSource } from "./browser-source.js";

/** Bounded, ticket-scoped signaling only. Media never passes through Fastify. */
export function registerRemoteProbe(app: FastifyInstance, valid: (ticket: unknown) => boolean): void {
  const rooms = new Map<string, Map<string, ServerSocket>>();
  app.get("/mcp/viewer-probe/sender", async (_req, reply) => reply
    .header("cache-control", "no-store").header("referrer-policy", "no-referrer")
    .type("text/html").send(remoteSenderHtml()));
  app.get("/mcp/viewer-probe/signal", {
    websocket: true, logLevel: "silent",
    preValidation: async (req, reply) => {
      const { ticket, role } = req.query as { ticket?: string; role?: string };
      if (!valid(ticket)) return reply.code(401).send({ error: "Expired or revoked" });
      if (role !== "sender" && role !== "viewer") return reply.code(400).send({ error: "Invalid role" });
      if (rooms.get(ticket!)?.has(role) || (!rooms.has(ticket!) && rooms.size >= 4)) return reply.code(409).send({ error: "Probe busy" });
    },
  }, (socket, req) => {
    const { ticket, role } = req.query as { ticket: string; role: string };
    const room = rooms.get(ticket) ?? new Map<string, ServerSocket>();
    if (room.has(role)) { socket.close(1008, "Role occupied"); return; }
    rooms.set(ticket, room); room.set(role, socket);
    let count = 0;
    const started = Date.now();
    const timer = setInterval(() => {
      count = 0;
      if (!valid(ticket) || Date.now() - started > 120_000) socket.close(1000, "Probe ended");
    }, 1000);
    if (room.size === 2) for (const peer of room.values()) peer.send('{"type":"ready"}');
    socket.on("message", bytes => {
      if (!valid(ticket) || Buffer.byteLength(bytes.toString()) > 32_768 || ++count > 64) { socket.close(1008, "Invalid signaling"); return; }
      try {
        const message = JSON.parse(bytes.toString());
        if (!((message.type === "offer" && role === "sender") || (message.type === "answer" && role === "viewer") || message.type === "candidate" || (message.type === "sender-state" && role === "sender"))) throw new Error();
        if (message.type === "candidate" ? typeof message.candidate !== "object" || !message.candidate : message.type === "sender-state" ? typeof message.visible !== "boolean" : typeof message.sdp !== "string") throw new Error();
        for (const [otherRole, peer] of room) if (otherRole !== role) {
          if (peer.bufferedAmount > 65_536) peer.close(1008, "Slow peer");
          else peer.send(JSON.stringify(message));
        }
      } catch { socket.close(1008, "Invalid signaling"); }
    });
    socket.on("error", () => socket.terminate());
    socket.once("close", () => {
      clearInterval(timer); room.delete(role);
      for (const peer of room.values()) peer.close(1000, "Peer left");
      if (!room.size) rooms.delete(ticket);
    });
  });
}

/** Shared standalone browser function; only the sender generates canvas frames. */
export function remoteProbeClient(video: HTMLVideoElement, status: (text: string) => void,
  report: Record<string, unknown>, origin: string, ticket: string, sender: boolean): () => void {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  const url = new URL("/mcp/viewer-probe/signal", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket); url.searchParams.set("role", sender ? "sender" : "viewer");
  const ws = new WebSocket(url);
  let stopped = false, raf = 0, stream: MediaStream | undefined, frames = 0, first = 0, lastFrame = 0;
  let channel: RTCDataChannel | undefined;
  const rtts: number[] = [];
  const send = (message: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  const visibility = () => {
    if (!sender || stopped) return;
    const visible = !document.hidden;
    send({ type: "sender-state", visible });
    status(visible ? `Remote sender: ${pc.connectionState}` : "Sender tab hidden; move this page to a visible window or monitor");
  };
  const stop = () => { if (stopped) return; stopped = true; clearInterval(stats); clearTimeout(timeout); cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", visibility); stream?.getTracks().forEach(t => t.stop()); pc.close(); ws.close(); video.srcObject = null; };
  const timeout = setTimeout(() => { stop(); status("Remote test ended (120-second limit)"); }, 120_000);
  const stats = setInterval(() => {
    if (channel?.readyState === "open" && !sender) channel.send(String(performance.now()));
    void pc.getStats().then(values => {
      values.forEach(s => {
        if (s.type === "inbound-rtp" && s.kind === "video") {
          report.remoteDecodedFrames = s.framesDecoded;
          report.remoteFramesPerSecond = s.framesPerSecond;
          report.jitterBufferMeanMs = s.jitterBufferEmittedCount ? Math.round(1000 * s.jitterBufferDelay / s.jitterBufferEmittedCount) : null;
        }
        if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
          report.iceRttMs = Math.round(s.currentRoundTripTime * 1000);
          report.remoteCandidateType = values.get(s.remoteCandidateId)?.candidateType;
        }
      });
      if (!stopped && !sender) {
        const stalled = pc.connectionState === "connected" && (!lastFrame || performance.now() - lastFrame > 3000);
        if (stalled) status(report.senderVisible === false ? "Sender tab hidden; keep it visible in a separate window or monitor" : "Video received, but playback stalled; keep both pages visible and press Play");
        else status(`Remote peer: ${pc.connectionState} | ${frames} presented frames`);
      }
    }).catch(() => {});
  }, 1000);
  pc.onicecandidate = e => { if (e.candidate) send({ type: "candidate", candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => { if (!stopped) { report.remoteWebRTC = pc.connectionState; status(`Remote peer: ${pc.connectionState}`); } };
  const bind = (dc: RTCDataChannel) => {
    channel = dc;
    dc.onmessage = e => {
      if (sender) { if (typeof e.data === "string" && e.data.length < 64 && dc.readyState === "open") dc.send(e.data); }
      else if (Number.isFinite(Number(e.data))) {
        rtts.push(performance.now() - Number(e.data));
        const sorted = [...rtts].sort((a,b) => a-b);
        report.mediaPathRttMs = { median: Math.round(sorted[Math.floor(sorted.length / 2)]!), samples: sorted.length };
      }
    };
  };
  if (sender) {
    document.addEventListener("visibilitychange", visibility);
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      if (stopped) return;
      ctx.fillStyle = "#101113"; ctx.fillRect(0,0,640,360);
      ctx.fillStyle = "#e4c571"; ctx.fillRect((performance.now()/7)%600,150,40,70);
      ctx.font = "24px sans-serif"; ctx.fillText("HELIX / PC REMOTE SENDER",24,48);
      ctx.font = "18px monospace"; ctx.fillText(new Date().toISOString(),24,320);
      raf = requestAnimationFrame(draw);
    }; draw();
    stream = canvas.captureStream(30); video.srcObject = stream;
    stream.getTracks().forEach(track => pc.addTrack(track, stream!)); bind(pc.createDataChannel("probe-rtt"));
  } else {
    pc.ondatachannel = e => bind(e.channel);
    pc.ontrack = e => { video.srcObject = e.streams[0] ?? new MediaStream([e.track]); void video.play().catch(() => status("Tap video to play")); };
    const frame = (now: number) => {
      if (stopped) return; if (!first) first = now; lastFrame = performance.now(); frames++;
      report.remotePresentedFrames = frames;
      report.remotePlaybackFps = frames > 1 ? Math.round((frames-1)*1000/(now-first)) : 0;
      video.requestVideoFrameCallback(frame);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
  }
  const candidates: RTCIceCandidateInit[] = [];
  let queue = Promise.resolve();
  ws.onopen = () => { status("Waiting for the other peer; keep both pages visible"); visibility(); };
  ws.onmessage = e => {
    queue = queue.then(async () => {
      if (stopped) return;
      const m = JSON.parse(e.data);
      if (m.type === "ready" && sender) { visibility(); await pc.setLocalDescription(await pc.createOffer()); send({ type: "offer", sdp: pc.localDescription!.sdp }); }
      if (m.type === "sender-state" && !sender) { report.senderVisible = m.visible; if (!m.visible) status("Sender tab hidden; keep it visible in a separate window or monitor"); }
      if (m.type === "offer" || m.type === "answer") {
        await pc.setRemoteDescription({ type: m.type, sdp: m.sdp });
        for (const c of candidates.splice(0)) await pc.addIceCandidate(c);
        if (m.type === "offer") { await pc.setLocalDescription(await pc.createAnswer()); send({ type: "answer", sdp: pc.localDescription!.sdp }); }
      }
      if (m.type === "candidate") { if (pc.remoteDescription) await pc.addIceCandidate(m.candidate); else candidates.push(m.candidate); }
    }).catch(() => { status("Remote signaling failed; start a fresh test"); stop(); });
  };
  ws.onerror = () => { status("Signaling unavailable (network, expired ticket, or occupied role)"); stop(); };
  ws.onclose = () => { if (!stopped) { stop(); status("Remote test disconnected"); } };
  return stop;
}

export function remoteSenderHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Helix PC sender</title></head><body style="background:#101113;color:#e4c571;font:18px system-ui"><h1>Helix synthetic PC sender</h1><p>Keep this page visible on your PC. No desktop, camera or microphone capture. Stops after two minutes.</p><video autoplay muted playsinline style="width:640px;max-width:100%"></video><p id="status">Ready</p><button id="start">Start sender</button><button id="stop">Stop</button><script>
const ticket=location.hash.slice(1); history.replaceState(null,'',location.pathname);
let stop=()=>{}; document.getElementById('start').onclick=()=>{stop();stop=(${browserSource(remoteProbeClient)})(document.querySelector('video'),s=>document.getElementById('status').textContent=s,{},location.origin,ticket,true);};
document.getElementById('stop').onclick=()=>{stop();document.getElementById('status').textContent='Stopped';};window.addEventListener('pagehide',()=>stop());
</script></body></html>`;
}
