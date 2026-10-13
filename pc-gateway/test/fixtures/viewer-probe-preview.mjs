// Local, synthetic-only browser harness. Run after npm run build; never loaded by the service.
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { ViewerProbe } from "../../dist/src/computer/viewer-probe.js";
import { viewerProbeHtml } from "../../dist/src/computer/viewer-probe-ui.js";

const app = Fastify({ logger: false });
await app.register(websocket);
const probe = new ViewerProbe(id => id === "preview");
probe.registerRoutes(app);
app.get("/", async (_req, reply) => {
  const port = app.server.address().port;
  const config = { viewerProbe: { origin: `http://127.0.0.1:${port}`, ticket: probe.issue("preview") } };
  return reply.type("text/html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Helix probe local harness</title></head>
  <body style="margin:20px;background:#252525;color:white;font:14px system-ui"><p>LOCAL HARNESS — not ChatGPT. Synthetic video only.</p>
  <iframe title="Helix viewer probe" style="width:min(100%,680px);height:820px;border:0" sandbox="allow-scripts allow-same-origin"></iframe>
  <script>const f=document.querySelector('iframe');
  window.addEventListener('message', e=>{ if(e.source!==f.contentWindow)return;
    if(e.data.method==='ui/initialize')f.contentWindow.postMessage({jsonrpc:'2.0',id:e.data.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'Local test harness',version:'1'},hostCapabilities:{},hostContext:{displayMode:'inline'}}},'*');
    if(e.data.method==='ui/notifications/initialized')f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{_meta:${JSON.stringify(config)}}},'*');
    if(e.data.method==='ui/request-display-mode')f.contentWindow.postMessage({jsonrpc:'2.0',id:e.data.id,error:{code:-32601,message:'Harness does not support display changes'}},'*');
  }); f.srcdoc=${JSON.stringify(viewerProbeHtml()).replace(/</g, "\\u003c")};</script></body></html>`);
});
await app.listen({ host: "127.0.0.1", port: 7798 });
console.log("Synthetic viewer harness: http://127.0.0.1:7798");
const stop = async () => { await app.close(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
