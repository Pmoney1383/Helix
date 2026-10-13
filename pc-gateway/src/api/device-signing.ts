// Device-key request signing. A paired phone holds a private key that never leaves it (Secure Enclave); once the gateway knows the
// public half, every request must carry a signature made with it, so a stolen bearer token alone is no longer enough.
//
// Algorithm: ECDSA P-256 with SHA-256 (what the Secure Enclave and CryptoKit provide).
//   public key:  SPKI DER, base64  (CryptoKit: P256.Signing.PublicKey.derRepresentation)
//   signature:   raw r||s (64 bytes, CryptoKit rawRepresentation) or DER, base64
// Headers on every request (and on the WebSocket upgrade):
//   X-Helix-Timestamp   unix time in milliseconds
//   X-Helix-Nonce       16 to 64 characters of A-Z a-z 0-9 _ -, never reused
//   X-Helix-Body-SHA256 lowercase hex SHA-256 of the exact request body bytes (of the empty string when there is no body)
//   X-Helix-Signature   base64 signature of the signing string below
// Signing string: these seven lines joined by "\n" (no trailing newline):
//   HELIX-SIGN-V1 / METHOD (upper case) / URL as sent (path and query) / timestamp / nonce / body sha256 / device id
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

export const SIGN_VERSION = "HELIX-SIGN-V1";
export const ENROLL_PREFIX = "helix-enroll-v1\n";
export const SKEW_MS = 120_000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
export const EMPTY_BODY_SHA256 = sha256Hex("");

export function signingString(p: { method: string; url: string; timestamp: string; nonce: string; bodySha256: string; deviceId: string }): string {
  return [SIGN_VERSION, p.method.toUpperCase(), p.url, p.timestamp, p.nonce, p.bodySha256, p.deviceId].join("\n");
}

/** The text a new key signs to prove its owner holds the private half (checked when the key is enrolled). */
export const enrollmentMessage = (publicKeyB64: string): string => ENROLL_PREFIX + publicKeyB64;

/** Is this a P-256 public key in SPKI DER form? */
export function isP256PublicKey(publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

/** Verify an ECDSA P-256 signature (raw 64-byte or DER). Never throws. */
export function verifySignature(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    const sig = Buffer.from(signatureB64, "base64");
    return cryptoVerify("sha256", Buffer.from(message, "utf8"), { key, dsaEncoding: sig.length === 64 ? "ieee-p1363" : "der" }, sig);
  } catch {
    return false;
  }
}

/** Remembers recent nonces so a captured signed request cannot be replayed. Memory only: it is short-lived by design. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 2 * SKEW_MS + 60_000, private readonly max = 20_000) {}

  /** True the first time a nonce is used by a device, false if it was already seen. */
  use(deviceId: string, nonce: string, now = Date.now()): boolean {
    this.prune(now);
    const k = `${deviceId}:${nonce}`;
    if (this.seen.has(k)) return false;
    this.seen.set(k, now + this.ttlMs);
    return true;
  }

  private prune(now: number): void {
    if (this.seen.size < this.max) {
      for (const [k, exp] of this.seen) { if (exp > now) break; this.seen.delete(k); } // oldest first: insertion order
      return;
    }
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    while (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value as string);
  }
}

export type SignatureFailure = "signature_required" | "bad_timestamp" | "bad_nonce" | "replayed" | "body_mismatch" | "bad_signature";

export interface SignedRequest {
  method: string;
  url: string;
  deviceId: string;
  /** SHA-256 hex of the body bytes the server actually received. */
  actualBodySha256: string;
  headers: Record<string, string | string[] | undefined>;
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Check the four headers against a device's public key. Returns undefined when the request is properly signed. */
export function checkSignature(req: SignedRequest, publicKeyB64: string, nonces: NonceCache, now = Date.now(), skewMs = SKEW_MS): SignatureFailure | undefined {
  const timestamp = one(req.headers["x-helix-timestamp"]);
  const nonce = one(req.headers["x-helix-nonce"]);
  const bodySha256 = one(req.headers["x-helix-body-sha256"])?.toLowerCase();
  const signature = one(req.headers["x-helix-signature"]);
  if (!timestamp || !nonce || !bodySha256 || !signature) return "signature_required";
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > skewMs) return "bad_timestamp";
  if (!NONCE_RE.test(nonce)) return "bad_nonce";
  if (bodySha256 !== req.actualBodySha256) return "body_mismatch";
  const message = signingString({ method: req.method, url: req.url, timestamp, nonce, bodySha256, deviceId: req.deviceId });
  if (!verifySignature(publicKeyB64, message, signature)) return "bad_signature";
  // Only a request that is otherwise valid may use up a nonce, so junk cannot fill the cache.
  if (!nonces.use(req.deviceId, nonce, now)) return "replayed";
  return undefined;
}
