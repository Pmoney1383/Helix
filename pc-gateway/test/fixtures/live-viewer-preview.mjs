// Explicit local-only real-desktop QA. No input actions, no recording, no public routes.
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import { ComputerController } from '../../dist/src/computer/controller.js';
import { LiveDesktopViewer } from '../../dist/src/computer/live-viewer.js';
import { liveViewerHtml } from '../../dist/src/computer/live-viewer-ui.js';
const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true }); await app.register(websocket);
// Optional manual helper launch for restricted development shells that cannot spawn from Node.
// Run hooks/computer-helper.ps1 -Bootstrap data/live-preview/bootstrap.json in a second shell.
let manual;
if (process.argv.includes('--manual-helper')) {
  const config = { pipe: `helix-computer-${randomUUID()}`, secret: randomBytes(32).toString('hex') };
  fs.mkdirSync('data/live-preview', { recursive: true }); fs.writeFileSync('data/live-preview/bootstrap.json', JSON.stringify(config));
  const pending = new Map(); let socket, buffer = '', next = 0;
  manual = { close() { socket?.destroy(); }, async request(command) {
    if (!socket) {
      socket = net.createConnection(`\\\\.\\pipe\\${config.pipe}`); socket.setEncoding('utf8');
      socket.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (value.event === 'control_stopped') manual.onControlStopped?.(); else { pending.get(value.id)?.(value); pending.delete(value.id); }
      } });
      socket.on('error', () => manual.onControlStopped?.()); socket.on('close', () => manual.onControlStopped?.());
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      await this.request({ op: 'hello', secret: config.secret });
    }
    return new Promise((resolve, reject) => { const id = String(++next); const timer = setTimeout(() => reject(Error('Helper timed out')), 15000);
      pending.set(id, value => { clearTimeout(timer); resolve(value); }); socket.write(JSON.stringify({ ...command, id }) + '\n'); });
  } };
}
if (process.argv.includes('--synthetic')) manual = {
  async request(command) {
    if (command.op === 'viewer_start') { fs.mkdirSync('data/live-preview', { recursive: true }); fs.writeFileSync('data/live-preview/port.txt', String(command.port)); }
    return { ok: true, active: true };
  }, close() {},
};
const controller = new ComputerController(id => id === 'local-preview', manual ? () => manual : undefined);
const viewer = new LiveDesktopViewer(controller, []); viewer.registerRoutes(app);
const nonce = randomBytes(32).toString('hex'); let controlId, timer;
app.addHook('preHandler', async (req, reply) => {
  if (req.method === 'POST' && req.headers['x-preview-token'] !== nonce) return reply.code(403).send({ error: 'Forbidden' });
});
app.post('/start', async () => {
  if (controlId) await controller.stop('local-preview', controlId);
  const result = await controller.start('local-preview');
  if (!result.ok) throw new Error(result.error);
  controlId = result.controlId; clearTimeout(timer);
  timer = setTimeout(() => { void controller.stop('local-preview', controlId); }, 110_000);
  return { _meta: { liveDesktop: { origin: 'http://127.0.0.1:7799', ...viewer.issue('local-preview', controlId) } } };
});
app.post('/stop', async () => { if (controlId) await controller.stop('local-preview', controlId); return { ok: true }; });
app.get('/', async (_req, reply) => reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Helix viewer QA</title>
<body style="background:#222;color:white;font:16px system-ui"><h3>Local ${process.argv.includes('--synthetic') ? 'encoder-pattern' : 'real-desktop'} QA — auto-stop after 110 seconds</h3>
<button id="start">Start desktop preview</button><button id="stop">Stop control</button><p id="status">Ready</p><iframe title="Live desktop" style="width:650px;height:370px;border:0"></iframe>
<script>const f=document.querySelector('iframe');let result;
const call=async path=>{const r=await fetch(path,{method:'POST',headers:{'x-preview-token':'${nonce}'}});const data=await r.json();if(!r.ok)throw Error(data.message);return data;};
document.getElementById('start').onclick=async()=>{try{result=await call('/start');f.style.height='370px';f.srcdoc=${JSON.stringify(liveViewerHtml().replace('<script>', process.argv.includes('--fallback-test') ? '<script>window.RTCPeerConnection=class {constructor(){throw Error("Forced WebRTC failure for fallback QA")}};</script><script>' : '<script>')).replace(/</g, '\\u003c')};}catch(e){document.getElementById('status').textContent=e.message;}};
document.getElementById('stop').onclick=()=>call('/stop');
window.addEventListener('message',e=>{if(e.source!==f.contentWindow)return;
if(e.data.method==='ui/initialize')f.contentWindow.postMessage({jsonrpc:'2.0',id:1,result:{}},'*');
if(e.data.method==='ui/notifications/initialized')f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result},'*');
if(e.data.method==='ui/notifications/size-changed'&&e.data.params.height===0){f.style.height='0';document.getElementById('status').textContent='Viewer dismissed';}});
setInterval(()=>{const v=f.contentDocument?.querySelector('video');if(v)document.getElementById('status').textContent='Video: '+v.videoWidth+'x'+v.videoHeight+' | time: '+v.currentTime.toFixed(1)+' | decoded frames: '+v.getVideoPlaybackQuality().totalVideoFrames+' | paused: '+v.paused;},500);
</script>`));
await app.listen({ host: '127.0.0.1', port: 7799 }); console.log('Local actual desktop QA: http://127.0.0.1:7799');
const stop = async () => { clearTimeout(timer); viewer.close(); controller.close(); await app.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
