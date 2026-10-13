import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipPlan, pcmToWav } from "../src/voice/clip-maker.js";
import { FILLERS } from "../src/persona/lines.js";

describe("planning the canned-line clips", () => {
  const plan = clipPlan(["gorgeous", "babe"]);

  it("covers the flirty greetings and fillers, one clip per pet name, plus the plain fillers", () => {
    const texts = plan.map((p) => p.text);
    assert.ok(texts.includes("Hey gorgeous. What are we getting into today?"));
    assert.ok(texts.includes("Hey babe. What are we getting into today?"));
    assert.ok(texts.includes("Mmm... let me check."));
    for (const f of FILLERS.professional) assert.ok(plan.some((p) => p.voice === "plain" && p.text === f), f);
    assert.ok(plan.every((p) => !p.text.includes("{pet}")), "no unfilled token reaches the voice");
  });

  it("ids are safe file names and unique, and no text is recorded twice", () => {
    const ids = plan.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(id)), ids.join(","));
    const texts = plan.map((p) => p.text.toLowerCase());
    assert.equal(new Set(texts).size, texts.length);
  });
});

describe("wav files", () => {
  it("wraps raw pcm with a correct 44 byte header", () => {
    const wav = pcmToWav(Buffer.alloc(480), 24000);
    assert.equal(wav.length, 44 + 480);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(4), 36 + 480);
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt32LE(40), 480);
  });
});
