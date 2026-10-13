/** Independent spectator UI. Never calls input tools or extends the control lease. */
function liveViewerClient(options: { panel: boolean }): void {
  /** Panel mode: opened by the user as a thread tab, watches whatever control session exists, owns the stream. */
  const panel = options.panel;
  const video = document.querySelector('video')!;
  const canvas = document.querySelector('canvas')!;
  const status = document.getElementById('status')!;
  const popButton = document.getElementById('popout') as HTMLButtonElement;
  const host = (window as any).openai;
  let config: { origin: string; ticket: string; seat?: number; panelKey?: string; iceServers: RTCIceServer[] } | undefined;
  let socket: WebSocket | undefined, pc: RTCPeerConnection | undefined, ended = false, dismissed = false, generation = 0;
  let lastContact = Date.now(), lastFrame = Date.now(), lastTime = 0, failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined, firstError = '';
  let compatibility = false, decoding = false;
  /** True while the user has the stream in the browser's floating picture-in-picture window. */
  let pinned = false, hostPinned = false, hostRefused = false, lastMode: string | undefined;
  /** Panel only: stood down because another panel holds the stream (waits for the user), a lookup is in flight, last state shown. */
  let standing = false, polling = false, peeking = false, state = '';
  function setState(next: 'idle' | 'connecting' | 'live' | 'ended', text?: string): void {
    if (!panel) return;
    if (next !== state) { state = next; try { document.body.dataset.state = next; } catch { /* styling only */ } report('panel_state', next); }
    if (text !== undefined) { status.hidden = false; status.textContent = text; } else if (next === 'live') status.hidden = true;
  }
  /** Host calls with their own ids; the gateway tool answers with a fresh read-only ticket or { active: false }. */
  let rpcId = 100;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  function rpc(method: string, params: unknown): Promise<any> {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      const entry: { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
      pending.set(id, entry);
      entry.timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('Host request timed out')); }, 5000);
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  /** Asks the gateway whether this identity has a control session. Never starts one and never renews its lease. */
  async function fetchAndAccept(peek = false): Promise<void> {
    // A peek in flight must never block the user's own "Watch here" lookup, so they are tracked apart.
    if ((peek ? peeking : polling) || ended) return;
    if (peek) peeking = true; else polling = true;
    // A peek only asks whether a session exists: no ticket, no key, nothing issued. Used by a copy that stood down.
    const args = peek ? { peek: true } : {};
    try {
      const attempts: (() => Promise<any>)[] = [() => rpc('tools/call', { name: 'helix_live_panel', arguments: args })];
      if (host?.callTool) attempts.push(() => host.callTool('helix_live_panel', args));
      for (const attempt of attempts) {
        try {
          const r = await attempt(); const value = r?.result ?? r;
          const meta = value?._meta ?? value?.meta;
          if (meta?.liveDesktop?.peek) {
            // Another copy holds the stream, so this one never hears the gateway's "ended": it learns the end here and closes.
            if (meta.liveDesktop.active === false && standing) goIdle(true);
            return;
          }
          if (meta?.liveDesktop) { accept({ _meta: meta }, true); return; }
        } catch { /* try the next bridge */ }
      }
    } finally { if (peek) peeking = false; else polling = false; }
  }
  function watchHere(): void {
    standing = false; popButton.hidden = true; popButton.textContent = 'Pop out'; status.style.position = ''; video.style.display = '';
    setState('connecting', 'Looking for the desktop…'); notifySize(); void fetchAndAccept();
  }
  /** Control ended (or there is none): clear every pixel at once and go back to waiting. The panel itself stays open. */
  function goIdle(closeHost = false): void {
    const hadSession = !!config;
    if (closeHost && hadSession) {
      report('panel_closing', 'control ended: asking the host to close the panel');
      try { Promise.resolve(host?.requestClose?.()).catch(() => {}); } catch { /* the host may keep it open: the panel then just waits */ }
    }
    clearTimeout(retry); retry = undefined; release();
    config = undefined; firstError = ''; failures = 0; compatibility = false; live = false; standing = false;
    status.style.position = ''; status.style.pointerEvents = ''; popButton.hidden = true; popButton.textContent = 'Pop out';
    setState(hadSession ? 'ended' : 'idle', hadSession ? 'Desktop control ended. Waiting for the next session.' : 'No desktop control is running. Waiting…');
    notifySize();
  }
  function shutdown(): void {
    ended = true; clearInterval(watchdog); clearInterval(idlePoll); clearTimeout(retry); release();
  }
  const notifySize = () => window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: dismissed ? 0 : document.body.scrollHeight } }, '*');
  const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/(?:https?|wss?):\/\/[^\s"']+/gi, '[endpoint]').slice(0, 4096);
  function release(): void {
    generation++;
    const oldSocket = socket, oldPeer = pc; socket = undefined; pc = undefined;
    if (oldSocket) { oldSocket.onclose = oldSocket.onerror = oldSocket.onmessage = null; oldSocket.close(); }
    if (oldPeer) { oldPeer.onconnectionstatechange = oldPeer.onicecandidate = oldPeer.ontrack = null; oldPeer.close(); }
    (video.srcObject as MediaStream | null)?.getTracks().forEach(t => t.stop());
    video.pause(); video.srcObject = null;
    video.style.display = '';
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); canvas.hidden = true;
  }
  /** Tells the gateway log what happened to this card, so a vanished card can be pinned on Helix or the host. */
  function report(event: string, detail = ''): void {
    try { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'card_event', event, detail: detail.slice(0, 200) })); } catch { /* best effort */ }
  }
  function checkMode(): void {
    const mode = host?.displayMode;
    if (!mode || mode === lastMode) return;
    lastMode = mode; report('display_mode', mode);
    if (hostPinned && mode === 'inline') { hostPinned = pinned = false; control('unpin'); popButton.textContent = 'Pop out'; }
  }
  function control(type: 'pin' | 'unpin'): void {
    try { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type })); } catch { /* re-sent on reconnect */ }
  }
  function leavePictureInPicture(): void {
    try { if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {}); } catch { /* not supported */ }
  }
  /**
   * Pop out. ChatGPT's own floating mode is tried first: the host keeps it until it is dismissed, whereas a video window
   * opened from inside a card the host later destroys may not survive. If the host has no such mode or refuses it, the
   * button becomes "Pop out video" and the NEXT tap opens the browser's floating video window (also Safari's webkit API):
   * iOS only allows that inside the tap's own call stack, so it cannot follow an awaited host request. What was asked and
   * what was granted is logged, so the real iPhone behaviour can be read from the log.
   */
  function popOut(): void {
    if (pinned) { if (hostPinned) void hostInline(); else leavePictureInPicture(); return; }
    if (!hostRefused && typeof host?.requestDisplayMode === 'function') { void hostPip(); return; }
    browserPip();
  }
  function browserPip(): void {
    // The 8 fps fallback draws to a canvas: feed the video element from it so there is something to pop out.
    if (compatibility && !video.srcObject && canvas.captureStream) video.srcObject = canvas.captureStream(8);
    const v = video as HTMLVideoElement & { webkitSetPresentationMode?: (m: string) => void; webkitSupportsPresentationMode?: (m: string) => boolean };
    const standard = !!document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function';
    const legacy = !standard && typeof v.webkitSetPresentationMode === 'function' && !!v.webkitSupportsPresentationMode?.('picture-in-picture');
    report('browser_pip_tapped', `standard=${standard} legacy=${legacy}`);
    let attempt: Promise<void>;
    try {
      if (standard) attempt = v.requestPictureInPicture().then(() => undefined);
      else if (legacy) { v.webkitSetPresentationMode!('picture-in-picture'); attempt = Promise.resolve(); }
      else attempt = Promise.reject(new Error('picture-in-picture is not available in this frame'));
    } catch (e) { attempt = Promise.reject(e); }
    attempt.then(() => {
      pinned = true; control('pin'); report('popped_out', standard ? 'browser picture-in-picture' : 'webkit picture-in-picture');
      popButton.textContent = 'Bring back';
    }, e => {
      report('pip_failed', describe(e));
      status.hidden = false; status.textContent = `Pop-out is blocked here (${describe(e)}). The card still works.`;
    });
  }
  /** ChatGPT's floating mode. Mobile hosts may answer fullscreen, which is logged and still keeps the stream. */
  async function hostPip(): Promise<void> {
    report('host_pip_requested', `mode=pip current=${host?.displayMode ?? 'unknown'}`);
    try {
      const r = await host.requestDisplayMode({ mode: 'pip' });
      const granted = r?.mode ?? host?.displayMode;
      const ok = granted === 'pip' || granted === 'fullscreen';
      report(ok ? 'host_pip_granted' : 'host_pip_refused', `asked=pip granted=${granted ?? 'none'} raw=${JSON.stringify(r ?? null)}`);
      if (ok) { pinned = hostPinned = true; control('pin'); popButton.textContent = 'Bring back'; return; }
    } catch (e) { report('host_pip_failed', describe(e)); }
    hostRefused = true; popButton.textContent = 'Pop out video';
    status.hidden = false; status.textContent = 'ChatGPT would not float this card here. Tap again to try a video window.';
  }
  async function hostInline(): Promise<void> {
    try { await host.requestDisplayMode({ mode: 'inline' }); } catch { /* the mode watcher releases the pin */ }
    pinned = hostPinned = false; control('unpin'); popButton.textContent = 'Pop out'; report('host_pip_closed', 'user brought the card back inline');
  }
  popButton.onclick = () => (panel ? watchHere() : popOut());
  video.addEventListener('leavepictureinpicture', () => {
    if (!pinned) return;
    pinned = false; popButton.textContent = 'Pop out';
    if (!ended) { control('unpin'); report('pop_out_closed', 'user closed the pop-out'); }
  });
  /** A newer card's view while the stream plays in the pop-out: a short note, no video, no retries. */
  function standDown(event: string, note: string): void {
    if (ended) return;
    report(event, note);
    if (panel) {
      standing = true; clearTimeout(retry); retry = undefined; release();
      video.style.display = 'none'; status.hidden = false; status.style.position = 'static'; status.textContent = note;
      popButton.textContent = 'Watch here'; popButton.hidden = false; setState('idle'); notifySize(); return;
    }
    ended = true; clearInterval(watchdog); clearTimeout(retry); release();
    video.style.display = 'none'; popButton.hidden = true;
    status.hidden = false; status.style.position = 'static'; status.textContent = note;
    notifySize();
  }
  function dismiss(reason = 'helix'): void {
    report('helix_dismissed', reason);
    dismissed = true; document.body.replaceChildren(); notifySize();
    try { Promise.resolve(host?.requestClose?.()).catch(() => {}); } catch { /* host owns dismissal */ }
  }
  function close(preserveError = true): void {
    if (panel) { goIdle(true); return; }
    if (ended) { if (!preserveError) dismiss(); return; }
    ended = true; clearInterval(watchdog); clearTimeout(retry); leavePictureInPicture(); release();
    if (firstError && preserveError) {
      video.style.display = 'none'; status.hidden = false; status.style.position = 'static'; status.style.pointerEvents = 'auto';
      status.textContent = `Desktop control ended. Last viewer error: ${firstError}`;
      const button = document.createElement('button'); button.textContent = 'Dismiss'; button.onclick = () => dismiss('user pressed Dismiss'); status.append(button); notifySize();
    } else dismiss('control ended');
  }
  function recover(message: string): void {
    if (ended || retry) return;
    firstError ||= message;
    if (!compatibility && /WEBRTC|NEGOTIATION|VIDEO_STALLED|VIEWER_FAILURE|VIEWER_INITIALIZE/.test(message)) compatibility = true;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'client_error', message }));
    release(); status.hidden = false;
    const delay = failures < 5 ? Math.min(10_000, 1000 * 2 ** failures) : 30_000;
    failures++;
    status.textContent = `${firstError} Reconnecting in ${delay / 1000}s. Desktop control is unaffected.`;
    retry = setTimeout(() => { retry = undefined; connect(); }, delay);
  }
  // A delayed heartbeat alone must not destroy working video. Reconnecting never renews control.
  const watchdog = setInterval(() => {
    if (ended || !socket || retry) return;
    const now = Date.now();
    if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastFrame = now; }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    if (now - lastContact > 30_000) recover('SIGNAL_TIMEOUT: no gateway heartbeat for 30 seconds.');
    else if ((compatibility || pc?.connectionState === 'connected') && now - lastFrame > 20_000 && document.visibilityState !== 'hidden') recover('VIDEO_STALLED: no playback progress for 20 seconds.');
  }, 2000);
  /** Waiting for a control session to appear. Each lookup is read-only; it cannot start capture or extend control. */
  const idlePoll = panel ? setInterval(() => { if (ended || socket || retry || (standing ? peeking : polling)) return; void fetchAndAccept(standing); }, 4000) : undefined;
  function connect(): void {
    if (!config || ended) return;
    const attempt = ++generation;
    const current = () => !ended && generation === attempt;
    try {
      if (panel) { standing = false; setState('connecting', 'Connecting live desktop…'); }
      const url = new URL(compatibility ? '/mcp/live-desktop/frames' : '/mcp/live-desktop/signal', config.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', config.ticket); url.searchParams.set('seat', String(config.seat ?? 0));
      if (panel && config.panelKey) url.searchParams.set('panel', config.panelKey);
      const ws = socket = new WebSocket(url); lastContact = lastFrame = Date.now(); lastTime = 0;
      ws.binaryType = 'arraybuffer';
      const send = (value: unknown) => { if (current() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
      ws.onopen = () => { lastMode = undefined; checkMode(); if (pinned) send({ type: 'pin' }); if (firstError && !compatibility) send({ type: 'client_error', message: firstError }); };
      ws.onclose = event => {
        if (!current()) return;
        if (event.code === 4411) standDown('stood_down_popout', event.reason || 'Live desktop is playing in the pop-out window.'); // the stream stays in the pop-out the user opened from an earlier card
        else if (event.code === 4410) standDown('stood_down_replaced', 'Live desktop moved to the newest card.'); // a newer card took the stream over: stop quietly, never reconnect
        else if (event.code === 4404) close();
        else if (event.code === 4403) { if (panel) goIdle(); else close(); } // the panel key was not valid: look up a fresh one, never close
        else recover(`SIGNAL_CLOSED: WebSocket code ${event.code}${event.reason ? ` (${event.reason})` : ''}.`);
      };
      ws.onerror = () => {};
      if (compatibility) {
        video.style.display = 'none'; canvas.width = 1280; canvas.height = 720; canvas.hidden = false;
        if (pinned && canvas.captureStream) { video.srcObject = canvas.captureStream(8); void video.play().catch(() => {}); }
        ws.onmessage = event => {
          if (!current()) return; lastContact = Date.now();
          if (typeof event.data === 'string') {
            try {
              const m = JSON.parse(event.data);
              if (m.type === 'ended') close();
              else if (m.type === 'error') recover(`${m.code}: ${m.message} ${m.detail ?? ''} [${m.diagnosticId ?? ''}]`);
            } catch (e) { recover(`INVALID_SIGNAL: ${describe(e)}`); }
            return;
          }
          if (decoding) return; decoding = true;
          // Decode bytes directly: no blob URL / img-src CSP dependency and no retained object URLs.
          void createImageBitmap(new Blob([event.data], { type: 'image/jpeg' })).then(bitmap => {
            try {
              if (!current()) return;
              canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0); canvas.hidden = false;
              lastFrame = Date.now(); failures = 0; popButton.hidden = !!panel || false; live = true; setState('live');
              status.hidden = false; status.textContent = 'Compatibility stream · 8 fps'; status.style.inset = 'auto 0 0'; status.style.background = '#000b'; status.style.padding = '4px';
            } finally { bitmap.close(); }
          }).catch(e => { if (current()) recover(`JPEG_DECODE: ${describe(e)}`); }).finally(() => { decoding = false; });
        };
        return;
      }
      const peer = pc = new RTCPeerConnection({ iceServers: config.iceServers });
      peer.ontrack = event => {
        if (!current()) return;
        video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void video.play().catch(e => {
          if (!current()) return;
          status.hidden = false; status.textContent = `Playback: ${describe(e)}. Tap to watch.`;
          send({ type: 'client_error', message: status.textContent });
          video.onclick = () => { void video.play().catch(() => {}); };
        });
      };
      video.onplaying = () => { if (current()) { setState('live'); live = true; canvas.hidden = true; video.style.display = ''; status.hidden = true; popButton.hidden = panel; firstError = ''; failures = 0; lastFrame = Date.now(); } };
      peer.onconnectionstatechange = () => {
        if (current() && peer.connectionState === 'failed') recover('WEBRTC_FAILED: browser peer connection failed.');
      };
      let answered = false, queue = Promise.resolve(); const candidates: RTCIceCandidateInit[] = [];
      peer.onicecandidate = event => { if (event.candidate && current()) {
        if (answered) send({ type: 'candidate', candidate: event.candidate.toJSON() }); else candidates.push(event.candidate.toJSON());
      } };
      ws.onmessage = event => {
        if (!current()) return; lastContact = Date.now();
        // Stop and error messages must not wait behind slow SDP operations.
        let message: any;
        try { message = JSON.parse(event.data); } catch (e) { recover(`INVALID_SIGNAL: ${describe(e)}`); return; }
        if (message.type === 'ended') { close(); return; }
        if (message.type === 'error') { recover(`${message.code ?? 'VIEWER_ERROR'}: ${message.message}${message.detail ? ` ${message.detail}` : ''}${message.diagnosticId ? ` [${message.diagnosticId}]` : ''}`); return; }
        queue = queue.then(async () => {
          if (!current()) return;
          if (message.type === 'offer') {
            await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp }); if (!current()) return;
            const answer = await peer.createAnswer(); if (!current()) return;
            await peer.setLocalDescription(answer); if (!current()) return;
            send({ type: 'answer', sdp: answer.sdp }); answered = true;
            candidates.splice(0).forEach(candidate => send({ type: 'candidate', candidate }));
          } else if (message.type === 'candidate') await peer.addIceCandidate(message.candidate);
        }).catch(e => { if (current()) recover(`NEGOTIATION: ${describe(e)}`); });
      };
      ws.onclose = event => {
        if (!current()) return;
        if (event.code === 4411) standDown('stood_down_popout', event.reason || 'Live desktop is playing in the pop-out window.'); // the stream stays in the pop-out the user opened from an earlier card
        else if (event.code === 4410) standDown('stood_down_replaced', 'Live desktop moved to the newest card.'); // a newer card took the stream over: stop quietly, never reconnect
        else if (event.code === 4404) close();
        else if (event.code === 4403) { if (panel) goIdle(); else close(); } // the panel key was not valid: look up a fresh one, never close
        else recover(`SIGNAL_CLOSED: WebSocket code ${event.code}${event.reason ? ` (${event.reason})` : ''}.`);
      };
      // Error events contain no useful reason; close supplies the available browser code.
      ws.onerror = () => {};
    } catch (e) { if (current()) recover(`VIEWER_INITIALIZE: ${describe(e)}`); }
  }
  /** The tool result carries a fresh screenshot: show it at once so a new card is never blank while the stream connects. */
  let live = false;
  function paintStill(result: any, shownFor: number): void {
    const image = (result?.content as any[] | undefined)?.find(c => c?.type === 'image' && typeof c.data === 'string');
    if (!image || live || typeof createImageBitmap !== 'function') return;
    try {
      const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
      void createImageBitmap(new Blob([bytes], { type: image.mimeType || 'image/png' })).then(bitmap => {
        try {
          if (live || ended || generation !== shownFor) return;
          canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
          canvas.hidden = false; video.style.display = 'none'; status.hidden = true;
        } finally { bitmap.close(); }
      }).catch(() => {});
    } catch { /* a bad image never blocks the live stream */ }
  }
  function accept(result: any, lookup = false): void {
    const value = result?._meta?.liveDesktop;
    if (!value || ended) return;
    // The host re-sends whatever it holds for this panel on EVERY tool call the model makes: the result of the call that
    // opened it (usually { active: false }, from before control started), or another tool's card result. None of that says
    // anything about the stream, and the gateway's own "ended"/close is the only thing that ends it. So the panel believes
    // only its own lookups, plus a pushed result that carries a panel key while it is idle (the opening result).
    if (panel && !lookup && (config || !value.ticket || !value.panelKey)) return;
    if (!value.ticket) { if (!panel || config) close(); return; }
    // The same card can be handed a later call's result: keep the stream, just hold the newer seat.
    if (config && config.ticket === value.ticket) { if ((value.seat ?? 0) > (config.seat ?? 0)) config.seat = value.seat; return; }
    clearTimeout(retry); retry = undefined; release(); config = value; firstError = ''; failures = 0; compatibility = false; live = false; connect(); paintStill(result, generation);
  }
  window.addEventListener('message', ({ source, data }) => {
    if (source !== window.parent || data?.jsonrpc !== '2.0') return;
    const answer = typeof data.id === 'number' ? pending.get(data.id) : undefined;
    if (answer) { pending.delete(data.id); clearTimeout(answer.timer); if (data.error) answer.reject(new Error(data.error.message)); else answer.resolve(data.result); return; }
    if (data.method === 'ui/notifications/tool-result') accept(data.params);
    if (data.method === 'ui/resource-teardown') { report('host_teardown', 'ChatGPT asked the card to tear down'); if (panel) shutdown(); else close(false); window.parent.postMessage({ jsonrpc: '2.0', id: data.id, result: {} }, '*'); }
    if (data.id === 1 && data.result) { window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*'); notifySize(); if (panel) void fetchAndAccept(); }
  });
  window.parent.postMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'Helix live desktop', version: '2.0.0' }, appCapabilities: {} } }, '*');
  if (host?.toolResponseMetadata) accept({ _meta: host.toolResponseMetadata });
  window.addEventListener('openai:set_globals', () => { checkMode(); if (host?.toolResponseMetadata) accept({ _meta: host.toolResponseMetadata }); });
  window.addEventListener('pagehide', () => { report('host_unloaded', 'the host unloaded the card page'); if (panel) shutdown(); else close(false); });
  // The host can hide a card without unloading it (collapsed, scrolled away, replaced in place): log each change.
  document.addEventListener?.('visibilitychange', () => {
    report(document.hidden ? 'page_hidden' : 'page_visible', document.visibilityState);
    // A copy displaced by a newer one takes the stream back the moment it is the one on screen.
    if (panel && standing && !document.hidden) watchHere();
  });
  let shown: boolean | undefined;
  try {
    new IntersectionObserver(entries => {
      const visible = entries.some(e => e.isIntersecting && e.intersectionRatio > 0);
      if (visible === shown) return;
      shown = visible;
      if (panel && standing && visible) watchHere();
      report(visible ? 'card_visible' : 'card_hidden', `ratio ${entries[0]?.intersectionRatio ?? 0}, frame ${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`);
    }).observe(document.querySelector('main')!);
  } catch { /* older browser */ }
  new ResizeObserver(notifySize).observe(document.body);
  if (panel) setState('idle', 'No desktop control is running. Waiting…');
}

