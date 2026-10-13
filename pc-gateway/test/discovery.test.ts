import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SessionIndexer } from "../src/discovery/indexer.js";
import { applyClaudeLine, applyCodexLine, emptyAgg } from "../src/discovery/parsers.js";
import { EventBus } from "../src/sessions/manager.js";
import { openDb } from "../src/storage/sqlite.js";
import type { GatewayEvent } from "../src/types.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";

const CLAUDE_ID = "11111111-aaaa-4bbb-8ccc-000000000001";
const CLAUDE_ID2 = "22222222-aaaa-4bbb-8ccc-000000000002";
const CODEX_ID = "33333333-aaaa-4bbb-8ccc-000000000003";
const j = (o: unknown) => JSON.stringify(o) + "\n";

function homes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-disc-"));
  const claudeHome = path.join(root, ".claude");
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(path.join(claudeHome, "projects", "C--proj-alpha"), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(codexHome, "sessions", "2026", "09", "28"), { recursive: true });
  return { root, claudeHome, codexHome };
}

const claudeFile = (h: ReturnType<typeof homes>, id = CLAUDE_ID) => path.join(h.claudeHome, "projects", "C--proj-alpha", `${id}.jsonl`);
const codexFile = (h: ReturnType<typeof homes>) => path.join(h.codexHome, "sessions", "2026", "09", "28", `rollout-2026-09-28T22-40-57-${CODEX_ID}.jsonl`);

const claudeSession = (ts = "2026-10-01T10:00:00.000Z") =>
  j({ type: "user", timestamp: ts, cwd: "C:\\proj\\alpha", gitBranch: "main", version: "2.1.0", sessionId: CLAUDE_ID, message: { role: "user", content: "Refactor the auth module please" } }) +
  j({ type: "assistant", timestamp: "2026-10-01T10:00:05.000Z", cwd: "C:\\proj\\alpha", message: { model: "claude-sonnet-5-5", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "On it. Reading the files first." }, { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } }] } }) +
  j({ type: "user", timestamp: "2026-10-01T10:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", content: "file contents" }] } }) +
  j({ type: "assistant", timestamp: "2026-10-01T10:00:09.000Z", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "Done: extracted a TokenService." }] } }) +
  j({ type: "ai-title", aiTitle: "Refactor auth module", sessionId: CLAUDE_ID });

