import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import type { Scope } from "../src/mcp/scopes.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

let gw: Gateway;
let base: string;
let token: string;
let tmp: string;
const provider = new FakeProvider();

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

async function mcp(scope: Scope, sessionId?: string) {
  const t = gw.agentTokens.issue({ scope, sessionId, actor: "test" });
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
  return c;
}
const text = (r: any) => r.content[0].text as string;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-wapi-"));
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: provider });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  const { code } = gw.auth.createPairingCode();
  token = ((await (await fetch(base + "/v1/pair/complete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "phone" }),
  })).json()) as any).token;
});
after(async () => { await gw.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("watch HTTP API", () => {
  it("requires auth", async () => {
    assert.equal((await fetch(base + "/v1/watches")).status, 401);
  });

  it("creates, lists, checks, disables and deletes a watch; rejects bad input", async () => {
    const log = path.join(tmp, "x.log");
    fs.writeFileSync(log, "");
    const created = await api("POST", "/v1/watches", { name: "my log", type: "log", config: { path: log, patterns: [{ regex: "BOOM", severity: "critical" }] }, intervalSec: 5 });
    assert.equal(created.status, 201);
    const id = created.json.id;

    assert.ok((await api("GET", "/v1/watches")).json.watches.some((w: any) => w.id === id));

    fs.appendFileSync(log, "BOOM happened\n");
    const check = await api("POST", `/v1/watches/${id}/check`);
    assert.equal(check.json.fired, 1);
    const events = (await api("GET", `/v1/watches/${id}/events`)).json.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].severity, "critical");

    assert.equal((await api("PATCH", `/v1/watches/${id}`, { enabled: false })).json.enabled, false);
    assert.equal((await api("DELETE", `/v1/watches/${id}`)).status, 200);
    assert.equal((await api("DELETE", `/v1/watches/${id}`)).status, 404);
    assert.equal((await api("GET", `/v1/watches/${id}/events`)).status, 404);

    assert.equal((await api("POST", "/v1/watches", { name: "bad", type: "nope", config: {} })).status, 400);
    assert.equal((await api("POST", "/v1/watches", { name: "bad", type: "command", config: { command: "rm -rf /" } })).status, 400);
    assert.equal((await api("POST", "/v1/watches", { name: "bad", type: "process", config: {} })).status, 400);
  });

  it("watch/job expands one description into process + log (+ GPU) watches", async () => {
    const log = path.join(tmp, "job.log");
    fs.writeFileSync(log, "");
    const r = await api("POST", "/v1/watches/job", { name: "nightly build", profile: "build", processName: "node", logPath: log });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.watches.map((w: any) => w.type), ["process", "log"]);
    assert.equal((await api("POST", "/v1/watches/job", { name: "nothing" })).status, 400);
    for (const w of r.json.watches) await api("DELETE", `/v1/watches/${w.id}`);
  });

  it("pushes watch events to the phone over the websocket", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
    const got: any[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));

    const log = path.join(tmp, "ws.log");
    fs.writeFileSync(log, "");
    const w = (await api("POST", "/v1/watches", { name: "ws", type: "log", config: { path: log, patterns: [{ regex: "ALERT", severity: "important" }] } })).json;
    fs.appendFileSync(log, "ALERT: disk almost full\n");
    await api("POST", `/v1/watches/${w.id}/check`);
    await new Promise((r) => setTimeout(r, 50));
    ws.close();

    const trig = got.find((e) => e.type === "watch.triggered");
    assert.ok(trig);
    assert.equal(trig.watch.name, "ws");
    assert.match(trig.event.summary, /ALERT: disk almost full/);
    assert.ok(got.some((e) => e.type === "message.created" && e.message.type === "event"), "also lands in the conversation");
    await api("DELETE", `/v1/watches/${w.id}`);
  });

  it("the agent is never invoked by watching (no model polling)", async () => {
    const before = provider.calls.length;
    const w = (await api("POST", "/v1/watches", { name: "quiet", type: "file", config: { path: path.join(tmp, "nope"), mode: "missing" } })).json;
    for (let i = 0; i < 25; i++) await gw.watchers.runNow(w.id);
    assert.equal(provider.calls.length, before);
    await api("DELETE", `/v1/watches/${w.id}`);
  });
});

