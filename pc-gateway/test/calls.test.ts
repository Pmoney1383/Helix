import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";
import { makeKey, startMockApns } from "./fixtures/mock-apns.js";

const ALERT = "a1".repeat(32);
const VOIP = "b2".repeat(32);
const DEAD = "dead" + "0".repeat(60);

let mock: Awaited<ReturnType<typeof startMockApns>>;
let key: ReturnType<typeof makeKey>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-calls-"));
/** Every gateway a test opens is closed at the end even if the test failed first: a leftover server would keep this whole file's process alive and stall the suite. */
const openRigs = new Set<{ close: () => Promise<void> }>();
before(async () => { mock = await startMockApns(); key = makeKey(); });
after(async () => {
  await Promise.all([...openRigs].map((r) => r.close().catch(() => undefined)));
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Rig {
  gw: Gateway; base: string; token: string; provider: FakeProvider;
  api: (method: string, p: string, body?: unknown, auth?: string | false) => Promise<{ status: number; json: any }>;
  pushes: (kind: "alert" | "voip") => typeof mock.received;
  until: (fn: () => boolean, ms?: number) => Promise<void>;
  close: () => Promise<void>;
}

async function rig(opts: { ringTimeoutMs?: number; approvalCallAfterMs?: number; apns?: boolean } = {}): Promise<Rig> {
  const provider = new FakeProvider();
  const gw = await buildGateway({
    defaultProjectPath: tmp, logLevel: "silent", routerHome: path.join(tmp, "router"),
    ringTimeoutMs: opts.ringTimeoutMs ?? 30_000, approvalCallAfterMs: opts.approvalCallAfterMs ?? 0,
    apns: opts.apns === false ? undefined : {
      keyPem: key.keyPem, keyId: "KEY123ABCD", teamId: "TEAM987654", bundleId: "com.example.helix",
      endpoints: { sandbox: mock.url, production: mock.url },
    },
  }, openDb(":memory:"), { claude: provider });
  gw.enableAgentGate("http://127.0.0.1:1");
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  const { code } = gw.auth.createPairingCode();
  const token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "iphone" }) })).json()) as any).token;
  gw.presence.setMode("away"); // phone alerts are only sent when the user is away
  mock.reset();
  let closed: Promise<void> | undefined;
  const closeOnce = () => (closed ??= gw.app.close());
  openRigs.add({ close: closeOnce });
  return {
    gw, base, token, provider,
    api: async (method, p, body, auth) => {
      const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(auth === false ? {} : { authorization: `Bearer ${auth ?? token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
    },
    pushes: (kind) => mock.received.filter((r) => r.headers["apns-push-type"] === kind),
    until: async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } },
    close: closeOnce,
  };
}

async function registered(r: Rig) {
  await r.api("PUT", "/v1/devices/me/push-token", { kind: "alert", token: ALERT, environment: "sandbox", bundleId: "com.example.helix" });
  await r.api("PUT", "/v1/devices/me/push-token", { kind: "voip", token: VOIP, environment: "sandbox", bundleId: "com.example.helix" });
}

describe("registering the phone", () => {
  it("stores alert and VoIP tokens, validates them, and shows what is registered", async () => {
    const r = await rig();
    assert.equal((await r.api("PUT", "/v1/devices/me/push-token", { kind: "alert", token: "not hex!", environment: "sandbox" })).status, 400);
    assert.equal((await r.api("PUT", "/v1/devices/me/push-token", { kind: "weird", token: ALERT, environment: "sandbox" })).status, 400);
    assert.equal((await r.api("PUT", "/v1/devices/me/push-token", { kind: "alert", token: ALERT, environment: "sandbox" }, false)).status, 401);

    await registered(r);
    const list = (await r.api("GET", "/v1/devices")).json;
    assert.equal(list.devices.length, 1);
    assert.deepEqual(list.devices[0].tokens.map((t: any) => t.kind).sort(), ["alert", "voip"]);
    assert.ok(!JSON.stringify(list).includes(ALERT), "the tokens themselves are never echoed back");
    const status = (await r.api("GET", "/v1/push/status")).json;
    assert.deepEqual([status.configured, status.alertTokens, status.voipTokens, status.callsAvailable, status.bundleId], [true, 1, 1, true, "com.example.helix"]);
    assert.equal((await r.api("DELETE", "/v1/devices/me/push-token/voip")).status, 200);
    assert.equal((await r.api("GET", "/v1/push/status")).json.voipTokens, 0);
    await r.close();
  });

  it("without Apple credentials push and calls report unavailable instead of pretending", async () => {
    const r = await rig({ apns: false });
    assert.equal((await r.api("GET", "/v1/push/status")).json.configured, false);
    assert.equal((await r.api("POST", "/v1/push/test", { kind: "alert" })).status, 409);
    const out = await r.gw.escalation.notify({ severity: "critical", title: "t", body: "", dedupeKey: "k" });
    assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:unavailable", "call:unavailable"]);
    await r.close();
  });

  it("a revoked phone is cut off from push and calls", async () => {
    const r = await rig();
    await registered(r);
    const id = (await r.api("GET", "/v1/devices")).json.currentDeviceId;
    await r.api("DELETE", `/v1/devices/${id}`);
    assert.equal(r.gw.devices.tokensFor("alert").length + r.gw.devices.tokensFor("voip").length, 0);
    await assert.rejects(() => r.gw.calls.ringIncoming({ severity: "critical", title: "x", summary: "" }), /no phone has registered/);
    await r.close();
  });

  it("push/test sends a real alert and rings a real test call", async () => {
    const r = await rig();
    await registered(r);
    assert.deepEqual((await r.api("POST", "/v1/push/test", { kind: "alert" })).json, { sent: true, kind: "alert" });
    assert.equal(r.pushes("alert").length, 1);
    const t = (await r.api("POST", "/v1/push/test", { kind: "voip" })).json;
    assert.equal(t.sent, true);
    assert.equal(r.pushes("voip")[0]!.body.callId, t.callId);
    await r.close();
  });
});

describe("the alert policy now reaches the phone", () => {
  it("important = message + push; critical = message + push + a call that rings the VoIP token", async () => {
    const r = await rig();
    await registered(r);
    const imp = await r.gw.escalation.notify({ severity: "important", title: "Build finished", body: "All green", dedupeKey: "a" });
    assert.deepEqual(imp.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:delivered"]);
    assert.equal(r.pushes("voip").length, 0);

    const crit = await r.gw.escalation.notify({ severity: "critical", title: "Training crashed", body: "CUDA OOM", dedupeKey: "b", sessionId: undefined });
    assert.deepEqual(crit.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:delivered", "call:delivered"]);
    const ring = r.pushes("voip")[0]!;
    assert.equal(ring.token, VOIP, "the call goes to the PushKit token, not the alert token");
    assert.equal(ring.body.title, "Training crashed");
    assert.equal(ring.body.expects, "conversation");
    await r.close();
  });

  it("at the PC nothing is pushed or rung (presence), though the message still lands", async () => {
    const r = await rig();
    await registered(r);
    r.gw.presence.setMode("home");
    const out = await r.gw.escalation.notify({ severity: "critical", title: "x", body: "", dedupeKey: "c" });
    assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:suppressed", "call:suppressed"]);
    assert.equal(mock.received.length, 0);
    await r.close();
  });

  it("a dead VoIP token fails the call cleanly and is dropped", async () => {
    const r = await rig();
    await r.api("PUT", "/v1/devices/me/push-token", { kind: "voip", token: DEAD, environment: "sandbox" });
    const out = await r.gw.escalation.notify({ severity: "critical", title: "x", body: "", dedupeKey: "d" });
    assert.equal(out.find((d) => d.channel === "call")?.status, "failed");
    assert.match(out.find((d) => d.channel === "call")!.reason!, /410 Unregistered/);
    assert.equal(r.gw.devices.tokensFor("voip").length, 0);
    assert.equal(r.gw.calls.list()[0]?.status, "failed", "recorded, not left ringing");
    await r.close();
  });
});

describe("an incoming call", () => {
  it("rings, is answered once, and opens a conversation primed with why Helix is calling", async () => {
    const r = await rig();
    await registered(r);
    const sess = await r.gw.manager.createSession({ provider: "claude", title: "Cat training", projectPath: tmp });
    const events: any[] = [];
    r.gw.manager.bus.subscribe((e) => events.push(e));

    await r.gw.escalation.notify({ severity: "critical", title: "Training crashed", body: "CUDA out of memory at step 84231.", dedupeKey: "e", sessionId: sess.id });
    const call = r.gw.calls.list()[0]!;
    assert.equal(call.status, "ringing");
    assert.equal(call.direction, "incoming");
    assert.equal(call.script, "Training crashed. CUDA out of memory at step 84231. What would you like to do?", "ready to be spoken");
    assert.ok(events.some((e) => e.type === "call.ringing" && e.call.id === call.id));

    const answered = (await r.api("POST", `/v1/calls/${call.id}/answer`)).json;
    assert.equal(answered.status, "answered");
    assert.ok(answered.routeId, "there is now a conversation to speak into");
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.provider.calls.length, 0, "the router does not speak first: the phone already said the script");

    await r.api("POST", `/v1/routes/${answered.routeId}/message`, { text: "what happened exactly?" });
    await r.until(() => r.provider.calls.some((c) => /\[Helix call\]/.test(c.text)));
    const primer = r.provider.calls.find((c) => /\[Helix call\]/.test(c.text))!.text;
    assert.match(primer, /Reason for the call: Training crashed\. CUDA out of memory/);
    assert.match(primer, /The phone already told them: "Training crashed\./, "so it will not repeat it");
    assert.match(primer, new RegExp(`Helix session id ${sess.id}`), "the router can hand the conversation to the session involved");
    assert.match(primer, /The user says: what happened exactly\?$/, "the user's own words come last");
    await r.api("POST", `/v1/routes/${answered.routeId}/message`, { text: "and now?" }).catch(() => undefined);
    assert.ok(events.some((e) => e.type === "call.answered"));

    assert.equal((await r.api("POST", `/v1/calls/${call.id}/answer`)).status, 409, "a second device cannot also answer");
    assert.equal((await r.api("POST", `/v1/calls/${call.id}/end`, {})).json.status, "ended");
    await r.close();
  });

  it("can be declined", async () => {
    const r = await rig();
    await registered(r);
    await r.gw.escalation.notify({ severity: "critical", title: "x", body: "", dedupeKey: "f" });
    const id = r.gw.calls.list()[0]!.id;
    const declined = (await r.api("POST", `/v1/calls/${id}/decline`)).json;
    assert.deepEqual([declined.status, declined.endReason], ["declined", "declined on the phone"]);
    assert.equal((await r.api("POST", `/v1/calls/${id}/answer`)).status, 409);
    await r.close();
  });

  it("unanswered, it becomes a missed call and the user is told by ordinary push", async () => {
    const r = await rig({ ringTimeoutMs: 120 });
    await registered(r);
    await r.gw.escalation.notify({ severity: "critical", title: "Disk is full", body: "0 bytes free", dedupeKey: "g" });
    mock.reset();
    await r.until(() => r.gw.calls.list()[0]!.status === "missed");
    await r.until(() => r.pushes("alert").length === 1);
    const p = r.pushes("alert")[0]!.body;
    assert.equal(p.aps.alert.title, "Missed call: Disk is full");
    assert.equal(p.helix.kind, "missed_call");
    await r.close();
  });

  it("an answered call is not turned into a missed one by the ring timer", async () => {
    const r = await rig({ ringTimeoutMs: 150 });
    await registered(r);
    await r.gw.escalation.notify({ severity: "critical", title: "x", body: "", dedupeKey: "h" });
    const id = r.gw.calls.list()[0]!.id;
    await r.api("POST", `/v1/calls/${id}/answer`);
    mock.reset();
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(r.gw.calls.get(id)!.status, "answered");
    assert.equal(mock.received.length, 0, "no 'missed call' push");
    await r.close();
  });

  it("a ringing call does not survive a gateway restart", async () => {
    const dbFile = path.join(tmp, "restart.db");
    const db = openDb(dbFile);
    db.prepare("INSERT INTO calls (id, direction, status, severity, title, created_at) VALUES ('c1', 'incoming', 'ringing', 'critical', 't', 'x')").run();
    const gw = await buildGateway({ defaultProjectPath: tmp, logLevel: "silent" }, db, { claude: new FakeProvider() });
    assert.equal(gw.calls.get("c1")!.status, "ended");
    assert.equal(gw.calls.get("c1")!.endReason, "gateway restarted");
    await gw.app.close();
    db.close(); // Windows will not delete a database file that is still open
  });
});

describe("an approval call", () => {
  const ask = (r: Rig, summary = "shell: rm -rf checkpoints/old-run-17  [atlas]") =>
    r.gw.approvals.request({ source: "agent", tool: "shell", summary, reasons: ["rm deletes data"] });

  it("pushes at once; if unanswered it rings, and the script says exactly what is being asked", async () => {
    const r = await rig({ approvalCallAfterMs: 150 });
    await registered(r);
    const { approval } = ask(r);

    await r.until(() => r.pushes("alert").length === 1);
    const push = r.pushes("alert")[0]!.body;
    assert.equal(push.aps.alert.title, "Approval needed [atlas]");
    assert.equal(push.helix.approvalId, approval.id);
    assert.equal(r.pushes("voip").length, 0, "not ringing yet");

    await r.until(() => r.pushes("voip").length === 1);
    const call = r.gw.calls.list()[0]!;
    assert.equal(call.expects, "approval");
    assert.equal(call.approvalId, approval.id);
    assert.equal(call.script, "Claude needs your approval to run the command rm -rf checkpoints/old-run-17, in atlas. Say approve to allow it, or reject to stop it.");
    assert.equal(r.pushes("voip")[0]!.body.helix.approvalId, approval.id);
    await r.close();
  });

  it("answering and saying 'approve' resolves the approval, once", async () => {
    const r = await rig({ approvalCallAfterMs: 80 });
    await registered(r);
    const { approval, outcome } = ask(r);
    await r.until(() => r.gw.calls.list()[0]?.status === "ringing");
    const id = r.gw.calls.list()[0]!.id;

    assert.equal((await r.api("POST", `/v1/calls/${id}/decision`, { approve: true })).status, 409, "must answer before deciding");
    const answered = (await r.api("POST", `/v1/calls/${id}/answer`)).json;
    assert.equal(answered.routeId, undefined, "an approval call is not a conversation");

    const decided = await r.api("POST", `/v1/calls/${id}/decision`, { approve: true });
    assert.equal(decided.json.approvalStatus, "approved");
    assert.equal(decided.json.call.status, "ended");
    assert.equal((await outcome).approved, true, "the agent that was waiting is released");
    assert.equal(r.gw.approvals.get(approval.id)!.resolvedBy !== undefined, true);

    assert.equal((await r.api("POST", `/v1/calls/${id}/decision`, { approve: false })).status, 409, "no changing your mind after the call ended");
    assert.equal(r.gw.approvals.get(approval.id)!.status, "approved");
    await r.close();
  });

  it("saying 'reject' denies it", async () => {
    const r = await rig({ approvalCallAfterMs: 80 });
    await registered(r);
    const { outcome } = ask(r);
    await r.until(() => r.gw.calls.list()[0]?.status === "ringing");
    const id = r.gw.calls.list()[0]!.id;
    await r.api("POST", `/v1/calls/${id}/answer`);
    assert.equal((await r.api("POST", `/v1/calls/${id}/decision`, { approve: false })).json.approvalStatus, "rejected");
    assert.deepEqual((({ approved, status }) => ({ approved, status }))(await outcome), { approved: false, status: "rejected" });
    await r.close();
  });

  it("approved from the app while the phone is still ringing: the call ends quietly, nothing is 'missed'", async () => {
    // The ring timeout must comfortably outlast the test's own steps even on a loaded machine (a 400 ms timeout made this
    // flaky: the call "missed" before the approval arrived). Then wait out the whole timeout to prove no missed-call push follows.
    const RING_MS = 1500;
    const r = await rig({ approvalCallAfterMs: 80, ringTimeoutMs: RING_MS });
    await registered(r);
    const { approval } = ask(r);
    await r.until(() => r.gw.calls.list()[0]?.status === "ringing");
    // The call is marked ringing slightly BEFORE its push reaches the (mock) Apple server. Wait for the ring itself to
    // arrive; clearing the record earlier made that late original push look like a stray one on a busy machine.
    await r.until(() => r.pushes("voip").length === 1);
    mock.reset();
    await r.api("POST", `/v1/approvals/${approval.id}/approve`, {});
    const call = r.gw.calls.list()[0]!;
    assert.equal(call.status, "ended");
    assert.match(call.endReason!, /approval approved elsewhere/);
    await new Promise((res) => setTimeout(res, RING_MS + 300));
    assert.equal(mock.received.length, 0, `no missed-call push for a call that no longer matters, but got: ${JSON.stringify(mock.received.map((x) => ({ type: x.headers["apns-push-type"], body: x.body })))}`);
    await r.close();
  });

  it("answered in the app before the delay: no call is ever placed", async () => {
    const r = await rig({ approvalCallAfterMs: 200 });
    await registered(r);
    const { approval } = ask(r);
    await r.api("POST", `/v1/approvals/${approval.id}/reject`, {});
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(r.gw.calls.list().length, 0);
    assert.equal(r.pushes("voip").length, 0);
    await r.close();
  });

  it("a decision is only accepted on an approval call, from a paired device", async () => {
    const r = await rig();
    await registered(r);
    await r.gw.escalation.notify({ severity: "critical", title: "plain event", body: "", dedupeKey: "i" });
    const id = r.gw.calls.list()[0]!.id;
    await r.api("POST", `/v1/calls/${id}/answer`);
    assert.equal((await r.api("POST", `/v1/calls/${id}/decision`, { approve: true })).status, 400, "not an approval call");
    assert.equal((await r.api("POST", `/v1/calls/${id}/decision`, { approve: true }, false)).status, 401);
    const local = r.gw.localTokens.create("agent").token;
    assert.equal((await r.api("POST", `/v1/calls/${id}/decision`, { approve: true }, local)).status, 401, "an agent's own credential cannot answer for the user");
    await r.close();
  });

  it("at the PC the approval still waits in the app but nothing buzzes or rings", async () => {
    const r = await rig({ approvalCallAfterMs: 80 });
    await registered(r);
    r.gw.presence.setMode("home");
    ask(r);
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(mock.received.length, 0);
    assert.equal(r.gw.approvals.list("pending").length, 1);
    await r.close();
  });
});

describe("the user calls Helix", () => {
  it("'Call Claude' opens a route straight away; calling a specific session hands it over", async () => {
    const r = await rig();
    const general = (await r.api("POST", "/v1/calls/start", {})).json;
    assert.equal(general.direction, "outgoing");
    assert.equal(general.status, "answered");
    const route = (await r.api("GET", `/v1/routes/${general.routeId}`)).json;
    assert.equal(route.targetSessionId, undefined, "talking to the General Claude");

    const sess = await r.gw.manager.createSession({ provider: "claude", title: "Orbit", projectPath: tmp });
    const direct = (await r.api("POST", "/v1/calls/start", { sessionId: sess.id })).json;
    assert.equal(direct.title, "Call Orbit");
    assert.equal((await r.api("GET", `/v1/routes/${direct.routeId}`)).json.targetSessionId, sess.id);

    assert.equal((await r.api("GET", "/v1/calls")).json.calls.length, 2);
    assert.equal((await r.api("POST", "/v1/calls/start", {}, false)).status, 401);
    await r.close();
  });
});

describe("events over the websocket (what the app shows while it is open)", () => {
  it("call.ringing, call.answered and call.ended are pushed to the phone", async () => {
    const r = await rig();
    await registered(r);
    const ws = new WebSocket(r.base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${r.token}` } });
    const got: any[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
    await new Promise((res) => ws.once("open", res));
    await r.gw.escalation.notify({ severity: "critical", title: "x", body: "", dedupeKey: "ws" });
    const id = r.gw.calls.list()[0]!.id;
    await r.api("POST", `/v1/calls/${id}/answer`);
    await r.api("POST", `/v1/calls/${id}/end`, {});
    await r.until(() => got.some((e) => e.type === "call.ended"));
    assert.deepEqual(got.filter((e) => e.type.startsWith("call.")).map((e) => `${e.type}:${e.call.status}`), ["call.ringing:ringing", "call.answered:answered", "call.ended:ended"]);
    ws.close();
    await r.close();
  });
});

