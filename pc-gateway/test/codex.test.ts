import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import { CodexProvider } from "../src/providers/codex.js";
import { codexEnv } from "../src/providers/codex-env.js";
import type { AgentEvent, ApprovalAsk, SendOptions } from "../src/providers/provider.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const FIXTURE = path.resolve("test/fixtures/fake-codex-app-server.mjs");
const j = (o: unknown) => JSON.stringify(o) + "\n";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-codex-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let logCounter = 0;
function fakeProvider(opts: { sandbox?: "read-only" | "workspace-write"; approvalPolicy?: "untrusted" | "on-request"; env?: Record<string, string> } = {}) {
  const log = path.join(tmp, `codex-${++logCounter}.log`);
  const provider = new CodexProvider({
    server: { bin: process.execPath, args: [FIXTURE], env: () => ({ ...process.env, FAKE_CODEX_LOG: log, ...opts.env }) },
    sandbox: opts.sandbox, approvalPolicy: opts.approvalPolicy,
  });
  const messages = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { dir: string; msg: any }) : []);
  const sent = (method: string) => messages().filter((m) => m.dir === "in" && m.msg.method === method).map((m) => m.msg.params);
  const replies = () => messages().filter((m) => m.dir === "in" && m.msg.id !== undefined && m.msg.method === undefined).map((m) => m.msg);
  return { provider, log, messages, sent, replies };
}

const opts = (o: Partial<SendOptions> & { providerSessionId: string; text: string }): SendOptions =>
  ({ resume: true, signal: new AbortController().signal, ...o });
async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const allow = async (): Promise<{ allow: boolean }> => ({ allow: true });

