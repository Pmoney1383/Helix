import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { once } from 'node:events';
import net from 'node:net';
import { Script, runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { LiveDesktopViewer, type ViewerControl } from '../src/computer/live-viewer.js';
import { liveViewerHtml } from '../src/computer/live-viewer-ui.js';
import { ComputerController } from '../src/computer/controller.js';
import type { ComputerBridge } from '../src/computer/bridge.js';
import { loadConfig } from '../src/config.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerComputerTools } from '../src/computer/tools.js';
import type { McpDeps } from '../src/mcp/server.js';
import { LIVE_VIEWER_URI, viewerError } from '../src/computer/live-viewer.js';

class Control implements ViewerControl {
  active = true; starts = 0; stops = 0; listener?: (id: string) => void;
  isActive(identity: string, id: string) { return this.active && identity === 'owner' && id === 'session'; }
  activeControlId(identity: string) { return this.active && identity === 'owner' ? 'session' : undefined; }
  onStopped(listener: (id: string) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  async startViewer() { this.starts++; return { ok: true }; }
  async stopViewer() { this.stops++; }
  stop() { this.active = false; this.listener?.('session'); }
}

it('live tickets are restricted to one active owner/session and expire on stop', async () => {
  const control = new Control(), viewer = new LiveDesktopViewer(control, []);
  const app = Fastify(); await app.register(websocket); viewer.registerRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  let socket: WebSocket | undefined;
  try {
    assert.throws(() => viewer.issue('other', 'session'), /ended/);
    assert.throws(() => viewer.issue('owner', 'other'), /ended/);
    const { ticket, seat } = viewer.issue('owner', 'session');
    const later = viewer.issue('owner', 'session');
    assert.equal(ticket, later.ticket); assert.equal(later.seat, seat + 1, 'each card gets a newer seat');
    assert.equal((await app.inject({ url: '/mcp/live-desktop/signal?ticket=invalid' })).statusCode, 410);
    socket = new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp/live-desktop/signal?ticket=${ticket}&seat=${later.seat}`);
    const messages: any[] = []; socket.on('message', v => messages.push(JSON.parse(String(v))));
    await once(socket, 'open');
    assert.equal((await app.inject({ url: `/mcp/live-desktop/signal?ticket=${ticket}` })).statusCode, 409);
    assert.equal(control.starts, 0, 'capture must wait for a negotiated viewer');
    const closed = once(socket, 'close'); control.stop(); await closed;
    assert.ok(messages.some(m => m.type === 'ended'));
    assert.equal((await app.inject({ url: `/mcp/live-desktop/signal?ticket=${ticket}` })).statusCode, 410);
    assert.throws(() => viewer.issue('owner', 'session'), /ended/);
  } finally { socket?.terminate(); viewer.close(); await app.close(); }
});

it('the newest card takes the stream over; an older card is turned away for good', async () => {
  const control = new Control(), viewer = new LiveDesktopViewer(control, []);
  const app = Fastify({ logger: false }); await app.register(websocket); viewer.registerRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = (ticket: string, seat: number) => `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp/live-desktop/signal?ticket=${ticket}&seat=${seat}`;
  const sockets: WebSocket[] = [];
  const open = async (ticket: string, seat: number) => { const ws = new WebSocket(url(ticket, seat)); sockets.push(ws); await once(ws, 'open'); return ws; };
  try {
    const first = viewer.issue('owner', 'session');
    const a = await open(first.ticket, first.seat);
    const second = viewer.issue('owner', 'session'); // the model's next call: ChatGPT shows this card instead
    const aClosed = once(a, 'close');
    const b = await open(second.ticket, second.seat);
    assert.equal((await aClosed)[0], 4410, 'the hidden card is told it was replaced');
    // The hidden card retrying must not steal the stream back
    const retry = new WebSocket(url(first.ticket, first.seat)); sockets.push(retry);
    assert.equal((await once(retry, 'close'))[0], 4410);
    assert.equal(b.readyState, WebSocket.OPEN, 'the newest card keeps the stream');
  } finally { for (const s of sockets) s.terminate(); viewer.close(); await app.close(); }
});

it('viewer operations do not refresh frame IDs or keep the control lease alive; native stop is immediate', async () => {
  let now = Date.now(); const commands: any[] = [];
  const bridge: ComputerBridge = { close() {}, async request(command) { commands.push(command); return { ok: true, active: true, frameId: 'native-frame', capturedAt: new Date(now).toISOString() }; } };
  const controller = new ComputerController(() => true, () => bridge, () => now);
  const stopped: string[] = []; controller.onStopped(id => stopped.push(id));
  try {
    const start = await controller.start('owner'); const id = String(start.controlId);
    const framesBefore = commands.filter(c => c.op === 'capture').length;
    now += 119_000; await controller.startViewer('owner', id, 44444); await controller.stopViewer('owner', id);
    assert.equal(commands.filter(c => c.op === 'capture').length, framesBefore);
    now += 1001; assert.equal(controller.isActive('owner', id), false);
    await assert.rejects(controller.startViewer('owner', id, 44444), /ended/);
    bridge.onControlStopped?.(); assert.deepEqual(stopped, [id]);
  } finally { controller.close(); }
});

it('stream-only UI is standalone, automatically clears media and requests host dismissal', () => {
  const html = liveViewerHtml(); new Script(html.match(/<script>([\s\S]*)<\/script>/)![1]!);
  assert.match(html, /requestClose/); assert.match(html, /replaceChildren/);
  assert.match(html, /autoplay muted playsinline/);
  assert.doesNotMatch(html, /getDisplayMedia|getUserMedia|SYNTHETIC TEST/);
  assert.doesNotMatch(html, /start_desktop_control|stop_desktop_control|take_screenshot|type_text|press_key|name: 'click'/, 'no desktop input tool is reachable from the card');
  // Watching only: the one button pops the video out; nothing in the card can act on the desktop
  assert.deepEqual(html.match(/<button[^>]*>/g)?.map(b => /id="([^"]+)"/.exec(b)?.[1]), ['popout']);
});

it('ICE config accepts optional relays without leaking credentials in validation errors', () => {
  assert.deepEqual(loadConfig({ HELIX_VIEWER_ICE_SERVERS: '[{"urls":"turn:example.com:3478","username":"u","credential":"secret"}]' }).viewerIceServers,
    [{ urls: 'turn:example.com:3478', username: 'u', credential: 'secret' }]);
  assert.throws(() => loadConfig({ HELIX_VIEWER_ICE_SERVERS: 'secret' }), e => e instanceof Error && !e.message.includes('secret'));
});

it('every call during control renders the live widget (ChatGPT hides the previous one); tickets stay hidden', async () => {
  const bridge: ComputerBridge = { close() {}, async request() { return { ok: true, image: 'YWJj', mimeType: 'image/png' }; } };
  const computer = new ComputerController(() => true, () => bridge), liveViewer = new LiveDesktopViewer(computer, []);
  const server = new McpServer({ name: 'test', version: '1' }), client = new Client({ name: 'test', version: '1' });
  registerComputerTools(server, { scope: 'pc.hosted', actor: 'test', desktopAllowed: true, desktopIdentity: 'owner' },
    { computer, liveViewer, liveViewerCards: true, publicUrl: 'https://helix.example', auth: { audit() {} } } as unknown as McpDeps);
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    const withCard = tools.filter(t => t._meta?.['openai/outputTemplate']).map(t => t.name);
    for (const n of ['start_desktop_control', 'take_screenshot', 'click', 'type_text', 'press_key', 'scroll', 'drag']) assert.ok(withCard.includes(n), n);
    for (const n of ['stop_desktop_control', 'get_screen_info', 'get_active_window']) assert.ok(!withCard.includes(n), n);
    assert.equal((await client.readResource({ uri: LIVE_VIEWER_URI })).contents[0]?.mimeType, 'text/html;profile=mcp-app');
    const result = await client.callTool({ name: 'start_desktop_control', arguments: {} });
    const meta = result._meta?.liveDesktop as { ticket: string };
    assert.ok(meta.ticket); assert.ok(!JSON.stringify(result.content).includes(meta.ticket));
    assert.ok(JSON.stringify(result.content).includes('image/png'), 'model screenshot remains present');
    // The control handle and the viewer arrive together, and the handle does not depend on the text content
    const s = result.structuredContent as Record<string, unknown>;
    for (const k of ['controlId', 'frameId', 'nextRequestId']) assert.equal(typeof s[k], 'string', k);
    assert.ok(!JSON.stringify(s).includes('YWJj'), 'no screenshot bytes in structuredContent');
    assert.ok(!JSON.stringify(s).includes(meta.ticket));
    // A follow-up call carries the same stream with a newer seat, so its card can take over
    const shot = await client.callTool({ name: 'take_screenshot', arguments: { controlId: s.controlId } });
    const shotMeta = shot._meta?.liveDesktop as { ticket: string; seat: number };
    assert.equal(shotMeta.ticket, meta.ticket);
    assert.ok(shotMeta.seat > (meta as any).seat);
    assert.ok(!JSON.stringify(shot.content).includes(meta.ticket));
    // The same caller starting again (its first result was lost) gets a new working session, not a lockout
    const again = await client.callTool({ name: 'start_desktop_control', arguments: {} });
    assert.ok(!again.isError, JSON.stringify(again.content));
    assert.notEqual((again.structuredContent as any).controlId, s.controlId);
    assert.ok((again._meta?.liveDesktop as any).ticket);
    // ...and can always stop it, even without the id
    assert.ok(!(await client.callTool({ name: 'stop_desktop_control', arguments: {} })).isError);
  } finally { computer.close(); liveViewer.close(); await client.close(); await server.close(); }
});

it('a failed start dismisses the viewer; a viewer failure never hides a started session', async () => {
  const bridge: ComputerBridge = { close() {}, async request() { return { ok: true, image: 'YWJj', mimeType: 'image/png' }; } };
  const computer = new ComputerController(() => true, () => bridge);
  const liveViewer = new LiveDesktopViewer(computer, []);
  const connect = async (identity: string, viewer: unknown) => {
    const server = new McpServer({ name: 'test', version: '1' }), client = new Client({ name: 'test', version: '1' });
    registerComputerTools(server, { scope: 'pc.hosted', actor: identity, desktopAllowed: true, desktopIdentity: identity },
      { computer, liveViewer: viewer, liveViewerCards: true, publicUrl: 'https://helix.example', auth: { audit() {} } } as unknown as McpDeps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };
  const broken = { issue() { throw new Error('viewer exploded'); } };
  const owner = await connect('owner', broken), other = await connect('other', liveViewer);
  try {
    const started = await owner.callTool({ name: 'start_desktop_control', arguments: {} });
    assert.ok(!started.isError, JSON.stringify(started.content));
    assert.equal(typeof (started.structuredContent as any).controlId, 'string');
    assert.deepEqual(started._meta?.liveDesktop, { active: false });
    const blocked = await other.callTool({ name: 'start_desktop_control', arguments: {} });
    assert.equal(blocked.isError, true);
    assert.deepEqual(blocked._meta?.liveDesktop, { active: false });
  } finally { computer.close(); liveViewer.close(); await owner.close(); await other.close(); }
});

it('the card only dismisses itself when control ends, not when the video drops', () => {
  const script = liveViewerHtml().match(/<script>([\s\S]*)<\/script>/)![1]!;
  assert.match(script, /function recover/);
  assert.match(script, /Desktop control is unaffected/);
});

function uiHarness(opts: { pip?: boolean; panel?: boolean; host?: Record<string, unknown> } = {}) {
  const listeners: Record<string, (e: unknown) => void> = {}, docListeners: Record<string, () => void> = {}, posted: any[] = [], parent = { postMessage(m: unknown) { posted.push(m); } };
  let drawn = 0, now = 1000, dismissed = 0, cleared = 0, next = 0;
  const timers = new Map<number, () => void>(), intervals: (() => void)[] = [], sockets: any[] = [], peers: any[] = [];
  const buttons: any[] = [];
  const canvas = { hidden: true, width: 0, height: 0, getContext() { return { clearRect() {}, drawImage() { drawn++; } }; } };
  const pip = { element: null as any, exits: 0 }, videoEvents: Record<string, () => void> = {};
  const status = { hidden: false, textContent: '', style: {}, append() {} }, video = { currentTime: 0, srcObject: null, style: {} as { display?: string }, removeAttribute() {}, onplaying: null as any, pause() {}, play: async () => {},
    addEventListener(type: string, fn: () => void) { videoEvents[type] = fn; },
    async requestPictureInPicture() { pip.element = video; } };
  const popout = { hidden: true, textContent: 'Pop out', onclick: undefined as any };
  class WS {
    static OPEN = 1; readyState = 1; onclose: any; onerror: any; onmessage: any; onopen: any; closed = false; sent: any[] = [];
    constructor(readonly url: URL) { sockets.push(this); }
    close() { this.closed = true; this.readyState = 3; this.onclose?.({ code: 1000, reason: 'cleanup' }); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
  }
  class PC { connectionState = 'connected'; closed = false; constructor() { peers.push(this); } close() { this.closed = true; } }
  const context = {
    document: { querySelector: (selector: string) => selector === 'canvas' ? canvas : video, getElementById: (id: string) => id === 'popout' ? popout : status,
      pictureInPictureEnabled: opts.pip ?? true, get pictureInPictureElement() { return pip.element; },
      async exitPictureInPicture() { pip.element = null; pip.exits++; videoEvents.leavepictureinpicture?.(); }, createElement() { const b = { textContent: '', onclick: undefined }; buttons.push(b); return b; }, visibilityState: 'visible', hidden: false, addEventListener(type: string, fn: () => void) { docListeners[type] = fn; }, body: { scrollHeight: 360, replaceChildren() { cleared++; } } },
    window: { openai: Object.assign(opts.host ?? {}, { requestClose() { dismissed++; }, ...(opts.panel ? {} : { toolResponseMetadata: { liveDesktop: { origin: 'https://example.com', ticket: 'private-test-ticket', iceServers: [] } } }) }), parent, addEventListener(type: string, fn: (e: unknown) => void) { listeners[type] = fn; } },
    createImageBitmap: async () => ({ width: 640, height: 360, close() {} }), atob: (v: string) => Buffer.from(v, 'base64').toString('binary'), Blob: class { constructor(readonly parts: unknown[]) {} }, Uint8Array,
    WebSocket: WS, RTCPeerConnection: PC, URL, ResizeObserver: class { observe() {} },
    setInterval(fn: () => void) { intervals.push(fn); return 1; }, clearInterval() {},
    setTimeout(fn: () => void) { const id = ++next; timers.set(id, fn); return id; }, clearTimeout(id: number) { timers.delete(id); },
    Date: { now: () => now }, Promise,
  };
  runInNewContext(liveViewerHtml({ panel: opts.panel }).match(/<script>([\s\S]*)<\/script>/)![1]!, context);
  return { sockets, peers, status, video, timers, canvas, drawn: () => drawn, posted, intervals, body: context.document.body,
    hostSays: (m: unknown) => listeners.message?.({ source: parent, data: m }), docEvent: (type: string) => docListeners[type]?.(),
    toolResult: (params: unknown) => listeners.message?.({ source: parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params } }),
    setGlobals: () => listeners['openai:set_globals']?.({}), buttons, popout, pip, videoEvents, advance(ms: number) { now += ms; intervals.forEach(f => f()); },
    retry() { const [id, fn] = [...timers][0]!; timers.delete(id); fn(); },
    message(value: unknown) { sockets.at(-1).onmessage?.({ data: JSON.stringify(value) }); },
    dismissed: () => dismissed, cleared: () => cleared };
}

it('original encoder error survives cleanup and reconnect; stale callbacks cannot close a new player', () => {
  const h = uiHarness(), old = h.sockets[0], staleClose = old.onclose;
  h.message({ type: 'error', code: 'ENCODER_EXIT', message: 'Desktop encoder stopped (exit 1).', detail: 'Capture area outside screen.', diagnosticId: 'diagnostic-123' });
  assert.match(h.status.textContent, /ENCODER_EXIT.*exit 1.*Capture area outside screen.*diagnostic-123/);
  assert.ok(old.closed); assert.equal(h.dismissed(), 0); assert.equal(h.timers.size, 1);
  h.retry(); assert.equal(h.sockets.length, 2);
  staleClose({ code: 1006 }); assert.equal(h.sockets[1].closed, false);
  assert.match(h.status.textContent, /Capture area outside screen/);
  h.message({ type: 'ended' }); assert.equal(h.dismissed(), 0); assert.match(h.status.textContent, /Desktop control ended.*Capture area outside screen/);
  assert.equal(h.video.srcObject, null); assert.equal(h.timers.size, 0);
  h.buttons[0].onclick(); assert.equal(h.dismissed(), 1); assert.equal(h.cleared(), 1);
});

it('six-second heartbeat delay does not destroy video; sustained loss reconnects and expired tickets dismiss', () => {
  const h = uiHarness(); h.video.currentTime = 8; h.advance(8000);
  assert.equal(h.sockets[0].closed, false); assert.equal(h.timers.size, 0);
  h.video.currentTime = 32; h.advance(24_000);
  assert.equal(h.sockets[0].closed, true); assert.equal(h.timers.size, 1);
  assert.match(h.status.textContent, /SIGNAL_TIMEOUT/);
  h.retry(); h.sockets.at(-1).onclose({ code: 4404 });
  assert.equal(h.dismissed(), 0); assert.match(h.status.textContent, /Desktop control ended.*SIGNAL_TIMEOUT/); assert.equal(h.timers.size, 0);
});

it('browser disconnect reports actual close code, retries, and clears the error only when playback resumes', () => {
  const h = uiHarness(); h.sockets[0].onclose({ code: 1006, reason: '' });
  assert.match(h.status.textContent, /1006/); assert.equal(h.dismissed(), 0);
  h.retry(); h.sockets.at(-1).onopen();
  assert.match(h.sockets.at(-1).sent[0].message, /1006/);
  h.video.onplaying(); assert.equal(h.status.hidden, true);
  h.sockets.at(-1).onclose({ code: 1011, reason: '' }); assert.match(h.status.textContent, /1011/); assert.doesNotMatch(h.status.textContent, /1006/);
});

it('WebRTC failures select the authenticated compatibility stream, not another failing peer', () => {
  const h = uiHarness(); h.message({ type: 'error', code: 'WEBRTC_FAILED', message: 'ICE failed.' }); h.retry();
  assert.equal(h.sockets.at(-1).url.pathname, '/mcp/live-desktop/frames'); assert.equal(h.peers.length, 1);
  h.message({ type: 'ended' }); assert.equal(h.video.srcObject, null); assert.match(h.status.textContent, /ICE failed/);
});

it('normal control completion still dismisses the stream immediately', () => {
  const h = uiHarness(); h.message({ type: 'ended' }); assert.equal(h.dismissed(), 1); assert.equal(h.cleared(), 1);
});

it('compatibility route forwards separate JPEG frames and ends on control stop without refreshing control', async () => {
  const app = Fastify(); await app.register(websocket);
  const control = new Control(); let encoder: net.Socket | undefined, stopped = 0, capturePort = 0;
  control.startViewer = (async (_identity: string, _id: string, port: number, format: string) => {
    assert.equal(format, 'jpeg'); capturePort = port; encoder = net.createConnection({ port, host: '127.0.0.1' }); await once(encoder, 'connect');
    encoder.write(Buffer.from([0xff, 0xd8, 1, 2])); encoder.write(Buffer.from([3, 0xff, 0xd9])); return { ok: true };
  }) as typeof control.startViewer;
  control.stopViewer = async () => { stopped++; };
  const viewer = new LiveDesktopViewer(control, []); viewer.registerRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  let ws: WebSocket | undefined;
  try {
    const ticket = viewer.issue('owner', 'session').ticket;
    ws = new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp/live-desktop/frames?ticket=${ticket}`);
    const [frame, binary] = await once(ws, 'message'); assert.equal(binary, true); assert.deepEqual([...frame], [255,216,1,2,3,255,217]);
    encoder!.end(); await once(encoder!, 'close');
    encoder = net.createConnection({ port: capturePort, host: '127.0.0.1' }); await once(encoder, 'connect');
    const switched = once(ws, 'message'); encoder.write(Buffer.from([255,216,9,255,217]));
    assert.deepEqual([...(await switched)[0]], [255,216,9,255,217], 'monitor switch reconnects its encoder without ending the viewer');
    const ended = once(ws, 'message'); control.stop(); assert.equal(JSON.parse(String((await ended)[0])).type, 'ended');
    await new Promise(r => setImmediate(r)); assert.equal(stopped, 1);
  } finally { encoder?.destroy(); ws?.terminate(); viewer.close(); await app.close(); }
});

it('diagnostics redact capabilities and user paths without losing encoder errors', () => {
  const detail = viewerError(new Error('Encoder exited 1; wss://example.com/signal?ticket=abc token=private C:\\Users\\alice\\x\nv=0\na=ice-pwd:private'));
  assert.match(detail, /Encoder exited 1/); assert.doesNotMatch(detail, /abc|private|alice/);
});

it('logs the original signaling failure with the same diagnostic ID sent to the card; ended reconnect is explicit', async () => {
  const logs: any[] = [];
  const app = Fastify({ logger: { stream: { write(line: string) { logs.push(JSON.parse(line)); } } } });
  await app.register(websocket); const control = new Control(), viewer = new LiveDesktopViewer(control, []); viewer.registerRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp/live-desktop/signal`;
  let ws: WebSocket | undefined, ended: WebSocket | undefined;
  try {
    const ticket = viewer.issue('owner', 'session').ticket;
    ws = new WebSocket(`${base}?ticket=${ticket}`); await once(ws, 'open');
    const error = new Promise<any>(resolve => ws!.on('message', b => { const m = JSON.parse(String(b)); if (m.type === 'error') resolve(m); }));
    ws.send(JSON.stringify({ type: 'unexpected' }));
    const result = await error;
    assert.equal(result.code, 'NEGOTIATION'); assert.match(result.detail, /Invalid viewer signaling/);
    assert.ok(logs.some(l => l.diagnosticId === result.diagnosticId && l.code === result.code && l.detail === result.detail));
    assert.ok(!JSON.stringify(logs).includes(ticket));
    control.stop(); ended = new WebSocket(`${base}?ticket=${ticket}`);
    const message = await once(ended, 'message'); assert.equal(JSON.parse(String(message[0])).type, 'ended');
  } finally { ws?.terminate(); ended?.terminate(); viewer.close(); await app.close(); }
});

it('pop out: the floating window keeps this card on the stream until it is closed or control ends', async () => {
  const h = uiHarness();
  const settle = () => new Promise(r => setImmediate(r));
  h.video.onplaying?.();
  assert.equal(h.popout.hidden, false, 'offered once video plays');
  h.popout.onclick(); await settle();
  const sent = h.sockets.at(-1).sent;
  assert.ok(sent.some((m: any) => m.type === 'pin'), 'the gateway is told to keep the stream here');
  assert.ok(sent.some((m: any) => m.type === 'card_event' && m.event === 'popped_out'));
  assert.equal(h.popout.textContent, 'Bring back');
  // The user closes the floating window: newer cards may take over again
  h.pip.element = null; h.videoEvents.leavepictureinpicture!();
  assert.ok(sent.some((m: any) => m.type === 'unpin'));
  // Popped out again, then control ends: the floating window closes with it
  h.popout.onclick(); await settle();
  h.message({ type: 'ended' });
  assert.equal(h.pip.element, null);
  assert.ok(h.pip.exits >= 1);
});

it('pop out matrix: ChatGPT floating mode first, then the video window on the next tap, all logged', async () => {
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
  const events = (h: ReturnType<typeof uiHarness>) => h.sockets.at(-1).sent.filter((m: any) => m.type === 'card_event').map((m: any) => m.event + ' ' + m.detail);
  const pins = (h: ReturnType<typeof uiHarness>) => h.sockets.at(-1).sent.filter((m: any) => m.type === 'pin' || m.type === 'unpin').map((m: any) => m.type);

  // 1. Host grants pip: the stream is pinned, the browser window is never needed
  const asked: unknown[] = [];
  const pip = uiHarness({ host: { displayMode: 'inline', requestDisplayMode: async (a: unknown) => { asked.push(a); return { mode: 'pip' }; } } });
  pip.video.onplaying?.(); pip.popout.onclick(); await settle();
  assert.equal(JSON.stringify(asked), '[{"mode":"pip"}]');
  assert.ok(events(pip).some((e: string) => /^host_pip_granted .*granted=pip/.test(e)));
  assert.deepEqual(pins(pip), ['pin']); assert.equal(pip.pip.element, null, 'no browser video window opened'); assert.equal(pip.popout.textContent, 'Bring back');

  // 2. Mobile answers fullscreen: still counted as granted, and logged as such
  const full = uiHarness({ host: { displayMode: 'inline', requestDisplayMode: async () => ({ mode: 'fullscreen' }) } });
  full.video.onplaying?.(); full.popout.onclick(); await settle();
  assert.ok(events(full).some((e: string) => /^host_pip_granted .*granted=fullscreen/.test(e)));
  assert.deepEqual(pins(full), ['pin']);

  // 3. Host refuses: nothing is pinned; the next tap opens the browser's video window inside that tap
  const refused = uiHarness({ host: { displayMode: 'inline', requestDisplayMode: async () => ({ mode: 'inline' }) } });
  refused.video.onplaying?.(); refused.popout.onclick(); await settle();
  assert.ok(events(refused).some((e: string) => /^host_pip_refused .*granted=inline/.test(e)));
  assert.deepEqual(pins(refused), []); assert.equal(refused.popout.textContent, 'Pop out video');
  refused.popout.onclick(); await settle();
  assert.ok(refused.pip.element, 'second tap opens the video window'); assert.deepEqual(pins(refused), ['pin']);

  // 4. Host throws, and 5. no host API at all: straight to the video window
  const broke = uiHarness({ host: { displayMode: 'inline', requestDisplayMode: async () => { throw new Error('unsupported'); } } });
  broke.video.onplaying?.(); broke.popout.onclick(); await settle();
  assert.ok(events(broke).some((e: string) => /^host_pip_failed/.test(e)));
  const bare = uiHarness();
  bare.video.onplaying?.(); bare.popout.onclick(); await settle();
  assert.ok(bare.pip.element); assert.deepEqual(pins(bare), ['pin']);

  // 6. Neither works: a plain note, the card keeps working, nothing is pinned
  const none = uiHarness({ pip: false });
  none.video.onplaying?.(); none.popout.onclick(); await settle();
  assert.ok(events(none).some((e: string) => /^pip_failed/.test(e))); assert.deepEqual(pins(none), []);
  assert.match(none.status.textContent, /Pop-out is blocked/);

  // End of control while pinned in the host: the card closes itself and the pop-out goes with it
  pip.message({ type: 'ended' });
  assert.equal(pip.dismissed(), 1);
  // Bringing a host-pinned card back inline releases the stream for newer cards
  const back = uiHarness({ host: { displayMode: 'inline', requestDisplayMode: async () => ({ mode: 'pip' }) } });
  back.video.onplaying?.(); back.popout.onclick(); await settle(); back.popout.onclick(); await settle();
  assert.deepEqual(pins(back), ['pin', 'unpin']); assert.equal(back.popout.textContent, 'Pop out');
});

it('the host display mode is reported at connect and when it changes', () => {
  const host: Record<string, unknown> = { displayMode: 'inline' };
  const h = uiHarness({ host });
  h.sockets.at(-1).onopen();
  host.displayMode = 'fullscreen'; h.setGlobals();
  const modes = h.sockets.at(-1).sent.filter((m: any) => m.event === 'display_mode').map((m: any) => m.detail);
  assert.deepEqual(modes, ['inline', 'fullscreen']);
});

it('a card that loses the stream goes quiet: no reconnect, no request to close it', () => {
  const h = uiHarness();
  h.sockets.at(-1).onclose({ code: 4410, reason: 'Replaced by a newer viewer' });
  assert.match(h.status.textContent, /newest card/);
  assert.equal(h.timers.size, 0);
  assert.equal(h.dismissed(), 0, 'the host is never asked to close it');
  assert.equal(h.cleared(), 0);
});

it('a new card paints the screenshot that came with the tool result before the stream connects', async () => {
  const settle = () => new Promise(r => setImmediate(r));
  const h = uiHarness();
  const before = h.drawn();
  h.toolResult({ content: [{ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }],
    _meta: { liveDesktop: { origin: 'https://example.com', ticket: 'second-ticket', seat: 2, iceServers: [] } } });
  await settle(); await settle();
  assert.equal(h.drawn(), before + 1, 'the still is drawn at once');
  assert.equal(h.canvas.hidden, false);
  assert.equal(h.video.style.display, 'none');
  h.video.onplaying?.();
  assert.equal(h.canvas.hidden, true, 'live video replaces the still');
  assert.equal(h.video.style.display, '');
  // Once live, a later result never overwrites the stream with an older still
  const live = h.drawn();
  h.toolResult({ content: [{ type: 'image', data: Buffer.from('png').toString('base64') }], _meta: { liveDesktop: { origin: 'https://example.com', ticket: 'second-ticket', seat: 3, iceServers: [] } } });
  await settle(); await settle();
  assert.equal(h.drawn(), live);
});

it('the resource declares pip so ChatGPT may grant it, and the URI changed so hosts drop the cached card', () => {
  assert.match(LIVE_VIEWER_URI, /v4\.html$/);
});

it('a newer card shows a note while the stream plays in the pop-out, and never retries', () => {
  const h = uiHarness();
  h.sockets.at(-1).onclose({ code: 4411, reason: 'Live desktop is playing in the pop-out window.' });
  assert.match(h.status.textContent, /pop-out window/);
  assert.equal(h.timers.size, 0, 'no reconnect scheduled');
  assert.equal(h.dismissed(), 0);
});

it('a popped-out card keeps the stream: newer cards get 4411 until the pop-out closes', async () => {
  const control = new Control(), viewer = new LiveDesktopViewer(control, []);
  const app = Fastify({ logger: false }); await app.register(websocket); viewer.registerRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = (ticket: string, seat: number) => `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp/live-desktop/signal?ticket=${ticket}&seat=${seat}`;
  const sockets: WebSocket[] = [];
  const open = async (ticket: string, seat: number) => { const ws = new WebSocket(url(ticket, seat)); sockets.push(ws); await once(ws, 'open'); return ws; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    const first = viewer.issue('owner', 'session');
    const a = await open(first.ticket, first.seat);
    a.send(JSON.stringify({ type: 'pin' })); await wait(50);
    const second = viewer.issue('owner', 'session');
    const refused = new WebSocket(url(second.ticket, second.seat)); sockets.push(refused);
    assert.equal((await once(refused, 'close'))[0], 4411, 'the newer card is told the stream is popped out');
    assert.equal(a.readyState, WebSocket.OPEN, 'the popped-out card keeps streaming');
    a.send(JSON.stringify({ type: 'unpin' })); await wait(50);
    const third = viewer.issue('owner', 'session');
    const aClosed = once(a, 'close');
    const c = await open(third.ticket, third.seat);
    assert.equal((await aClosed)[0], 4410, 'after the pop-out closes, the newest card takes over as before');
    assert.equal(c.readyState, WebSocket.OPEN);
  } finally { for (const s of sockets) s.terminate(); viewer.close(); await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Helix Live thread panel
// ---------------------------------------------------------------------------------------------------------------------

async function panelServer() {
  const { LIVE_PANEL_URI, LIVE_PANEL_TOOL } = await import('../src/computer/live-viewer.js');
  const control = new Control(), viewer = new LiveDesktopViewer(control, []);
  const app = Fastify({ logger: false }); await app.register(websocket); viewer.registerRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  const open = (ticket: string, seat: number, panel?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp/live-desktop/signal?ticket=${ticket}&seat=${seat}${panel ? `&panel=${panel}` : ''}`);
    sockets.push(ws); return ws;
  };
  const opened = async (ws: WebSocket) => { await once(ws, 'open'); return ws; };
  const done = async () => { for (const s of sockets) s.terminate(); viewer.close(); await app.close(); };
  return { control, viewer, app, open, opened, done, LIVE_PANEL_URI, LIVE_PANEL_TOOL };
}

