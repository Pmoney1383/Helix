// Explicit desktop grants. Never prints secrets and never starts input as a side effect of granting access.
import { loadConfig, loadDotEnv } from "../config.js";
import { openDb } from "../storage/sqlite.js";
import { LocalTokenService } from "../auth/local-tokens.js";

loadDotEnv();
const db = openDb(loadConfig().dbPath);
try {
  const service = new LocalTokenService(db);
  const [command, id] = process.argv.slice(2);
  if (command === "list") {
    console.log("OAuth clients (grants survive token refresh):");
    for (const c of service.desktopClients()) console.log(`${c.id}  ${c.enabled ? "enabled" : "disabled"}  ${c.name}`);
    console.log("Credentials (use for local agents or static hosted tokens):");
    for (const t of service.list().filter(t => !t.revoked)) console.log(`${t.id}  ${service.desktopAllowed(t.id) ? "enabled" : "disabled"}  ${t.scope}  ${t.name}`);
  } else if ((command === "enable" || command === "disable") && id) {
    if (!service.setDesktopAccess(id, command === "enable")) { console.error("No matching client or active credential."); process.exitCode = 1; }
    else console.log(command === "enable"
      ? "Desktop access enabled. This permits screenshots and mouse/keyboard control of your unlocked desktop. Refresh the connector's tool list. Start control only for a task you requested; Ctrl+Alt+Shift+F12 or physical input stops it."
      : "Desktop access disabled. Active control stops within two seconds (or the helper watchdog if disconnected).");
  } else console.log("usage: npm run desktop -- list | enable <client-or-token-id> | disable <client-or-token-id>");
} finally { db.close(); }