describe("rehearsing calls from the app: POST /v1/calls/simulate", () => {
  it("a critical test call rings the phone through the real path, with the VoIP payload the app will receive", async () => {
    const r = await rig();
    await registered(r);
    const res = await r.api("POST", "/v1/calls/simulate", { severity: "critical", title: "Training crashed", summary: "Loss went to NaN at step 9000." });
    assert.equal(res.status, 201);
    assert.equal(res.json.call.status, "ringing");
    assert.equal(res.json.call.severity, "critical");
    assert.equal(res.json.call.expects, "conversation");
    assert.equal(res.json.approvalId, undefined);
    const voip = r.pushes("voip");
    assert.equal(voip.length, 1);
    assert.equal(voip[0]!.body.callId, res.json.call.id);
    assert.equal(voip[0]!.body.helix.severity, "critical");
    // answering it is exactly the normal flow: a conversation route is opened with the call's context
    const answered = (await r.api("POST", `/v1/calls/${res.json.call.id}/answer`)).json;
    assert.ok(answered.routeId);
    await r.close();
  });

  it("an approval test call: the spoken yes/no flow works end to end, and the approval is labelled as a test", async () => {
    const r = await rig();
    await registered(r);
    const res = await r.api("POST", "/v1/calls/simulate", { approval: true, summary: "delete the old checkpoints" });
    assert.equal(res.status, 201);
    assert.equal(res.json.call.expects, "approval");
    const approval = r.gw.approvals.get(res.json.approvalId)!;
    assert.equal(approval.status, "pending");
    assert.match(approval.summary, /^Test only, nothing will run: delete the old checkpoints/);
    assert.match(res.json.call.script, /approve/i, "the call explains how to answer");

    const id = res.json.call.id;
    await r.api("POST", `/v1/calls/${id}/answer`);
    const decided = await r.api("POST", `/v1/calls/${id}/decision`, { approve: false });
    assert.equal(decided.json.approvalStatus, "rejected");
    assert.equal(r.gw.approvals.get(res.json.approvalId)!.status, "rejected");
    await r.close();
  });

  it("if the call cannot be delivered, nothing is left pending", async () => {
    const r = await rig();
    // no phone registered
    const res = await r.api("POST", "/v1/calls/simulate", { approval: true });
    assert.equal(res.status, 502);
    assert.match(res.json.error, /no phone has registered/);
    assert.equal(r.gw.approvals.list("pending").length, 0, "the test approval was withdrawn");
    await r.close();
  });

  it("without Apple credentials it says how to check the setup", async () => {
    const r = await rig({ apns: false });
    const res = await r.api("POST", "/v1/calls/simulate", {});
    assert.equal(res.status, 409);
    assert.match(res.json.error, /npm run push -- check/);
    await r.close();
  });

  it("needs a paired device, validates its input, and is rate limited", async () => {
    const r = await rig();
    await registered(r);
    assert.equal((await r.api("POST", "/v1/calls/simulate", {}, false)).status, 401);
    assert.equal((await r.api("POST", "/v1/calls/simulate", { severity: "info" })).status, 400, "only calls that would really ring");
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await r.api("POST", "/v1/calls/simulate", {})).status);
    assert.ok(statuses.includes(429), `got ${statuses.join(",")}`);
    await r.close();
  });
});

