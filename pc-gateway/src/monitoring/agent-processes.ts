// Tracks long-running processes that Claude/Codex sessions started (a training run, a build, a download,
// a dev server), and reports when they end, with nobody having to tell Helix they exist.
//
// How: Windows records each process's parent. Starting from every running `claude` / `codex` process we
// walk down the process tree, look through shells, skip known helper servers, and remember the top-most
// "real" program in each branch once it has been running a while. When it disappears, that is the news.
//
// What counts as news: a program that ends while its agent is still running (the job finished), or one
// that outlives its agent and later ends (a job left running). A program that vanishes in the same
// moment as its agent is not news: that is every MCP server and tool process dying with the session.
//
// Limits: a process that is not a descendant of an agent (a scheduler, a service, another terminal) is
// invisible here, and Windows does not give exit codes for processes we did not start, so "ended" is all
// we can say. Pair it with a log watch (watch_job) when success vs. failure matters.

export interface ProcSnap {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  /** Epoch ms the process started. Together with pid this identifies it (pids get reused). */
  createdMs: number;
}

export interface TrackedProc {
  name: string;
  cmd: string;
  createdMs: number;
  /** Which agent started it, for the notification text. */
  owner: string;
  ownerPid: number;
  ownerCreatedMs: number;
  /** The agent was already gone the last time we saw this process running (it outlived its owner). */
  ownerGone?: boolean;
}

const AGENT_ROOT = /^(claude|codex)(\.exe)?$/i;
/** Shells and console plumbing: never the interesting process themselves; look through them to their children. */
const WRAPPERS = new Set(["cmd.exe", "powershell.exe", "pwsh.exe", "bash.exe", "sh.exe", "zsh.exe", "conhost.exe", "openconsole.exe", "windowsterminal.exe", "wslhost.exe", "wsl.exe"]);
/** Helper servers and tooling that live as long as the agent does: not "work", and their children are not either. */
const HELPERS = /(mcp|modelcontextprotocol|--stdio|node_repl|cua-repl|computer-use|gitkraken|language[-_]server|tsserver|helix-hook|\bnpx(-cli)?\b.*\b(mcp|plugin)\b)/i;
/**
 * Programs living under the agent's own home folder (plugin servers and the like). Not applied to shells:
 * the shell wrappers an agent uses to run YOUR commands mention these folders too (shell snapshots), and
 * skipping them would hide exactly the jobs we want to see.
 */
const AGENT_HOME = /[\\/]\.(claude|codex)[\\/]/i;
const IGNORED_NAMES = new Set(["rg.exe", "claude.exe", "codex.exe", "conhost.exe", "git.exe", "tasklist.exe", "wmic.exe", "taskkill.exe"]);

export interface TrackInput {
  snapshot: ProcSnap[];
  tracked: Record<string, TrackedProc>;
  now: number;
  minRuntimeMs: number;
  /** pids already covered by an explicit process watch, to avoid telling the user twice. */
  covered: Set<number>;
  /** Display names for agent processes (e.g. the session title), by pid. */
  ownerNames: Map<number, string>;
}

export interface TrackResult {
  tracked: Record<string, TrackedProc>;
  started: TrackedProc[];
  ended: (TrackedProc & { runMs: number })[];
}

export function trackAgentProcesses(i: TrackInput): TrackResult {
  const byParent = new Map<number, ProcSnap[]>();
  for (const p of i.snapshot) {
    const l = byParent.get(p.ppid) ?? [];
    l.push(p);
    byParent.set(p.ppid, l);
  }
  const present = new Map(i.snapshot.map((p) => [`${p.pid}`, p]));

  // Find the candidates: top-most real programs under each agent.
  const candidates: { proc: ProcSnap; root: ProcSnap; owner: string }[] = [];
  for (const root of i.snapshot.filter((p) => AGENT_ROOT.test(p.name))) {
    const owner = i.ownerNames.get(root.pid) ?? (root.name.toLowerCase().startsWith("codex") ? "Codex" : "Claude");
    const walk = (parent: ProcSnap, depth: number) => {
      if (depth > 8) return;
      for (const c of byParent.get(parent.pid) ?? []) {
        const name = c.name.toLowerCase();
        if (c.pid === parent.pid) continue;
        if (HELPERS.test(c.cmd) || IGNORED_NAMES.has(name)) continue; // skip it and everything below
        if (WRAPPERS.has(name)) { walk(c, depth + 1); continue; }      // look through shells
        if (AGENT_HOME.test(c.cmd)) continue;                          // the agent's own plugin/tool programs
        candidates.push({ proc: c, root, owner });                     // the program itself; do not descend (its workers are noise)
      }
    };
    walk(root, 0);
  }

  const tracked: Record<string, TrackedProc> = { ...i.tracked };
  const started: TrackedProc[] = [];
  for (const { proc, root, owner } of candidates) {
    const key = `${proc.pid}:${proc.createdMs}`;
    if (tracked[key] || i.covered.has(proc.pid)) continue;
    if (i.now - proc.createdMs < i.minRuntimeMs) continue; // short-lived commands are not worth tracking
    tracked[key] = { name: proc.name, cmd: proc.cmd, createdMs: proc.createdMs, owner, ownerPid: root.pid, ownerCreatedMs: root.createdMs };
    started.push(tracked[key]);
  }

  const ownerAlive = (t: TrackedProc) => present.get(`${t.ownerPid}`)?.createdMs === t.ownerCreatedMs;

  const ended: TrackResult["ended"] = [];
  for (const [key, t] of Object.entries(tracked)) {
    const pid = key.split(":")[0]!;
    const live = present.get(pid);
    if (live && live.createdMs === t.createdMs) {
      tracked[key] = { ...t, ownerGone: !ownerAlive(t) }; // still running; note whether its agent has gone
      continue;
    }
    // Gone. News unless it simply died along with its agent (both vanished since the last look).
    const diedWithAgent = !ownerAlive(t) && !t.ownerGone;
    if (!diedWithAgent) ended.push({ ...t, runMs: i.now - t.createdMs });
    delete tracked[key];
  }
  return { tracked, started, ended };
}

/** "C:\Python\python.exe train.py --steps 1000" -> "python.exe train.py --steps 1000" (trimmed). */
export function shortCommand(name: string, cmd: string, max = 90): string {
  const text = (cmd || name).trim();
  const m = text.match(/^"([^"]+)"\s*(.*)$/) ?? text.match(/^(\S+)\s*(.*)$/);
  const exe = m ? (m[1]!.split(/[\\/]/).pop() ?? m[1]!) : name;
  const rest = m?.[2]?.replace(/[A-Za-z]:\\[^\s"]*\\([^\s"\\]+)/g, "$1") ?? "";
  const out = `${exe} ${rest}`.trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}
