import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

// The "fake" engine of the real server script: a quiet tone, no model, no GPU.
const HAVE_PYTHON = spawnSync("python", ["--version"], { windowsHide: true }).status === 0;
const t = HAVE_PYTHON ? it : it.skip;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn: () => boolean, ms = 8000) => { const s = Date.now(); while (!fn()) { if (Date.now() - s > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };

interface Rig { gw: Gateway; api: (m: string, p: string, body?: unknown, auth?: boolean) => Promise<{ status: number; json: any; headers: Headers; bytes: Buffer }>; close: () => Promise<void> }

async function rig(tts: { enabled: boolean; minFreeRamMb?: number }): Promise<Rig> {
  const gw = await buildGateway(
    { defaultProjectPath: os.tmpdir(), logLevel: "silent", tts: { enabled: tts.enabled, engine: "fake", port: await freePort(), idleSec: 60, minFreeVramMb: 6000, minFreeRamMb: tts.minFreeRamMb ?? 0 } },
    openDb(":memory:"), { claude: new FakeProvider() }
  );
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  const { code } = gw.auth.createPairingCode();
  const token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  const api: Rig["api"] = async (method, p, body, auth = true) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = Buffer.from(await r.arrayBuffer());
    let json: any = {};
    try { json = JSON.parse(bytes.toString("utf8")); } catch { /* binary */ }
    return { status: r.status, json, headers: r.headers, bytes };
  };
  return { gw, api, close: () => gw.app.close() };
}

describe("the PC voice API", () => {
  it("every endpoint needs a paired device", async () => {
    const r = await rig({ enabled: false });
    for (const [m, p] of [["GET", "/v1/voice/tts/status"], ["POST", "/v1/voice/tts/warm"], ["POST", "/v1/voice/tts/stop"], ["POST", "/v1/voice/speak"]] as const) {
      assert.equal((await r.api(m, p, m === "POST" ? {} : undefined, false)).status, 401, `${m} ${p}`);
    }
    await r.close();
  });

  it("building the gateway starts nothing: the voice is off until something needs it", async () => {
    const r = await rig({ enabled: true });
    assert.equal(r.gw.tts.pid, undefined);
    const s = (await r.api("GET", "/v1/voice/tts/status")).json;
    assert.deepEqual([s.enabled, s.configured, s.state, s.engine], [true, true, "off", "fake"]);
    await r.close();
  });

  it("turned off: speaking is a clear 503 with a reason, warming is a 409, and nothing is ever started", async () => {
    const r = await rig({ enabled: false });
    const speak = await r.api("POST", "/v1/voice/speak", { text: "hello" });
    assert.equal(speak.status, 503);
    assert.equal(speak.json.reason, "disabled");
    assert.match(speak.json.error, /turned off/);
    const warm = await r.api("POST", "/v1/voice/tts/warm");
    assert.equal(warm.status, 409);
    assert.equal(warm.json.reason, "disabled");
    assert.equal(r.gw.tts.pid, undefined);
    await r.close();
  });

  it("validates what it is asked to say, and is rate limited", async () => {
    const r = await rig({ enabled: false });
    assert.equal((await r.api("POST", "/v1/voice/speak", { text: "" })).status, 400);
    assert.equal((await r.api("POST", "/v1/voice/speak", { text: "x".repeat(601) })).status, 400);
    assert.equal((await r.api("POST", "/v1/voice/speak", { text: "hi", style: "shouting" })).status, 400);
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push((await r.api("POST", "/v1/voice/speak", { text: "hi" })).status);
    assert.ok(statuses.includes(429), "too many requests are turned away before they can reach the GPU");
    await r.close();
  });

  it("refuses to warm up when RAM is short, without starting anything", async () => {
    const r = await rig({ enabled: true, minFreeRamMb: 1_000_000 });
    const warm = await r.api("POST", "/v1/voice/tts/warm");
    assert.equal(warm.status, 409);
    assert.equal(warm.json.reason, "ram_low");
    const speak = await r.api("POST", "/v1/voice/speak", { text: "hello" });
    assert.equal(speak.status, 503);
    assert.equal(speak.json.reason, "ram_low");
    assert.equal(r.gw.tts.pid, undefined);
    await r.close();
  });

  t("speak starts it on demand and returns raw 16-bit audio; stop frees it; closing the gateway stops it too", async () => {
    const r = await rig({ enabled: true });
    const res = await r.api("POST", "/v1/voice/speak", { text: "Hello there friend" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/L16");
    assert.equal(res.headers.get("x-sample-rate"), "24000");
    assert.equal(res.bytes.length, Math.floor(24000 * 0.07 * 18) * 2);
    const pid = r.gw.tts.pid!;
    assert.ok(alive(pid));
    assert.equal((await r.api("GET", "/v1/voice/tts/status")).json.state, "running");

    const stopped = (await r.api("POST", "/v1/voice/tts/stop")).json;
    assert.equal(stopped.state, "off");
    assert.ok(!alive(pid), "the process is gone");

    await r.api("POST", "/v1/voice/speak", { text: "again", style: "serious" });
    const pid2 = r.gw.tts.pid!;
    assert.ok(pid2 && pid2 !== pid && alive(pid2));
    await r.close();                                                    // the gateway shuts down...
    await waitFor(() => !alive(pid2));                                  // ...and takes the voice with it
  });

  t("warm returns at once and the voice is ready by the time it is needed", async () => {
    const r = await rig({ enabled: true });
    const warm = await r.api("POST", "/v1/voice/tts/warm");
    assert.equal(warm.status, 202);
    assert.ok(["starting", "running"].includes(warm.json.state), warm.json.state);
    await waitFor(() => r.gw.tts.status().state === "running");
    assert.equal((await r.api("POST", "/v1/voice/speak", { text: "ready" })).status, 200);
    await r.close();
  });
});

describe("the PC status endpoint for the app's status screen", () => {
  it("needs a paired device and returns the PC and GPU readings together", async () => {
    const r = await rig({ enabled: false });
    try {
      assert.equal((await r.api("GET", "/v1/pc/status", undefined, false)).status, 401);
      const res = await r.api("GET", "/v1/pc/status");
      assert.equal(res.status, 200);
      assert.equal(typeof res.json.pc.hostname, "string");
      assert.ok(Array.isArray(res.json.pc.disks));
      assert.equal(typeof res.json.gpu.available, "boolean");
    } finally { await r.close(); }
  });
});
