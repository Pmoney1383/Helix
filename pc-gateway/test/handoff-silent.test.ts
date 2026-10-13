import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { ROUTER_PROMPT, routerPrompt } from "../src/router/prompt.js";
import { isRoutingOnly } from "../src/router/routing-only.js";
import { openDb } from "../src/storage/sqlite.js";

describe("is this message for the router, or for the session being connected to?", () => {
  const routing = [
    "connect me to the claude agent working on helix",
    "Connect me to the Claude agent working on Helix.",
    "can you connect me to the helix agent please",
    "please put me through to Astra",
    "switch me over to the cat session",
    "take me to the recipe box project",
    "hand me to the codex session",
    "I want to talk to the helix agent",
    "let me talk to the training session",
    "talk to the helix agent",
    "speak with the cat diffusion agent",
    "go to the helix session",
    "switch to the codex agent",
    "hey, connect me to the agent on atlas",
    "call the helix agent",
    "get me to the helix session",
    "transfer me to the claude session working on the login page",
    "put this call through to the orbit agent",
    "I need to talk to Astra",
    "connect me to the agent that is working on the helix voice stuff",
  ];
  for (const m of routing) it(`drops: ${m}`, () => assert.equal(isRoutingOnly(m), true, m));

  const real = [
    "how is the training going",
    "fix the login bug",
    "continue the login page work",
    "what is the status of the build?",
    "connect me to the helix agent and tell it to run the tests",
    "connect me to the cat session, then check the loss",
    "talk to the helix agent about the pairing bug and fix it",
    "switch to the codex agent and review my last commit",
    "ask the helix agent how pairing is going",
    "tell the cat session to restart the run",
    "connect me to the helix agent so that it can deploy",
    "put me through to the agent and have it summarize the logs",
    "go to the helix session; run the tests",
    "which agent is working on helix?",
    "run the tests",
    "",
    "x".repeat(300),
  ];
  for (const m of real) it(`delivers: ${m.slice(0, 70) || "(empty)"}`, () => assert.equal(isRoutingOnly(m), false, m));

  it("a missing message is never 'routing only' (there is nothing to drop)", () => assert.equal(isRoutingOnly(undefined), false));
});

describe("the router's instructions and tool say it too", () => {
  for (const name of ["General Claude", "Astra"] as const) {
    it(`${name}: tells the model to leave message out for a pure connection request`, () => {
      const p = routerPrompt(name);
      assert.match(p, /ONLY if they asked that session to do or answer something/);
      assert.match(p, /leave "message" out entirely/);
      assert.match(p, /waits silently/);
    });
  }
  it("the default prompt is the Claude one", () => assert.equal(ROUTER_PROMPT, routerPrompt("General Claude")));
});

describe("through the gateway: a connection request connects without speaking", () => {
  let gw: Gateway;
  let base: string;
  let token: string;
  let root: string;
  let proj: string;
  const provider = new FakeProvider();
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const settle = async (id: string) => { for (let i = 0; i < 500 && gw.manager.isRunning(id); i++) await new Promise((r) => setTimeout(r, 10)); };

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-silent-"));
    proj = path.join(root, "helix-proj");
    fs.mkdirSync(proj);
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", routerHome: path.join(root, "router") }, openDb(":memory:"), { claude: provider });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    gw.enableAgentGate(base);
    const { code } = gw.auth.createPairingCode();
    token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  });
  after(async () => { await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const asRouter = async (routerSessionId: string) => {
    const t = gw.agentTokens.issue({ scope: "pc.router", sessionId: routerSessionId, actor: `router:${routerSessionId}` });
    const c = new Client({ name: "router", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
    return c;
  };
  const target = async () => (await api("POST", "/v1/sessions", { title: "helix work", projectPath: proj })).json.id as string;

  it("the router tool drops a connection request: the target gets no turn, and the route still points at it", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const sid = await target();
    const before = provider.calls.length;
    const c = await asRouter(route.routerSessionId);
    const r: any = await c.callTool({ name: "handoff_current_conversation", arguments: { session: sid, message: "connect me to the claude agent working on helix" } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.messageDelivered, false);
    assert.match(out.messageNotDelivered, /request to connect/);
    await settle(sid);
    assert.equal(provider.calls.length, before, "no turn ran on the target: it has nothing to answer");
    assert.equal(gw.manager.messages.list(sid).length, 0, "and nothing appears in its conversation");
    assert.equal((await api("GET", `/v1/routes/${route.id}`)).json.targetSessionId, sid, "but the conversation is connected to it");
    await c.close();
  });

  it("the user's own next message then goes to the target, as the only thing it ever sees", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const sid = await target();
    const c = await asRouter(route.routerSessionId);
    await c.callTool({ name: "handoff_current_conversation", arguments: { session: sid, message: "put me through to the helix agent" } });
    await c.close();
    const before = provider.calls.length;
    const sent = await api("POST", `/v1/routes/${route.id}/message`, { text: "how is the pairing bug going" });
    assert.equal(sent.json.sessionId, sid);
    await settle(sid);
    assert.equal(provider.calls.length, before + 1);
    assert.equal(provider.calls.at(-1)!.text, "how is the pairing bug going");
    const texts = gw.manager.messages.list(sid).filter((m) => m.sender === "user").map((m) => m.text);
    assert.deepEqual(texts, ["how is the pairing bug going"], "the navigation sentence never reached it");
  });

  it("real work is still delivered right away, exactly as before", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const sid = await target();
    const c = await asRouter(route.routerSessionId);
    const r: any = await c.callTool({ name: "handoff_current_conversation", arguments: { session: sid, message: "how is the training going" } });
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.messageDelivered, true);
    assert.equal(out.messageNotDelivered, undefined);
    await settle(sid);
    assert.equal(provider.calls.at(-1)!.text, "how is the training going");
    await c.close();
  });

  it("a request that both connects and asks for something is delivered whole", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const sid = await target();
    const c = await asRouter(route.routerSessionId);
    const r: any = await c.callTool({ name: "handoff_current_conversation", arguments: { session: sid, message: "connect me to the helix agent and tell it to run the tests" } });
    assert.equal(JSON.parse(r.content[0].text).messageDelivered, true);
    await c.close();
  });

  it("the same through the HTTP handoff API (the app's own call), for a new session too", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const sid = await target();
    const before = provider.calls.length;
    const h = await api("POST", `/v1/routes/${route.id}/handoff`, { session: sid, message: "switch me over to the helix session" });
    assert.equal(h.status, 200);
    assert.equal(h.json.messageDelivered, false);
    assert.equal(h.json.routingMessageDropped, true);
    assert.equal(provider.calls.length, before);
    const fresh = await api("POST", `/v1/routes/${route.id}/handoff`, { projectPath: proj, message: "talk to the helix agent" });
    assert.equal(fresh.json.mode, "new");
    assert.equal(fresh.json.messageDelivered, false);
    await settle(fresh.json.session.id);
    assert.equal(provider.calls.length, before, "a freshly started session is silent too");
  });

  it("a connection request to a session that is busy does not fail: there is nothing to deliver", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const sid = await target();
    (provider as any).delayMs = 300;
    await api("POST", `/v1/sessions/${sid}/message`, { text: "a long task" });
    const h = await api("POST", `/v1/routes/${route.id}/handoff`, { session: sid, message: "connect me to the helix agent" });
    assert.equal(h.status, 200, JSON.stringify(h.json));
    await settle(sid);
  });
});
