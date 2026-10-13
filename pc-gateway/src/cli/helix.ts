// Connect this PC's Claude Code (and Codex) to Helix, or undo it.
//
//   npm run helix -- connect [--dry-run] [--yes] [--no-claude] [--no-codex] [--no-presence]
//   npm run helix -- disconnect [--yes]
//   npm run helix -- status
//
// connect edits files in your home folder (originals are backed up to data/backups first):
//   ~/.claude/CLAUDE.md, ~/.claude/settings.json (hooks only), ~/.claude.json (MCP server, via `claude mcp add`),
//   ~/.codex/AGENTS.md and the Codex MCP list, ~/.helix/local.json, and a hidden logon item in your Startup folder
//   that reports keyboard/mouse idle time so Helix knows when you are away.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { LocalTokenService } from "../auth/local-tokens.js";
import { loadConfig, loadDotEnv } from "../config.js";
import { type ConnectEnv, connect, disconnect, realRunner, status } from "../connect/connect.js";
import { defaultHomes } from "../discovery/indexer.js";
import { openDb } from "../storage/sqlite.js";

const TOKEN_NAME = "terminal-agents";

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("cannot locate the pc-gateway package root");
}

loadDotEnv();
const config = loadConfig();
const homes = defaultHomes();
const env: ConnectEnv = {
  claudeHome: homes.claudeHome,
  codexHome: homes.codexHome,
  helixHome: process.env.HELIX_HOME ?? path.join(os.homedir(), ".helix"),
  backupDir: path.join(config.dataDir, "backups"),
  gatewayUrl: `http://127.0.0.1:${config.port}`,
  nodePath: process.execPath,
  hookScript: path.join(packageRoot(), "hooks", "helix-hook.mjs"),
  presenceScript: path.join(packageRoot(), "hooks", "presence-agent.ps1"),
  startupDir: path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
  claudeBin: config.claudeBin,
  codexBin: "codex",
  run: realRunner,
};

const [cmd, ...rest] = process.argv.slice(2);
const has = (f: string) => rest.includes(`--${f}`);
const opts = { dryRun: has("dry-run"), claude: !has("no-claude"), codex: !has("no-codex"), presence: !has("no-presence") };

const print = (changes: { target: string; action: string; ok: boolean; detail?: string }[]) => {
  for (const c of changes) console.log(`  ${c.ok ? "-" : "!"} ${c.target}: ${c.action}${c.detail ? `  (${c.detail})` : ""}`);
};

async function confirm(question: string): Promise<boolean> {
  if (has("yes")) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

if (cmd === "connect") {
  console.log("\nThis will let every new Claude Code / Codex session on this PC use Helix:\n");
  print(await connect(env, "hxl_DRYRUN", { ...opts, dryRun: true }));
  if (opts.dryRun) { console.log("\n(dry run: nothing was changed)\n"); process.exit(0); }
  if (!(await confirm("\nApply these changes? Originals are backed up first."))) { console.log("Cancelled."); process.exit(1); }

  const db = openDb(config.dbPath);
  const tokens = new LocalTokenService(db);
  tokens.revokeAll(TOKEN_NAME); // rotate: any earlier connection's token stops working
  const { token } = tokens.create(TOKEN_NAME);
  db.close();

  const result = await connect(env, token, opts);
  console.log("\nDone:\n");
  print(result);
  console.log(`\nBackups: ${env.backupDir}\nUndo anytime: npm run helix -- disconnect`);
  console.log("New sessions pick this up. Sessions already open must be restarted.\n");
  process.exit(result.every((c) => c.ok) ? 0 : 2);
} else if (cmd === "disconnect") {
  console.log("\nThis will remove Helix from Claude Code / Codex on this PC:\n");
  print(await disconnect(env, { ...opts, dryRun: true }));
  if (opts.dryRun) process.exit(0);
  if (!(await confirm("\nRemove?"))) { console.log("Cancelled."); process.exit(1); }
  const result = await disconnect(env, opts);
  const db = openDb(config.dbPath);
  const revoked = new LocalTokenService(db).revokeAll(TOKEN_NAME);
  db.close();
  console.log("\nDone:\n");
  print(result);
  console.log(`  - gateway: revoked ${revoked} token(s)\n`);
} else if (cmd === "status") {
  console.log("");
  for (const s of await status(env)) console.log(`  ${s.connected ? "connected  " : "NOT linked "} ${s.name}${s.detail ? ` (${s.detail})` : ""}`);
  console.log("");
} else {
  console.log("usage: npm run helix -- connect|disconnect|status [--dry-run] [--yes] [--no-claude] [--no-codex] [--no-presence]");
}
