import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { type ConnectEnv, type Runner, connect, disconnect, status } from "../src/connect/connect.js";
import { HOOK_MARKER, installedHookEvents, mergeHooks, removeHooks } from "../src/connect/hooks-config.js";
import { BLOCK_BEGIN, HELIX_INSTRUCTIONS, hasBlock, removeBlock, upsertBlock } from "../src/connect/instructions.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

describe("instruction block", () => {
  it("adds, updates in place and removes without touching the user's own text", () => {
    const mine = "# My rules\n\nAlways use tabs.\n";
    const once = upsertBlock(mine);
    assert.ok(once.startsWith("# My rules"));
    assert.ok(hasBlock(once));
    assert.equal(upsertBlock(once), once, "idempotent");
    assert.equal(once.split(BLOCK_BEGIN).length - 1, 1, "never duplicated");
    assert.equal(removeBlock(once), mine, "removal restores the original exactly");
    assert.equal(removeBlock(upsertBlock("")), "", "a file that only held our block becomes empty");

    const updated = upsertBlock(once, `${BLOCK_BEGIN}\nnew text\n<!-- helix:end -->`);
    assert.match(updated, /new text/);
    assert.ok(updated.includes("Always use tabs."));
  });

  it("tells agents the things that matter", () => {
    for (const must of ["watch_job", "notify_user", "request_user_approval", "critical", "never block", "Mention in your reply"]) {
      assert.ok(new RegExp(must, "i").test(HELIX_INSTRUCTIONS), must);
    }
    assert.ok(HELIX_INSTRUCTIONS.length < 2500, "short: it is loaded into every session");
  });
});

describe("hooks config", () => {
  const cmd = (e: string) => `node "C:/x/${HOOK_MARKER}.mjs" ${e.toLowerCase()}`;
  const existing = {
    model: "sonnet",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }],
    },
  };

  it("adds our hooks next to existing ones and is idempotent", () => {
    const m = mergeHooks(existing, cmd);
    assert.equal(m.model, "sonnet");
    assert.equal(m.hooks!.Stop!.length, 2, "user's Stop hook kept, ours added");
    assert.equal(m.hooks!.PreToolUse!.length, 2, "user's PreToolUse audit hook kept, ours added beside it");
    assert.deepEqual(m.hooks!.PreToolUse![0], existing.hooks.PreToolUse[0], "the user's own group is untouched");
    const gate = m.hooks!.PreToolUse![1]!;
    assert.equal(gate.matcher, "Bash|PowerShell|mcp__.*", "the permission gate only runs for shell and MCP tools");
    assert.equal(gate.hooks![0]!.timeout, 1900, "long enough to wait for an answer from the phone");
    assert.equal(m.hooks!.Stop![1]!.hooks![0]!.timeout, 10);
    assert.deepEqual(installedHookEvents(m).sort(), ["Notification", "PreToolUse", "Stop"]);
    assert.deepEqual(mergeHooks(m, cmd), m);
    assert.equal(JSON.stringify(existing).includes(HOOK_MARKER), false, "input not mutated");
  });

  it("updates our command if the install path changed", () => {
    const m = mergeHooks(existing, cmd);
    const moved = mergeHooks(m, (e) => `node "D:/new/${HOOK_MARKER}.mjs" ${e}`);
    assert.equal(moved.hooks!.Stop!.length, 2);
    assert.equal(moved.hooks!.PreToolUse!.length, 2, "no duplicate gate on re-run");
    assert.match(JSON.stringify(moved), /D:\/new/);
    assert.ok(!JSON.stringify(moved).includes("C:/x"));
  });

  it("removal restores the original and drops empty containers", () => {
    assert.deepEqual(removeHooks(mergeHooks(existing, cmd)), existing);
    assert.deepEqual(removeHooks(mergeHooks({}, cmd)), {});
  });
});

