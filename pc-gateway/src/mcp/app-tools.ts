// Open and close desktop apps by name, for remote callers (hosted chats). Deliberately narrow:
//  - open: only things in the Start menu (Get-StartApps), matched in code. The name is never put into a shell command;
//    what gets launched is the app id from that list.
//  - close: only apps that have a visible window, and only the polite way (WM_CLOSE, same as clicking the X), so unsaved-work prompts
//    still appear. Never a forced kill. Shells, terminals, editors that host agent sessions, the Helix gateway and
//    Tailscale are never closed, and system apps are never opened.
import { desktop } from "./desktop.js";
import { run } from "./pc-tools.js";

export interface StartApp {
  name: string;
  appId: string;
}

export interface WindowedProcess {
  id: number;
  processName: string;
  title: string;
}

/** Never opened remotely: command shells and machine-administration consoles. */
const BLOCKED_TO_OPEN = [
  /^(command prompt|cmd)$/i, /powershell/i, /^windows terminal$/i, /^terminal$/i, /^pwsh/i, /^windows powershell/i,
  /^registry editor$/i, /^regedit/i, /^task manager$/i, /^services$/i, /^computer management$/i, /^device manager$/i,
  /^disk management$/i, /^local group policy/i, /^group policy/i, /^event viewer$/i, /^windows security$/i, /^system configuration$/i,
  /^component services$/i, /^local security policy$/i, /^windows memory diagnostic$/i, /^resource monitor$/i, /^performance monitor$/i,
  /^iscsi initiator$/i, /^odbc data sources/i, /^print management$/i, /^task scheduler$/i, /^wsl$/i, /^ubuntu/i, /^git bash$/i,
];
export const isBlockedToOpen = (name: string, appId = ""): boolean =>
  BLOCKED_TO_OPEN.some((re) => re.test(name.trim())) || /cmd\.exe|powershell|pwsh\.exe|regedit|taskmgr|mmc\.exe|wt\.exe/i.test(appId);

/** Never closed remotely, by process name. The editors are here because agent sessions run in their terminals. */
const PROTECTED_PROCESSES = new Set([
  "system", "idle", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "svchost", "dwm", "explorer", "fontdrvhost",
  "sihost", "taskhostw", "ctfmon", "searchhost", "startmenuexperiencehost", "shellexperiencehost", "textinputhost",
  "securityhealthsystray", "msmpeng", "taskmgr", "regedit", "mmc",
  "powershell", "pwsh", "cmd", "conhost", "openconsole", "windowsterminal", "wt", "bash", "wsl", "wslhost", "sh", "mintty",
  "node", "claude", "codex", "helix-gateway", "winsw", "tailscale", "tailscaled", "tailscale-ipn",
  "cursor", "code", "code - insiders", "devenv", "idea64", "pycharm64", "webstorm64", "windsurf",
]);
export const isProtectedProcess = (processName: string): boolean => PROTECTED_PROCESSES.has(processName.toLowerCase());

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export type Resolution<T> = { ok: true; match: T } | { ok: false; reason: string; candidates?: string[] };

/** Exact name wins; otherwise a unique partial match; otherwise ask the caller to be more specific. */
export function resolveApp(apps: StartApp[], query: string): Resolution<StartApp> {
  const q = norm(query);
  if (!q) return { ok: false, reason: "no app name given" };
  const exact = apps.filter((a) => norm(a.name) === q);
  if (exact.length === 1) return { ok: true, match: exact[0]! };
  const pool = exact.length > 1 ? exact : apps.filter((a) => norm(a.name).includes(q));
  const names = [...new Set(pool.map((a) => a.name))];
  if (names.length === 1) return { ok: true, match: pool[0]! };
  if (names.length === 0) {
    const close = apps.filter((a) => q.split(" ").some((w) => w.length > 2 && norm(a.name).includes(w))).map((a) => a.name).slice(0, 8);
    return { ok: false, reason: `no app named "${query}" in the Start menu`, candidates: close.length ? close : undefined };
  }
  return { ok: false, reason: `"${query}" matches several apps; say which one`, candidates: names.slice(0, 12) };
}

export async function listStartApps(): Promise<StartApp[]> {
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Sort-Object Name | ConvertTo-Json -Compress"], { timeoutMs: 25_000 });
  if (!r.stdout.trim()) throw new Error(r.stderr || "could not list Start menu apps");
  const parsed = JSON.parse(r.stdout) as { Name: string; AppID: string } | { Name: string; AppID: string }[];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((a) => a.Name && a.AppID).map((a) => ({ name: a.Name, appId: a.AppID }));
}

