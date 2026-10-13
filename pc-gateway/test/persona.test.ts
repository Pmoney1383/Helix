import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import { eventScript } from "../src/calls/composer.js";
import { effectivePersona, voiceSeverityFor } from "../src/persona/clamp.js";
import { GREETINGS } from "../src/persona/lines.js";
import { voiceStylePrompt } from "../src/persona/prompt.js";
import { PersonaService } from "../src/persona/service.js";
import { DEFAULT_SETTINGS, MODE_PRESETS, VOICE_SEVERITIES, type PersonaSettings } from "../src/persona/types.js";
import { claudeArgs } from "../src/providers/claude.js";
import { CodexProvider } from "../src/providers/codex.js";
import { FakeProvider } from "../src/providers/fake.js";
import type { SendOptions } from "../src/providers/provider.js";
import { openDb } from "../src/storage/sqlite.js";
import { makeKey, startMockApns } from "./fixtures/mock-apns.js";

const wild: PersonaSettings = { enabled: true, mode: "unhinged", teasing: 1, flirtiness: 1, sarcasm: 1, verbosity: 1, speech: {}, petNames: ["gorgeous", "babe"] };

describe("severity clamp: the more serious the moment, the less character", () => {
  it("full personality when nothing is wrong", () => {
    for (const s of ["info", "normal"] as const) {
      const e = effectivePersona(wild, s);
      assert.deepEqual([e.mode, e.teasing, e.flirtiness, e.sarcasm, e.verbosity], ["unhinged", 1, 1, 1, 1]);
    }
  });

  it("warning: a light touch (flirting included, kept small), shorter", () => {
    const e = effectivePersona(wild, "warning");
    assert.deepEqual([e.mode, e.teasing, e.flirtiness, e.sarcasm, e.verbosity], ["playful", 0.35, 0.4, 0.35, 0.7]);
  });

  it("high: almost nothing", () => {
    const e = effectivePersona(wild, "high");
    assert.deepEqual([e.mode, e.teasing, e.flirtiness, e.sarcasm, e.verbosity], ["casual", 0.1, 0, 0.1, 0.5]);
  });

  it("critical and approval: no character whatsoever, and terse, whatever the sliders say", () => {
    for (const s of ["critical", "approval"] as const) {
      const e = effectivePersona(wild, s);
      assert.deepEqual([e.mode, e.teasing, e.flirtiness, e.sarcasm], ["professional", 0, 0, 0], s);
      assert.ok(e.verbosity <= 0.3, s);
    }
  });

  it("flirting is off from 'high' upward at every slider value: nothing serious ever flirts", () => {
    for (const f of [0, 0.3, 0.7, 1]) {
      for (const s of ["high", "critical", "approval"] as const) {
        assert.equal(effectivePersona({ ...wild, flirtiness: f }, s).flirtiness, 0, `${s} @ ${f}`);
      }
    }
  });

  it("an event that merely needs attention keeps a small share of the slider's flirting, never more than chosen", () => {
    for (const f of [0, 0.3, 0.7, 1]) {
      const got = effectivePersona({ ...wild, flirtiness: f }, "warning").flirtiness;
      assert.equal(got, Math.round(f * 0.4 * 100) / 100, `@ ${f}`);
      assert.ok(got <= f);
    }
  });

  it("the flirty mode is held back exactly like the others: full in conversation, a light touch at warning, gone when serious", () => {
    const flirty = { ...wild, mode: "flirty" as const, flirtiness: 0.85, teasing: 0.6, sarcasm: 0.2 };
    assert.equal(effectivePersona(flirty, "normal").mode, "flirty");
    assert.equal(effectivePersona(flirty, "normal").flirtiness, 0.85);
    assert.equal(effectivePersona(flirty, "warning").mode, "flirty", "an event that needs attention is not yet serious");
    assert.equal(effectivePersona(flirty, "high").mode, "casual");
    for (const s of ["critical", "approval"] as const) {
      const e = effectivePersona(flirty, s);
      assert.deepEqual([e.mode, e.teasing, e.flirtiness, e.sarcasm], ["professional", 0, 0, 0], s);
    }
  });

  it("never exceeds what the user chose, and never goes below zero or above one", () => {
    const mild: PersonaSettings = { ...wild, mode: "casual", teasing: 0.2, flirtiness: 0, sarcasm: 0.1, verbosity: 0.35 };
    for (const s of VOICE_SEVERITIES) {
      const e = effectivePersona(mild, s);
      assert.ok(e.teasing <= 0.2 && e.sarcasm <= 0.1 && e.verbosity <= 0.35, s);
    }
    const silly = effectivePersona({ ...wild, teasing: 9, sarcasm: -3 } as PersonaSettings, "normal");
    assert.deepEqual([silly.teasing, silly.sarcasm], [1, 0]);
  });

  it("turned off: spoken-style replies with no personality at any severity", () => {
    for (const s of VOICE_SEVERITIES) {
      const e = effectivePersona({ ...wild, enabled: false }, s);
      assert.deepEqual([e.mode, e.teasing, e.flirtiness, e.sarcasm], ["professional", 0, 0, 0], s);
    }
  });

  it("maps the gateway's severities to voice severities, approvals always winning", () => {
    assert.equal(voiceSeverityFor({ severity: "info" }), "info");
    assert.equal(voiceSeverityFor({ severity: "important" }), "warning");
    assert.equal(voiceSeverityFor({ severity: "critical" }), "critical");
    assert.equal(voiceSeverityFor({ severity: "info", approval: true }), "approval");
  });
});

