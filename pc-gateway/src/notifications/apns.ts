import crypto from "node:crypto";
import http2 from "node:http2";

export type ApnsEnvironment = "sandbox" | "production";
export type ApnsKind = "alert" | "voip";

export interface ApnsConfig {
  /** Contents of the .p8 auth key from the Apple developer portal. Never commit it. */
  keyPem: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. VoIP pushes go to "<bundleId>.voip". */
  bundleId: string;
  /** Overridable so tests can point at a local server. */
  endpoints?: Record<ApnsEnvironment, string>;
  now?: () => number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface ApnsRequest {
  token: string;
  environment: ApnsEnvironment;
  kind: ApnsKind;
  payload: Record<string, unknown>;
  /** 10 = deliver now (default), 5 = conserve power. VoIP is always 10. */
  priority?: 5 | 10;
  /** A later push with the same id replaces an earlier undelivered one. */
  collapseId?: string;
  /** Seconds the push may wait for a device that is offline. Calls use 0: a stale call is worse than none. */
  ttlSeconds?: number;
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  /** The token is dead (uninstalled, wrong environment, rotated): stop using it. */
  invalidToken: boolean;
}

const APPLE = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} satisfies Record<ApnsEnvironment, string>;

/** Apple rejects provider tokens older than an hour and dislikes refreshes more often than every 20 minutes. */
const JWT_TTL_MS = 40 * 60_000;

const TOKEN_DEAD_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);

/**
 * Sends pushes to Apple (HTTP/2 + a signed JWT), nothing else. Knows nothing about Helix concepts:
 * the notifiers decide what to send and to whom.
 */
export class ApnsClient {
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private jwt?: { value: string; issuedAt: number };
  private readonly endpoints: Record<ApnsEnvironment, string>;
  private readonly now: () => number;

  constructor(private readonly cfg: ApnsConfig) {
    this.endpoints = cfg.endpoints ?? APPLE;
    this.now = cfg.now ?? (() => Date.now());
    // Fail at startup, not at the first alert, if the key is not a usable EC private key.
    crypto.createPrivateKey(cfg.keyPem);
  }

  get bundleId(): string {
    return this.cfg.bundleId;
  }

  async send(req: ApnsRequest): Promise<ApnsResult> {
    const attempts = req.kind === "voip" ? 1 : 3;
    let last: ApnsResult = { ok: false, status: 0, reason: "not sent", invalidToken: false };
    for (let i = 0; i < attempts; i++) {
      last = await this.once(req);
      const retryable = last.status === 0 || last.status === 429 || last.status >= 500;
      if (last.ok || !retryable) return last;
      await new Promise((r) => setTimeout(r, (this.cfg.retryDelayMs ?? 500) * (i + 1)));
    }
    return last;
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  /* ---------------- internals ---------------- */

  private providerToken(): string {
    const now = this.now();
    if (this.jwt && now - this.jwt.issuedAt < JWT_TTL_MS) return this.jwt.value;
    const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
    const head = b64({ alg: "ES256", kid: this.cfg.keyId });
    const claims = b64({ iss: this.cfg.teamId, iat: Math.floor(now / 1000) });
    // JWT wants the raw r||s signature, not DER.
    const sig = crypto.sign("sha256", Buffer.from(`${head}.${claims}`), { key: this.cfg.keyPem, dsaEncoding: "ieee-p1363" });
    this.jwt = { value: `${head}.${claims}.${sig.toString("base64url")}`, issuedAt: now };
    return this.jwt.value;
  }

  private session(origin: string): http2.ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(origin);
    s.on("error", () => this.sessions.delete(origin));
    s.on("close", () => this.sessions.delete(origin));
    s.on("goaway", () => this.sessions.delete(origin));
    s.unref();
    this.sessions.set(origin, s);
    return s;
  }

  private once(req: ApnsRequest): Promise<ApnsResult> {
    return new Promise((resolve) => {
      const done = (r: ApnsResult) => resolve(r);
      let stream: http2.ClientHttp2Stream;
      try {
        const topic = req.kind === "voip" ? `${this.cfg.bundleId}.voip` : this.cfg.bundleId;
        const headers: http2.OutgoingHttpHeaders = {
          ":method": "POST",
          ":path": `/3/device/${req.token}`,
          authorization: `bearer ${this.providerToken()}`,
          "apns-topic": topic,
          "apns-push-type": req.kind === "voip" ? "voip" : "alert",
          "apns-priority": String(req.kind === "voip" ? 10 : req.priority ?? 10),
          // Calls never wait for an offline phone, whatever the caller asked: ringing late is worse than not ringing.
          "apns-expiration": String(req.kind === "voip" || !req.ttlSeconds ? 0 : Math.floor(this.now() / 1000) + req.ttlSeconds),
          "content-type": "application/json",
        };
        if (req.collapseId) headers["apns-collapse-id"] = req.collapseId.slice(0, 64);
        stream = this.session(this.endpoints[req.environment]).request(headers);
      } catch (err) {
        return done({ ok: false, status: 0, reason: err instanceof Error ? err.message : String(err), invalidToken: false });
      }

      let status = 0;
      let apnsId: string | undefined;
      let body = "";
      const timer = setTimeout(() => { stream.close(http2.constants.NGHTTP2_CANCEL); done({ ok: false, status: 0, reason: "timeout", invalidToken: false }); }, this.cfg.timeoutMs ?? 10_000);
      timer.unref();

      stream.on("response", (h) => { status = Number(h[":status"]); apnsId = h["apns-id"] as string | undefined; });
      stream.setEncoding("utf8");
      stream.on("data", (c) => { body += c; });
      stream.on("error", (e) => { clearTimeout(timer); done({ ok: false, status: 0, reason: e.message, invalidToken: false }); });
      stream.on("end", () => {
        clearTimeout(timer);
        let reason: string | undefined;
        try { reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined; } catch { reason = body.slice(0, 100); }
        done({
          ok: status === 200, status, apnsId, reason,
          invalidToken: status === 410 || (status === 400 && !!reason && TOKEN_DEAD_REASONS.has(reason)),
        });
      });
      stream.end(JSON.stringify(req.payload));
    });
  }
}
