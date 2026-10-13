import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { CheckDeps } from "../src/monitoring/checks.js";
import { buildJobWatches } from "../src/monitoring/presets.js";
import { SessionActivity } from "../src/monitoring/session-activity.js";
import { WatcherManager } from "../src/monitoring/watcher-manager.js";
import { Escalation, type Notice, type Notifier } from "../src/notifications/escalation.js";
import { MessageNotifier } from "../src/notifications/messages.js";
import { ApprovalService } from "../src/permissions/approvals.js";
import { EventBus } from "../src/sessions/manager.js";
import { MessageStore, SessionRegistry } from "../src/sessions/registry.js";
import { openDb } from "../src/storage/sqlite.js";
import type { GatewayEvent } from "../src/types.js";

const MIN = 60_000;

class Recorder implements Notifier {
  sent: Notice[] = [];
  async deliver(n: Notice) { this.sent.push(n); }
}

function rig(opts: { checkDeps?: Partial<CheckDeps>; wake?: (sid: string, text: string) => boolean; dbFile?: string; db?: ReturnType<typeof openDb> } = {}) {
  const t = { now: Date.parse("2026-10-01T12:00:00Z") };
  const now = () => t.now;
  const db = opts.db ?? openDb(opts.dbFile ?? ":memory:");
  const bus = new EventBus();
  const messages = new MessageStore(db);
  const registry = new SessionRegistry(db);
  const approvals = new ApprovalService(db, bus, messages);
  const activity = new SessionActivity(bus, approvals, now);
  const push = new Recorder();
  const call = new Recorder();
  const escalation = new Escalation(db, { message: new MessageNotifier(messages, bus), push, call }, { now });
  const events: GatewayEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const woken: { sessionId: string; text: string }[] = [];
  const watchers = new WatcherManager({
    db, bus, escalation, activity,
    sessionExists: (id) => !!registry.get(id),
    wake: opts.wake ?? ((sessionId, text) => { woken.push({ sessionId, text }); return true; }),
    checkDeps: opts.checkDeps,
  }, { now });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-watch-"));
  return { t, db, bus, messages, registry, approvals, activity, push, call, escalation, events, woken, watchers, tmp };
}

const eventsOf = (r: ReturnType<typeof rig>, id: string) => r.watchers.events(id).reverse();

