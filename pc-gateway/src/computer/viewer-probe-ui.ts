import { browserSource } from "./browser-source.js";
import { remoteProbeClient } from "./viewer-remote.js";
/** Self-contained browser code, serialized after TypeScript compilation; no external scripts. */
function viewerProbeClient(): void {
  const el = (id: string) => document.getElementById(id)!;
  const video = el("video") as HTMLVideoElement;
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  const report: Record<string, unknown> = { synthetic: true, remoteWebRTC: "not tested", desktopLatency: "not measured" };
  let config: { origin?: string; ticket?: string } = {};
  let running = false, generation = 0, raf = 0;
  let stopRemote: (() => void) | undefined;
  let peers: RTCPeerConnection[] = [], media: MediaStream | undefined, socket: WebSocket | undefined;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let rtts: number[] = [], decoded = 0, lastFrame = 0, firstFrame = 0;
  const status = (id: string, text: string) => { el(id).textContent = text; report[id] = text; renderReport(); };
  const renderReport = () => { (el("report") as HTMLTextAreaElement).value = JSON.stringify(report, null, 2); };
  const host = (window as unknown as { openai?: { toolResponseMetadata?: { viewerProbe?: typeof config }; requestDisplayMode?: (a: { mode: string }) => Promise<unknown>; callTool?: (name: string, args: unknown) => Promise<any> } }).openai;
  const accept = (result: { _meta?: { viewerProbe?: typeof config } }) => {
    const value = result?._meta?.viewerProbe;
    if (value && typeof value.ticket === "string") { config = value; status("bridge", "Host connected"); }
  };
  let rpcId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  function rpc(method: string, params: unknown): Promise<any> {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.delete(id)) reject(new Error("Host request timed out")); }, 5000);
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }
  window.addEventListener("message", ({ source, data }) => {
    if (source !== window.parent || data?.jsonrpc !== "2.0") return;
    if (data.method === "ui/notifications/tool-result") accept(data.params);
    if (data.method === "ui/resource-teardown") { stop("Closed"); window.parent.postMessage({ jsonrpc: "2.0", id: data.id, result: {} }, "*"); }
    const p = pending.get(data.id);
    if (p) { pending.delete(data.id); data.error ? p.reject(new Error(data.error.message)) : p.resolve(data.result); }
  });
  if (host?.toolResponseMetadata?.viewerProbe) accept({ _meta: host.toolResponseMetadata });
  window.addEventListener("openai:set_globals", () => { if (host?.toolResponseMetadata) accept({ _meta: host.toolResponseMetadata }); });
  void rpc("ui/initialize", {
    protocolVersion: "2026-01-26", appInfo: { name: "Helix viewer probe", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  }).then((r) => {
    report.host = r?.hostInfo; report.displayMode = r?.hostContext?.displayMode;
    status("bridge", "Host connected");
    window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
    window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.body.scrollHeight } }, "*");
  }).catch(() => status("bridge", host ? "Legacy ChatGPT bridge" : "Host bridge unavailable"));
  new ResizeObserver(() => window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.body.scrollHeight } }, "*")).observe(document.body);

  /**
   * Tickets last 5 minutes and do not survive a gateway restart, but the host keeps showing this card long after.
   * So every run asks the gateway for a fresh one by calling the tool again; the ticket the card opened with is the fallback.
   */
  async function refreshTicket(): Promise<boolean> {
    const fresh = (r: any) => r?._meta?.viewerProbe ?? r?.meta?.viewerProbe ?? r?.result?._meta?.viewerProbe;
    const attempts: (() => Promise<any>)[] = [() => rpc("tools/call", { name: "test_desktop_viewer", arguments: {} })];
    if (host?.callTool) attempts.push(() => host.callTool!("test_desktop_viewer", {}));
    for (const attempt of attempts) {
      try {
        const value = fresh(await attempt());
        if (value && typeof value.ticket === "string") { config = value; return true; }
      } catch { /* try the next bridge */ }
    }
    return false;
  }

  function stop(label: string): void {
    stopRemote?.(); stopRemote = undefined;
    el("sender-help").hidden = true; (el("sender") as HTMLInputElement).value = "";
    running = false; generation++; cancelAnimationFrame(raf);
    timers.forEach(clearTimeout); timers = [];
    socket?.close(); socket = undefined;
    peers.forEach(p => p.close()); peers = [];
    media?.getTracks().forEach(t => t.stop()); media = undefined;
    video.pause(); video.srcObject = null;
    if (rtts.length) { const sorted = [...rtts].sort((a, b) => a - b); report.networkRttMs = { median: Math.round(sorted[Math.floor(sorted.length / 2)]!), p95: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))]!), samples: sorted.length }; }
    report.decodedFrames = decoded;
    if (decoded > 1) report.playbackFps = Math.round((decoded - 1) * 1000 / Math.max(1, lastFrame - firstFrame));
    el("run").textContent = "Run again"; (el("run") as HTMLButtonElement).disabled = false;
    status("state", label);
  }
  async function start(): Promise<void> {
    stop("Starting…"); running = true; const run = generation;
    (el("run") as HTMLButtonElement).disabled = true;
    rtts = []; decoded = 0; firstFrame = 0; lastFrame = 0;
    delete report.networkRttMs; delete report.playbackFps;
    status("rtc", "Checking WebRTC…"); status("network", "Checking gateway…"); status("https", "Not run");
    status("state", "Running for 20 seconds…");
    report.client = navigator.userAgent; report.secureContext = window.isSecureContext;
    report.ticket = (await refreshTicket()) ? "fresh" : "from when the card opened (could not refresh)";
    if (run !== generation) return;
    timers.push(setTimeout(() => { if (running && run === generation) stop("Test complete — see results"); }, 20_000));
    // A real direct connection to the gateway, independent of any model tool round trips.
    if (config.origin && config.ticket) {
      const url = new URL("/mcp/viewer-probe/ping", config.origin); url.searchParams.set("ticket", config.ticket);
      void fetch(url, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5000) })
        .then(r => { if (run === generation) status("https", r.ok ? "Connected" : r.status === 401 ? "HTTP 401 — ticket expired; ask for a new viewer test" : `HTTP ${r.status}`); })
        .catch(() => { if (run === generation) status("https", "Blocked or unreachable"); });
      try {
        url.pathname = "/mcp/viewer-probe/stream"; url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const ws = socket = new WebSocket(url); let sentAt = 0, tick = 0;
        ws.onopen = () => { if (run !== generation) return; status("network", "WebSocket connected"); ping(); };
        const ping = () => { if (run !== generation || ws.readyState !== WebSocket.OPEN) return; sentAt = performance.now(); ws.send(JSON.stringify({ type: "ping", id: sentAt })); timers.push(setTimeout(ping, 1000)); };
        ws.onmessage = e => {
          if (run !== generation) return;
          try { const message = JSON.parse(e.data); if (message.type === "tick") { tick = message.seq; status("network", `Live gateway ticks: ${tick}`); } if (message.type === "pong" && message.id === sentAt) { rtts.push(performance.now() - sentAt); report.latestNetworkRttMs = Math.round(rtts.at(-1)!); renderReport(); } } catch { status("network", "Invalid gateway response"); }
        };
        ws.onerror = () => { if (run === generation) status("network", "WebSocket blocked or unreachable"); };
        ws.onclose = () => { if (run === generation && running) status("network", "Connection closed — reopen test if expired"); };
      } catch { status("network", "WebSocket unavailable"); }
    } else { status("network", "No network configuration — reopen tool or set HELIX_PUBLIC_URL"); }
    // Two local peers test codec/iframe playback only. No STUN/TURN or remote peer is involved.
    try {
      if (!canvas.captureStream || !window.RTCPeerConnection) throw new Error("Canvas capture or WebRTC API unavailable");
      const ctx = canvas.getContext("2d")!;
      const draw = () => {
        if (run !== generation || !running) return;
        const t = performance.now();
        ctx.fillStyle = "#101113"; ctx.fillRect(0, 0, 640, 360);
        ctx.strokeStyle = "#343027";
        for (let x = 0; x < 640; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 360); ctx.stroke(); }
        ctx.fillStyle = "#e4c571"; ctx.fillRect((t / 7) % 600, 155, 40, 70);
        ctx.font = "24px sans-serif"; ctx.fillText("HELIX · SYNTHETIC VIDEO", 28, 50);
        ctx.font = "18px monospace"; ctx.fillText(`${(t / 1000).toFixed(2)} s`, 28, 315);
        raf = requestAnimationFrame(draw);
      }; draw();
      media = canvas.captureStream(30);
      const tx = new RTCPeerConnection({ iceServers: [] }), rx = new RTCPeerConnection({ iceServers: [] }); peers = [tx, rx];
      const candidates = new Map<RTCPeerConnection, RTCIceCandidateInit[]>([[tx, []], [rx, []]]);
      const candidate = (target: RTCPeerConnection, c: RTCIceCandidate | null) => {
        if (!c || run !== generation) return;
        if (target.remoteDescription) void target.addIceCandidate(c).catch(() => status("rtc", "ICE candidate rejected"));
        else candidates.get(target)!.push(c.toJSON());
      };
      tx.onicecandidate = e => candidate(rx, e.candidate); rx.onicecandidate = e => candidate(tx, e.candidate);
      rx.ontrack = e => { if (run !== generation) return; video.srcObject = e.streams[0] ?? new MediaStream([e.track]); void video.play().catch(() => status("rtc", "Playback needs a tap on the video")); };
      rx.onconnectionstatechange = () => { if (run === generation && decoded === 0) status("rtc", `Peer: ${rx.connectionState}; waiting for video`); };
      const track = media.getVideoTracks()[0]!; tx.addTrack(track, media);
      await tx.setLocalDescription(await tx.createOffer()); if (run !== generation) return;
      await rx.setRemoteDescription(tx.localDescription!);
      for (const c of candidates.get(rx)!) await rx.addIceCandidate(c);
      await rx.setLocalDescription(await rx.createAnswer()); if (run !== generation) return;
      await tx.setRemoteDescription(rx.localDescription!);
      for (const c of candidates.get(tx)!) await tx.addIceCandidate(c);
      const frame = (now: number) => {
        if (run !== generation || !running) return;
        if (!firstFrame) firstFrame = now;
        lastFrame = now; decoded++; report.decodedFrames = decoded; status("rtc", `WebRTC video playing · ${decoded} presented frames`);
        video.requestVideoFrameCallback(frame);
      };
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
      else {
        // Older clients: measure decoded frames, not canvas animation or timeupdate events.
        const poll = async () => {
          if (run !== generation || !running) return;
          try { (await rx.getStats()).forEach(s => { if (s.type === "inbound-rtp" && s.kind === "video" && s.framesDecoded > decoded) { if (!firstFrame) firstFrame = performance.now(); lastFrame = performance.now(); decoded = s.framesDecoded; status("rtc", `WebRTC received · ${decoded} decoded frames (presentation unverified)`); } }); } catch { /* closed */ }
          timers.push(setTimeout(poll, 1000));
        }; void poll();
      }
      timers.push(setTimeout(() => { if (run === generation && !decoded) status("rtc", "No video frames after 10 seconds — compatibility not confirmed"); }, 10_000));
    } catch (e) { if (run === generation) status("rtc", `Failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  el("run").onclick = () => void start(); el("stop").onclick = () => stop("Stopped");
  el("remote").onclick = () => { void (async () => {
    stop("Preparing remote test"); const run = generation;
    await refreshTicket(); if (run !== generation) return;
    if (!config.origin || !config.ticket) { status("state", "Open a fresh viewer test first"); return; }
    report.remoteWebRTC = "waiting"; report.desktopLatency = "not measured; RTT is not glass-to-glass latency";
    for (const key of ["remoteDecodedFrames", "remoteFramesPerSecond", "remotePresentedFrames", "remotePlaybackFps", "mediaPathRttMs", "iceRttMs", "remoteCandidateType", "jitterBufferMeanMs"]) delete report[key];
    const sender = new URL("/mcp/viewer-probe/sender", config.origin); sender.hash = config.ticket;
    (el("sender") as HTMLInputElement).value = sender.href;
    el("sender-help").hidden = false;
    // This function is supplied inline below, not imported into the sandbox.
    const remote = (window as unknown as { helixRemote: typeof remoteProbeClient }).helixRemote;
    stopRemote = remote(video, text => {
      status("rtc", text);
      if (text.includes("ended") || text.includes("disconnected")) status("state", "Remote test stopped. Press Test remote PC video for a fresh link.");
      else if (text.startsWith("Remote peer: connected")) status("state", "Receiving generated PC video. Keep the sender visible in another window or monitor.");
    }, report, config.origin, config.ticket, false);
    status("state", "Remote test ready. Open the sender link on your PC and press Start sender. Keep both pages visible.");
  })(); };
  el("expand").onclick = () => { void (host?.requestDisplayMode ? host.requestDisplayMode({ mode: "fullscreen" }) : rpc("ui/request-display-mode", { mode: "fullscreen" })).then(r => { report.requestedDisplay = r; renderReport(); }).catch(() => status("state", "Expand unavailable; inline test still works")); };
  el("copy").onclick = () => { const area = el("report") as HTMLTextAreaElement; area.select(); void navigator.clipboard?.writeText(area.value).catch(() => { /* selection permits manual copy */ }); };
  window.addEventListener("pagehide", () => stop("Closed"));
  document.addEventListener("visibilitychange", () => { if (document.hidden && running) stop("Paused when hidden — run again when visible"); });
  renderReport();
}

export function viewerProbeHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Helix Viewer Test</title><style>
*{box-sizing:border-box}body{margin:0;padding:16px;background:#101113;color:#f6f1e4;font:14px system-ui,sans-serif}main{max-width:640px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}h1{font-size:17px;margin:0;letter-spacing:.04em}small{color:#d5b968}video{width:100%;aspect-ratio:16/9;background:#08090a;border:1px solid #67572e;border-radius:12px;object-fit:contain}p{color:#bcbab2;line-height:1.45}.rows{display:grid;gap:7px;margin:14px 0}.row{display:flex;justify-content:space-between;gap:12px}.row span:last-child{text-align:right;color:#e4c571;overflow-wrap:anywhere}nav{display:flex;gap:8px;flex-wrap:wrap}button{border:1px solid #65552d;border-radius:8px;padding:10px 14px;background:#26231a;color:#f5df9d;cursor:pointer}button:first-child{background:#e4c571;color:#171611}button:disabled{opacity:.5}button:focus-visible{outline:2px solid white;outline-offset:2px}textarea{width:100%;min-height:160px;background:#17191d;color:#ddd;border:1px solid #454545;border-radius:8px;margin:8px 0;padding:8px;font:12px monospace}summary{cursor:pointer;padding:12px 0}#state{min-height:20px}</style></head><body><main>
<header><h1>HELIX <small>VIEWER LAB</small></h1><small>SYNTHETIC TEST</small></header>
<video id="video" autoplay muted playsinline controls aria-label="Synthetic WebRTC test video"></video>
<div class="rows"><div class="row"><span>Host UI</span><span id="bridge">Connecting…</span></div><div class="row"><span>HTTPS</span><span id="https">Not run</span></div><div class="row"><span>Live connection</span><span id="network">Not run</span></div><div class="row"><span>Local video</span><span id="rtc">Not run</span></div></div>
<nav><button id="run">Run 20-second test</button><button id="remote">Test remote PC video</button><button id="stop">Stop</button><button id="expand">Expand</button></nav><p id="state" role="status">Ready when you are.</p>
<div id="sender-help" hidden><p>Copy this private, temporary link into a browser on your PC (not your phone). Press Start sender there. Keep that page visible alongside this viewer. Do not share the link.</p><input id="sender" readonly aria-label="Private PC sender link" style="width:100%" onclick="this.select()"></div>
<p>Generated animation only; this does not show your desktop yet. Keep the PC sender visible in a separate window or on your second monitor, and leave this card visible too. Chrome slows hidden tabs. The remote test ends after two minutes. RTT is not desktop end-to-end latency.</p>
<details><summary>Diagnostic results</summary><textarea id="report" readonly aria-label="Diagnostic results"></textarea><button id="copy">Copy results</button></details>
</main><script>window.helixRemote=(${browserSource(remoteProbeClient)});(${browserSource(viewerProbeClient)})();</script></body></html>`;
}
