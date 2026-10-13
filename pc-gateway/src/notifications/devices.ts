import type { Db } from "../storage/sqlite.js";
import type { ApnsEnvironment, ApnsKind } from "./apns.js";

export interface PushToken {
  deviceId: string;
  kind: ApnsKind;
  token: string;
  environment: ApnsEnvironment;
}

/** APNs tokens are hex strings (normally 64 characters; Apple reserves the right to change that). */
export const TOKEN_FORMAT = /^[0-9a-fA-F]{32,200}$/;

/**
 * The phone registers two tokens: a normal push token ("alert") and a PushKit token ("voip", used only to
 * ring the phone). Both belong to a paired device; revoking the device cuts both off.
 */
export class DeviceTokens {
  constructor(private readonly db: Db) {}

  register(deviceId: string, t: { kind: ApnsKind; token: string; environment: ApnsEnvironment; bundleId?: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO push_tokens (device_id, kind, token, environment, bundle_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, kind) DO UPDATE SET token = excluded.token, environment = excluded.environment,
         bundle_id = excluded.bundle_id, updated_at = excluded.updated_at, invalid_at = NULL`
    ).run(deviceId, t.kind, t.token.toLowerCase(), t.environment, t.bundleId ?? null, now, now);
  }

  remove(deviceId: string, kind: ApnsKind): boolean {
    return this.db.prepare("DELETE FROM push_tokens WHERE device_id = ? AND kind = ?").run(deviceId, kind).changes === 1;
  }

  /** Usable tokens of one kind across every active (non-revoked) device. */
  tokensFor(kind: ApnsKind): PushToken[] {
    return (this.db.prepare(
      `SELECT p.device_id AS deviceId, p.kind, p.token, p.environment FROM push_tokens p
         JOIN devices d ON d.id = p.device_id
        WHERE p.kind = ? AND p.invalid_at IS NULL AND d.revoked_at IS NULL`
    ).all(kind) as PushToken[]);
  }

  /** Apple said this token is dead. Keep the row (so the app can see why) but never use it again. */
  invalidate(token: string): void {
    this.db.prepare("UPDATE push_tokens SET invalid_at = ? WHERE token = ?").run(new Date().toISOString(), token.toLowerCase());
  }

  forDevice(deviceId: string): { kind: ApnsKind; environment: ApnsEnvironment; bundleId?: string; updatedAt: string; invalid: boolean }[] {
    return (this.db.prepare("SELECT kind, environment, bundle_id, updated_at, invalid_at FROM push_tokens WHERE device_id = ?").all(deviceId) as any[])
      .map((r) => ({ kind: r.kind, environment: r.environment, bundleId: r.bundle_id ?? undefined, updatedAt: r.updated_at, invalid: !!r.invalid_at }));
  }

  listDevices(): { id: string; name: string; platform?: string; createdAt: string; lastSeenAt?: string; revoked: boolean; tokens: ReturnType<DeviceTokens["forDevice"]> }[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY created_at").all() as any[]).map((d) => ({
      id: d.id, name: d.name, platform: d.platform ?? undefined, createdAt: d.created_at, lastSeenAt: d.last_seen_at ?? undefined,
      revoked: !!d.revoked_at, tokens: this.forDevice(d.id),
    }));
  }
}
