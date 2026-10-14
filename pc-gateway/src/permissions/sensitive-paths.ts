// Files an agent may not change without the user's approval, however normal the edit looks: credentials, the
// configuration that decides what agents and Helix are allowed to do, and places that make something run again later
// (startup folders, shell profiles, hooks). Ordinary project files are not on this list, so normal coding never asks.
import path from "node:path";

/** Credentials and secrets. Hosted chats may not even read these (permissions/hosted-safety.ts). */
export const CREDENTIAL_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /\.(p8|pem|key|pfx|p12|ppk|kdbx|keystore|jks)$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|[\\/])\.(ssh|aws|azure|gnupg|kube|docker|gcloud)([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gh([\\/]|$)/i,
  /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials|pgpass)$/i,
  /(^|[\\/])\.helix([\\/]|$)/i,
  /(^|[\\/])\.claude[\\/](\.credentials\.json|settings(\.local)?\.json)$/i,
  /(^|[\\/])\.claude\.json$/i,
  /(^|[\\/])\.codex[\\/](auth\.json|config\.toml)$/i,
  /(^|[\\/])(login data|cookies|web data|local state)$/i,
  /(^|[\\/])(credentials|secrets?)(\.[a-z]+)?$/i,
  /helix\.db(-wal|-shm)?$/i,
  /(^|[\\/])(sam|security|system)$/i,
];

/** What decides what agents may do, or runs code on their behalf. */
const SECURITY_CONFIG: [RegExp, string][] = [
  [/(^|[\\/])\.claude[\\/](settings(\.local)?\.json|CLAUDE\.md)$/i, "Claude Code settings or global instructions"],
  [/(^|[\\/])\.claude[\\/](hooks|plugins|agents|commands|skills|output-styles)([\\/]|$)/i, "Claude Code hooks, plugins or agents"],
  [/(^|[\\/])\.mcp\.json$/i, "MCP server configuration"],
  [/(^|[\\/])\.codex[\\/](config\.toml|auth\.json|AGENTS\.md|hooks\.json|rules)([\\/]|$)/i, "Codex configuration or global instructions"],
  [/(^|[\\/])\.git[\\/](hooks([\\/]|$)|config$)/i, "git hooks or repository config (can run code)"],
  [/(^|[\\/])\.gitconfig$/i, "global git config (can run code)"],
];

/** Places that make something start again later, without anyone asking. */
const PERSISTENCE: [RegExp, string][] = [
  [/[\\/]Start Menu[\\/]Programs[\\/]Startup([\\/]|$)/i, "the Windows Startup folder"],
  [/(^|[\\/])(Microsoft\.[\w.]+_)?profile\.ps1$/i, "a PowerShell profile"],
  [/(^|[\\/])\.(bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin)$/i, "a shell startup file"],
  [/(^|[\\/])\.config[\\/](fish[\\/]config\.fish|autostart([\\/]|$))/i, "a shell startup file or autostart entry"],
  [/[\\/]Windows[\\/]System32[\\/]Tasks([\\/]|$)/i, "scheduled tasks"],
];

export interface SensitiveContext {
  /** Helix's own data folder (database, desktop helper jobs). */
  dataDir?: string;
  /** The gateway package: its hooks and service scripts run with the user's rights. */
  gatewayRoot?: string;
}

let context: SensitiveContext = {};

/** Set once by the gateway so Helix's own folders are protected wherever they live. */
export function configureSensitivePaths(c: SensitiveContext): void {
  context = { ...c };
}

