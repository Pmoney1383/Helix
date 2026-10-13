import fs from "node:fs";
import path from "node:path";
import { buildGateway } from "./app.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { defaultHomes } from "./discovery/indexer.js";
import { FunnelWatchdog, realFunnelDeps } from "./monitoring/funnel-watchdog.js";
import { spawnSync } from "node:child_process";
import { ClaudeProvider } from "./providers/claude.js";
import { CodexProvider } from "./providers/codex.js";
import { codexEnv } from "./providers/codex-env.js";
import { openDb } from "./storage/sqlite.js";

loadDotEnv();
const config = loadConfig();
const db = openDb(config.dbPath);

// Codex is optional: only offered if the CLI is actually installed.
const codexInstalled = config.codex.enabled && spawnSync(config.codex.bin, ["--version"], { timeout: 15_000, windowsHide: true }).status === 0;
const codex = codexInstalled
  ? new CodexProvider({
      server: { bin: config.codex.bin, args: ["app-server", "--stdio"], env: () => codexEnv() },
      approvalPolicy: config.codex.approvalPolicy, sandbox: config.codex.sandbox,
    })
  : undefined;

let apns: Parameters<typeof buildGateway>[0]["apns"];
if (config.apns) {
  try {
    apns = { keyPem: fs.readFileSync(config.apns.keyPath, "utf8"), keyId: config.apns.keyId, teamId: config.apns.teamId, bundleId: config.apns.bundleId };
  } catch (err) {
    console.error(`APNs key could not be read (${config.apns.keyPath}): push and calls are disabled. ${err instanceof Error ? err.message : err}`);
  }
}

const gateway = await buildGateway({ ...config, apns, routerHome: path.join(config.dataDir, "router"), presenceAwayMin: config.presenceAwayMin, discovery: config.discovery ? { homes: defaultHomes() } : undefined }, db, {
  claude: new ClaudeProvider({
    bin: config.claudeBin,
    permissionMode: config.claudePermissionMode,
    toolTimeoutMs: config.approvalTtlMs + 5 * 60_000,
  }),
  ...(codex ? { codex } : {}),
});
console.log(codex ? "codex provider enabled" : "codex not available: Codex sessions are visible but not controllable");
const { app } = gateway;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
// Spawned agents call back over loopback, whatever interface the gateway is exposed on.
gateway.enableAgentGate(`http://127.0.0.1:${config.port}`);
gateway.watchers.ensureDefaults(); // always-on "agent tasks" watch, created once
gateway.watchers.start();
gateway.indexer?.start();

// Hosted connectors (ChatGPT, claude.ai) need the Tailscale Funnel paths: check them end to end and put them back if they go missing.
if (config.publicUrl && process.env.HELIX_FUNNEL_WATCHDOG !== "false") {
  const tsBin = process.env.HELIX_TAILSCALE_BIN ?? (fs.existsSync("C:\\Program Files\\Tailscale\\tailscale.exe") ? "C:\\Program Files\\Tailscale\\tailscale.exe" : "tailscale");
  new FunnelWatchdog(
    realFunnelDeps(tsBin, (n) => gateway.escalation.notify(n), app.log),
    { publicUrl: config.publicUrl, port: config.port },
  ).start(); // its timer is unref'd: it never keeps the process alive
}
