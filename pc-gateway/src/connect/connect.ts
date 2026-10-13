import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_HOOKS, type HookSpec, installedHookEvents, mergeHooks, removeHooks } from "./hooks-config.js";
import { hasBlock, removeBlock, upsertBlock } from "./instructions.js";

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export const realRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? ((err as any).code as number) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
    });
  });

export interface ConnectEnv {
  claudeHome: string;
  codexHome: string;
  /** ~/.helix: where the hook script finds the gateway URL and token. */
  helixHome: string;
  /** Originals are copied here before any of the user's files is modified. */
  backupDir: string;
  gatewayUrl: string;
  nodePath: string;
  hookScript: string;
  /** The desktop idle reporter (hooks/presence-agent.ps1) and the folder whose contents run at logon. */
  presenceScript: string;
  startupDir: string;
  claudeBin: string;
  codexBin: string;
  run: Runner;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

export interface ConnectOptions {
  dryRun?: boolean;
  /** Skip Claude Code / Codex respectively. */
  claude?: boolean;
  codex?: boolean;
  /** Install the desktop idle reporter (default true). */
  presence?: boolean;
  hooks?: readonly HookSpec[];
}

export interface Change { target: string; action: string; ok: boolean; detail?: string }

const TOKEN_ENV = "HELIX_AGENT_TOKEN";
const fwd = (p: string) => p.replace(/\\/g, "/");

function backup(env: ConnectEnv, file: string, dryRun: boolean): string | undefined {
  if (dryRun || !fs.existsSync(file)) return undefined;
  fs.mkdirSync(env.backupDir, { recursive: true });
  const stamp = (env.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const dest = path.join(env.backupDir, `${path.basename(file)}.${stamp}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function readJson(file: string): Record<string, any> {
  const t = readText(file).trim();
  if (!t) return {};
  return JSON.parse(t); // a malformed settings file must stop us, never be overwritten
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/**
 * Puts `http_headers = { Authorization = "Bearer <token>" }` into the `[mcp_servers.helix]` table of Codex's
 * config.toml, replacing any token setting already there. Undefined if the table is missing.
 */
export function setCodexHelixHeader(toml: string, token: string): string | undefined {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.helix]");
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  const body = lines.slice(start + 1, end).filter((l) => !/^\s*(bearer_token_env_var|http_headers)\s*=/.test(l));
  let last = body.length;
  while (last > 0 && !body[last - 1]!.trim()) last--; // keep the blank line before the next table after our line
  body.splice(last, 0, `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`);
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join("\n");
}

/** A one-line VBScript so the PowerShell reporter starts at logon with no visible window. */
export function presenceLauncher(script: string): string {
  const ps = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${script.replace(/\//g, "\\")}""`;
  return `CreateObject("WScript.Shell").Run "${ps}", 0, False\r\n`;
}

async function stopPresenceHelper(env: ConnectEnv): Promise<void> {
  await env.run("powershell.exe", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*presence-agent.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
  ]);
}

/** The command line Claude Code runs for a hook. Forward slashes survive both bash and cmd. */
export function hookCommand(env: ConnectEnv, event: string): string {
  return `"${fwd(env.nodePath)}" "${fwd(env.hookScript)}" ${event.toLowerCase()}`;
}

/** Wire this machine's Claude Code (and optionally Codex) up to Helix. Reversible with disconnect(). */
export async function connect(env: ConnectEnv, token: string, opts: ConnectOptions = {}): Promise<Change[]> {
  const dry = !!opts.dryRun;
  const changes: Change[] = [];
  const note = (target: string, action: string, ok = true, detail?: string) => changes.push({ target, action: dry ? `would ${action}` : action, ok, detail });
  const mcpUrl = `${env.gatewayUrl}/mcp`;

  // Pre-flight: a settings file we cannot parse must stop us BEFORE anything is changed, not halfway through.
  if (opts.claude !== false) readJson(path.join(env.claudeHome, "settings.json"));

  // 1. Credentials for the hook script (the MCP registrations carry their own copy).
  const localJson = path.join(env.helixHome, "local.json");
  note(localJson, "write gateway URL and token for the hook script");
  if (!dry) writeFile(localJson, JSON.stringify({ url: env.gatewayUrl, token }, null, 2));

  if (opts.claude !== false) {
    // 2. User-level MCP server: every session, any folder.
    note("claude mcp (user scope)", `register MCP server "helix" -> ${mcpUrl}`);
    if (!dry) {
      await env.run(env.claudeBin, ["mcp", "remove", "helix", "--scope", "user"]); // fine if absent
      const r = await env.run(env.claudeBin, ["mcp", "add", "--scope", "user", "--transport", "http", "helix", mcpUrl, "--header", `Authorization: Bearer ${token}`]);
      if (r.code !== 0) { changes[changes.length - 1] = { target: "claude mcp (user scope)", action: "register MCP server failed", ok: false, detail: r.stderr.trim() || r.stdout.trim() }; }
    }

    // 3. Instructions every session loads.
    const claudeMd = path.join(env.claudeHome, "CLAUDE.md");
    note(claudeMd, `add the Helix instructions block${fs.existsSync(claudeMd) ? " (existing content kept)" : " (new file)"}`);
    if (!dry) { backup(env, claudeMd, dry); writeFile(claudeMd, upsertBlock(readText(claudeMd))); }

    // 4. Hooks: the deterministic part that works even if the model never mentions Helix.
    const settingsFile = path.join(env.claudeHome, "settings.json");
    const specs = opts.hooks ?? DEFAULT_HOOKS;
    note(settingsFile, `add hooks for ${specs.map((s) => s.event).join(", ")} (other settings untouched)`);
    if (!dry) {
      const current = readJson(settingsFile);
      backup(env, settingsFile, dry);
      writeFile(settingsFile, JSON.stringify(mergeHooks(current, (e) => hookCommand(env, e), specs), null, 2) + "\n");
    } else {
      readJson(settingsFile); // surface a malformed file during the dry run too
    }
  }

  if (opts.presence !== false && (env.platform ?? process.platform) === "win32") {
    const launcher = path.join(env.startupDir, "helix-presence.vbs");
    note(launcher, "start the desktop idle reporter at logon, and start it now (tells Helix when you are away from the PC)");
    if (!dry) {
      writeFile(launcher, presenceLauncher(env.presenceScript));
      await stopPresenceHelper(env); // restart cleanly if an older one is running
      await env.run("wscript.exe", [launcher]);
    }
  }

  if (opts.codex !== false && fs.existsSync(env.codexHome)) {
    const agentsMd = path.join(env.codexHome, "AGENTS.md");
    note(agentsMd, "add the Helix instructions block");
    if (!dry) { backup(env, agentsMd, dry); writeFile(agentsMd, upsertBlock(readText(agentsMd))); }

    // The token goes into the config as a static header, like Claude's registration. An environment variable
    // (`--bearer-token-env-var`) only reaches apps started after it was set: an editor that was already open
    // launches Codex without it and the helix server fails to start.
    note("codex mcp", `register MCP server "helix" -> ${mcpUrl}`);
    if (!dry) {
      await env.run(env.codexBin, ["mcp", "remove", "helix"]);
      const r = await env.run(env.codexBin, ["mcp", "add", "helix", "--url", mcpUrl]);
      if (r.code !== 0) changes[changes.length - 1] = { target: "codex mcp", action: "register MCP server failed", ok: false, detail: r.stderr.trim() || r.stdout.trim() };
      else {
        const configToml = path.join(env.codexHome, "config.toml");
        const done = setCodexHelixHeader(readText(configToml), token);
        if (done === undefined) changes[changes.length - 1] = { target: "codex mcp", action: "set the Helix token in config.toml failed", ok: false, detail: "no [mcp_servers.helix] table found" };
        else { backup(env, configToml, dry); writeFile(configToml, done); }
      }
    }
  }
  return changes;
}

/** Undo connect(): removes only what Helix added; everything else in those files is left as it was. */
export async function disconnect(env: ConnectEnv, opts: ConnectOptions = {}): Promise<Change[]> {
  const dry = !!opts.dryRun;
  const changes: Change[] = [];
  const note = (target: string, action: string, ok = true, detail?: string) => changes.push({ target, action: dry ? `would ${action}` : action, ok, detail });

  if (opts.claude !== false) {
    note("claude mcp (user scope)", 'remove MCP server "helix"');
    if (!dry) await env.run(env.claudeBin, ["mcp", "remove", "helix", "--scope", "user"]);

    const claudeMd = path.join(env.claudeHome, "CLAUDE.md");
    if (hasBlock(readText(claudeMd))) {
      note(claudeMd, "remove the Helix instructions block");
      if (!dry) { backup(env, claudeMd, dry); writeFile(claudeMd, removeBlock(readText(claudeMd))); }
    }
    const settingsFile = path.join(env.claudeHome, "settings.json");
    if (fs.existsSync(settingsFile) && installedHookEvents(readJson(settingsFile)).length > 0) {
      note(settingsFile, "remove the Helix hooks");
      if (!dry) { backup(env, settingsFile, dry); writeFile(settingsFile, JSON.stringify(removeHooks(readJson(settingsFile)), null, 2) + "\n"); }
    }
  }

  if (opts.codex !== false && fs.existsSync(env.codexHome)) {
    const agentsMd = path.join(env.codexHome, "AGENTS.md");
    if (hasBlock(readText(agentsMd))) {
      note(agentsMd, "remove the Helix instructions block");
      if (!dry) { backup(env, agentsMd, dry); writeFile(agentsMd, removeBlock(readText(agentsMd))); }
    }
    note("codex mcp", 'remove MCP server "helix"');
    if (!dry) await env.run(env.codexBin, ["mcp", "remove", "helix"]);
    if ((env.platform ?? process.platform) === "win32") {
      note(`user environment variable ${TOKEN_ENV}`, "remove");
      if (!dry) await env.run("reg", ["delete", "HKCU\\Environment", "/v", TOKEN_ENV, "/f"]);
    }
  }

  const launcher = path.join(env.startupDir, "helix-presence.vbs");
  if (opts.presence !== false && fs.existsSync(launcher)) {
    note(launcher, "remove the desktop idle reporter and stop it");
    if (!dry) { fs.rmSync(launcher, { force: true }); await stopPresenceHelper(env); }
  }

  const localJson = path.join(env.helixHome, "local.json");
  if (fs.existsSync(localJson)) {
    note(localJson, "delete");
    if (!dry) fs.rmSync(localJson, { force: true });
  }
  return changes;
}

export interface StatusItem { name: string; connected: boolean; detail?: string }

export async function status(env: ConnectEnv): Promise<StatusItem[]> {
  const items: StatusItem[] = [];
  items.push({ name: "hook credentials (~/.helix/local.json)", connected: fs.existsSync(path.join(env.helixHome, "local.json")) });
  items.push({ name: "Claude: CLAUDE.md instructions", connected: hasBlock(readText(path.join(env.claudeHome, "CLAUDE.md"))) });
  let hooks: string[] = [];
  try { hooks = installedHookEvents(readJson(path.join(env.claudeHome, "settings.json"))); } catch { /* unreadable */ }
  items.push({ name: "Claude: hooks", connected: hooks.length > 0, detail: hooks.join(", ") || undefined });
  const cm = await env.run(env.claudeBin, ["mcp", "get", "helix"]);
  items.push({ name: "Claude: MCP server", connected: cm.code === 0 && /helix/i.test(cm.stdout) });
  if ((env.platform ?? process.platform) === "win32") {
    items.push({ name: "Desktop idle reporter (starts at logon)", connected: fs.existsSync(path.join(env.startupDir, "helix-presence.vbs")) });
  }
  if (fs.existsSync(env.codexHome)) {
    items.push({ name: "Codex: AGENTS.md instructions", connected: hasBlock(readText(path.join(env.codexHome, "AGENTS.md"))) });
    const xm = await env.run(env.codexBin, ["mcp", "get", "helix"]);
    items.push({ name: "Codex: MCP server", connected: xm.code === 0 });
  }
  return items;
}
