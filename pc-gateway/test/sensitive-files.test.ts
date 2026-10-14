import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { classify } from "../src/permissions/classifier.js";
import { configureSensitivePaths, sensitiveReason } from "../src/permissions/sensitive-paths.js";
import { CodexProvider } from "../src/providers/codex.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const HOME = "C:\\Users\\someone";
const needsApproval = (tool: string, input: Record<string, unknown>) => classify({ tool, input }).destructive;

describe("sensitive files: ordinary coding never asks", () => {
  it("edits, writes and patches to project files are normal", () => {
    for (const [tool, input] of [
      ["Write", { file_path: "C:\\proj\\src\\app.ts", content: "x" }],
      ["Edit", { file_path: "C:\\proj\\README.md" }],
      ["MultiEdit", { file_path: "C:\\proj\\src\\a.ts" }],
      ["NotebookEdit", { notebook_path: "C:\\proj\\nb.ipynb" }],
      ["write_file", { path: "C:\\proj\\notes.txt" }],
      ["apply_patch", { paths: ["C:\\proj\\src\\x.ts", "C:\\proj\\test\\x.test.ts"] }],
      ["Write", { file_path: "C:\\proj\\.env.example" }],
      ["Write", { file_path: "C:\\proj\\docs\\profile.md" }],
      ["Write", { file_path: "C:\\proj\\CLAUDE.md" }],
      ["Write", { file_path: "C:\\proj\\AGENTS.md" }],
    ] as const) assert.equal(needsApproval(tool, input), false, `${tool} ${JSON.stringify(input)}`);
  });

  it("everyday commands are normal, including reading sensitive files and read-only git config", () => {
    for (const command of [
      "npm test", "git status", "git commit -m 'fix'", "cat ~/.bashrc", "Get-Content $PROFILE", "git config --get core.hooksPath",
      "git config user.name 'Me'", "npm install", "copy src\\a.ts src\\b.ts", "echo hi > out.txt",
    ]) assert.equal(needsApproval("Bash", { command }), false, command);
  });
});

describe("sensitive files: changing them waits for the user", () => {
  it("credentials, agent and Helix security config, and persistence locations", () => {
    for (const p of [
      "C:\\proj\\.env", "C:\\proj\\.env.local", `${HOME}\\.ssh\\authorized_keys`, `${HOME}\\.aws\\credentials`,
      `${HOME}\\.claude\\settings.json`, "C:\\proj\\.claude\\settings.local.json", `${HOME}\\.claude\\CLAUDE.md`,
      `${HOME}\\.claude\\hooks\\x.mjs`, `${HOME}\\.claude\\agents\\a.md`, "C:\\proj\\.mcp.json", `${HOME}\\.claude.json`,
      `${HOME}\\.codex\\config.toml`, `${HOME}\\.codex\\AGENTS.md`, `${HOME}\\.helix\\local.json`,
      "C:\\proj\\.git\\hooks\\pre-commit", "C:\\proj\\.git\\config", `${HOME}\\.gitconfig`,
      `${HOME}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\run.vbs`,
      `${HOME}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`, `${HOME}\\Documents\\PowerShell\\profile.ps1`,
      `${HOME}\\.bashrc`, `${HOME}\\.zshrc`,
    ]) {
      assert.ok(sensitiveReason(p), p);
      for (const [tool, input] of [["Write", { file_path: p }], ["Edit", { file_path: p }], ["write_file", { path: p }], ["apply_patch", { paths: ["C:\\proj\\ok.ts", p] }]] as const) {
        const c = classify({ tool, input });
        assert.equal(c.destructive, true, `${tool} ${p}`);
        assert.ok(c.reasons.some((r) => r.startsWith("modifies ")), c.reasons.join("; "));
      }
    }
  });

  it("Helix's own data folder and hooks/service scripts, wherever they are installed", () => {
    configureSensitivePaths({ dataDir: "D:\\helix-data", gatewayRoot: "D:\\apps\\helix\\pc-gateway" });
    try {
      assert.ok(needsApproval("Write", { file_path: "D:\\helix-data\\helix.sqlite" }));
      assert.ok(needsApproval("Edit", { file_path: "D:\\apps\\helix\\pc-gateway\\hooks\\helix-hook.mjs" }));
      assert.ok(needsApproval("Write", { file_path: "D:\\apps\\helix\\pc-gateway\\service\\update.ps1" }));
      assert.equal(needsApproval("Edit", { file_path: "D:\\apps\\helix\\pc-gateway\\src\\app.ts" }), false, "working on Helix's own code is normal coding");
      assert.ok(needsApproval("Bash", { command: "Set-Content D:\\apps\\helix\\pc-gateway\\hooks\\helix-hook.mjs 'x'" }));
    } finally { configureSensitivePaths({}); }
  });

  it("commands that write to these places or make something start later", () => {
    for (const command of [
      "Set-Content $PROFILE 'x'", "Add-Content -Path $PROFILE -Value x", "echo x >> ~/.bashrc", "cp evil.mjs ~/.claude/hooks/",
      "Copy-Item a.vbs \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\\"",
      "reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d y",
      "New-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name x -Value y",
      "schtasks /create /tn x /tr y /sc onlogon", "Register-ScheduledTask -TaskName x -Action $a",
      "git config core.hooksPath .h", "git config --global alias.x '!sh'", "Add-MpPreference -ExclusionPath C:\\x",
      "Set-ExecutionPolicy Unrestricted", "Out-File -FilePath .mcp.json -InputObject x", "echo KEY=1 > .env",
    ]) assert.equal(needsApproval("Bash", { command }), true, command);
  });
});