it('panel metadata: a read-only thread entrypoint with its own UI resource', async () => {
  const { LIVE_PANEL_URI, LIVE_PANEL_TOOL } = await import('../src/computer/live-viewer.js');
  const computer = new ComputerController(() => true, () => ({ close() {}, async request() { return { ok: true }; } } as ComputerBridge)), liveViewer = new LiveDesktopViewer(computer, []);
  const server = new McpServer({ name: 'test', version: '1' }), client = new Client({ name: 'test', version: '1' });
  registerComputerTools(server, { scope: 'pc.hosted', actor: 'test', desktopAllowed: true, desktopIdentity: 'owner' },
    { computer, liveViewer, liveViewerCards: true, publicUrl: 'https://helix.example', auth: { audit() {} } } as unknown as McpDeps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tool = (await client.listTools()).tools.find(t => t.name === LIVE_PANEL_TOOL)!;
    assert.ok(tool, 'registered');
    const meta = tool._meta as any;
    assert.equal(meta.ui.resourceUri, LIVE_PANEL_URI);
    // ChatGPT refuses to render widgets for app-only ("private") tools, so the host must be able to see it as a normal tool
    assert.deepEqual(meta.ui.visibility, ['model', 'app']);
    assert.match(String(tool.description), /Read-only/); assert.match(String(tool.description), /Do not call this to start, control or stop/);
    assert.deepEqual(meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.deepEqual(Object.keys((tool.inputSchema as any).properties ?? {}), ['peek'], 'the host calls it with {}; peek is optional');
    assert.deepEqual((tool.inputSchema as any).required ?? [], []);
    assert.notEqual(LIVE_PANEL_URI, LIVE_VIEWER_URI);
    const resource = (await client.readResource({ uri: LIVE_PANEL_URI })).contents[0] as any;
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.text, /"panel":true/);
    assert.deepEqual(resource._meta['openai/widgetCSP'].connect_domains, ['https://helix.example', 'wss://helix.example']);
    // Existing tool cards keep working unchanged
    assert.equal((await client.readResource({ uri: LIVE_VIEWER_URI })).contents[0]?.mimeType, 'text/html;profile=mcp-app');
    // No viewer configured (no public URL) or no desktop grant: no panel tool at all
    const bare = new McpServer({ name: 'test', version: '1' }); bare.registerTool('placeholder', { inputSchema: {} }, async () => ({ content: [] }));
    registerComputerTools(bare, { scope: 'pc.hosted', actor: 'test', desktopAllowed: false, desktopIdentity: 'owner' }, { computer, liveViewer, publicUrl: 'https://helix.example', auth: { audit() {} } } as unknown as McpDeps);
    const bareClient = new Client({ name: 'test', version: '1' }); const [c, d] = InMemoryTransport.createLinkedPair();
    await Promise.all([bare.connect(c), bareClient.connect(d)]);
    assert.ok(!(await bareClient.listTools()).tools.some(t => t.name === LIVE_PANEL_TOOL), 'no desktop grant, no panel');
    await bareClient.close(); await bare.close();
  } finally { computer.close(); liveViewer.close(); await client.close(); await server.close(); }
});

