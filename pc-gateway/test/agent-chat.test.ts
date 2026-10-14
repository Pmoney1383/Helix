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
import { openDb, type Db } from "../src/storage/sqlite.js";

const BIG = "eeeeeeee-1111-4222-8333-000000000001";
const SMALL = "eeeeeeee-1111-4222-8333-000000000002";
const j = (o: unknown) => JSON.stringify(o) + "\n";

let gw: Gateway;
let db: Db;
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
  db = openDb(":memory:");
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", discovery: { homes: { claudeHome, codexHome: path.join(root, ".codex") } } }, db, { claude: new FakeProvider() });
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Delivery happens after the approval, and the first one asks PowerShell which Windows session we are in. */
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await wait(50); };
const pendingMessages = () => gw.approvals.list("pending").filter((a) => a.tool === "send_agent_message");
/** What the user does on their phone: approve the hosted chat's message (and wait for it to be delivered). */
const approve = (approvalId: string) => gw.approvals.resolve(approvalId, true, "test-phone");
/** Send from a hosted chat and approve it, as the tests below mostly care about what happens once the user said yes. */
async function sendApproved(c: Client, args: Record<string, unknown>) {
  const r: any = await c.callTool({ name: "send_agent_message", arguments: args });
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.pendingApproval, true, "a hosted chat's message always waits for the user");
  approve(out.approvalId);
  return out;
}

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
    await sendApproved(c, { session: `claude:${SMALL}`, text: "how is it going?" });
    let adopted: string | undefined;
    await until(() => !!(adopted = gw.manager.registry.findByProviderId("claude", SMALL)?.id));
    assert.ok(adopted, "approved: the session was brought under Helix control");
    await until(() => gw.manager.messages.list(adopted!, 0, 50).some((m: any) => m.sender === "user"));
    const msgs = gw.manager.messages.list(adopted!, 0, 50);
    assert.ok(msgs.some((m: any) => m.sender === "user" && /how is it going\?/.test(m.text) && /hosted chat/.test(m.text)));
    const read: any = await c.callTool({ name: "read_agent_session", arguments: { session: adopted! } });
    assert.ok(!read.isError, text(read));
    await c.close();
  });

  it("will not quietly wake a huge session: says the size before the user is asked, then asks once confirmed", async () => {
    const c = await connect(hostedToken);
    const before = pendingMessages().length;
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${BIG}`, text: "status?" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /400010 tokens/);
    assert.equal(pendingMessages().length, before, "the user is not bothered about a message that could not go out");
    const again: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${BIG}`, text: "status?", confirmHeavy: true } });
    assert.ok(!again.isError, text(again));
    assert.equal(JSON.parse(text(again)).pendingApproval, true);
    gw.approvals.resolve(JSON.parse(text(again)).approvalId, false, "test-phone");
    await c.close();
  });
});