describe("log watch", () => {
  it("reports only what is written after it was created, and escalates by severity", async () => {
    const r = rig();
    const log = path.join(r.tmp, "train.log");
    fs.writeFileSync(log, "old line\nCUDA out of memory (from yesterday)\n");
    const w = r.watchers.create({
      name: "run", type: "log",
      config: { path: log, patterns: [
        { regex: "CUDA out of memory", severity: "critical", label: "OOM" },
        { regex: "checkpoint saved", severity: "info", label: "checkpoint" },
      ] },
    });

    assert.deepEqual(await r.watchers.runNow(w.id), { status: "ok", fired: 0 }, "history before creation is ignored");

    fs.appendFileSync(log, "step 100 loss 0.5\ncheckpoint saved step 100\n");
    await r.watchers.runNow(w.id);
    assert.equal(r.push.sent.length, 0, "info never pushes");
    assert.equal(r.call.sent.length, 0);

    fs.appendFileSync(log, "RuntimeError: CUDA out of memory. Tried to allocate 2 GiB\n");
    await r.watchers.runNow(w.id);
    const ev = eventsOf(r, w.id);
    assert.deepEqual(ev.map((e) => [e.kind, e.severity]), [["match", "info"], ["match", "critical"]]);
    assert.match(ev[1]!.summary, /OOM/);
    assert.equal(r.push.sent.length, 1, "critical pushes");
    assert.equal(r.call.sent.length, 1, "critical rings");
    assert.ok(r.events.some((e) => e.type === "watch.triggered" && e.event.severity === "critical"), "websocket event");
    assert.ok(r.messages.list("general").some((m) => m.severity === "critical"), "message stored");
  });

  it("waits for a complete line before matching", async () => {
    const r = rig();
    const log = path.join(r.tmp, "a.log");
    fs.writeFileSync(log, "");
    const w = r.watchers.create({ name: "n", type: "log", config: { path: log, patterns: [{ regex: "FAILED", severity: "critical" }] } });
    fs.appendFileSync(log, "build FAI");
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0);
    fs.appendFileSync(log, "LED badly\n");
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 1);
  });

  it("collapses repeated identical lines but reports again later with a count", async () => {
    const r = rig();
    const log = path.join(r.tmp, "a.log");
    fs.writeFileSync(log, "");
    const w = r.watchers.create({ name: "n", type: "log", config: { path: log, patterns: [{ regex: "error", severity: "important" }] } });
    for (let i = 0; i < 4; i++) {
      fs.appendFileSync(log, `error: connection reset on attempt ${i}\n`);
      await r.watchers.runNow(w.id);
    }
    assert.equal(eventsOf(r, w.id).length, 1, "four similar lines in a row -> one event");
    r.t.now += 6 * MIN;
    fs.appendFileSync(log, "error: connection reset on attempt 99\n");
    await r.watchers.runNow(w.id);
    const ev = eventsOf(r, w.id);
    assert.equal(ev.length, 2);
    assert.match(ev[1]!.summary, /\+3 similar earlier/);
  });

  it("caps a flood but never drops the critical line", async () => {
    const r = rig();
    const log = path.join(r.tmp, "a.log");
    fs.writeFileSync(log, "");
    const w = r.watchers.create({
      name: "n", type: "log",
      config: { path: log, patterns: [{ regex: "warn-\\w+", severity: "info" }, { regex: "FATAL", severity: "critical" }] },
    });
    const lines = Array.from({ length: 40 }, (_, i) => `warn-${String.fromCharCode(97 + (i % 26))}${i}`);
    lines.push("FATAL: disk failure");
    fs.appendFileSync(log, lines.join("\n") + "\n");
    await r.watchers.runNow(w.id);
    const ev = eventsOf(r, w.id);
    assert.ok(ev.length <= 7, `bounded events, got ${ev.length}`);
    assert.ok(ev.some((e) => e.severity === "critical" && /FATAL/.test(e.summary)));
  });

  it("recovers from truncation or rotation", async () => {
    const r = rig();
    const log = path.join(r.tmp, "a.log");
    fs.writeFileSync(log, "x".repeat(500) + "\n");
    const w = r.watchers.create({ name: "n", type: "log", config: { path: log, patterns: [{ regex: "DONE", severity: "important" }] } });
    fs.writeFileSync(log, "DONE\n"); // rotated: smaller than the stored offset
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 1);
  });

  it("alerts when the log goes quiet and when it recovers", async () => {
    const r = rig();
    const log = path.join(r.tmp, "a.log");
    fs.writeFileSync(log, "start\n");
    const w = r.watchers.create({ name: "training", type: "log", config: { path: log, patterns: [], staleAfterSec: 600 } });
    r.t.now = fs.statSync(log).mtimeMs + 5 * MIN;
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0, "5 minutes of quiet is fine");

    r.t.now = fs.statSync(log).mtimeMs + 20 * MIN;
    await r.watchers.runNow(w.id);
    await r.watchers.runNow(w.id);
    await r.watchers.runNow(w.id);
    let ev = eventsOf(r, w.id);
    assert.equal(ev.length, 1, "fires once, not on every check");
    assert.equal(ev[0]!.kind, "triggered");
    assert.match(ev[0]!.summary, /not been written for 20 min/);
    assert.equal(r.push.sent.length, 1, "important -> push");
    assert.equal(r.call.sent.length, 0);

    fs.appendFileSync(log, "step 1\n");
    r.t.now = fs.statSync(log).mtimeMs + MIN;
    await r.watchers.runNow(w.id);
    ev = eventsOf(r, w.id);
    assert.deepEqual(ev.map((e) => e.kind), ["triggered", "resolved"]);
    assert.equal(ev[1]!.severity, "info");
  });

  it("reports a missing log file and its return", async () => {
    const r = rig();
    const log = path.join(r.tmp, "later.log");
    const w = r.watchers.create({ name: "n", type: "log", config: { path: log, patterns: [] } });
    await r.watchers.runNow(w.id);
    assert.match(eventsOf(r, w.id)[0]!.summary, /not found/);
    fs.writeFileSync(log, "hi\n");
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id)[1]?.kind, "resolved");
  });
});

