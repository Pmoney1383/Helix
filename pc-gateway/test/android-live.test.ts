import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import { ChannelUnavailable } from "../src/notifications/escalation.js";
import { LiveDevices } from "../src/notifications/live-devices.js";
import { FanOutNotifier } from "../src/notifications/live-push.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-android-"));
const open = new Set<Gateway>();
after(async () => {
  await Promise.all([...open].map((gw) => gw.app.close().catch(() => undefined)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A gateway without Apple push, and a phone paired with the given platform. */
async function rig(platform: string) {
  const gw = await buildGateway({ defaultProjectPath: tmp, logLevel: "silent", routerHome: path.join(tmp, "router"), ringTimeoutMs: 30_000, approvalCallAfterMs: 0 },
    openDb(":memory:"), { claude: new FakeProvider() });
  open.add(gw);
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (gw.app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const { code } = gw.auth.createPairingCode();
  const paired = (await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "phone", platform }) })).json()) as { token: string };
  gw.presence.setMode("away");
  const events: any[] = [];
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${paired.token}` } });
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await until(() => events.some((e) => e.type === "hello"));
    return ws;
  };
  const status = async () => (await (await fetch(base + "/v1/push/status", { headers: { authorization: `Bearer ${paired.token}` } })).json()) as any;
  return { gw, events, connect, status };
}

async function until(fn: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
}

describe("Android phones get pushes and calls over the live connection", () => {
  it("an important event becomes a device.notification while an Android phone is connected", async () => {
    const r = await rig("android");
    const ws = await r.connect();
    assert.equal((await r.status()).androidConnected, 1);
    const out = await r.gw.escalation.notify({ severity: "important", title: "Build failed", body: "tsc: 3 errors\nmore", dedupeKey: "k", kind: "event" });
    assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:delivered"]);
    await until(() => r.events.some((e) => e.type === "device.notification"));
    const n = r.events.find((e) => e.type === "device.notification").notification;
    assert.deepEqual([n.title, n.body, n.severity, n.kind], ["Build failed", "tsc: 3 errors\nmore", "important", "event"]);
    ws.close();
  });

  it("a critical event rings the Android phone with no Apple push configured", async () => {
    const r = await rig("android");
    const ws = await r.connect();
    const out = await r.gw.escalation.notify({ severity: "critical", title: "Training crashed", body: "CUDA out of memory", dedupeKey: "crash" });
    assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:delivered", "call:delivered"]);
    await until(() => r.events.some((e) => e.type === "call.ringing"));
    const ringing = r.events.find((e) => e.type === "call.ringing").call;
    assert.equal(ringing.status, "ringing");
    assert.equal(ringing.title, "Training crashed");
    ws.close();
  });

  it("once the Android phone disconnects, push and calls are unavailable again", async () => {
    const r = await rig("android");
    const ws = await r.connect();
    ws.close();
    const t = Date.now();
    while ((await r.status()).androidConnected !== 0 && Date.now() - t < 3000) await new Promise((res) => setTimeout(res, 20));
    const out = await r.gw.escalation.notify({ severity: "critical", title: "t", body: "", dedupeKey: "gone" });
    assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:unavailable", "call:unavailable"]);
  });

  it("an iPhone on the live connection does not count: it is reached through Apple push only", async () => {
    const r = await rig("ios");
    const ws = await r.connect();
    assert.equal((await r.status()).androidConnected, 0);
    const out = await r.gw.escalation.notify({ severity: "important", title: "t", body: "", dedupeKey: "ios" });
    assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:unavailable"]);
    assert.ok(!r.events.some((e) => e.type === "device.notification"));
    ws.close();
  });
});

describe("LiveDevices and FanOutNotifier", () => {
  it("counts devices, not sockets, and closing twice is harmless", () => {
    const live = new LiveDevices();
    const a = live.connect("d1", "android");
    const b = live.connect("d1", "android");
    const c = live.connect("d2", "ios");
    assert.equal(live.count("android"), 1);
    a(); a();
    assert.equal(live.count("android"), 1, "the second socket of the same phone is still open");
    b();
    assert.equal(live.count("android"), 0);
    c();
    assert.equal(live.count("ios"), 0);
  });

  it("delivered if any notifier delivered; unavailable only if none could try; failed otherwise", async () => {
    const ok = { deliver: async () => undefined };
    const none = { deliver: async () => { throw new ChannelUnavailable("not set up"); } };
    const broken = { deliver: async () => { throw new Error("apns 500"); } };
    const n = { severity: "important" as const, title: "t", body: "", dedupeKey: "k" };
    await new FanOutNotifier([broken, ok]).deliver(n);
    await assert.rejects(new FanOutNotifier([none, none]).deliver(n), (e) => e instanceof ChannelUnavailable);
    await assert.rejects(new FanOutNotifier([none, broken]).deliver(n), (e) => !(e instanceof ChannelUnavailable) && /apns 500/.test((e as Error).message));
  });
});
