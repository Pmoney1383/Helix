// A stand-in for `codex app-server --stdio` that speaks the real JSON-RPC shapes (verified against the
// schema `codex app-server generate-json-schema` produces and against a live server), driven by the
// text of the prompt so tests are deterministic:
//
//   (anything)              echoes "echo: <prompt>" in streamed deltas
//   RUN <command>           asks for command approval, then reports accepted/declined
//   DELETE <path>           a file change that deletes <path>, asks for approval
//   PATCH <path>            a file change that adds <path>, asks for approval
//   PERMS                   asks to widen the sandbox (write access + network)
//   ASK                     asks the user a question
//   MCP <server>.<tool>     asks permission to run an MCP tool (real elicitation shape)
//   FORM                    an MCP form that asks the user for data
//   WEIRD                   sends a request the client does not support
//   SLOW                    streams for ~3 s unless interrupted
//   FAIL                    the turn fails with an error
//   CRASH                   the process dies mid-turn
//
// Every message in either direction is appended to $FAKE_CODEX_LOG as JSON lines, for assertions.
import fs from "node:fs";
import readline from "node:readline";

const LOG = process.env.FAKE_CODEX_LOG;
const record = (dir, msg) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ dir, msg }) + "\n"); };
const out = (m) => { record("out", m); process.stdout.write(JSON.stringify(m) + "\n"); };

const threads = new Map(); // threadId -> { cwd, interrupted }
let seq = 0;
let nextServerId = 0;
const waiting = new Map(); // server-request id -> resolve

const request = (method, params) => new Promise((resolve) => {
  const id = nextServerId++;
  waiting.set(id, resolve);
  out({ id, method, params });
});

