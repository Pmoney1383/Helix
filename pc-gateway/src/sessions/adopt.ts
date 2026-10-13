import fs from "node:fs";
import type { SessionIndexer } from "../discovery/indexer.js";
import type { AgentSession, ProviderName } from "../types.js";
import { GatewayError, type SessionManager } from "./manager.js";

export type AdoptMode = "auto" | "resume" | "fork";

export interface Adopted {
  session: AgentSession;
  /** What actually happened. */
  mode: "resume" | "fork";
  note?: string;
}

/**
 * Brings a session that already exists on this machine (started in a terminal, an IDE, anywhere) under
 * Helix's control so it can be continued from the phone.
 *
 * - resume: continue the very same conversation. Only safe when nothing else has it open: two
 *   processes appending to one transcript would interleave and corrupt the history.
 * - fork: branch from the session's current state into a new session and leave the original alone.
 *   Always safe, including while the original is running in a terminal.
 * - auto (default): fork if the session is open somewhere, otherwise resume.
 */
export async function adoptSession(
  manager: SessionManager,
  indexer: SessionIndexer,
  provider: ProviderName,
  id: string,
  mode: AdoptMode = "auto",
  title?: string
): Promise<Adopted> {
  const info = indexer.get(provider, id);
  if (!info) throw new GatewayError(404, "session not found");
  const projectPath = info.projectPath;
  if (!projectPath || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new GatewayError(400, `the session's project folder no longer exists: ${projectPath ?? "(unknown)"}`);
  }

  const existing = manager.registry.findByProviderId(provider, info.id);
  if (existing && mode !== "fork") return { session: existing, mode: "resume", note: "already managed by Helix" };

  // "Open elsewhere" excludes our own process: a managed session that is merely mid-turn here is not a conflict.
  const openElsewhere = info.live && !(existing && manager.isRunning(existing.id));
  const effective: "resume" | "fork" = mode === "auto" ? (openElsewhere ? "fork" : "resume") : mode;

  if (effective === "resume" && openElsewhere) {
    throw new GatewayError(
      409,
      `This session is open in a terminal (pid ${info.livePid ?? "?"}). Continuing it from here would interleave with that terminal. ` +
        `Fork it instead (mode "fork"), or close the terminal session first.`
    );
  }

  if (effective === "fork") {
    const session = await manager.createSession({ provider, title: title ?? `${info.title} (fork)`, projectPath, forkFrom: info.id });
    return { session, mode: "fork", note: openElsewhere ? "forked because the original is open in a terminal" : undefined };
  }
  const session = await manager.createSession({ provider, title: title ?? info.title, projectPath, providerSessionId: info.id });
  return { session, mode: "resume" };
}