describe("ringback and hanging up", () => {
  it("an outgoing call tells the phone how long to ring: 1 to 3 seconds, different each time", async () => {
    const r = await rig();
    const times: number[] = [];
    for (let i = 0; i < 12; i++) times.push((await r.api("POST", "/v1/calls/start", {})).json.ringbackMs);
    assert.ok(times.every((t) => Number.isInteger(t) && t >= 1000 && t <= 3000), times.join(","));
    assert.ok(new Set(times).size > 3, `varied: ${times.join(",")}`);
    await r.close();
  });

  const events = (r: Rig) => { const seen: any[] = []; r.gw.manager.bus.subscribe((e) => { seen.push(e); }); return seen; };

  it("a clear goodbye on a call: the reply is still spoken, then the line goes quiet", async () => {
    const r = await rig();
    r.gw.calls.speechDelayMs = () => 40;
    const seen = events(r);
    const call = (await r.api("POST", "/v1/calls/start", {})).json;
    await r.api("POST", `/v1/routes/${call.routeId}/message`, { text: "okay that's all, bye" });
    await r.until(() => seen.some((e) => e.type === "call.hangup"));
    assert.equal(seen.find((e) => e.type === "call.hangup").afterSpeech, true);
    assert.equal(r.gw.calls.get(call.id)!.status, "answered", "not cut off before the reply");
    await r.until(() => r.gw.calls.get(call.id)!.status === "ended");
    assert.equal(r.gw.calls.get(call.id)!.endReason, "hung up after goodbye");
    assert.ok(seen.some((e) => e.type === "agent.output.final"), "the goodbye reply was produced");
    await r.close();
  });

  it("ordinary talk keeps the call, and a goodbye in a text chat (no call) does nothing", async () => {
    const r = await rig();
    r.gw.calls.speechDelayMs = () => 20;
    const seen = events(r);
    const call = (await r.api("POST", "/v1/calls/start", {})).json;
    await r.api("POST", `/v1/routes/${call.routeId}/message`, { text: "check why the build failed" });
    await r.until(() => seen.some((e) => e.type === "agent.output.final"));
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(r.gw.calls.get(call.id)!.status, "answered");
    r.gw.calls.end(call.id);
    seen.length = 0;
    await r.api("POST", `/v1/routes/${call.routeId}/message`, { text: "bye" }); // the call is over: this is just text
    await r.until(() => seen.some((e) => e.type === "agent.output.final"));
    assert.ok(!seen.some((e) => e.type === "call.hangup"));
    await r.close();
  });

  it("the handed session can hang up too (end_call), and only the call it is speaking on", async () => {
    const r = await rig();
    r.gw.calls.speechDelayMs = () => 20;
    const sess = await r.gw.manager.createSession({ provider: "claude", title: "Orbit", projectPath: tmp });
    const other = await r.gw.manager.createSession({ provider: "claude", title: "Other", projectPath: tmp });
    const seen = events(r);
    assert.equal(r.gw.router.hangUp!(sess.id), false, "no call yet");
    const call = (await r.api("POST", "/v1/calls/start", { sessionId: sess.id })).json;
    assert.equal(r.gw.router.hangUp!(other.id), false, "a session that is not on the call cannot end it");
    assert.equal(r.gw.calls.get(call.id)!.status, "answered");
    assert.equal(r.gw.router.hangUp!(sess.id), true);
    assert.ok(seen.some((e) => e.type === "call.hangup"));
    // The agent's goodbye is its reply: once it arrives the call ends
    await r.api("POST", `/v1/routes/${call.routeId}/message`, { text: "thanks" });
    await r.until(() => r.gw.calls.get(call.id)!.status === "ended");
    await r.close();
  });

  it("a hang-up with no reply at all still ends the call (the safety timer is cleared when it ends another way)", async () => {
    const r = await rig();
    const call = (await r.api("POST", "/v1/calls/start", {})).json;
    assert.equal(r.gw.calls.hangUpAfterReply(call.id), true);
    r.gw.calls.end(call.id, "ended on the phone");
    assert.equal(r.gw.calls.get(call.id)!.endReason, "ended on the phone");
    assert.equal(r.gw.calls.hangUpAfterReply(call.id), false, "nothing left to hang up");
    await r.close();
  });
});