it('panel tool: no session means no ticket; it never starts control or renews the lease; scoped to the caller', async () => {
  const { LIVE_PANEL_TOOL } = await import('../src/computer/live-viewer.js');
  let now = Date.now(); const commands: any[] = [];
  const bridge: ComputerBridge = { close() {}, async request(command) { commands.push(command); return { ok: true, active: true, image: 'YWJj', mimeType: 'image/png' }; } };
  const computer = new ComputerController(() => true, () => bridge, () => now), liveViewer = new LiveDesktopViewer(computer, []);
  const audits: string[] = [];
  const make = async (identity: string) => {
    const server = new McpServer({ name: 'test', version: '1' }), client = new Client({ name: 'test', version: '1' });
    registerComputerTools(server, { scope: 'pc.hosted', actor: identity, desktopAllowed: true, desktopIdentity: identity },
      { computer, liveViewer, publicUrl: 'https://helix.example', auth: { audit: (_d: unknown, what: string) => audits.push(what) } } as unknown as McpDeps);
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
    return { client, server };
  };
  const owner = await make('owner'), other = await make('someone-else');
  try {
    // Nothing running: an honest "inactive", no capture, no commands, no audit noise
    const none = await owner.client.callTool({ name: LIVE_PANEL_TOOL, arguments: {} });
    assert.deepEqual((none._meta as any).liveDesktop, { active: false });
    assert.equal(commands.length, 0, 'looking starts nothing');
    assert.equal(audits.length, 0);
    const started = await owner.client.callTool({ name: 'start_desktop_control', arguments: {} });
    const controlId = (started.structuredContent as any).controlId as string;
    const commandsAfterStart = commands.length;
    // The owner gets a spectator ticket + panel key, in _meta only, never in what the model reads
    now += 100_000;
    const got = await owner.client.callTool({ name: LIVE_PANEL_TOOL, arguments: {} });
    const live = (got._meta as any).liveDesktop;
    assert.equal(live.active, true); assert.ok(live.ticket); assert.ok(live.panelKey); assert.equal(live.origin, 'https://helix.example');
    assert.ok(!JSON.stringify(got.content).includes(live.ticket) && !JSON.stringify(got.content).includes(live.panelKey));
    assert.ok(!JSON.stringify(got.structuredContent ?? {}).includes(live.ticket));
    assert.equal(commands.length, commandsAfterStart, 'no native command: no capture, no lease renewal');
    assert.ok(audits.includes(`mcp.${LIVE_PANEL_TOOL}`));
    assert.ok(!JSON.stringify(audits).includes(live.ticket));
    // Another credential sees nothing of the owner's session
    assert.deepEqual(((await other.client.callTool({ name: LIVE_PANEL_TOOL, arguments: {} }))._meta as any).liveDesktop, { active: false });
    assert.equal(liveViewer.issuePanel('someone-else').active, false);
    // The panel did not keep control alive: 100 s + the poll, then past the 120 s idle limit it is over
    now += 21_000;
    assert.equal(computer.isActive('owner', controlId), false, 'the panel poll did not extend the lease');
    assert.deepEqual(((await owner.client.callTool({ name: LIVE_PANEL_TOOL, arguments: {} }))._meta as any).liveDesktop, { active: false });
  } finally { computer.close(); liveViewer.close(); await owner.client.close(); await owner.server.close(); await other.client.close(); await other.server.close(); }
});

