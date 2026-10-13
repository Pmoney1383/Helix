// Decides whether an agent action is destructive/irreversible and therefore needs human approval.
//
// This is deliberately conservative. A shell command can't be fully analysed statically, so the
// rules are: (1) known deletion verbs/APIs anywhere in the command, including inside wrappers like
// `cmd /c` or `bash -c`; (2) anything we can't inspect (encoded/obfuscated commands, piping a download
// into a shell) also needs approval. False positives cost one tap on the phone; false negatives cost files.

export interface Action {
  /** Claude tool name ("Bash", "Write", "mcp__x__delete_thing") or an MCP tool name. */
  tool: string;
  input: Record<string, unknown>;
}

export interface Classification {
  destructive: boolean;
  reasons: string[];
  /** True if the command could not be inspected, as opposed to matching a known destructive pattern. */
  opaque: boolean;
}

const SHELL_TOOLS = new Set(["bash", "powershell", "run_command", "shell", "pwsh"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "write_file"]);

/** Verbs that delete files/dirs when they are the command word. */
const DELETE_COMMANDS = new Set([
  "rm", "rmdir", "rd", "del", "erase", "unlink", "shred", "srm", "trash", "trash-put", "gio-trash",
  "remove-item", "ri", "deltree", "rimraf", "remove-itemproperty", "clear-content", "clear-recyclebin",
  "format", "format-volume", "clear-disk", "remove-partition", "mkfs", "wipefs", "fdisk", "diskpart", "cipher",
  "truncate",
]);

/** Commands that run another command string, so the string is classified recursively. */
const WRAPPERS = new Set([
  "sudo", "doas", "env", "nohup", "time", "command", "exec", "xargs", "start", "call", "start-process", "invoke-command",
  "cmd", "powershell", "pwsh", "bash", "sh", "zsh", "dash", "wsl", "busybox", "timeout", "nice", "ionice",
  "invoke-expression", "iex",
]);

