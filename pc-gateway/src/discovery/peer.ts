import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { findClaudeTranscript } from "../usage/context.js";
import { type PidAlive, pidAlive } from "./live.js";

/**
 * Claude Code sessions that are open in a terminal listen on a per-session inbox (a named pipe on Windows, a unix socket
 * elsewhere) so other sessions can message them. This lets Helix drop a message straight into such a session instead of
 * forking it: the session's own Claude reads it at its next tool round, or starts a turn if idle.
 *
 * The wire format is Claude Code's own (peerProtocol 1): one JSON line per message, after an auth line carrying the
 * session's peer token from ~/.claude/sessions/<pid>.<hash>.key. It is not a documented API, so everything here fails
 * soft: no inbox found, or a refused connection, and the caller falls back to forking.
 */

export interface PeerTarget {
  pid: number;
  sessionId: string;
  name?: string;
  socketPath: string;
  token?: string;
  status?: string;
}

const KEY_FILE = /^(\d+)\.[0-9a-f]{64}\.key$/;

/** The live, interactive inbox of a Claude session, if it has one. */
export function findPeer(claudeHome: string, providerSessionId: string, alive: PidAlive = pidAlive): PeerTarget | undefined {
  const dir = path.join(claudeHome, "sessions");
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return undefined; }
  // Two terminals can have the same session open (a resume after a crash): the one touched last is the one in use.
  let best: PeerTarget | undefined;
  let bestAt = -1;
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    let rec: any;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8").replace(/^﻿/, "")); } catch { continue; }
    if (String(rec.sessionId ?? "").toLowerCase() !== providerSessionId.toLowerCase()) continue;
    if (typeof rec.messagingSocketPath !== "string" || !rec.messagingSocketPath || !(rec.peerProtocol >= 1)) continue;
    const pid = Number(rec.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) continue;
    let token: string | undefined;
    for (const k of files) {
      const m = KEY_FILE.exec(k);
      if (!m || Number(m[1]) !== pid) continue;
      try {
        const key = JSON.parse(fs.readFileSync(path.join(dir, k), "utf8").replace(/^﻿/, ""));
        // The key must belong to this very process, not a recycled pid.
        const started = String(rec.procStart ?? "");
        if (typeof key.peerToken === "string" && (!key.procStartFt || !started || String(key.procStartFt) === started)) token = key.peerToken;
      } catch { /* unreadable key */ }
    }
    const at = Math.max(Number(rec.updatedAt) || 0, Number(rec.startedAt) || 0);
    if (at > bestAt) {
      bestAt = at;
      best = { pid, sessionId: String(rec.sessionId), name: rec.name, socketPath: rec.messagingSocketPath, token, status: rec.status };
    }
  }
  return best;
}

/** The lines to write: auth first (when the session published a key), then the message. */
export function peerLines(target: PeerTarget, text: string, sender = "Helix", opts: { bypass?: boolean; call?: boolean } = {}): string[] {
  const from = `helix:${sender.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  // The sender has no inbox of its own, so say how the answer gets back; otherwise the agent tries to SendMessage a dead address.
  const note = `(${sender} has no inbox to reply to. Just answer here as you normally would; ${sender} reads your reply from this conversation. Do not use SendMessage for it.)`;
  // Only claimed when the user approved this message on their phone, standing in for the approval dialog in the terminal.
  const mode = opts.bypass ? ` from-mode="bypass"` : "";
  // On a live phone call the reply is spoken and the user may say goodbye: the agent can hang up with Helix's end_call tool.
  const callNote = opts.call ? `\n(This is a live phone call and your reply will be spoken aloud: keep it to two or three short sentences at most, with the answer first and no lists or long details; offer to put more in the chat. If the user is saying goodbye or wants to end the call, answer with a brief goodbye and call the helix end_call tool; the call then ends once your goodbye has been spoken.)` : "";
  const body = `<cross-session-message from="${from}" from-name="${sender}"${mode}>\n${text}\n\n${note}${callNote}\n</cross-session-message>`;
  const lines: string[] = [];
  if (target.token) lines.push(JSON.stringify({ type: "auth", token: target.token }));
  lines.push(JSON.stringify({ msgV: 1, msg_id: randomUUID(), type: "user", message: { role: "user", content: body }, priority: "next", from }));
  return lines;
}

/** Writes the lines to the session's inbox. Resolves true once the bytes are flushed; never throws. */
export function writeToPeer(socketPath: string, lines: string[], timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: boolean; error?: string }) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(r); } };
    const sock = net.connect({ path: socketPath });
    const timer = setTimeout(() => finish({ ok: false, error: "timed out talking to the session's inbox" }), timeoutMs);
    sock.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, error: e.code ?? e.message }));
    sock.on("connect", () => sock.end(lines.map((l) => l + "\n").join(""), () => setTimeout(() => finish({ ok: true }), 50)));
  });
}

/** The permission mode a Claude session is in right now ("bypassPermissions", "default", ...), from the tail of its transcript. */
export function permissionModeOf(claudeHome: string, providerSessionId: string): string | undefined {
  const file = findClaudeTranscript(claudeHome, providerSessionId);
  if (!file) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? "";
      if (!line.includes('"permission-mode"')) continue;
      try { const j = JSON.parse(line); if (j.type === "permission-mode" && typeof j.permissionMode === "string") return j.permissionMode; } catch { /* cut line */ }
    }
  } catch { return undefined; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  return undefined;
}