it('panel ownership needs a key the app-only tool issued: forged flags, card tickets and replays are refused', async () => {
  const t = await panelServer();
  const closeCode = async (ws: WebSocket) => (await once(ws, 'close'))[0];
  const status = async (ticket: string) => (await t.app.inject({ url: `/mcp/live-desktop/signal?ticket=${ticket}` })).statusCode;
  try {
    const card = t.viewer.issue('owner', 'session');
    const panel = t.viewer.issuePanel('owner') as { ticket: string; seat: number; panelKey: string };
    assert.equal(panel.ticket, card.ticket, 'one spectator ticket per control session');
    // A card cannot claim the panel by saying so: made-up key, its own seat, the ticket itself, the word "panel"
    for (const fake of ['panel', 'forged-key', String(card.seat), card.ticket]) {
      assert.equal(await closeCode(t.open(card.ticket, panel.seat + 5, fake)), 4403, `key "${fake.slice(0, 12)}" is refused`);
    }
    // The real panel claims the stream, and a card holding a NEWER seat is turned away with the panel note
    const p = await t.opened(t.open(panel.ticket, panel.seat, panel.panelKey));
    const newer = t.viewer.issue('owner', 'session');
    const cardSocket = t.open(newer.ticket, newer.seat);
    const [code, reason] = await once(cardSocket, 'close');
    assert.equal(code, 4411); assert.match(String(reason), /Helix Live panel/);
    assert.equal(p.readyState, WebSocket.OPEN, 'a tool card never takes the panel stream');
    // Control stops: everything is revoked, tickets and keys alike
    const seen: any[] = []; p.on('message', v => seen.push(JSON.parse(String(v))));
    const ended = once(p, 'close'); t.control.stop(); await ended;
    assert.ok(seen.some(m => m.type === 'ended'), 'the panel is told, and its stream is closed');
    assert.equal(await status(panel.ticket), 410, 'the old ticket is dead');
    assert.equal(t.viewer.issuePanel('owner').active, false, 'no session, nothing to hand out');
    // A new session of the same identity: the old key does not work on the new ticket
    t.control.active = true;
    const fresh = t.viewer.issuePanel('owner') as { ticket: string; seat: number; panelKey: string };
    assert.notEqual(fresh.ticket, panel.ticket); assert.notEqual(fresh.panelKey, panel.panelKey);
    assert.equal(await closeCode(t.open(fresh.ticket, fresh.seat, panel.panelKey)), 4403, 'a replayed key is refused');
    assert.equal(await status(panel.ticket), 410);
  } finally { await t.done(); }
});

