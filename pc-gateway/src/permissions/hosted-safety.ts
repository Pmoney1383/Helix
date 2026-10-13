// Rules for the `pc.hosted` scope: what a hosted ChatGPT/Claude conversation, which reaches the PC over the internet,
// may do. Anything that passes is "safe": it can look, and it can run small read-mostly commands. Anything else is
// refused outright (there is no approval prompt for hosted callers; use the phone app or a local agent for those).
import path from "node:path";
import { classify } from "./classifier.js";

export interface Verdict {
  allowed: boolean;
  reason?: string;
}

const MAX_COMMAND_LENGTH = 2000;

/** Things a hosted caller must never read or touch: credentials, keys, tokens, Helix's own state. */
const PROTECTED_NAMES = [
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

export function isProtectedPath(p: string, dataDir?: string): boolean {
  const norm = path.resolve(p).replace(/\//g, "\\");
  if (PROTECTED_NAMES.some((re) => re.test(norm))) return true;
  if (dataDir) {
    const d = path.resolve(dataDir).toLowerCase();
    const n = norm.toLowerCase();
    if (n === d || n.startsWith(d + "\\")) return true;
  }
  return false;
}

/** The same protections applied to free text such as a command line: any mention of a protected name is refused. */
const PROTECTED_IN_TEXT: [RegExp, string][] = [
  [/(^|[\s"'`\\/])\.env(\.\w+)?(?=$|[\s"'`;|&)])/i, ".env file"],
  [/\.(p8|pem|pfx|p12|ppk|kdbx)\b/i, "key file"],
  [/\bid_(rsa|ed25519|ecdsa)\b/i, "ssh key"],
  [/[\\/]\.(ssh|aws|azure|gnupg|kube|helix)\b|~[\\/]\.(ssh|aws|helix)/i, "credential folder"],
  [/\.(npmrc|netrc|git-credentials|pgpass)\b|\.credentials\.json|auth\.json|local\.json/i, "credential file"],
  [/helix\.db\b/i, "Helix database"],
  [/\b(HELIX_[A-Z_]*|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN)\b/, "secret environment variable"],
  [/\b(get-childitem|dir|gci|ls)\s+env:|\$env:[a-z_]*(key|token|secret|pass)/i, "environment secrets"],
  [/\b(printenv|set)\s*(\||$)/i, "environment dump"],
  [/\bcmdkey\b|\bvaultcmd\b|\bmimikatz\b|\bget-credential\b|\bconvertfrom-securestring\b|\bsecretsdump\b/i, "credential tooling"],
];

/** Beyond "not destructive": no writes, no installs, no network fetches, no service/process/system changes. */
const HOSTED_DENY: [RegExp, string][] = [
  [/\b(shutdown|restart-computer|stop-computer|logoff)\b/i, "power or session control"],
  [/\b(set-executionpolicy|set-itemproperty|new-itemproperty|new-psdrive|reg(\.exe)?\s+(add|import|save|copy)|regedit|bcdedit|setx|netsh|set-netfirewallrule|new-netfirewallrule|enable-psremoting)\b/i, "system configuration change"],
  [/\b(stop-process|taskkill|kill|pskill|stop-service|restart-service|start-service|set-service|new-service|sc(\.exe)?\s+(stop|start|config|create)|net\s+(stop|start|user|localgroup))\b/i, "process or service control"],
  [/\b(invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget|start-bitstransfer|bitsadmin|certutil|scp|sftp|ftp|ssh|nc|ncat|telnet|test-netconnection)\b/i, "network access"],
  [/\b(npm|npx|pnpm|yarn|pip3?|pipx|winget|choco|scoop|cargo|go|gem|apt|brew)\s+(i|install|add|update|upgrade|publish|run-script|exec|dlx)\b/i, "installing or running packages"],
  [/\bgit\s+(-C\s+\S+\s+)?(push|commit|pull|merge|rebase|cherry-pick|am|apply|fetch|clone|add|stash|tag|config|remote|submodule)\b/i, "git change or network operation"],
  [/\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|set-item|tee-object|tee|copy|move|ren|rename|mkdir|md|touch|xcopy|robocopy|attrib|icacls|takeown|cacls|compress-archive|expand-archive|export-clixml|export-csv)\b/i, "writes files"],
  [/\b(start-process|start|invoke-command|icm|enter-pssession|invoke-item|ii|invoke-expression|iex|add-type|register-scheduledtask|schtasks|at)\b\s/i, "starts other programs or schedules work"],
  [/\b(powershell|pwsh|cmd|bash|sh|wsl|python3?|node|ruby|perl|php|java|dotnet)(\.exe)?\s+\S/i, "runs another interpreter"],
  [/`|\$\(|@\(|(^|[;|(]\s*)&\s*[\w"'$.\\]/, "dynamic command construction"],
];

/** `>` that writes somewhere, as opposed to `2>&1`, `>$null` or `=>` / `->`. */
function hasFileRedirect(command: string): boolean {
  const cleaned = command.replace(/\d?>\s*&\s*\d/g, "").replace(/\d?>>?\s*\$null\b/gi, "").replace(/[=-]>/g, "");
  return />/.test(cleaned);
}

export function hostedCommandVerdict(command: string, dataDir?: string): Verdict {
  const text = command.trim();
  if (!text) return { allowed: false, reason: "empty command" };
  if (text.length > MAX_COMMAND_LENGTH) return { allowed: false, reason: `command is longer than ${MAX_COMMAND_LENGTH} characters` };
  if (/[\r\n]/.test(text)) return { allowed: false, reason: "multi-line scripts are not allowed; send one short command" };

  const c = classify({ tool: "run_command", input: { command: text } });
  if (c.destructive) return { allowed: false, reason: `not marked safe: ${c.reasons.join("; ") || "destructive"}` };

  for (const [re, why] of PROTECTED_IN_TEXT) if (re.test(text)) return { allowed: false, reason: `not marked safe: touches ${why}` };
  if (dataDir && text.toLowerCase().includes(path.resolve(dataDir).toLowerCase())) return { allowed: false, reason: "not marked safe: touches Helix's data folder" };
  for (const [re, why] of HOSTED_DENY) if (re.test(text)) return { allowed: false, reason: `not marked safe: ${why}` };
  if (hasFileRedirect(text)) return { allowed: false, reason: "not marked safe: redirects output into a file" };
  return { allowed: true };
}