describe("watch MCP tools (agents can set up monitoring themselves)", () => {
  it("scopes: observe can list watches but not create or remove them", async () => {
    const c = await mcp("pc.observe");
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("list_status_watches"));
    for (const n of ["create_status_watch", "watch_job", "remove_status_watch"]) assert.ok(!names.includes(n), n);
    await c.close();
  });

  it("an agent can watch a job for the user, and removal works", async () => {
    const s = await gw.manager.createSession({ provider: "claude", title: "build helper", projectPath: os.tmpdir() });
    const c = await mcp("pc.agent.full", s.id);
    const log = path.join(tmp, "agent-job.log");
    fs.writeFileSync(log, "");

    const made = JSON.parse(text(await c.callTool({ name: "watch_job", arguments: { name: "docs build", profile: "build", logPath: log, wakeMe: true } })));
    assert.equal(made.created.length, 1);
    const stored = gw.watchers.get(made.created[0].id)!;
    assert.equal(stored.sessionId, s.id, "notifications land in the agent's own conversation");
    assert.equal(stored.wake?.sessionId, s.id);

    const single = JSON.parse(text(await c.callTool({ name: "create_status_watch", arguments: { name: "api", type: "http", config: { url: "http://127.0.0.1:1/" } } })));
    const listed = JSON.parse(text(await c.callTool({ name: "list_status_watches", arguments: {} })));
    assert.ok(listed.some((w: any) => w.id === single.created.id));

    const bad = await c.callTool({ name: "create_status_watch", arguments: { name: "evil", type: "command", config: { command: "Remove-Item C:\\data -Recurse" } } });
    assert.equal(bad.isError, true, "a watch cannot be used to smuggle in a destructive command");
    assert.match(text(bad), /must not be destructive/);

    assert.equal(JSON.parse(text(await c.callTool({ name: "remove_status_watch", arguments: { id: single.created.id } }))).removed, true);
    for (const w of made.created) gw.watchers.remove(w.id);
    await c.close();
  });

  it("a terminal agent's command watch waits for the user's approval once; its other watches do not", async () => {
    const c = await mcp("pc.agent.local");
    const pending = async () => {
      for (let i = 0; i < 100; i++) {
        const a = gw.approvals.list("pending").find((x) => x.tool === "create_status_watch");
        if (a) return a;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("no approval was requested");
    };
    const args = { name: "disk", type: "command", config: { command: "Get-PSDrive C" }, intervalSec: 300 };

    const denied = c.callTool({ name: "create_status_watch", arguments: { ...args, name: "disk denied" } });
    const ask = await pending();
    assert.match(ask.summary, /Get-PSDrive C/);
    assert.match(ask.summary, /every 300 s/);
    gw.approvals.resolve(ask.id, false);
    const r1 = await denied;
    assert.equal(r1.isError, true);
    assert.ok(!gw.watchers.list().some((w) => w.name === "disk denied"), "nothing is created without approval");

    const approved = c.callTool({ name: "create_status_watch", arguments: args });
    gw.approvals.resolve((await pending()).id, true);
    const made = JSON.parse(text(await approved));
    assert.equal(gw.watchers.get(made.created.id)?.type, "command");
    gw.watchers.remove(made.created.id);

    // Destructive commands are refused before anyone is asked; non-command watches need no approval.
    const bad = await c.callTool({ name: "create_status_watch", arguments: { name: "evil", type: "command", config: { command: "Remove-Item C:\\data -Recurse" } } });
    assert.equal(bad.isError, true);
    assert.equal(gw.approvals.list("pending").length, 0);
    const http = JSON.parse(text(await c.callTool({ name: "create_status_watch", arguments: { name: "api", type: "http", config: { url: "http://127.0.0.1:1/" } } })));
    assert.equal(gw.approvals.list("pending").length, 0);
    gw.watchers.remove(http.created.id);
    await c.close();
  });
});