describe("the instruction given to the model", () => {
  const prompt = (s: PersonaSettings, sev: (typeof VOICE_SEVERITIES)[number]) => voiceStylePrompt(effectivePersona(s, sev));

  it("always insists on spoken style and on facts never bending to tone, at every severity and mode", () => {
    for (const mode of ["professional", "casual", "playful", "unhinged"] as const) {
      for (const sev of VOICE_SEVERITIES) {
        const p = prompt({ ...wild, mode, ...MODE_PRESETS[mode] }, sev);
        assert.match(p, /spoken aloud/, `${mode}/${sev}`);
        assert.match(p, /No markdown, no lists, no code blocks, no emoji/);
        assert.match(p, /Never let tone change a fact, a decision, a command you run or which tool you use/);
        assert.match(p, /Important information always wins over character/);
      }
    }
  });

  it("critical and approval prompts forbid humour outright", () => {
    const crit = prompt(wild, "critical");
    assert.match(crit, /No jokes, no teasing, no flirting, no banter, no sarcasm/);
    assert.match(crit, /Lead with what is wrong, then the impact, then the exact decision/);
    assert.ok(!/Teasing:|Sarcasm:|cheeky charm/.test(crit), "no personality knobs leak into an urgent prompt");
    const appr = prompt(wild, "approval");
    assert.match(appr, /No humour\. State exactly what will happen/);
    assert.match(appr, /clear yes or no/);
  });

  it("describes the character the user dialled in, only when it applies", () => {
    const calm = prompt(wild, "normal");
    assert.match(calm, /goofy/);
    assert.match(calm, /Teasing: heavy/);
    assert.match(calm, /Sarcasm: noticeable|Sarcasm: heavy/);
    assert.match(calm, /cheeky charm/);
    const warn = prompt(wild, "warning");
    assert.match(warn, /cheeky charm is fine \(light\)/, "an event that needs attention keeps only a light touch");
    assert.ok(!/cheeky charm/.test(prompt(wild, "high")), "flirting never survives anything serious");
    assert.match(warn, /Say the problem first/);
    assert.ok(!/Teasing:|Sarcasm:/.test(prompt({ ...wild, mode: "professional", teasing: 0, sarcasm: 0, flirtiness: 0 }, "normal")));
  });

  it("flirting is bounded: never crude, never about anyone else, never ahead of the task", () => {
    assert.match(prompt(wild, "normal"), /never crude, never about anyone but the user, always secondary to the task/);
  });

  it("length guidance follows verbosity", () => {
    assert.match(prompt({ ...wild, verbosity: 0.1 }, "normal"), /One short sentence/);
    assert.match(prompt({ ...wild, verbosity: 0.4 }, "normal"), /One to three short sentences/);
    assert.match(prompt({ ...wild, verbosity: 0.7 }, "normal"), /A few sentences/);
    assert.match(prompt({ ...wild, verbosity: 1 }, "normal"), /elaborate/);
    assert.match(prompt({ ...wild, verbosity: 1 }, "critical"), /One to three short sentences|One short sentence/, "capped when urgent");
  });

  it("is deterministic and says it is not part of the user's message", () => {
    assert.equal(prompt(wild, "normal"), prompt(wild, "normal"));
    assert.match(prompt(wild, "normal"), /not part of the user's message/);
  });
});

describe("settings", () => {
  it("start as casual, switching mode applies its preset, explicit sliders win, and it survives a restart", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helix-persona-")), "p.db");
    let db = openDb(file);
    let svc = new PersonaService(db);
    assert.deepEqual(svc.get(), DEFAULT_SETTINGS);

    const playful = svc.update({ mode: "playful" });
    assert.deepEqual([playful.teasing, playful.sarcasm, playful.flirtiness], [MODE_PRESETS.playful.teasing, MODE_PRESETS.playful.sarcasm, MODE_PRESETS.playful.flirtiness]);
    const tuned = svc.update({ mode: "unhinged", flirtiness: 0 });
    assert.equal(tuned.flirtiness, 0, "an explicit slider beats the preset");
    assert.equal(tuned.teasing, MODE_PRESETS.unhinged.teasing, "the rest take the new mode's preset");
    const moved = svc.update({ teasing: 0.4 });
    assert.equal(moved.mode, "unhinged", "moving a slider does not change the mode");
    assert.deepEqual(svc.update({ speech: { rate: 0.5 } }).speech, { rate: 0.5 });
    assert.deepEqual(svc.update({ speech: { voiceId: "Samantha" } }).speech, { rate: 0.5, voiceId: "Samantha" }, "speech preferences merge");

    db.close();
    db = openDb(file);
    svc = new PersonaService(db);
    assert.deepEqual([svc.get().mode, svc.get().teasing, svc.get().flirtiness], ["unhinged", 0.4, 0]);
    db.close();
  });

  it("garbage in storage falls back to the defaults instead of breaking calls", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO settings (key, value) VALUES ('persona', 'not json')").run();
    assert.deepEqual(new PersonaService(db).get(), DEFAULT_SETTINGS);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'persona'").run(JSON.stringify({ mode: "evil", teasing: 99 }));
    assert.deepEqual(new PersonaService(db).get(), DEFAULT_SETTINGS);
  });

  it("shows how the character fades, for the app's settings screen", () => {
    const all = new PersonaService(openDb(":memory:")).allEffective({ ...wild });
    assert.deepEqual(Object.keys(all), ["info", "normal", "warning", "high", "critical", "approval"]);
    assert.ok(all.info.teasing > all.warning.teasing && all.warning.teasing > all.high.teasing && all.high.teasing > all.critical.teasing);
  });
});