describe("sensitive files through the gateway", () => {
  let gw: Gateway;
  let base: string;
  let localToken: string;
  const SID = "eeeeeeee-1111-4222-8333-0000000000aa";
  const OTHER = "eeeeeeee-1111-4222-8333-0000000000bb";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-sensitive-"));

  before(async () => {
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    localToken = gw.localTokens.create("terminal-agents").token;
    await gw.manager.createSession({ provider: "claude", title: "helix-run", projectPath: os.tmpdir(), providerSessionId: SID });
  });
  after(async () => { await gw.app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const ask = (sessionId: string, tool_name: string, tool_input: Record<string, unknown>) =>
    fetch(base + "/v1/agent-events/permission", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localToken}` },
      body: JSON.stringify({ provider: "claude", payload: { session_id: sessionId, cwd: "C:\\proj", tool_name, tool_input } }),
    }).then((r) => r.json()) as Promise<any>;
  const nextPending = async () => {
    for (let i = 0; i < 300; i++) { const p = gw.approvals.list("pending"); if (p.length) return p[0]!; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error("no approval appeared");
  };

  it("a Helix-run session is asked about a sensitive edit even while the user is at the PC (allow rules cannot skip it)", async () => {
    gw.presence.setMode("home");
    assert.equal((await ask(SID, "Edit", { file_path: "C:\\proj\\src\\a.ts" })).decision, "none", "ordinary edits: no opinion");
    const answer = ask(SID, "Write", { file_path: `${HOME}\\.claude\\settings.json` });
    const a = await nextPending();
    assert.match(a.reasons.join(" "), /Claude Code settings|credentials/);
    gw.approvals.resolve(a.id, false, "phone");
    assert.equal((await answer).decision, "deny");
  });

  it("a terminal session follows the away rule: at the PC no opinion, away it waits for the phone", async () => {
    gw.presence.setMode("home");
    assert.equal((await ask(OTHER, "Write", { file_path: `${HOME}\\.bashrc` })).decision, "none");
    gw.presence.setMode("away");
    assert.equal((await ask(OTHER, "Edit", { file_path: "C:\\proj\\src\\a.ts" })).decision, "none", "ordinary edits never wait");
    const answer = ask(OTHER, "Write", { file_path: `${HOME}\\.bashrc` });
    const a = await nextPending();
    gw.approvals.resolve(a.id, true, "phone");
    assert.equal((await answer).decision, "allow");
    gw.presence.setMode("auto");
  });

  it("the write_file tool waits for approval on a sensitive path and writes ordinary files at once", async () => {
    const token = gw.agentTokens.issue({ scope: "pc.agent.full", actor: "test" });
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const ordinary = path.join(root, "notes.txt");
    const r: any = await client.callTool({ name: "write_file", arguments: { path: ordinary, content: "hello" } });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(fs.readFileSync(ordinary, "utf8"), "hello");

    const sensitive = path.join(root, ".git", "hooks", "pre-commit");
    const call = client.callTool({ name: "write_file", arguments: { path: sensitive, content: "x", createDirs: true } });
    const a = await nextPending();
    assert.match(a.summary, /pre-commit/);
    assert.equal(fs.existsSync(sensitive), false, "nothing is written while the user has not answered");
    gw.approvals.resolve(a.id, false, "phone");
    const refused: any = await call;
    assert.equal(refused.isError, true);
    assert.equal(fs.existsSync(sensitive), false);
    await client.close();
  });
});

describe("Codex file changes fail closed", () => {
  const provider = new CodexProvider({ server: { bin: "codex-not-started" } } as never);
  const answer = (req: unknown, fileItems: Map<string, unknown>) => {
    const asked: { tool: string; input: Record<string, unknown> }[] = [];
    const o = { approve: async (a: { tool: string; input: Record<string, unknown> }) => { asked.push(a); return { allow: false }; } };
    return (provider as any).answer(req, o, fileItems, () => undefined).then(() => asked);
  };

  it("a change Helix has not seen announced is treated like a delete, never as harmless", async () => {
    const asked = await answer({ method: "item/fileChange/requestApproval", params: { itemId: "unknown-item" } }, new Map());
    assert.equal(asked.length, 1);
    assert.equal(classify(asked[0]!).destructive, true);
  });

  it("an older-protocol patch with no file list is treated the same way", async () => {
    const asked = await answer({ method: "applyPatchApproval", params: { fileChanges: {} } }, new Map());
    assert.equal(classify(asked[0]!).destructive, true);
  });

  it("a known patch to an ordinary file is not, and one to a sensitive file is", async () => {
    const items = new Map<string, unknown>([
      ["a", { changes: [{ path: "C:\\proj\\src\\a.ts", kind: { type: "update" } }] }],
      ["b", { changes: [{ path: "C:\\proj\\.git\\hooks\\post-checkout", kind: { type: "add" } }] }],
    ]);
    const plain = await answer({ method: "item/fileChange/requestApproval", params: { itemId: "a" } }, items);
    assert.equal(classify(plain[0]!).destructive, false);
    const hook = await answer({ method: "item/fileChange/requestApproval", params: { itemId: "b" } }, items);
    assert.equal(classify(hook[0]!).destructive, true);
  });
});