describe("process watch", () => {
  it("fires once when the process disappears and again as resolved when it returns", async () => {
    let running = true;
    const r = rig({ checkDeps: { getProcessStatus: async () => ({ running, processes: [] }) } });
    const w = r.watchers.create({ name: "trainer", type: "process", config: { pid: 4242 } });
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0);
    running = false;
    for (let i = 0; i < 3; i++) await r.watchers.runNow(w.id);
    assert.deepEqual(eventsOf(r, w.id).map((e) => e.kind), ["triggered"]);
    assert.match(eventsOf(r, w.id)[0]!.summary, /process 4242 is no longer running/);
    running = true;
    await r.watchers.runNow(w.id);
    assert.deepEqual(eventsOf(r, w.id).map((e) => e.kind), ["triggered", "resolved"]);
  });

  it("can wait for a process to finish: quiet while it runs, loud when it stops", async () => {
    let running = true;
    const r = rig({ checkDeps: { getProcessStatus: async () => ({ running, processes: [] }) } });
    const w = r.watchers.create({ name: "build", type: "process", severity: "important", config: { name: "msbuild", expect: "stopped" } });
    for (let i = 0; i < 3; i++) await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0, "still running: nothing to say");
    running = false;
    await r.watchers.runNow(w.id);
    await r.watchers.runNow(w.id);
    const ev = eventsOf(r, w.id);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0]!.kind, ev[0]!.severity], ["resolved", "important"]);
    assert.match(ev[0]!.summary, /has stopped/);
    assert.equal(r.push.sent.length, 1, "important finish reaches the phone");
  });

  it("wait-for-finish also reports at once if the process had already ended", async () => {
    const r = rig({ checkDeps: { getProcessStatus: async () => ({ running: false, processes: [] }) } });
    const w = r.watchers.create({ name: "job", type: "process", config: { pid: 99, expect: "stopped" } });
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id)[0]?.kind, "resolved");
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 1);
  });

  it("repeats a reminder only when asked to", async () => {
    const r = rig({ checkDeps: { getProcessStatus: async () => ({ running: false, processes: [] }) } });
    const w = r.watchers.create({ name: "svc", type: "process", config: { name: "x" }, repeatMin: 10 });
    await r.watchers.runNow(w.id);
    r.t.now += 5 * MIN; await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 1);
    r.t.now += 6 * MIN; await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 2);
    assert.match(eventsOf(r, w.id)[1]!.summary, /^still:/);
  });
});