export interface DesktopOpts {
  dataDir?: string;
}

export async function openApp(query: string, opts: DesktopOpts = {}): Promise<{ opened?: string; error?: string; candidates?: string[] }> {
  const apps = await listStartApps();
  const r = resolveApp(apps, query);
  if (!r.ok) return { error: r.reason, candidates: r.candidates };
  if (isBlockedToOpen(r.match.name, r.match.appId)) return { error: `"${r.match.name}" is a system or administration tool and is not opened remotely` };
  // The id comes from the Start menu list above, never from the caller's text. It runs in the user's own session
  // (see desktop.ts), where the helper checks it against Windows' list again before launching.
  const d = await desktop({ op: "open", appId: r.match.appId }, opts);
  return d.ok ? { opened: r.match.name } : { error: `could not open "${r.match.name}": ${d.error ?? "unknown error"}` };
}

export interface OpenWindow extends WindowedProcess {
  hwnd: number;
}

/** Visible, titled, top-level windows with their owning process. Modern (UWP) apps live in ApplicationFrameHost, so the window title is what identifies them. */
export async function openWindows(opts: DesktopOpts = {}): Promise<OpenWindow[]> {
  const d = await desktop({ op: "windows" }, opts);
  if (!d.ok) throw new Error(d.error ?? "could not list windows");
  return (d.windows ?? []).map((w) => ({ hwnd: w.hwnd, id: w.id, processName: w.processName, title: w.title ?? "" }));
}

/** Pure part of closing: which running windows does this name mean, and is it allowed? */
export function resolveWindows<T extends WindowedProcess>(procs: T[], query: string): Resolution<T[]> {
  const q = norm(query);
  if (!q) return { ok: false, reason: "no app name given" };
  const hits = procs.filter((p) => norm(p.processName) === q || norm(p.processName).includes(q) || norm(p.title).includes(q));
  if (!hits.length) return { ok: false, reason: `no open window matches "${query}"` };
  const blocked = hits.filter((p) => isProtectedProcess(p.processName));
  const allowed = hits.filter((p) => !isProtectedProcess(p.processName));
  if (!allowed.length) return { ok: false, reason: `"${[...new Set(blocked.map((p) => p.processName))].join(", ")}" is protected (shell, terminal, editor hosting agents, system, or Helix itself) and is not closed remotely` };
  // Modern apps all share ApplicationFrameHost, so for those the window title is the identity; for the rest it is the process.
  const kinds = [...new Set(allowed.map((p) => (p.processName.toLowerCase() === "applicationframehost" ? `window:${norm(p.title)}` : p.processName.toLowerCase())))];
  if (kinds.length > 1) return { ok: false, reason: `"${query}" matches several apps; say which one`, candidates: kinds.map((k) => k.replace(/^window:/, "")) };
  return { ok: true, match: allowed };
}

export async function closeApp(query: string, opts: DesktopOpts = {}): Promise<{ closed?: string; windows?: number; stillRunning?: boolean; note?: string; error?: string; candidates?: string[] }> {
  let wins: OpenWindow[];
  try { wins = await openWindows(opts); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const r = resolveWindows(wins, query);
  if (!r.ok) return { error: r.reason, candidates: r.candidates };
  // WM_CLOSE is the same request as clicking the window's X: the app may still ask about unsaved work.
  // Handles are integers taken from the window list above; nothing the caller typed reaches the helper.
  const handles = r.match.map((w) => w.hwnd).filter((h) => Number.isSafeInteger(h) && h > 0);
  const closed = await desktop({ op: "close", hwnds: handles }, opts);
  if (!closed.ok) return { error: closed.error ?? "could not close the window" };
  await new Promise((res) => setTimeout(res, 2000));
  const after = new Set((await openWindows(opts)).map((w) => w.hwnd));
  const still = handles.some((h) => after.has(h));
  const title = r.match[0]!.processName.toLowerCase() === "applicationframehost" ? r.match[0]!.title : r.match[0]!.processName;
  return {
    closed: title, windows: handles.length, stillRunning: still,
    note: still ? "Asked it to close; it is still open, probably waiting for the user (an unsaved-changes prompt). Nothing was force-closed." : undefined,
  };
}
