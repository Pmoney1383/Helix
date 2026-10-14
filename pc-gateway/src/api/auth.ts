import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Db } from "../storage/sqlite.js";
import {
  EMPTY_BODY_SHA256, PersistentNonceStore, type SignatureFailure, checkSignature, enrollmentMessage, isP256PublicKey, sha256Hex, verifySignature,
} from "./device-signing.js";

const PAIRING_TTL_MS = 5 * 60 * 1000;
// No 0/O/1/I/L so a code read aloud or typed from the PC screen isn't misread.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Device {
  id: string;
  name: string;
  /** "ios", "android", "terminal", ... as given at pairing. */
  platform?: string;
  /** The device's signing key (SPKI DER, base64) once it has enrolled one; from then on its requests must be signed. */
  publicKey?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    device?: Device;
    /** SHA-256 hex of the raw body, computed only for requests that carry a signature. */
    rawBodySha256?: string;
  }
}

export interface AuthOptions {
  /** Refuse devices that have no signing key yet (except for enrolling one). Turn on once the phone is enrolled. */
  requireSigning?: boolean;
}

export type KeyEnrollResult = "ok" | "already_enrolled" | "bad_key" | "bad_proof" | "no_such_device" | "pairing_required" | "invalid_pairing_code";

export class AuthService {
  private readonly nonces: PersistentNonceStore;
  private readonly deviceChanged = new Set<(deviceId: string) => void>();
  constructor(private readonly db: Db, private readonly opts: AuthOptions = {}) {
    this.nonces = new PersistentNonceStore(db);
  }

  /** Live connections must stop immediately when their credential's trust changes. */
  onDeviceChanged(listener: (deviceId: string) => void): () => void {
    this.deviceChanged.add(listener);
    return () => { this.deviceChanged.delete(listener); };
  }

  private invalidateDevice(deviceId: string): void {
    for (const listener of this.deviceChanged) {
      try { listener(deviceId); } catch { /* one broken connection must not prevent others being invalidated */ }
    }
  }

  /** Revalidate a connection's authenticated snapshot, without reusing its handshake nonce. */
  isCurrentDevice(device: Device): boolean {
    const row = this.db.prepare("SELECT public_key FROM devices WHERE id = ? AND revoked_at IS NULL").get(device.id) as { public_key: string | null } | undefined;
    return !!row && (row.public_key ?? undefined) === device.publicKey && (!this.requireSigning || !!row.public_key);
  }

  get requireSigning(): boolean {
    return !!this.opts.requireSigning;
  }

  /** Is this key good and does the proof show its owner holds the private half? */
  checkNewKey(publicKey: string, proof: string): "ok" | "bad_key" | "bad_proof" {
    if (!isP256PublicKey(publicKey)) return "bad_key";
    return verifySignature(publicKey, enrollmentMessage(publicKey), proof) ? "ok" : "bad_proof";
  }

  /** Legacy migration needs independent local authorization, just like pairing a new device. */
  enrollKey(deviceId: string, publicKey: string, proof: string, pairingCode?: string): KeyEnrollResult {
    const checked = this.checkNewKey(publicKey, proof);
    if (checked !== "ok") return checked;
    const result = this.db.transaction((): KeyEnrollResult => {
      const row = this.db.prepare("SELECT public_key FROM devices WHERE id = ? AND revoked_at IS NULL").get(deviceId) as { public_key: string | null } | undefined;
      if (!row) return "no_such_device";
      if (row.public_key) return "already_enrolled";
      if (!pairingCode) return "pairing_required";
      const now = new Date().toISOString();
      const claimed = this.db.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
        .run(now, sha256(pairingCode.trim().toUpperCase()), now);
      if (claimed.changes !== 1) return "invalid_pairing_code";
      this.db.prepare("UPDATE devices SET public_key = ?, key_enrolled_at = ? WHERE id = ? AND public_key IS NULL AND revoked_at IS NULL").run(publicKey, now, deviceId);
      this.audit(deviceId, "device.key_enrolled");
      return "ok";
    }).immediate();
    if (result === "ok") this.invalidateDevice(deviceId);
    return result;
  }

  keyStatus(deviceId: string): { enrolled: boolean; enrolledAt?: string; required: boolean } {
    const row = this.db.prepare("SELECT public_key, key_enrolled_at FROM devices WHERE id = ?").get(deviceId) as { public_key: string | null; key_enrolled_at: string | null } | undefined;
    return { enrolled: !!row?.public_key, enrolledAt: row?.key_enrolled_at ?? undefined, required: this.requireSigning };
  }