/** Whole-string patterns for deletion done through interpreters/APIs, regardless of position. */
const EMBEDDED_PATTERNS: [RegExp, string][] = [
  [/\bos\.(remove|unlink|rmdir|removedirs)\b/i, "python os.remove/unlink"],
  [/\bshutil\.rmtree\b|\brmtree\b/i, "python rmtree"],
  [/\bpathlib\b.*\.(unlink|rmdir)\b|\.unlink\(|\.rmdir\(/i, "unlink/rmdir call"],
  [/\.(rmSync|unlinkSync|rmdirSync)\b|\bfs\b[^;&|]*\.(rm|unlink|rmdir)\s*\(|\bfs\.promises\.(rm|unlink|rmdir)\b/i, "node fs delete"],
  [/\bmkfs(\.\w+)?\b|\bwipefs\b/i, "filesystem format"],
  [/\bFile\.Delete\b|\bDirectory\.Delete\b|\[\s*(System\.)?IO\.(File|Directory)\s*\]\s*::\s*Delete/i, ".NET delete"],
  [/\bRemove-Item\b|\bRemove-ItemProperty\b|\bClear-RecycleBin\b/i, "PowerShell Remove-Item"],
  [/\bFileSystem\.DeleteFile\b|\bDeleteDirectory\b|SHFileOperation/i, "Windows API delete"],
  [/\bgit\s+(-C\s+\S+\s+)?clean\b/i, "git clean"],
  [/\bgit\s+(-C\s+\S+\s+)?reset\s+(.*\s)?--hard\b/i, "git reset --hard"],
  [/\bgit\s+(-C\s+\S+\s+)?checkout\s+(.*\s)?(--\s+\S+|\.\s*$)/i, "git checkout discarding changes"],
  [/\bgit\s+(-C\s+\S+\s+)?restore\b(?!.*--staged\b)/i, "git restore (discards working-tree changes)"],
  [/\bgit\s+(-C\s+\S+\s+)?(rm|branch\s+(-D|--delete\s+--force)|stash\s+(drop|clear)|worktree\s+remove|reflog\s+expire|gc\s+--prune)/i, "git history/file removal"],
  [/\bgit\s+(-C\s+\S+\s+)?push\b.*(--force\b|--force-with-lease\b|\s-f\b|--delete\b|\s:\S+)/i, "git force/delete push"],
  [/\bdrop\s+(table|database|schema|index|view|collection)\b/i, "SQL DROP"],
  [/\btruncate\s+(table\s+)?\w+/i, "SQL/file truncate"],
  [/\bdelete\s+from\b/i, "SQL DELETE"],
  [/\b(db|collection)\.\w*(drop|deleteMany|remove)\w*\(/i, "database drop/delete"],
  [/\b(flushall|flushdb)\b/i, "redis flush"],
  [/\bdd\b[^|;&]*\bof=/i, "dd write"],
  [/\bfind\b[^|;&]*(\s-delete\b|-exec\s+(rm|del)\b)/i, "find -delete"],
  [/\brsync\b[^|;&]*--delete/i, "rsync --delete"],
  [/\brobocopy\b[^|;&]*(\s\/mir\b|\s\/purge\b)/i, "robocopy mirror/purge"],
  [/\breg(\.exe)?\s+delete\b/i, "registry delete"],
  [/\bschtasks(\.exe)?\b[^|;&]*\/delete\b|\bsc(\.exe)?\s+delete\b|\bnet\s+user\b[^|;&]*\/delete\b/i, "service/task/user delete"],
  [/\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|container\s+prune|image\s+prune|network\s+(rm|prune))\b/i, "docker removal"],
  [/\bkubectl\s+delete\b|\bgh\s+repo\s+delete\b|\bnpm\s+(unpublish|uninstall|rm)\b|\bpip3?\s+uninstall\b|\bwinget\s+uninstall\b|\bchoco\s+uninstall\b/i, "uninstall/delete"],
  [/\b(wevtutil\s+cl|vssadmin\s+delete|bcdedit\s+\/delete|wbadmin\s+delete)\b/i, "system data wipe"],
  [/\brm\s+-\w*[rf]/i, "rm -rf"],
  [/(^|[\s;|&(])(rm|rmdir|rd|del|erase|unlink|shred)\s/i, "delete command"],
];

/** Constructs that hide what will run. */
const OPAQUE_PATTERNS: [RegExp, string][] = [
  [/-(e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i, "PowerShell encoded command"],
  [/\bbase64\b[^|;&]*(-d|--decode)[^;&]*\|\s*(sh|bash|zsh|powershell|pwsh|python3?|node|iex)\b/i, "decoded payload piped to interpreter"],
  [/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^;&]*\|\s*(sh|bash|zsh|powershell|pwsh|iex|invoke-expression|python3?|node)\b/i, "download piped to interpreter"],
  [/\b(iex|invoke-expression)\b.*\b(downloadstring|frombase64string)\b/i, "PowerShell download-and-execute"],
  [/\bfrombase64string\b/i, "base64 decode in script"],
  [/\beval\b\s*[("$`]/i, "eval of dynamic string"],
];

const DESTRUCTIVE_TOOL_NAME = /(delete|remove|purge|wipe|destroy|drop|truncate|erase|unlink|rmdir|uninstall|prune|format_disk|reset_hard)/i;

export function classify(action: Action): Classification {
  const reasons = new Set<string>();
  let opaque = false;
  const tool = action.tool.toLowerCase();
  const baseTool = tool.split("__").pop() ?? tool; // mcp__server__tool -> tool

  if (SHELL_TOOLS.has(tool) || SHELL_TOOLS.has(baseTool)) {
    const command = String(action.input["command"] ?? action.input["cmd"] ?? "");
    const r = classifyCommand(command, 0);
    r.reasons.forEach((x) => reasons.add(x));
    opaque = r.opaque;
  } else if (FILE_WRITE_TOOLS.has(tool) || FILE_WRITE_TOOLS.has(baseTool)) {
    // Creating or editing files is a normal action. Nothing to flag.
  } else if (DESTRUCTIVE_TOOL_NAME.test(baseTool)) {
    reasons.add(`tool "${action.tool}" is named like a destructive operation`);
  }

  return { destructive: reasons.size > 0 || opaque, reasons: [...reasons], opaque };
}

function classifyCommand(command: string, depth: number): { reasons: string[]; opaque: boolean } {
  const reasons = new Set<string>();
  let opaque = false;
  if (!command.trim()) return { reasons: [], opaque: false };
  if (depth > 4) return { reasons: ["command nesting too deep to inspect"], opaque: true };

  for (const [re, why] of OPAQUE_PATTERNS) if (re.test(command)) { reasons.add(`cannot inspect: ${why}`); opaque = true; }
  for (const [re, why] of EMBEDDED_PATTERNS) if (re.test(command)) reasons.add(why);

  for (const segment of splitSegments(command)) {
    const words = shellSplit(segment);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++; // VAR=value prefixes
    const first = words[i];
    if (!first) continue;
    const name = baseName(first);

    if (DELETE_COMMANDS.has(name)) reasons.add(`${name} deletes data`);
    if (WRAPPERS.has(name)) {
      // Classify the argument that is itself a command line, and also the remaining words as a command.
      const rest = words.slice(i + 1);
      for (const w of rest) {
        if (/\s/.test(w)) {
          const inner = classifyCommand(w, depth + 1);
          inner.reasons.forEach((x) => reasons.add(x));
          opaque = opaque || inner.opaque;
        }
      }
      const restJoined = rest.filter((w) => !w.startsWith("-") && !w.startsWith("/")).join(" ");
      if (restJoined) {
        const inner = classifyCommand(restJoined, depth + 1);
        inner.reasons.forEach((x) => reasons.add(x));
        opaque = opaque || inner.opaque;
      }
    }
  }
  return { reasons: [...reasons], opaque };
}

function baseName(word: string): string {
  const w = word.replace(/^["']|["']$/g, "");
  const leaf = w.split(/[\\/]/).pop() ?? w;
  return leaf.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, "");
}

/** Split on ; && || | & and newlines, ignoring separators inside quotes. */
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r" || c === "(" || c === ")" || c === "{" || c === "}") {
      if (cur.trim()) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Whitespace split that keeps quoted strings together (quotes stripped). */
function shellSplit(segment: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = ""; has = false;
      continue;
    }
    cur += c; has = true;
  }
  if (has || cur) words.push(cur);
  return words;
}

/** Human-readable one-liner for the approval card. */
export function describeAction(action: Action): string {
  const input = action.input;
  const cmd = input["command"] ?? input["cmd"];
  if (typeof cmd === "string") return `${action.tool}: ${cmd.length > 300 ? cmd.slice(0, 300) + "…" : cmd}`;
  const target = input["file_path"] ?? input["path"] ?? input["notebook_path"];
  if (typeof target === "string") return `${action.tool}: ${target}`;
  const json = JSON.stringify(input);
  return `${action.tool}: ${json.length > 300 ? json.slice(0, 300) + "…" : json}`;
}
