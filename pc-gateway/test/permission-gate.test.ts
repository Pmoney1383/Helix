import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const SID = "eeeeeeee-1111-4222-8333-000000000001";
const HOOK = path.resolve("hooks/helix-hook.mjs");

let gw: Gateway;
let base: string;
let localToken: string;
let deviceToken: string;
let helixHome: string;

const pending = async (): Promise<any> => {
  for (let i = 0; i < 300; i++) {
    const { approvals } = (await (await fetch(base + "/v1/approvals?status=pending", { headers: { authorization: `Bearer ${deviceToken}` } })).json()) as any;
    if (approvals.length) return approvals[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no approval appeared");
};
const decide = (id: string, how: "approve" | "reject") =>
  fetch(`${base}/v1/approvals/${id}/${how}`, { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: "{}" });
const ask = (payload: Record<string, unknown>, token = localToken) =>
  fetch(base + "/v1/agent-events/permission", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ provider: "claude", payload: { session_id: SID, cwd: "C:\\proj\\atlas", ...payload } }),
  });

/** Runs the real hook script the way Claude would: JSON on stdin, decision (if any) on stdout. */
function runHook(event: string, payload: object, home = helixHome): Promise<{ stdout: string; code: number | null; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK, event], { env: { ...process.env, HELIX_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("close", (code) => resolve({ stdout, code, ms: Date.now() - t0 }));
    child.stdin.end(JSON.stringify(payload));
  });
}

before(async () => {
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider() });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  const { code } = gw.auth.createPairingCode();
  deviceToken = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  localToken = gw.localTokens.create("terminal-agents").token;
  helixHome = fs.mkdtempSync(path.join(os.tmpdir(), "helix-home-"));
  fs.writeFileSync(path.join(helixHome, "local.json"), JSON.stringify({ url: base, token: localToken }));
  gw.presence.setMode("away");
});
after(async () => { await gw.app.close(); fs.rmSync(helixHome, { recursive: true, force: true }); });

describe("terminal permission gate", () => {
  it("requires a local token", async () => {
    assert.equal((await ask({ tool_name: "Bash", tool_input: { command: "rm -rf x" } }, "nope")).status, 401);
    assert.equal((await ask({ tool_name: "Bash", tool_input: { command: "rm -rf x" } }, deviceToken)).status, 401, "a phone token cannot answer for the agent");
  });

  it("stays out of the way for normal work: no opinion, instantly, nothing queued", async () => {
    for (const [tool_name, tool_input] of [["Bash", { command: "npm test" }], ["Bash", { command: "git push origin main" }], ["Edit", { file_path: "a.ts" }], ["mcp__x__list_things", {}]] as const) {
      const r = (await (await ask({ tool_name, tool_input })).json()) as any;
      assert.equal(r.decision, "none", `${tool_name} ${JSON.stringify(tool_input)}`);
    }
    assert.equal(((await (await fetch(base + "/v1/approvals?status=pending", { headers: { authorization: `Bearer ${deviceToken}` } })).json()) as any).approvals.length, 0);
  });

  it("while away, a destructive command waits for the phone; approving lets it through", async () => {
    const answer = ask({ tool_name: "Bash", tool_input: { command: "rm -rf checkpoints/old-run-17" } }).then((r) => r.json()) as Promise<any>;
    const a = await pending();
    assert.match(a.summary, /rm -rf checkpoints\/old-run-17/);
    assert.match(a.summary, /\[atlas\]/, "says which project");
    assert.equal(a.source, "agent");
    let settled = false;
    void answer.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(settled, false, "the agent is held while the user decides");

    await decide(a.id, "approve");
    const r = await answer;
    assert.equal(r.decision, "allow");
    assert.equal(r.approvalId, a.id);
  });

  it("rejecting denies it with a reason the agent can relay, and tells it not to retry", async () => {
    const answer = ask({ tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse data" } }).then((r) => r.json()) as Promise<any>;
    await decide((await pending()).id, "reject");
    const r = await answer;
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /rejected/);
    assert.match(r.reason, /Do not retry/);
  });

  it("also covers deletion hidden in tools named like deletions and in obfuscated commands", async () => {
    const a1 = ask({ tool_name: "mcp__gitkraken__delete_branch", tool_input: { branch: "x" } }).then((r) => r.json()) as Promise<any>;
    await decide((await pending()).id, "reject");
    assert.equal((await a1).decision, "deny");
    const a2 = ask({ tool_name: "Bash", tool_input: { command: "powershell -enc UgBlAG0AbwB2AGUALQBJAHQAZQBtACAAeAA=" } }).then((r) => r.json()) as Promise<any>;
    await decide((await pending()).id, "reject");
    assert.equal((await a2).decision, "deny");
  });

  it("an approval request also tries to reach the phone (push), recorded by the escalation policy", async () => {
    const answer = ask({ tool_name: "Bash", tool_input: { command: "del important.db" } }).then((r) => r.json()) as Promise<any>;
    await decide((await pending()).id, "reject");
    await answer;
    const rows = (gw.escalation as any)["db"].prepare("SELECT channel, status, title FROM notifications WHERE title LIKE 'Approval needed%'").all() as any[];
    assert.ok(rows.some((r) => r.channel === "message"), "lands in the app");
    assert.ok(rows.some((r) => r.channel === "push"), "push attempted (unavailable until APNs exists)");
    assert.ok(rows.every((r) => /\[atlas\]/.test(r.title)));
  });

  it("at the PC (auto, recently active) or set to home, Helix never interferes", async () => {
    gw.presence.setMode("auto");
    gw.presence.reportIdle(3);
    let r = (await (await ask({ tool_name: "Bash", tool_input: { command: "rm -rf build" } })).json()) as any;
    assert.equal(r.decision, "none");
    assert.match(r.reason, /at the PC/);
    gw.presence.setMode("home");
    r = (await (await ask({ tool_name: "Bash", tool_input: { command: "rm -rf build" } })).json()) as any;
    assert.equal(r.decision, "none");
    gw.presence.setMode("away");
  });

  it("sessions Helix runs itself keep their own gate; Helix does not ask twice", async () => {
    const s = await gw.manager.createSession({ provider: "claude", title: "managed", projectPath: os.tmpdir() });
    const r = (await (await ask({ session_id: s.providerSessionId, tool_name: "Bash", tool_input: { command: "rm -rf x" } })).json()) as any;
    assert.equal(r.decision, "none");
    assert.match(r.reason, /managed by Helix/);
  });

  it("if the hook is killed while waiting (Ctrl-C), the request is withdrawn rather than left dangling", async () => {
    const ac = new AbortController();
    const req = fetch(base + "/v1/agent-events/permission", {
      method: "POST", signal: ac.signal, headers: { "content-type": "application/json", authorization: `Bearer ${localToken}` },
      body: JSON.stringify({ provider: "claude", payload: { session_id: SID, tool_name: "Bash", tool_input: { command: "rm -rf big" } } }),
    }).catch(() => undefined);
    const a = await pending();
    ac.abort();
    await req;
    for (let i = 0; i < 100 && gw.approvals.get(a.id)?.status === "pending"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(gw.approvals.get(a.id)?.status, "cancelled");
  });

  it("with no gate configured the answer is always 'no opinion' (fail open)", async () => {
    const bare = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider() });
    (bare.agentEvents as any).gate = undefined;
    const r = await bare.agentEvents.checkPermission({ provider: "claude", payload: { session_id: SID, tool_name: "Bash", tool_input: { command: "rm -rf x" } } });
    assert.equal(r.decision, "none");
    await bare.app.close();
  });
});

