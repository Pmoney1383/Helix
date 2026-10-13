import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";
import { limitSpoken } from "../src/voice/speech.js";
import { voiceOptions } from "../src/voice/voice-opts.js";
import type { GatewayEvent } from "../src/types.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => { for (let i = 0; i < ms / 20 && !f(); i++) await wait(20); };
const SIX = "One thing is done. Two things are running. Three things are queued. Four things are old. Five things are new. Six things are left.";

describe("how replies sound on a live call", () => {
  let gw: Gateway, root: string, provider: FakeProvider;
  const events: GatewayEvent[] = [];

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-callvoice-"));
    provider = new FakeProvider();
    // The PC voice is "on" but its python does not exist, so nothing is ever synthesized: only the signalling is under test.
    gw = await buildGateway({
      defaultProjectPath: os.tmpdir(), logLevel: "silent", routerHome: path.join(root, "router"),
      tts: { enabled: true, engine: "fake", python: "no-such-python-for-test", port: 7788, idleSec: 10, minFreeVramMb: 0, minFreeRamMb: 0 },
    }, openDb(":memory:"), { claude: provider });
    gw.manager.bus.subscribe((e) => events.push(e));
    gw.persona.update({ mode: "flirty" }); // the default is professional; flirty is the mode with the most to strip from sessions
  });
  after(async () => { await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const lastStyle = () => provider.calls.at(-1)!.voiceStyle ?? "";
  const speechOf = (sessionId: string) => events.filter((e) => e.type === "agent.speech" && e.sessionId === sessionId) as Extract<GatewayEvent, { type: "agent.speech" }>[];

  it("the front door is Helix: the user's persona (here flirty), Helix's own voice, and no more than three spoken sentences", async () => {
    gw.router.inCall = () => true;
    const route = await gw.router.createRoute();
    const sent = gw.router.send(route.id, SIX); // the app sends nothing about voice: the gateway decides on a call
    await until(() => events.some((e) => e.type === "agent.output.final" && e.sessionId === sent.sessionId));
    assert.match(lastStyle(), /flirty/i, "the persona the user picked");
    assert.match(lastStyle(), /live phone call/i);
    assert.match(lastStyle(), /at most three short sentences/i);
    const speech = speechOf(sent.sessionId);
    assert.ok(speech.length > 0 && speech.length <= 3, `spoke ${speech.length} sentences`);
    assert.ok(speech.every((s) => s.engine === "pc" && s.style === "normal"), "the PC voice");
    const final = events.find((e) => e.type === "agent.output.final" && e.sessionId === sent.sessionId) as Extract<GatewayEvent, { type: "agent.output.final" }>;
    assert.match(final.text, /Six things are left/, "the chat keeps the whole reply");
    assert.doesNotMatch(final.spoken ?? "", /Six things/, "the spoken text is cut to the first sentences");
  });

  it("a session the call was handed to keeps its own tone (never flirty) but is held to the same length and uses the same voice", async () => {
    const session = await gw.manager.createSession({ provider: "claude", title: "Build agent", projectPath: os.tmpdir() });
    const route = await gw.router.createRoute();
    await gw.router.handoff(route.id, { session: session.id });
    events.length = 0;
    gw.router.send(route.id, SIX);
    await until(() => events.some((e) => e.type === "agent.output.final" && e.sessionId === session.id));
    assert.doesNotMatch(lastStyle(), /flirty/i);
    assert.match(lastStyle(), /Relaxed, natural/);
    assert.match(lastStyle(), /live phone call/i);
    const speech = speechOf(session.id);
    assert.ok(speech.length > 0 && speech.length <= 3);
    assert.ok(speech.every((s) => s.engine === "pc"));
  });

  it("a critical call keeps no character at all, spoken in the serious style", async () => {
    gw.router.inCall = () => true;
    const route = await gw.router.createRoute();
    gw.router.setVoiceSeverity(route.id, "critical");
    events.length = 0;
    const sent = gw.router.send(route.id, "What failed?");
    await until(() => events.some((e) => e.type === "agent.output.final" && e.sessionId === sent.sessionId));
    assert.match(lastStyle(), /No jokes, no teasing, no flirting/);
    assert.ok(speechOf(sent.sessionId).every((s) => s.style === "serious"));
  });

  it("outside a call nothing changes: text chat has no voice style, and a direct session chat is never flirty", async () => {
    gw.router.inCall = () => false;
    const route = await gw.router.createRoute();
    gw.router.send(route.id, "just text");
    await until(() => provider.calls.some((c) => c.text.includes("just text")));
    assert.equal(provider.calls.find((c) => c.text.includes("just text"))!.voiceStyle, undefined);

    const front = voiceOptions(gw.persona, { voice: true }, "normal");
    const session = voiceOptions(gw.persona, { voice: true }, "normal", "session");
    assert.match(front.voiceStyle!, /flirty/i);
    assert.doesNotMatch(session.voiceStyle!, /flirty/i);
    assert.match(session.voiceStyle!, /Relaxed, natural/);
    // another mode the user picked still applies to sessions
    gw.persona.update({ mode: "playful" });
    assert.match(voiceOptions(gw.persona, { voice: true }, "normal", "session").voiceStyle!, /Witty and warm/);
    gw.persona.update({ mode: "flirty" });
  });

  it("limitSpoken keeps the first sentences and nothing else", () => {
    assert.equal(limitSpoken(SIX, 2), "One thing is done. Two things are running.");
    assert.equal(limitSpoken("Just one.", 3), "Just one.");
  });
});
