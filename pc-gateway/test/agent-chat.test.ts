import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const BIG = "eeeeeeee-1111-4222-8333-000000000001";
const SMALL = "eeeeeeee-1111-4222-8333-000000000002";
const j = (o: unknown) => JSON.stringify(o) + "\n";

let gw: Gateway;
let base: string;
let root: string;
let hostedToken: string;
let agentToken: string;

const transcript = (tokens: number) =>
  j({ type: "user", timestamp: new Date(Date.now() - 1_805_000).toISOString(), cwd: root, message: { content: "earlier question" } }) +
  j({ type: "assistant", timestamp: new Date(Date.now() - 1_800_000).toISOString(), message: { id: "m1", model: "m", content: [{ type: "text", text: "earlier answer" }], usage: { input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 5 } } });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-chat-"));
  const claudeHome = path.join(root, ".claude");
  fs.mkdirSync(path.join(claudeHome, "projects", "p"), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, "projects", "p", `${BIG}.jsonl`), transcript(400_000));
  fs.writeFileSync(path.join(claudeHome, "projects", "p", `${SMALL}.jsonl`), transcript(20_000));
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", discovery: { homes: { claudeHome, codexHome: path.join(root, ".codex") } } }, openDb(":memory:"), { claude: new FakeProvider() });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  await gw.indexer!.scan();
  hostedToken = gw.localTokens.create("hosted:test", "pc.hosted", { ttlDays: 1 }).token;
  agentToken = gw.localTokens.create("terminal-agents", "pc.agent.local").token;
});
after(async () => { srv?.close(); await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

const connect = async (token: string) => {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
};
const text = (r: any): string => r.content[0].text;
/** Everything written to the fake terminal inbox. */
const got: string[] = [];
let srv: net.Server | undefined;

describe("hosted chats can talk to agents", () => {
  it("offers the tools to hosted chats but not to terminal agents", async () => {
    const h = await connect(hostedToken);
    const names = (await h.listTools()).tools.map((t) => t.name);
    for (const n of ["send_agent_message", "read_agent_session", "search_agent_sessions"]) assert.ok(names.includes(n), n);
    await h.close();
    const a = await connect(agentToken);
    assert.ok(!(await a.listTools()).tools.some((t) => t.name === "send_agent_message"));
    await a.close();
  });

  it("finds a session, sends it a message, and the message reaches the agent", async () => {
    const c = await connect(hostedToken);
    const found: any = await c.callTool({ name: "search_agent_sessions", arguments: { query: "earlier" } });
    assert.ok(!found.isError);
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${SMALL}`, text: "how is it going?" } });
    assert.ok(!r.isError, text(r));
    const sent = JSON.parse(text(r));
    assert.equal(sent.sent, true);
    const msgs = gw.manager.messages.list(sent.sessionId, 0, 50);
    assert.ok(msgs.some((m: any) => m.sender === "user" && /how is it going\?/.test(m.text) && /hosted chat/.test(m.text)));
    const read: any = await c.callTool({ name: "read_agent_session", arguments: { session: sent.sessionId } });
    assert.ok(!read.isError, text(read));
    await c.close();
  });

  it("will not quietly wake a huge session; says the size and the Helix id, then sends once confirmed", async () => {
    const c = await connect(hostedToken);
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${BIG}`, text: "status?" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /400010 tokens/);
    const id = /Helix sessionId: ([0-9a-f-]{36})/.exec(text(r))?.[1];
    assert.ok(id, text(r));
    const again: any = await c.callTool({ name: "send_agent_message", arguments: { session: id, text: "status?", confirmHeavy: true } });
    assert.ok(!again.isError, text(again));
    await c.close();
  });
});

describe("sessions open in a terminal get the message directly", () => {
  const LIVE = "eeeeeeee-1111-4222-8333-000000000003";
  const LIVE_BIG = "eeeeeeee-1111-4222-8333-000000000004";
  let sock: string;

  before(async () => {
    const claudeHome = path.join(root, ".claude");
    sock = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cc-msg-${"ab".repeat(16)}` : path.join(root, "inbox.sock");
    srv = net.createServer((c) => {
      let b = "";
      c.on("data", (d) => { b += d.toString("utf8"); });
      c.on("end", () => got.push(...b.split("\n").filter(Boolean)));
    });
    await new Promise<void>((r) => srv!.listen(sock, r));
    fs.writeFileSync(path.join(claudeHome, "projects", "p", `${LIVE}.jsonl`), transcript(20_000));
    fs.writeFileSync(path.join(claudeHome, "projects", "p", `${LIVE_BIG}.jsonl`), transcript(400_000));
    // Both claim the same pid and inbox; each record is its own file, so use two fake pids that count as alive
    for (const [pid, id] of [[process.pid, LIVE], [process.ppid, LIVE_BIG]] as const) {
      fs.writeFileSync(path.join(claudeHome, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: root, kind: "interactive", name: `term-${pid}`, status: "idle", peerProtocol: 1, messagingSocketPath: sock }));
    }
    await gw.indexer!.scan();
    gw.indexer!.refreshLive();
  });

  it("delivers into the open session and does not fork or adopt it", async () => {
    const c = await connect(hostedToken);
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${LIVE}`, text: "status please" } });
    assert.ok(!r.isError, text(r));
    const out = JSON.parse(text(r));
    assert.equal(out.delivered, "terminal");
    assert.equal(out.sessionRef, `claude:${LIVE}`);
    await new Promise((res) => setTimeout(res, 150));
    assert.ok(got.some((l) => /status please/.test(l) && /hosted chat/.test(l)), got.join("\n"));
    assert.equal(gw.manager.registry.findByProviderId("claude", LIVE), undefined, "no Helix copy was made");
    await c.close();
  });

  it("still asks before waking a huge terminal session whose cache is cold", async () => {
    const c = await connect(hostedToken);
    const before = got.length;
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${LIVE_BIG}`, text: "hello" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /terminal session holds about 400k tokens/);
    assert.equal(got.length, before, "nothing was sent");
    const ok: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${LIVE_BIG}`, text: "hello", confirmHeavy: true } });
    assert.ok(!ok.isError, text(ok));
    await c.close();
  });
});

