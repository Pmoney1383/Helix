import assert from "node:assert/strict";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { Escalation, type Notice, type Notifier } from "../src/notifications/escalation.js";
import { PresenceService } from "../src/notifications/presence.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const MIN = 60_000;

class Recorder implements Notifier {
  sent: Notice[] = [];
  async deliver(n: Notice) { this.sent.push(n); }
}

describe("presence", () => {
  const mk = () => {
    const t = { now: 1_000_000 };
    return { t, p: new PresenceService(openDb(":memory:"), { awayAfterMin: 5, now: () => t.now }) };
  };

  it("auto: at the PC while recently active, away once idle long enough", () => {
    const { t, p } = mk();
    p.reportIdle(30);
    assert.equal(p.isAway(), false);
    assert.equal(p.status().reason, "you are at the PC");
    p.reportIdle(4 * 60);
    assert.equal(p.isAway(), false, "4 minutes idle is not yet away");
    p.reportIdle(5 * 60);
    assert.equal(p.isAway(), true);
    assert.match(p.status().reason, /idle for 5 min/);
    assert.equal(p.status().idleSec, 300);
    t.now += 1; // reporter stays fresh
  });

  it("not knowing means away: a missed alert is worse than an unneeded one", () => {
    const { t, p } = mk();
    assert.equal(p.isAway(), true, "no helper has ever reported");
    assert.match(p.status().reason, /no desktop helper/);
    p.reportIdle(10);
    assert.equal(p.isAway(), false);
    t.now += 2 * MIN; // helper went quiet (PC asleep, helper killed...)
    assert.equal(p.isAway(), true);
    assert.equal(p.status().reporterActive, false);
  });

  it("manual override wins and persists", () => {
    const { p } = mk();
    p.reportIdle(5);
    p.setMode("away");
    assert.equal(p.isAway(), true, "away even though active");
    p.setMode("home");
    p.reportIdle(3600);
    assert.equal(p.isAway(), false, "home even though idle for an hour");
    p.setMode("auto");
    assert.equal(p.isAway(), true);
    assert.equal(p.mode(), "auto");
  });
});

describe("alerts follow presence", () => {
  const mk = (away: boolean) => {
    const db = openDb(":memory:");
    const message = new Recorder(), push = new Recorder(), call = new Recorder();
    const presence = { isAway: () => away, status: () => ({ reason: "you are at the PC" }) };
    const e = new Escalation(db, { message, push, call }, { presence });
    return { e, message, push, call };
  };
  const n = (severity: Notice["severity"]): Notice => ({ severity, title: "t", body: "", dedupeKey: "k" });

  it("at the PC: the app and the phone get the push, but nothing rings", async () => {
    const { e, message, push, call } = mk(false);
    const out = await e.notify(n("critical"));
    assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:delivered", "call:suppressed"]);
    assert.match(out[2]!.reason!, /you are at the PC/);
    assert.equal(message.sent.length, 1);
    assert.equal(push.sent.length, 1);
    assert.equal(call.sent.length, 0);
  });

  it("an important alert pushes at the PC and away alike", async () => {
    for (const away of [false, true]) {
      const { e, push, call } = mk(away);
      const out = await e.notify(n("important"));
      assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:delivered"], `away=${away}`);
      assert.equal(push.sent.length, 1);
      assert.equal(call.sent.length, 0);
    }
  });

  it("away: the normal severity policy applies", async () => {
    const { e, push, call } = mk(true);
    await e.notify(n("important"));
    assert.equal(push.sent.length, 1);
    assert.equal(call.sent.length, 0);
    await e.notify(n("critical"));
    assert.equal(push.sent.length, 2);
    assert.equal(call.sent.length, 1);
  });

  it("a suppressed call does not use up the call allowance", async () => {
    let away = false;
    const db = openDb(":memory:");
    const call = new Recorder();
    const e = new Escalation(db, { message: new Recorder(), push: new Recorder(), call }, { presence: { isAway: () => away, status: () => ({ reason: "x" }) }, maxCallsPerHour: 1 });
    await e.notify(n("critical"));
    away = true;
    await e.notify(n("critical"));
    assert.equal(call.sent.length, 1, "the first real call still goes out");
  });

  it("an approval request pushes on the first request in every presence mode", async () => {
    for (const away of [false, true]) {
      const { e, push, call } = mk(away);
      const approval = { title: "Approval needed", body: "rm -rf build", dedupeKey: "approval:a1", approvalId: "a1", kind: "approval" as const };
      const out = await e.notify({ ...approval, severity: "important" }, { skip: ["message"] });
      assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["push:delivered"], `away=${away}`);
      assert.equal(push.sent.length, 1);
      // The escalated ring after a wait still follows presence.
      const ring = await e.notify({ ...approval, severity: "critical", dedupeKey: "approval-call:a1" }, { skip: ["message", "push"] });
      assert.equal(ring[0]!.status, away ? "delivered" : "suppressed", `ring away=${away}`);
      assert.equal(call.sent.length, away ? 1 : 0);
    }
  });

  it("skip lets a caller omit a channel it already covered", async () => {
    const { e, message, push } = mk(true);
    const out = await e.notify(n("important"), { skip: ["message"] });
    assert.deepEqual(out.map((d) => d.channel), ["push"]);
    assert.equal(message.sent.length, 0);
    assert.equal(push.sent.length, 1);
  });
});

describe("presence API", () => {
  let gw: Gateway;
  let base: string;
  let deviceToken: string;
  let localToken: string;

  before(async () => {
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    deviceToken = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
    localToken = gw.localTokens.create("presence-helper").token;
  });
  after(async () => { await gw.app.close(); });

  const call = (method: string, p: string, token: string | undefined, body?: unknown) =>
    fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("the desktop helper reports idle time with a local token; the phone reads and sets the mode", async () => {
    assert.equal((await call("POST", "/v1/presence/idle", deviceToken, { idleSec: 5 })).status, 401, "phone tokens are not the helper");
    assert.equal((await call("POST", "/v1/presence/idle", undefined, { idleSec: 5 })).status, 401);
    assert.equal((await call("POST", "/v1/presence/idle", localToken, { idleSec: 12 })).status, 204);

    const s = await (await call("GET", "/v1/presence", deviceToken)).json() as any;
    assert.equal(s.away, false);
    assert.equal(s.idleSec, 12);
    assert.equal(s.reporterActive, true);

    assert.equal((await call("GET", "/v1/presence", localToken)).status, 401, "helper token cannot read or steer presence");
    const set = await (await call("PUT", "/v1/presence", deviceToken, { mode: "away" })).json() as any;
    assert.equal(set.away, true);
    assert.equal((await call("PUT", "/v1/presence", deviceToken, { mode: "bogus" })).status, 400);
    await call("PUT", "/v1/presence", deviceToken, { mode: "auto" });
  });

  it("rejects nonsense idle values", async () => {
    assert.equal((await call("POST", "/v1/presence/idle", localToken, { idleSec: -5 })).status, 400);
    assert.equal((await call("POST", "/v1/presence/idle", localToken, { idleSec: "soon" })).status, 400);
  });

  it("notify_user from an agent respects presence end to end", async () => {
    // at the PC: no push/call attempted even though the channel is unavailable anyway; the tool reports it truthfully
    await call("POST", "/v1/presence/idle", localToken, { idleSec: 1 });
    const results = await gw.escalation.notify({ severity: "important", title: "x", body: "", dedupeKey: "d" });
    assert.deepEqual(results.map((r) => `${r.channel}:${r.status}`), ["message:delivered", "push:unavailable"]);
  });
});
