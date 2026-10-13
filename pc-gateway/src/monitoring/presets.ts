import type { WatchInput } from "./watch-types.js";

/**
 * One call to watch a long-running piece of work, whoever is doing it (you, Claude, Codex) and
 * whatever it is. A profile only supplies sensible default log patterns; everything is overridable.
 */
export type JobProfile = "generic" | "training" | "build" | "tests" | "deploy" | "download";

export interface JobWatchInput {
  name: string;
  profile?: JobProfile;
  pid?: number;
  processName?: string;
  logPath?: string;
  /** Extra regexes that mean "something went wrong" (critical). */
  errorPatterns?: string[];
  /** Extra regexes that mean "finished" (important). */
  donePatterns?: string[];
  /** Alert if the log goes quiet this long. 0 disables. Default 10 min (15 for training). */
  staleAfterMin?: number;
  /** Also watch for the GPU sitting idle (default on for training). */
  watchGpu?: boolean;
  /** Conversation the notifications belong to. */
  sessionId?: string;
  /** Wake this agent session when something important fires, so it can investigate. */
  wakeSessionId?: string;
  wakeInstruction?: string;
  intervalSec?: number;
}

interface Profile {
  critical: string[];
  important: string[];
  done: string[];
  info: string[];
  staleMin: number;
}

const GENERIC: Profile = {
  critical: [
    String.raw`Traceback \(most recent call last\)`,
    String.raw`\b(FATAL|PANIC)\b|panic:`,
    String.raw`segmentation fault|core dumped|access violation`,
    String.raw`out of memory|OutOfMemory|\bOOM\b`,
    String.raw`unhandled (exception|promise ?rejection)`,
  ],
  important: [String.raw`\b(error|exception|failed|failure)\b`],
  done: [
    String.raw`\b(training|build|job|task|process|run|download|deploy(ment)?|tests?|migration) (is |was )?(complete[d]?|finished|done|succe(ss|eded)\w*)\b`,
    String.raw`\ball done\b`,
    String.raw`exit(ed)? with code 0`,
  ],
  info: [],
  staleMin: 10,
};

const PROFILES: Record<JobProfile, Profile> = {
  generic: GENERIC,
  training: {
    ...GENERIC,
    critical: [
      ...GENERIC.critical,
      String.raw`CUDA (error|out of memory)|cuDNN error|NCCL (error|timeout)`,
      String.raw`\bnan\b.*\bloss\b|\bloss\b.*\b(nan|inf)\b`,
      String.raw`RuntimeError|^Killed$`,
    ],
    done: [...GENERIC.done, String.raw`finished training|training (complete|finished|done)|final (checkpoint|model) saved`],
    info: [String.raw`(saved|saving|wrote) (a )?(checkpoint|model)|checkpoint (saved|written)`],
    staleMin: 15,
  },
  build: {
    ...GENERIC,
    critical: [...GENERIC.critical, String.raw`build failed|compilation failed|error TS\d+|could not compile`],
    done: [...GENERIC.done, String.raw`build succeeded|compiled successfully|build complete`],
  },
  tests: {
    ...GENERIC,
    critical: [...GENERIC.critical, String.raw`\b[1-9]\d* (failed|failing)\b|AssertionError|test run failed`],
    done: [...GENERIC.done, String.raw`\b\d+ passed\b|all tests passed`],
  },
  deploy: {
    ...GENERIC,
    critical: [...GENERIC.critical, String.raw`deploy(ment)? (failed|error)|rolling back|rollback`],
    done: [...GENERIC.done, String.raw`deployed|published successfully`],
  },
  download: {
    ...GENERIC,
    critical: [...GENERIC.critical, String.raw`(download|transfer) (failed|error)|connection (reset|refused|timed out)|HTTP (error )?(403|404|5\d\d)`],
    done: [...GENERIC.done, String.raw`download(ed)? (complete|finished)|\b100%`],
  },
};

/** Expands one job description into the individual watches that cover it. */
export function buildJobWatches(i: JobWatchInput): WatchInput[] {
  if (i.pid === undefined && !i.processName && !i.logPath) {
    throw new Error("give at least one of pid, processName or logPath to watch");
  }
  const profile = PROFILES[i.profile ?? "generic"];
  const interval = i.intervalSec ?? 30;
  const wake = i.wakeSessionId ? { sessionId: i.wakeSessionId, instruction: i.wakeInstruction, cooldownMin: 30 } : undefined;
  const out: WatchInput[] = [];

  if (i.pid !== undefined || i.processName) {
    out.push({
      name: `${i.name}: process`, type: "process", intervalSec: interval, severity: "important",
      sessionId: i.sessionId, wake,
      config: { pid: i.pid, name: i.processName, expect: "running" },
    });
  }

  if (i.logPath) {
    const staleMin = i.staleAfterMin ?? profile.staleMin;
    out.push({
      name: `${i.name}: log`, type: "log", intervalSec: interval, severity: "important", sessionId: i.sessionId, wake,
      config: {
        path: i.logPath,
        startAt: "end",
        // Order matters: the first matching pattern wins, so the most severe come first.
        patterns: [
          ...[...profile.critical, ...(i.errorPatterns ?? [])].map((regex) => ({ regex, severity: "critical", label: "error" })),
          ...[...profile.done, ...(i.donePatterns ?? [])].map((regex) => ({ regex, severity: "important", label: "finished" })),
          ...profile.important.map((regex) => ({ regex, severity: "important", label: "problem" })),
          ...profile.info.map((regex) => ({ regex, severity: "info", label: "milestone" })),
        ],
        staleAfterSec: staleMin > 0 ? Math.round(staleMin * 60) : undefined,
        staleSeverity: "important",
      },
    });
  }

  if (i.watchGpu ?? i.profile === "training") {
    out.push({
      name: `${i.name}: GPU`, type: "gpu", intervalSec: Math.max(interval, 30), severity: "important", sessionId: i.sessionId,
      config: { idleBelowPercent: 5, idleForSec: 600, tempAboveC: 88 },
    });
  }
  return out;
}
