import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventBus } from "../src/sessions/manager.js";
import { CallAudio } from "../src/voice/call-audio.js";
import { TtsUnavailable } from "../src/voice/tts-manager.js";
import type { Call } from "../src/types.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 2000) => { for (let i = 0; i < ms / 10 && !f(); i++) await wait(10); };
const call = (over: Partial<Call>): Call => ({ id: "c1", direction: "incoming", status: "ringing", severity: "important", title: "t", summary: "", script: "Training finished. The loss looks healthy. Want details?", expects: "conversation", createdAt: new Date().toISOString(), ...over }) as Call;

describe("recording what Helix says while the phone rings", () => {
  it("records the whole script, sentence by sentence, into one wav the app can fetch", async () => {
    const bus = new EventBus();
    const spoken: { text: string; style: string }[] = [];
    const ca = new CallAudio(bus, { speak: async (text, style) => { spoken.push({ text, style }); await wait(5); return { pcm: Buffer.alloc(4800), sampleRate: 24000 }; } });
    ca.start();
    bus.publish({ type: "call.ringing", call: call({}) });
    assert.equal(ca.get("c1")?.state, "rendering");
    await until(() => ca.get("c1")?.state === "ready");
    assert.deepEqual(spoken.map((s) => s.text), ["Training finished.", "The loss looks healthy.", "Want details?"]);
    assert.ok(spoken.every((s) => s.style === "normal"));
    const e = ca.get("c1")!;
    assert.equal(e.wav!.toString("ascii", 0, 4), "RIFF");
    assert.ok(e.seconds! > 0.3);
  });

  it("a critical call or an approval is recorded in the serious style", async () => {
    const bus = new EventBus();
    const styles: string[] = [];
    const ca = new CallAudio(bus, { speak: async (_t, style) => { styles.push(style); return { pcm: Buffer.alloc(480), sampleRate: 24000 }; } });
    ca.start();
    bus.publish({ type: "call.ringing", call: call({ id: "a", severity: "critical", script: "Training crashed with a loss of NaN." }) });
    bus.publish({ type: "call.ringing", call: call({ id: "b", expects: "approval", script: "Claude needs your approval to delete the checkpoints." }) });
    await until(() => ca.get("a")?.state === "ready" && ca.get("b")?.state === "ready");
    assert.deepEqual(styles, ["serious", "serious"]);
  });

  it("when the voice cannot speak, the recording is marked failed so the phone falls back to Apple's voice", async () => {
    const bus = new EventBus();
    const ca = new CallAudio(bus, { speak: async () => { throw new TtsUnavailable("gpu_busy", "GPU is busy"); } });
    ca.start();
    bus.publish({ type: "call.ringing", call: call({}) });
    await until(() => ca.get("c1")?.state === "failed");
    assert.equal(ca.get("c1")?.state, "failed");
    assert.match(ca.get("c1")!.reason!, /GPU is busy/);
  });

  it("keeps only the most recent recordings", async () => {
    const bus = new EventBus();
    const ca = new CallAudio(bus, { speak: async () => ({ pcm: Buffer.alloc(480), sampleRate: 24000 }) });
    for (let i = 0; i < 12; i++) await ca.render(`call-${i}`, "Hello there friend.", false);
    assert.equal(ca.get("call-0"), undefined);
    assert.equal(ca.get("call-11")?.state, "ready");
  });
});
