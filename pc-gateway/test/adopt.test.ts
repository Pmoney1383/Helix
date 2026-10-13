import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const ORIGINAL = "aaaaaaaa-1111-4222-8333-000000000001";
const CODEX = "bbbbbbbb-1111-4222-8333-000000000002";
const j = (o: unknown) => JSON.stringify(o) + "\n";

let gw: Gateway;
let base: string;
let token: string;
let root: string;
let projectDir: string;
let claudeHome: string;
const provider = new FakeProvider();
const alive = new Set<number>();

const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const until = async (fn: () => boolean) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(fn(), "timed out"); };

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-adopt-"));
  projectDir = path.join(root, "my-project");
  fs.mkdirSync(projectDir);
  claudeHome = path.join(root, ".claude");
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(path.join(claudeHome, "projects", "p"), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(codexHome, "sessions", "2026", "09", "28"), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, "projects", "p", `${ORIGINAL}.jsonl`),
    j({ type: "user", timestamp: "2026-10-01T10:00:00Z", cwd: projectDir, message: { content: "Build the login page" } }) +
    j({ type: "assistant", timestamp: "2026-10-01T10:00:05Z", message: { model: "m", content: [{ type: "text", text: "Done." }] } }) +
    j({ type: "ai-title", aiTitle: "Login page" }));
  fs.writeFileSync(path.join(codexHome, "sessions", "2026", "09", "28", `rollout-2026-09-28T22-40-57-${CODEX}.jsonl`),
    j({ type: "session_meta", timestamp: "2026-09-28T22:40:57Z", payload: { id: CODEX, cwd: projectDir } }) +
    j({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }));

  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", discovery: { homes: { claudeHome, codexHome } } }, openDb(":memory:"), { claude: provider });
  // make "is this pid alive" controllable
  (gw.indexer as any).alive = (pid: number) => alive.has(pid);
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  const { code } = gw.auth.createPairingCode();
  token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  await gw.indexer!.scan();
});
after(async () => { await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

const setLive = (on: boolean) => {
  const f = path.join(claudeHome, "sessions", "9001.json");
  if (on) { fs.writeFileSync(f, JSON.stringify({ pid: 9001, sessionId: ORIGINAL, status: "idle", name: "term" })); alive.add(9001); }
  else { alive.delete(9001); fs.rmSync(f, { force: true }); }
  gw.indexer!.refreshLive();
};

describe("adopting an existing session", () => {
  it("resumes the very same conversation when nothing else has it open", async () => {
    const r = await api("POST", `/v1/agent-sessions/claude/${ORIGINAL}/adopt`, {});
    assert.equal(r.status, 201);
    assert.equal(r.json.mode, "resume");
    assert.equal(r.json.session.providerSessionId, ORIGINAL);
    assert.equal(r.json.session.title, "Login page");
    assert.equal(r.json.session.projectPath, projectDir);

    const sent = await api("POST", `/v1/sessions/${r.json.session.id}/message`, { text: "add a remember-me checkbox" });
    assert.equal(sent.status, 202);
    await until(() => provider.calls.some((c) => c.text.includes("remember-me")));
    const call = provider.calls.find((c) => c.text.includes("remember-me"))!;
    assert.equal(call.resume, true, "continues the existing conversation");
    assert.equal(call.providerSessionId, ORIGINAL);
    assert.equal(call.forkFrom, undefined);
    assert.equal(call.projectPath, projectDir, "runs in the session's own project folder");
  });

  it("is idempotent: adopting again returns the same Helix session", async () => {
    const a = await api("POST", `/v1/agent-sessions/claude/${ORIGINAL}/adopt`, {});
    const b = await api("POST", `/v1/agent-sessions/claude/${ORIGINAL}/adopt`, {});
    assert.equal(a.json.session.id, b.json.session.id);
    assert.match(b.json.note, /already managed/);
    const listed = await api("GET", "/v1/agent-sessions?provider=claude");
    assert.equal(listed.json.sessions[0].managed, true);
    assert.equal(listed.json.sessions[0].helixSessionId, a.json.session.id);
  });
});

describe("a session that is open in a terminal", () => {
  let forkId: string;
  let forkProviderId: string;

  it("auto mode forks instead of colliding with the terminal", async () => {
    // fresh gateway state for this session: pretend it was never adopted
    (gw.manager.registry as any)["db"].prepare("DELETE FROM sessions").run();
    setLive(true);

    const r = await api("POST", `/v1/agent-sessions/claude/${ORIGINAL}/adopt`, { mode: "auto" });
    assert.equal(r.status, 201);
    assert.equal(r.json.mode, "fork");
    assert.match(r.json.note, /open in a terminal/);
    assert.notEqual(r.json.session.providerSessionId, ORIGINAL, "the fork gets its own session id");
    assert.equal(r.json.session.forkFrom, ORIGINAL);
    assert.match(r.json.session.title, /\(fork\)$/);
    forkId = r.json.session.id;
    forkProviderId = r.json.session.providerSessionId;
  });

  it("the first turn forks from the original; later turns just continue the fork", async () => {
    await api("POST", `/v1/sessions/${forkId}/message`, { text: "fork turn one" });
    await until(() => provider.calls.some((c) => c.text === "fork turn one"));
    const first = provider.calls.find((c) => c.text === "fork turn one")!;
    assert.equal(first.forkFrom, ORIGINAL);
    assert.equal(first.providerSessionId, forkProviderId);

    await until(() => gw.manager.registry.get(forkId)?.status === "idle" && gw.manager.registry.get(forkId)?.turnCount === 1);
    assert.equal(gw.manager.registry.get(forkId)?.forkFrom, undefined, "no longer pending once the branch exists");

    await api("POST", `/v1/sessions/${forkId}/message`, { text: "fork turn two" });
    await until(() => provider.calls.some((c) => c.text === "fork turn two"));
    const second = provider.calls.find((c) => c.text === "fork turn two")!;
    assert.equal(second.forkFrom, undefined);
    assert.equal(second.resume, true);
    assert.equal(second.providerSessionId, forkProviderId, "continues the branch, never the original");
  });

  it("refuses to resume the original while the terminal has it open, and says why", async () => {
    (gw.manager.registry as any)["db"].prepare("DELETE FROM sessions").run();
    const r = await api("POST", `/v1/agent-sessions/claude/${ORIGINAL}/adopt`, { mode: "resume" });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /open in a terminal \(pid 9001\)/);
    assert.match(r.json.error, /Fork it instead/);
  });

  it("explicit fork works even when nothing has it open, and once the terminal closes resume is allowed again", async () => {
    setLive(false);
    const f = await api("POST", `/v1/agent-sessions/claude/${ORIGINAL}/adopt`, { mode: "fork", title: "My branch" });
    assert.equal(f.status, 201);
    assert.equal(f.json.mode, "fork");
    assert.equal(f.json.session.title, "My branch");
    const r = await api("POST", `/v1/agent-sessions/claude/${ORIGINAL}/adopt`, { mode: "resume" });
    assert.equal(r.status, 201);
    assert.equal(r.json.session.providerSessionId, ORIGINAL);
  });
});

describe("what cannot be adopted", () => {
  it("Codex sessions are visible, but cannot be continued unless the Codex provider is available", async () => {
    assert.equal((await api("GET", `/v1/agent-sessions/codex/${CODEX}`)).status, 200);
    const r = await api("POST", `/v1/agent-sessions/codex/${CODEX}/adopt`, {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /provider "codex" is not available/);
  });

  it("unknown sessions 404 and vanished project folders are reported", async () => {
    assert.equal((await api("POST", "/v1/agent-sessions/claude/ffffffff-0000-4000-8000-000000000000/adopt", {})).status, 404);
    fs.rmSync(projectDir, { recursive: true, force: true });
    (gw.manager.registry as any)["db"].prepare("DELETE FROM sessions").run();
    const r = await api("POST", `/v1/agent-sessions/claude/${ORIGINAL}/adopt`, {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /no longer exists/);
  });
});
