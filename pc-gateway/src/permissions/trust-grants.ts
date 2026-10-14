import { randomUUID } from "node:crypto";
import type { Db } from "../storage/sqlite.js";

/** The longest a grant may last. Asking again after a working day is the point. */
export const MAX_TRUST_MINUTES = 8 * 60;

/** What an approval offers to trust when it is approved with `trustForMin`. */
export interface TrustOffer {
  /** The hosted connector (OAuth client id, or the token id of a manual hosted token). */
  connectorId: string;
  connectorName: string;
  /** The agent session, as a `<provider>:<id>` key (or `helix:<id>` for a Helix session not yet started). */
  target: string;
  targetTitle: string;
  maxMinutes: number;
}

export interface TrustGrant {
  id: string;
  connectorId: string;
  connectorName: string;
  target: string;
  targetTitle: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  grantedBy?: string;
  approvalId?: string;
}

interface Row {
  id: string; connector_id: string; connector_name: string; target: string; target_title: string;
  created_at: string; expires_at: string; revoked_at: string | null; granted_by: string | null; approval_id: string | null;
}

const toGrant = (r: Row): TrustGrant => ({
  id: r.id, connectorId: r.connector_id, connectorName: r.connector_name, target: r.target, targetTitle: r.target_title,
  createdAt: r.created_at, expiresAt: r.expires_at, revoked: !!r.revoked_at, grantedBy: r.granted_by ?? undefined, approvalId: r.approval_id ?? undefined,
});

/**
 * Explicit, time-limited trust: while a grant is live, one hosted connector may message one agent session without a phone
 * approval for each message. Grants are only ever created by the owner (approving with "trust for N minutes" on the phone,
 * or the local CLI); nothing a model sends can create, extend or widen one.
 */
export class TrustGrants {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  grant(g: { connectorId: string; connectorName: string; target: string; targetTitle: string; minutes: number; grantedBy?: string; approvalId?: string }): TrustGrant {
    const minutes = Math.min(Math.max(Math.round(g.minutes), 1), MAX_TRUST_MINUTES);
    const id = randomUUID();
    const created = new Date(this.now());
    this.db.prepare(`INSERT INTO trust_grants (id, connector_id, connector_name, target, target_title, created_at, expires_at, granted_by, approval_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, g.connectorId, g.connectorName, g.target, g.targetTitle, created.toISOString(),
        new Date(created.getTime() + minutes * 60_000).toISOString(), g.grantedBy ?? null, g.approvalId ?? null);
    return this.get(id)!;
  }

  /** The live grant letting this connector message this session, if any. */
  active(connectorId: string, target: string): TrustGrant | undefined {
    const r = this.db.prepare(`SELECT * FROM trust_grants WHERE connector_id = ? AND target = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY expires_at DESC LIMIT 1`).get(connectorId, target, new Date(this.now()).toISOString()) as Row | undefined;
    return r && toGrant(r);
  }

  get(id: string): TrustGrant | undefined {
    const r = this.db.prepare("SELECT * FROM trust_grants WHERE id = ?").get(id) as Row | undefined;
    return r && toGrant(r);
  }

  /** Live grants, soonest to expire first. */
  list(): TrustGrant[] {
    return (this.db.prepare("SELECT * FROM trust_grants WHERE revoked_at IS NULL AND expires_at > ? ORDER BY expires_at")
      .all(new Date(this.now()).toISOString()) as Row[]).map(toGrant);
  }

  revoke(id: string): boolean {
    return this.db.prepare("UPDATE trust_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date(this.now()).toISOString(), id).changes === 1;
  }

  /** Revoking a connector's credentials also ends every grant it holds. Without an id: every grant. */
  revokeConnector(connectorId?: string): number {
    const now = new Date(this.now()).toISOString();
    return connectorId
      ? this.db.prepare("UPDATE trust_grants SET revoked_at = ? WHERE connector_id = ? AND revoked_at IS NULL").run(now, connectorId).changes
      : this.db.prepare("UPDATE trust_grants SET revoked_at = ? WHERE revoked_at IS NULL").run(now).changes;
  }
}
