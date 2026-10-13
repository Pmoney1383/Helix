import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ApnsClient } from "../src/notifications/apns.js";
import { DeviceTokens } from "../src/notifications/devices.js";
import { PushNotifier } from "../src/notifications/push.js";
import { openDb } from "../src/storage/sqlite.js";
import { makeKey, startMockApns, verifyJwt } from "./fixtures/mock-apns.js";

// The mock sends these markers back as Apple would; real tokens are just hex, so the markers are hex-safe prefixes.
const T = {
  ok: "a1".repeat(32), ok2: "b2".repeat(32),
  dead: "dead" + "0".repeat(60), bad: "bad0" + "0".repeat(60), flaky: "f1a4" + "0".repeat(60), throttle: "7407" + "0".repeat(60),
};

let mock: Awaited<ReturnType<typeof startMockApns>>;
let key: ReturnType<typeof makeKey>;
before(async () => { mock = await startMockApns(); key = makeKey(); });
after(async () => { await mock.close(); });

const client = (extra: Partial<ConstructorParameters<typeof ApnsClient>[0]> = {}) =>
  new ApnsClient({
    keyPem: key.keyPem, keyId: "KEY123ABCD", teamId: "TEAM987654", bundleId: "com.example.helix",
    endpoints: { sandbox: mock.url, production: mock.url }, retryDelayMs: 5, timeoutMs: 800, ...extra,
  });

