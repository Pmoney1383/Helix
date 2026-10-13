import path from "node:path";
import { z } from "zod";

const schema = z.object({
  HELIX_HOST: z.string().default("127.0.0.1"),
  HELIX_PORT: z.coerce.number().int().min(0).max(65535).default(7777),
  HELIX_DATA_DIR: z.string().default("./data"),
  HELIX_DEFAULT_PROJECT: z.string().optional(),
  HELIX_CLAUDE_BIN: z.string().default("claude"),
  // bypassPermissions is deliberately not allowed: Phase 2 builds the approval gate instead.
  HELIX_CLAUDE_PERMISSION_MODE: z.enum(["default", "acceptEdits", "plan"]).default("default"),
  HELIX_CODEX_ENABLED: z.enum(["true", "false"]).default("true"),
  HELIX_CODEX_BIN: z.string().default("codex"),
  HELIX_CODEX_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  // "untrusted" asks about anything not known-safe, which is what lets Helix's gate see destructive commands.
  HELIX_CODEX_APPROVAL: z.enum(["untrusted", "on-request", "never"]).default("untrusted"),
  // Apple push (needed for notifications and calls). All four are required together; otherwise push/call stay off.
  HELIX_APNS_KEY_PATH: z.string().optional(),
  HELIX_APNS_KEY_ID: z.string().optional(),
  HELIX_APNS_TEAM_ID: z.string().optional(),
  HELIX_APNS_BUNDLE_ID: z.string().optional(),
  HELIX_RING_TIMEOUT_SEC: z.coerce.number().min(5).max(120).default(30),
  // An approval nobody answers by push escalates to a phone call after this long (0 = never).
  HELIX_APPROVAL_CALL_AFTER_MIN: z.coerce.number().min(0).max(240).default(5),
  HELIX_PRESENCE_AWAY_MIN: z.coerce.number().min(1).max(240).default(5),
  HELIX_DISCOVERY: z.enum(["true", "false"]).default("true"),
  HELIX_APPROVAL_TTL_MIN: z.coerce.number().min(0.01).max(24 * 60).default(30),
  // Temporary desktop-only testing bypass; all other approval gates remain active.
  HELIX_DESKTOP_APPROVALS: z.enum(["true", "false"]).default("true"),
  HELIX_PUBLIC_URL: z.string().url().optional(),
  HELIX_VIEWER_ICE_SERVERS: z.string().optional(),
  HELIX_VIEWER_CARDS: z.string().optional(),
  // The PC voice (docs/LOCAL-TTS.md). OFF unless enabled; even then it only starts when a voice turn asks for it and stops
  // itself when idle. It refuses to start while the GPU or RAM is busy (for example while a model is training).
  HELIX_TTS_ENABLED: z.enum(["true", "false"]).default("false"),
  HELIX_TTS_ENGINE: z.enum(["qwen3", "qwen3stream", "chatterbox", "fake"]).default("qwen3"),
  HELIX_TTS_WSL_DISTRO: z.string().default("Ubuntu"),
  HELIX_TTS_WSL_PYTHON: z.string().optional(),
  HELIX_TTS_WSL_QWEN_ROOT: z.string().optional(),
  HELIX_TTS_QWEN_ROOT: z.string().optional(),
  HELIX_TTS_PYTHON: z.string().optional(),
  HELIX_TTS_REFERENCE: z.string().optional(),
  HELIX_TTS_HF_HOME: z.string().optional(),
  HELIX_TTS_CLIPS_DIR: z.string().optional(),
  HELIX_TTS_PORT: z.coerce.number().int().min(1024).max(65535).default(7791),
  HELIX_TTS_SMOOTH_HOLD_SEC: z.coerce.number().min(0).max(60).default(12),
  HELIX_REQUIRE_DEVICE_SIGNING: z.enum(["true", "false"]).default("false"),
  HELIX_TTS_WARM_WHEN_AWAY: z.enum(["true", "false"]).default("true"),
  HELIX_TTS_IDLE_SEC: z.coerce.number().int().min(10).max(3600).default(180),
  HELIX_TTS_MIN_FREE_VRAM_MB: z.coerce.number().min(0).default(6000),
  HELIX_TTS_MIN_FREE_RAM_MB: z.coerce.number().min(0).default(4000),
  HELIX_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  publicUrl?: string;
  viewerIceServers?: { urls: string; username?: string; credential?: string }[];
  /** Show a live-desktop card under every computer-use tool call. Off: the Helix Live panel is the only viewer. */
  viewerCards?: boolean;
  defaultProjectPath: string;
  claudeBin: string;
  claudePermissionMode: "default" | "acceptEdits" | "plan";
  approvalTtlMs: number;
  desktopApprovals: boolean;
  codex: { enabled: boolean; bin: string; sandbox: "read-only" | "workspace-write" | "danger-full-access"; approvalPolicy: "untrusted" | "on-request" | "never" };
  apns?: { keyPath: string; keyId: string; teamId: string; bundleId: string };
  ringTimeoutMs: number;
  approvalCallAfterMs: number;
  /** Minutes of keyboard/mouse inactivity before you count as away. */
  presenceAwayMin: number;
  /** Refuse devices that have no signing key enrolled (turn on once the phone is enrolled; see api/device-signing.ts). */
  requireDeviceSigning: boolean;
  /** Index every Claude/Codex session on this machine. */
  discovery: boolean;
  tts: {
    enabled: boolean;
    engine: "qwen3" | "qwen3stream" | "chatterbox" | "fake";
    python?: string;
    reference?: string;
    qwenRoot?: string;
    /** The streaming engine runs inside WSL2: the distro, its python, and the workspace (Linux paths). */
    wsl?: { distro: string; python: string; qwenRoot: string };
    hfHome?: string;
    clipsDir?: string;
    port: number;
    idleSec: number;
    /** Longest the first audio of a spoken reply is held so the rest plays without gaps (0 = play at once). */
    smoothHoldSec?: number;
    /** Keep the voice loaded while the user is away from the PC and the GPU is free (see voice/away-warmer.ts). */
    warmWhenAway?: boolean;
    minFreeVramMb: number;
    minFreeRamMb: number;
  };
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  const dataDir = path.resolve(e.HELIX_DATA_DIR);
  return {
    host: e.HELIX_HOST,
    port: e.HELIX_PORT,
    dataDir,
    dbPath: path.join(dataDir, "helix.db"),
    publicUrl: e.HELIX_PUBLIC_URL?.replace(/\/$/, ""),
    viewerIceServers: parseViewerIceServers(e.HELIX_VIEWER_ICE_SERVERS),
    viewerCards: e.HELIX_VIEWER_CARDS === "true",
    defaultProjectPath: path.resolve(e.HELIX_DEFAULT_PROJECT ?? process.cwd()),
    claudeBin: e.HELIX_CLAUDE_BIN,
    claudePermissionMode: e.HELIX_CLAUDE_PERMISSION_MODE,
    approvalTtlMs: Math.round(e.HELIX_APPROVAL_TTL_MIN * 60_000),
    desktopApprovals: e.HELIX_DESKTOP_APPROVALS === "true",
    codex: { enabled: e.HELIX_CODEX_ENABLED === "true", bin: e.HELIX_CODEX_BIN, sandbox: e.HELIX_CODEX_SANDBOX, approvalPolicy: e.HELIX_CODEX_APPROVAL },
    apns: e.HELIX_APNS_KEY_PATH && e.HELIX_APNS_KEY_ID && e.HELIX_APNS_TEAM_ID && e.HELIX_APNS_BUNDLE_ID
      ? { keyPath: e.HELIX_APNS_KEY_PATH, keyId: e.HELIX_APNS_KEY_ID, teamId: e.HELIX_APNS_TEAM_ID, bundleId: e.HELIX_APNS_BUNDLE_ID }
      : undefined,
    ringTimeoutMs: Math.round(e.HELIX_RING_TIMEOUT_SEC * 1000),
    approvalCallAfterMs: Math.round(e.HELIX_APPROVAL_CALL_AFTER_MIN * 60_000),
    presenceAwayMin: e.HELIX_PRESENCE_AWAY_MIN,
    requireDeviceSigning: e.HELIX_REQUIRE_DEVICE_SIGNING === "true",
    discovery: e.HELIX_DISCOVERY === "true",
    tts: {
      enabled: e.HELIX_TTS_ENABLED === "true", engine: e.HELIX_TTS_ENGINE, python: e.HELIX_TTS_PYTHON, reference: e.HELIX_TTS_REFERENCE, qwenRoot: e.HELIX_TTS_QWEN_ROOT,
      wsl: e.HELIX_TTS_WSL_PYTHON && e.HELIX_TTS_WSL_QWEN_ROOT ? { distro: e.HELIX_TTS_WSL_DISTRO, python: e.HELIX_TTS_WSL_PYTHON, qwenRoot: e.HELIX_TTS_WSL_QWEN_ROOT } : undefined,
      hfHome: e.HELIX_TTS_HF_HOME, clipsDir: e.HELIX_TTS_CLIPS_DIR, port: e.HELIX_TTS_PORT, idleSec: e.HELIX_TTS_IDLE_SEC, smoothHoldSec: e.HELIX_TTS_SMOOTH_HOLD_SEC, warmWhenAway: e.HELIX_TTS_WARM_WHEN_AWAY === "true",
      minFreeVramMb: e.HELIX_TTS_MIN_FREE_VRAM_MB, minFreeRamMb: e.HELIX_TTS_MIN_FREE_RAM_MB,
    },
    logLevel: e.HELIX_LOG_LEVEL,
  };
}

function parseViewerIceServers(value?: string): Config["viewerIceServers"] {
  if (!value) return undefined;
  try { return z.array(z.object({ urls: z.string().regex(/^(stun|stuns|turn|turns):/), username: z.string().optional(), credential: z.string().optional() })).max(8).parse(JSON.parse(value)); }
  catch { throw new Error("HELIX_VIEWER_ICE_SERVERS must be a JSON array of STUN/TURN server objects."); }
}

/** Load .env if present (Node 20.12+). Missing file is fine. */
export function loadDotEnv(file = ".env"): void {
  try {
    process.loadEnvFile(file);
  } catch {
    /* no .env */
  }
}