it('panel owner: issuing never steals, a newer panel does, an older panel is refused, and a dropped panel reconnects without a new ticket', async () => {
  const t = await panelServer();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    const first = t.viewer.issuePanel('owner') as { ticket: string; seat: number; panelKey: string };
    const a = await t.opened(t.open(first.ticket, first.seat, first.panelKey));
    // Looking up again (a second poll, a second thread) hands out a new key but moves nothing by itself
    const second = t.viewer.issuePanel('owner') as { ticket: string; seat: number; panelKey: string };
    assert.ok(second.seat > first.seat); await wait(150);
    assert.equal(a.readyState, WebSocket.OPEN, 'issuing is not claiming');
    // The newer panel claims it; the older one is told where the stream went
    const aClosed = once(a, 'close');
    const b = await t.opened(t.open(second.ticket, second.seat, second.panelKey));
    assert.equal((await aClosed)[0], 4411); await wait(400); // the gateway finishes handing over before the next connect
    // The older panel cannot come back and fight for it
    assert.equal((await once(t.open(first.ticket, first.seat, first.panelKey), 'close'))[0], 4411);
    assert.equal(b.readyState, WebSocket.OPEN);
    // A dropped panel keeps its claim for the grace period: a card is still refused, the panel returns with the SAME seat and key
    b.terminate(); await wait(250);
    const card = t.viewer.issue('owner', 'session');
    assert.equal((await once(t.open(card.ticket, card.seat), 'close'))[0], 4411, 'handoff gap: cards cannot slip in');
    const back = await t.opened(t.open(second.ticket, second.seat, second.panelKey));
    await wait(150);
    assert.equal(back.readyState, WebSocket.OPEN, 'reconnect needs no new issuance');
  } finally { await t.done(); }
});

