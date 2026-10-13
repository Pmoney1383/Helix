import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Environment for the Codex app-server the gateway runs.
 *
 * `helix connect` registers the Helix MCP server in Codex's config with the token read from the
 * HELIX_AGENT_TOKEN environment variable. A Windows service was started before that variable was
 * set, so without this the server's `helix` tools would fail to start in every Codex session Helix
 * runs. Fill it from ~/.helix/local.json, the same credential the hooks use.
 */
export function codexEnv(base: NodeJS.ProcessEnv = process.env, helixHome?: string): NodeJS.ProcessEnv {
  if (base.HELIX_AGENT_TOKEN) return base;
  try {
    const home = helixHome ?? base.HELIX_HOME ?? path.join(os.homedir(), ".helix");
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "local.json"), "utf8")) as { token?: string };
    if (cfg.token) return { ...base, HELIX_AGENT_TOKEN: cfg.token };
  } catch { /* not connected: Codex simply will not have the Helix tools */ }
  return base;
}