const under = (p: string, dir: string): boolean => {
  const d = path.resolve(dir).toLowerCase().replace(/\//g, "\\");
  return p === d || p.startsWith(d + "\\");
};

/** Why changing this path needs the user's approval, or undefined for an ordinary file. */
export function sensitiveReason(p: string): string | undefined {
  if (!p.trim()) return undefined;
  const norm = path.resolve(p).replace(/\//g, "\\");
  // `.env.example` and friends are templates checked into projects: editing them is ordinary coding.
  const template = /(^|\\)\.env\.(example|sample|template|dist|defaults)$/i.test(norm);
  if (!template && CREDENTIAL_PATTERNS.some((re) => re.test(norm))) return "credentials or secrets";
  for (const [re, why] of [...SECURITY_CONFIG, ...PERSISTENCE]) if (re.test(norm)) return why;
  const lower = norm.toLowerCase();
  if (context.dataDir && under(lower, context.dataDir)) return "Helix's own data";
  if (context.gatewayRoot) {
    for (const sub of ["hooks", "service"]) if (under(lower, path.join(context.gatewayRoot, sub))) return "Helix's hooks or service scripts";
  }
  return undefined;
}

/* ---------------- the same, for a shell command line ---------------- */

/** Mentions of sensitive places in free text (a command line), unanchored. */
const SENSITIVE_IN_TEXT: [RegExp, string][] = [
  [/(^|[\s"'`=\\/])\.env(\.\w+)?(?=$|[\s"'`;|&)])/i, "an .env file"],
  [/\.(p8|pem|pfx|p12|ppk|kdbx)\b|\bid_(rsa|ed25519|ecdsa)\b/i, "a key file"],
  [/[\\/]\.(ssh|aws|azure|gnupg|kube|helix)\b|~[\\/]\.(ssh|aws|helix)\b|\bauthorized_keys\b/i, "a credential folder"],
  [/\.(npmrc|netrc|git-credentials|pgpass)\b|\.credentials\.json|\.claude\.json\b|\.codex[\\/](auth\.json|config\.toml)/i, "a credential file"],
  [/\.claude[\\/](settings(\.local)?\.json|CLAUDE\.md|hooks|plugins|agents|commands|skills)/i, "Claude Code settings or hooks"],
  [/\.mcp\.json\b/i, "MCP server configuration"],
  [/\.codex[\\/](AGENTS\.md|hooks\.json|rules)/i, "Codex configuration"],
  [/\.git[\\/](hooks|config)\b|\.gitconfig\b/i, "git hooks or config"],
  [/Start Menu[\\/]Programs[\\/]Startup|shell:startup|shell:common startup/i, "the Startup folder"],
  [/\$PROFILE\b|\bprofile\.ps1\b/i, "a PowerShell profile"],
  [/(^|[\s"'`\\/~])\.(bashrc|bash_profile|zshrc|zprofile|zshenv)\b/i, "a shell startup file"],
  [/helix\.db\b/i, "the Helix database"],
];

/** Verbs and constructs that write, copy, move, link or re-permission files. */
const WRITES = /\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|tee-object|tee|cp|mv|copy|move|xcopy|robocopy|ren|rename|ln|mklink|install|sed\s+-i|perl\s+-[a-z]*i|icacls|takeown|attrib|chmod|chown)\b|\[\s*(System\.)?IO\.File\s*\]\s*::\s*(Write|Append|Copy|Move|Replace|Create)|\bWriteAllText\b|\bAppendAllText\b/i;

/** Commands that make something run at logon or on a schedule, or loosen the machine's defences. */
const PERSISTENCE_COMMANDS: [RegExp, string][] = [
  [/\breg(\.exe)?\s+(add|import|load|restore)\b/i, "changes the registry"],
  [/\b(new|set)-itemproperty\b[^;|&]*\\(CurrentVersion\\(Run|RunOnce|Policies)|Winlogon|Image File Execution Options)\b/i, "adds a logon or startup entry"],
  [/\bschtasks(\.exe)?\b[^;|&]*\/(create|change)\b|\b(register|set)-scheduledtask\b/i, "creates or changes a scheduled task"],
  [/\bnew-service\b|\bsc(\.exe)?\s+(create|config)\b|\bset-service\b[^;|&]*-startuptype/i, "creates or reconfigures a service"],
  [/\b(add|set)-mppreference\b|\bset-executionpolicy\b|\bnetsh\s+(advfirewall|firewall)\b|\b(new|set)-netfirewallrule\b|\bbcdedit\b/i, "changes security settings"],
  [/\bgit\s+(-C\s+\S+\s+)?config\b(?![^;|&]*\s--?(get|get-all|get-regexp|list|l)\b)[^;|&]*\b(core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass)|credential\.|alias\.|filter\.|diff\.\w+\.textconv|url\.)/i, "changes a git setting that can run code"],
  [/\bcrontab\b|\bsystemctl\s+(enable|edit)\b|\blaunchctl\s+(load|bootstrap)\b/i, "schedules work or enables a service"],
];

/** `>` / `>>` into a file, as opposed to `2>&1`, `>$null`, `=>` or `->`. */
function redirects(command: string): boolean {
  const cleaned = command.replace(/\d?>\s*&\s*\d/g, "").replace(/\d?>>?\s*\$null\b/gi, "").replace(/[=-]>/g, "");
  return />/.test(cleaned);
}

/** Why this command line needs approval because of what it would change, or undefined. */
export function sensitiveCommandReasons(command: string): string[] {
  const reasons: string[] = [];
  for (const [re, why] of PERSISTENCE_COMMANDS) if (re.test(command)) reasons.push(why);
  if (WRITES.test(command) || redirects(command)) {
    for (const [re, what] of SENSITIVE_IN_TEXT) if (re.test(command)) reasons.push(`writes to ${what}`);
    const lower = command.toLowerCase();
    if (context.dataDir && lower.includes(path.resolve(context.dataDir).toLowerCase())) reasons.push("writes to Helix's own data");
    if (context.gatewayRoot) {
      for (const sub of ["hooks", "service"]) if (lower.includes(path.join(path.resolve(context.gatewayRoot), sub).toLowerCase())) reasons.push("writes to Helix's hooks or service scripts");
    }
  }
  return reasons;
}
