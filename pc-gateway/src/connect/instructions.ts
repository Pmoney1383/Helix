export const BLOCK_BEGIN = "<!-- helix:begin (managed by `helix connect`; remove with `helix disconnect`) -->";
export const BLOCK_END = "<!-- helix:end -->";

/**
 * Loaded into every Claude Code / Codex session on this PC (user-level CLAUDE.md / AGENTS.md).
 * Kept short on purpose: it costs context in every session. The deterministic safety net is the
 * hooks and process tracking; this just lets a capable agent do the smart part (set up the right
 * watch, say it failed, know when to ask) and answer "do you know Helix?".
 */
export const HELIX_INSTRUCTIONS = `${BLOCK_BEGIN}
## Helix (the user's phone companion)
The user runs Helix on this PC so they can follow and steer agent work from their phone when they are away.
You have a \`helix\` MCP server with: \`watch_job\`, \`create_status_watch\`, \`list_status_watches\`, \`notify_user\`, \`request_user_approval\`.

- **Long-running work** (training, builds, test suites, downloads, deploys, anything over ~2 minutes): right after starting it, call \`watch_job\` with its process id and/or log file so the user is told when it ends or fails. Mention in your reply that you set the watch.
- **When something fails or blocks you**, call \`notify_user\`. Use severity \`important\` for "finished" or "I need your input", and \`critical\` only when work is broken or blocked and they must know NOW (it rings their phone). Routine progress is \`info\`. Say in your reply that you notified them, and only claim it if the tool reported delivery.
- **Before an irreversible action** (deleting data, force-pushing, dropping tables) when the user may be away, use \`request_user_approval\` instead of guessing.
- Helix itself decides whether the user is away and whether to buzz or ring them; you never need to check. A destructive command may pause while the user answers on their phone: that is expected, wait for it.
- If the Helix tools are missing or error, carry on normally. Never block or abandon work because Helix is unavailable.
- If asked about Helix: it is the user's phone app and PC gateway; these tools are how you reach it.
${BLOCK_END}`;

/** Adds the block, or replaces the existing one in place. Idempotent. */
export function upsertBlock(text: string, block: string = HELIX_INSTRUCTIONS): string {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  }
  const body = text.replace(/\s+$/, "");
  return (body ? body + "\n\n" : "") + block + "\n";
}

/** Removes the block and tidies the blank lines around it. */
export function removeBlock(text: string): string {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return text;
  const before = text.slice(0, start).replace(/\s+$/, "");
  const after = text.slice(end + BLOCK_END.length).replace(/^\s+/, "");
  const out = [before, after].filter(Boolean).join("\n\n");
  return out ? out + "\n" : "";
}

export const hasBlock = (text: string): boolean => text.includes(BLOCK_BEGIN) && text.includes(BLOCK_END);
