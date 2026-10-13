import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { CodexProvider, ROUTER_MCP_SERVER } from "../src/providers/codex.js";
import { FakeProvider } from "../src/providers/fake.js";
import type { AgentEvent, ApprovalAsk, SendOptions } from "../src/providers/provider.js";
import { routerPrompt } from "../src/router/prompt.js";
import { openDb } from "../src/storage/sqlite.js";

const FIXTURE = path.resolve("test/fixtures/fake-codex-app-server.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-chat-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function fakeCodex() {
  const log = path.join(tmp, `codex-${++n}.log`);
  const provider = new CodexProvider({ server: { bin: process.execPath, args: [FIXTURE], env: () => ({ ...process.env, FAKE_CODEX_LOG: log }) }, sandbox: "danger-full-access" });
  const sent = (method: string) =>
    (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { dir: string; msg: any }) : [])
      .filter((m) => m.dir === "in" && m.msg.method === method).map((m) => m.msg.params);
  const replies = () =>
    (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { dir: string; msg: any }) : [])
      .filter((m) => m.dir === "in" && m.msg.id !== undefined && m.msg.method === undefined).map((m) => m.msg);
  return { provider, sent, replies };
}
const routing = { mcp: { url: "http://127.0.0.1:1/mcp", token: "hxa_testtoken" }, instructions: routerPrompt("Astra") };
const send = (o: Partial<SendOptions> & { providerSessionId: string; text: string }): SendOptions =>
  ({ resume: true, signal: new AbortController().signal, ...o });
async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("Astra router: how a Codex thread is configured", () => {
  it("a router thread gets its own MCP entry with a router credential, the router prompt, and a read-only sandbox", async () => {
    const f = fakeCodex();
    await f.provider.createSession({ projectPath: "C:/router", routing });
    const start = f.sent("thread/start")[0];
    assert.equal(start.sandbox, "read-only", "even though the gateway default is danger-full-access");
    assert.equal(start.approvalPolicy, "untrusted");
    assert.match(start.developerInstructions, /Astra/);
    assert.match(start.developerInstructions, /handoff_current_conversation/);
    assert.deepEqual(start.config.mcp_servers[ROUTER_MCP_SERVER], { url: routing.mcp.url, http_headers: { Authorization: "Bearer hxa_testtoken" } });
    f.provider.close();
  });

  it("an ordinary thread is untouched: gateway sandbox, no MCP override, no instructions", async () => {
    const f = fakeCodex();
    await f.provider.createSession({ projectPath: "C:/p" });
    const start = f.sent("thread/start")[0];
    assert.equal(start.sandbox, "danger-full-access");
    assert.equal(start.config, undefined);
    assert.equal(start.developerInstructions, undefined);
    f.provider.close();
  });

  it("a router thread that is loaded again (gateway restarted) gets a fresh credential and its instructions back", async () => {
    const f = fakeCodex();
    const fresh = { mcp: { url: "http://127.0.0.1:1/mcp", token: "hxa_fresh" }, instructions: routerPrompt("Astra") };
    await collect(f.provider.send(send({ providerSessionId: "old-router", text: "hello", routingOnly: true, mcp: fresh.mcp, appendSystemPrompt: fresh.instructions })));
    const resume = f.sent("thread/resume")[0];
    assert.equal(resume.sandbox, "read-only");
    assert.equal(resume.config.mcp_servers[ROUTER_MCP_SERVER].http_headers.Authorization, "Bearer hxa_fresh");
    assert.match(resume.developerInstructions, /Astra/);
    f.provider.close();
  });
});

