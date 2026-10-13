// Incremental parsers for the transcript files Claude Code and Codex write to disk.
//
// These formats are written by third-party tools and are not a stable API, so every parser is
// defensive: unknown line types are ignored, missing fields are tolerated, and a malformed line
// never aborts a file. If a tool changes its format, sessions degrade (less metadata) rather than vanish.

export interface SessionAgg {
  title?: string;
  projectPath?: string;
  gitBranch?: string;
  model?: string;
  cliVersion?: string;
  createdAt?: string;
  lastActivityAt?: string;
  messageCount: number;
  firstUser?: string;
  lastUser?: string;
  /** Timestamp of the latest real prompt: the start of the current/last turn. */
  lastUserAt?: string;
  lastAssistant?: string;
  /** Codex only: whether a turn is in flight according to the transcript. */
  taskState?: "running" | "idle";
}

export const emptyAgg = (): SessionAgg => ({ messageCount: 0 });

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Text that tools inject into the "user" role but that the person never typed. */
const INJECTED = /^\s*(<(local-command|command-name|command-message|system-reminder|environment_context|user_instructions|user-prompt-submit-hook)|# AGENTS\.md|\[Request interrupted|Caveat:)/i;

function bump(agg: SessionAgg, ts: unknown): void {
  if (typeof ts !== "string") return;
  agg.createdAt ??= ts;
  if (!agg.lastActivityAt || ts > agg.lastActivityAt) agg.lastActivityAt = ts;
}

/* ---------------- Claude Code ---------------- */

/** Applies one JSONL line from ~/.claude/projects/<project>/<session>.jsonl. */
export function applyClaudeLine(agg: SessionAgg, line: any): void {
  if (!line || typeof line !== "object") return;
  switch (line.type) {
    case "ai-title":
      if (typeof line.aiTitle === "string" && line.aiTitle.trim()) agg.title = oneLine(line.aiTitle);
      return;
    case "user":
    case "assistant":
    case "system":
    case "attachment":
      break;
    default:
      return;
  }
  if (line.isSidechain) return; // sub-agent chatter belongs to the parent session
  bump(agg, line.timestamp);
  if (typeof line.cwd === "string" && line.cwd) agg.projectPath ??= line.cwd;
  if (typeof line.gitBranch === "string" && line.gitBranch) agg.gitBranch = line.gitBranch;
  if (typeof line.version === "string") agg.cliVersion = line.version;

  if (line.type === "user") {
    const text = claudeUserText(line.message?.content);
    if (text && !INJECTED.test(text)) {
      agg.messageCount++;
      agg.firstUser ??= clip(oneLine(text), 200);
      agg.lastUser = clip(oneLine(text), 300);
      if (typeof line.timestamp === "string") agg.lastUserAt = line.timestamp;
    }
  } else if (line.type === "assistant") {
    const m = line.message;
    if (typeof m?.model === "string" && m.model !== "<synthetic>") agg.model = m.model;
    const text = claudeAssistantText(m?.content);
    if (text) {
      agg.messageCount++;
      agg.lastAssistant = clip(oneLine(text), 400);
    }
  }
}

function claudeUserText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((b) => b?.type === "tool_result")) return undefined; // tool plumbing, not a prompt
  const parts = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  return parts.length ? parts.join("\n") : undefined;
}

function claudeAssistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return typeof content === "string" ? content : undefined;
  const parts = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  return parts.length ? parts.join("\n") : undefined;
}

/* ---------------- Codex ---------------- */

/** Applies one JSONL line from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. */
export function applyCodexLine(agg: SessionAgg, line: any): void {
  if (!line || typeof line !== "object") return;
  bump(agg, line.timestamp);
  const p = line.payload;
  if (!p || typeof p !== "object") return;

  switch (line.type) {
    case "session_meta":
      if (typeof p.cwd === "string") agg.projectPath ??= p.cwd;
      if (typeof p.cli_version === "string") agg.cliVersion = p.cli_version;
      if (typeof p.timestamp === "string") agg.createdAt = p.timestamp;
      if (typeof p.git?.branch === "string") agg.gitBranch = p.git.branch;
      return;
    case "turn_context":
      if (typeof p.model === "string") agg.model = p.model;
      if (typeof p.cwd === "string") agg.projectPath ??= p.cwd;
      return;
    case "event_msg":
      if (p.type === "task_started") agg.taskState = "running";
      else if (p.type === "task_complete" || p.type === "turn_aborted") agg.taskState = "idle";
      return;
    case "response_item": {
      if (p.type !== "message") return;
      const text = codexText(p.content);
      if (!text) return;
      if (p.role === "user" && !INJECTED.test(text)) {
        agg.messageCount++;
        agg.firstUser ??= clip(oneLine(text), 200);
        agg.lastUser = clip(oneLine(text), 300);
        if (typeof line.timestamp === "string") agg.lastUserAt = line.timestamp;
      } else if (p.role === "assistant") {
        agg.messageCount++;
        agg.lastAssistant = clip(oneLine(text), 400);
      }
      return;
    }
    default:
      return;
  }
}

function codexText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((b) => (b?.type === "input_text" || b?.type === "output_text" || b?.type === "text") && typeof b.text === "string")
    .map((b) => b.text as string);
  return parts.length ? parts.join("\n") : undefined;
}

/** Fallback title when the tool recorded none. */
export function fallbackTitle(agg: SessionAgg, projectName?: string): string {
  return agg.title ?? (agg.firstUser ? clip(agg.firstUser, 80) : projectName ?? "Untitled session");
}