describe("the gateway, not the model, decides when a hosted chat's message is delivered", () => {
  const SESSION = "eeeeeeee-1111-4222-8333-000000000005";
  const OTHER = "eeeeeeee-1111-4222-8333-000000000006";
  let phone: { token: string; deviceId: string };

  before(async () => {
    for (const id of [SESSION, OTHER]) fs.writeFileSync(path.join(root, ".claude", "projects", "p", `${id}.jsonl`), transcript(20_000));
    await gw.indexer!.scan();
    const { code } = gw.auth.createPairingCode();
    phone = gw.auth.completePairing(code, "test phone")!;
  });

  const userMessages = (providerId: string) => {
    const s = gw.manager.registry.findByProviderId("claude", providerId);
    return s ? gw.manager.messages.list(s.id, 0, 200).filter((m: any) => m.sender === "user").map((m: any) => m.text as string) : [];
  };
  const idle = async (providerId: string) => {
    const s = gw.manager.registry.findByProviderId("claude", providerId);
    if (s) await until(() => !gw.manager.isRunning(s.id));
  };
  const decide = (approvalId: string, decision: "approve" | "reject", body: Record<string, unknown> = {}) =>
    fetch(`${base}/v1/approvals/${approvalId}/${decision}`, {
      method: "POST", headers: { authorization: `Bearer ${phone.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
  const ask = async (c: Client, session: string, msg: string) => {
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session, text: msg } });
    assert.ok(!r.isError, text(r));
    return JSON.parse(text(r));
  };

  it("asks the user about every message, showing the text and the target, and delivers only once approved", async () => {
    const c = await connect(hostedToken);
    const out = await ask(c, `claude:${SESSION}`, "please run the tests");
    assert.equal(out.sent, false);
    assert.equal(out.pendingApproval, true);
    const a = gw.approvals.get(out.approvalId)!;
    assert.equal(a.status, "pending");
    assert.match(a.summary, /please run the tests/);
    assert.ok(a.trust, "the phone may offer to trust this chat with this session");
    assert.equal(a.trust!.target, `claude:${SESSION}`);
    await wait(200);
    assert.deepEqual(userMessages(SESSION), [], "nothing reaches the agent while the user has not answered");
    approve(out.approvalId);
    await until(() => userMessages(SESSION).length === 1);
    assert.match(userMessages(SESSION)[0]!, /please run the tests/);
    await idle(SESSION);
    await c.close();
  });

  it("never delivers a message the user rejected, or one that expired", async () => {
    const c = await connect(hostedToken);
    const before = userMessages(SESSION).length;
    const out = await ask(c, `claude:${SESSION}`, "rejected message");
    assert.equal((await decide(out.approvalId, "reject")).status, 200);
    await wait(300);
    assert.equal(userMessages(SESSION).length, before);
    assert.ok(!userMessages(SESSION).some((m) => /rejected message/.test(m)));
    await c.close();
  });

  it("approving with trustForMin trusts that chat with that one session, and only for that long", async () => {
    const c = await connect(hostedToken);
    const first = await ask(c, `claude:${SESSION}`, "first, trusted from here on");
    const res = await decide(first.approvalId, "approve", { trustForMin: 30 });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.ok(body.trustGrant, JSON.stringify(body));
    const minutes = (Date.parse(body.trustGrant.expiresAt) - Date.parse(body.trustGrant.createdAt)) / 60_000;
    assert.equal(Math.round(minutes), 30);
    await until(() => userMessages(SESSION).some((m) => /first, trusted/.test(m)));
    assert.ok(userMessages(SESSION).some((m) => /first, trusted/.test(m)), "the approved message itself was delivered");
    await idle(SESSION);

    // Same chat, same session: delivered at once, no new approval.
    const before = pendingMessages().length;
    const trusted = await ask(c, `claude:${SESSION}`, "second, no prompt");
    assert.equal(trusted.sent, true, JSON.stringify(trusted));
    assert.ok(trusted.trustedUntil);
    assert.equal(pendingMessages().length, before);
    await until(() => userMessages(SESSION).some((m) => /second, no prompt/.test(m)));
    assert.ok(userMessages(SESSION).some((m) => /second, no prompt/.test(m)), "the trusted message was delivered");
    await idle(SESSION);

    // Same chat, another session: still asks.
    const other = await ask(c, `claude:${OTHER}`, "other session");
    assert.equal(other.pendingApproval, true);
    gw.approvals.resolve(other.approvalId, false, "test-phone");

    // Another chat, same session: still asks.
    const otherChat = gw.localTokens.create("hosted:other", "pc.hosted", { ttlDays: 1 }).token;
    const c2 = await connect(otherChat);
    const fromOther = await ask(c2, `claude:${SESSION}`, "from another chat");
    assert.equal(fromOther.pendingApproval, true);
    gw.approvals.resolve(fromOther.approvalId, false, "test-phone");
    await c2.close();

    // The user ends it: asks again.
    const list: any = await (await fetch(`${base}/v1/trust-grants`, { headers: { authorization: `Bearer ${phone.token}` } })).json();
    assert.equal(list.grants.length, 1);
    const del = await fetch(`${base}/v1/trust-grants/${list.grants[0].id}`, { method: "DELETE", headers: { authorization: `Bearer ${phone.token}` } });
    assert.equal(del.status, 200);
    const afterRevoke = await ask(c, `claude:${SESSION}`, "after revoke");
    assert.equal(afterRevoke.pendingApproval, true);
    gw.approvals.resolve(afterRevoke.approvalId, false, "test-phone");
    await c.close();
  });

  it("an expired grant asks again", async () => {
    const c = await connect(hostedToken);
    const out = await ask(c, `claude:${OTHER}`, "trust briefly");
    const body: any = await (await decide(out.approvalId, "approve", { trustForMin: 1 })).json();
    assert.ok(body.trustGrant);
    // As if its minute had passed.
    db.prepare("UPDATE trust_grants SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), body.trustGrant.id);
    await until(() => userMessages(OTHER).some((m) => /trust briefly/.test(m)));
    assert.ok(userMessages(OTHER).some((m) => /trust briefly/.test(m)));
    await idle(OTHER);
    const again = await ask(c, `claude:${OTHER}`, "after expiry");
    assert.equal(again.pendingApproval, true);
    gw.approvals.resolve(again.approvalId, false, "test-phone");
    await c.close();
  });

  it("trust cannot be added by a replayed approval, exceed 8 hours, or come from a non-hosted approval", async () => {
    const c = await connect(hostedToken);
    const out = await ask(c, `claude:${SESSION}`, "approve once");
    assert.equal((await decide(out.approvalId, "approve")).status, 200);
    const replay: any = await (await decide(out.approvalId, "approve", { trustForMin: 60 })).json();
    assert.equal(replay.trustGrant, undefined, "a replay of a settled approval grants nothing");
    const tooLong = await ask(c, `claude:${OTHER}`, "too long");
    assert.equal((await decide(tooLong.approvalId, "approve", { trustForMin: 8 * 60 + 1 })).status, 400);
    gw.approvals.resolve(tooLong.approvalId, false, "test-phone");
    const plain = gw.approvals.request({ source: "request", tool: "request_user_approval", summary: "something else" });
    const plainRes: any = await (await decide(plain.approval.id, "approve", { trustForMin: 60 })).json();
    assert.equal(plainRes.trustGrant, undefined);
    const grants: any = await (await fetch(`${base}/v1/trust-grants`, { headers: { authorization: `Bearer ${phone.token}` } })).json();
    assert.equal(grants.grants.length, 0);
    await idle(SESSION);
    await c.close();
  });

  it("the hosted chat has no tool that could approve or trust itself", async () => {
    const c = await connect(hostedToken);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ["request_user_approval", "permission_prompt"]) assert.ok(!names.includes(n), n);
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

  it("delivers into the open session once approved, and does not fork or adopt it", async () => {
    const c = await connect(hostedToken);
    const out = await sendApproved(c, { session: `claude:${LIVE}`, text: "status please" });
    assert.equal(out.sessionRef, `claude:${LIVE}`);
    await until(() => got.some((l) => /status please/.test(l)));
    assert.ok(got.some((l) => /status please/.test(l) && /hosted chat/.test(l)), got.join("\n"));
    assert.equal(gw.manager.registry.findByProviderId("claude", LIVE), undefined, "no Helix copy was made");
    await c.close();
  });

  it("still warns before waking a huge terminal session whose cache is cold", async () => {
    const c = await connect(hostedToken);
    const before = got.length;
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${LIVE_BIG}`, text: "hello" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /holds about 400k tokens/);
    assert.equal(got.length, before, "nothing was sent");
    await sendApproved(c, { session: `claude:${LIVE_BIG}`, text: "hello big", confirmHeavy: true });
    await until(() => got.some((l) => /hello big/.test(l)));
    assert.ok(got.some((l) => /hello big/.test(l)));
    await c.close();
  });
});

