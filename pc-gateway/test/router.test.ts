import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const CAT = "aaaaaaaa-0000-4000-8000-00000000000a";
const COOK = "bbbbbbbb-0000-4000-8000-00000000000b";
const ORBIT = "cccccccc-0000-4000-8000-00000000000c";
const j = (o: unknown) => JSON.stringify(o) + "\n";

let root: string, claudeHome: string, catDir: string, cookDir: string, orbitDir: string, newDir: string;
let gw: Gateway;
let base: string;
let token: string;
const provider = new FakeProvider();
const alive = new Set<number>();

const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const until = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
const settle = (id: string) => until(() => !gw.manager.isRunning(id));
const text = (r: any): string => r.content[0].text;
const callTool = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: text(r), json: r.isError ? undefined : JSON.parse(text(r)) };
};

/** The tools the router's Claude process would see: connect with a router-scoped token bound to the route's router session. */
async function asRouter(routerSessionId: string) {
  const t = gw.agentTokens.issue({ scope: "pc.router", sessionId: routerSessionId, actor: `router:${routerSessionId}` });
  const c = new Client({ name: "router", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
  return c;
}

const transcript = (id: string, dir: string, title: string, ask: string, answer: string, minsAgo: number) =>
  fs.writeFileSync(path.join(claudeHome, "projects", path.basename(dir), `${id}.jsonl`),
    j({ type: "user", timestamp: new Date(Date.now() - minsAgo * 60_000).toISOString(), cwd: dir, message: { content: ask } }) +
    j({ type: "assistant", timestamp: new Date(Date.now() - (minsAgo - 1) * 60_000).toISOString(), message: { model: "m", content: [{ type: "text", text: answer }, { type: "tool_use", name: "Bash", input: { command: "nvidia-smi" } }] } }) +
    j({ type: "user", timestamp: new Date(Date.now() - (minsAgo - 1) * 60_000).toISOString(), message: { content: [{ type: "tool_result", content: "SECRET TOOL OUTPUT" }] } }) +
    j({ type: "ai-title", aiTitle: title }));

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-router-"));
  claudeHome = path.join(root, ".claude");
  catDir = path.join(root, "cat-diffusion"); cookDir = path.join(root, "recipe-box"); orbitDir = path.join(root, "orbit"); newDir = path.join(root, "brand-new-app");
  for (const d of [catDir, cookDir, orbitDir, newDir]) fs.mkdirSync(d);
  for (const d of [catDir, cookDir, orbitDir]) fs.mkdirSync(path.join(claudeHome, "projects", path.basename(d)), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "sessions"), { recursive: true });
  transcript(CAT, catDir, "Cat diffusion training", "How is the training run going?", "Step 84,231, loss 0.184, GPU at 97 percent.", 30);
  transcript(COOK, cookDir, "Fix publish admin editor", "The admin editor loses edits on publish", "Found it: the debounce drops the last keystroke.", 10);
  transcript(ORBIT, orbitDir, "Orbit networking bug", "Peers disconnect after 30 seconds", "NAT keepalive interval was too long.", 120);

  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", routerHome: path.join(root, "router"), discovery: { homes: { claudeHome, codexHome: path.join(root, ".codex") } } }, openDb(":memory:"), { claude: provider });
  (gw.indexer as any).alive = (pid: number) => alive.has(pid);
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  const { code } = gw.auth.createPairingCode();
  token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  gw.enableAgentGate(base); // what src/index.ts does once listening: agents connect back for their tools
  await gw.indexer!.scan();
});
after(async () => { await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("the General Claude route", () => {
  it("starts at a hidden, tool-less router session that is told its role", async () => {
    const created = await api("POST", "/v1/routes", {});
    assert.equal(created.status, 201);
    const route = created.json;
    assert.equal(route.targetSessionId, undefined);
    assert.equal(route.currentSessionId, route.routerSessionId);

    const sent = await api("POST", `/v1/routes/${route.id}/message`, { text: "how is the cat training doing?" });
    assert.equal(sent.status, 202);
    assert.equal(sent.json.sessionId, route.routerSessionId);
    await until(() => provider.calls.some((c) => c.text.includes("cat training")));
    const call = provider.calls.find((c) => c.text.includes("cat training"))!;
    assert.equal(call.routingOnly, true, "no shell, no editor: routing tools only");
    assert.match(call.appendSystemPrompt!, /General Claude/);
    assert.ok(call.mcp, "connected back to the gateway for its routing tools");
    await settle(route.routerSessionId);

    const listed = await api("GET", "/v1/sessions");
    assert.ok(!listed.json.sessions.some((s: any) => s.role === "router"), "router sessions are not shown with real sessions");
    const indexed = await api("GET", "/v1/agent-sessions?minMessages=0");
    assert.ok(!indexed.json.sessions.some((s: any) => s.helixSessionId === route.routerSessionId), "nor in the machine-wide index");
  });

  it("the router sees routing tools and nothing that can touch the machine", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const c = await asRouter(route.routerSessionId);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["end_call", "get_session_summary", "handoff_current_conversation", "list_projects", "list_status_watches", "resume_agent_session", "search_agent_sessions", "start_agent_session"]);
    for (const bad of ["run_command", "write_file", "read_file", "stop_process", "notify_user", "permission_prompt"]) assert.ok(!names.includes(bad), bad);
    await c.close();
  });
});

