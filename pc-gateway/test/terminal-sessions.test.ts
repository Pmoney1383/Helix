import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { shortCommand, trackAgentProcesses, type ProcSnap, type TrackedProc } from "../src/monitoring/agent-processes.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";
import type { GatewayEvent } from "../src/types.js";

const SID = "cccccccc-1111-4222-8333-000000000001";
const SID_H = "dddddddd-1111-4222-8333-000000000002";
const j = (o: unknown) => JSON.stringify(o) + "\n";
const MIN = 60_000;

/* ------------------------------------------------------------------ process tracker (pure) */

describe("agent process tracker", () => {
  const T0 = Date.parse("2026-10-01T12:00:00Z");
  const p = (pid: number, ppid: number, name: string, cmd: string, ageMs: number, now = T0 + 60 * MIN): ProcSnap =>
    ({ pid, ppid, name, cmd, createdMs: now - ageMs });
  const claude = p(100, 1, "claude.exe", "claude", 120 * MIN);
  const run = (snapshot: ProcSnap[], tracked: Record<string, TrackedProc> = {}, extra: Partial<Parameters<typeof trackAgentProcesses>[0]> = {}) =>
    trackAgentProcesses({ snapshot, tracked, now: T0 + 60 * MIN, minRuntimeMs: 60_000, covered: new Set(), ownerNames: new Map([[100, 'Claude "Atlas training"']]), ...extra });

  it("tracks the real program under a shell, ignores the shell and the program's own workers", () => {
    const snap = [
      claude,
      p(101, 100, "bash.exe", "bash -c 'python train.py'", 30 * MIN),
      p(102, 101, "python.exe", "python train.py --steps 100000", 30 * MIN),
      p(103, 102, "python.exe", "python -c multiprocessing spawn", 29 * MIN), // dataloader worker
      p(104, 102, "python.exe", "python -c multiprocessing spawn", 29 * MIN),
    ];
    const r = run(snap);
    assert.deepEqual(r.started.map((s) => s.name), ["python.exe"]);
    assert.equal(Object.keys(r.tracked).length, 1);
    assert.equal(Object.values(r.tracked)[0]!.owner, 'Claude "Atlas training"');
  });

  it("does not track short-lived commands or known helper servers", () => {
    const snap = [
      claude,
      p(101, 100, "node.exe", "node C:\\x\\mcp-server.js --stdio", 100 * MIN),
      p(103, 100, "cmd.exe", "cmd /c npm test", 20_000),
      p(104, 103, "node.exe", "node test-runner.js", 20_000), // only 20s old
      p(105, 100, "rg.exe", "rg foo", 10 * MIN),
    ];
    assert.equal(run(snap).started.length, 0);
  });

  it("a process that dies together with its agent (every MCP server, on session close) is not news", () => {
    const first = run([claude, p(102, 100, "node.exe", "node C:\\tools\\whatever-server.js", 50 * MIN)]);
    assert.equal(Object.keys(first.tracked).length, 1, "tracked while the agent lives");
    const closed = run([], first.tracked, { now: T0 + 70 * MIN }); // terminal closed: both vanish
    assert.equal(closed.ended.length, 0);
    assert.deepEqual(closed.tracked, {});
  });

  it("a job that ends while its agent is still running is news, and so is one that outlives it", () => {
    const job = p(102, 100, "python.exe", "python train.py", 30 * MIN);
    const first = run([claude, job]);
    assert.equal(run([claude], first.tracked, { now: T0 + 70 * MIN }).ended.length, 1, "finished while agent alive");

    // agent exits but the job keeps running...
    const orphaned = run([job], first.tracked, { now: T0 + 70 * MIN });
    assert.equal(orphaned.ended.length, 0);
    assert.equal(Object.values(orphaned.tracked)[0]!.ownerGone, true);
    // ...and later ends: now it is news
    const later = run([], orphaned.tracked, { now: T0 + 90 * MIN });
    assert.equal(later.ended.length, 1);
  });

  it("reports when a tracked process disappears, and distinguishes a reused pid", () => {
    const snap = [claude, p(102, 100, "python.exe", "python train.py", 30 * MIN)];
    const first = run(snap);
    // later: the process is gone
    const gone = run([claude], first.tracked, { now: T0 + 90 * MIN });
    assert.equal(gone.ended.length, 1);
    assert.equal(gone.ended[0]!.name, "python.exe");
    assert.equal(gone.ended[0]!.runMs, 60 * MIN, "ran from its start until we noticed");
    assert.deepEqual(gone.tracked, {});
    // pid 102 reused by a different, newer process: the old one is over
    const reused = run([claude, p(102, 100, "chrome.exe", "chrome", 1 * MIN, T0 + 90 * MIN)], first.tracked, { now: T0 + 90 * MIN });
    assert.equal(reused.ended.length, 1);
  });

  it("sees a job through the real Windows shell chain (claude -> cmd -> powershell -> program) even though the wrappers mention .claude", () => {
    const now = T0 + 60 * MIN;
    const agent = p(300, 1, "claude.exe", "claude.exe -p run", 5 * MIN);
    const snap = [
      agent,
      p(301, 300, "cmd.exe", "cmd.exe /d /s /c \"npx -y @gitkraken/gk mcp --plugin --host=claude\"", 5 * MIN),       // MCP launcher, at agent start
      p(302, 301, "node.exe", "node C:\\npm-cache\\gk.js mcp", 5 * MIN),
      p(310, 300, "cmd.exe", "cmd.exe /d /s /c \"chcp.com 65001 >nul & powershell.exe -NoProfile ...\"", 90_000),
      p(311, 310, "powershell.exe", "powershell.exe -NoProfile -File C:\\Users\\u\\.claude\\shell-snapshots\\x.ps1", 90_000),
      p(312, 311, "PING.EXE", "PING.EXE -n 40 127.0.0.1", 80_000),
      p(320, 300, "bash.exe", "bash.exe -c \"source /c/Users/u/.claude/shell-snapshots/snapshot.sh && python train.py\"", 90_000),
      p(321, 320, "python.exe", "python train.py", 85_000),
      p(330, 300, "node.exe", "node C:\\Users\\u\\.claude\\plugins\\cache\\server.js", 5 * MIN - 60_000), // a plugin program under the agent's home
    ];
    const r = run(snap, {}, { now, ownerNames: new Map([[300, "Claude"]]) });
    assert.deepEqual(r.started.map((s) => s.name).sort(), ["PING.EXE", "python.exe"]);
  });

  it("keeps tracking after its agent exits (the job outlives the terminal)", () => {
    const job = p(102, 100, "python.exe", "python train.py", 30 * MIN);
    const first = run([claude, job]);
    const orphaned = run([job], first.tracked); // same process (same start time), agent gone
    assert.equal(orphaned.ended.length, 0, "still running, just orphaned");
  });

  it("skips processes an explicit watch already covers", () => {
    const r = run([claude, p(102, 100, "python.exe", "python train.py", 30 * MIN)], {}, { covered: new Set([102]) });
    assert.equal(r.started.length, 0);
  });

  it("handles nested shells and tolerates cycles / bad data", () => {
    const snap = [claude, p(101, 100, "powershell.exe", "pwsh", 30 * MIN), p(102, 101, "cmd.exe", "cmd", 30 * MIN), p(103, 102, "ffmpeg.exe", "ffmpeg -i in.mp4 out.mp4", 30 * MIN), p(200, 200, "weird.exe", "x", 30 * MIN)];
    assert.deepEqual(run(snap).started.map((s) => s.name), ["ffmpeg.exe"]);
  });

  it("describes commands compactly", () => {
    assert.equal(shortCommand("python.exe", '"C:\\Python311\\python.exe" train.py --steps 1000'), "python.exe train.py --steps 1000");
    assert.equal(shortCommand("node.exe", "node C:\\Users\\me\\proj\\scripts\\build.js"), "node build.js");
    assert.ok(shortCommand("x.exe", "x " + "a".repeat(300)).length <= 90);
    assert.equal(shortCommand("a.exe", ""), "a.exe");
  });
});