it('panel without a claim behaves like any card: no panel, no change to the card takeover rules', async () => {
  const t = await panelServer();
  try {
    const one = t.viewer.issue('owner', 'session');
    const a = await t.opened(t.open(one.ticket, one.seat));
    const two = t.viewer.issue('owner', 'session');
    const aClosed = once(a, 'close');
    await t.opened(t.open(two.ticket, two.seat));
    assert.equal((await aClosed)[0], 4410, 'newest card still wins when no panel is open');
  } finally { await t.done(); }
});

// ---- the panel page itself (UI state machine) ----

const settleAll = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const liveMeta = (ticket = 'panel-ticket', panelKey = 'key-1', seat = 2) => ({ _meta: { liveDesktop: { origin: 'https://example.com', ticket, seat, panelKey, iceServers: [] } } });
const lookups = (h: ReturnType<typeof uiHarness>) => h.posted.filter((m: any) => m.method === 'tools/call' && !m.params.arguments?.peek);
const peeks = (h: ReturnType<typeof uiHarness>) => h.posted.filter((m: any) => m.method === 'tools/call' && m.params.arguments?.peek === true);

it('panel page: idle until a session exists, looks up read-only, connects with its key, never dismisses itself', async () => {
  const h = uiHarness({ panel: true });
  assert.equal(h.sockets.length, 0, 'no stream without a session'); assert.match(h.status.textContent, /No desktop control is running/);
  // Host finished its handshake: the panel looks the session up through the app-only tool
  h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  const asked = lookups(h); assert.equal(asked.length, 1);
  assert.equal(asked[0].params.name, 'helix_live_panel'); assert.equal(JSON.stringify(asked[0].params.arguments), '{}');
  h.hostSays({ jsonrpc: '2.0', id: asked[0].id, result: { _meta: { liveDesktop: { active: false } } } }); await settleAll();
  assert.equal(h.sockets.length, 0, 'still nothing to watch'); assert.match(h.status.textContent, /No desktop control/);
  // A session appears: the next idle lookup finds it
  h.advance(4000); await settleAll();
  const second = lookups(h); assert.equal(second.length, 2);
  h.hostSays({ jsonrpc: '2.0', id: second[1].id, result: liveMeta() }); await settleAll();
  assert.equal(h.sockets.length, 1);
  const url = h.sockets[0].url as URL;
  assert.equal(url.pathname, '/mcp/live-desktop/signal'); assert.equal(url.searchParams.get('panel'), 'key-1'); assert.equal(url.searchParams.get('ticket'), 'panel-ticket');
  assert.match(h.status.textContent, /Connecting/);
  h.video.onplaying?.(); assert.equal(h.status.hidden, true, 'live');
  // While connected it does not look up again
  const before = lookups(h).length; h.advance(4000); h.advance(4000); await settleAll();
  assert.equal(lookups(h).length, before);
  assert.equal(h.dismissed(), 0); assert.equal(h.cleared(), 0);
  // The panel never sends anything but viewer messages
  assert.ok(h.sockets[0].sent.every((m: any) => ['card_event', 'ping', 'client_error', 'pin', 'unpin'].includes(m.type)));
});

it('panel page: control ends -> pixels cleared at once, waits for the next session, panel stays open', async () => {
  const h = uiHarness({ panel: true });
  h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  h.hostSays({ jsonrpc: '2.0', id: lookups(h)[0].id, result: liveMeta() }); await settleAll();
  h.video.onplaying?.(); h.canvas.hidden = false;
  h.message({ type: 'ended' });
  assert.equal(h.canvas.hidden, true, 'canvas hidden'); assert.equal(h.video.srcObject, null, 'video source dropped');
  assert.match(h.status.textContent, /Desktop control ended/); assert.equal(h.dismissed(), 1, 'a real end asks the host to close the panel (best effort)');
  assert.ok(h.sockets[0].closed);
  // Next session is picked up by the next idle lookup, with its own ticket and key
  const n = lookups(h).length; h.advance(4000); await settleAll();
  assert.equal(lookups(h).length, n + 1);
  h.hostSays({ jsonrpc: '2.0', id: lookups(h).at(-1).id, result: liveMeta('second-ticket', 'key-2', 1) }); await settleAll();
  assert.equal(h.sockets.length, 2); assert.equal((h.sockets[1].url as URL).searchParams.get('panel'), 'key-2');
});

it('panel page: stand-down by a newer panel waits for the user; a refused key looks up a fresh one; teardown ends it for good', async () => {
  const h = uiHarness({ panel: true });
  h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  h.hostSays({ jsonrpc: '2.0', id: lookups(h)[0].id, result: liveMeta() }); await settleAll();
  // Another panel holds the stream: note + button, no automatic fight
  h.sockets[0].onclose({ code: 4411, reason: 'Live desktop is playing in the Helix Live panel.' });
  assert.match(h.status.textContent, /Helix Live panel/); assert.equal(h.dismissed(), 0);
  const stood = lookups(h).length; h.advance(4000); h.advance(4000); await settleAll();
  assert.equal(lookups(h).length, stood, 'no lookups while standing down'); assert.equal(h.sockets.length, 1);
  h.hostSays({ jsonrpc: '2.0', id: peeks(h)[0].id, result: { _meta: { liveDesktop: { active: true, peek: true } } } }); await settleAll(); // it only peeks while standing
  assert.equal(h.popout.hidden, false); assert.equal(h.popout.textContent, 'Watch here');
  h.popout.onclick(); await settleAll();
  assert.equal(lookups(h).length, stood + 1, 'the button asks again');
  h.hostSays({ jsonrpc: '2.0', id: lookups(h).at(-1).id, result: liveMeta('t3', 'key-3', 3) }); await settleAll();
  assert.equal(h.sockets.length, 2);
  // The gateway says this key is not valid: no reconnect loop with it, a fresh lookup instead
  h.sockets[1].onclose({ code: 4403, reason: 'Not a Helix Live panel ticket' });
  assert.equal(h.timers.size, 0, 'no retry timer for a refused key'); assert.match(h.status.textContent, /ended|No desktop|Waiting/);
  const n = lookups(h).length; h.advance(4000); await settleAll(); assert.equal(lookups(h).length, n + 1);
  // The host unmounts the panel: nothing runs afterwards
  h.hostSays({ jsonrpc: '2.0', id: 77, method: 'ui/resource-teardown' });
  const m = lookups(h).length; h.advance(4000); h.advance(4000); await settleAll();
  assert.equal(lookups(h).length, m);
});

it('panel page: when WebRTC fails it falls back to the authenticated JPEG stream with the same key', async () => {
  const h = uiHarness({ panel: true });
  h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  h.hostSays({ jsonrpc: '2.0', id: lookups(h)[0].id, result: liveMeta() }); await settleAll();
  h.message({ type: 'error', code: 'WEBRTC_FAILED', message: 'peer failed' });
  h.retry(); await settleAll();
  const url = h.sockets.at(-1).url as URL;
  assert.equal(url.pathname, '/mcp/live-desktop/frames'); assert.equal(url.searchParams.get('panel'), 'key-1');
});