describe("APNs client", () => {
  it("signs a valid ES256 provider token that Apple could verify", async () => {
    mock.reset();
    const c = client();
    await c.send({ token: T.ok, environment: "sandbox", kind: "alert", payload: { aps: { alert: "x" } } });
    const auth = String(mock.received[0]!.headers.authorization);
    assert.match(auth, /^bearer /);
    const v = verifyJwt(auth.slice(7), key.publicKey);
    assert.equal(v.ok, true, "signature verifies against the key's public half");
    assert.equal(v.header.alg, "ES256");
    assert.equal(v.header.kid, "KEY123ABCD");
    assert.equal(v.claims.iss, "TEAM987654");
    assert.ok(Math.abs(v.claims.iat - Date.now() / 1000) < 5);
    c.close();
  });

  it("reuses the token for 40 minutes, then makes a fresh one (Apple rejects tokens older than an hour)", async () => {
    mock.reset();
    let now = 1_800_000_000_000;
    const c = client({ now: () => now });
    const send = () => c.send({ token: T.ok, environment: "sandbox", kind: "alert", payload: {} });
    await send(); now += 30 * 60_000; await send();
    assert.equal(mock.received[0]!.headers.authorization, mock.received[1]!.headers.authorization, "cached");
    now += 15 * 60_000; await send();
    assert.notEqual(mock.received[2]!.headers.authorization, mock.received[0]!.headers.authorization, "refreshed");
    c.close();
  });

  it("alert pushes: bundle topic, alert type, priority, collapse id, ttl, JSON body", async () => {
    mock.reset();
    const c = client();
    const r = await c.send({ token: T.ok, environment: "sandbox", kind: "alert", payload: { aps: { alert: { title: "hi" } }, helix: { a: 1 } }, priority: 5, collapseId: "approval-42", ttlSeconds: 3600 });
    assert.equal(r.ok, true);
    assert.ok(r.apnsId);
    const got = mock.received[0]!;
    assert.equal(got.path, `/3/device/${T.ok}`);
    assert.equal(got.headers["apns-topic"], "com.example.helix");
    assert.equal(got.headers["apns-push-type"], "alert");
    assert.equal(got.headers["apns-priority"], "5");
    assert.equal(got.headers["apns-collapse-id"], "approval-42");
    assert.ok(Number(got.headers["apns-expiration"]) > Date.now() / 1000, "waits for an offline phone for up to an hour");
    assert.deepEqual(got.body, { aps: { alert: { title: "hi" } }, helix: { a: 1 } });
    c.close();
  });

  it("VoIP pushes (calls): the .voip topic, voip type, top priority, and never queued for a phone that is off", async () => {
    mock.reset();
    const c = client();
    await c.send({ token: T.ok, environment: "sandbox", kind: "voip", payload: { callId: "c1" }, priority: 5, ttlSeconds: 3600 });
    const h = mock.received[0]!.headers;
    assert.equal(h["apns-topic"], "com.example.helix.voip");
    assert.equal(h["apns-push-type"], "voip");
    assert.equal(h["apns-priority"], "10", "a call is always urgent, whatever the caller asked");
    assert.equal(h["apns-expiration"], "0", "ring now or never: a stale call is worse than none");
    c.close();
  });

  it("recognises dead tokens (uninstalled app, wrong environment) so they can be dropped", async () => {
    const c = client();
    const dead = await c.send({ token: T.dead, environment: "sandbox", kind: "alert", payload: {} });
    assert.deepEqual([dead.ok, dead.status, dead.reason, dead.invalidToken], [false, 410, "Unregistered", true]);
    const bad = await c.send({ token: T.bad, environment: "sandbox", kind: "alert", payload: {} });
    assert.deepEqual([bad.ok, bad.status, bad.reason, bad.invalidToken], [false, 400, "BadDeviceToken", true]);
    c.close();
  });

  it("retries transient failures for ordinary pushes (503, 429) but not for calls", async () => {
    mock.reset();
    const c = client();
    const flaky = await c.send({ token: T.flaky, environment: "sandbox", kind: "alert", payload: {} });
    assert.equal(flaky.ok, true);
    assert.equal(mock.received.filter((r) => r.token === T.flaky).length, 2, "one retry");
    const throttled = await c.send({ token: T.throttle, environment: "sandbox", kind: "alert", payload: {} });
    assert.equal(throttled.ok, true);

    mock.reset();
    const call = await c.send({ token: T.flaky, environment: "sandbox", kind: "voip", payload: {} });
    assert.equal(call.ok, false, "a call that did not go out at once is not retried: it would ring late");
    assert.equal(mock.received.length, 1);
    c.close();
  });

  it("does not hang the gateway when Apple does not answer", async () => {
    const c = client({ timeoutMs: 200, retryDelayMs: 1 });
    const t0 = Date.now();
    const r = await c.send({ token: "c0ff" + "0".repeat(60), environment: "sandbox", kind: "voip", payload: {} });
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(r.ok, false);
    c.close();
  });

  it("sandbox and production are separate hosts", async () => {
    const other = await startMockApns();
    const c = client({ endpoints: { sandbox: mock.url, production: other.url } });
    mock.reset(); other.reset();
    await c.send({ token: T.ok, environment: "sandbox", kind: "alert", payload: {} });
    await c.send({ token: T.ok, environment: "production", kind: "alert", payload: {} });
    assert.equal(mock.received.length, 1);
    assert.equal(other.received.length, 1);
    c.close(); await other.close();
  });

  it("rejects an unusable key at startup rather than at the first alert", () => {
    assert.throws(() => new ApnsClient({ keyPem: "not a key", keyId: "K", teamId: "T", bundleId: "b" }));
  });

  it("reports an unreachable server as a failed result, not an exception", async () => {
    const c = client({ endpoints: { sandbox: "http://127.0.0.1:1", production: "http://127.0.0.1:1" }, retryDelayMs: 1 });
    const r = await c.send({ token: T.ok, environment: "sandbox", kind: "alert", payload: {} });
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    c.close();
  });
});

