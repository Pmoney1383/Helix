import assert from "node:assert/strict";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import { buildDigest, buildHints, type BriefingSources } from "../src/voice/briefing.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";
import type { Approval } from "../src/types.js";

const approval = (summary: string, createdAt = "2026-10-01T10:00:00Z"): Approval =>
  ({ id: summary, source: "agent", tool: "Bash", summary, reasons: [], status: "pending", createdAt, expiresAt: "2026-10-01T11:00:00Z" });
const sources = (o: Partial<BriefingSources> = {}): BriefingSources => ({
  pendingApprovals: () => [], workingSessions: () => [], liveSessions: () => [], watches: () => [],
  projects: () => [], aliases: () => [], recentSessionTitles: () => [], watchNames: () => [], ...o,
});

describe("voice hints for speech recognition", () => {
  it("always includes the words Helix expects to hear", () => {
    const { strings } = buildHints(sources());
    for (const w of ["Helix", "Claude", "Codex", "approve", "reject", "interrupt"]) assert.ok(strings.includes(w), w);
  });

  it("adds project, alias and session names, plus how a person would say them", () => {
    const { strings } = buildHints(sources({
      projects: () => ["cat-diffusion", "recipe_box"], aliases: () => ["training"], recentSessionTitles: () => ["Fix publish admin editor"], watchNames: () => ["GPU temperature"],
    }));
    for (const w of ["cat-diffusion", "cat diffusion", "recipe box", "training", "Fix publish admin editor", "GPU temperature"]) assert.ok(strings.includes(w), w);
  });

  it("de-duplicates ignoring case, drops junk, and stays within the limits", () => {
    const many = Array.from({ length: 300 }, (_, i) => `project number ${i} alpha`);
    const { strings } = buildHints(sources({ projects: () => ["Claude", "claude", "12345", "2026-10-01", "", "x".repeat(80), ...many] }));
    assert.equal(strings.filter((s) => s.toLowerCase() === "claude").length, 1);
    assert.ok(!strings.includes("12345") && !strings.includes("2026-10-01") && !strings.includes(""));
    assert.ok(strings.every((s) => s.length <= 50));
    assert.ok(strings.length <= 100);
  });

  it("names the user is likely to say come before generic titles", () => {
    const { strings } = buildHints(sources({ aliases: () => ["training"], recentSessionTitles: () => Array.from({ length: 120 }, (_, i) => `session title ${i} here`) }));
    assert.ok(strings.indexOf("training") < strings.indexOf("session title 0 here"));
  });
});

describe("spoken digest", () => {
  it("says so when everything is quiet", () => {
    const d = buildDigest(sources());
    assert.equal(d.spoken, "All quiet. Nothing is running or waiting.");
    assert.deepEqual(d.counts, { approvalsPending: 0, sessionsWorking: 0, sessionsOpen: 0, watchesFiring: 0, watchesFailing: 0 });
  });

  it("puts what needs the user first, with the oldest approval's summary", () => {
    const d = buildDigest(sources({
      pendingApprovals: () => [approval("delete the new checkpoint folder", "2026-10-01T10:05:00Z"), approval("delete the old checkpoints in atlas", "2026-10-01T10:00:00Z")],
      watches: () => [{ name: "training log", status: "triggered" }],
      workingSessions: () => ["cat diffusion"], liveSessions: () => ["a", "b", "c"],
    }));
    assert.equal(d.spoken, "2 approvals are waiting for you. The oldest is: delete the old checkpoints in atlas. 1 watch is firing: training log. Working right now: cat diffusion. 3 agent sessions are open on the PC.");
    assert.deepEqual(d.counts, { approvalsPending: 2, sessionsWorking: 1, sessionsOpen: 3, watchesFiring: 1, watchesFailing: 0 });
  });

  it("singular and plural wording, and long lists are cut with a count", () => {
    assert.match(buildDigest(sources({ pendingApprovals: () => [approval("one thing")] })).spoken, /^1 approval is waiting for you\./);
    const d = buildDigest(sources({ workingSessions: () => ["alpha", "beta", "gamma", "delta", "epsilon"] }));
    assert.equal(d.spoken, "Working right now: alpha, beta, gamma and 2 more.");
    assert.match(buildDigest(sources({ watches: () => [{ name: "disk", status: "error" }] })).spoken, /1 watch could not run: disk\./);
  });

  it("is clean speech: markdown in an approval summary does not leak through", () => {
    const d = buildDigest(sources({ pendingApprovals: () => [approval("run `rm -rf **checkpoints**` in C:\\proj\\atlas\\runs")] }));
    assert.doesNotMatch(d.spoken, /[`*\\]/);
  });
});

describe("through the gateway", () => {
  let gw: Gateway;
  let base: string;
  let token: string;
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  before(async () => {
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider(400) });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  });
  after(async () => { await gw.app.close(); });

  it("both endpoints need a paired device", async () => {
    assert.equal((await fetch(base + "/v1/digest")).status, 401);
    assert.equal((await fetch(base + "/v1/voice/hints")).status, 401);
  });

  it("the digest follows what is really happening: a working session, then a waiting approval, then quiet again", async () => {
    assert.equal((await api("GET", "/v1/digest?plain=true")).json.spoken, "All quiet. Nothing is running or waiting.");

    const s = (await api("POST", "/v1/sessions", { title: "cat diffusion training", projectPath: os.tmpdir() })).json;
    await api("POST", `/v1/sessions/${s.id}/message`, { text: "go go go go go go" });
    const working = (await api("GET", "/v1/digest?plain=true")).json;
    assert.match(working.spoken, /Working right now: cat diffusion training\./);
    assert.equal(working.counts.sessionsWorking, 1);
    while (gw.manager.isRunning(s.id)) await new Promise((r) => setTimeout(r, 10));

    const ask = gw.approvals.request({ sessionId: s.id, source: "agent", tool: "Bash", summary: "delete the old checkpoints", reasons: ["rm deletes data"], signal: new AbortController().signal });
    const waiting = (await api("GET", "/v1/digest?plain=true")).json;
    assert.match(waiting.spoken, /^1 approval is waiting for you\. The oldest is: delete the old checkpoints\./);
    assert.equal(waiting.counts.approvalsPending, 1);

    gw.approvals.resolve(ask.approval.id, false, undefined, "no");
    await ask.outcome;
    assert.equal((await api("GET", "/v1/digest?plain=true")).json.spoken, "All quiet. Nothing is running or waiting.");
  });

  it("hints include the session titles and aliases the user has", async () => {
    await api("POST", "/v1/sessions", { title: "Recipe Box admin", projectPath: os.tmpdir() });
    const { status, json } = await api("GET", "/v1/voice/hints");
    assert.equal(status, 200);
    assert.ok(json.strings.includes("Recipe Box admin"));
    assert.ok(json.strings.includes("Helix"));
  });
});