describe("connect / disconnect", () => {
  let root: string;
  let calls: { cmd: string; args: string[] }[];
  let env: ConnectEnv;
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: args.includes("get") ? "helix" : "", stderr: "" };
  };

  const setup = (opts: { claudeMd?: string; settings?: unknown; codex?: boolean; rawSettings?: string } = {}) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-conn-"));
    calls = [];
    const claudeHome = path.join(root, ".claude");
    const codexHome = path.join(root, ".codex");
    fs.mkdirSync(claudeHome, { recursive: true });
    if (opts.claudeMd !== undefined) fs.writeFileSync(path.join(claudeHome, "CLAUDE.md"), opts.claudeMd);
    if (opts.rawSettings !== undefined) fs.writeFileSync(path.join(claudeHome, "settings.json"), opts.rawSettings);
    else if (opts.settings) fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify(opts.settings, null, 2));
    if (opts.codex !== false) { fs.mkdirSync(codexHome, { recursive: true }); fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "");
      // What `codex mcp add` leaves behind (the fake runner does not write it), with an old env-var setting
      fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "x"\n\n[mcp_servers.helix]\nurl = "http://127.0.0.1:7777/mcp"\nbearer_token_env_var = "HELIX_AGENT_TOKEN"\n\n[other]\na = 1\n'); }
    env = {
      claudeHome, codexHome, helixHome: path.join(root, ".helix"), backupDir: path.join(root, "backups"),
      gatewayUrl: "http://127.0.0.1:7777", nodePath: "C:\\Program Files\\nodejs\\node.exe",
      hookScript: "C:\\repo\\pc-gateway\\hooks\\helix-hook.mjs", presenceScript: "C:\\repo\\pc-gateway\\hooks\\presence-agent.ps1",
      startupDir: path.join(root, "Startup"), claudeBin: "claude", codexBin: "codex", run,
      now: () => new Date("2026-10-01T12:00:00Z"), platform: "win32",
    };
  };
  const read = (p: string) => fs.readFileSync(p, "utf8");
  after(() => root && fs.rmSync(root, { recursive: true, force: true }));

  it("dry run reports the plan and writes nothing", async () => {
    setup({ claudeMd: "# mine\n" });
    const plan = await connect(env, "hxl_x", { dryRun: true });
    assert.ok(plan.length >= 6 && plan.every((c) => c.action.startsWith("would ")));
    assert.equal(read(path.join(env.claudeHome, "CLAUDE.md")), "# mine\n");
    assert.equal(fs.existsSync(env.helixHome), false);
    assert.equal(calls.length, 0, "no commands run");
  });

  it("connect wires everything up, keeps existing content, and backs originals up", async () => {
    setup({ claudeMd: "# my rules\nuse tabs\n", settings: { model: "sonnet", theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } } });
    const changes = await connect(env, "hxl_secret123");
    assert.ok(changes.every((c) => c.ok));

    const md = read(path.join(env.claudeHome, "CLAUDE.md"));
    assert.ok(md.startsWith("# my rules\nuse tabs"));
    assert.ok(hasBlock(md));

    const settings = JSON.parse(read(path.join(env.claudeHome, "settings.json")));
    assert.equal(settings.model, "sonnet");
    assert.equal(settings.theme, "dark");
    assert.equal(settings.hooks.Stop.length, 2);
    const ourCmd = settings.hooks.Stop[1].hooks[0].command as string;
    assert.match(ourCmd, /^"C:\/Program Files\/nodejs\/node\.exe" "C:\/repo\/pc-gateway\/hooks\/helix-hook\.mjs" stop$/, "forward slashes, quoted");
    assert.equal(settings.hooks.Stop[1].hooks[0].timeout, 10);

    assert.equal(settings.hooks.PreToolUse.length, 1, "permission gate installed");
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash|PowerShell|mcp__.*");
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /helix-hook\.mjs" pretooluse$/);

    const vbs = read(path.join(env.startupDir, "helix-presence.vbs"));
    assert.match(vbs, /WScript\.Shell/);
    assert.match(vbs, /presence-agent\.ps1/);
    assert.match(vbs, /, 0, False/, "hidden window, does not wait");
    assert.ok(calls.some((c) => c.cmd === "wscript.exe"), "started right away, not only at next logon");

    assert.deepEqual(JSON.parse(read(path.join(env.helixHome, "local.json"))), { url: "http://127.0.0.1:7777", token: "hxl_secret123" });
    assert.ok(hasBlock(read(path.join(env.codexHome, "AGENTS.md"))));

    const add = calls.find((c) => c.cmd === "claude" && c.args.includes("add"))!;
    assert.deepEqual(add.args.slice(0, 7), ["mcp", "add", "--scope", "user", "--transport", "http", "helix"]);
    assert.ok(add.args.includes("http://127.0.0.1:7777/mcp"));
    assert.ok(add.args.includes("Authorization: Bearer hxl_secret123"));
    assert.ok(!calls.some((c) => c.cmd === "setx"), "no environment variable: apps already open would never see it");
    const cadd = calls.find((c) => c.cmd === "codex" && c.args.includes("add"))!;
    assert.ok(!cadd.args.join(" ").includes("hxl_secret123"), "the token is never on a command line");
    const toml = read(path.join(env.codexHome, "config.toml"));
    assert.match(toml, /\[mcp_servers\.helix\]\nurl = "http:\/\/127\.0\.0\.1:7777\/mcp"\nhttp_headers = \{ Authorization = "Bearer hxl_secret123" \}\n\n\[other\]/);
    assert.ok(!toml.includes("bearer_token_env_var"));
    assert.match(toml, /^model = "x"/, "the rest of the config is untouched");

    const backups = fs.readdirSync(env.backupDir);
    assert.ok(backups.some((b) => b.startsWith("CLAUDE.md.")) && backups.some((b) => b.startsWith("settings.json.")), "originals backed up");
    const savedSettings = JSON.parse(read(path.join(env.backupDir, backups.find((b) => b.startsWith("settings.json."))!)));
    assert.equal(savedSettings.hooks.Stop.length, 1, "backup is the untouched original");
  });

  it("running connect twice changes nothing the second time", async () => {
    setup({ claudeMd: "# mine\n", settings: { model: "opus" } });
    await connect(env, "hxl_a");
    const snap = [path.join(env.claudeHome, "CLAUDE.md"), path.join(env.claudeHome, "settings.json"), path.join(env.codexHome, "AGENTS.md")].map(read);
    await connect(env, "hxl_a");
    assert.deepEqual([path.join(env.claudeHome, "CLAUDE.md"), path.join(env.claudeHome, "settings.json"), path.join(env.codexHome, "AGENTS.md")].map(read), snap);
  });

  it("disconnect puts everything back exactly as it was", async () => {
    const originalSettings = { model: "sonnet", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
    setup({ claudeMd: "# my rules\nuse tabs\n", settings: originalSettings });
    await connect(env, "hxl_a");
    assert.ok((await status(env)).every((s) => s.connected), "everything linked");

    await disconnect(env);
    assert.equal(fs.existsSync(path.join(env.startupDir, "helix-presence.vbs")), false, "idle reporter removed");
    assert.ok(calls.some((c) => c.cmd === "powershell.exe" && c.args.join(" ").includes("presence-agent.ps1")), "and stopped");
    assert.equal(read(path.join(env.claudeHome, "CLAUDE.md")), "# my rules\nuse tabs\n");
    assert.deepEqual(JSON.parse(read(path.join(env.claudeHome, "settings.json"))), originalSettings);
    assert.equal(read(path.join(env.codexHome, "AGENTS.md")), "");
    assert.equal(fs.existsSync(path.join(env.helixHome, "local.json")), false);
    assert.ok(calls.some((c) => c.cmd === "reg" && c.args.includes("HELIX_AGENT_TOKEN")));
    const st = await status({ ...env, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
    assert.ok(st.every((s) => !s.connected));
  });

  it("refuses to touch a settings.json it cannot parse, and changes nothing at all", async () => {
    setup({ claudeMd: "# mine\n", rawSettings: "{ this is not json" });
    await assert.rejects(() => connect(env, "hxl_a"));
    assert.equal(read(path.join(env.claudeHome, "settings.json")), "{ this is not json", "left exactly as it was");
    assert.equal(read(path.join(env.claudeHome, "CLAUDE.md")), "# mine\n", "nothing was done before the problem was found");
    assert.equal(fs.existsSync(env.helixHome), false);
    assert.equal(calls.length, 0);
  });

  it("the idle reporter can be skipped", async () => {
    setup({});
    await connect(env, "hxl_a", { presence: false });
    assert.equal(fs.existsSync(path.join(env.startupDir, "helix-presence.vbs")), false);
    assert.ok(!calls.some((c) => c.cmd === "wscript.exe"));
  });

  it("works without Codex installed, and can skip either tool", async () => {
    setup({ codex: false });
    const c = await connect(env, "hxl_a");
    assert.ok(!c.some((x) => x.target.includes("codex") || x.target.includes("AGENTS")));
    setup({});
    await connect(env, "hxl_a", { claude: false });
    assert.ok(!calls.some((x) => x.cmd === "claude"));
    assert.equal(fs.existsSync(path.join(env.claudeHome, "CLAUDE.md")), false);
  });

  it("reports a failed MCP registration instead of pretending it worked", async () => {
    setup({});
    env.run = async (cmd, args) => (cmd === "claude" && args.includes("add") ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" });
    const changes = await connect(env, "hxl_a");
    const failed = changes.find((c) => !c.ok)!;
    assert.match(failed.action, /failed/);
    assert.equal(failed.detail, "boom");
  });
});

describe("local agent credentials over MCP", () => {
  let gw: Gateway;
  let base: string;
  let deviceToken: string;
  const connectWith = async (token: string) => {
    const c = new Client({ name: "terminal", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };

  before(async () => {
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    deviceToken = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
  });
  after(async () => { await gw.app.close(); });

  it("a local token reaches the watch and notify tools, and nothing more", async () => {
    const { token } = gw.localTokens.create("terminal-agents");
    const c = await connectWith(token);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["create_status_watch", "end_call", "list_agent_sessions", "list_status_watches", "notify_user", "remove_status_watch", "request_user_approval", "watch_job"]);
    for (const dangerous of ["run_command", "write_file", "stop_process", "read_file", "permission_prompt"]) {
      assert.ok(!names.includes(dangerous), `${dangerous} must not be reachable from a terminal agent`);
    }
    await c.close();
  });

  it("only a hash of the token is stored; revoking cuts the agent off", async () => {
    const { token } = gw.localTokens.create("revoke-me");
    const rows = JSON.stringify((gw.localTokens as any)["db"].prepare("SELECT * FROM local_tokens").all());
    assert.ok(!rows.includes(token), "raw token never stored");
    const ok = await connectWith(token);
    await ok.close();
    assert.equal(gw.localTokens.revokeAll("revoke-me"), 1);
    const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
    assert.equal(res.status, 401);
  });

  it("phone tokens and garbage are not MCP credentials", async () => {
    for (const t of [deviceToken, "hxl_not-a-real-token", ""]) {
      const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: "{}" });
      assert.equal(res.status, 401);
    }
  });

  it("notify_user routes by severity and is honest about what could not be delivered", async () => {
    const { token } = gw.localTokens.create("notifier");
    const c = await connectWith(token);
    const call = async (severity: string, title: string) =>
      JSON.parse(((await c.callTool({ name: "notify_user", arguments: { title, message: "details", severity, project: "atlas" } })) as any).content[0].text);

    const info = await call("info", "progress 40%");
    assert.deepEqual(info.delivered, ["message"]);
    assert.deepEqual(info.unavailable, []);

    const crit = await call("critical", "training crashed");
    assert.deepEqual(crit.delivered, ["message"], "only the in-app message exists today");
    assert.deepEqual(crit.unavailable.sort(), ["call", "push"], "the agent is told push/call did not happen");

    const msgs = gw.manager.messages.list("general");
    assert.ok(msgs.some((m) => m.severity === "critical" && /\[atlas\] training crashed/.test(m.text)));
    await c.close();
  });
});
