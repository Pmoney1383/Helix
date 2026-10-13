import assert from "node:assert/strict";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { effectivePersona } from "../src/persona/clamp.js";
import { DIGEST, FILLERS, GREETINGS, OPENERS } from "../src/persona/lines.js";
import { DEFAULT_PET_NAMES, fillPet } from "../src/persona/pet-names.js";
import { voiceStylePrompt } from "../src/persona/prompt.js";
import { PersonaService } from "../src/persona/service.js";
import { MODE_PRESETS, PERSONA_MODES, VOICE_SEVERITIES, type PersonaSettings } from "../src/persona/types.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const seeded = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]!; };
const svc = (rng = seeded(0)) => new PersonaService(openDb(":memory:"), rng);
const flirty: PersonaSettings = { enabled: true, mode: "flirty", ...MODE_PRESETS.flirty, speech: {}, petNames: [...DEFAULT_PET_NAMES] };

describe("the flirty mode", () => {
  it("is a real mode with its own preset, and you can dial it up or down", () => {
    assert.ok(PERSONA_MODES.includes("flirty"));
    assert.deepEqual(MODE_PRESETS.flirty, { teasing: 0.6, flirtiness: 0.85, sarcasm: 0.2, verbosity: 0.4 });
    const s = svc();
    assert.equal(s.update({ mode: "flirty" }).flirtiness, 0.85);
    assert.equal(s.update({ flirtiness: 0.3 }).flirtiness, 0.3, "adjustable");
    assert.equal(s.update({ flirtiness: 0 }).flirtiness, 0, "and off");
  });

  it("the instruction for a spoken reply makes the model flirty in conversation, with the safety limits intact", () => {
    const p = voiceStylePrompt(effectivePersona(flirty, "normal"));
    assert.match(p, /flirty/i);
    assert.match(p, /gorgeous|pet name/i);
    assert.match(p, /Use an ellipsis for a pause/, "pacing the voice engine can use");
    assert.match(p, /cheeky charm is fine \(heavy\); never crude, never about anyone but the user, always secondary to the task/);
    assert.match(p, /facts and the help stay exact/);
    assert.match(p, /Never let tone change a fact/);
  });

  it("an ordinary reply is flirty; a reply to an event that needs attention is lighter; a serious one is not flirty at all", () => {
    const normal = voiceStylePrompt(effectivePersona(flirty, "normal"));
    const warning = voiceStylePrompt(effectivePersona(flirty, "warning"));
    const serious = voiceStylePrompt(effectivePersona(flirty, "high"));
    const critical = voiceStylePrompt(effectivePersona(flirty, "critical"));
    assert.match(normal, /cheeky charm is fine \(heavy\)/);
    assert.match(warning, /cheeky charm is fine \(light\)/);
    for (const p of [serious, critical]) assert.doesNotMatch(p, /cheeky charm|gorgeous|flirty/i);
    assert.match(critical, /No jokes, no teasing, no flirting/);
  });

  it("the canned lines for the flirty mode exist, and none of them is the line that was dropped", () => {
    assert.ok(GREETINGS.flirty.length >= 3 && OPENERS.flirty.good.length > 0 && OPENERS.flirty.problem.length > 0);
    const everything = [
      ...GREETINGS.flirty, ...OPENERS.flirty.good, ...OPENERS.flirty.problem, ...FILLERS.flirty,
      ...DIGEST.flirty.quiet, ...DIGEST.flirty.busy, ...DIGEST.flirty.attention,
    ];
    for (const line of everything) assert.doesNotMatch(line, /very, very interested/i, line);
    for (const line of everything) assert.doesNotMatch(line, /\b(sex|naked|bed)\b/i, "tasteful: never crude");
    for (const line of DIGEST.flirty.quiet) {
      assert.match(line, /nothing/i);
      assert.match(line, /running/i);
      assert.match(line, /waiting/i);
    }
  });
});

describe("the filler: said the moment you stop talking, while the agent thinks", () => {
  it("every mode has short fillers, and the flirty one starts with 'Mmm... let me check.'", () => {
    for (const m of PERSONA_MODES) assert.ok(FILLERS[m].length >= 2, m);
    assert.equal(FILLERS.flirty[0], "Mmm... let me check.");
    for (const m of PERSONA_MODES) for (const l of FILLERS[m]) assert.ok(l.length <= 40, `${m}: ${l}`);
  });

  it("follows the user's mode in conversation", () => {
    const s = svc(seeded(0));
    s.update({ mode: "flirty" });
    assert.equal(s.filler("normal"), "Mmm... let me check.");
    s.update({ mode: "casual" });
    assert.equal(s.filler("normal"), FILLERS.casual[0]);
  });

  it("a serious moment gets the plain line whatever the mode, and a switched-off persona is always plain", () => {
    const s = svc(seeded(0));
    s.update({ mode: "flirty" });
    for (const sev of ["critical", "approval"] as const) assert.ok(FILLERS.professional.includes(s.filler(sev)), sev);
    assert.ok(!FILLERS.flirty.includes(s.filler("high")), "high is already too serious to flirt");
    s.update({ enabled: false });
    for (const sev of VOICE_SEVERITIES) assert.ok(FILLERS.professional.includes(s.filler(sev)), `off: ${sev}`);
  });
});

describe("through the gateway", () => {
  let gw: Gateway;
  let base: string;
  let token: string;
  const provider = new FakeProvider();
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  before(async () => {
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: provider });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  });
  after(async () => { await gw.app.close(); });

  it("GET /v1/voice/filler gives a line in the user's mode, and the plain line for anything serious", async () => {
    assert.equal((await fetch(base + "/v1/voice/filler")).status, 401);
    await api("PUT", "/v1/persona", { mode: "flirty" });
    const filled = FILLERS.flirty.flatMap((l) => DEFAULT_PET_NAMES.map((p) => fillPet(l, p)));
    const chat = (await api("GET", "/v1/voice/filler")).json;
    assert.ok(filled.includes(chat.text), chat.text);
    assert.doesNotMatch(chat.text, /\{pet\}/);
    assert.equal(chat.severity, "normal");
    for (const severity of ["critical", "approval", "high"]) {
      const r = (await api("GET", `/v1/voice/filler?severity=${severity}`)).json;
      assert.ok(!filled.includes(r.text), `${severity}: ${r.text}`);
      assert.ok(FILLERS.professional.includes(r.text) || FILLERS.casual.includes(r.text), `${severity}: ${r.text}`);
    }
    assert.equal((await api("GET", "/v1/voice/filler?severity=nonsense")).status, 400);
  });

  it("a spoken message to the front door in the flirty mode carries the flirty instruction; once it is serious it does not", async () => {
    await api("PUT", "/v1/persona", { mode: "flirty" });
    const route = (await api("POST", "/v1/routes", {})).json;
    const settle = async () => { while (gw.manager.isRunning(route.routerSessionId)) await new Promise((r) => setTimeout(r, 10)); };
    await api("POST", `/v1/routes/${route.id}/message`, { text: "how is it going", voice: true });
    await settle();
    assert.match(provider.calls.at(-1)!.voiceStyle ?? "", /flirty/i);
    await api("POST", `/v1/routes/${route.id}/message`, { text: "it crashed", voice: true, voiceSeverity: "critical" });
    await settle();
    assert.doesNotMatch(provider.calls.at(-1)!.voiceStyle ?? "", /flirty|cheeky charm|gorgeous/i);
    assert.match(provider.calls.at(-1)!.voiceStyle ?? "", /No jokes, no teasing, no flirting/);
  });
});