it('panel page: the host re-sending stale or other tools\' results on every tool call never ends or restarts the stream', async () => {
  const host: Record<string, unknown> = { displayMode: 'inline', toolResponseMetadata: { liveDesktop: { active: false } } };
  const h = uiHarness({ panel: true, host });
  h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  h.hostSays({ jsonrpc: '2.0', id: lookups(h)[0].id, result: liveMeta('live-ticket', 'key-live', 2) }); await settleAll();
  h.video.onplaying?.();
  assert.equal(h.sockets.length, 1);
  const pushes: unknown[] = [
    { _meta: { liveDesktop: { active: false } } },                                             // the panel's opening result, from before control started
    { _meta: { liveDesktop: { origin: 'https://example.com', ticket: 'live-ticket', seat: 9, iceServers: [] } } },   // a computer-use call's card result: same stream, newer seat
    { _meta: { liveDesktop: { origin: 'https://example.com', ticket: 'old-session-ticket', seat: 1, panelKey: 'old-key', iceServers: [] } } }, // a stale panel result
    { _meta: { liveDesktop: { origin: 'https://example.com', ticket: 'other-card-ticket', seat: 4, iceServers: [] } } },   // some other card's ticket
    { content: [{ type: 'text', text: 'ok' }] },                                               // a result with no stream data at all
  ];
  // Five sequential tool calls: each makes the host push a tool-result and fire set_globals with whatever it holds
  for (const push of pushes) {
    h.hostSays({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: push });
    host.toolResponseMetadata = (push as any)._meta ?? { liveDesktop: { active: false } };
    h.setGlobals(); h.advance(4000); await settleAll();
  }
  host.toolResponseMetadata = { liveDesktop: { active: false } }; h.setGlobals(); await settleAll();
  assert.equal(h.sockets.length, 1, 'no reconnect, no second stream'); assert.equal(h.sockets[0].closed, false, 'the stream was never released');
  assert.equal(h.status.hidden, true, 'still showing live video'); assert.doesNotMatch(h.status.textContent, /ended|Waiting/);
  assert.equal(h.dismissed(), 0);
  assert.equal(lookups(h).length, 1, 'no lookups while it is watching');
  // Only the gateway ends it
  h.message({ type: 'ended' });
  assert.match(h.status.textContent, /Desktop control ended/); assert.ok(h.sockets[0].closed);
});

it('panel page: opened while control is already running, the host\'s opening result (with a panel key) starts the stream', async () => {
  const host: Record<string, unknown> = { displayMode: 'inline', toolResponseMetadata: liveMeta('open-ticket', 'open-key', 3)._meta };
  const h = uiHarness({ panel: true, host });
  assert.equal(h.sockets.length, 1); assert.equal((h.sockets[0].url as URL).searchParams.get('panel'), 'open-key');
});

it('three or more computer-use calls while the Helix Live panel is mounted: it keeps the stream until control actually stops', async () => {
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const bridge: ComputerBridge = { close() {}, async request(command: any) {
    if (command.op === 'stop') return { ok: true, active: false };
    return { ok: true, active: true, image: 'YWJj', mimeType: 'image/png', executed: true, width: 100, height: 100, bounds: { x: 0, y: 0, width: 100, height: 100 },
      layout: 'one-monitor', monitorId: 'm1', activeWindow: { handle: 'w1' }, capturedAt: new Date().toISOString() };
  } };
  const computer = new ComputerController(() => true, () => bridge), liveViewer = new LiveDesktopViewer(computer, []);
  const app = Fastify({ logger: false }); await app.register(websocket); liveViewer.registerRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const server = new McpServer({ name: 'test', version: '1' }), client = new Client({ name: 'test', version: '1' });
  registerComputerTools(server, { scope: 'pc.hosted', actor: 'test', desktopAllowed: true, desktopIdentity: 'owner' },
    { computer, liveViewer, liveViewerCards: true, publicUrl: 'https://helix.example', auth: { audit() {} } } as unknown as McpDeps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const sockets: WebSocket[] = [];
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content).slice(0, 200)}`); return r;
    };
    // The panel is opened by the user first: nothing running yet, so the host's opening call answers "inactive"
    assert.deepEqual(((await call('helix_live_panel'))._meta as any).liveDesktop, { active: false });
    const started = await call('start_desktop_control');
    const controlId = (started.structuredContent as any).controlId as string;
    // The panel's next lookup finds the session and connects with its key
    const found = ((await call('helix_live_panel'))._meta as any).liveDesktop as { ticket: string; seat: number; panelKey: string };
    assert.ok(found.ticket && found.panelKey);
    const messages: any[] = [];
    const panel = new WebSocket(`ws://127.0.0.1:${port}/mcp/live-desktop/signal?ticket=${found.ticket}&seat=${found.seat}&panel=${found.panelKey}`);
    sockets.push(panel); panel.on('message', v => messages.push(JSON.parse(String(v))));
    await once(panel, 'open'); await wait(200);
    // Five more computer-use calls, each carrying a card with a newer seat, and each card trying to take the stream
    let frame = JSON.parse((((await call('take_screenshot', { controlId })).content as any[])[0]).text) as { frameId: string; nextRequestId: string };
    const seats: number[] = [];
    for (const [name, extra] of [['press_key', { key: 'enter' }], ['scroll', { x: 10, y: 10, delta: -3 }], ['press_key', { key: 'escape' }], ['take_screenshot', {}], ['press_key', { key: 'tab' }]] as const) {
      const args = name === 'take_screenshot' ? { controlId, ...extra } : { controlId, requestId: frame.nextRequestId, frameId: frame.frameId, ...extra };
      const result = await call(name, args as Record<string, unknown>);
      const card = (result._meta as any).liveDesktop as { ticket: string; seat: number };
      assert.equal(card.ticket, found.ticket, 'same control session, same viewer ticket'); seats.push(card.seat);
      const cardSocket = new WebSocket(`ws://127.0.0.1:${port}/mcp/live-desktop/signal?ticket=${card.ticket}&seat=${card.seat}`); sockets.push(cardSocket);
      assert.equal((await once(cardSocket, 'close'))[0], 4411, `${name}: the tool card is turned away`);
      const next = JSON.parse((((result.content as any[])[0]).text)) as { frameId?: string; nextRequestId?: string };
      if (next.frameId && next.nextRequestId) frame = { frameId: next.frameId, nextRequestId: next.nextRequestId };
      assert.equal(panel.readyState, WebSocket.OPEN, `${name}: the panel still has the stream`);
      assert.ok(!messages.some(m => m.type === 'ended' || m.type === 'error'), `${name}: no ended or error signal reached the panel`);
    }
    assert.deepEqual([...seats].sort((x, y) => x - y), seats, 'cards keep getting newer seats');
    assert.equal(computer.isActive('owner', controlId), true, 'control itself is untouched by the panel');
    // The real stop is what ends the panel
    await call('stop_desktop_control', { controlId });
    await wait(200);
    assert.ok(messages.some(m => m.type === 'ended'), 'the panel is told when control really stops');
    assert.equal(panel.readyState === WebSocket.CLOSED || panel.readyState === WebSocket.CLOSING, true);
    assert.equal(liveViewer.issuePanel('owner').active, false);
  } finally { for (const s of sockets) s.terminate(); computer.close(); liveViewer.close(); await client.close(); await server.close(); await app.close(); }
});

it('cards off (the default): no live-desktop card under any tool call; the Helix Live panel is the only viewer', async () => {
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const bridge: ComputerBridge = { close() {}, async request(command: any) {
    if (command.op === 'stop') return { ok: true, active: false };
    return { ok: true, active: true, image: 'YWJj', mimeType: 'image/png', executed: true, width: 100, height: 100, bounds: { x: 0, y: 0, width: 100, height: 100 },
      layout: 'one-monitor', monitorId: 'm1', activeWindow: { handle: 'w1' }, capturedAt: new Date().toISOString() };
  } };
  const computer = new ComputerController(() => true, () => bridge), liveViewer = new LiveDesktopViewer(computer, []);
  const server = new McpServer({ name: 'test', version: '1' }), client = new Client({ name: 'test', version: '1' });
  const { LIVE_PANEL_TOOL, LIVE_PANEL_URI } = await import('../src/computer/live-viewer.js');
  registerComputerTools(server, { scope: 'pc.hosted', actor: 'test', desktopAllowed: true, desktopIdentity: 'owner' },
    { computer, liveViewer, publicUrl: 'https://helix.example', auth: { audit() {} } } as unknown as McpDeps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    // The only tool with a widget is the panel's
    assert.deepEqual(tools.filter(t => t._meta?.['openai/outputTemplate'] || (t._meta as any)?.ui?.resourceUri).map(t => t.name), [LIVE_PANEL_TOOL]);
    await assert.rejects(client.readResource({ uri: LIVE_VIEWER_URI }), 'the per-call card resource is not even registered');
    assert.equal((await client.readResource({ uri: LIVE_PANEL_URI })).contents[0]?.mimeType, 'text/html;profile=mcp-app');
    // Every computer-use result is plain: no card data, no viewer ticket
    const started = await client.callTool({ name: 'start_desktop_control', arguments: {} });
    const controlId = (started.structuredContent as any).controlId as string;
    assert.equal(started._meta?.liveDesktop, undefined);
    let frame = JSON.parse((((await client.callTool({ name: 'take_screenshot', arguments: { controlId } })).content as any[])[0]).text) as { frameId: string; nextRequestId: string };
    for (const key of ['enter', 'escape', 'tab']) {
      const r = await client.callTool({ name: 'press_key', arguments: { controlId, requestId: frame.nextRequestId, frameId: frame.frameId, key } });
      assert.ok(!r.isError); assert.equal(r._meta?.liveDesktop, undefined, 'no card under press_key');
      const next = JSON.parse((((r.content as any[])[0]).text)) as { frameId?: string; nextRequestId?: string };
      if (next.frameId && next.nextRequestId) frame = { frameId: next.frameId, nextRequestId: next.nextRequestId };
    }
    // The panel still finds the session by itself
    const found = ((await client.callTool({ name: LIVE_PANEL_TOOL, arguments: {} }))._meta as any).liveDesktop;
    assert.ok(found.ticket && found.panelKey);
    await wait(10);
    assert.ok(!(await client.callTool({ name: 'stop_desktop_control', arguments: { controlId } })).isError);
  } finally { computer.close(); liveViewer.close(); await client.close(); await server.close(); }
});

