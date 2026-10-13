import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { after, describe, it } from "node:test";
import { AwayWarmer, type WarmTarget } from "../src/voice/away-warmer.js";
import { TtsManager, TtsUnavailable, type TtsStatus } from "../src/voice/tts-manager.js";

const status = (over: Partial<TtsStatus> = {}): TtsStatus => ({ enabled: true, configured: true, engine: "qwen3stream", state: "off", ...over });

class FakeTarget implements WarmTarget {
  calls: string[] = [];
  st: TtsStatus = status();
  refuse?: TtsUnavailable;
  status() { return this.st; }
  async warm() { this.calls.push("warm"); if (this.refuse) throw this.refuse; this.st = status({ state: "running" }); return this.st; }
  async keepLoaded() { this.calls.push("keep"); }
  async stop(reason?: string) { this.calls.push(`stop:${reason}`); this.st = status(); }
}

const rig = (over: { away?: boolean; free?: number | undefined } = {}) => {
  const target = new FakeTarget();
  const state = { away: over.away ?? true, free: "free" in over ? over.free : 12_000 };
  const warmer = new AwayWarmer(target, { isAway: () => state.away, gpuFreeMb: async () => state.free, now: () => Date.parse("2026-10-09T12:00:00Z") });
  return { target, state, warmer };
};

describe("keeping the voice warm while the user is away", () => {
  it("warms an unloaded voice when the user is away", async () => {
    const { target, warmer } = rig();
    assert.equal(await warmer.tick(), "warmed");
    assert.deepEqual(target.calls, ["warm"]);
  });

  it("does nothing while the user is at the PC", async () => {
    const { target, warmer } = rig({ away: false });
    assert.equal(await warmer.tick(), "skipped");
    assert.deepEqual(target.calls, []);
  });

  it("stays off when a guard says the GPU or RAM is busy (the image trainer)", async () => {
    const { target, warmer } = rig();
    target.refuse = new TtsUnavailable("gpu_busy", "busy");
    assert.equal(await warmer.tick(), "skipped");
    assert.equal(target.st.state, "off");
  });

  it("does nothing when the voice is off or not configured", async () => {
    const { target, warmer } = rig();
    target.st = status({ enabled: false });
    assert.equal(await warmer.tick(), "skipped");
    target.st = status({ configured: false });
    assert.equal(await warmer.tick(), "skipped");
    assert.deepEqual(target.calls, []);
  });

  it("keeps a loaded voice loaded while away, but lets the normal idle timer run when the user is at the PC", async () => {
    const { target, state, warmer } = rig();
    target.st = status({ state: "running", lastUsedAt: "2026-10-09T11:59:50Z" });
    assert.equal(await warmer.tick(), "kept");
    state.away = false;
    assert.equal(await warmer.tick(), "skipped");
    assert.deepEqual(target.calls, ["keep"]);
  });

  it("unloads an unused voice when something else is squeezing the GPU, but never one in use", async () => {
    const { target, state, warmer } = rig();
    state.free = 800;
    target.st = status({ state: "running", lastUsedAt: "2026-10-09T11:59:55Z" }); // used 5 s ago: a call is on
    assert.equal(await warmer.tick(), "kept");
    target.st = status({ state: "running", lastUsedAt: "2026-10-09T11:50:00Z" }); // unused for 10 min
    assert.equal(await warmer.tick(), "yielded");
    assert.equal(target.st.state, "off");
    assert.equal(await warmer.tick(), "warmed", "it tries again later; the manager's own guard refuses while the GPU is busy");
  });

  it("an unknown free-memory reading never unloads the voice", async () => {
    const { target, warmer } = rig({ free: undefined });
    target.st = status({ state: "running", lastUsedAt: "2026-10-09T10:00:00Z" });
    assert.equal(await warmer.tick(), "kept");
  });
});

const HAVE_PYTHON = spawnSync("python", ["--version"], { windowsHide: true }).status === 0;
const managers: TtsManager[] = [];
after(async () => { await Promise.all(managers.map((m) => m.stop("test over").catch(() => undefined))); });
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

describe("TtsManager.keepLoaded", () => {
  (HAVE_PYTHON ? it : it.skip)("pushes the idle stop back without counting as a use", async () => {
    const m = new TtsManager(
      { enabled: true, engine: "fake", port: await freePort(), idleSec: 30, minFreeVramMb: 6000, minFreeRamMb: 4000, startTimeoutMs: 30_000, script: path.resolve("tts/helix_tts_server.py") },
      { gpuFreeMb: async () => 12_000, freeRamMb: () => 16_000 }
    );
    managers.push(m);
    await m.keepLoaded(); // not running: harmless
    assert.equal(m.status().state, "off");
    await m.speak("hello there");
    const used = m.status().lastUsedAt;
    await new Promise((r) => setTimeout(r, 1200));
    const before = m.status().stopsInSec!;
    await m.keepLoaded();
    assert.equal(m.status().lastUsedAt, used, "a keep-alive is not a use");
    assert.ok(m.status().stopsInSec! >= before, "the idle clock restarted");
  });
});
