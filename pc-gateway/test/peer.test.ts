import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { findPeer, peerLines, writeToPeer } from "../src/discovery/peer.js";

const SID = "ffffffff-1111-4222-8333-000000000001";
let home: string;
let server: net.Server;
let socketPath: string;
const received: string[] = [];

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "helix-peer-"));
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cc-msg-${randomBytes(16).toString("hex")}` : path.join(home, "inbox.sock");
  server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => { buf += d.toString("utf8"); });
    c.on("end", () => { received.push(...buf.split("\n").filter(Boolean)); });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  const hash = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: SID, procStart: "99", peerProtocol: 1, messagingSocketPath: socketPath, name: "helix-x", status: "idle" }));
  fs.writeFileSync(path.join(dir, `4242.${hash}.key`), JSON.stringify({ peerToken: "a".repeat(32), procStartFt: "99" }));
  // A stale record for a dead process, and a record without an inbox
  fs.writeFileSync(path.join(dir, "7.json"), JSON.stringify({ pid: 7, sessionId: "dead", peerProtocol: 1, messagingSocketPath: socketPath }));
  fs.writeFileSync(path.join(dir, "8.json"), JSON.stringify({ pid: 8, sessionId: "noinbox", peerProtocol: 1 }));
});
after(async () => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });

const alive = (pid: number) => pid === 4242 || pid === 8;

describe("terminal session inbox", () => {
  it("finds a live session's inbox and token by session id", () => {
    const t = findPeer(home, SID.toUpperCase(), alive);
    assert.equal(t?.pid, 4242);
    assert.equal(t?.socketPath, socketPath);
    assert.equal(t?.token, "a".repeat(32));
    assert.equal(t?.name, "helix-x");
  });

  it("with two live terminals on the same session, picks the one active most recently", () => {
    const dir = path.join(home, "sessions");
    const two = "ffffffff-1111-4222-8333-000000000002";
    fs.writeFileSync(path.join(dir, "11.json"), JSON.stringify({ pid: 11, sessionId: two, peerProtocol: 1, messagingSocketPath: socketPath, startedAt: 1000, updatedAt: 5000, name: "old" }));
    fs.writeFileSync(path.join(dir, "12.json"), JSON.stringify({ pid: 12, sessionId: two, peerProtocol: 1, messagingSocketPath: socketPath, startedAt: 3000, updatedAt: 9000, name: "new" }));
    fs.writeFileSync(path.join(dir, "10.json"), JSON.stringify({ pid: 10, sessionId: two, peerProtocol: 1, messagingSocketPath: socketPath, startedAt: 500, updatedAt: 100, name: "oldest" }));
    assert.equal(findPeer(home, two, () => true)?.name, "new");
    assert.equal(findPeer(home, two, (pid) => pid !== 12)?.name, "old");
  });

  it("ignores dead processes, sessions without an inbox, and unknown ids", () => {
    assert.equal(findPeer(home, "dead", alive), undefined);
    assert.equal(findPeer(home, "noinbox", alive), undefined);
    assert.equal(findPeer(home, "nope", alive), undefined);
    assert.equal(findPeer(path.join(home, "missing"), SID, alive), undefined);
  });

  it("does not trust a key that belongs to a different process start", () => {
    const dir = path.join(home, "sessions");
    fs.writeFileSync(path.join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: SID, procStart: "100", peerProtocol: 1, messagingSocketPath: socketPath }));
    assert.equal(findPeer(home, SID, alive)?.token, undefined);
    fs.writeFileSync(path.join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: SID, procStart: "99", peerProtocol: 1, messagingSocketPath: socketPath, name: "helix-x", status: "idle" }));
  });

  it("writes an auth line then one message line, labelled as coming from Helix", async () => {
    const t = findPeer(home, SID, alive)!;
    const r = await writeToPeer(t.socketPath, peerLines(t, "how is the build going?\nsecond line"));
    assert.equal(r.ok, true, r.error ?? "");
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(received.length, 2);
    assert.deepEqual(JSON.parse(received[0]!), { type: "auth", token: "a".repeat(32) });
    const m = JSON.parse(received[1]!);
    assert.equal(m.type, "user");
    assert.equal(m.msgV, 1);
    assert.match(m.message.content, /^<cross-session-message from="helix:helix" from-name="Helix">\nhow is the build going\?\nsecond line\n\n\(Helix has no inbox to reply to\..*Do not use SendMessage for it\.\)\n<\/cross-session-message>$/s);
    assert.ok(!/from-mode/.test(m.message.content), "never claims bypass unless the user approved it");
  });

  it("reports a failure instead of throwing when nothing is listening", async () => {
    const gone = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cc-msg-${"0".repeat(32)}` : path.join(home, "none.sock");
    const r = await writeToPeer(gone, ["x"], 1000);
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
});
