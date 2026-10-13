import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { McpContext, Scope } from "../mcp/scopes.js";
import type { Db } from "../storage/sqlite.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Credentials for agents running on this PC: the user-level MCP server registered in Claude/Codex
 * and the hook script. Distinct from phone device tokens (which cannot call MCP) and from per-turn
 * agent tokens (in-memory, die with the turn). Only a hash is stored; revoke to cut an agent off.
 */
export class LocalTokenService {
  constructor(private readonly db: Db) {}

  create(name: string, scope: Scope = "pc.agent.local", opts: { ttlDays?: number; ttlMs?: number; oauthClientId?: string } = {}): { id: string; token: string; expiresAt?: string } {
    const token = "hxl_" + randomBytes(32).toString("base64url");
    const id = randomUUID();
    const ttl = opts.ttlMs ?? (opts.ttlDays ? opts.ttlDays * 86_400_000 : undefined);
    const expiresAt = ttl ? new Date(Date.now() + ttl).toISOString() : undefined;
    this.db
      .prepare("INSERT INTO local_tokens (id, name, scope, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, scope, sha256(token), new Date().toISOString(), expiresAt ?? null);
    if (opts.oauthClientId) this.db.prepare("UPDATE local_tokens SET oauth_client_id = ? WHERE id = ?").run(opts.oauthClientId, id);
    return { id, token, expiresAt };
  }

  /** MCP context for a presented token, or undefined if unknown/revoked. */
  lookup(token: string | undefined): (McpContext & { tokenId: string }) | undefined {
    if (!token || !token.startsWith("hxl_")) return undefined;
    const row = this.db
      .prepare("SELECT id, name, scope, oauth_client_id FROM local_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      .get(sha256(token), new Date().toISOString()) as { id: string; name: string; scope: Scope; oauth_client_id?: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE local_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    // A connector's access token rotates on every OAuth refresh (about hourly). Desktop control belongs to the connector,
    // or a refresh in the middle of a session turns its own lease into "another session" it can neither use nor stop.
    const desktopIdentity = row.oauth_client_id ?? row.id;
    return { scope: row.scope, actor: `local:${row.name}`, tokenId: row.id, desktopIdentity, desktopAllowed: this.desktopAllowed(desktopIdentity) };
  }

  /** Rechecked during an active desktop lease, so revocation/expiry also stops existing control. */
  desktopAllowed(tokenId: string): boolean {
    if (tokenId.startsWith("hxc_")) {
      // A connector: granted, and still holding at least one live token (revoking its tokens ends control too).
      const c = this.db.prepare(`SELECT c.desktop_allowed AS allowed FROM oauth_clients c WHERE c.client_id = ? AND EXISTS (
        SELECT 1 FROM local_tokens t WHERE t.oauth_client_id = c.client_id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?))`)
        .get(tokenId, new Date().toISOString()) as { allowed: number } | undefined;
      return c?.allowed === 1;
    }
    const r = this.db.prepare(`SELECT CASE WHEN t.oauth_client_id IS NULL THEN t.desktop_allowed ELSE c.desktop_allowed END AS allowed
      FROM local_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.oauth_client_id
      WHERE t.id = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)`)
      .get(tokenId, new Date().toISOString()) as { allowed: number } | undefined;
    return r?.allowed === 1;
  }

  setDesktopAccess(id: string, enabled: boolean): boolean {
    const token = this.db.prepare("SELECT oauth_client_id FROM local_tokens WHERE id = ? AND revoked_at IS NULL").get(id) as { oauth_client_id: string | null } | undefined;
    const client = token?.oauth_client_id ?? (id.startsWith("hxc_") ? id : undefined);
    if (client) return this.db.prepare("UPDATE oauth_clients SET desktop_allowed = ? WHERE client_id = ?").run(enabled ? 1 : 0, client).changes === 1;
    return this.db.prepare("UPDATE local_tokens SET desktop_allowed = ? WHERE id = ? AND revoked_at IS NULL").run(enabled ? 1 : 0, id).changes === 1;
  }

  desktopClients(): { id: string; name: string; enabled: boolean }[] {
    return (this.db.prepare("SELECT client_id, name, desktop_allowed FROM oauth_clients ORDER BY created_at").all() as { client_id: string; name: string; desktop_allowed: number }[])
      .map(r => ({ id: r.client_id, name: r.name, enabled: r.desktop_allowed === 1 }));
  }

  revokeAll(name?: string): number {
    const now = new Date().toISOString();
    return name
      ? this.db.prepare("UPDATE local_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND name = ?").run(now, name).changes
      : this.db.prepare("UPDATE local_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now).changes;
  }

  revoke(id: string): boolean {
    return this.db.prepare("UPDATE local_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id).changes === 1;
  }

  list(): { id: string; name: string; scope: string; createdAt: string; lastUsedAt?: string; expiresAt?: string; revoked: boolean }[] {
    return (this.db.prepare("SELECT * FROM local_tokens ORDER BY created_at").all() as any[]).map((r) => ({
      id: r.id, name: r.name, scope: r.scope, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? undefined, expiresAt: r.expires_at ?? undefined, revoked: !!r.revoked_at,
    }));
  }
}
