import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "../storage/sqlite.js";
import type { AgentMessage, AgentSession, ProviderName, SessionStatus } from "../types.js";

interface SessionRow {
  id: string;
  provider: ProviderName;
  provider_session_id: string;
  title: string;
  project_path: string | null;
  project_name: string | null;
  status: SessionStatus;
  managed: number;
  turn_count: number;
  role: "agent" | "router";
  fork_from: string | null;
  tags: string;
  created_at: string;
  last_activity_at: string;
}

const toSession = (r: SessionRow): AgentSession => ({
  id: r.id,
  provider: r.provider,
  providerSessionId: r.provider_session_id,
  title: r.title,
  projectPath: r.project_path ?? undefined,
  projectName: r.project_name ?? undefined,
  status: r.status,
  managed: r.managed === 1,
  turnCount: r.turn_count,
  role: r.role ?? "agent",
  forkFrom: r.fork_from ?? undefined,
  tags: JSON.parse(r.tags) as string[],
  createdAt: r.created_at,
  lastActivityAt: r.last_activity_at,
});

export interface NewSession {
  provider: ProviderName;
  providerSessionId: string;
  title: string;
  projectPath?: string;
  /** Imported sessions already have history, so the first send must resume. */
  imported?: boolean;
  /** Branch from this provider session on the first turn (providerSessionId is the new branch). */
  forkFrom?: string;
  role?: "agent" | "router";
  /** Pre-allocated id (a Codex router needs its credential, which names the session, before the thread exists). */
  id?: string;
}

export class SessionRegistry {
  constructor(private readonly db: Db) {}

  create(n: NewSession): AgentSession {
    const now = new Date().toISOString();
    const id = n.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, provider, provider_session_id, title, project_path, project_name,
                               status, managed, turn_count, fork_from, role, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, n.provider, n.providerSessionId, n.title,
        n.projectPath ?? null,
        n.projectPath ? path.basename(n.projectPath) : null,
        n.imported ? 0 : 1,
        n.imported ? 1 : 0,
        n.forkFrom ?? null,
        n.role ?? "agent",
        now, now
      );
    return this.mustGet(id);
  }

  get(id: string): AgentSession | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return r && toSession(r);
  }

  mustGet(id: string): AgentSession {
    const s = this.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    return s;
  }

  /** Router sessions are plumbing for the phone's front door; they are left out unless asked for. */
  list(opts: { includeRouters?: boolean } = {}): AgentSession[] {
    const where = opts.includeRouters ? "" : "WHERE role != 'router'";
    return (this.db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity_at DESC`).all() as SessionRow[]).map(toSession);
  }

  findByProviderId(provider: ProviderName, providerSessionId: string): AgentSession | undefined {
    const r = this.db
      .prepare("SELECT * FROM sessions WHERE provider = ? AND provider_session_id = ?")
      .get(provider, providerSessionId) as SessionRow | undefined;
    return r && toSession(r);
  }

  setStatus(id: string, status: SessionStatus): AgentSession {
    this.db.prepare("UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return this.mustGet(id);
  }

  completeTurn(id: string, status: SessionStatus): AgentSession {
    this.db
      .prepare("UPDATE sessions SET status = ?, turn_count = turn_count + 1, fork_from = NULL, last_activity_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return this.mustGet(id);
  }

  /** After a crash/restart nothing is really running; anything marked running was cut off. */
  recoverInterrupted(): number {
    return this.db.prepare("UPDATE sessions SET status = 'idle' WHERE status = 'running'").run().changes;
  }
}

interface MessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  session_id: string | null;
  provider: ProviderName | null;
  sender: AgentMessage["sender"];
  type: AgentMessage["type"];
  severity: AgentMessage["severity"];
  text: string;
  metadata: string | null;
  created_at: string;
}

const toMessage = (r: MessageRow): AgentMessage => ({
  seq: r.seq,
  id: r.id,
  conversationId: r.conversation_id,
  sessionId: r.session_id ?? undefined,
  provider: r.provider ?? undefined,
  sender: r.sender,
  type: r.type,
  severity: r.severity,
  text: r.text,
  createdAt: r.created_at,
  metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
});

export type NewMessage = Pick<AgentMessage, "conversationId" | "sender" | "text"> &
  Partial<Pick<AgentMessage, "sessionId" | "provider" | "type" | "severity" | "metadata">>;

export class MessageStore {
  constructor(private readonly db: Db) {}

  add(m: NewMessage): AgentMessage {
    const id = randomUUID();
    const info = this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, session_id, provider, sender, type, severity, text, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, m.conversationId, m.sessionId ?? null, m.provider ?? null, m.sender,
        m.type ?? "text", m.severity ?? "info", m.text,
        m.metadata ? JSON.stringify(m.metadata) : null,
        new Date().toISOString()
      );
    return toMessage(
      this.db.prepare("SELECT * FROM messages WHERE seq = ?").get(info.lastInsertRowid) as MessageRow
    );
  }

  /** One merged, ordered history across several conversations (a routed chat spans every session it visited). */
  listMany(conversationIds: string[], afterSeq = 0, limit = 200): AgentMessage[] {
    if (conversationIds.length === 0) return [];
    const marks = conversationIds.map(() => "?").join(",");
    return (
      this.db
        .prepare(`SELECT * FROM messages WHERE conversation_id IN (${marks}) AND seq > ? ORDER BY seq ASC LIMIT ?`)
        .all(...conversationIds, afterSeq, limit) as MessageRow[]
    ).map(toMessage);
  }

  list(conversationId: string, afterSeq = 0, limit = 200): AgentMessage[] {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
        .all(conversationId, afterSeq, limit) as MessageRow[]
    ).map(toMessage);
  }
}
