#!/usr/bin/env node
// Forwards Claude Code hook events to the Helix gateway on this PC.
//
//   helix-hook.mjs <event>        event JSON arrives on stdin (session_id, transcript_path, cwd, ...)
//
//   stop | notification   fire-and-forget: tell Helix a turn ended / Claude needs you
//   pretooluse            ask Helix before a possibly destructive command runs. While the user is away
//                         this can wait for their phone; otherwise it answers instantly with no opinion.
//
// Rules this script lives by:
//  - It must NEVER disturb the session: no stray output, always exit 0, hard time limits.
//  - If Helix is down, not installed, or slow, it silently does nothing and Claude carries on
//    (so Helix can never be the reason work is blocked).
//
// Credentials are read at run time from ~/.helix/local.json (written by `helix connect`),
// so rotating the token never requires editing Claude's settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const event = (process.argv[2] ?? "unknown").toLowerCase();
const WAITS = event === "pretooluse";
// A permission check may legitimately wait for the user; everything else must be near-instant.
const HARD_LIMIT_MS = WAITS ? 31 * 60_000 + 30_000 : 4000;
setTimeout(() => process.exit(0), HARD_LIMIT_MS).unref();

async function readStdin(timeoutMs) {
  if (process.stdin.isTTY) return "";
  return await new Promise((resolve) => {
    let data = "";
    const t = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => { clearTimeout(t); resolve(data); });
    process.stdin.on("error", () => { clearTimeout(t); resolve(data); });
  });
}

async function main() {
  const home = process.env.HELIX_HOME ?? path.join(os.homedir(), ".helix");
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "local.json"), "utf8"));
  let payload = {};
  try { payload = JSON.parse(await readStdin(1500)); } catch { /* no/invalid stdin */ }
  const headers = { "content-type": "application/json", authorization: `Bearer ${cfg.token}` };

  if (!WAITS) {
    await fetch(`${cfg.url}/v1/agent-events`, {
      method: "POST", headers, body: JSON.stringify({ provider: "claude", event, payload }), signal: AbortSignal.timeout(3000),
    });
    return;
  }

  const res = await fetch(`${cfg.url}/v1/agent-events/permission`, {
    method: "POST", headers, body: JSON.stringify({ provider: "claude", payload }), signal: AbortSignal.timeout(31 * 60_000),
  });
  const answer = await res.json();
  // Only speak up when Helix has a decision. Printing nothing means "carry on as normal".
  if (answer.decision === "allow" || answer.decision === "deny") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: answer.decision,
        permissionDecisionReason: answer.reason ?? "",
      },
    }));
  }
}

main().catch(() => { /* never disturb the session */ }).finally(() => process.exit(0));
