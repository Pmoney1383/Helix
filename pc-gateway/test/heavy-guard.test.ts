import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const BIG = "cccccccc-1111-4222-8333-000000000001";
const SMALL = "cccccccc-1111-4222-8333-000000000002";
const j = (o: unknown) => JSON.stringify(o) + "\n";

let gw: Gateway;
let base: string;
let token: string;
let root: string;
const provider = new FakeProvider();

const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const transcript = (id: string, tokens: number, ageMs: number) =>
  j({ type: "user", timestamp: new Date(Date.now() - ageMs - 5000).toISOString(), cwd: root, message: { content: "hi" } }) +
  j({ type: "assistant", timestamp: new Date(Date.now() - ageMs).toISOString(), message: { id: "m1", model: "m", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 5 } } });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-heavy-"));
  const claudeHome = path.join(root, ".claude");
  fs.mkdirSync(path.join(claudeHome, "projects", "p"), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, "projects", "p", `${BIG}.jsonl`), transcript(BIG, 400_000, 30 * 60_000)); // 400k, cache long gone
  fs.writeFileSync(path.join(claudeHome, "projects", "p", `${SMALL}.jsonl`), transcript(SMALL, 20_000, 30 * 60_000));
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", discovery: { homes: { claudeHome, codexHome: path.join(root, ".codex") } } }, openDb(":memory:"), { claude: provider });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  const { code } = gw.auth.createPairingCode();
  token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
});
after(async () => { await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

const adopt = async (id: string, mode: string) =>
  gw.manager.registry.findByProviderId("claude", id) ??
  gw.manager.registry.create({ provider: "claude", providerSessionId: mode === "fork" ? "dddddddd-1111-4222-8333-000000000009" : id, title: "t", projectPath: root, imported: true, forkFrom: mode === "fork" ? id : undefined });

describe("heavy session guard", () => {
  it("refuses to quietly continue a huge session whose cache has expired, and says why", async () => {
    const s = await adopt(BIG, "resume");
    const r = await api("POST", `/v1/sessions/${s.id}/message`, { text: "hello" });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "heavy_session");
    assert.equal(r.json.contextTokens, 400_010);
    assert.equal(r.json.reason, "cold");
    const check = await api("GET", `/v1/sessions/${s.id}/cost-check`);
    assert.equal(check.json.heavy, true);
  });

  it("goes ahead once the client confirms", async () => {
    const s = await adopt(BIG, "resume");
    const r = await api("POST", `/v1/sessions/${s.id}/message`, { text: "hello", confirmHeavy: true });
    assert.equal(r.status, 202);
  });

  it("does not interfere with a small session", async () => {
    const s = await adopt(SMALL, "resume");
    const r = await api("POST", `/v1/sessions/${s.id}/message`, { text: "hello" });
    assert.equal(r.status, 202);
  });

  it("treats a fork of a huge session as heavy even when the original was just used", async () => {
    fs.writeFileSync(path.join(root, ".claude", "projects", "p", `${BIG}.jsonl`), transcript(BIG, 400_000, 1000));
    const s = gw.manager.registry.create({ provider: "claude", providerSessionId: "dddddddd-1111-4222-8333-000000000009", title: "f", projectPath: root, forkFrom: BIG });
    const r = await api("POST", `/v1/sessions/${s.id}/message`, { text: "hello" });
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, "fork");
  });

  it("reports usage per session", async () => {
    const r = await api("GET", "/v1/usage?hours=1");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.sessions));
  });
});

describe("heavy session guard after a compact", () => {
  it("measures the compacted size, not the reply from before the compact", async () => {
    const COMPACTED = "cccccccc-1111-4222-8333-000000000010";
    const file = path.join(root, ".claude", "projects", "p", `${COMPACTED}.jsonl`);
    fs.writeFileSync(file, transcript(COMPACTED, 745_000, 30 * 60_000) +
      j({ type: "system", subtype: "compact_boundary", timestamp: new Date(Date.now() - 20 * 60_000).toISOString(), compactMetadata: { trigger: "manual", preTokens: 745_234, postTokens: 8_468 } }) +
      j({ type: "user", isCompactSummary: true, timestamp: new Date(Date.now() - 20 * 60_000).toISOString(), message: { content: "summary" } }));
    const s = await adopt(COMPACTED, "resume");
    const r = await api("POST", `/v1/sessions/${s.id}/message`, { text: "hello" });
    assert.equal(r.status, 202);
    assert.equal((await api("GET", `/v1/sessions/${s.id}/cost-check`)).json.heavy, false);
  });
});
