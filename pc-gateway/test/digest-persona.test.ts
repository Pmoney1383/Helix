import assert from "node:assert/strict";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { DIGEST } from "../src/persona/lines.js";
import { PersonaService } from "../src/persona/service.js";
import { PERSONA_MODES } from "../src/persona/types.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";
import { buildDigest, type BriefingSources } from "../src/voice/briefing.js";
import type { Approval } from "../src/types.js";

const seeded = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]!; };
const svc = (rng = seeded(0)) => new PersonaService(openDb(":memory:"), rng);
const sources = (o: Partial<BriefingSources> = {}): BriefingSources => ({
  pendingApprovals: () => [], workingSessions: () => [], liveSessions: () => [], watches: () => [],
  projects: () => [], aliases: () => [], recentSessionTitles: () => [], watchNames: () => [], ...o,
});
const approval = (summary: string): Approval =>
  ({ id: "a", source: "agent", tool: "Bash", summary, reasons: [], status: "pending", createdAt: "2026-10-01T10:00:00Z", expiresAt: "2026-10-01T11:00:00Z" });

describe("digest personality: how much character each kind of digest may have", () => {
  it("professional mode, or the persona switched off, adds nothing to any digest", () => {
    const s = svc();
    s.update({ mode: "professional" });
    for (const k of ["quiet", "busy", "attention", "urgent"] as const) assert.deepEqual(s.digestFlavor(k), {}, k);
    s.update({ mode: "unhinged", enabled: false });
    for (const k of ["quiet", "busy", "attention", "urgent"] as const) assert.deepEqual(s.digestFlavor(k), {}, `off: ${k}`);
  });

  it("an approval waiting is never flavoured, in any mode", () => {
    const s = svc();
    for (const mode of PERSONA_MODES) { s.update({ mode }); assert.deepEqual(s.digestFlavor("urgent"), {}, mode); }
  });

  it("when all is well the full personality is allowed", () => {
    const s = svc(seeded(0));
    s.update({ mode: "unhinged" });
    assert.equal(s.digestFlavor("quiet").quiet, DIGEST.unhinged.quiet[0]);
    assert.equal(s.digestFlavor("busy").opener, DIGEST.unhinged.busy[0]);
    s.update({ mode: "casual" });
    assert.equal(s.digestFlavor("quiet").quiet, DIGEST.casual.quiet[0]);
  });

  it("a problem only gets a light touch: even the most extreme mode is held to 'playful'", () => {
    const s = svc(seeded(0));
    s.update({ mode: "unhinged" });
    assert.equal(s.digestFlavor("attention").opener, DIGEST.playful.attention[0], "not the unhinged line");
    assert.ok(!DIGEST.unhinged.attention.includes(s.digestFlavor("attention").opener!));
    s.update({ mode: "casual" });
    assert.equal(s.digestFlavor("attention").opener, DIGEST.casual.attention[0]);
  });

  it("every personality line for 'nothing going on' still states the facts", () => {
    for (const mode of PERSONA_MODES) {
      for (const line of DIGEST[mode].quiet) {
        assert.match(line, /nothing|nada/i, line);
        assert.match(line, /running/i, line);
        assert.match(line, /waiting/i, line);
      }
    }
  });
});

describe("digest personality: the facts never change", () => {
  const flavor = (opener?: string, quiet?: string) => () => ({ opener, quiet });

  it("an opener goes in front of the same facts", () => {
    const src = sources({ workingSessions: () => ["cat diffusion"], liveSessions: () => ["a", "b"] });
    const neutral = buildDigest(src);
    const flavoured = buildDigest(src, flavor("Okay, status report time."));
    assert.equal(neutral.spoken, "Working right now: cat diffusion. 2 agent sessions are open on the PC.");
    assert.equal(flavoured.spoken, `Okay, status report time. ${neutral.spoken}`);
    assert.deepEqual(flavoured.counts, neutral.counts);
    assert.equal(flavoured.kind, "busy");
  });

  it("the quiet line replaces the neutral wording only when nothing is going on", () => {
    assert.equal(buildDigest(sources(), flavor(undefined, "Crickets. Nothing is running or waiting.")).spoken, "Crickets. Nothing is running or waiting.");
    // a quiet-line must not leak into a digest that has something to say
    const busy = buildDigest(sources({ workingSessions: () => ["x"] }), flavor(undefined, "Crickets."));
    assert.equal(busy.spoken, "Working right now: x.");
  });

  it("an urgent digest is the neutral text even if a flavour callback tried to add something", () => {
    const src = sources({ pendingApprovals: () => [approval("delete the old checkpoints")] });
    const real = svc();
    real.update({ mode: "unhinged" });
    const d = buildDigest(src, (k) => real.digestFlavor(k));
    assert.equal(d.spoken, buildDigest(src).spoken);
    assert.equal(d.kind, "urgent");
  });

  it("kinds: urgent beats attention beats busy beats quiet", () => {
    const kind = (o: Partial<BriefingSources>) => buildDigest(sources(o)).kind;
    assert.equal(kind({}), "quiet");
    assert.equal(kind({ liveSessions: () => ["a"] }), "busy");
    assert.equal(kind({ liveSessions: () => ["a"], watches: () => [{ name: "w", status: "triggered" }] }), "attention");
    assert.equal(kind({ watches: () => [{ name: "w", status: "error" }], pendingApprovals: () => [approval("x")] }), "urgent");
  });
});

describe("GET /v1/digest in the user's personality", () => {
  let gw: Gateway;
  let base: string;
  let token: string;
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  before(async () => {
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  });
  after(async () => { await gw.app.close(); });

  it("follows the saved mode, and ?plain=true always gives the neutral wording", async () => {
    await api("PUT", "/v1/persona", { mode: "unhinged" });
    const flavoured = (await api("GET", "/v1/digest")).json;
    assert.equal(flavoured.kind, "quiet");
    assert.ok(DIGEST.unhinged.quiet.includes(flavoured.spoken), flavoured.spoken);
    assert.equal((await api("GET", "/v1/digest?plain=true")).json.spoken, "All quiet. Nothing is running or waiting.");

    await api("PUT", "/v1/persona", { mode: "professional" });
    assert.equal((await api("GET", "/v1/digest")).json.spoken, "All quiet. Nothing is running or waiting.");
    assert.equal((await api("GET", "/v1/digest?plain=maybe")).status, 400);
  });

  it("with a waiting approval it stays plain even in the most extreme mode", async () => {
    await api("PUT", "/v1/persona", { mode: "unhinged" });
    const ask = gw.approvals.request({ source: "agent", tool: "Bash", summary: "delete the old checkpoints", reasons: ["rm"], signal: new AbortController().signal });
    const d = (await api("GET", "/v1/digest")).json;
    assert.equal(d.kind, "urgent");
    assert.equal(d.spoken, "1 approval is waiting for you. The oldest is: delete the old checkpoints.");
    gw.approvals.resolve(ask.approval.id, false, undefined, "no");
    await ask.outcome;
  });
});