describe("the real hook script", () => {
  const payload = (command: string) => ({ session_id: SID, cwd: "C:\\proj\\atlas", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

  it("prints nothing for ordinary commands (Claude carries on) and does it fast", async () => {
    const r = await runHook("pretooluse", payload("npm test"));
    assert.equal(r.stdout, "");
    assert.equal(r.code, 0);
    assert.ok(r.ms < 3000, `took ${r.ms}ms`);
  });

  it("prints Claude's PreToolUse decision JSON once the phone answers", async () => {
    const run = runHook("pretooluse", payload("rm -rf checkpoints"));
    await decide((await pending()).id, "reject");
    const r = await run;
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /rejected/);

    const run2 = runHook("pretooluse", payload("rm -rf checkpoints"));
    await decide((await pending()).id, "approve");
    assert.equal(JSON.parse((await run2).stdout).hookSpecificOutput.permissionDecision, "allow");
  });

  it("never disturbs Claude: gateway down, missing credentials or garbage input all mean silence and exit 0", async () => {
    const dead = fs.mkdtempSync(path.join(os.tmpdir(), "helix-dead-"));
    fs.writeFileSync(path.join(dead, "local.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: "hxl_x" }));
    for (const [home, ev] of [[dead, "pretooluse"], [dead, "stop"], [fs.mkdtempSync(path.join(os.tmpdir(), "helix-none-")), "pretooluse"]] as const) {
      const r = await runHook(ev, payload("rm -rf x"), home);
      assert.equal(r.stdout, "", `${ev} stdout must stay empty`);
      assert.equal(r.code, 0);
      assert.ok(r.ms < 4500);
    }
  });

  it("stop events reach the gateway", async () => {
    const before = gw.agentEvents.recent(100).length;
    const r = await runHook("stop", { session_id: "ffffffff-1111-4222-8333-000000000009", cwd: "C:\\proj\\x" });
    assert.equal(r.stdout, "");
    for (let i = 0; i < 100 && gw.agentEvents.recent(100).length === before; i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(gw.agentEvents.recent(100).some((e) => e.event === "stop" && e.sessionId === "ffffffff-1111-4222-8333-000000000009"));
  });
});