it('HELIX_VIEWER_CARDS turns the per-call cards back on; they are off unless it is "true"', () => {
  assert.equal(loadConfig({}).viewerCards, false);
  assert.equal(loadConfig({ HELIX_VIEWER_CARDS: 'false' }).viewerCards, false);
  assert.equal(loadConfig({ HELIX_VIEWER_CARDS: 'true' }).viewerCards, true);
});

it('panel page: "Watch here" restores the video box (it used to collapse to a thin line); the panel has a minimum height', async () => {
  assert.match(liveViewerHtml({ panel: true }), /main\{position:relative;min-height:200px/);
  assert.doesNotMatch(liveViewerHtml(), /min-height:200px/, 'cards are unchanged');
  const h = uiHarness({ panel: true });
  h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  h.hostSays({ jsonrpc: '2.0', id: lookups(h)[0].id, result: liveMeta() }); await settleAll();
  h.sockets[0].onclose({ code: 4411, reason: 'Live desktop is playing in the Helix Live panel.' });
  assert.equal(h.video.style.display, 'none'); assert.equal(h.popout.textContent, 'Watch here');
  const before = lookups(h).length;
  h.popout.onclick(); await settleAll();
  assert.equal(h.video.style.display, '', 'the video box is back, so the panel keeps its height');
  assert.equal(lookups(h).length, before + 1); assert.equal(h.popout.hidden, true);
  // Even if the lookup never answers, the page is not left collapsed
  assert.match(h.status.textContent, /Looking for the desktop/);
});

it('panel page: a displaced copy takes the stream back by itself when it becomes the one on screen', async () => {
  const h = uiHarness({ panel: true });
  h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  h.hostSays({ jsonrpc: '2.0', id: lookups(h)[0].id, result: liveMeta() }); await settleAll();
  h.sockets[0].onclose({ code: 4411, reason: 'Live desktop is playing in the Helix Live panel.' });
  const stood = lookups(h).length; h.advance(4000); await settleAll();
  assert.equal(lookups(h).length, stood, 'no automatic fight while it is not the visible one');
  h.docEvent('visibilitychange'); await settleAll();
  assert.equal(lookups(h).length, stood + 1, 'becoming visible reclaims it');
  h.hostSays({ jsonrpc: '2.0', id: lookups(h).at(-1).id, result: liveMeta('again', 'key-again', 5) }); await settleAll();
  assert.equal(h.sockets.length, 2); assert.equal((h.sockets[1].url as URL).searchParams.get('panel'), 'key-again');
  // Becoming visible while it is already watching does nothing
  h.docEvent('visibilitychange'); await settleAll();
  assert.equal(lookups(h).length, stood + 1);
});

it('panel page: it asks the host to close only when control really ended, never for other transitions', async () => {
  const open = async () => {
    const h = uiHarness({ panel: true });
    h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
    h.hostSays({ jsonrpc: '2.0', id: lookups(h)[0].id, result: liveMeta() }); await settleAll();
    return h;
  };
  const refused = await open(); refused.sockets[0].onclose({ code: 4403, reason: 'Not a Helix Live panel ticket' });
  assert.equal(refused.dismissed(), 0, 'a refused key looks up a fresh one; it does not close');
  const stood = await open(); stood.sockets[0].onclose({ code: 4411, reason: 'x' });
  assert.equal(stood.dismissed(), 0, 'standing down does not close');
  const idle = uiHarness({ panel: true }); idle.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  idle.hostSays({ jsonrpc: '2.0', id: lookups(idle)[0].id, result: { _meta: { liveDesktop: { active: false } } } }); await settleAll();
  assert.equal(idle.dismissed(), 0, 'no session yet: nothing to close');
  const ended = await open(); ended.sockets[0].onclose({ code: 4404, reason: 'Desktop control ended' });
  assert.equal(ended.dismissed(), 1, 'close code 4404 is a real end');
  assert.ok(ended.sockets[0].sent.length >= 0);
  // The host may ignore the request: the panel still waits for the next session
  const n = lookups(ended).length; ended.advance(4000); await settleAll();
  assert.equal(lookups(ended).length, n + 1);
});

it('panel tool peek: says whether a session exists and issues nothing', async () => {
  const { LIVE_PANEL_TOOL } = await import('../src/computer/live-viewer.js');
  const bridge: ComputerBridge = { close() {}, async request() { return { ok: true, active: true, image: 'YWJj', mimeType: 'image/png', width: 100, height: 100, bounds: { x: 0, y: 0, width: 100, height: 100 }, layout: 'l', monitorId: 'm', activeWindow: { handle: 'w' } }; } };
  const computer = new ComputerController(() => true, () => bridge), liveViewer = new LiveDesktopViewer(computer, []);
  const audits: string[] = [];
  const server = new McpServer({ name: 'test', version: '1' }), client = new Client({ name: 'test', version: '1' });
  registerComputerTools(server, { scope: 'pc.hosted', actor: 'test', desktopAllowed: true, desktopIdentity: 'owner' },
    { computer, liveViewer, publicUrl: 'https://helix.example', auth: { audit: (_d: unknown, what: string) => audits.push(what) } } as unknown as McpDeps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const peek = async () => ((await client.callTool({ name: LIVE_PANEL_TOOL, arguments: { peek: true } }))._meta as any).liveDesktop;
    assert.deepEqual(await peek(), { active: false, peek: true });
    await client.callTool({ name: 'start_desktop_control', arguments: {} });
    for (let i = 0; i < 3; i++) assert.deepEqual(await peek(), { active: true, peek: true }, 'no ticket, no key');
    assert.equal(audits.filter(w => w === `mcp.${LIVE_PANEL_TOOL}`).length, 0, 'peeking is not audited and issues nothing');
    // Nothing was issued by the peeks: the first real lookup is still seat 1
    const real = ((await client.callTool({ name: LIVE_PANEL_TOOL, arguments: {} }))._meta as any).liveDesktop;
    assert.equal(real.seat, 1); assert.ok(real.ticket && real.panelKey);
    await client.callTool({ name: 'stop_desktop_control', arguments: {} });
    assert.deepEqual(await peek(), { active: false, peek: true });
  } finally { computer.close(); liveViewer.close(); await client.close(); await server.close(); }
});

it('panel page: a copy that stood down still learns the session ended (peeks) and closes; it never reclaims by peeking', async () => {
  const h = uiHarness({ panel: true });
  h.hostSays({ jsonrpc: '2.0', id: 1, result: {} }); await settleAll();
  h.hostSays({ jsonrpc: '2.0', id: lookups(h)[0].id, result: liveMeta() }); await settleAll();
  // A second copy took the stream: this one stands down and so will never hear the gateway's "ended"
  h.sockets[0].onclose({ code: 4411, reason: 'Live desktop is playing in the Helix Live panel.' });
  assert.equal(h.dismissed(), 0);
  h.advance(4000); await settleAll();
  assert.equal(peeks(h).length, 1, 'it peeks while standing'); assert.equal(lookups(h).length, 1, 'no ticket lookups');
  h.hostSays({ jsonrpc: '2.0', id: peeks(h)[0].id, result: { _meta: { liveDesktop: { active: true, peek: true } } } }); await settleAll();
  assert.equal(h.sockets.length, 1, 'a running session does not make it fight for the stream'); assert.equal(h.dismissed(), 0);
  assert.equal(h.popout.textContent, 'Watch here');
  // The session ends: the standing copy closes itself, like the other copy does
  h.advance(4000); await settleAll();
  assert.equal(peeks(h).length, 2);
  h.hostSays({ jsonrpc: '2.0', id: peeks(h)[1].id, result: { _meta: { liveDesktop: { active: false, peek: true } } } }); await settleAll();
  assert.equal(h.dismissed(), 1, 'asked the host to close it'); assert.match(h.status.textContent, /Desktop control ended/);
  assert.equal(h.popout.hidden, true); assert.equal(h.video.style.display, '');
});
