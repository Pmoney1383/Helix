// Manage credentials for hosted ChatGPT / Claude connectors (scope pc.hosted).
//
//   npm run hosted -- create [--name chatgpt] [--days 30 | --never]     prints the connector URL (shown once)
//   npm run hosted -- code            one-time code to approve an OAuth connector (ChatGPT / Claude)
//   npm run hosted -- list
//   npm run hosted -- revoke <id>      |  revoke --all
//
// The URL base comes from HELIX_PUBLIC_URL (e.g. https://my-pc.my-tailnet.ts.net); see docs/HOSTED.md.
import { LocalTokenService } from "../auth/local-tokens.js";
import { OAuthService } from "../oauth/oauth.js";
import { loadConfig, loadDotEnv } from "../config.js";
import { openDb } from "../storage/sqlite.js";

loadDotEnv();
const config = loadConfig();
const db = openDb(config.dbPath);
const tokens = new LocalTokenService(db);
const oauth = new OAuthService(db, tokens);

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (cmd === "create") {
  const name = flag("name") ?? "hosted";
  const never = rest.includes("--never");
  const days = never ? 0 : Number(flag("days") ?? 30);
  if (!never && (!Number.isFinite(days) || days <= 0 || days > 365)) { console.error("--days must be between 1 and 365"); process.exit(1); }
  const { id, token, expiresAt } = tokens.create(`hosted:${name}`, "pc.hosted", { ttlDays: never ? undefined : days });
  const base = (process.env.HELIX_PUBLIC_URL ?? "https://<your-funnel-host>").replace(/\/$/, "");
  console.log(`\nCreated hosted credential "${name}" (id ${id}), expires ${expiresAt ?? "never"}.`);
  console.log("Shown once. Anyone with it can use the hosted tools (read-only inspection and safe commands), so keep it private.\n");
  console.log(`  Connector URL : ${base}/mcp/t/${token}`);
  console.log(`  or bearer     : POST ${base}/mcp  with  Authorization: Bearer ${token}\n`);
} else if (cmd === "code") {
  const { code, expiresAt } = oauth.createApprovalCode();
  console.log(`\nApproval code: ${code}   (one use, expires ${expiresAt})`);
  console.log("Enter it on the Helix consent page that opens when you connect ChatGPT or Claude.\n");
} else if (cmd === "list") {
  const rows = tokens.list().filter((t) => t.scope === "pc.hosted");
  if (!rows.length) console.log("No hosted credentials.");
  for (const t of rows) {
    const state = t.revoked ? "revoked" : t.expiresAt && t.expiresAt < new Date().toISOString() ? "expired" : "active";
    console.log(`${t.id}  ${t.name.padEnd(24)} ${state.padEnd(8)} created ${t.createdAt}  expires ${t.expiresAt ?? "never"}  last used ${t.lastUsedAt ?? "never"}`);
  }
} else if (cmd === "revoke") {
  if (rest.includes("--all")) {
    const n = tokens.list().filter((t) => t.scope === "pc.hosted" && !t.revoked).map((t) => tokens.revoke(t.id)).filter(Boolean).length;
    console.log(`Revoked ${n} hosted credential(s) and ${oauth.revokeAll()} connector refresh token(s).`);
  } else {
    const id = rest[0];
    console.log(id && tokens.revoke(id) ? "Revoked." : "No such active credential.");
  }
} else {
  console.log("usage: npm run hosted -- create [--name N] [--days D | --never] | code | list | revoke <id> | revoke --all");
}
db.close();