describe("a terminal running with permissions bypassed is approved on the phone", () => {
  const LIVE = "eeeeeeee-1111-4222-8333-000000000003"; // registered as a live terminal session by the block above
  const modeLine = JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: LIVE }) + "\n";

  it("asks once (the hosted approval), then delivers marked as approved, with a note on how the reply comes back", async () => {
    fs.appendFileSync(path.join(root, ".claude", "projects", "p", `${LIVE}.jsonl`), modeLine);
    const asked: string[] = [];
    gw.router.approveTerminalSend = async (summary) => { asked.push(summary); return true; };
    const c = await connect(hostedToken);
    await sendApproved(c, { session: `claude:${LIVE}`, text: "approved please" });
    await until(() => got.some((l) => /approved please/.test(l)));
    assert.equal(asked.length, 0, "the user is not asked a second time by the terminal path");
    const line = got.find((l) => /approved please/.test(l));
    assert.ok(line, "the approved message reached the inbox");
    const content = JSON.parse(line!).message.content as string;
    assert.match(content, /from-mode="bypass"/);
    assert.match(content, /Do not use SendMessage/);
    await c.close();
  });

  it("delivers nothing when the user declines", async () => {
    const c = await connect(hostedToken);
    const r: any = await c.callTool({ name: "send_agent_message", arguments: { session: `claude:${LIVE}`, text: "declined please" } });
    const out = JSON.parse(text(r));
    assert.equal(out.pendingApproval, true);
    gw.approvals.resolve(out.approvalId, false, "test-phone");
    await wait(300);
    assert.ok(!got.some((l) => /declined please/.test(l)), "a declined message is never sent");
    await c.close();
  });
});
