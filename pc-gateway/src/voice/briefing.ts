// Two small, deterministic helpers for the voice experience, built from state the gateway already has (no model call):
//   - hints:  words and names the phone's speech recognizer should expect, so "cat diffusion" is not heard as "cat the fusion"
//   - digest: a short, speakable "what is going on right now", for the first thing said on a call or a "status?" question
import type { Approval } from "../types.js";
import { toSpeech } from "./speech.js";

/** The slice of the gateway these helpers read; kept narrow so they stay easy to test. */
export interface BriefingSources {
  pendingApprovals(): Approval[];
  /** Sessions the gateway is running a turn for right now (titles). */
  workingSessions(): string[];
  /** Claude/Codex sessions open on the PC (titles), from discovery; empty when discovery is off. */
  liveSessions(): string[];
  /** Watches that are currently firing or failing to run. */
  watches(): { name: string; status: "triggered" | "error" }[];
  projects(): string[];
  aliases(): string[];
  recentSessionTitles(): string[];
  watchNames(): string[];
}

const FIXED = [
  "Helix", "Claude", "Codex", "ChatGPT", "General Claude", "Astra", "approve", "reject", "interrupt", "go back", "status",
];

const MAX_HINTS = 100;
const MAX_LEN = 50;

/** Variants a person would say: "cat-diffusion" and "cat_diffusion" are spoken "cat diffusion". */
const spoken = (name: string): string => name.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();

export function buildHints(src: BriefingSources): { strings: string[] } {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    const s = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!s || s.length > MAX_LEN || /^[\d\s.,:/-]+$/.test(s)) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  FIXED.forEach(add);
  // Names the user is most likely to say come first: aliases, projects, then session and watch titles.
  for (const name of [...src.aliases(), ...src.projects()]) { add(name); add(spoken(name)); }
  for (const t of [...src.recentSessionTitles(), ...src.watchNames()]) add(t);
  return { strings: out.slice(0, MAX_HINTS) };
}

/** How serious the digest is: decides how much personality it may carry. */
export type DigestKind = "quiet" | "busy" | "attention" | "urgent";

/** Optional personality for the digest: an opener before the facts, or another way of saying "nothing is going on". */
export type DigestFlavor = (kind: DigestKind) => { opener?: string; quiet?: string };

export interface Digest {
  /** Speak this. */
  spoken: string;
  /** quiet = nothing going on, busy = agents working, attention = a watch needs a look, urgent = an approval is waiting. */
  kind: DigestKind;
  counts: { approvalsPending: number; sessionsWorking: number; sessionsOpen: number; watchesFiring: number; watchesFailing: number };
}

const list = (names: string[], max = 3): string => {
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  const joined = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
  return more > 0 ? `${shown.join(", ")} and ${more} more` : joined;
};
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function buildDigest(src: BriefingSources, flavor?: DigestFlavor): Digest {
  const approvals = src.pendingApprovals();
  const working = src.workingSessions();
  const open = src.liveSessions();
  const firing = src.watches().filter((w) => w.status === "triggered").map((w) => w.name);
  const failing = src.watches().filter((w) => w.status === "error").map((w) => w.name);
  const counts = { approvalsPending: approvals.length, sessionsWorking: working.length, sessionsOpen: open.length, watchesFiring: firing.length, watchesFailing: failing.length };

  const parts: string[] = [];
  // Most urgent first: things waiting on the user, then problems, then activity.
  if (approvals.length) {
    const oldest = [...approvals].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
    parts.push(`${approvals.length} ${plural(approvals.length, "approval is", "approvals are")} waiting for you. The oldest is: ${toSpeech(oldest.summary).slice(0, 140)}`);
  }
  if (firing.length) parts.push(`${firing.length} ${plural(firing.length, "watch is", "watches are")} firing: ${list(firing)}.`);
  if (failing.length) parts.push(`${failing.length} ${plural(failing.length, "watch", "watches")} could not run: ${list(failing)}.`);
  if (working.length) parts.push(`Working right now: ${list(working)}.`);
  if (open.length) parts.push(`${open.length} ${plural(open.length, "agent session is", "agent sessions are")} open on the PC.`);
  const kind: DigestKind = approvals.length ? "urgent" : firing.length || failing.length ? "attention" : working.length || open.length ? "busy" : "quiet";
  const style = flavor?.(kind) ?? {};

  // Personality changes how it is said, never what: the facts above are the same in every mode.
  if (kind === "quiet") parts.push(style.quiet ?? "All quiet. Nothing is running or waiting.");
  else if (style.opener) parts.unshift(style.opener);

  return { spoken: toSpeech(parts.join(" ")), kind, counts };
}