describe("lines composed by Helix itself", () => {
  const seeded = (...values: number[]) => { let i = 0; return () => values[i++ % values.length]!; };
  const svc = (rng = seeded(0)) => new PersonaService(openDb(":memory:"), rng);

  it("greets in the chosen personality", () => {
    for (const mode of ["professional", "casual", "playful", "unhinged"] as const) {
      const s = svc();
      s.update({ mode });
      assert.ok(GREETINGS[mode].includes(s.greeting()), mode);
    }
    const s = svc(seeded(0));
    s.update({ mode: "playful" });
    assert.equal(s.greeting(), "Oh wow, you called me voluntarily. I'm touched. What do you need?");
  });

  it("flavours only routine updates: never urgent ones, approvals, or professional mode", () => {
    const s = svc(seeded(0));
    s.update({ mode: "unhinged" });
    assert.deepEqual(s.flavor({ severity: "critical", title: "Training crashed" }), {});
    assert.deepEqual(s.flavor({ severity: "important", title: "Approve?", approval: true }), {});
    s.update({ mode: "professional" });
    assert.deepEqual(s.flavor({ severity: "important", title: "Build finished" }), {});
  });

  it("a routine update gets an opener that matches the news; a teasing tag only on good news at full volume", () => {
    const s = svc(seeded(0));
    s.update({ mode: "playful" });
    const good = s.flavor({ severity: "info", title: "Training finished" });
    assert.equal(good.opener, "Good news.");
    assert.equal(good.closer, "Took it long enough.");
    const bad = s.flavor({ severity: "info", title: "Build failed" });
    assert.equal(bad.opener, "Heads up.");
    assert.equal(bad.closer, undefined, "no teasing about a problem");
    const routine = s.flavor({ severity: "important", title: "Training finished" });
    assert.equal(routine.opener, "Good news.");
    assert.equal(routine.closer, undefined, "at 'warning' there is no room for a tag");
  });

  it("flavour wraps the neutral script without touching its content", () => {
    const neutral = eventScript("Training finished", "Final loss 0.18.");
    const flavoured = eventScript("Training finished", "Final loss 0.18.", { opener: "Good news.", closer: "Took it long enough." });
    assert.equal(neutral, "Training finished. Final loss 0.18. What would you like to do?");
    assert.equal(flavoured, "Good news. Training finished. Final loss 0.18. Took it long enough. What would you like to do?");
  });
});