const codexSession = () =>
  j({ timestamp: "2026-09-29T05:40:57.755Z", type: "session_meta", payload: { id: CODEX_ID, cwd: "C:\\proj\\beta", cli_version: "0.158.0", timestamp: "2026-09-29T05:40:57.755Z" } }) +
  j({ timestamp: "2026-09-29T05:41:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: "C:\\proj\\beta" } }) +
  j({ timestamp: "2026-09-29T05:41:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }) +
  j({ timestamp: "2026-09-29T05:41:02.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "system rules" }] } }) +
  j({ timestamp: "2026-09-29T05:41:03.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for x" }] } }) +
  j({ timestamp: "2026-09-29T05:41:04.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the failing webhook test" }] } }) +
  j({ timestamp: "2026-09-29T05:41:09.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":\"npm test\"}" } }) +
  j({ timestamp: "2026-09-29T05:41:20.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed the test by awaiting the handler." }] } }) +
  j({ timestamp: "2026-09-29T05:41:21.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } });

describe("parsers", () => {
  it("claude: counts real prompts and replies, not tool plumbing, thinking or sub-agent chatter", () => {
    const a = emptyAgg();
    for (const l of claudeSession().trim().split("\n")) applyClaudeLine(a, JSON.parse(l));
    applyClaudeLine(a, { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub-agent noise" }] } });
    applyClaudeLine(a, { type: "user", message: { content: "<system-reminder>injected</system-reminder>" } });
    assert.equal(a.messageCount, 3);
    assert.equal(a.title, "Refactor auth module");
    assert.equal(a.projectPath, "C:\\proj\\alpha");
    assert.equal(a.gitBranch, "main");
    assert.equal(a.model, "claude-sonnet-5-5");
    assert.equal(a.firstUser, "Refactor the auth module please");
    assert.equal(a.lastAssistant, "Done: extracted a TokenService.");
    assert.equal(a.createdAt, "2026-10-01T10:00:00.000Z");
    assert.equal(a.lastActivityAt, "2026-10-01T10:00:09.000Z");
  });

  it("codex: reads meta, messages and turn state, skipping injected context", () => {
    const a = emptyAgg();
    for (const l of codexSession().trim().split("\n")) applyCodexLine(a, JSON.parse(l));
    assert.equal(a.messageCount, 2);
    assert.equal(a.firstUser, "Fix the failing webhook test");
    assert.equal(a.lastAssistant, "Fixed the test by awaiting the handler.");
    assert.equal(a.model, "gpt-5.6-sol");
    assert.equal(a.projectPath, "C:\\proj\\beta");
    assert.equal(a.taskState, "idle");
  });

  it("tolerates garbage and unknown shapes without throwing", () => {
    const a = emptyAgg();
    for (const x of [null, 42, "str", {}, { type: "user" }, { type: "assistant", message: null }, { type: "response_item", payload: 5 }]) {
      applyClaudeLine(a, x as any);
      applyCodexLine(a, x as any);
    }
    assert.equal(a.messageCount, 0);
  });
});

describe("indexer", () => {
  let h: ReturnType<typeof homes>;
  let bus: EventBus;
  let events: GatewayEvent[];
  let db: ReturnType<typeof openDb>;
  let indexer: SessionIndexer;
  let now: number;
  const alivePids = new Set<number>();

  before(async () => {
    h = homes();
    fs.writeFileSync(claudeFile(h), claudeSession());
    fs.writeFileSync(codexFile(h), codexSession());
    fs.writeFileSync(path.join(h.codexHome, "session_index.jsonl"), j({ id: CODEX_ID, thread_name: "Webhook test fix", updated_at: "2026-09-29T05:41:21Z" }));
    // a session with nothing said, and a file that is not a session
    fs.writeFileSync(claudeFile(h, CLAUDE_ID2), j({ type: "mode", mode: "x", sessionId: CLAUDE_ID2 }));
    fs.writeFileSync(path.join(h.claudeHome, "projects", "C--proj-alpha", "notes.jsonl"), "{}\n");
    db = openDb(":memory:");
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
    now = Date.now();
    indexer = new SessionIndexer(db, bus, { homes: h, now: () => now, alive: (pid) => alivePids.has(pid) });
    await indexer.scan();
  });
  after(() => fs.rmSync(h.root, { recursive: true, force: true }));

  it("finds sessions from both tools that Helix never started", () => {
    const all = indexer.list();
    assert.deepEqual(all.map((s) => s.key).sort(), [`claude:${CLAUDE_ID}`, `codex:${CODEX_ID}`].sort());
    const c = indexer.get("claude", CLAUDE_ID)!;
    assert.equal(c.title, "Refactor auth module");
    assert.equal(c.projectName, "alpha");
    assert.equal(c.messageCount, 3);
    assert.equal(c.managed, false);
    assert.equal(c.preview, "Done: extracted a TokenService.");
    const x = indexer.get("codex", CODEX_ID)!;
    assert.equal(x.title, "Webhook test fix", "Codex titles come from its session index");
    assert.equal(x.projectName, "beta");
  });

  it("hides empty sessions by default but can show them", () => {
    assert.equal(indexer.list().length, 2);
    assert.equal(indexer.list({ minMessages: 0 }).length, 3);
  });

  it("filters by provider, text and project", () => {
    assert.deepEqual(indexer.list({ provider: "codex" }).map((s) => s.id), [CODEX_ID]);
    assert.equal(indexer.list({ q: "webhook" }).length, 1);
    assert.equal(indexer.list({ q: "TokenService" })[0]?.provider, "claude");
    assert.equal(indexer.list({ project: "beta" }).length, 1);
    assert.equal(indexer.list({ q: "nothing-like-this" }).length, 0);
  });

  it("incremental: appended lines are picked up, a half-written line waits for its newline", async () => {
    const before = indexer.get("claude", CLAUDE_ID)!.messageCount;
    const partial = JSON.stringify({ type: "user", timestamp: "2026-10-01T11:00:00.000Z", message: { role: "user", content: "Now add tests" } });
    fs.appendFileSync(claudeFile(h), partial.slice(0, 30));
    await indexer.scan();
    assert.equal(indexer.get("claude", CLAUDE_ID)!.messageCount, before, "incomplete line not counted");
    fs.appendFileSync(claudeFile(h), partial.slice(30) + "\n");
    fs.utimesSync(claudeFile(h), new Date(), new Date(Date.now() + 2000));
    await indexer.scan();
    const c = indexer.get("claude", CLAUDE_ID)!;
    assert.equal(c.messageCount, before + 1);
    assert.equal(c.lastUser, "Now add tests");
    assert.equal(c.title, "Refactor auth module", "earlier metadata survives incremental parsing");
  });

  it("a rewritten (smaller) transcript is re-read from scratch", async () => {
    fs.writeFileSync(claudeFile(h, CLAUDE_ID2), j({ type: "user", timestamp: "2026-10-01T12:00:00.000Z", cwd: "C:\\proj\\gamma", message: { content: "short" } }) + j({ type: "ai-title", aiTitle: "T1" }));
    await indexer.scan();
    assert.equal(indexer.get("claude", CLAUDE_ID2)!.messageCount, 1);
    fs.writeFileSync(claudeFile(h, CLAUDE_ID2), j({ type: "ai-title", aiTitle: "Rewritten" }));
    fs.utimesSync(claudeFile(h, CLAUDE_ID2), new Date(), new Date(Date.now() + 5000));
    await indexer.scan();
    const s = indexer.get("claude", CLAUDE_ID2)!;
    assert.equal(s.messageCount, 0);
    assert.equal(s.title, "Rewritten");
  });

  it("live status comes from Claude's registry and ignores dead processes", () => {
    const reg = (pid: number, sessionId: string, status: string) =>
      fs.writeFileSync(path.join(h.claudeHome, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, status, name: "my-terminal", kind: "interactive", statusUpdatedAt: now - 5000 }));
    db.prepare("UPDATE discovered_sessions SET file_mtime_ms = ? WHERE key = ?").run(now - 60 * 60_000, `codex:${CODEX_ID}`); // quiet Codex transcript
    reg(4001, CLAUDE_ID, "busy");
    reg(4002, CLAUDE_ID2, "idle"); // process is gone
    alivePids.add(4001);
    events.length = 0;
    indexer.refreshLive();
    const c = indexer.get("claude", CLAUDE_ID)!;
    assert.equal(c.live, true);
    assert.equal(c.liveStatus, "busy");
    assert.equal(c.livePid, 4001);
    assert.equal(c.liveName, "my-terminal");
    assert.equal(indexer.get("claude", CLAUDE_ID2)!.live, false, "stale registry entry for a dead pid");
    assert.deepEqual(indexer.list({ live: true }).map((s) => s.id), [CLAUDE_ID]);
    assert.ok(events.some((e) => e.type === "agent.session.changed" && e.session.liveStatus === "busy"), "phone is told");

    reg(4001, CLAUDE_ID, "idle");
    events.length = 0;
    indexer.refreshLive();
    assert.equal(indexer.get("claude", CLAUDE_ID)!.liveStatus, "idle");
    assert.equal(events.filter((e) => e.type === "agent.session.changed").length, 1, "one event per transition");
    indexer.refreshLive();
    assert.equal(events.filter((e) => e.type === "agent.session.changed").length, 1, "no event when nothing changed");

    alivePids.delete(4001);
    indexer.refreshLive();
    assert.equal(indexer.get("claude", CLAUDE_ID)!.live, false, "closed terminal");
  });

  it("codex liveness is inferred from recent transcript activity and is labelled as a guess", () => {
    fs.utimesSync(codexFile(h), new Date(now), new Date(now));
    db.prepare("UPDATE discovered_sessions SET file_mtime_ms = ? WHERE key = ?").run(now - 30_000, `codex:${CODEX_ID}`);
    indexer.refreshLive();
    const x = indexer.get("codex", CODEX_ID)!;
    assert.equal(x.live, true);
    assert.equal(x.liveInferred, true);
    db.prepare("UPDATE discovered_sessions SET file_mtime_ms = ? WHERE key = ?").run(now - 10 * 60_000, `codex:${CODEX_ID}`);
    indexer.refreshLive();
    assert.equal(indexer.get("codex", CODEX_ID)!.live, false);
  });

  it("announces newly discovered sessions after the first scan (not during it)", async () => {
    const id = "44444444-aaaa-4bbb-8ccc-000000000004";
    events.length = 0;
    fs.writeFileSync(claudeFile(h, id), j({ type: "user", timestamp: "2026-10-01T13:00:00.000Z", cwd: "C:\\proj\\delta", message: { content: "hello" } }));
    await indexer.scan();
    assert.ok(events.some((e) => e.type === "agent.session.changed" && e.session.id === id));
  });

  it("renders a readable transcript with paging, hiding tool plumbing", () => {
    const t = indexer.transcript("claude", CLAUDE_ID)!;
    assert.deepEqual(t.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant", "user"]);
    assert.equal(t.messages[2]!.tool, "Read");
    assert.match(t.messages[2]!.text, /src\/auth\.ts/);
    assert.ok(!t.messages.some((m) => /file contents|hmm/.test(m.text)), "no tool results or hidden reasoning");
    const page = indexer.transcript("claude", CLAUDE_ID, { limit: 2 })!;
    assert.equal(page.messages.length, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.messages[1]!.index, t.total - 1);
    const older = indexer.transcript("claude", CLAUDE_ID, { before: page.messages[0]!.index, limit: 10 })!;
    assert.equal(older.messages.at(-1)!.index, page.messages[0]!.index - 1);

    const cx = indexer.transcript("codex", CODEX_ID)!;
    assert.deepEqual(cx.messages.map((m) => m.role), ["user", "tool", "assistant"]);
    assert.equal(indexer.transcript("claude", "00000000-0000-4000-8000-000000000000"), undefined);
  });

  it("links sessions Helix manages", async () => {
    db.prepare("INSERT INTO sessions (id, provider, provider_session_id, title, status, managed, turn_count, created_at, last_activity_at) VALUES ('h1','claude',?, 'x','idle',1,1,'t','t')").run(CLAUDE_ID);
    const c = indexer.get("claude", CLAUDE_ID)!;
    assert.equal(c.managed, true);
    assert.equal(c.helixSessionId, "h1");
  });
});

describe("discovery API", () => {
  let gw: Gateway;
  let base: string;
  let token: string;
  let h: ReturnType<typeof homes>;

  before(async () => {
    h = homes();
    fs.writeFileSync(claudeFile(h), claudeSession());
    fs.writeFileSync(codexFile(h), codexSession());
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", discovery: { homes: h } }, openDb(":memory:"), { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  });
  after(async () => { await gw.app.close(); fs.rmSync(h.root, { recursive: true, force: true }); });

  const get = async (p: string, auth = true) => {
    const r = await fetch(base + p, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.status, json: (await r.json()) as any };
  };

  it("requires auth, lists sessions, and serves details and transcripts", async () => {
    assert.equal((await get("/v1/agent-sessions", false)).status, 401);
    const rescan = await fetch(base + "/v1/agent-sessions/rescan", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.equal(rescan.status, 200);

    const list = await get("/v1/agent-sessions");
    assert.equal(list.json.sessions.length, 2);
    assert.ok(!JSON.stringify(list.json).includes("source_file"), "no filesystem internals in the API");

    assert.equal((await get(`/v1/agent-sessions/claude/${CLAUDE_ID}`)).json.title, "Refactor auth module");
    assert.equal((await get(`/v1/agent-sessions/codex/${CODEX_ID}`)).status, 200);
    assert.equal((await get(`/v1/agent-sessions/claude/${CODEX_ID}`)).status, 404, "provider is part of the identity");
    assert.equal((await get(`/v1/agent-sessions/nope/${CODEX_ID}`)).status, 400);

    const t = await get(`/v1/agent-sessions/claude/${CLAUDE_ID}/transcript?limit=3`);
    assert.equal(t.json.messages.length, 3);
    assert.equal(t.json.hasMore, true);

    assert.equal((await get("/v1/agent-sessions?provider=codex")).json.sessions.length, 1);
    assert.equal((await get("/v1/agent-sessions?q=webhook")).json.sessions.length, 1);
  });
});