describe("Astra router: nothing but routing is allowed, enforced by the gateway", () => {
  const asks: ApprovalAsk[] = [];
  const approve = async (a: ApprovalAsk) => { asks.push(a); return { allow: true }; }; // would allow everything: it must never be consulted
  const run = async (f: ReturnType<typeof fakeCodex>, text: string) => {
    const { providerSessionId } = await f.provider.createSession({ projectPath: "C:/router", routing });
    return (await collect(f.provider.send(send({ providerSessionId, text, approve, routingOnly: true, mcp: routing.mcp, appendSystemPrompt: routing.instructions })))).at(-1);
  };

  it("declines shell commands, even harmless ones, without asking anyone", async () => {
    const f = fakeCodex();
    assert.deepEqual(await run(f, "RUN Get-Date"), { type: "final", text: "refused: Get-Date" });
    assert.deepEqual(f.replies().map((r) => r.result.decision), ["decline"]);
    f.provider.close();
  });

  it("declines file changes: patches and deletions", async () => {
    const f = fakeCodex();
    assert.deepEqual(await run(f, "PATCH C:/x/new.txt"), { type: "final", text: "not changed: C:/x/new.txt" });
    assert.deepEqual(await run(f, "DELETE C:/x/old.txt"), { type: "final", text: "not changed: C:/x/old.txt" });
    f.provider.close();
  });

  it("refuses to widen the sandbox", async () => {
    const f = fakeCodex();
    const r = await run(f, "PERMS");
    assert.deepEqual(r, { type: "final", text: 'granted: {"fileSystem":null,"network":null}' });
    f.provider.close();
  });

  it("allows its own routing tools straight through, and any other MCP server's tools are blocked", async () => {
    const f = fakeCodex();
    assert.deepEqual(await run(f, `MCP ${ROUTER_MCP_SERVER}.search_agent_sessions`), { type: "final", text: `tool ran: ${ROUTER_MCP_SERVER}.search_agent_sessions` });
    assert.deepEqual(await run(f, "MCP github.create_issue"), { type: "final", text: "tool blocked: github.create_issue (decline)" });
    assert.deepEqual(await run(f, "MCP helix.notify_user"), { type: "final", text: "tool blocked: helix.notify_user (decline)" }, "not even Helix's own other server");
    f.provider.close();
  });

  it("never consults the approval policy: there is nothing to approve", async () => {
    assert.deepEqual(asks, []);
  });

  it("a normal (non-router) Codex session still goes through the policy as before", async () => {
    const f = fakeCodex();
    const { providerSessionId } = await f.provider.createSession({ projectPath: "C:/p" });
    const mine: ApprovalAsk[] = [];
    await collect(f.provider.send(send({ providerSessionId, text: "RUN npm test", approve: async (a) => { mine.push(a); return { allow: true }; } })));
    assert.equal(mine.length, 1);
    f.provider.close();
  });
});