describe("providers carry the style without changing behaviour", () => {
  const base = (o: Partial<SendOptions> = {}): SendOptions => ({ providerSessionId: "11111111-1111-4111-8111-111111111111", text: "hi", resume: true, signal: new AbortController().signal, ...o });
  const systemPrompt = (a: string[]) => a[a.indexOf("--append-system-prompt") + 1];

  it("Claude: appended to the system prompt, after the router's own role prompt when there is one", () => {
    assert.equal(systemPrompt(claudeArgs(base({ voiceStyle: "STYLE" }), { kind: "resume" }, "default")), "STYLE");
    assert.equal(systemPrompt(claudeArgs(base({ voiceStyle: "STYLE", appendSystemPrompt: "ROLE" }), { kind: "resume" }, "default")), "ROLE\n\nSTYLE");
    assert.equal(claudeArgs(base(), { kind: "resume" }, "default").includes("--append-system-prompt"), false, "no voice, no extra prompt");
  });

  it("Codex: a clearly marked note ahead of the user's message", async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helix-cx-")), "codex.log");
    const provider = new CodexProvider({ server: { bin: process.execPath, args: [path.resolve("test/fixtures/fake-codex-app-server.mjs")], env: () => ({ ...process.env, FAKE_CODEX_LOG: log }) } });
    const { providerSessionId } = await provider.createSession({});
    const events: any[] = [];
    for await (const e of provider.send(base({ providerSessionId, text: "how is it going", voiceStyle: "Helix voice note: be brief." }))) events.push(e);
    const turns = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.dir === "in" && m.msg.method === "turn/start");
    const sent = turns[0].msg.params.input[0].text as string;
    assert.match(sent, /^Helix voice note: be brief\./);
    assert.match(sent, /User's message:\nhow is it going$/);
    for await (const _ of provider.send(base({ providerSessionId, text: "plain" }))) { /* drain */ }
    const second = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.dir === "in" && m.msg.method === "turn/start")[1];
    assert.equal(second.msg.params.input[0].text, "plain", "untouched when not speaking");
    provider.close();
  });
});

