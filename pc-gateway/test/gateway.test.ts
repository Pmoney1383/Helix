import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

let gw: Gateway;
let base: string;
let token: string;
const provider = new FakeProvider(5);

const api = async (method: string, path: string, body?: unknown, auth = true) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

const openWs = async () => {
  const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
  const events: any[] = [];
  ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, events };
};

const until = async (fn: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

before(async () => {
  const db = openDb(":memory:");
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, db, { claude: provider });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = gw.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const { code } = gw.auth.createPairingCode();
  const paired = await api("POST", "/v1/pair/complete", { code, deviceName: "test phone" }, false);
  assert.equal(paired.status, 200);
  token = paired.json.token;
});

after(async () => { await gw.app.close(); });

describe("auth", () => {
  it("rejects unauthenticated requests", async () => {
    assert.equal((await api("GET", "/v1/sessions", undefined, false)).status, 401);
  });

  it("pairing codes are single use", async () => {
    const { code } = gw.auth.createPairingCode();
    assert.equal((await api("POST", "/v1/pair/complete", { code, deviceName: "a" }, false)).status, 200);
    assert.equal((await api("POST", "/v1/pair/complete", { code, deviceName: "b" }, false)).status, 401);
  });

  it("rejects the websocket without a token", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws");
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => resolve(200));
      ws.once("error", () => undefined);
    });
    assert.equal(status, 401);
  });
});

describe("sessions", () => {
  it("streams a reply over the websocket, then resumes on the next message", async () => {
    const created = await api("POST", "/v1/sessions", { title: "cat training", projectPath: os.tmpdir() });
    assert.equal(created.status, 201);
    const id: string = created.json.id;

    const { ws, events } = await openWs();
    ws.send(JSON.stringify({ type: "send", sessionId: id, text: "hello there" }));
    await until(() => events.some((e) => e.type === "agent.output.final"));

    const deltas = events.filter((e) => e.type === "agent.output.delta").map((e) => e.text).join("");
    assert.equal(deltas, "echo(start): hello there");
    assert.ok(events.filter((e) => e.type === "agent.output.delta").length > 1, "output arrives incrementally");
    assert.equal(provider.calls.at(-1)?.resume, false);

    // "Stopped" session: nothing is running between turns, so a second message must resume by ID.
    events.length = 0;
    ws.send(JSON.stringify({ type: "send", sessionId: id, text: "again" }));
    await until(() => events.some((e) => e.type === "agent.output.final"));
    assert.equal(provider.calls.at(-1)?.resume, true);
    assert.equal(provider.calls.at(-1)?.providerSessionId, created.json.providerSessionId);
    ws.close();

    const history = await api("GET", `/v1/conversations/${id}/messages`);
    assert.deepEqual(history.json.messages.map((m: any) => m.sender), ["user", "agent", "user", "agent"]);

    const after = history.json.messages[1].seq;
    const tail = await api("GET", `/v1/conversations/${id}/messages?after=${after}`);
    assert.equal(tail.json.messages.length, 2, "?after= returns only newer messages");
  });

  it("imported sessions resume on the first message", async () => {
    const providerSessionId = "5b7a52c1-3f77-4d0e-9d57-0a5b6b8a2a11";
    const created = await api("POST", "/v1/sessions", { title: "terminal session", providerSessionId });
    assert.equal(created.status, 201);
    const sent = await api("POST", `/v1/sessions/${created.json.id}/message`, { text: "continue" });
    assert.equal(sent.status, 202);
    await until(() => provider.calls.some((c) => c.providerSessionId === providerSessionId));
    assert.equal(provider.calls.find((c) => c.providerSessionId === providerSessionId)?.resume, true);
  });

  it("returns 409 while a turn is running and 404 for unknown sessions", async () => {
    const slow = new FakeProvider(50);
    const db = openDb(":memory:");
    const g = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, db, { claude: slow });
    const s = await g.manager.createSession({ provider: "claude", title: "t" });
    g.manager.send(s.id, "one two three four five");
    assert.throws(() => g.manager.send(s.id, "second"), /already running/);
    assert.throws(() => g.manager.send("nope", "x"), /not found/);
    g.manager.interrupt(s.id);
    await g.app.close();
  });

  it("interrupt stops a running turn and the session is usable again", async () => {
    const slow = new FakeProvider(40);
    const db = openDb(":memory:");
    const g = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, db, { claude: slow });
    const s = await g.manager.createSession({ provider: "claude", title: "t" });
    g.manager.send(s.id, "a b c d e f g h i j k l");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(g.manager.interrupt(s.id), true);
    await until(() => !g.manager.isRunning(s.id));
    assert.equal(g.manager.registry.get(s.id)?.status, "idle");
    assert.equal(g.manager.registry.get(s.id)?.turnCount, 0, "an interrupted first turn does not count as started");
    await g.app.close();
  });

  it("rejects a bad projectPath", async () => {
    const r = await api("POST", "/v1/sessions", { title: "x", projectPath: "Z:\\definitely\\not\\here" });
    assert.equal(r.status, 400);
  });
});

describe("restart recovery", () => {
  it("marks sessions that were running at crash time idle", async () => {
    const file = `${fs.mkdtempSync(`${os.tmpdir()}/helix-`)}/t.db`;
    const db = openDb(file);
    const g1 = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, db, { claude: new FakeProvider() });
    const s = await g1.manager.createSession({ provider: "claude", title: "t" });
    g1.manager.registry.setStatus(s.id, "running");
    await g1.app.close();
    const g2 = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, db, { claude: new FakeProvider() });
    assert.equal(g2.manager.registry.get(s.id)?.status, "idle");
    await g2.app.close();
  });
});