describe("a terminal running with permissions bypassed is approved on the phone", () => {
  const LIVE = "eeeeeeee-1111-4222-8333-000000000003"; // registered as a live terminal session by the block above
  const modeLine = JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: LIVE }) + "\n";
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Delivery happens after the approval, and the first one asks PowerShell which Windows session we are in. */
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await wait(50); };

  it("asks first, then delivers marked as approved, with a note on how the reply comes back", async () => {
    fs.appendFileSync(path.join(root, ".claude", "projects", "p", `${LIVE}.jsonl`), modeLine);
    const asked: string[] = [];
    gw.router.approveTerminalSend = async (summary) => { asked.push(summary); return true; };
    const c = await connect(hostedToken);
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${LIVE}`, text: "approved please" } });
    assert.ok(!r.isError, text(r));
    assert.equal(JSON.parse(text(r)).pendingApproval, true);
    await until(() => got.some((l) => /approved please/.test(l)));
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /permissions bypassed/);
    const line = got.find((l) => /approved please/.test(l));
    assert.ok(line, "the approved message reached the inbox");
    const content = JSON.parse(line!).message.content as string;
    assert.match(content, /from-mode="bypass"/);
    assert.match(content, /Do not use SendMessage/);
    await c.close();
  });

  it("delivers nothing when the user declines", async () => {
    let called = 0;
    gw.router.approveTerminalSend = async () => { called++; return false; };
    const c = await connect(hostedToken);
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${LIVE}`, text: "declined please" } });
    assert.equal(JSON.parse(text(r)).pendingApproval, true);
    await wait(300);
    assert.equal(called, 1);
    assert.ok(!got.some((l) => /declined please/.test(l)), "a declined message is never sent");
    await c.close();
  });
});
