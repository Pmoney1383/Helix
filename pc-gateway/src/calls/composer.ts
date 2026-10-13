/** Wording for calls: short sentences meant to be spoken aloud, assembled deterministically (no model involved). */

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/**
 * "shell: rm -rf checkpoints/old  [atlas]" -> "run the command rm -rf checkpoints/old in atlas".
 * Approval summaries are written for the app's card; this turns them into something a voice can say.
 */
export function describeForSpeech(summary: string): string {
  const project = /\s\[([^\]]+)\]\s*$/.exec(summary)?.[1];
  const body = summary.replace(/\s*\[[^\]]+\]\s*$/, "").trim();
  const m = /^([A-Za-z_]+):\s*(.+)$/s.exec(body);
  const tool = m?.[1]?.toLowerCase();
  const rest = m?.[2] ?? body;
  let what: string;
  if (tool === "shell" || tool === "bash" || tool === "powershell" || tool === "run_command") what = `run the command ${clip(rest, 160)}`;
  else if (tool === "delete_file") what = `delete files: ${clip(rest.replace(/^\{?"?paths"?:?\s*/i, ""), 160)}`;
  else if (tool && tool.startsWith("mcp__")) what = `use the ${tool.split("__").slice(1).join(" ")} tool`;
  else what = clip(body, 180);
  return project ? `${what}, in ${project}` : what;
}

export function approvalScript(summary: string): string {
  return `Claude needs your approval to ${describeForSpeech(summary)}. Say approve to allow it, or reject to stop it.`;
}

export function eventScript(title: string, detail: string, flavor: { opener?: string; closer?: string } = {}): string {
  const first = detail.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  const sentence = first ? `${title}. ${clip(first, 200)}` : title;
  const body = `${flavor.opener ? `${flavor.opener} ` : ""}${sentence.replace(/\.+$/, "")}.`;
  return `${body}${flavor.closer ? ` ${flavor.closer}` : ""} What would you like to do?`;
}

/**
 * Background for the General Claude when the user answers a call about an event. The phone has already spoken
 * `script` to them, so this rides along with their FIRST reply instead of making the router talk first.
 */
export function conversationPrimer(c: { title: string; summary: string; script: string; relatedSessionId?: string; relatedTitle?: string }): string {
  return [
    "[Helix call] You phoned the user about something. This paragraph is from Helix, not from the user.",
    `Reason for the call: ${c.title}${c.summary ? `. ${clip(c.summary, 600)}` : ""}`,
    `The phone already told them: "${c.script}". Do not repeat it; respond to what they say next.`,
    c.relatedSessionId ? `The session involved is "${c.relatedTitle ?? "unknown"}" (Helix session id ${c.relatedSessionId}); you can hand the conversation to it.` : "",
  ].filter(Boolean).join("\n");
}
