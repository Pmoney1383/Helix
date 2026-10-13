import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { TtsManager, TtsUnavailable, toWslPath, type TtsOptions } from "../src/voice/tts-manager.js";

// These tests use the "fake" engine of the real server script: a quiet tone with no model and no GPU, so the actual
// Chatterbox voice is never started by the test suite.
const HAVE_PYTHON = spawnSync("python", ["--version"], { windowsHide: true }).status === 0;
const t = HAVE_PYTHON ? it : it.skip;
const SCRIPT = path.resolve("tts/helix_tts_server.py");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-tts-"));
const reference = path.join(tmp, "ref.wav");
fs.writeFileSync(reference, "not really audio");

const managers: TtsManager[] = [];
after(async () => {
  await Promise.all(managers.map((m) => m.stop("test over").catch(() => undefined)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

async function mgr(over: Partial<TtsOptions> = {}, deps: ConstructorParameters<typeof TtsManager>[1] = {}): Promise<TtsManager> {
  const m = new TtsManager(
    { enabled: true, engine: "fake", port: await freePort(), idleSec: 30, minFreeVramMb: 6000, minFreeRamMb: 4000, startTimeoutMs: 30_000, ...over },
    { gpuFreeMb: async () => 12_000, freeRamMb: () => 16_000, ...deps }
  );
  managers.push(m);
  return m;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn: () => boolean, ms = 8000) => { const s = Date.now(); while (!fn()) { if (Date.now() - s > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };

describe("the PC voice stays off until it is needed", () => {
  it("building the manager starts nothing, and a disabled one never starts", async () => {
    const m = await mgr({ enabled: false });
    assert.equal(m.pid, undefined);
    assert.equal(m.status().state, "off");
    assert.equal(m.status().enabled, false);
    await assert.rejects(() => m.speak("hello"), (e: unknown) => e instanceof TtsUnavailable && e.reason === "disabled");
    await assert.rejects(() => m.warm(), (e: unknown) => e instanceof TtsUnavailable && e.reason === "disabled");
    assert.equal(m.pid, undefined, "nothing was spawned");
  });

  it("refuses to start while the GPU is busy (training), and says how much is free", async () => {
    const m = await mgr({ engine: "chatterbox", python: "python", reference }, { gpuFreeMb: async () => 3_000 });
    await assert.rejects(() => m.speak("hello"), (e: unknown) => e instanceof TtsUnavailable && e.reason === "gpu_busy" && /3000 MB/.test(e.message));
    assert.equal(m.pid, undefined, "no process was started");
    assert.equal(m.status().state, "off");
  });

  it("refuses when the GPU's free memory cannot be read", async () => {
    const m = await mgr({ engine: "chatterbox", python: "python", reference }, { gpuFreeMb: async () => undefined });
    await assert.rejects(() => m.speak("hello"), (e: unknown) => e instanceof TtsUnavailable && e.reason === "gpu_unknown");
    assert.equal(m.pid, undefined);
  });

  it("refuses when RAM is nearly full, even for the fake engine", async () => {
    const m = await mgr({}, { freeRamMb: () => 500 });
    await assert.rejects(() => m.speak("hello"), (e: unknown) => e instanceof TtsUnavailable && e.reason === "ram_low" && /500 MB/.test(e.message));
    assert.equal(m.pid, undefined);
  });

  it("refuses when it is not configured", async () => {
    const m = await mgr({ engine: "chatterbox", python: undefined, reference: undefined });
    await assert.rejects(() => m.speak("hello"), (e: unknown) => e instanceof TtsUnavailable && e.reason === "not_configured");
    assert.equal(m.pid, undefined);
  });

  it("warm-up checks the guards first and does not start anything when one fails", async () => {
    const m = await mgr({ engine: "chatterbox", python: "python", reference }, { gpuFreeMb: async () => 100 });
    await assert.rejects(() => m.warm(), (e: unknown) => e instanceof TtsUnavailable && e.reason === "gpu_busy");
    assert.equal(m.pid, undefined);
  });
});

describe("the PC voice, started on demand", () => {
  t("the first request starts it; the audio has the right size and rate; later requests reuse the same process", async () => {
    const m = await mgr();
    assert.equal(m.pid, undefined, "off before the first request");
    const a = await m.speak("Hello there friend");                     // 18 characters: the fake engine speaks 0.07 s each
    assert.equal(a.sampleRate, 24000);
    assert.equal(a.pcm.length, Math.floor(24000 * 0.07 * 18) * 2, "16-bit samples");
    const pid = m.pid!;
    assert.ok(pid && alive(pid));
    assert.equal(m.status().state, "running");
    await m.speak("again");
    assert.equal(m.pid, pid, "the same process");
  });

  /** Voice server processes on this PC that were started for this port (a second copy would be a second model on the GPU). */
  const processesOnPort = (port: number): number => {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `@(Get-CimInstance -Query "SELECT CommandLine FROM Win32_Process WHERE Name LIKE 'python%'" | Where-Object { $_.CommandLine -match 'helix_tts_server.py.*--port ${port} ' }).Count`], { encoding: "utf8", windowsHide: true });
    return Number(r.stdout.trim());
  };

  t("many requests at once share ONE process: a second copy would put a second model on the GPU", async () => {
    const port = await freePort();
    const m = await mgr({ port });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => m.speak(`sentence number ${i}`)));
    assert.ok(results.every((r) => r.pcm.length > 0));
    assert.equal(m.spawnCount, 1, "launched exactly once");
    assert.equal(processesOnPort(port), 1, "and exactly one process is really running");
    const pid = m.pid!;
    await m.speak("one more");
    assert.equal(m.pid, pid);
    assert.equal(m.spawnCount, 1);
    await m.stop();
    assert.equal(processesOnPort(port), 0, "nothing left behind");
  });

  t("a warm-up and a request that race each other still start only one process", async () => {
    const port = await freePort();
    const m = await mgr({ port });
    const [status, spoken] = await Promise.all([m.warm(), m.speak("racing the warm-up"), m.speak("and another")]);
    assert.ok(["starting", "running"].includes(status.state), status.state);
    assert.ok(spoken.pcm.length > 0);
    assert.equal(m.spawnCount, 1);
    assert.equal(processesOnPort(port), 1);
    await m.stop();
    assert.equal(processesOnPort(port), 0);
  });

  t("a refused start in a race leaves it off, and a later request can still start it", async () => {
    let ram = 100;
    const m = await mgr({}, { freeRamMb: () => ram });
    const refused = await Promise.allSettled([m.speak("a"), m.speak("b"), m.speak("c")]);
    assert.ok(refused.every((r) => r.status === "rejected" && (r.reason as TtsUnavailable).reason === "ram_low"));
    assert.equal(m.spawnCount, 0);
    assert.equal(m.status().state, "off");
    ram = 16_000;
    assert.ok((await m.speak("now it works")).pcm.length > 0);
    assert.equal(m.spawnCount, 1);
  });

  t("it stops itself when idle, freeing the process, and starts again on the next request", async () => {
    const m = await mgr({ idleSec: 1 });
    await m.speak("wake up");
    const first = m.pid!;
    await waitFor(() => m.status().state === "off", 6000);
    assert.equal(m.pid, undefined);
    assert.ok(!alive(first), "the process is really gone, not just forgotten");
    await m.speak("back again");
    assert.notEqual(m.pid, first, "a fresh process");
    assert.equal(m.status().state, "running");
  });

  t("each request pushes the idle stop back", async () => {
    const m = await mgr({ idleSec: 2 });
    await m.speak("one");
    await new Promise((r) => setTimeout(r, 1300));
    await m.speak("two");                                             // would have been stopped at ~2 s without this
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(m.status().state, "running", "still running 2.6 s after the first request");
    assert.ok((m.status().stopsInSec ?? 99) <= 2);
  });

  t("stop() ends the process for real, and is harmless when already off", async () => {
    const m = await mgr();
    await m.stop();                                                    // nothing to stop
    await m.speak("hi");
    const pid = m.pid!;
    await m.stop("test");
    assert.equal(m.status().state, "off");
    assert.ok(!alive(pid));
    await m.stop();
  });

  t("warm-up returns at once and the voice becomes ready in the background", async () => {
    const m = await mgr();
    const status = await m.warm();
    assert.ok(["starting", "running"].includes(status.state), status.state);
    await waitFor(() => m.status().state === "running");
    const r = await m.speak("ready");
    assert.ok(r.pcm.length > 0);
  });

  t("a process that cannot start gives a clear reason, leaves nothing running, and a retry is allowed", async () => {
    // the real server with the real engine selected but a reference clip that does not exist: it exits before loading anything
    const m = await mgr({ engine: "chatterbox", python: "python", reference: path.join(tmp, "missing.wav") });
    await assert.rejects(() => m.speak("hello"), (e: unknown) => e instanceof TtsUnavailable && e.reason === "start_failed" && /reference voice clip not found/.test(e.message));
    assert.equal(m.pid, undefined);
    assert.equal(m.status().state, "off");
    assert.match(m.status().lastError ?? "", /reference voice clip not found/);
    await assert.rejects(() => m.speak("again"), (e: unknown) => e instanceof TtsUnavailable, "tries again rather than staying stuck");
  });

  t("a missing Python gives a clear reason", async () => {
    const m = await mgr({ python: path.join(tmp, "no-such-python.exe") });
    await assert.rejects(() => m.speak("hello"), (e: unknown) => e instanceof TtsUnavailable && e.reason === "start_failed");
    assert.equal(m.pid, undefined);
  });
});

describe("the server process cannot linger or hog the machine", () => {
  const spawnServer = async (extra: string[] = []): Promise<{ child: ChildProcess; port: number }> => {
    const port = await freePort();
    const child = spawn("python", [SCRIPT, "--engine", "fake", "--port", String(port), ...extra], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { child, port };
  };
  const exited = (child: ChildProcess, ms: number) => new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });

  t("it leaves when its parent goes away (stdin closes), so a crashed gateway cannot leave a model on the GPU", async () => {
    const { child } = await spawnServer();
    assert.equal(child.exitCode, null);
    child.stdin!.end();
    assert.ok(await exited(child, 5000), "exited after stdin closed");
  });

  t("it leaves by itself after the idle time, even if nobody tells it to", async () => {
    const { child } = await spawnServer(["--idle-exit", "2", "--no-parent-watch"]);
    assert.ok(await exited(child, 8000), "exited on its own after 2 s of silence");
  });

  t("POST /shutdown stops it", async () => {
    const { child, port } = await spawnServer(["--no-parent-watch"]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" })).status, 200);
    assert.ok(await exited(child, 5000));
  });

  t("it answers only sensible requests", async () => {
    const { child, port } = await spawnServer(["--no-parent-watch"]);
    try {
      const url = `http://127.0.0.1:${port}`;
      const post = (body: unknown) => fetch(`${url}/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, ready: true, engine: "fake", sampleRate: 24000 });
      assert.equal((await post({ text: "" })).status, 400);
      assert.equal((await post({ text: "x".repeat(601) })).status, 400);
      assert.equal((await post({ text: "hi", style: "shouting" })).status, 400);
      assert.equal((await fetch(`${url}/speak`, { method: "POST", body: "not json" })).status, 400);
      assert.equal((await fetch(`${url}/nope`)).status, 404);
      const ok = await post({ text: "fine", style: "serious" });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("content-type"), "audio/L16");
      assert.equal(ok.headers.get("x-sample-rate"), "24000");
    } finally {
      child.kill();
    }
  });

  t("it listens on this PC only", async () => {
    const { child, port } = await spawnServer(["--no-parent-watch"]);
    try {
      const nics = Object.values(os.networkInterfaces()).flat().filter((n) => n && !n.internal && n.family === "IPv4");
      for (const n of nics.slice(0, 2)) {
        const reachable = await fetch(`http://${n!.address}:${port}/health`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
        assert.equal(reachable, false, `reachable on ${n!.address}`);
      }
    } finally {
      child.kill();
    }
  });
});

describe("streaming speech", () => {
  it("turns a Windows path into the path WSL sees", () => {
    assert.equal(toWslPath("C:\\Users\\me\\Git Projects\\x.py"), "/mnt/c/Users/me/Git Projects/x.py");
    assert.equal(toWslPath("/home/me/qb"), "/home/me/qb");
  });

  it("the streaming engine needs its WSL settings, and only that engine reports that it streams", async () => {
    const m = await mgr({ engine: "qwen3stream" });
    assert.equal(m.status().configured, false);
    assert.equal(m.streams, true);
    assert.equal((await mgr({ engine: "qwen3stream", wsl: { distro: "Ubuntu", python: "/p", qwenRoot: "/r" } })).status().configured, true);
    assert.equal((await mgr()).streams, false);
    await assert.rejects(() => m.stream("hi", "normal", () => undefined), (e: unknown) => e instanceof TtsUnavailable && e.reason === "not_configured");
  });

  t("streams a sentence in whole-sample pieces that add up to the same audio as /speak", async () => {
    const m = await mgr();
    const pieces: Buffer[] = [];
    await m.stream("This is a sentence that is long enough to be sent in a few pieces.", "normal", (pcm, rate) => { assert.equal(rate, 24000); assert.equal(pcm.length % 2, 0); pieces.push(Buffer.from(pcm)); });
    const spoken = await m.speak("This is a sentence that is long enough to be sent in a few pieces.");
    assert.ok(pieces.length >= 1);
    assert.equal(Buffer.concat(pieces).length, spoken.pcm.length);
  });
});
