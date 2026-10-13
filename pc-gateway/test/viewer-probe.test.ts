import assert from "node:assert/strict";
import { once } from "node:events";
import { it } from "node:test";
import { Script } from "node:vm";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ViewerProbe, VIEWER_PROBE_URI } from "../src/computer/viewer-probe.js";
import { viewerProbeHtml } from "../src/computer/viewer-probe-ui.js";
import { remoteSenderHtml } from "../src/computer/viewer-remote.js";
import { buildGateway } from "../src/app.js";
import { openDb } from "../src/storage/sqlite.js";
import { FakeProvider } from "../src/providers/fake.js";

it("probe tickets expire, honor revocation, and cannot be guessed", () => {
  let now = 1000, allowed = true;
  const probe = new ViewerProbe(id => id === "owner" && allowed, () => now);
  assert.throws(() => probe.issue("other"), /disabled/);
  const ticket = probe.issue("owner");
  assert.equal(probe.valid(ticket), true);
  assert.equal(probe.valid("invalid"), false);
  allowed = false; assert.equal(probe.valid(ticket), false);
  allowed = true; now += 300_000; assert.equal(probe.valid(ticket), false);
});

it("serves authenticated synthetic ticks and pongs; revocation ends the stream", async () => {
  const app = Fastify(); await app.register(websocket);
  let allowed = true;
  const probe = new ViewerProbe(() => allowed); probe.registerRoutes(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let ws: WebSocket | undefined;
  try {
    assert.equal((await app.inject({ url: "/mcp/viewer-probe/ping" })).statusCode, 401);
    const ticket = probe.issue("owner");
    const ping = await app.inject({ url: `/mcp/viewer-probe/ping?ticket=${ticket}` });
    assert.equal(ping.json().synthetic, true);
    assert.equal(ping.headers["cache-control"], "no-store");
    ws = new WebSocket(`${base.replace("http", "ws")}/mcp/viewer-probe/stream?ticket=${ticket}`);
    await once(ws, "open");
    const pong = once(ws, "message"); ws.send(JSON.stringify({ type: "ping", id: 123 }));
    assert.deepEqual(JSON.parse(String((await pong)[0])), { type: "pong", id: 123 });
    assert.equal(JSON.parse(String((await once(ws, "message"))[0])).type, "tick");
    const closed = once(ws, "close"); allowed = false; await closed;
    assert.equal((await app.inject({ url: `/mcp/viewer-probe/ping?ticket=${ticket}` })).statusCode, 401);
  } finally { ws?.terminate(); await app.close(); }
});

it("registers the UI only for desktop-granted callers and hides network tickets from model content", async () => {
  const db = openDb(":memory:");
  const gw = await buildGateway({ logLevel: "silent", defaultProjectPath: process.cwd(), publicUrl: "https://helix.example" }, db, { claude: new FakeProvider() });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  const token = gw.localTokens.create("viewer-test", "pc.hosted");
  const client = new Client({ name: "probe-test", version: "1" });
  try {
    const port = (gw.app.server.address() as { port: number }).port;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token.token}` } } }));
    assert.ok(!(await client.listTools()).tools.some(t => t.name === "test_desktop_viewer"));
    gw.localTokens.setDesktopAccess(token.id, true);
    const tool = (await client.listTools()).tools.find(t => t.name === "test_desktop_viewer")!;
    assert.equal(tool._meta?.["openai/outputTemplate"], VIEWER_PROBE_URI);
    assert.equal(tool._meta?.["openai/widgetAccessible"], true, "the card can call it for a fresh ticket");
    const resource = (await client.readResource({ uri: VIEWER_PROBE_URI })).contents[0]!;
    assert.equal(resource.mimeType, "text/html;profile=mcp-app");
    assert.ok("text" in resource);
    assert.match(resource.text, /SYNTHETIC TEST/);
    const result = await client.callTool({ name: "test_desktop_viewer", arguments: {} });
    const meta = result._meta?.viewerProbe as { ticket: string };
    assert.ok(meta.ticket);
    assert.ok(!JSON.stringify([result.content, result.structuredContent]).includes(meta.ticket));
    // Calling again (what the card does on every Run) hands out a different, working ticket
    const again = (await client.callTool({ name: "test_desktop_viewer", arguments: {} }))._meta?.viewerProbe as { ticket: string };
    assert.notEqual(again.ticket, meta.ticket);
    assert.equal((await gw.app.inject({ url: `/mcp/viewer-probe/ping?ticket=${again.ticket}` })).statusCode, 200);
    assert.equal((await gw.app.inject({ url: `/mcp/viewer-probe/ping?ticket=${meta.ticket}`, headers: { "tailscale-funnel-request": "1" } })).statusCode, 200);
    assert.equal((await gw.app.inject({ url: "/v1/sessions", headers: { "tailscale-funnel-request": "1" } })).statusCode, 404);
    gw.localTokens.setDesktopAccess(token.id, false);
    assert.equal((await gw.app.inject({ url: `/mcp/viewer-probe/ping?ticket=${meta.ticket}` })).statusCode, 401);
  } finally { await client.close(); await gw.app.close(); db.close(); }
});

it("emits standalone browser JavaScript without desktop capture APIs", () => {
  const html = viewerProbeHtml();
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
  new Script(script);
  assert.doesNotMatch(script, /getDisplayMedia|getUserMedia|start_desktop_control/);
  assert.match(script, /tools\/call/, "every Run asks for a fresh ticket");
});

it("remote signaling authenticates, isolates tickets, relays SDP and closes on revocation", async () => {
  const app = Fastify(); await app.register(websocket);
  let allowed = true;
  const probe = new ViewerProbe(() => allowed); probe.registerRoutes(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp/viewer-probe/signal`;
  const sockets: WebSocket[] = [];
  const connect = async (ticket: string, role: string) => {
    const ws = new WebSocket(`${base}?ticket=${ticket}&role=${role}`); sockets.push(ws);
    await once(ws, "open"); return ws;
  };
  try {
    assert.equal((await app.inject({ url: "/mcp/viewer-probe/signal?ticket=invalid&role=viewer" })).statusCode, 401);
    const ticket = probe.issue("owner"), otherTicket = probe.issue("owner");
    const viewer = await connect(ticket, "viewer");
    const isolated = await connect(otherTicket, "viewer");
    let isolatedMessages = 0; isolated.on("message", () => isolatedMessages++);
    const ready = once(viewer, "message");
    const sender = await connect(ticket, "sender");
    assert.equal(JSON.parse(String((await ready)[0])).type, "ready");
    const offer = once(viewer, "message"); sender.send(JSON.stringify({ type: "offer", sdp: "test-offer" }));
    assert.deepEqual(JSON.parse(String((await offer)[0])), { type: "offer", sdp: "test-offer" });
    const answer = once(sender, "message"); viewer.send(JSON.stringify({ type: "answer", sdp: "test-answer" }));
    assert.equal(JSON.parse(String((await answer)[0])).sdp, "test-answer");
    assert.equal((await app.inject({ url: `/mcp/viewer-probe/signal?ticket=${ticket}&role=viewer` })).statusCode, 409);
    const closed = once(viewer, "close"); allowed = false; await closed;
    assert.equal(isolatedMessages, 0);
  } finally { sockets.forEach(s => s.terminate()); await app.close(); }
});

it("remote sender is standalone and never requests private media", () => {
  const html = remoteSenderHtml();
  new Script(html.match(/<script>([\s\S]*)<\/script>/)![1]!);
  assert.doesNotMatch(html, /getDisplayMedia|getUserMedia|start_desktop_control/);
  assert.match(html, /history.replaceState/);
  assert.match(html, /120_000|120000|12e4/, "the 120-second limit (esbuild under tsx prints it as 12e4)");
});
