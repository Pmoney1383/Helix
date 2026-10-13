import { z } from "zod";

export const SeveritySchema = z.enum(["info", "important", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Per-type configuration. A watch is a cheap deterministic check that runs on a timer; no model is
 * involved unless a watch is explicitly configured to wake an agent when it fires.
 */
export const configSchemas = {
  /** Alert when a process is not running (expect "running") or is running (expect "stopped"). */
  process: z.object({
    pid: z.number().int().positive().optional(),
    name: z.string().min(1).max(100).optional(),
    expect: z.enum(["running", "stopped"]).default("running"),
  }).refine((v) => v.pid !== undefined || v.name !== undefined, { message: "pid or name is required" }),

  /** Tail a log: regexes fire an event per matching new line; optionally alert when the log goes quiet. */
  log: z.object({
    path: z.string().min(1).max(1024),
    patterns: z.array(z.object({
      regex: z.string().min(1).max(300),
      severity: SeveritySchema.default("important"),
      label: z.string().max(80).optional(),
    })).max(30).default([]),
    startAt: z.enum(["end", "start"]).default("end"),
    staleAfterSec: z.number().int().min(10).optional(),
    staleSeverity: SeveritySchema.default("important"),
  }),

  /** exists / missing / modified (fires on every change) / stale (not touched for staleAfterSec). */
  file: z.object({
    path: z.string().min(1).max(1024),
    mode: z.enum(["exists", "missing", "modified", "stale"]),
    staleAfterSec: z.number().int().min(10).optional(),
  }).refine((v) => v.mode !== "stale" || v.staleAfterSec !== undefined, { message: "staleAfterSec is required for mode stale" }),

  /** Run a (non-destructive) PowerShell command; alert when its result is not what you expect. */
  command: z.object({
    command: z.string().min(1).max(5000),
    cwd: z.string().max(1024).optional(),
    timeoutSec: z.number().int().min(1).max(120).default(30),
    expectExitCode: z.number().int().default(0),
    expectStdoutRegex: z.string().max(300).optional(),
  }),

  /** GET a URL; alert after `failAfter` consecutive failures. */
  http: z.object({
    url: z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), { message: "http(s) only" }),
    timeoutSec: z.number().int().min(1).max(60).default(10),
    expectStatus: z.number().int().min(100).max(599).optional(),
    failAfter: z.number().int().min(1).max(10).default(2),
  }),

  /** Alert when the repo's HEAD moves (an agent or person committed) or the branch changes. */
  git: z.object({
    repo: z.string().min(1).max(1024),
    notifyOnCommit: z.boolean().default(true),
    notifyOnBranchChange: z.boolean().default(true),
  }),

  /**
   * Agent activity, event-driven from the gateway's own sessions (Claude now, Codex later).
   * Omit sessionId to cover every session. Fires when a task finishes, fails, stalls, or waits on you.
   */
  session: z.object({
    sessionId: z.string().optional(),
    notifyOnFinish: z.boolean().default(true),
    /** Don't announce quick turns; only tasks that ran at least this long. */
    minDurationSec: z.number().int().min(0).max(86_400).default(120),
    finishSeverity: SeveritySchema.default("important"),
    notifyOnError: z.boolean().default(true),
    errorSeverity: SeveritySchema.default("important"),
    /** The agent is waiting for you (a permission prompt, or idle at its prompt). */
    notifyOnNeedsInput: z.boolean().default(true),
    needsInputSeverity: SeveritySchema.default("important"),
    /** Running but no output or tool activity for this long. */
    stalledAfterSec: z.number().int().min(30).max(86_400).optional(),
    /** An approval request has been waiting this long without an answer. */
    approvalWaitingAfterSec: z.number().int().min(30).max(86_400).optional(),
  }),

  /**
   * Long-running programs that Claude/Codex sessions started (training, builds, downloads, servers): reports when
   * they end. Needs no setup per job; one of these watches the whole machine (see monitoring/agent-processes.ts).
   */
  agentprocs: z.object({
    /** Ignore anything that ran for less than this: short commands are not "work". */
    minRuntimeSec: z.number().int().min(10).max(3600).default(60),
    /** Runs at least this long are announced as important (a push), shorter ones are info. */
    importantAfterSec: z.number().int().min(10).max(86_400).default(300),
    notifyOnStart: z.boolean().default(false),
  }),

  /** GPU health: overheating, VRAM nearly full, or sitting idle (a stalled training run). */
  gpu: z.object({
    tempAboveC: z.number().min(30).max(120).optional(),
    memAbovePercent: z.number().min(1).max(100).optional(),
    idleBelowPercent: z.number().min(0).max(100).optional(),
    idleForSec: z.number().int().min(10).default(600),
  }).refine((v) => v.tempAboveC !== undefined || v.memAbovePercent !== undefined || v.idleBelowPercent !== undefined,
    { message: "set at least one of tempAboveC, memAbovePercent, idleBelowPercent" }),
} as const;

export type WatchType = keyof typeof configSchemas;
export const WATCH_TYPES = Object.keys(configSchemas) as WatchType[];

export interface WakeConfig {
  sessionId: string;
  /** What the agent should do when woken. */
  instruction?: string;
  cooldownMin: number;
}

export interface Watch {
  id: string;
  name: string;
  type: WatchType;
  config: Record<string, any>;
  intervalSec: number;
  /** Severity for level-style conditions (process gone, file stale, command failing, ...). Log patterns carry their own. */
  severity: Severity;
  sessionId?: string;
  enabled: boolean;
  state: Record<string, any>;
  wake?: WakeConfig;
  notifyOnResolve: boolean;
  repeatMin?: number;
  createdAt: string;
  lastCheckedAt?: string;
  lastEventAt?: string;
  lastStatus?: "ok" | "triggered" | "error";
  lastError?: string;
}

export interface WatchEvent {
  id: string;
  watchId: string;
  ts: string;
  kind: "triggered" | "resolved" | "match" | "error";
  severity: Severity;
  summary: string;
  detail?: string;
}

export const WatchInputSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(Object.keys(configSchemas) as [WatchType, ...WatchType[]]),
  config: z.record(z.string(), z.unknown()).default({}),
  intervalSec: z.number().int().min(1).max(86_400).default(30),
  severity: SeveritySchema.default("important"),
  sessionId: z.string().optional(),
  wake: z.object({
    sessionId: z.string(),
    instruction: z.string().max(2000).optional(),
    cooldownMin: z.number().min(1).max(1440).default(30),
  }).optional(),
  notifyOnResolve: z.boolean().default(true),
  repeatMin: z.number().int().min(1).max(1440).optional(),
});
export type WatchInput = z.input<typeof WatchInputSchema>;