/* ------------------------------------------------------------------ gateway integration */

describe("terminal sessions reach the phone", () => {
  let root: string;
  let claudeHome: string;
  let projectDir: string;
  let gw: Gateway;
  let base: string;
  let localToken: string;
  let deviceToken: string;
  let events: GatewayEvent[];
  const transcript = () => path.join(claudeHome, "projects", "p", `${SID}.jsonl`);
  const hookTranscript = () => path.join(claudeHome, "projects", "p", `${SID_H}.jsonl`);
  const alive = new Set<number>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn: () => boolean) => { for (let i = 0; i < 300 && !fn(); i++) await sleep(10); assert.ok(fn(), "timed out"); };

  const post = async (p: string, body: unknown, token: string) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const registry = (status: string, since: number) =>
    fs.writeFileSync(path.join(claudeHome, "sessions", "7001.json"), JSON.stringify({ pid: 7001, sessionId: SID, status, name: "my-terminal", kind: "interactive", statusUpdatedAt: since }));
  const infoEvents = () => events.filter((e) => e.type === "watch.triggered");

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-term-"));
    claudeHome = path.join(root, ".claude");
    projectDir = path.join(root, "atlas");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(path.join(claudeHome, "projects", "p"), { recursive: true });
    fs.mkdirSync(path.join(claudeHome, "sessions"), { recursive: true });
    const started = new Date(Date.now() - 20 * MIN).toISOString();
    fs.writeFileSync(transcript(),
      j({ type: "user", timestamp: started, cwd: projectDir, message: { content: "Train the cat model overnight" } }) +
      j({ type: "assistant", timestamp: new Date(Date.now() - 19 * MIN).toISOString(), message: { model: "m", content: [{ type: "text", text: "Training finished: final loss 0.12, checkpoint saved." }] } }) +
      j({ type: "ai-title", aiTitle: "Cat model training" }));

    fs.writeFileSync(hookTranscript(),
      j({ type: "user", timestamp: new Date(Date.now() - 7 * MIN).toISOString(), cwd: projectDir, message: { content: "Run the full test suite and fix failures" } }) +
      j({ type: "assistant", timestamp: new Date(Date.now() - 6 * MIN).toISOString(), message: { model: "m", content: [{ type: "text", text: "All 214 tests pass after fixing the flaky one." }] } }) +
      j({ type: "ai-title", aiTitle: "Fix flaky tests" }));
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", discovery: { homes: { claudeHome, codexHome: path.join(root, ".codex") } } }, openDb(":memory:"), { claude: new FakeProvider() });
    (gw.indexer as any).alive = (pid: number) => alive.has(pid);
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    deviceToken = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
    localToken = gw.localTokens.create("terminal-agents").token;
    gw.watchers.ensureDefaults();
    events = [];
    gw.manager.bus.subscribe((e) => events.push(e));
    await gw.indexer!.scan();
  });
  after(async () => { await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("seeds both always-on watches", () => {
    assert.deepEqual(gw.watchers.list().map((w) => w.type).sort(), ["agentprocs", "session"]);
  });

  it("a finished terminal turn (no hooks, no cooperation) is announced from the live registry", async () => {
    alive.add(7001);
    registry("busy", Date.now() - 15 * MIN);
    gw.indexer!.refreshLive(); // learns the terminal is mid-turn
    events.length = 0;
    registry("idle", Date.now());
    gw.indexer!.refreshLive(); // ...and that it just finished
    await until(() => infoEvents().length > 0);
    const ev = infoEvents()[0] as any;
    assert.match(ev.event.summary, /Claude finished "Cat model training" \(atlas\) after 15 min/);
    assert.equal(ev.event.severity, "important");
    assert.match(ev.event.detail, /final loss 0\.12/, "the actual result, not just 'done'");
  });

  it("a terminal that dies mid-task is reported as a failure", async () => {
    registry("busy", Date.now() - 10 * MIN);
    gw.indexer!.refreshLive();
    events.length = 0;
    alive.delete(7001); // killed
    gw.indexer!.refreshLive();
    await until(() => infoEvents().length > 0);
    assert.match((infoEvents()[0] as any).event.summary, /failed after 10 min/);
    assert.match((infoEvents()[0] as any).event.detail, /ended while it was working/);
  });

  it("an open terminal that has gone silent while 'busy' triggers the stalled alert", async () => {
    alive.add(7001);
    registry("busy", Date.now() - 40 * MIN);
    gw.indexer!.refreshLive();
    db(gw).prepare("UPDATE discovered_sessions SET file_mtime_ms = ? WHERE key = ?").run(Date.now() - 30 * MIN, `claude:${SID}`);
    const watch = gw.watchers.list().find((w) => w.type === "session")!;
    events.length = 0;
    await gw.watchers.runNow(watch.id);
    assert.ok(infoEvents().some((e: any) => /no output for 30 min/.test(e.event.summary)), "stall detected for a session Helix does not run");
    alive.delete(7001);
    gw.indexer!.refreshLive();
  });

  describe("hooks (POST /v1/agent-events)", () => {
    it("rejects anything but a local token", async () => {
      const body = { provider: "claude", event: "stop", payload: { session_id: SID } };
      assert.equal((await post("/v1/agent-events", body, "nope")).status, 401);
      assert.equal((await post("/v1/agent-events", body, deviceToken)).status, 401, "a phone token cannot inject agent events");
      assert.equal((await fetch(base + "/v1/agent-events", { method: "POST" })).status, 401);
    });

    it("Stop: announces the finished turn using the transcript the hook points at", async () => {
      events.length = 0;
      const r = await post("/v1/agent-events", { provider: "claude", event: "stop", payload: { session_id: SID_H, cwd: projectDir, transcript_path: hookTranscript(), hook_event_name: "Stop" } }, localToken);
      assert.equal(r.status, 202);
      assert.match(((await r.json()) as any).outcome, /finished after 4\d\ds|finished after 3[5-9]\ds/, "turn length measured from the last prompt in the transcript");
      await until(() => infoEvents().length > 0);
      const ev = infoEvents()[0] as any;
      assert.match(ev.event.summary, /Claude finished "Fix flaky tests" \(atlas\) after 7 min/);
      assert.match(ev.event.detail, /All 214 tests pass/);
    });

    it("the same turn reported by both the registry and a hook is announced once", async () => {
      // SID_H was announced a moment ago by the previous test: a repeat of the same turn is dropped.
      events.length = 0;
      const body = { provider: "claude", event: "stop", payload: { session_id: SID_H, cwd: projectDir, transcript_path: hookTranscript() } };
      await post("/v1/agent-events", body, localToken);
      await post("/v1/agent-events", body, localToken);
      await sleep(30);
      assert.equal(infoEvents().length, 0, "duplicate suppressed");
    });

    it("Notification: 'Claude needs your permission' becomes an important alert with the message", async () => {
      events.length = 0;
      await post("/v1/agent-events", { provider: "claude", event: "notification", payload: { session_id: SID, cwd: projectDir, message: "Claude needs your permission to use Bash" } }, localToken);
      await until(() => infoEvents().length > 0);
      const ev = infoEvents()[0] as any;
      assert.match(ev.event.summary, /Claude needs you: "Cat model training"/);
      assert.equal(ev.event.severity, "important");
      assert.match(ev.event.detail, /permission to use Bash/);
    });

    it("ignores sessions Helix manages (their own claude -p also fires the user's hooks), unknown events and junk", async () => {
      const managed = await gw.manager.createSession({ provider: "claude", title: "managed", projectPath: os.tmpdir() });
      events.length = 0;
      const r1 = await (await post("/v1/agent-events", { provider: "claude", event: "stop", payload: { session_id: managed.providerSessionId } }, localToken)).json() as any;
      assert.match(r1.outcome, /managed by Helix/);
      const r2 = await (await post("/v1/agent-events", { provider: "claude", event: "pretooluse", payload: { session_id: SID } }, localToken)).json() as any;
      assert.match(r2.outcome, /not used/);
      const r3 = await (await post("/v1/agent-events", { provider: "claude", event: "stop", payload: {} }, localToken)).json() as any;
      assert.match(r3.outcome, /no session id/);
      const r4 = await (await post("/v1/agent-events", { provider: "claude", event: "notification", payload: { session_id: SID, message: "  " } }, localToken)).json() as any;
      assert.match(r4.outcome, /empty/);
      assert.equal((await post("/v1/agent-events", { provider: "bogus", event: "stop" }, localToken)).status, 400);
      await sleep(30);
      assert.equal(infoEvents().length, 0);
    });

    it("keeps a short audit trail", async () => {
      const r = await fetch(base + "/v1/agent-events", { headers: { authorization: `Bearer ${deviceToken}` } });
      const { events: rows } = (await r.json()) as any;
      assert.ok(rows.length >= 4);
      assert.ok(rows.some((e: any) => e.event === "stop" && /finished/.test(e.outcome)));
    });
  });

  it("process tracking: a job an agent started is reported when it ends (via the watch)", async () => {
    const T = Date.now();
    let snap: ProcSnap[] = [
      { pid: 100, ppid: 1, name: "claude.exe", cmd: "claude", createdMs: T - 3 * 3600_000 },
      { pid: 101, ppid: 100, name: "bash.exe", cmd: "bash", createdMs: T - 20 * MIN },
      { pid: 102, ppid: 101, name: "python.exe", cmd: "python train.py", createdMs: T - 18 * MIN },
    ];
    const g2 = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider() });
    // swap in a controllable process snapshot
    (g2.watchers as any).checkDeps.processSnapshot = async () => snap;
    const w = g2.watchers.create({ name: "Agent processes", type: "agentprocs", config: {}, severity: "info" });
    const evs: GatewayEvent[] = [];
    g2.manager.bus.subscribe((e) => evs.push(e));

    await g2.watchers.runNow(w.id);
    assert.equal(g2.watchers.events(w.id).length, 0, "first look just learns what is running");
    snap = snap.filter((p) => p.pid !== 102); // the job finishes
    await g2.watchers.runNow(w.id);
    const out = g2.watchers.events(w.id);
    assert.equal(out.length, 1);
    assert.match(out[0]!.summary, /python train\.py \(started by Claude\) ended after 18 min/);
    assert.equal(out[0]!.severity, "important", "an 18 minute job is worth a push");
    await g2.app.close();
  });
});

const db = (g: Gateway) => (g.manager.registry as any)["db"];