describe("Astra router: through the gateway, the same API as the General Claude", () => {
  let gw: Gateway;
  let base: string;
  let token: string;
  let root: string;
  let proj: string;
  let f: ReturnType<typeof fakeCodex>;
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const until = async (fn: () => boolean, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
  const reply = async (sessionId: string): Promise<string> => {
    await until(() => !gw.manager.isRunning(sessionId));
    return gw.manager.messages.list(sessionId).filter((m) => m.sender === "agent").at(-1)?.text ?? "";
  };
  const pairedGateway = async (providers: ConstructorParameters<typeof Object> extends never ? never : Parameters<typeof buildGateway>[2]) => {
    const g = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", routerHome: path.join(root, "router") }, openDb(":memory:"), providers);
    await g.app.listen({ host: "127.0.0.1", port: 0 });
    const b = `http://127.0.0.1:${(g.app.server.address() as { port: number }).port}`;
    g.enableAgentGate(b);
    const { code } = g.auth.createPairingCode();
    const t = ((await (await fetch(b + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
    return { g, b, t };
  };

  before(async () => {
    root = fs.mkdtempSync(path.join(tmp, "gw-"));
    proj = path.join(root, "demo-proj");
    fs.mkdirSync(proj);
    f = fakeCodex();
    const p = await pairedGateway({ claude: new FakeProvider(), codex: f.provider });
    gw = p.g; base = p.b; token = p.t;
  });
  after(async () => { await gw.app.close(); });

  it("POST /v1/routes defaults to the General Claude; provider codex opens Astra", async () => {
    const claude = (await api("POST", "/v1/routes", {})).json;
    assert.equal(claude.frontDoor, "claude");
    assert.equal(claude.title, "General Claude");
    const chat = await api("POST", "/v1/routes", { provider: "codex" });
    assert.equal(chat.status, 201);
    assert.equal(chat.json.frontDoor, "codex");
    assert.equal(chat.json.title, "Astra");
    assert.equal(gw.manager.registry.get(chat.json.routerSessionId)?.provider, "codex");
    assert.equal(gw.manager.registry.get(chat.json.routerSessionId)?.role, "router");
    assert.equal((await api("GET", `/v1/routes/${chat.json.id}`)).json.frontDoor, "codex");
    assert.deepEqual((await api("GET", "/v1/routes")).json.routes.map((r: any) => r.frontDoor).sort(), ["claude", "codex"]);
  });

  it("the credential in the Codex thread's config works: it is a router token for exactly that session, and it outlives a turn", async () => {
    const route = (await api("POST", "/v1/routes", { provider: "codex", title: "Chat A" })).json;
    const start = f.sent("thread/start").at(-1);
    const bearer = String(start.config.mcp_servers[ROUTER_MCP_SERVER].http_headers.Authorization).replace(/^Bearer /, "");
    assert.match(bearer, /^hxa_/);
    assert.deepEqual(gw.agentTokens.lookup(bearer), { scope: "pc.router", sessionId: route.routerSessionId, actor: `router:${route.routerSessionId}` });

    // a turn runs and finishes; per-turn tokens are revoked at the end of a turn, this one must not be
    await api("POST", `/v1/routes/${route.id}/message`, { text: "hello chat" });
    assert.equal(await reply(route.routerSessionId), "echo: hello chat");
    assert.ok(gw.agentTokens.lookup(bearer), "still valid for the next turn, because Codex holds it in the thread's config");
    await api("POST", `/v1/routes/${route.id}/message`, { text: "again" });
    assert.equal(await reply(route.routerSessionId), "echo: again");

    // and it really is the router's tool set: routing tools, nothing that touches the PC
    const c = new Client({ name: "chat", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("search_agent_sessions") && names.includes("handoff_current_conversation"));
    for (const banned of ["run_command", "write_file", "read_file", "stop_process", "run_safe_command", "open_app"]) assert.ok(!names.includes(banned), banned);

    // using it, exactly as Codex would, hands this very conversation to a new session
    const r: any = await c.callTool({ name: "handoff_current_conversation", arguments: { projectPath: proj, message: "from the chat router", provider: "claude" } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const after = (await api("GET", `/v1/routes/${route.id}`)).json;
    assert.ok(after.targetSessionId);
    assert.equal(gw.manager.registry.get(after.targetSessionId)?.provider, "claude");
    assert.equal(await reply(after.targetSessionId), "echo(start): from the chat router");
    await c.close();
  });

  it("after the handoff the phone does the same things it does with the General Claude: message, switch, go back", async () => {
    const route = (await api("POST", "/v1/routes", { provider: "codex" })).json;
    const h = await api("POST", `/v1/routes/${route.id}/handoff`, { projectPath: proj, provider: "codex", message: "summarize the open tasks", title: "Codex in demo" });
    assert.equal(h.status, 200);
    assert.equal(h.json.session.provider, "codex");
    assert.equal(await reply(h.json.session.id), "echo: summarize the open tasks");
    const m = await api("POST", `/v1/routes/${route.id}/message`, { text: "next" });
    assert.equal(m.json.sessionId, h.json.session.id);
    await reply(h.json.session.id);
    const back = await api("POST", `/v1/routes/${route.id}/reset`);
    assert.equal(back.json.currentSessionId, route.routerSessionId, "back to Astra");
    const history = (await api("GET", `/v1/routes/${route.id}/messages`)).json;
    assert.ok(history.messages.length >= 3, "one history across router and target");
  });

  it("the voice flag works on the Chat route as on any other", async () => {
    const route = (await api("POST", "/v1/routes", { provider: "codex" })).json;
    await api("POST", `/v1/routes/${route.id}/message`, { text: "status?", voice: true });
    await reply(route.routerSessionId);
    const turn = f.sent("turn/start").at(-1);
    assert.match(turn.input[0].text, /spoken aloud/);
  });

  it("starting a call to Chat opens a Astra route, titled Call Astra", async () => {
    const call = await api("POST", "/v1/calls/start", { provider: "codex" });
    assert.equal(call.status, 201);
    assert.equal(call.json.title, "Call Astra");
    assert.equal((await api("GET", `/v1/routes/${call.json.routeId}`)).json.frontDoor, "codex");
    const claude = await api("POST", "/v1/calls/start", {});
    assert.equal(claude.json.title, "Call Claude");
    assert.equal((await api("GET", `/v1/routes/${claude.json.routeId}`)).json.frontDoor, "claude");
  });

  it("without Codex installed, asking for Astra is a clear 400 and nothing is left half-created", async () => {
    const p = await pairedGateway({ claude: new FakeProvider() });
    const before = p.g.manager.registry.list().length;
    const r = await fetch(p.b + "/v1/routes", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.t}` }, body: JSON.stringify({ provider: "codex" }) });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, /provider "codex" is not available/);
    assert.equal(p.g.manager.registry.list().length, before);
    await p.g.app.close();
  });
});

describe("Astra router across a gateway restart", () => {
  it("the conversation carries on: the thread is loaded again with a fresh credential that lasts, and the router's tools still work on later turns", async () => {
    const dbFile = path.join(tmp, "restart.db");
    const proj = path.join(tmp, "restart-proj");
    fs.mkdirSync(proj, { recursive: true });
    const boot = async () => {
      const log = path.join(tmp, `codex-restart-${++n}.log`);
      const provider = new CodexProvider({ server: { bin: process.execPath, args: [FIXTURE], env: () => ({ ...process.env, FAKE_CODEX_LOG: log, FAKE_CODEX_RESUME_ANY: "1" }) }, sandbox: "danger-full-access" });
      const db = openDb(dbFile);
      const g = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", routerHome: path.join(tmp, "restart-router") }, db, { claude: new FakeProvider(), codex: provider });
      await g.app.listen({ host: "127.0.0.1", port: 0 });
      const b = `http://127.0.0.1:${(g.app.server.address() as { port: number }).port}`;
      g.enableAgentGate(b);
      const { code } = g.auth.createPairingCode();
      const t = ((await (await fetch(b + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
      const sent = (method: string) => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.dir === "in" && m.msg.method === method).map((m) => m.msg.params);
      const api = async (method: string, p: string, body?: unknown) => {
        const r = await fetch(b + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
      };
      const settle = async (id: string) => { for (let i = 0; i < 400 && g.manager.isRunning(id); i++) await new Promise((r) => setTimeout(r, 10)); };
      return { g, b, sent, api, settle, close: async () => { await g.app.close(); db.close(); } };
    };

    // first life: create the Chat route and talk to it
    const one = await boot();
    const route = (await one.api("POST", "/v1/routes", { provider: "codex", title: "Chat before restart" })).json;
    await one.api("POST", `/v1/routes/${route.id}/message`, { text: "one" });
    await one.settle(route.routerSessionId);
    await one.close();

    // second life: same database, brand new gateway and Codex process
    const two = await boot();
    await two.api("POST", `/v1/routes/${route.id}/message`, { text: "two" });
    await two.settle(route.routerSessionId);
    const resume = two.sent("thread/resume")[0];
    assert.ok(resume, "the thread was loaded again");
    assert.equal(resume.sandbox, "read-only");
    const bearer = String(resume.config.mcp_servers[ROUTER_MCP_SERVER].http_headers.Authorization).replace(/^Bearer /, "");
    assert.ok(two.g.agentTokens.lookup(bearer), "valid right after the turn that loaded the thread");

    // a third turn in the same process: Codex still holds that same credential in the thread, so it must still be valid
    await two.api("POST", `/v1/routes/${route.id}/message`, { text: "three" });
    await two.settle(route.routerSessionId);
    assert.ok(two.g.agentTokens.lookup(bearer), "not revoked at the end of a turn");
    assert.deepEqual(two.g.agentTokens.lookup(bearer), { scope: "pc.router", sessionId: route.routerSessionId, actor: `router:${route.routerSessionId}` });
    assert.equal(two.sent("thread/resume").length, 1, "loaded once, not on every turn");

    const c = new Client({ name: "chat", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(two.b + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    assert.ok((await c.listTools()).tools.some((t) => t.name === "handoff_current_conversation"));
    await c.close();
    await two.close();
  });
});