  /**
   * Is this request allowed to use this device? A device with a signing key must sign every request; a device without one is
   * refused only when signing is required (and then only outside the enrollment call itself).
   */
  verifyRequest(device: Device, req: { method: string; url: string; rawBodySha256?: string; headers: Record<string, string | string[] | undefined> }, allowUnenrolled = false): SignatureFailure | "key_required" | undefined {
    if (device.publicKey) {
      const failure = checkSignature({ method: req.method, url: req.url, deviceId: device.id, actualBodySha256: req.rawBodySha256 ?? EMPTY_BODY_SHA256, headers: req.headers }, device.publicKey, this.nonces);
      if (failure) this.audit(device.id, "device.signature_rejected", { reason: failure, method: req.method, url: req.url.split("?")[0] });
      return failure;
    }
    if (this.requireSigning && !allowUnenrolled) return "key_required";
    return undefined;
  }

  /** Called from the local `npm run pair` CLI only; there is deliberately no HTTP endpoint for it. */
  createPairingCode(): { code: string; expiresAt: string } {
    const bytes = randomBytes(8);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    this.db.prepare("INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)").run(sha256(code), expiresAt);
    return { code, expiresAt };
  }

  /** One-time: a code that is expired or already used yields undefined. */
  completePairing(code: string, deviceName: string, platform?: string, publicKey?: string): { deviceId: string; token: string } | undefined {
    const hash = sha256(code.trim().toUpperCase());
    const now = new Date().toISOString();
    const claimed = this.db
      .prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, hash, now);
    if (claimed.changes !== 1) return undefined;

    const token = randomBytes(32).toString("base64url");
    const deviceId = randomUUID();
    this.db
      .prepare("INSERT INTO devices (id, name, platform, token_hash, created_at, public_key, key_enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(deviceId, deviceName, platform ?? null, sha256(token), now, publicKey ?? null, publicKey ? now : null);
    this.audit(deviceId, "device.paired", { name: deviceName, platform, signed: !!publicKey });
    return { deviceId, token };
  }

  authenticate(token: string | undefined): Device | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare("SELECT id, name, platform, public_key AS publicKey FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(sha256(token)) as (Device & { publicKey: string | null; platform: string | null }) | undefined;
    if (row && row.publicKey === null) delete (row as { publicKey?: string | null }).publicKey;
    if (row && row.platform === null) delete (row as { platform?: string | null }).platform;
    if (row) this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return row;
  }

  revoke(deviceId: string): boolean {
    const revoked = this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), deviceId).changes === 1;
    if (revoked) this.invalidateDevice(deviceId);
    return revoked;
  }

  audit(deviceId: string | undefined, action: string, detail?: unknown): void {
    this.db
      .prepare("INSERT INTO audit_log (ts, device_id, action, detail) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), deviceId ?? null, action, detail === undefined ? null : JSON.stringify(detail));
  }
}

export function bearerToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/**
 * Tailscale Funnel adds this to every request that arrived from the public internet rather than the tailnet. A caller
 * can add it themselves, but that only ever puts them on the stricter, internet side.
 */
export const isPublicInternet = (req: FastifyRequest): boolean => req.headers["tailscale-funnel-request"] !== undefined;

export function requireDevice(auth: AuthService, opts: { allowUnenrolled?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const device = auth.authenticate(bearerToken(req));
    if (!device) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const failure = auth.verifyRequest(device, { method: req.method, url: req.raw.url ?? req.url, rawBodySha256: req.rawBodySha256, headers: req.headers }, opts.allowUnenrolled);
    if (failure) {
      if (failure === "nonce_capacity") reply.header("retry-after", "60");
      await reply.code(failure === "nonce_capacity" ? 429 : 401).send({ error: failure });
      return;
    }
    req.device = device;
  };
}

const MAX_SIGNED_BODY = 8 * 1024 * 1024;

/** Hash the raw body of signed requests (before it is parsed), so the signature can bind to the exact bytes. */
export function registerBodyHashing(app: FastifyInstance): void {
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (!req.headers["x-helix-signature"]) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const b = Buffer.from(chunk as Uint8Array);
      size += b.length;
      if (size > MAX_SIGNED_BODY) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
      chunks.push(b);
    }
    const body = Buffer.concat(chunks);
    req.rawBodySha256 = sha256Hex(body);
    return Readable.from(body.length ? [body] : []);
  });
}

/** Fixed-window limiter, in memory. Enough to make pairing-code guessing hopeless. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Whether `key` still has attempts left, without counting one. */
  peek(key: string): boolean {
    const e = this.hits.get(key);
    return !e || e.resetAt <= Date.now() || e.count < this.max;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    e.count += 1;
    return e.count <= this.max;
  }
}
