import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import { FILLERS } from "../src/persona/lines.js";
import { DEFAULT_PET_NAMES, fillPet } from "../src/persona/pet-names.js";
import type { AgentEvent, AgentProvider, SendOptions } from "../src/providers/provider.js";
import { EventBus } from "../src/sessions/manager.js";
import { openDb } from "../src/storage/sqlite.js";
import type { GatewayEvent } from "../src/types.js";
import { TtsPipeline, type Synthesizer } from "../src/voice/tts-pipeline.js";
import { TtsUnavailable, type TtsStyle } from "../src/voice/tts-manager.js";

const until = async (fn: () => boolean, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const speech = (text: string, seq: number, extra: object = {}): GatewayEvent => ({ type: "agent.speech", sessionId: "s1", turnId: "t1", seq, text, engine: "pc", ...extra } as GatewayEvent);
const endEvent = (cancelled = false, turnId = "t1"): GatewayEvent => ({ type: "agent.speech.end", sessionId: "s1", turnId, cancelled });

/** A synthesizer whose speed we control per sentence, and which records what it was asked. */
class FakeSynth implements Synthesizer {
  calls: { text: string; style: TtsStyle }[] = [];
  delays: Record<string, number> = {};
  fail?: TtsUnavailable;
  async speak(text: string, style: TtsStyle) {
    this.calls.push({ text, style });
    await new Promise((r) => setTimeout(r, this.delays[text] ?? 0));
    if (this.fail) throw this.fail;
    return { pcm: Buffer.from(text), sampleRate: 24000 };
  }
}

describe("the PC voice pipeline", () => {
  const rig = () => {
    const bus = new EventBus();
    const synth = new FakeSynth();
    const events: GatewayEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const stop = new TtsPipeline(bus, synth).start();
    const audio = () => events.filter((e): e is Extract<GatewayEvent, { type: "agent.audio" }> => e.type === "agent.audio");
    return { bus, synth, events, audio, stop };
  };

  it("turns each spoken sentence into audio, in order, and says when the turn's audio is finished", async () => {
    const { bus, events, audio } = rig();
    bus.publish(speech("First sentence.", 0));
    bus.publish(speech("Second sentence.", 1));
    bus.publish(endEvent());
    await until(() => events.some((e) => e.type === "agent.audio.end"));
    assert.deepEqual(audio().map((a) => a.seq), [0, 1]);
    assert.deepEqual(audio().map((a) => Buffer.from(a.data, "base64").toString()), ["First sentence.", "Second sentence."]);
    assert.ok(audio().every((a) => a.sampleRate === 24000 && a.format === "pcm_s16le" && a.sessionId === "s1" && a.turnId === "t1"));
    assert.equal(events.filter((e) => e.type === "agent.audio.end").length, 1);
    assert.equal(events.at(-1)!.type, "agent.audio.end", "the end comes after the last audio");
  });

  it("keeps the order even when a later sentence would finish first", async () => {
    const { bus, synth, events, audio } = rig();
    synth.delays = { "Slow one.": 120 };
    bus.publish(speech("Slow one.", 0));
    bus.publish(speech("Quick one.", 1));
    bus.publish(endEvent());
    await until(() => events.some((e) => e.type === "agent.audio.end"));
    assert.deepEqual(audio().map((a) => a.seq), [0, 1]);
  });

  it("starts speaking before the turn has ended", async () => {
    const { bus, events, audio } = rig();
    bus.publish(speech("Early sentence.", 0));
    await until(() => audio().length === 1);
    assert.ok(!events.some((e) => e.type === "agent.speech.end"), "the turn is still going when the first audio is out");
    bus.publish(endEvent());
    await until(() => events.some((e) => e.type === "agent.audio.end"));
  });

  it("does nothing for turns that did not ask for the PC voice", async () => {
    const { bus, synth, events } = rig();
    bus.publish({ type: "agent.speech", sessionId: "s1", turnId: "t1", seq: 0, text: "Apple will say this." });
    bus.publish(endEvent());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(synth.calls.length, 0, "the voice was never touched");
    assert.ok(!events.some((e) => e.type.startsWith("agent.audio")));
  });

  it("passes the style through: serious moments use the calm voice", async () => {
    const { bus, synth, events } = rig();
    bus.publish(speech("Calm please.", 0, { style: "serious" }));
    bus.publish(speech("Normal one.", 1, { style: "normal" }));
    bus.publish(speech("Unspecified.", 2));
    bus.publish(endEvent());
    await until(() => events.some((e) => e.type === "agent.audio.end"));
    assert.deepEqual(synth.calls.map((c) => c.style), ["serious", "normal", "normal"]);
  });

  it("an interrupted turn drops what is still queued and never says it finished", async () => {
    const { bus, synth, events, audio } = rig();
    synth.delays = { "One.": 80 };
    bus.publish(speech("One.", 0));
    bus.publish(speech("Two.", 1));
    bus.publish(speech("Three.", 2));
    await new Promise((r) => setTimeout(r, 25));       // the first sentence is being made now
    bus.publish(endEvent(true));                       // interrupted while it is still in flight
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(audio().map((a) => a.seq), [], "not even the one in flight is delivered after the interrupt");
    assert.deepEqual(synth.calls.map((c) => c.text), ["One."], "the others were never synthesized");
    assert.ok(!events.some((e) => e.type === "agent.audio.end"));
  });

  it("an interrupt that arrives before anything started means nothing is synthesized at all", async () => {
    const { bus, synth, events } = rig();
    bus.publish(speech("One.", 0));
    bus.publish(speech("Two.", 1));
    bus.publish(endEvent(true));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(synth.calls.length, 0);
    assert.ok(!events.some((e) => e.type === "agent.audio" || e.type === "agent.audio.end"));
  });

  it("when the voice is unavailable it says so once, skips the rest, and the text is still there to speak", async () => {
    const { bus, synth, events } = rig();
    synth.fail = new TtsUnavailable("gpu_busy", "Not starting the PC voice: only 3000 MB of GPU memory is free.");
    bus.publish(speech("Sentence one.", 0));
    bus.publish(speech("Sentence two.", 1));
    bus.publish(speech("Sentence three.", 2));
    bus.publish(endEvent());
    await new Promise((r) => setTimeout(r, 150));
    const unavailable = events.filter((e) => e.type === "agent.audio.unavailable") as Extract<GatewayEvent, { type: "agent.audio.unavailable" }>[];
    assert.equal(unavailable.length, 1, "told once per turn, not once per sentence");
    assert.equal(unavailable[0]!.reason, "gpu_busy");
    assert.match(unavailable[0]!.message, /3000 MB/);
    assert.equal(synth.calls.length, 1, "it did not keep trying every sentence");
    assert.ok(!events.some((e) => e.type === "agent.audio" || e.type === "agent.audio.end"));
    assert.equal(events.filter((e) => e.type === "agent.speech").length, 3, "the sentences themselves were already sent for the phone to speak");
  });

  it("an unexpected error is reported the same way, as a failed speech", async () => {
    const { bus, events } = rig();
    const boom = { speak: async () => { throw new Error("kaboom"); } };
    new TtsPipeline(bus, boom as Synthesizer).start();
    bus.publish(speech("Hi.", 0, { turnId: "tx" }));
    await until(() => events.some((e) => e.type === "agent.audio.unavailable"));
    const u = events.find((e) => e.type === "agent.audio.unavailable") as Extract<GatewayEvent, { type: "agent.audio.unavailable" }>;
    assert.equal(u.reason, "speech_failed");
  });

  it("turns are independent, and nothing is remembered once a turn is over", async () => {
    const { bus, synth, events, audio } = rig();
    bus.publish(speech("A one.", 0, { turnId: "tA" }));
    bus.publish(speech("B one.", 0, { turnId: "tB" }));
    bus.publish({ type: "agent.speech.end", sessionId: "s1", turnId: "tA", cancelled: true });
    bus.publish({ type: "agent.speech.end", sessionId: "s1", turnId: "tB", cancelled: false });
    await until(() => events.some((e) => e.type === "agent.audio.end" && e.turnId === "tB"));
    assert.ok(!audio().some((a) => a.turnId === "tA"), "turn A was interrupted");
    assert.ok(audio().some((a) => a.turnId === "tB"));
    assert.ok(synth.calls.length >= 1);
    assert.equal(((new TtsPipeline(bus, synth) as unknown) as { turns: Map<string, unknown> }).turns.size, 0);
  });

  it("stops listening when asked", async () => {
    const { bus, synth, stop } = rig();
    stop();
    bus.publish(speech("Nobody hears this.", 0));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(synth.calls.length, 0);
  });
});

/* ------------------------------------------------------------------------------------------------------------ */

/** An agent that streams the given text in small pieces. */
class Scripted implements AgentProvider {
  readonly name = "claude" as const;
  text = "First sentence is here. Second sentence follows. Third one closes it.";
  async createSession() { return { providerSessionId: crypto.randomUUID() }; }
  async *send(o: SendOptions): AsyncGenerator<AgentEvent> {
    let full = "";
    for (const piece of this.text.match(/[\s\S]{1,9}/g) ?? []) {
      if (o.signal.aborted) return;
      full += piece;
      yield { type: "delta", text: piece };
      await new Promise((r) => setTimeout(r, 4));
    }
    yield { type: "final", text: full };
  }
}

describe("through the gateway", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-tts-gw-"));
  const agent = new Scripted();
  let gw: Gateway;
  let base: string;
  let token: string;
  let events: GatewayEvent[] = [];
  let synthCalls: { text: string; style: string }[] = [];

  const api = async (method: string, p: string, body?: unknown, auth = true) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any, headers: r.headers };
  };
  const newSession = async () => (await api("POST", "/v1/sessions", { title: "voice", projectPath: os.tmpdir() })).json.id as string;
  const settle = async (id: string) => { while (gw.manager.isRunning(id)) await new Promise((r) => setTimeout(r, 10)); await new Promise((r) => setTimeout(r, 20)); };
  const ofType = <T extends GatewayEvent["type"]>(type: T) => events.filter((e): e is Extract<GatewayEvent, { type: T }> => e.type === type);

  const boot = async (tts: Parameters<typeof buildGateway>[0]["tts"]) => {
    const g = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", tts }, openDb(":memory:"), { claude: agent });
    await g.app.listen({ host: "127.0.0.1", port: 0 });
    const b = `http://127.0.0.1:${(g.app.server.address() as { port: number }).port}`;
    const { code } = g.auth.createPairingCode();
    const t = ((await (await fetch(b + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
    return { g, b, t };
  };

  const FLIRTY_FILLERS = FILLERS.flirty.flatMap((l) => DEFAULT_PET_NAMES.map((p) => fillPet(l, p)));
  const clipsDir = path.join(tmp, "clips");

  before(async () => {
    fs.mkdirSync(clipsDir);
    const manifest = [...new Set([...FLIRTY_FILLERS])].map((text, i) => ({ id: `flirty-filler-${i}`, kind: "filler", text, voice: "flirty", seconds: 2.5, file: `flirty-filler-${i}.wav` }));
    manifest.push({ id: "plain-filler-1", kind: "filler", text: "One moment.", voice: "plain", seconds: 1.4, file: "plain-filler-1.wav" });
    manifest.push({ id: "evil", kind: "x", text: "evil", voice: "x", seconds: 1, file: "..\\..\\secret.txt" }); // a manifest entry that tries to leave the folder
    for (const m of manifest) if (m.id !== "evil") fs.writeFileSync(path.join(clipsDir, m.file), `RIFFfake-${m.id}`);
    fs.writeFileSync(path.join(tmp, "secret.txt"), "TOP SECRET");
    fs.writeFileSync(path.join(clipsDir, "manifest.json"), JSON.stringify(manifest));

    const r = await boot({ enabled: false, engine: "fake", port: 7791, idleSec: 60, minFreeVramMb: 6000, minFreeRamMb: 4000, clipsDir });
    gw = r.g; base = r.b; token = r.t;
    gw.manager.bus.subscribe((e) => events.push(e));
    // stand in for the voice: record what it is asked and return deterministic audio, without any process
    (gw.tts as any).speak = async (text: string, style: string) => { synthCalls.push({ text, style }); return { pcm: Buffer.from(`pcm:${text}`), sampleRate: 24000 }; };
  });
  after(async () => { await gw.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("a voice message that asks for the PC voice gets audio per sentence, then the end", async () => {
    events = []; synthCalls = [];
    const id = await newSession();
    await api("POST", `/v1/sessions/${id}/message`, { text: "hi", voice: true, engine: "pc" });
    await until(() => ofType("agent.audio.end").length === 1);
    assert.deepEqual(ofType("agent.speech").map((e) => e.text), ["First sentence is here.", "Second sentence follows.", "Third one closes it."]);
    assert.ok(ofType("agent.speech").every((e) => e.engine === "pc" && e.style === "normal"));
    assert.deepEqual(ofType("agent.audio").map((e) => e.seq), [0, 1, 2]);
    assert.deepEqual(ofType("agent.audio").map((e) => Buffer.from(e.data, "base64").toString()), ["pcm:First sentence is here.", "pcm:Second sentence follows.", "pcm:Third one closes it."]);
    assert.ok(ofType("agent.speech.end").length === 1 && ofType("agent.speech.end")[0]!.cancelled === false);
  });

  it("a serious message uses the calm voice style", async () => {
    events = []; synthCalls = [];
    const id = await newSession();
    await api("POST", `/v1/sessions/${id}/message`, { text: "it crashed", voice: true, engine: "pc", voiceSeverity: "critical" });
    await until(() => ofType("agent.audio.end").length === 1);
    assert.ok(synthCalls.length === 3 && synthCalls.every((c) => c.style === "serious"), JSON.stringify(synthCalls));
  });

  it("without engine: pc (the default) the phone speaks and the PC voice is never touched", async () => {
    events = []; synthCalls = [];
    const id = await newSession();
    await api("POST", `/v1/sessions/${id}/message`, { text: "hi", voice: true });
    await settle(id);
    assert.equal(ofType("agent.speech").length, 3);
    assert.ok(ofType("agent.speech").every((e) => e.engine === undefined));
    assert.equal(synthCalls.length, 0);
    assert.equal(ofType("agent.audio").length + ofType("agent.audio.end").length, 0);
    const typed = await newSession();
    await api("POST", `/v1/sessions/${typed}/message`, { text: "hi", engine: "pc" });   // typed, not spoken: engine is ignored
    await settle(typed);
    assert.equal(synthCalls.length, 0);
  });

  it("an interrupt stops the audio, and nothing claims the turn finished", async () => {
    events = []; synthCalls = [];
    agent.text = "A long first sentence goes here now. ".repeat(60);
    const id = await newSession();
    await api("POST", `/v1/sessions/${id}/message`, { text: "talk", voice: true, engine: "pc" });
    await until(() => ofType("agent.speech").length >= 2);
    await api("POST", `/v1/sessions/${id}/interrupt`);
    await settle(id);
    await new Promise((r) => setTimeout(r, 100));
    const before = ofType("agent.audio").length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ofType("agent.audio").length, before, "no more audio after the interrupt");
    assert.equal(ofType("agent.speech.end")[0]!.cancelled, true);
    assert.equal(ofType("agent.audio.end").length, 0);
    agent.text = "First sentence is here. Second sentence follows. Third one closes it.";
  });

  it("the same works over the websocket", async () => {
    events = []; synthCalls = [];
    const id = await newSession();
    const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
    const got: any[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "send", sessionId: id, text: "hi", voice: true, engine: "pc" }));
    await until(() => got.some((m) => m.type === "agent.audio.end"));
    assert.deepEqual(got.filter((m) => m.type === "agent.audio").map((m) => m.seq), [0, 1, 2]);
    assert.ok(typeof got.find((m) => m.type === "agent.audio").data === "string");
    ws.close();
  });

  it("a route (Claude or Astra) honours it too", async () => {
    events = []; synthCalls = [];
    const route = (await api("POST", "/v1/routes", {})).json;
    await api("POST", `/v1/routes/${route.id}/message`, { text: "hi", voice: true, engine: "pc" });
    await until(() => ofType("agent.audio.end").length === 1);
    assert.equal(ofType("agent.audio").length, 3);
  });

  it("with the PC voice off, the phone is told to speak the text itself, once", async () => {
    // the gateway above has it disabled; use the real (unpatched) manager for this one
    const r = await boot({ enabled: false, engine: "fake", port: 7792, idleSec: 60, minFreeVramMb: 6000, minFreeRamMb: 4000 });
    const seen: GatewayEvent[] = [];
    r.g.manager.bus.subscribe((e) => seen.push(e));
    const s = ((await (await fetch(r.b + "/v1/sessions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${r.t}` }, body: JSON.stringify({ title: "x", projectPath: os.tmpdir() }) })).json()) as any).id;
    await fetch(`${r.b}/v1/sessions/${s}/message`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${r.t}` }, body: JSON.stringify({ text: "hi", voice: true, engine: "pc" }) });
    await until(() => seen.some((e) => e.type === "agent.audio.unavailable"));
    await new Promise((res) => setTimeout(res, 100));
    const u = seen.filter((e) => e.type === "agent.audio.unavailable") as Extract<GatewayEvent, { type: "agent.audio.unavailable" }>[];
    assert.equal(u.length, 1);
    assert.equal(u[0]!.reason, "disabled");
    assert.equal(seen.filter((e) => e.type === "agent.speech").length, 3, "the sentences are there to speak");
    assert.ok(!seen.some((e) => e.type === "agent.audio"));
    assert.equal(r.g.tts.pid, undefined, "nothing was started");
    await r.g.app.close();
  });

  it("filler: the line comes with its pre-recorded clip when one exists, and the serious line too", async () => {
    await api("PUT", "/v1/persona", { mode: "flirty" });
    for (let i = 0; i < 12; i++) {
      const f = (await api("GET", "/v1/voice/filler")).json;
      assert.ok(FLIRTY_FILLERS.includes(f.text), f.text);
      assert.ok(f.clip, `no clip for: ${f.text}`);
      assert.equal(f.clip.url, `/v1/voice/clips/${f.clip.id}`);
    }
    const serious = (await api("GET", "/v1/voice/filler?severity=critical")).json;
    assert.ok(!FLIRTY_FILLERS.includes(serious.text));
    // no clip for a line nobody recorded: the response just has the text
    const none = (await api("GET", "/v1/voice/filler?severity=high")).json;
    assert.equal(typeof none.text, "string");
  });

  it("clips: listed without file names, served as wav, and nothing outside the manifest can be fetched", async () => {
    const list = (await api("GET", "/v1/voice/clips")).json.clips as any[];
    assert.ok(list.length > 5 && list.every((c) => c.id && c.text && !("file" in c)));
    assert.ok(!list.some((c) => c.id === "evil"), "a manifest entry pointing outside the folder is ignored");
    const first = await fetch(`${base}/v1/voice/clips/plain-filler-1`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "audio/wav");
    assert.equal(await first.text(), "RIFFfake-plain-filler-1");
    for (const id of ["evil", "nope", "..%2F..%2Fsecret.txt", "%2e%2e%2fsecret", "C%3A%5Cwindows%5Cwin.ini", "plain-filler-1%00", "PLAIN-FILLER-1"]) {
      const r = await fetch(`${base}/v1/voice/clips/${id}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(r.status, 404, id);
      assert.doesNotMatch(await r.text(), /TOP SECRET/);
    }
    assert.equal((await fetch(`${base}/v1/voice/clips`)).status, 401);
    assert.equal((await fetch(`${base}/v1/voice/clips/plain-filler-1`)).status, 401);
  });
});

describe("smooth playback (hold the first audio until the rest keeps up)", () => {
  /** 1 s of audio per call, generated in `genMs`. */
  class TimedSynth implements Synthesizer {
    constructor(private genMs: number) {}
    async speak() { await new Promise((r) => setTimeout(r, this.genMs)); return { pcm: Buffer.alloc(48000), sampleRate: 24000 }; }
  }
  const run = (genMs: number, opts: { maxHoldMs: number }) => {
    const bus = new EventBus();
    const events: GatewayEvent[] = [];
    bus.subscribe((e) => events.push(e));
    new TtsPipeline(bus, new TimedSynth(genMs), undefined, { ...opts, charsPerSec: 14 }).start();
    return { bus, events, audio: () => events.filter((e) => e.type === "agent.audio") };
  };
  const sentence = (n: number) => "x".repeat(14) + n; // about one second of speech

  it("holds the first sentence while later ones are still being generated, then plays them together", async () => {
    const { bus, events, audio } = run(60, { maxHoldMs: 5000 });
    for (let i = 0; i < 3; i++) bus.publish(speech(sentence(i), i));
    bus.publish(endEvent());
    await new Promise((r) => setTimeout(r, 80)); // the first one is generated, the other two are not
    assert.equal(audio().length, 0, "nothing is sent while the rest would still run dry");
    await until(() => events.some((e) => e.type === "agent.audio.end"));
    assert.deepEqual(audio().map((a) => (a as { seq: number }).seq), [0, 1, 2]);
  });

  it("stops holding after the longest allowed wait", async () => {
    const { bus, audio } = run(60, { maxHoldMs: 50 });
    for (let i = 0; i < 3; i++) bus.publish(speech(sentence(i), i));
    await until(() => audio().length >= 1);
    assert.equal(audio().length >= 1, true);
  });

  it("sends a single sentence at once", async () => {
    const { bus, audio } = run(20, { maxHoldMs: 5000 });
    bus.publish(speech(sentence(0), 0));
    await until(() => audio().length === 1);
  });

  it("with holding off (0) every sentence goes out as it is ready", async () => {
    const { bus, audio } = run(40, { maxHoldMs: 0 });
    for (let i = 0; i < 2; i++) bus.publish(speech(sentence(i), i));
    await until(() => audio().length === 1);
    assert.equal(audio().length, 1);
  });
});

describe("streaming voice", () => {
  class StreamSynth implements Synthesizer {
    async speak() { return { pcm: Buffer.alloc(4), sampleRate: 24000 }; }
    async stream(text: string, _style: TtsStyle, onChunk: (pcm: Buffer, rate: number) => void) {
      for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 5)); onChunk(Buffer.from(`${text}#${i}`), 24000); }
    }
  }
  it("forwards each piece at once as it arrives, numbered per sentence, with nothing held back", async () => {
    const bus = new EventBus();
    const events: GatewayEvent[] = [];
    bus.subscribe((e) => events.push(e));
    new TtsPipeline(bus, new StreamSynth(), undefined, { maxHoldMs: 5000 }, true).start();
    bus.publish(speech("A", 0));
    bus.publish(speech("B", 1));
    bus.publish(endEvent());
    await until(() => events.some((e) => e.type === "agent.audio.end"));
    const audio = events.filter((e): e is Extract<GatewayEvent, { type: "agent.audio" }> => e.type === "agent.audio");
    assert.deepEqual(audio.map((a) => [a.seq, a.part]), [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
    assert.deepEqual(audio.map((a) => Buffer.from(a.data, "base64").toString()), ["A#0", "A#1", "A#2", "B#0", "B#1", "B#2"]);
    assert.equal(events.at(-1)!.type, "agent.audio.end");
  });
});