describe("file, command, http, gpu, git watches", () => {
  it("file: exists / missing / modified / stale", async () => {
    const r = rig();
    const f = path.join(r.tmp, "flag.txt");
    const exists = r.watchers.create({ name: "done flag", type: "file", config: { path: f, mode: "exists" } });
    const modified = r.watchers.create({ name: "metrics", type: "file", config: { path: f, mode: "modified" }, severity: "info" });
    await r.watchers.runNow(exists.id);
    assert.equal(eventsOf(r, exists.id).length, 0);
    fs.writeFileSync(f, "1");
    await r.watchers.runNow(exists.id);
    assert.equal(eventsOf(r, exists.id)[0]?.kind, "triggered");

    await r.watchers.runNow(modified.id); // absorbs current mtime
    await new Promise((res) => setTimeout(res, 20));
    fs.writeFileSync(f, "22");
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    await r.watchers.runNow(modified.id);
    assert.match(eventsOf(r, modified.id).at(-1)!.summary, /was modified/);

    const stale = r.watchers.create({ name: "heartbeat", type: "file", config: { path: f, mode: "stale", staleAfterSec: 60 } });
    r.t.now = fs.statSync(f).mtimeMs + 10 * MIN;
    await r.watchers.runNow(stale.id);
    assert.match(eventsOf(r, stale.id)[0]!.summary, /has not changed for 10 min/);
  });

  it("command: alerts when expectations fail, recovers when they pass, and refuses destructive commands", async () => {
    let result = { exitCode: 0 as number | null, timedOut: false, stdout: "healthy", stderr: "" };
    const r = rig({ checkDeps: { runCommand: async () => result } });
    const w = r.watchers.create({ name: "api up", type: "command", config: { command: "Get-Service foo", expectStdoutRegex: "healthy" } });
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0);
    result = { exitCode: 0, timedOut: false, stdout: "degraded", stderr: "" };
    await r.watchers.runNow(w.id);
    assert.match(eventsOf(r, w.id)[0]!.summary, /did not match/);
    result = { exitCode: 0, timedOut: false, stdout: "healthy", stderr: "" };
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id)[1]!.kind, "resolved");

    for (const bad of ["Remove-Item C:\\x -Recurse", "rm -rf /tmp/a", "powershell -enc UgBlAG0AbwB2AGUALQBJAHQAZQBtACAAeAA="]) {
      assert.throws(() => r.watchers.create({ name: "x", type: "command", config: { command: bad } }), /must not be destructive/, bad);
    }
    assert.throws(() => r.watchers.create({ name: "x", type: "log", config: { path: "a", patterns: [{ regex: "(" }] } }), /invalid regex/);
  });

  it("http: needs consecutive failures, then recovers", async () => {
    let status = 200;
    const server = http.createServer((_q, res) => { res.statusCode = status; res.end("x"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`;
    try {
      const r = rig();
      const w = r.watchers.create({ name: "api", type: "http", config: { url, failAfter: 2, timeoutSec: 2 } });
      await r.watchers.runNow(w.id);
      status = 500;
      await r.watchers.runNow(w.id);
      assert.equal(eventsOf(r, w.id).length, 0, "one failure is a blip");
      await r.watchers.runNow(w.id);
      assert.match(eventsOf(r, w.id)[0]!.summary, /HTTP 500/);
      status = 200;
      await r.watchers.runNow(w.id);
      assert.equal(eventsOf(r, w.id)[1]!.kind, "resolved");
    } finally { server.close(); }
  });

  it("http: unreachable host counts as failing", async () => {
    const r = rig();
    const w = r.watchers.create({ name: "down", type: "http", config: { url: "http://127.0.0.1:1/", failAfter: 1, timeoutSec: 2 } });
    await r.watchers.runNow(w.id);
    assert.match(eventsOf(r, w.id)[0]!.summary, /unreachable|no response/);
  });

  it("gpu: idle for long enough, hot, and recovery", async () => {
    let g = { index: 0, name: "RTX", utilizationPercent: 97, memoryUsedMB: 8000, memoryTotalMB: 16000, temperatureC: 70, powerW: 300 };
    const r = rig({ checkDeps: { getGpuStatus: async () => ({ available: true, gpus: [g] }) } });
    const w = r.watchers.create({ name: "gpu", type: "gpu", config: { idleBelowPercent: 5, idleForSec: 600, tempAboveC: 85 } });
    await r.watchers.runNow(w.id);
    g = { ...g, utilizationPercent: 1 };
    await r.watchers.runNow(w.id);
    r.t.now += 5 * MIN; await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0, "idle for 5 min is not yet a problem");
    r.t.now += 6 * MIN; await r.watchers.runNow(w.id);
    assert.match(eventsOf(r, w.id)[0]!.summary, /idle/);
    g = { ...g, utilizationPercent: 95, temperatureC: 90 };
    await r.watchers.runNow(w.id);
    const kinds = eventsOf(r, w.id).map((e) => `${e.kind}:${e.summary.slice(0, 12)}`);
    assert.ok(kinds.some((k) => k.startsWith("resolved")), "idle resolved");
    assert.ok(eventsOf(r, w.id).some((e) => /90°C/.test(e.summary)), "overheating");
  });

  it("git: reports new commits", async () => {
    const r = rig();
    const repo = path.join(r.tmp, "repo");
    fs.mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git("add", "-A"); git("commit", "-q", "-m", "first");
    const w = r.watchers.create({ name: "repo", type: "git", config: { repo }, severity: "info" });
    await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0);
    fs.writeFileSync(path.join(repo, "b.txt"), "2");
    git("add", "-A"); git("commit", "-q", "-m", "add feature b");
    await r.watchers.runNow(w.id);
    assert.match(eventsOf(r, w.id)[0]!.summary, /New commit on .*: add feature b/);
  });
});

describe("agent session watch (any Claude/Codex task)", () => {
  const session = (r: ReturnType<typeof rig>, title = "refactor auth") =>
    r.registry.create({ provider: "claude", providerSessionId: crypto.randomUUID(), title });

  const runTurn = (r: ReturnType<typeof rig>, id: string, spendSec: number, outcome: "ok" | "error" | "interrupted") => {
    const s = r.registry.mustGet(id);
    r.bus.publish({ type: "session.state", session: { ...s, status: "running" } });
    r.t.now += spendSec * 1000;
    if (outcome === "ok") r.bus.publish({ type: "agent.output.final", sessionId: id, turnId: "t", text: "Refactor complete: 12 files changed.", messageId: "m" });
    if (outcome === "error") r.bus.publish({ type: "message.created", message: { seq: 1, id: "x", conversationId: id, sessionId: id, sender: "system", type: "status", severity: "important", text: "claude exited with code 1", createdAt: "" } });
    r.bus.publish({ type: "session.state", session: { ...s, status: outcome === "error" ? "error" : "idle" } });
  };

  it("announces long tasks finishing, with the result, but stays quiet for quick ones", async () => {
    const r = rig();
    const s = session(r);
    const w = r.watchers.create({ name: "Agent tasks", type: "session", config: {} });
    runTurn(r, s.id, 20, "ok");
    await new Promise((res) => setImmediate(res));
    assert.equal(eventsOf(r, w.id).length, 0, "a 20 second turn is not worth a notification");

    runTurn(r, s.id, 14 * 60, "ok");
    await new Promise((res) => setImmediate(res));
    const ev = eventsOf(r, w.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0]!.summary, /Claude finished "refactor auth" after 14 min/);
    assert.match(ev[0]!.detail!, /12 files changed/);
    assert.equal(r.push.sent.length, 1, "important -> push");
  });

  it("reports failures with the reason, and ignores interrupted turns", async () => {
    const r = rig();
    const s = session(r, "deploy fix");
    const w = r.watchers.create({ name: "Agent tasks", type: "session", config: { minDurationSec: 0 } });
    runTurn(r, s.id, 90, "interrupted");
    await new Promise((res) => setImmediate(res));
    assert.equal(eventsOf(r, w.id).length, 0);
    runTurn(r, s.id, 90, "error");
    await new Promise((res) => setImmediate(res));
    const ev = eventsOf(r, w.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0]!.summary, /failed after/);
    assert.match(ev[0]!.detail!, /exited with code 1/);
  });

  it("can be scoped to one session", async () => {
    const r = rig();
    const a = session(r, "A"), b = session(r, "B");
    const w = r.watchers.create({ name: "only B", type: "session", config: { sessionId: b.id, minDurationSec: 0 } });
    runTurn(r, a.id, 5, "ok");
    runTurn(r, b.id, 5, "ok");
    await new Promise((res) => setImmediate(res));
    assert.equal(eventsOf(r, w.id).length, 1);
    assert.match(eventsOf(r, w.id)[0]!.summary, /"B"/);
  });

  it("flags a task that has gone silent and an approval nobody answered", async () => {
    const r = rig();
    const s = session(r, "long task");
    const w = r.watchers.create({ name: "Agent tasks", type: "session", config: { stalledAfterSec: 600, approvalWaitingAfterSec: 300 } });
    r.bus.publish({ type: "session.state", session: { ...r.registry.mustGet(s.id), status: "running" } });
    r.t.now += 5 * MIN; await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0);
    r.bus.publish({ type: "agent.tool", sessionId: s.id, turnId: "t", name: "Bash" }); // activity resets the clock
    r.t.now += 8 * MIN; await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0, "8 min since last activity < 10");
    r.t.now += 3 * MIN; await r.watchers.runNow(w.id);
    assert.match(eventsOf(r, w.id)[0]!.summary, /no output for 11 min/);

    const { approval } = r.approvals.request({ sessionId: s.id, source: "agent", tool: "Bash", summary: "Bash: rm -rf old-runs" });
    r.t.now += 6 * MIN;
    // approvals use wall-clock createdAt; make it look old to the (virtual) clock
    r.db.prepare("UPDATE approvals SET created_at = ? WHERE id = ?").run(new Date(r.t.now - 6 * MIN).toISOString(), approval.id);
    await r.watchers.runNow(w.id);
    assert.ok(eventsOf(r, w.id).some((e) => /approval request\(s\) waiting on you/.test(e.summary)));
    r.approvals.resolve(approval.id, false);
  });
});

describe("escalation policy", () => {
  it("routes by severity and records what was unavailable", async () => {
    const r = rig();
    const bare = new Escalation(r.db, { message: new MessageNotifier(r.messages, r.bus) });
    const out = await bare.notify({ severity: "critical", title: "t", body: "", dedupeKey: "k" });
    assert.deepEqual(out.map((d) => `${d.channel}:${d.status}`), ["message:delivered", "push:unavailable", "call:unavailable"]);
    const rows = r.db.prepare("SELECT channel, status FROM notifications").all() as { channel: string; status: string }[];
    assert.equal(rows.length, 3);
    assert.deepEqual((await bare.notify({ severity: "info", title: "t", body: "", dedupeKey: "k" })).map((d) => d.channel), ["message"]);
  });

  it("does not ring twice about the same problem, and caps calls per hour", async () => {
    const r = rig();
    const n = (key: string): Notice => ({ severity: "critical", title: "t", body: "", dedupeKey: key });
    await r.escalation.notify(n("a"));
    r.t.now += 5 * MIN;
    const again = await r.escalation.notify(n("a"));
    assert.equal(again.find((d) => d.channel === "call")?.status, "suppressed");
    assert.equal(r.call.sent.length, 1);

    await r.escalation.notify(n("b"));
    await r.escalation.notify(n("c"));
    const fourth = await r.escalation.notify(n("d"));
    assert.equal(fourth.find((d) => d.channel === "call")?.status, "suppressed", "3 calls/hour");
    assert.equal(r.call.sent.length, 3);
    assert.ok(fourth.find((d) => d.channel === "push")?.status === "delivered", "push still goes out");

    r.t.now += 61 * MIN;
    assert.equal((await r.escalation.notify(n("e"))).find((d) => d.channel === "call")?.status, "delivered");
  });

  it("a failing channel does not block the others", async () => {
    const r = rig();
    const boom: Notifier = { deliver: async () => { throw new Error("apns down"); } };
    const e = new Escalation(r.db, { message: new MessageNotifier(r.messages, r.bus), push: boom });
    const out = await e.notify({ severity: "important", title: "t", body: "", dedupeKey: "k" });
    assert.deepEqual(out.map((d) => d.status), ["delivered", "failed"]);
  });
});

describe("waking an agent", () => {
  it("hands important events to the chosen session, once per cooldown, never for info", async () => {
    const r = rig();
    const s = r.registry.create({ provider: "claude", providerSessionId: crypto.randomUUID(), title: "trainer" });
    const log = path.join(r.tmp, "a.log");
    fs.writeFileSync(log, "");
    const w = r.watchers.create({
      name: "run", type: "log",
      config: { path: log, patterns: [{ regex: "OOM", severity: "critical" }, { regex: "ckpt", severity: "info" }] },
      wake: { sessionId: s.id, cooldownMin: 30, instruction: "Check the GPU and tell me why." },
    });
    fs.appendFileSync(log, "ckpt saved\n"); await r.watchers.runNow(w.id);
    assert.equal(r.woken.length, 0, "info does not wake the agent");

    fs.appendFileSync(log, "OOM at step 10\n"); await r.watchers.runNow(w.id);
    assert.equal(r.woken.length, 1);
    assert.match(r.woken[0]!.text, /Helix watcher "run" fired \(critical\)/);
    assert.match(r.woken[0]!.text, /OOM at step 10/);
    assert.match(r.woken[0]!.text, /Check the GPU/);

    r.t.now += 10 * MIN;
    fs.appendFileSync(log, "OOM again with different words 7\n"); await r.watchers.runNow(w.id);
    assert.equal(r.woken.length, 1, "cooldown");
    r.t.now += 25 * MIN;
    fs.appendFileSync(log, "OOM yet again, new text 8\n"); await r.watchers.runNow(w.id);
    assert.equal(r.woken.length, 2);
  });

  it("does not burn the cooldown when the agent was busy, and spends nothing without a wake config", async () => {
    let busy = true;
    const calls: string[] = [];
    const r = rig({ wake: (sid) => { calls.push(sid); return !busy; } });
    const s = r.registry.create({ provider: "claude", providerSessionId: crypto.randomUUID(), title: "t" });
    const log = path.join(r.tmp, "a.log");
    fs.writeFileSync(log, "");
    const w = r.watchers.create({ name: "n", type: "log", config: { path: log, patterns: [{ regex: "BAD", severity: "critical" }] }, wake: { sessionId: s.id, cooldownMin: 30 } });
    const plain = r.watchers.create({ name: "plain", type: "log", config: { path: log, patterns: [{ regex: "BAD", severity: "critical" }] } });
    fs.appendFileSync(log, "BAD one\n"); await r.watchers.runNow(w.id); await r.watchers.runNow(plain.id);
    assert.equal(calls.length, 1, "only the watch with a wake config tried");
    busy = false;
    r.t.now += MIN;
    fs.appendFileSync(log, "BAD two different\n"); await r.watchers.runNow(w.id);
    assert.equal(calls.length, 2, "retried because the first attempt failed");
  });
});

describe("robustness", () => {
  it("a failing check notifies once after repeated failures, then reports recovery", async () => {
    let broken = true;
    const r = rig({ checkDeps: { runCommand: async () => { if (broken) throw new Error("powershell unavailable"); return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; } } });
    const w = r.watchers.create({ name: "chk", type: "command", config: { command: "Get-Date" } });
    await r.watchers.runNow(w.id); await r.watchers.runNow(w.id);
    assert.equal(eventsOf(r, w.id).length, 0, "two failures: still just a blip");
    await r.watchers.runNow(w.id); await r.watchers.runNow(w.id);
    assert.deepEqual(eventsOf(r, w.id).map((e) => e.kind), ["error"], "told once");
    assert.equal(r.watchers.get(w.id)?.lastStatus, "error");
    broken = false;
    await r.watchers.runNow(w.id);
    assert.deepEqual(eventsOf(r, w.id).map((e) => e.kind), ["error", "resolved"]);
  });

  it("survives a gateway restart: no re-announcements, no missed lines", async () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helix-db-")), "w.db");
    let running = true;
    const deps = { getProcessStatus: async () => ({ running, processes: [] }) };
    const r1 = rig({ dbFile, checkDeps: deps });
    const log = path.join(r1.tmp, "a.log");
    fs.writeFileSync(log, "");
    const proc = r1.watchers.create({ name: "p", type: "process", config: { pid: 7 } });
    const lg = r1.watchers.create({ name: "l", type: "log", config: { path: log, patterns: [{ regex: "DONE", severity: "important" }] } });
    running = false;
    await r1.watchers.runNow(proc.id);
    fs.appendFileSync(log, "line before restart\n");
    await r1.watchers.runNow(lg.id);
    assert.equal(eventsOf(r1, proc.id).length, 1);

    // gateway is down; training finishes in the meantime
    fs.appendFileSync(log, "DONE while the gateway was offline\n");

    const r2 = rig({ db: openDb(dbFile), checkDeps: deps });
    await r2.watchers.runNow(proc.id);
    assert.equal(r2.watchers.events(proc.id).length, 1, "process already reported gone; not repeated after restart");
    await r2.watchers.runNow(lg.id);
    const ev = r2.watchers.events(lg.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0]!.summary, /DONE while the gateway was offline/);
  });

  it("tick runs only watches that are due, and respects disable", async () => {
    let checks = 0;
    const r = rig({ checkDeps: { getProcessStatus: async () => { checks++; return { running: true, processes: [] }; } } });
    const a = r.watchers.create({ name: "a", type: "process", intervalSec: 60, config: { pid: 1 } });
    const b = r.watchers.create({ name: "b", type: "process", intervalSec: 300, config: { pid: 2 } });
    await r.watchers.tick();
    assert.equal(checks, 2, "first tick checks everything");
    r.t.now += 61_000; await r.watchers.tick();
    assert.equal(checks, 3, "only the 60s watch is due");
    r.watchers.setEnabled(a.id, false);
    r.t.now += 400_000; await r.watchers.tick();
    assert.equal(checks, 4, "disabled watch skipped; the 300s one ran");
    assert.ok(b.id);
  });

  it("creates the always-on default watches once, and does not resurrect them after deletion", async () => {
    const r = rig();
    r.watchers.ensureDefaults();
    r.watchers.ensureDefaults();
    const list = r.watchers.list();
    assert.deepEqual(list.map((w) => w.type).sort(), ["agentprocs", "session"]);
    list.forEach((w) => r.watchers.remove(w.id));
    r.watchers.ensureDefaults();
    assert.equal(r.watchers.list().length, 0);
  });

  it("validates input and rejects unknown sessions", () => {
    const r = rig();
    assert.throws(() => r.watchers.create({ name: "x", type: "process", config: {} }), /pid or name/);
    assert.throws(() => r.watchers.create({ name: "x", type: "file", config: { path: "a", mode: "stale" } }), /staleAfterSec/);
    assert.throws(() => r.watchers.create({ name: "x", type: "gpu", config: {} }), /at least one/);
    assert.throws(() => r.watchers.create({ name: "x", type: "log", config: { path: "a" }, sessionId: "nope" }), /session nope not found/);
    assert.throws(() => r.watchers.create({ name: "x", type: "http", config: { url: "ftp://x" } }));
  });
});

describe("job presets", () => {
  const patternsFor = (input: Parameters<typeof buildJobWatches>[0]) => {
    const log = buildJobWatches(input).find((w) => w.type === "log")!;
    const pats = (log.config as { patterns: { regex: string; severity: string }[] }).patterns;
    return (line: string) => pats.find((p) => new RegExp(p.regex, "i").test(line))?.severity;
  };

  it("works for any kind of job, not only training", () => {
    const generic = patternsFor({ name: "x", logPath: "a.log" });
    assert.equal(generic("Traceback (most recent call last):"), "critical");
    assert.equal(generic("Job finished successfully"), "important");
    assert.equal(generic("something failed"), "important");
    assert.equal(generic("just a normal line"), undefined);

    const build = patternsFor({ name: "x", logPath: "a.log", profile: "build" });
    assert.equal(build("src/a.ts(3,1): error TS2322: nope"), "critical");
    assert.equal(build("Build succeeded"), "important");

    const tests = patternsFor({ name: "x", logPath: "a.log", profile: "tests" });
    assert.equal(tests("3 failed, 40 passed"), "critical");
    assert.equal(tests("40 passed"), "important");

    const dl = patternsFor({ name: "x", logPath: "a.log", profile: "download" });
    assert.equal(dl("connection reset by peer"), "critical");
    assert.equal(dl("Download complete"), "important");
  });

  it("training profile knows about OOM, NaN loss and checkpoints; GPU watch is on by default for it", () => {
    const t = patternsFor({ name: "cat", logPath: "a.log", profile: "training" });
    assert.equal(t("torch.cuda.OutOfMemoryError: CUDA out of memory"), "critical");
    assert.equal(t("step 4100 loss: nan"), "critical");
    assert.equal(t("Saved checkpoint to ckpt/step_500.pt"), "info");
    assert.equal(t("Training complete."), "important");
    assert.equal(t("step 4100 loss 0.184 lr 1e-4"), undefined);
    assert.ok(buildJobWatches({ name: "cat", logPath: "a.log", profile: "training" }).some((w) => w.type === "gpu"));
    assert.ok(!buildJobWatches({ name: "b", logPath: "a.log", profile: "build" }).some((w) => w.type === "gpu"));
  });

  it("combines process + log, honours custom patterns, and requires something to watch", () => {
    const w = buildJobWatches({ name: "n", pid: 5, logPath: "a.log", errorPatterns: ["my custom crash"], staleAfterMin: 0 });
    assert.deepEqual(w.map((x) => x.type), ["process", "log"]);
    const cfg = w[1]!.config as { patterns: { regex: string; severity: string }[]; staleAfterSec?: number };
    assert.ok(cfg.patterns.some((p) => p.regex === "my custom crash" && p.severity === "critical"));
    assert.equal(cfg.staleAfterSec, undefined, "stale check disabled");
    assert.throws(() => buildJobWatches({ name: "n" }), /at least one/);
  });
});