// The client is shipped as its own source text. Under tsx (tests, `npm run dev`) esbuild's keepNames adds calls to a `__name`
// helper inside it that does not exist in the page, so the page defines a no-op one.
export function liveViewerHtml(options: { panel?: boolean } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box}html,body{margin:0;background:transparent}main{position:relative;${options.panel ? 'min-height:200px;' : ''}max-width:${options.panel ? 960 : 640}px;margin:auto;overflow:hidden;border:1px solid #b79748;border-radius:12px;background:#0b0b0b}video,canvas{display:block;width:100%;aspect-ratio:16/9;object-fit:contain}canvas[hidden]{display:none}#status{position:absolute;inset:0;display:grid;place-items:center;color:#e4c777;font:14px system-ui;padding:16px;text-align:center;pointer-events:none;overflow:auto;overflow-wrap:anywhere}#status[hidden]{display:none}#popout{position:absolute;top:8px;right:8px;z-index:2;border:1px solid #b79748;border-radius:8px;padding:6px 10px;background:#0b0b0bcc;color:#e4c777;font:13px system-ui;cursor:pointer}#popout[hidden]{display:none}#popout:focus-visible{outline:2px solid #fff;outline-offset:2px}
  </style></head><body><main><video autoplay muted playsinline aria-label="Helix live desktop"></video><canvas hidden role="img" aria-label="Helix compatibility stream"></canvas><div id="status">Connecting live desktop…</div><button id="popout" hidden aria-label="Pop the live desktop out into a floating window">Pop out</button></main><script>var __name=function(f){return f};(${liveViewerClient.toString()})(${JSON.stringify({ panel: !!options.panel })});</script></body></html>`;
}
