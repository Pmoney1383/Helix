import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import type { Scope } from "../src/mcp/scopes.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

let gw: Gateway;
let base: string;
let deviceToken: string;
let sessionId: string;

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

async function mcpClient(scope: Scope, withSession = true) {
  const token = gw.agentTokens.issue({ scope, sessionId: withSession ? sessionId : undefined, actor: `test:${scope}` });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

const text = (r: any): string => r.content[0].text;
const waitPending = async (): Promise<any> => {
  for (let i = 0; i < 200; i++) {
    const { json } = await api("GET", "/v1/approvals?status=pending");
    if (json.approvals.length) return json.approvals[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no pending approval appeared");
};

before(async () => {
  const db = openDb(":memory:");
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", approvalTtlMs: 60_000 }, db, { claude: new FakeProvider() });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = gw.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const { code } = gw.auth.createPairingCode();
  deviceToken = (await (await fetch(base + "/v1/pair/complete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "phone" }),
  })).json() as any).token;
  sessionId = (await api("POST", "/v1/sessions", { title: "gate test", projectPath: os.tmpdir() })).json.id;
});

after(async () => { await gw.app.close(); });

const prompt = (c: Client, tool_name: string, input: Record<string, unknown>) =>
  c.callTool({ name: "permission_prompt", arguments: { tool_name, input } });

describe("permission gate (what Claude's --permission-prompt-tool calls)", () => {
  it("auto-allows normal actions without creating an approval", async () => {
    const c = await mcpClient("pc.agent.full");
    for (const [tool, input] of [["Bash", { command: "npm run build" }], ["Edit", { file_path: "a.ts" }], ["Write", { file_path: "b.ts", content: "x" }]] as const) {
      const out = JSON.parse(text(await prompt(c, tool, { ...input })));
      assert.equal(out.behavior, "allow", tool);
      assert.deepEqual(out.updatedInput, input);
    }
    assert.equal((await api("GET", "/v1/approvals?status=pending")).json.approvals.length, 0);
    await c.close();
  });

  it("blocks a deletion until the phone approves, then allows it", async () => {
    const c = await mcpClient("pc.agent.full");
    const pending = prompt(c, "Bash", { command: "rm -rf checkpoints/old-run-17" });
    const approval = await waitPending();
    assert.match(approval.summary, /rm -rf checkpoints\/old-run-17/);
    assert.equal(approval.sessionId, sessionId);
    assert.equal(approval.source, "agent");

    const decided = await api("POST", `/v1/approvals/${approval.id}/approve`, { note: "ok" });
    assert.equal(decided.json.status, "approved");
    assert.equal(JSON.parse(text(await pending)).behavior, "allow");
    await c.close();
  });

  it("denies a rejected deletion and tells the agent not to retry", async () => {
    const c = await mcpClient("pc.agent.full");
    const pending = prompt(c, "Bash", { command: "Remove-Item -Recurse data" });
    const approval = await waitPending();
    await api("POST", `/v1/approvals/${approval.id}/reject`);
    const out = JSON.parse(text(await pending));
    assert.equal(out.behavior, "deny");
    assert.match(out.message, /rejected/i);
    assert.match(out.message, /Do not retry/);
    await c.close();
  });

  it("approvals are single-use: replaying or flipping a settled approval changes nothing", async () => {
    const c = await mcpClient("pc.agent.full");
    const pending = prompt(c, "Bash", { command: "del important.txt" });
    const approval = await waitPending();
    await api("POST", `/v1/approvals/${approval.id}/reject`);
    await pending;

    const replay = await api("POST", `/v1/approvals/${approval.id}/approve`);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.status, "rejected", "a rejected approval cannot be approved afterwards");
    assert.equal((await api("POST", "/v1/approvals/nope/approve")).status, 404);
    await c.close();
  });

  it("fails closed when nobody answers", async () => {
    const db = openDb(":memory:");
    const g = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", approvalTtlMs: 80 }, db, { claude: new FakeProvider() });
    const { outcome, approval } = g.approvals.request({ source: "agent", tool: "Bash", summary: "rm x" });
    const r = await outcome;
    assert.equal(r.approved, false);
    assert.equal(r.status, "expired");
    assert.equal(g.approvals.get(approval.id)?.status, "expired");
    assert.equal(g.approvals.resolve(approval.id, true)?.status, "expired", "late approval after expiry is ignored");
    await g.app.close();
  });

  it("withdraws the request when the agent call is cancelled", async () => {
    const ac = new AbortController();
    const { outcome, approval } = gw.approvals.request({ source: "agent", tool: "Bash", summary: "rm y", signal: ac.signal });
    ac.abort();
    assert.equal((await outcome).status, "cancelled");
    assert.equal(gw.approvals.get(approval.id)?.status, "cancelled");
  });

  it("flags tools named like deletions and obfuscated shell", async () => {
    const c = await mcpClient("pc.agent.full");
    const p1 = prompt(c, "mcp__gitkraken__delete_branch", { branch: "x" });
    const a1 = await waitPending();
    await api("POST", `/v1/approvals/${a1.id}/reject`);
    assert.equal(JSON.parse(text(await p1)).behavior, "deny");

    const p2 = prompt(c, "Bash", { command: "powershell -enc UgBlAG0AbwB2AGUALQBJAHQAZQBtACAAeAA=" });
    const a2 = await waitPending();
    assert.ok(a2.reasons.some((r: string) => /cannot inspect/.test(r)));
    await api("POST", `/v1/approvals/${a2.id}/reject`);
    await p2;
    await c.close();
  });

  it("pushes approval events over the websocket and into the conversation", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${deviceToken}` } });
    const events: any[] = [];
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));

    const c = await mcpClient("pc.agent.full");
    const pending = prompt(c, "Bash", { command: "rm -rf build" });
    const approval = await waitPending();
    await api("POST", `/v1/approvals/${approval.id}/approve`);
    await pending;
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(events.some((e) => e.type === "approval.requested" && e.approval.id === approval.id));
    assert.ok(events.some((e) => e.type === "approval.resolved" && e.approval.status === "approved"));
    const msgs = (await api("GET", `/v1/conversations/${sessionId}/messages`)).json.messages;
    assert.ok(msgs.some((m: any) => m.type === "approval" && /Approval needed/.test(m.text)));
    ws.close();
    await c.close();
  });
});

describe("MCP scopes", () => {
  it("rejects connections without a valid agent token", async () => {
    const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
    assert.equal(res.status, 401);
    const asDevice = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` }, body: "{}" });
    assert.equal(asDevice.status, 401, "a phone token is not an MCP credential");
  });

  it("pc.observe lists read-only tools only", async () => {
    const c = await mcpClient("pc.observe", false);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("get_pc_status") && names.includes("tail_file"));
    for (const forbidden of ["run_command", "write_file", "stop_process", "permission_prompt", "request_user_approval"]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not be exposed to observe`);
    }
    await c.close();
  });

  it("pc.control adds control tools but not the agent-only gate", async () => {
    const c = await mcpClient("pc.control", false);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("run_command") && names.includes("write_file"));
    assert.ok(!names.includes("permission_prompt"));
    await c.close();
  });
});

describe("PC tools", () => {
  it("reads status and files; normal edits need no approval", async () => {
    const c = await mcpClient("pc.agent.full");
    const status = JSON.parse(text(await c.callTool({ name: "get_pc_status", arguments: {} })));
    assert.ok(status.memory.totalGB > 0 && status.disks.length > 0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helix-tools-"));
    const file = path.join(dir, "train.log");
    const w = JSON.parse(text(await c.callTool({ name: "write_file", arguments: { path: file, content: "step 100 loss 0.9\nstep 200 loss 0.5\n" } })));
    assert.equal(w.overwrote, false);

    const tail = JSON.parse(text(await c.callTool({ name: "tail_file", arguments: { path: file, lines: 1 } })));
    assert.deepEqual(tail.lines, ["step 200 loss 0.5"]);

    const training = JSON.parse(text(await c.callTool({ name: "get_training_status", arguments: { logPath: file, processName: "no-such-process-xyz" } })));
    assert.equal(training.latest.step, 200);
    assert.equal(training.latest.loss, 0.5);

    const list = JSON.parse(text(await c.callTool({ name: "list_directory", arguments: { path: dir } })));
    assert.equal(list.entries[0].name, "train.log");
    assert.equal((await api("GET", "/v1/approvals?status=pending")).json.approvals.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it("run_command executes normal commands directly", async () => {
    const c = await mcpClient("pc.control");
    const r = JSON.parse(text(await c.callTool({ name: "run_command", arguments: { command: "Write-Output hello-helix" } })));
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello-helix/);
    await c.close();
  });

  it("run_command holds a deletion for approval and does NOT run it until approved", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helix-del-"));
    const victim = path.join(dir, "old-checkpoint.bin");
    fs.writeFileSync(victim, "data");
    const c = await mcpClient("pc.control");

    const pending = c.callTool({ name: "run_command", arguments: { command: `Remove-Item -LiteralPath '${victim}'` } });
    const approval = await waitPending();
    assert.equal(approval.source, "tool");
    assert.ok(fs.existsSync(victim), "file must still exist while approval is pending");

    await api("POST", `/v1/approvals/${approval.id}/reject`);
    const rejected = await pending;
    assert.equal(rejected.isError, true);
    assert.ok(fs.existsSync(victim), "rejected deletion must not run");

    const pending2 = c.callTool({ name: "run_command", arguments: { command: `Remove-Item -LiteralPath '${victim}'` } });
    const approval2 = await waitPending();
    await api("POST", `/v1/approvals/${approval2.id}/approve`);
    const done = JSON.parse(text(await pending2));
    assert.equal(done.exitCode, 0);
    assert.ok(!fs.existsSync(victim), "approved deletion runs");
    fs.rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it("audit log records tool calls and permission decisions", async () => {
    const rows = (gw as any).auth.db.prepare("SELECT action FROM audit_log").all().map((r: any) => r.action) as string[];
    for (const expected of ["mcp.permission_prompt", "permission.decision", "mcp.get_pc_status", "approval.approve", "approval.reject"]) {
      assert.ok(rows.includes(expected), `audit log is missing ${expected}`);
    }
  });
});
