import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { writeToPeer } from "../src/discovery/peer.js";
import { FakeProvider } from "../src/providers/fake.js";
import { ReplyTracker, followTerminalReply } from "../src/router/terminal-relay.js";
import { openDb } from "../src/storage/sqlite.js";

const LIVE = "eeeeeeee-2222-4222-8333-000000000001";
const j = (o: unknown) => JSON.stringify(o) + "\n";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => { for (let i = 0; i < ms / 25 && !f(); i++) await wait(25); };

const assistant = (content: unknown[], stop: string | null = null) => j({ type: "assistant", message: { role: "assistant", content, stop_reason: stop } });

describe("reading a terminal session's reply from its transcript", () => {
  it("keeps the text said after the last tool call and ends on end_turn", () => {
    const t = new ReplyTracker();
    t.push(assistant([{ type: "text", text: "Let me look." }, { type: "tool_use", id: "1", name: "Read" }], "tool_use"));
    assert.equal(t.toolPending, true); assert.equal(t.text, "");
    t.push(j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "1", content: "x" }] } }));
    t.push(assistant([{ type: "text", text: "It is done." }], "end_turn"));
    assert.equal(t.ended, true); assert.equal(t.text, "It is done.");
  });

  it("ignores sub-agent chatter and half-written lines", () => {
    const t = new ReplyTracker();
    t.push(j({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "not me" }], stop_reason: "end_turn" } }));
    t.push('{"type":"assistant","message":{"content":[{"type":"te');
    assert.equal(t.text, ""); assert.equal(t.ended, false);
  });

  it("follows the file from the delivery point and ignores what was there before", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helix-follow-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, assistant([{ type: "text", text: "old answer" }], "end_turn"));
    const from = fs.statSync(file).size;
    const pending = followTerminalReply({ file, fromOffset: from, pollMs: 10, quietMs: 60_000 });
    await wait(40);
    fs.appendFileSync(file, assistant([{ type: "text", text: "new answer" }], "end_turn"));
    assert.deepEqual(await pending, { kind: "final", text: "new answer" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats a quiet spell after text (no tool pending) as the end when end_turn is never written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helix-follow-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, "");
    const pending = followTerminalReply({ file, fromOffset: 0, pollMs: 10, quietMs: 80 });
    fs.appendFileSync(file, assistant([{ type: "text", text: "all set" }]));
    assert.deepEqual(await pending, { kind: "final", text: "all set" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("a conversation handed to a session open in a terminal", () => {
  let gw: Gateway, root: string, srv: net.Server, file: string;
  const got: string[] = [];

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-termroute-"));
    const claudeHome = path.join(root, ".claude");
    fs.mkdirSync(path.join(claudeHome, "projects", "p"), { recursive: true });
    fs.mkdirSync(path.join(claudeHome, "sessions"), { recursive: true });
    file = path.join(claudeHome, "projects", "p", `${LIVE}.jsonl`);
    fs.writeFileSync(file,
      j({ type: "user", timestamp: new Date(Date.now() - 1_805_000).toISOString(), cwd: root, message: { content: "working on helix" } }) +
      j({ type: "assistant", timestamp: new Date(Date.now() - 1_800_000).toISOString(), message: { id: "m1", model: "m", content: [{ type: "text", text: "earlier" }], usage: { input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, output_tokens: 5 } } }));
    const sock = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cc-msg-${"cd".repeat(16)}` : path.join(root, "inbox.sock");
    srv = net.createServer((c) => {
      let b = "";
      c.on("data", (d) => { b += d.toString("utf8"); });
      c.on("end", () => got.push(...b.split("\n").filter(Boolean)));
    });
    await new Promise<void>((r) => srv.listen(sock, r));
    fs.writeFileSync(path.join(claudeHome, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: LIVE, cwd: root, kind: "interactive", name: "helix", status: "idle", peerProtocol: 1, messagingSocketPath: sock }));
    const provider = new FakeProvider();
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", routerHome: path.join(root, "router"), discovery: { homes: { claudeHome, codexHome: path.join(root, ".codex") } } }, openDb(":memory:"), { claude: provider });
    gw.router.deliverToPeer = (p, l) => writeToPeer(p, l);
    await gw.indexer!.scan();
    gw.indexer!.refreshLive();
  });
  after(async () => { srv.close(); await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("connects to that very session (no fork), delivers messages to its inbox, and brings its reply back", async () => {
    const route = await gw.router.createRoute();
    const forksBefore = gw.manager.registry.list().length;
    const r = await gw.router.handoff(route.id, { session: `claude:${LIVE}`, message: "connect me to the helix agent" });
    assert.equal(r.mode, "terminal");
    assert.equal(r.droppedRoutingMessage, true, "the connection request itself is not forwarded");
    assert.equal(r.session.providerSessionId, LIVE, "the same session, not a copy");
    assert.equal(gw.manager.registry.list().length, forksBefore + 1, "one record pointing at the original, no branch created");
    assert.equal(gw.router.mustGet(route.id).currentSessionId, r.session.id);

    const size = fs.statSync(file).size;
    const accepted = gw.router.send(route.id, "how far along is the push work?", { voiceStyle: "calm" });
    assert.equal(accepted.sessionId, r.session.id);
    await until(() => got.some((l) => /how far along is the push work\?/.test(l)));
    const line = got.find((l) => /how far along/.test(l))!;
    assert.match(JSON.parse(line).message.content as string, /cross-session-message/);

    const events: any[] = [];
    gw.manager.bus.subscribe((e) => events.push(e));
    // The terminal's own Claude answers in its transcript
    assert.ok(fs.statSync(file).size >= size);
    fs.appendFileSync(file, assistant([{ type: "text", text: "Push registration is done." }], "end_turn"));
    await until(() => events.some((e) => e.type === "agent.output.final"));
    const final = events.find((e) => e.type === "agent.output.final");
    assert.equal(final.text, "Push registration is done.");
    assert.ok(events.some((e) => e.type === "agent.speech"), "a spoken turn is spoken");
    const msgs = gw.manager.messages.list(r.session.id, 0, 50);
    assert.ok(msgs.some((m: any) => m.sender === "user" && /push work/.test(m.text)));
    assert.ok(msgs.some((m: any) => m.sender === "agent" && /Push registration is done/.test(m.text)));
    assert.equal(gw.manager.registry.get(r.session.id)!.status, "idle");
  });

  it("a terminal in bypass mode: what the user says needs no approval, a model-composed first message still does", async () => {
    fs.appendFileSync(file, j({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: LIVE }));
    gw.router.deliverToPeer = (p, l) => writeToPeer(p, l);
    const asked: string[] = [];
    gw.router.approveTerminalSend = async (summary) => { asked.push(summary); return true; };
    const route = await gw.router.createRoute();
    await gw.router.handoff(route.id, { session: `claude:${LIVE}` });
    gw.router.send(route.id, "spoken straight through");
    await until(() => got.some((l) => /spoken straight through/.test(l)));
    assert.equal(asked.length, 0, "the user's own words are not held for approval");
    const line = got.find((l) => /spoken straight through/.test(l))!;
    assert.match(JSON.parse(line).message.content as string, /from-mode="bypass"/);
    fs.appendFileSync(file, assistant([{ type: "text", text: "Heard you." }], "end_turn")); // lets the reply reader finish
    await wait(1200);
    // A message the front door composed itself rides the handoff and does ask
    const route2 = await gw.router.createRoute();
    await gw.router.handoff(route2.id, { session: `claude:${LIVE}`, message: "please run the full test suite" });
    await until(() => got.some((l) => /full test suite/.test(l)));
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /permissions bypassed/);
    fs.appendFileSync(file, assistant([{ type: "text", text: "Running it." }], "end_turn"));
    await wait(1200);
  });

  it("an explicit fork request is still honoured", async () => {
    const route = await gw.router.createRoute();
    const r = await gw.router.handoff(route.id, { session: `claude:${LIVE}`, mode: "fork" });
    assert.equal(r.mode, "fork");
  });

  it("opening it from the Chats tab does not fork either: adopt returns the same session and typed messages go to its inbox", async () => {
    gw.router.deliverToPeer = (p, l) => writeToPeer(p, l);
    const before = gw.manager.registry.list().length;
    const a = await gw.router.adopt("claude", LIVE);
    assert.equal(a.mode, "terminal");
    assert.equal(a.session.providerSessionId, LIVE);
    assert.ok(gw.manager.registry.list().length <= before + 1);
    const again = await gw.router.adopt("claude", LIVE);
    assert.equal(again.session.id, a.session.id, "opening it twice reuses the one record");
    const f = await gw.router.adopt("claude", LIVE, "fork");
    assert.equal(f.mode, "fork", "an explicit fork is still a fork");

    gw.router.sendMessage(a.session.id, "typed in the chats tab");
    await until(() => got.some((l) => /typed in the chats tab/.test(l)));
    assert.ok(got.some((l) => /typed in the chats tab/.test(l)), "went to the terminal's inbox");
    fs.appendFileSync(file, assistant([{ type: "text", text: "Got it." }], "end_turn"));
    await wait(1200);
  });

  it("says so, and sends nothing, when the inbox cannot be reached (no silent fork)", async () => {
    const route = await gw.router.createRoute();
    const r = await gw.router.handoff(route.id, { session: `claude:${LIVE}` });
    gw.router.deliverToPeer = async () => ({ ok: false, error: "ECONNREFUSED" });
    const events: any[] = [];
    gw.manager.bus.subscribe((e) => events.push(e));
    gw.router.send(route.id, "are you there?");
    await until(() => events.some((e) => e.type === "message.created" && e.message.sender === "system"));
    const note = events.find((e) => e.type === "message.created" && e.message.sender === "system");
    assert.match(note.message.text, /not forked/);
    assert.equal(gw.manager.registry.list().filter((s) => s.providerSessionId !== LIVE && s.role !== "router").length, 2, "only the two explicit forks from the earlier tests exist");
    void r;
  });
});