describe("finding the right session", () => {
  let c: Client;
  before(async () => { c = await asRouter((await api("POST", "/v1/routes", {})).json.routerSessionId); });
  after(async () => { await c.close(); });

  it("finds sessions by a few distinctive words, across title, project and recent text", async () => {
    const byTitle = await callTool(c, "search_agent_sessions", { query: "cat training" });
    assert.equal(byTitle.json.sessions[0].title, "Cat diffusion training");
    assert.equal(byTitle.json.sessions[0].ref, `claude:${CAT}`);
    const byContent = await callTool(c, "search_agent_sessions", { query: "debounce keystroke" });
    assert.equal(byContent.json.sessions[0].title, "Fix publish admin editor");
    const byProject = await callTool(c, "search_agent_sessions", { query: "orbit" });
    assert.equal(byProject.json.sessions[0].ref, `claude:${ORBIT}`);
    assert.equal((await callTool(c, "search_agent_sessions", { query: "zzz-nothing" })).json.sessions.length, 0);
    assert.ok(!JSON.stringify(byTitle.json).includes("SECRET TOOL OUTPUT"));
  });

  it("lists live sessions first and can filter to them", async () => {
    fs.writeFileSync(path.join(claudeHome, "sessions", "5001.json"), JSON.stringify({ pid: 5001, sessionId: COOK, status: "busy", name: "t" }));
    alive.add(5001);
    gw.indexer!.refreshLive();
    const all = await callTool(c, "search_agent_sessions", {});
    assert.equal(all.json.sessions[0].ref, `claude:${COOK}`, "the one running right now leads");
    assert.equal(all.json.sessions[0].live, true);
    const live = await callTool(c, "search_agent_sessions", { liveOnly: true });
    assert.deepEqual(live.json.sessions.map((s: any) => s.ref), [`claude:${COOK}`]);
    alive.delete(5001);
    fs.rmSync(path.join(claudeHome, "sessions", "5001.json"));
    gw.indexer!.refreshLive();
  });

  it("answers 'what did it say' from a summary without handing off", async () => {
    const s = await callTool(c, "get_session_summary", { session: `claude:${CAT}` });
    assert.equal(s.json.session.title, "Cat diffusion training");
    assert.deepEqual(s.json.recent.map((m: any) => m.role), ["user", "assistant"], "prompts and replies; tool plumbing left out");
    assert.match(s.json.recent[1].text, /loss 0\.184/);
    assert.equal((await callTool(c, "get_session_summary", { session: "claude:ffffffff-0000-4000-8000-000000000000" })).isError, true);
  });

  it("lists projects, most recent first, for starting new work", async () => {
    const p = await callTool(c, "list_projects");
    assert.deepEqual(p.json.map((x: any) => x.name), ["recipe-box", "cat-diffusion", "orbit"]);
  });
});