describe("through the gateway", () => {
  let gw: Gateway;
  let base: string;
  let token: string;
  let mock: Awaited<ReturnType<typeof startMockApns>>;
  const provider = new FakeProvider();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-pg-"));
  const api = async (method: string, p: string, body?: unknown, auth = true) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const until = async (fn: () => boolean) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > 3000) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
  const lastCall = (match: string) => provider.calls.filter((c) => c.text.includes(match)).at(-1);

  before(async () => {
    mock = await startMockApns();
    const key = makeKey();
    gw = await buildGateway({
      defaultProjectPath: tmp, logLevel: "silent", routerHome: path.join(tmp, "router"), approvalCallAfterMs: 0,
      apns: { keyPem: key.keyPem, keyId: "K", teamId: "T", bundleId: "com.example.helix", endpoints: { sandbox: mock.url, production: mock.url } },
    }, openDb(":memory:"), { claude: provider });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
    await api("PUT", "/v1/devices/me/push-token", { kind: "voip", token: "b2".repeat(32), environment: "sandbox" });
    gw.presence.setMode("away");
  });
  after(async () => { await gw.app.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("the settings API: defaults, presets, validation, and the severity preview", async () => {
    assert.equal((await api("GET", "/v1/persona", undefined, false)).status, 401);
    const v = (await api("GET", "/v1/persona")).json;
    assert.equal(v.settings.mode, "professional", "Helix starts professional until the user picks another mode");
    assert.deepEqual(Object.keys(v.presets), ["professional", "casual", "playful", "flirty", "unhinged"]);
    assert.equal(v.effective.critical.mode, "professional");

    assert.equal((await api("PUT", "/v1/persona", { teasing: 2 })).status, 400);
    assert.equal((await api("PUT", "/v1/persona", { mode: "evil" })).status, 400);
    assert.equal((await api("PUT", "/v1/persona", { surprise: true })).status, 400, "unknown settings are rejected, not ignored");

    const put = (await api("PUT", "/v1/persona", { mode: "unhinged", speech: { rate: 0.6, voiceId: "Ava" } })).json;
    assert.equal(put.settings.mode, "unhinged");
    assert.equal(put.settings.teasing, MODE_PRESETS.unhinged.teasing);
    assert.equal(put.effective.warning.mode, "playful");
    assert.deepEqual(put.settings.speech, { rate: 0.6, voiceId: "Ava" });

    // preview: what a setting would do, without saving it
    const preview = (await api("POST", "/v1/persona/preview", { mode: "professional", severity: "normal" })).json;
    assert.equal(preview.effective.mode, "professional");
    assert.ok(GREETINGS.professional.includes(preview.greeting));
    assert.match(preview.instruction, /Neutral and concise/);
    assert.equal((await api("GET", "/v1/persona")).json.settings.mode, "unhinged", "a preview changes nothing");
  });

  it("a spoken message carries the user's personality; a typed one does not", async () => {
    await api("PUT", "/v1/persona", { mode: "playful" });
    const s = (await api("POST", "/v1/sessions", { title: "voice", projectPath: tmp })).json;

    await api("POST", `/v1/sessions/${s.id}/message`, { text: "typed question" });
    await until(() => !!lastCall("typed question"));
    assert.equal(lastCall("typed question")!.voiceStyle, undefined, "reading the app gets the normal agent, not a spoken-style one");
    await until(() => !gw.manager.isRunning(s.id));

    await api("POST", `/v1/sessions/${s.id}/message`, { text: "spoken question", voice: true });
    await until(() => !!lastCall("spoken question"));
    const style = lastCall("spoken question")!.voiceStyle!;
    assert.match(style, /Helix voice note/);
    assert.match(style, /Witty and warm/);
    assert.match(style, /Teasing: noticeable/);
    await until(() => !gw.manager.isRunning(s.id));

    await api("POST", `/v1/sessions/${s.id}/message`, { text: "urgent spoken", voice: true, voiceSeverity: "critical" });
    await until(() => !!lastCall("urgent spoken"));
    const urgent = lastCall("urgent spoken")!.voiceStyle!;
    assert.match(urgent, /No jokes, no teasing, no flirting/);
    assert.ok(!/Witty and warm|Teasing:/.test(urgent), "playful mode, but not now");
    assert.equal((await api("POST", `/v1/sessions/${s.id}/message`, { text: "x", voice: true, voiceSeverity: "bogus" })).status, 400);
  });

  it("the same over the websocket, and an outgoing call greets in the chosen personality", async () => {
    await api("PUT", "/v1/persona", { mode: "unhinged" });
    const call = (await api("POST", "/v1/calls/start", {})).json;
    assert.ok(GREETINGS.unhinged.includes(call.script), "the greeting to speak when the call connects");

    const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
    const got: any[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "route.send", routeId: call.routeId, text: "hello over the socket", voice: true, clientId: "c" }));
    await until(() => got.some((e) => e.type === "send.accepted" && e.clientId === "c"));
    await until(() => !!lastCall("hello over the socket"));
    assert.match(lastCall("hello over the socket")!.voiceStyle!, /goofy/);
    ws.close();
  });

  it("an urgent call keeps the personality dialled down for the whole call, whatever the setting", async () => {
    await api("PUT", "/v1/persona", { mode: "unhinged" });
    await gw.escalation.notify({ severity: "critical", title: "Training crashed", body: "CUDA out of memory.", dedupeKey: "p1" });
    const call = gw.calls.list()[0]!;
    assert.equal(call.script, "Training crashed. CUDA out of memory. What would you like to do?", "the script is exactly the neutral wording");
    const answered = (await api("POST", `/v1/calls/${call.id}/answer`)).json;
    assert.equal(gw.router.voiceSeverity(answered.routeId), "critical");

    await api("POST", `/v1/routes/${answered.routeId}/message`, { text: "what do I do about the crash", voice: true });
    await until(() => !!lastCall("what do I do about the crash"));
    const style = lastCall("what do I do about the crash")!.voiceStyle!;
    assert.match(style, /This is urgent/);
    assert.ok(!/goofy|Teasing|cheeky/.test(style), "unhinged mode never reaches an urgent call");

    // the app can still raise or lower it explicitly for one message
    await until(() => !gw.manager.isRunning(gw.router.mustGet(answered.routeId).currentSessionId));
    await api("POST", `/v1/routes/${answered.routeId}/message`, { text: "lighter now", voice: true, voiceSeverity: "info" });
    await until(() => !!lastCall("lighter now"));
    assert.match(lastCall("lighter now")!.voiceStyle!, /goofy/);
  });

  it("a routine update call gets a light touch; an approval call never does", async () => {
    await api("PUT", "/v1/persona", { mode: "playful" });
    // The default policy only pushes for "important"; a call at that level (a test call, or a custom policy) is where the touch applies.
    await gw.calls.ringIncoming({ severity: "important", title: "Training finished", summary: "Final loss 0.18." });
    const routine = gw.calls.list().find((c) => c.title === "Training finished")!;
    assert.match(routine.script, /^(Good news\.|Well, look at that\.) Training finished\. Final loss 0\.18\. What would you like to do\?$/);

    const { approval } = gw.approvals.request({ source: "agent", tool: "shell", summary: "shell: rm -rf data  [atlas]" });
    gw.escalation.notify({ severity: "critical", title: "Approval needed", body: approval.summary, approvalId: approval.id, dedupeKey: "p3", kind: "approval" }, { skip: ["message", "push"] });
    await until(() => gw.calls.list().some((c) => c.approvalId === approval.id));
    const ask = gw.calls.list().find((c) => c.approvalId === approval.id)!;
    assert.equal(ask.script, "Claude needs your approval to run the command rm -rf data, in atlas. Say approve to allow it, or reject to stop it.", "no personality, ever");
  });

  it("turned off: still spoken-style, with no personality", async () => {
    await api("PUT", "/v1/persona", { enabled: false });
    const s = (await api("POST", "/v1/sessions", { title: "off", projectPath: tmp })).json;
    await api("POST", `/v1/sessions/${s.id}/message`, { text: "persona is off", voice: true });
    await until(() => !!lastCall("persona is off"));
    const style = lastCall("persona is off")!.voiceStyle!;
    assert.match(style, /spoken aloud/);
    assert.match(style, /Neutral and concise/);
    assert.ok(!/Teasing:|goofy|Witty/.test(style));
  });
});