const note = (method, params) => out({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(threadId, turnId, text) {
  const t = threads.get(threadId);
  const base = { threadId, turnId };
  note("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
  note("item/started", { ...base, item: { type: "userMessage", id: `u-${turnId}`, content: [{ type: "text", text }] } });

  const say = async (s, phase = "final_answer", itemId = `m-${turnId}-${Math.random().toString(36).slice(2, 6)}`) => {
    note("item/started", { ...base, item: { type: "agentMessage", id: itemId, text: "", phase } });
    for (const piece of s.match(/.{1,6}/gs) ?? []) { note("item/agentMessage/delta", { ...base, itemId, delta: piece }); await sleep(2); }
    note("item/completed", { ...base, item: { type: "agentMessage", id: itemId, text: s, phase } });
    return { type: "agentMessage", id: itemId, text: s, phase };
  };
  const finish = (items, status = "completed", error = null) =>
    note("turn/completed", { threadId, turn: { id: turnId, status, items, error } });

  const m = /^(RUN|DELETE|PATCH) (.+)$/s.exec(text);
  if (m && m[1] === "RUN") {
    const cmd = m[2];
    note("item/started", { ...base, item: { type: "commandExecution", id: "c1", command: `"powershell.exe" -Command '${cmd}'`, commandActions: [{ type: "unknown", command: cmd }], status: "inProgress" } });
    const res = await request("item/commandExecution/requestApproval", {
      kind: "command", ...base, itemId: "c1", command: `"powershell.exe" -Command '${cmd}'`, cwd: threads.get(threadId).cwd,
      commandActions: [{ type: "unknown", command: cmd }], availableDecisions: ["accept", "cancel"],
    });
    const msg = await say(res?.decision === "accept" ? `ran: ${cmd}` : `refused: ${cmd}`);
    return finish([msg]);
  }
  if (m && (m[1] === "DELETE" || m[1] === "PATCH")) {
    const kind = m[1] === "DELETE" ? { type: "delete" } : { type: "add" };
    note("item/started", { ...base, item: { type: "fileChange", id: "f1", changes: [{ path: m[2], kind, diff: "" }], status: "inProgress" } });
    const res = await request("item/fileChange/requestApproval", { ...base, itemId: "f1", reason: "apply changes" });
    return finish([await say(res?.decision === "accept" ? `changed: ${m[2]}` : `not changed: ${m[2]}`)]);
  }
  if (text === "PERMS") {
    const perms = { fileSystem: { write: ["C:/data"], read: null, entries: null, globScanMaxDepth: null }, network: { enabled: true } };
    const res = await request("item/permissions/requestApproval", { ...base, itemId: "p1", cwd: threads.get(threadId).cwd, permissions: perms, reason: "need network" });
    return finish([await say(`granted: ${JSON.stringify(res?.permissions ?? null)}`)]);
  }
  if (text === "ASK") {
    const res = await request("item/tool/requestUserInput", { ...base, itemId: "q1", isBlocking: true, questions: [{ id: "q", header: "h", question: "Which database?", isOther: false, isSecret: false }] });
    return finish([await say(`answers: ${JSON.stringify(res?.answers ?? null)}`)]);
  }
  const mcp = /^MCP ([^.\s]+)\.(\S+)$/.exec(text);
  if (mcp) {
    note("item/started", { ...base, item: { type: "mcpToolCall", id: "t1", server: mcp[1], tool: mcp[2], arguments: {}, status: "inProgress" } });
    const res = await request("mcpServer/elicitation/request", {
      ...base, serverName: mcp[1], mode: "form", message: `Allow the ${mcp[1]} MCP server to run tool "${mcp[2]}"?`,
      _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "x", tool_params: { branch: "main" }, tool_params_display: [] },
      requestedSchema: { type: "object", properties: {} },
    });
    return finish([await say(res?.action === "accept" ? `tool ran: ${mcp[1]}.${mcp[2]}` : `tool blocked: ${mcp[1]}.${mcp[2]} (${res?.action})`)]);
  }
  if (text === "FORM") {
    const res = await request("mcpServer/elicitation/request", {
      ...base, serverName: "other", mode: "form", message: "What is your API key?", _meta: {},
      requestedSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    });
    return finish([await say(`form answered: ${res?.action}`)]);
  }
  if (text === "WEIRD") {
    const res = await request("weird/method", { threadId, ...base });
    return finish([await say(`weird replied: ${res?.__error ?? "ok"}`)]);
  }
  if (text === "SLOW") {
    for (let i = 0; i < 60; i++) {
      if (t.interrupted) { t.interrupted = false; return finish([], "interrupted"); }
      note("item/agentMessage/delta", { ...base, itemId: "slow", delta: "." });
      await sleep(50);
    }
    return finish([await say("slow done")]);
  }
  if (text === "FAIL") {
    note("error", { ...base, error: { message: "model overloaded" }, willRetry: false });
    return finish([], "failed", { message: "model overloaded" });
  }
  if (text === "CRASH") {
    await say("about to ", "commentary");
    process.exit(1);
  }
  return finish([await say(`echo: ${text}`)]);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  record("in", m);

  if (m.id !== undefined && m.method === undefined) { // reply to one of our requests
    const r = waiting.get(m.id);
    waiting.delete(m.id);
    r?.(m.error ? { __error: m.error.message } : m.result);
    return;
  }
  if (m.method === "initialized") return;

  const reply = (result) => out({ id: m.id, result });
  const fail = (message) => out({ id: m.id, error: { code: -32000, message } });
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize": return reply({ userAgent: "fake-codex/0.0.0", codexHome: "C:/fake/.codex", platformFamily: "windows", platformOs: "windows" });
    case "thread/start": { const id = `th-${++seq}`; threads.set(id, { cwd: p.cwd }); return reply({ thread: { id }, model: "fake-model", cwd: p.cwd }); }
    case "thread/resume":
      if (threads.has(p.threadId)) return reply({ thread: { id: p.threadId } });
      if (/^old-/.test(p.threadId) || process.env.FAKE_CODEX_RESUME_ANY) { threads.set(p.threadId, { cwd: p.cwd }); return reply({ thread: { id: p.threadId } }); }
      return fail(`no rollout found for thread id ${p.threadId}`);
    case "thread/fork": { const id = `fork-${++seq}-of-${p.threadId}`; threads.set(id, { cwd: p.cwd }); return reply({ thread: { id, forkedFromId: p.threadId } }); }
    case "turn/start": {
      const turnId = `turn-${++seq}`;
      const text = (p.input ?? []).map((i) => i.text ?? "").join("");
      reply({ turn: { id: turnId, status: "inProgress", items: [] } });
      void runTurn(p.threadId, turnId, text);
      return;
    }
    case "turn/interrupt": { const t = threads.get(p.threadId); if (t) t.interrupted = true; return reply({}); }
    default: return fail(`unknown method ${m.method}`);
  }
});
