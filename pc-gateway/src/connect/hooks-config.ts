/**
 * Merging Helix's hooks into Claude Code's settings.json without disturbing anything else there.
 * Every entry we add carries the marker in its command, which is how we find (and remove) only our own.
 */
export const HOOK_MARKER = "helix-hook";

export interface HookSpec {
  /** Claude Code hook event name. */
  event: string;
  /** Only run for tools whose name matches (PreToolUse). Omit for events without a tool. */
  matcher?: string;
  timeoutSec: number;
}

/**
 * - Stop / Notification: a turn ended / Claude is waiting on the user.
 * - PreToolUse: the permission gate. Matched to shell, MCP and file-editing tools; reads never pay for it, and an
 *   ordinary edit is answered at once with "no opinion" (only sensitive files wait for the user; see
 *   permissions/sensitive-paths.ts). Its timeout is long because it may wait for the user to answer on their phone.
 */
export const DEFAULT_HOOKS: readonly HookSpec[] = [
  { event: "Stop", timeoutSec: 10 },
  { event: "Notification", timeoutSec: 10 },
  { event: "PreToolUse", matcher: "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*", timeoutSec: 1900 },
];

interface HookCommand { type: string; command: string; timeout?: number; [k: string]: unknown }
interface HookGroup { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown }
type Settings = Record<string, any> & { hooks?: Record<string, HookGroup[]> };

const isOurs = (h: HookCommand) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER);

export function mergeHooks(
  settings: Settings,
  commandFor: (event: string) => string,
  specs: readonly HookSpec[] = DEFAULT_HOOKS
): Settings {
  const out: Settings = structuredClone(settings);
  out.hooks ??= {};
  for (const spec of specs) {
    const groups = (out.hooks[spec.event] ??= []);
    const command = commandFor(spec.event);
    let updated = false;
    for (const g of groups) {
      if (!(g.hooks ?? []).some(isOurs)) continue;
      for (const h of g.hooks ?? []) {
        if (isOurs(h)) { h.command = command; h.timeout = spec.timeoutSec; updated = true; }
      }
      if (spec.matcher !== undefined && (g.hooks ?? []).every(isOurs)) g.matcher = spec.matcher;
    }
    if (!updated) {
      groups.push({
        ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
        hooks: [{ type: "command", command, timeout: spec.timeoutSec }],
      });
    }
  }
  return out;
}

export function removeHooks(settings: Settings): Settings {
  const out: Settings = structuredClone(settings);
  if (!out.hooks) return out;
  for (const [event, groups] of Object.entries(out.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks?.length ?? 0) > 0);
    if (kept.length) out.hooks[event] = kept; else delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

export function installedHookEvents(settings: Settings): string[] {
  return Object.entries(settings.hooks ?? {})
    .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some(isOurs)))
    .map(([event]) => event);
}