describe("Codex provider (against a server that speaks the real protocol)", () => {
  it("starts a thread with the sandbox and approval policy Helix wants, in the right folder", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({ projectPath: "C:/proj/cat" });
    assert.match(providerSessionId, /^th-/);
    const start = f.sent("thread/start")[0];
    assert.equal(start.cwd, "C:/proj/cat");
    assert.equal(start.approvalPolicy, "untrusted", "asks about anything not known-safe, so destructive commands reach Helix's gate");
    assert.equal(start.sandbox, "workspace-write");
    assert.deepEqual(f.sent("initialize")[0].clientInfo.name, "helix");
    f.provider.close();
  });

  it("streams a reply as deltas and ends with the final answer", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({ projectPath: "C:/p" });
    const ev = await collect(f.provider.send(opts({ providerSessionId, text: "hello codex" })));
    const deltas = ev.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
    assert.equal(deltas, "echo: hello codex");
    assert.ok(ev.filter((e) => e.type === "delta").length > 1, "incremental, not one lump");
    assert.deepEqual(ev.at(-1), { type: "final", text: "echo: hello codex" });
    assert.equal(f.sent("thread/resume").length, 0, "a thread this server just created is not 'resumed'");
    assert.deepEqual(f.sent("turn/start")[0].input, [{ type: "text", text: "hello codex", text_elements: [] }]);
    f.provider.close();
  });

  it("continues an existing thread from an earlier session by resuming it first, once", async () => {
    const f = fakeProvider();
    await collect(f.provider.send(opts({ providerSessionId: "old-aaaa", text: "one", projectPath: "C:/proj/old" })));
    await collect(f.provider.send(opts({ providerSessionId: "old-aaaa", text: "two", projectPath: "C:/proj/old" })));
    const resumes = f.sent("thread/resume");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].threadId, "old-aaaa");
    assert.equal(resumes[0].cwd, "C:/proj/old");
    assert.equal(resumes[0].approvalPolicy, "untrusted");
    f.provider.close();
  });

  it("reports a thread Codex does not know instead of hanging", async () => {
    const f = fakeProvider();
    const ev = await collect(f.provider.send(opts({ providerSessionId: "nope-1234", text: "x" })));
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.type, "error");
    assert.match((ev[0] as any).message, /no rollout found/);
    f.provider.close();
  });

  it("answers approval requests through Helix's policy: normal commands accepted, refused ones declined", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({ projectPath: "C:/p" });
    const asks: ApprovalAsk[] = [];
    const approve = async (a: ApprovalAsk) => { asks.push(a); return { allow: !/rm /.test(String(a.input.command ?? "")) }; };

    const ok = await collect(f.provider.send(opts({ providerSessionId, text: "RUN npm test", approve })));
    assert.deepEqual(ok.at(-1), { type: "final", text: "ran: npm test" });
    const no = await collect(f.provider.send(opts({ providerSessionId, text: "RUN rm -rf checkpoints", approve })));
    assert.deepEqual(no.at(-1), { type: "final", text: "refused: rm -rf checkpoints" });

    assert.deepEqual(asks.map((a) => a.tool), ["shell", "shell"]);
    assert.equal(asks[0]!.input.command, "npm test", "the command the model wrote, not Codex's PowerShell wrapper around it");
    assert.deepEqual(f.replies().filter((r) => r.result?.decision).map((r) => r.result.decision), ["accept", "decline"]);
    assert.ok(ok.some((e) => e.type === "tool" && e.name === "shell"), "tool use is announced");
    f.provider.close();
  });

  it("file changes: a deletion is presented as a delete_file action, anything else as a patch", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({ projectPath: "C:/p" });
    const asks: ApprovalAsk[] = [];
    const approve = async (a: ApprovalAsk) => { asks.push(a); return { allow: true }; };
    await collect(f.provider.send(opts({ providerSessionId, text: "DELETE C:/p/old.bin", approve })));
    await collect(f.provider.send(opts({ providerSessionId, text: "PATCH C:/p/new.ts", approve })));
    assert.deepEqual(asks.map((a) => a.tool), ["delete_file", "apply_patch"]);
    assert.deepEqual(asks[0]!.input.paths, ["C:/p/old.bin"]);
    f.provider.close();
  });

  it("sandbox-widening requests are granted as asked or refused entirely", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({ projectPath: "C:/p" });
    const granted = await collect(f.provider.send(opts({ providerSessionId, text: "PERMS", approve: allow })));
    assert.match((granted.at(-1) as any).text, /"write":\["C:\/data"\]/);
    assert.match((granted.at(-1) as any).text, /"enabled":true/);
    const denied = await collect(f.provider.send(opts({ providerSessionId, text: "PERMS", approve: async () => ({ allow: false }) })));
    assert.match((denied.at(-1) as any).text, /"fileSystem":null,"network":null/, "nothing granted");
    f.provider.close();
  });

  it("a question Codex asks the user is not answered by guessing", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({});
    const ev = await collect(f.provider.send(opts({ providerSessionId, text: "ASK", approve: allow })));
    assert.match(ev.filter((e) => e.type === "delta").map((e: any) => e.text).join(""), /Codex asked a question I cannot answer from here: Which database\?/);
    assert.match((ev.at(-1) as any).text, /answers: \{\}/, "empty answers, not invented ones");
    f.provider.close();
  });

  it("MCP tool calls: Helix's own tools are allowed through; a destructive third-party tool is held for approval; data forms are not answered", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({});
    const asks: ApprovalAsk[] = [];
    const approve = async (a: ApprovalAsk) => { asks.push(a); return { allow: !/delete/.test(a.tool) }; };

    const helix = await collect(f.provider.send(opts({ providerSessionId, text: "MCP helix.notify_user", approve })));
    assert.deepEqual(helix.at(-1), { type: "final", text: "tool ran: helix.notify_user" });
    const third = await collect(f.provider.send(opts({ providerSessionId, text: "MCP gitkraken.delete_branch", approve })));
    assert.deepEqual(third.at(-1), { type: "final", text: "tool blocked: gitkraken.delete_branch (decline)" });
    assert.deepEqual(asks.map((a) => a.tool), ["mcp__helix__notify_user", "mcp__gitkraken__delete_branch"], "named the way Claude's MCP tools are, so the same policy applies");
    assert.deepEqual(asks[0]!.input, { branch: "main" }, "the arguments are passed to the policy");

    const form = await collect(f.provider.send(opts({ providerSessionId, text: "FORM", approve })));
    assert.deepEqual(form.at(-1), { type: "final", text: "form answered: cancel" }, "no channel to ask the user for data yet: cancelled, never invented");
    f.provider.close();
  });

  it("requests it does not understand are refused with a protocol error and the turn carries on", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({});
    const ev = await collect(f.provider.send(opts({ providerSessionId, text: "WEIRD", approve: allow })));
    assert.match((ev.at(-1) as any).text, /weird replied: unsupported request weird\/method/);
    f.provider.close();
  });

  it("an interrupt stops the turn promptly and quietly", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({});
    const ac = new AbortController();
    const t0 = Date.now();
    const run = collect(f.provider.send(opts({ providerSessionId, text: "SLOW", signal: ac.signal })));
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const ev = await run;
    assert.ok(Date.now() - t0 < 2500, "did not run the full 3 seconds");
    assert.ok(!ev.some((e) => e.type === "final" || e.type === "error"), "an interrupted turn is neither a result nor a failure");
    assert.equal(f.sent("turn/interrupt").length, 1);
    f.provider.close();
  });

  it("a failed turn surfaces Codex's own message", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({});
    const ev = await collect(f.provider.send(opts({ providerSessionId, text: "FAIL" })));
    assert.deepEqual(ev, [{ type: "error", message: "model overloaded" }]);
    f.provider.close();
  });

  it("if Codex dies mid-turn the turn ends with an error, and the next message starts a fresh server", async () => {
    const f = fakeProvider();
    const { providerSessionId } = await f.provider.createSession({});
    const crashed = await collect(f.provider.send(opts({ providerSessionId, text: "CRASH" })));
    assert.equal(crashed.at(-1)!.type, "error");
    assert.match((crashed.at(-1) as any).message, /codex exited/);

    const again = await collect(f.provider.send(opts({ providerSessionId: "old-restart", text: "back again" })));
    assert.deepEqual(again.at(-1), { type: "final", text: "echo: back again" });
    assert.equal(f.sent("initialize").length, 2, "handshake repeated on the new process");
    assert.equal(f.sent("thread/resume").length, 1, "and the thread is loaded again there");
    f.provider.close();
  });

  it("forking branches the thread and returns the new id", async () => {
    const f = fakeProvider();
    const forked = await f.provider.forkSession("old-origin", { projectPath: "C:/p" });
    assert.match(forked.providerSessionId, /^fork-\d+-of-old-origin$/);
    assert.equal(f.sent("thread/fork")[0].threadId, "old-origin");
    const ev = await collect(f.provider.send(opts({ providerSessionId: forked.providerSessionId, text: "hi from the branch" })));
    assert.equal(ev.at(-1)!.type, "final");
    assert.equal(f.sent("thread/resume").length, 0, "a fresh fork is already loaded");
    f.provider.close();
  });

  it("two sessions share one server without mixing their events", async () => {
    const f = fakeProvider();
    const a = (await f.provider.createSession({})).providerSessionId;
    const b = (await f.provider.createSession({})).providerSessionId;
    const [ea, eb] = await Promise.all([
      collect(f.provider.send(opts({ providerSessionId: a, text: "alpha alpha alpha" }))),
      collect(f.provider.send(opts({ providerSessionId: b, text: "beta beta beta" }))),
    ]);
    assert.equal((ea.at(-1) as any).text, "echo: alpha alpha alpha");
    assert.equal((eb.at(-1) as any).text, "echo: beta beta beta");
    assert.equal(f.sent("initialize").length, 1, "one process serves both");
    f.provider.close();
  });

  it("reports a missing Codex binary as a clear error rather than crashing", async () => {
    const p = new CodexProvider({ server: { bin: "definitely-not-installed-codex", args: [] } });
    const ev = await collect(p.send(opts({ providerSessionId: "x", text: "hi" })));
    assert.equal(ev[0]!.type, "error");
    assert.match((ev[0] as any).message, /could not start codex/);
  });

  it("the token for the Helix tools is supplied from ~/.helix when the service did not inherit it", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    fs.writeFileSync(path.join(home, "local.json"), JSON.stringify({ url: "http://127.0.0.1:7777", token: "hxl_abc" }));
    assert.equal(codexEnv({ PATH: "x" }, home).HELIX_AGENT_TOKEN, "hxl_abc");
    assert.equal(codexEnv({ HELIX_AGENT_TOKEN: "already" }, home).HELIX_AGENT_TOKEN, "already", "an existing value wins");
    assert.equal(codexEnv({ PATH: "x" }, path.join(tmp, "missing")).HELIX_AGENT_TOKEN, undefined, "not connected: no token, no crash");
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("Codex sessions through the gateway", () => {
  const CODEX_OLD = "old-0001"; // the fake server treats ids starting with "old-" as threads from earlier runs
  let gw: Gateway;
  let base: string;
  let token: string;
  let root: string;
  let proj: string;
  let f: ReturnType<typeof fakeProvider>;
  const alive = new Set<number>();

  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const until = async (fn: () => boolean, ms = 20000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
  const pending = async (): Promise<any> => { let a: any; await until(() => { return false || (a = undefined) === undefined && false; }, 1).catch(() => undefined); for (let i = 0; i < 1500; i++) { const l = (await api("GET", "/v1/approvals?status=pending")).json.approvals; if (l.length) return l[0]; await new Promise((r) => setTimeout(r, 10)); } throw new Error("no approval"); };
  const reply = async (sessionId: string): Promise<string> => {
    await until(() => !gw.manager.isRunning(sessionId));
    return gw.manager.messages.list(sessionId).filter((m) => m.sender === "agent").at(-1)?.text ?? "";
  };

  before(async () => {
    root = fs.mkdtempSync(path.join(tmp, "gw-"));
    proj = path.join(root, "cat-project");
    fs.mkdirSync(proj);
    const codexHome = path.join(root, ".codex");
    const day = path.join(codexHome, "sessions", "2026", "09", "28");
    fs.mkdirSync(day, { recursive: true });
    fs.mkdirSync(path.join(root, ".claude", "projects"), { recursive: true });
    // a discovered Codex session (the thread id must be a uuid-shaped file suffix for the indexer)
    const uuid = "01a0aaaa-bbbb-7ccc-8ddd-0000000000aa";
    fs.writeFileSync(path.join(day, `rollout-2026-09-28T22-40-57-${uuid}.jsonl`),
      j({ timestamp: "2026-09-28T10:00:00Z", type: "session_meta", payload: { id: uuid, cwd: proj } }) +
      j({ timestamp: "2026-09-28T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "tune the cat model learning rate" }] } }) +
      j({ timestamp: "2026-09-28T10:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Lowered it to 1e-4." }] } }));

    f = fakeProvider();
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", routerHome: path.join(root, "router"), discovery: { homes: { claudeHome: path.join(root, ".claude"), codexHome } } },
      openDb(":memory:"), { codex: f.provider, claude: new FakeProvider() }); // the router itself is a Claude session
    (gw.indexer as any).alive = (pid: number) => alive.has(pid);
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
    await gw.indexer!.scan();
  });
  after(async () => { await gw.app.close(); });

  it("a Codex session is created and talked to like any other, streaming over the websocket", async () => {
    const created = await api("POST", "/v1/sessions", { provider: "codex", title: "codex chat", projectPath: proj });
    assert.equal(created.status, 201);
    assert.match(created.json.providerSessionId, /^th-/);

    const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
    const got: any[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "send", sessionId: created.json.id, text: "say something" }));
    await until(() => got.some((e) => e.type === "agent.output.final"));
    assert.equal(got.filter((e) => e.type === "agent.output.delta").map((e) => e.text).join(""), "echo: say something");
    ws.close();
    assert.equal(await reply(created.json.id), "echo: say something");
    assert.equal(f.sent("thread/start").at(-1).cwd, proj);
  });

  it("normal Codex commands run unattended; a destructive one waits for the phone, and the answer reaches Codex", async () => {
    const s = (await api("POST", "/v1/sessions", { provider: "codex", title: "gated", projectPath: proj })).json;

    await api("POST", `/v1/sessions/${s.id}/message`, { text: "RUN npm run build" });
    assert.equal(await reply(s.id), "ran: npm run build");
    assert.equal((await api("GET", "/v1/approvals?status=pending")).json.approvals.length, 0, "no interruption for ordinary work");

    await api("POST", `/v1/sessions/${s.id}/message`, { text: "RUN rm -rf checkpoints/old-run-17" });
    const a = await pending();
    assert.match(a.summary, /rm -rf checkpoints\/old-run-17/);
    assert.equal(a.sessionId, s.id);
    assert.equal(gw.manager.isRunning(s.id), true, "Codex is held while the user decides");
    await api("POST", `/v1/approvals/${a.id}/reject`, {});
    assert.equal(await reply(s.id), "refused: rm -rf checkpoints/old-run-17");

    await api("POST", `/v1/sessions/${s.id}/message`, { text: "RUN Remove-Item -Recurse data" });
    const b = await pending();
    await api("POST", `/v1/approvals/${b.id}/approve`, {});
    assert.equal(await reply(s.id), "ran: Remove-Item -Recurse data");
  });

  it("deleting files through Codex's patch tool is gated too", async () => {
    const s = (await api("POST", "/v1/sessions", { provider: "codex", title: "patches", projectPath: proj })).json;
    await api("POST", `/v1/sessions/${s.id}/message`, { text: "PATCH C:/p/new.ts" });
    assert.equal(await reply(s.id), "changed: C:/p/new.ts", "adding a file needs no approval");
    const sent = await api("POST", `/v1/sessions/${s.id}/message`, { text: "DELETE C:/p/old.bin" });
    assert.equal(sent.status, 202, `the delete request was refused: ${JSON.stringify(sent.json)}`);
    const a = await pending().catch((err) => {
      const msgs = gw.manager.messages.list(s.id).map((m) => `${m.sender}: ${m.text.slice(0, 120)}`);
      throw new Error(`${err.message}; running=${gw.manager.isRunning(s.id)} status=${gw.manager.registry.get(s.id)?.status} messages=${JSON.stringify(msgs)} approvals=${JSON.stringify(gw.approvals.list().slice(0, 3).map((x) => `${x.status}:${x.summary.slice(0, 60)}`))}`);
    });
    assert.match(a.summary, /delete_file/);
    await api("POST", `/v1/approvals/${a.id}/reject`, {});
    assert.equal(await reply(s.id), "not changed: C:/p/old.bin");
  });

  it("interrupting a running Codex turn works through the same API", async () => {
    const s = (await api("POST", "/v1/sessions", { provider: "codex", title: "interrupt me", projectPath: proj })).json;
    await api("POST", `/v1/sessions/${s.id}/message`, { text: "SLOW" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await api("POST", `/v1/sessions/${s.id}/interrupt`)).json.interrupted, true);
    await until(() => !gw.manager.isRunning(s.id));
    assert.equal(gw.manager.registry.get(s.id)?.status, "idle");
  });

  it("a Codex session found on the machine can be continued from the phone (resumed, or forked if open elsewhere)", async () => {
    // the indexer reports the session id as the uuid from the file name; the fake server only resumes "old-" ids,
    // so map it by adopting and then checking what was asked of Codex
    const uuid = "01a0aaaa-bbbb-7ccc-8ddd-0000000000aa";
    const setActivity = (agoMs: number) => {
      (gw.indexer as any)["db"].prepare("UPDATE discovered_sessions SET file_mtime_ms = ? WHERE key = ?").run(Date.now() - agoMs, `codex:${uuid}`);
      gw.indexer!.refreshLive();
    };
    setActivity(60 * 60_000); // quiet for an hour: not open anywhere
    const resumed = await api("POST", `/v1/agent-sessions/codex/${uuid}/adopt`, {});
    assert.equal(resumed.status, 201);
    assert.equal(resumed.json.mode, "resume");
    assert.equal(resumed.json.session.provider, "codex");
    assert.equal(resumed.json.session.providerSessionId, uuid);
    assert.equal(resumed.json.session.projectPath, proj);

    // it is "live" when its transcript was written a moment ago: then adopting forks instead of colliding
    (gw.manager.registry as any)["db"].prepare("DELETE FROM sessions WHERE provider = 'codex' AND provider_session_id = ?").run(uuid);
    setActivity(10_000); // written seconds ago: another process has it open
    const forked = await api("POST", `/v1/agent-sessions/codex/${uuid}/adopt`, { mode: "auto" });
    assert.equal(forked.json.mode, "fork");
    assert.match(forked.json.session.providerSessionId, new RegExp(`^fork-\\d+-of-${uuid}$`), "Codex was asked to fork that thread");
    assert.equal(f.sent("thread/fork").at(-1).threadId, uuid);
    assert.match(forked.json.note, /open in a terminal|forked/);
  });

  it("the General Claude can start a Codex session when asked, and hands the conversation to it", async () => {
    const route = (await api("POST", "/v1/routes", {})).json;
    const r = await api("POST", `/v1/routes/${route.id}/handoff`, { projectPath: proj, provider: "codex", message: "echo handed over", title: "Codex in cat-project" });
    assert.equal(r.status, 200);
    assert.equal(r.json.session.provider, "codex");
    assert.equal(r.json.mode, "new");
    assert.equal(await reply(r.json.session.id), "echo: echo handed over");
    const follow = await api("POST", `/v1/routes/${route.id}/message`, { text: "and again" });
    assert.equal(follow.json.sessionId, r.json.session.id, "the same conversation, now answered by Codex");
    assert.equal(await reply(r.json.session.id), "echo: and again");
  });

  it("without the Codex provider installed, asking for it is a clear 400", async () => {
    const bare = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), {});
    await bare.app.listen({ host: "127.0.0.1", port: 0 });
    const b = `http://127.0.0.1:${(bare.app.server.address() as { port: number }).port}`;
    const { code } = bare.auth.createPairingCode();
    const t = ((await (await fetch(b + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
    const r = await fetch(b + "/v1/sessions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ provider: "codex", title: "x" }) });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, /provider "codex" is not available/);
    await bare.app.close();
  });

  it("shutting the gateway down stops the Codex child process", async () => {
    const g = fakeProvider();
    const gw2 = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { codex: g.provider });
    await g.provider.createSession({});
    assert.equal((g.provider as any).server.running, true);
    await gw2.app.close();
    await until(() => (g.provider as any).server.running === false);
  });
});