describe("push channel", () => {
  const setup = () => {
    const db = openDb(":memory:");
    for (const id of ["d1", "d2", "d3"]) db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(id, id, id, "t");
    const devices = new DeviceTokens(db);
    const apns = client();
    mock.reset();
    return { db, devices, push: new PushNotifier(apns, devices), apns };
  };
  const notice = (o: Partial<Parameters<PushNotifier["deliver"]>[0]> = {}) =>
    ({ severity: "important" as const, title: "Training crashed", body: "CUDA out of memory at step 84231\nline two with more detail", dedupeKey: "k", ...o });

  it("sends a short preview to every registered phone, in the right environment", async () => {
    const { devices, push, apns } = setup();
    devices.register("d1", { kind: "alert", token: T.ok, environment: "sandbox" });
    devices.register("d2", { kind: "alert", token: T.ok2, environment: "production" });
    await push.deliver(notice({ sessionId: "s1", eventId: "e1" }));
    assert.deepEqual(mock.received.map((r) => r.token).sort(), [T.ok, T.ok2].sort());
    const p = mock.received[0]!.body;
    assert.equal(p.aps.alert.title, "Training crashed");
    assert.equal(p.aps.alert.body, "CUDA out of memory at step 84231", "first line only: the full detail stays on the PC");
    assert.equal(p.aps["thread-id"], "s1");
    assert.equal(p.aps["interruption-level"], "active");
    assert.deepEqual(p.helix, { kind: "event", severity: "important", eventId: "e1", sessionId: "s1" });
    apns.close();
  });

  it("critical alerts are marked time-sensitive; long text is clipped", async () => {
    const { devices, push, apns } = setup();
    devices.register("d1", { kind: "alert", token: T.ok, environment: "sandbox" });
    await push.deliver(notice({ severity: "critical", title: "x".repeat(200), body: "y".repeat(500) }));
    const p = mock.received[0]!.body;
    assert.equal(p.aps["interruption-level"], "time-sensitive");
    assert.ok(p.aps.alert.title.length <= 80 && p.aps.alert.body.length <= 140);
    apns.close();
  });

  it("approval pushes carry the approval id and collapse, so a repeat replaces the earlier one", async () => {
    const { devices, push, apns } = setup();
    devices.register("d1", { kind: "alert", token: T.ok, environment: "sandbox" });
    await push.deliver(notice({ kind: "approval", approvalId: "ap-1" }));
    assert.equal(mock.received[0]!.headers["apns-collapse-id"], "approval-ap-1");
    assert.equal(mock.received[0]!.body.helix.approvalId, "ap-1");
    assert.equal(mock.received[0]!.body.aps.category, "helix.approval", "lock-screen Approve / Reject buttons");
    mock.reset();
    await push.deliver(notice());
    assert.equal(mock.received[0]!.body.aps.category, undefined, "ordinary alerts carry no buttons");
    apns.close();
  });

  it("drops tokens Apple says are dead, still delivers to the live ones, and fails only if nothing got through", async () => {
    const { devices, push, apns } = setup();
    devices.register("d1", { kind: "alert", token: T.ok, environment: "sandbox" });
    devices.register("d2", { kind: "alert", token: T.dead, environment: "sandbox" });
    await push.deliver(notice());
    assert.deepEqual(devices.tokensFor("alert").map((t) => t.token), [T.ok], "the dead one is no longer used");

    const only = setup();
    only.devices.register("d1", { kind: "alert", token: T.bad, environment: "sandbox" });
    await assert.rejects(() => only.push.deliver(notice()), /push not delivered: 400 BadDeviceToken/);
    only.apns.close(); apns.close();
  });

  it("says plainly when no phone has registered", async () => {
    const { push, apns } = setup();
    await assert.rejects(() => push.deliver(notice()), /no phone has registered/);
    apns.close();
  });

  it("ignores revoked devices and tokens of the wrong kind", () => {
    const { db, devices, apns } = setup();
    devices.register("d1", { kind: "alert", token: T.ok, environment: "sandbox" });
    devices.register("d2", { kind: "voip", token: T.ok2, environment: "sandbox" });
    devices.register("d3", { kind: "alert", token: T.dead, environment: "sandbox" });
    db.prepare("UPDATE devices SET revoked_at = 'x' WHERE id = 'd3'").run();
    assert.deepEqual(devices.tokensFor("alert").map((t) => t.deviceId), ["d1"]);
    assert.deepEqual(devices.tokensFor("voip").map((t) => t.deviceId), ["d2"]);
    apns.close();
  });

  it("re-registering replaces the token and revives an invalidated one", () => {
    const { devices, apns } = setup();
    devices.register("d1", { kind: "alert", token: T.ok, environment: "sandbox" });
    devices.invalidate(T.ok);
    assert.equal(devices.tokensFor("alert").length, 0);
    devices.register("d1", { kind: "alert", token: T.ok2, environment: "production" });
    assert.deepEqual(devices.tokensFor("alert").map((t) => [t.token, t.environment]), [[T.ok2, "production"]]);
    apns.close();
  });
});