describe("handing the conversation over (the same chat continues)", () => {
  const newRoute = async () => (await api("POST", "/v1/routes", {})).json;

  it("router hands off to an existing session: the user's request is delivered there and the next message goes straight to it", async () => {
    const route = await newRoute();
    const c = await asRouter(route.routerSessionId);
    const events: any[] = [];
    const unsub = gw.manager.bus.subscribe((e) => events.push(e));

    const r = await callTool(c, "handoff_current_conversation", { session: `claude:${CAT}`, message: "Check how the training is doing" });
    assert.equal(r.json.connectedTo, "Cat diffusion training");
    assert.equal(r.json.messageDelivered, true);
    assert.equal(r.json.mode, "resume");

    const after = (await api("GET", `/v1/routes/${route.id}`)).json;
    assert.ok(after.targetSessionId);
    assert.equal(after.currentSessionId, after.targetSessionId);
    await until(() => provider.calls.some((x) => x.text === "Check how the training is doing"));
    const call = provider.calls.find((x) => x.text === "Check how the training is doing")!;
    assert.equal(call.providerSessionId, CAT, "the real cat-training conversation");
    assert.equal(call.resume, true);
    assert.equal(call.projectPath, catDir, "in its own project folder");
    assert.ok(!call.routingOnly, "the target is a normal full agent, not the router");
    assert.ok(events.some((e) => e.type === "route.handoff" && e.routeId === route.id && e.toTitle === "Cat diffusion training"), "the phone is told who it is now talking to");
    unsub();
    await settle(after.targetSessionId);

    // follow-up messages in the same conversation now go to the target, not the router
    const follow = await api("POST", `/v1/routes/${route.id}/message`, { text: "and the GPU memory?" });
    assert.equal(follow.json.sessionId, after.targetSessionId);
    await until(() => provider.calls.some((x) => x.text === "and the GPU memory?" && x.providerSessionId === CAT));
    await settle(after.targetSessionId);

    // the conversation reads as one thread across both sessions, in order
    const history = (await api("GET", `/v1/routes/${route.id}/messages`)).json.messages as any[];
    const seqs = history.map((m) => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.ok(history.some((m) => m.sessionId === after.targetSessionId && /GPU memory/.test(m.text)));
    await c.close();
  });

  it("going back returns the conversation to the General Claude", async () => {
    const route = await newRoute();
    const c = await asRouter(route.routerSessionId);
    await callTool(c, "handoff_current_conversation", { session: `claude:${ORBIT}`, message: "status?" });
    const reset = (await api("POST", `/v1/routes/${route.id}/reset`)).json;
    assert.equal(reset.targetSessionId, undefined);
    assert.equal(reset.currentSessionId, route.routerSessionId);
    await c.close();
  });

  it("a session open in a terminal is forked, never taken over", async () => {
    fs.writeFileSync(path.join(claudeHome, "sessions", "5002.json"), JSON.stringify({ pid: 5002, sessionId: COOK, status: "idle", name: "t" }));
    alive.add(5002);
    gw.indexer!.refreshLive();
    const route = await newRoute();
    const c = await asRouter(route.routerSessionId);
    const r = await callTool(c, "handoff_current_conversation", { session: `claude:${COOK}`, message: "any update?" });
    assert.equal(r.json.mode, "fork");
    assert.match(r.json.note, /open in a terminal/);
    await until(() => provider.calls.some((x) => x.text === "any update?"));
    const call = provider.calls.find((x) => x.text === "any update?")!;
    assert.equal(call.forkFrom, COOK, "branches from the terminal's session");
    assert.notEqual(call.providerSessionId, COOK);
    alive.delete(5002);
    fs.rmSync(path.join(claudeHome, "sessions", "5002.json"));
    gw.indexer!.refreshLive();
    await c.close();
  });

  it("new work in a project starts a fresh session there", async () => {
    const route = await newRoute();
    const c = await asRouter(route.routerSessionId);
    const r = await callTool(c, "handoff_current_conversation", { projectPath: newDir, message: "scaffold a todo app", title: "Todo app" });
    assert.equal(r.json.mode, "new");
    await until(() => provider.calls.some((x) => x.text === "scaffold a todo app"));
    const call = provider.calls.find((x) => x.text === "scaffold a todo app")!;
    assert.equal(call.projectPath, newDir);
    assert.equal(call.resume, false, "a brand-new conversation");
    assert.equal((await api("GET", `/v1/routes/${route.id}`)).json.targetSessionId !== undefined, true);
    await c.close();
  });

  it("a busy target is not interrupted: the router is told, and the route stays where it was", async () => {
    const route = await newRoute();
    const c = await asRouter(route.routerSessionId);
    await callTool(c, "handoff_current_conversation", { session: `claude:${ORBIT}`, message: "first question" });
    const target = (await api("GET", `/v1/routes/${route.id}`)).json.targetSessionId;
    await settle(target);

    // make ORBIT's session busy, then try to hand a *different* route to it
    const slow = new FakeProvider(40);
    (gw.manager as any).providers.claude = slow;
    gw.manager.send(target, "a long task that keeps it busy for a bit");
    const route2 = await newRoute();
    const c2 = await asRouter(route2.routerSessionId);
    const r = await callTool(c2, "handoff_current_conversation", { session: `claude:${ORBIT}`, message: "interrupting?" });
    assert.equal(r.isError, true);
    assert.match(r.text, /middle of a task/);
    assert.equal((await api("GET", `/v1/routes/${route2.id}`)).json.targetSessionId, undefined, "route not moved");
    gw.manager.interrupt(target);
    await settle(target);
    (gw.manager as any).providers.claude = provider;
    await c.close(); await c2.close();
  });

  it("rejects ambiguous, empty and impossible handoffs", async () => {
    const route = await newRoute();
    const c = await asRouter(route.routerSessionId);
    assert.match((await callTool(c, "handoff_current_conversation", {})).text, /exactly one/);
    assert.match((await callTool(c, "handoff_current_conversation", { session: `claude:${CAT}`, projectPath: catDir })).text, /exactly one/);
    assert.match((await callTool(c, "handoff_current_conversation", { session: "claude:ffffffff-0000-4000-8000-000000000000", message: "x" })).text, /not found/);
    assert.match((await callTool(c, "handoff_current_conversation", { session: route.routerSessionId, message: "x" })).text, /router/);
    assert.equal((await api("GET", `/v1/routes/${route.id}`)).json.targetSessionId, undefined, "failures leave the route alone");
    await c.close();
  });

  it("a conversation that is not a route has nothing to hand off", async () => {
    const plain = await gw.manager.createSession({ provider: "claude", title: "plain router-less", projectPath: os.tmpdir(), role: "router" });
    const c = await asRouter(plain.id);
    assert.match((await callTool(c, "handoff_current_conversation", { session: `claude:${CAT}` })).text, /not routed/);
    await c.close();
  });
});

describe("aliases (favorites for Siri / CarPlay / the router)", () => {
  it("name a session or a project, then use the name anywhere", async () => {
    assert.equal((await api("PUT", "/v1/aliases/cat%20training", { sessionKey: `claude:${CAT}` })).status, 200);
    assert.equal((await api("PUT", "/v1/aliases/Recipes", { sessionKey: `claude:${COOK}` })).status, 200);
    assert.equal((await api("PUT", "/v1/aliases/bad", { sessionKey: "x", projectPath: "y" })).status, 400, "exactly one target");
    assert.deepEqual((await api("GET", "/v1/aliases")).json.aliases.map((a: any) => a.name), ["cat training", "Recipes"], "listed alphabetically, ignoring case");

    const route = (await api("POST", "/v1/routes", {})).json;
    const c = await asRouter(route.routerSessionId);
    const found = await callTool(c, "search_agent_sessions", { query: "cat training" });
    assert.equal(found.json.aliases[0].name, "cat training");

    const r = await callTool(c, "handoff_current_conversation", { session: "CAT TRAINING", message: "status please" });
    assert.equal(r.json.connectedTo, "Cat diffusion training", "alias names are case-insensitive");
    assert.equal((await api("DELETE", "/v1/aliases/cat%20training")).status, 200);
    assert.equal((await api("DELETE", "/v1/aliases/cat%20training")).status, 404);
    await c.close();
  });
});

describe("over the websocket (what a phone call uses)", () => {
  it("route.send follows the handoff, and the handoff itself is pushed to the client", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
    const got: any[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));

    ws.send(JSON.stringify({ type: "route.send", routeId: route.id, text: "hello general", clientId: "c1" }));
    await until(() => got.some((e) => e.type === "send.accepted" && e.clientId === "c1"));
    assert.equal(got.find((e) => e.type === "send.accepted").sessionId, route.routerSessionId);
    await settle(route.routerSessionId);

    const c = await asRouter(route.routerSessionId);
    await callTool(c, "handoff_current_conversation", { session: `claude:${ORBIT}`, message: "peers dropping again?" });
    await until(() => got.some((e) => e.type === "route.handoff" && e.toTitle === "Orbit networking bug"));
    const target = (await api("GET", `/v1/routes/${route.id}`)).json.targetSessionId;
    await settle(target);

    ws.send(JSON.stringify({ type: "route.send", routeId: route.id, text: "try 15 seconds", clientId: "c2" }));
    await until(() => got.some((e) => e.type === "send.accepted" && e.clientId === "c2"));
    assert.equal(got.find((e) => e.type === "send.accepted" && e.clientId === "c2").sessionId, target, "now answered by the Orbit session");
    assert.ok(got.some((e) => e.type === "agent.output.delta" && e.sessionId === target), "its replies stream to the same socket");

    ws.send(JSON.stringify({ type: "route.send", routeId: "nope", text: "x" }));
    await until(() => got.some((e) => e.type === "error" && e.status === 404));
    ws.close();
    await c.close();
  });
});
