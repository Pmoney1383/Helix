import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RateLimiter as RL } from "../api/auth.js";
import { RateLimiter, isPublicInternet } from "../api/auth.js";
import type { LocalTokenService } from "../auth/local-tokens.js";
import type { Db } from "../storage/sqlite.js";

/**
 * A small OAuth 2.1 authorization server so hosted ChatGPT / Claude connectors can authenticate to /mcp the standard way
 * (RFC 9728 protected-resource metadata, RFC 8414 server metadata, RFC 7591 dynamic client registration, PKCE S256).
 *
 * Who approves a connector? You, at the PC: `npm run hosted -- code` prints a one-time code, and the consent page asks
 * for it. Registering a client proves nothing by itself; without a fresh code nobody gets a token.
 * What the token can do is unchanged: scope `pc.hosted` only.
 */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const APPROVAL_CODE_TTL_MS = 10 * 60_000;
const AUTH_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 60 * 86_400_000;
const REQUEST_TTL_MS = 10 * 60_000;
const UNUSED_CLIENT_TTL_MS = 86_400_000;
const MAX_UNUSED_CLIENTS = 100;

export const SCOPE = "pc.hosted";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class OAuthService {
  /** Pending consent screens, keyed by an unguessable id, so the approval POST is bound to the request that was shown. */
  private readonly requests = new Map<string, { clientId: string; redirectUri: string; challenge: string; state?: string; expires: number }>();
  /**
   * Wrong codes across all clients: a ceiling on guessing, however many addresses the guesses come from. Counted
   * separately for the internet (Funnel) and the tailnet, so strangers burning the internet's allowance cannot lock the
   * owner out when they approve from a device on their tailnet.
   */
  private readonly wrongCodes = new RateLimiter(10, APPROVAL_CODE_TTL_MS);

  constructor(private readonly db: Db, private readonly tokens: LocalTokenService) {}

  /* ---- owner approval codes (printed on the PC) ---- */
  createApprovalCode(): { code: string; expiresAt: string } {
    const code = Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const expiresAt = new Date(Date.now() + APPROVAL_CODE_TTL_MS).toISOString();
    this.db.prepare("INSERT INTO oauth_approval_codes (code_hash, expires_at) VALUES (?, ?)").run(sha256(code), expiresAt);
    return { code, expiresAt };
  }

  private consumeApprovalCode(code: string): boolean {
    const now = new Date().toISOString();
    return this.db.prepare("UPDATE oauth_approval_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, sha256(code.trim().toUpperCase().replace(/[\s-]/g, "")), now).changes === 1;
  }

  /* ---- clients ---- */
  registerClient(name: string, redirectUris: string[]): { clientId: string } {
    this.pruneUnusedClients();
    const clientId = "hxc_" + randomUUID();
    this.db.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
      .run(clientId, name, JSON.stringify(redirectUris), new Date().toISOString());
    return { clientId };
  }

  /**
   * Registration is open to the internet (connectors register themselves), so registrations that never led to a
   * sign-in are dropped after a day, and at most MAX_UNUSED_CLIENTS of them are kept. Connectors that ever got a
   * token or desktop access are never touched.
   */
  private pruneUnusedClients(): void {
    const unused = `NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id = c.client_id)
      AND NOT EXISTS (SELECT 1 FROM local_tokens t WHERE t.oauth_client_id = c.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_auth_codes a WHERE a.client_id = c.client_id)
      AND c.desktop_allowed = 0`;
    const cutoff = new Date(Date.now() - UNUSED_CLIENT_TTL_MS).toISOString();
    this.db.prepare(`DELETE FROM oauth_clients WHERE client_id IN (SELECT c.client_id FROM oauth_clients c WHERE c.created_at < ? AND ${unused})`).run(cutoff);
    this.db.prepare(`DELETE FROM oauth_clients WHERE client_id IN (SELECT c.client_id FROM oauth_clients c WHERE ${unused}
      ORDER BY c.created_at DESC LIMIT -1 OFFSET ?)`).run(MAX_UNUSED_CLIENTS - 1);
  }

  client(clientId: string): { name: string; redirectUris: string[] } | undefined {
    const r = this.db.prepare("SELECT name, redirect_uris FROM oauth_clients WHERE client_id = ?").get(clientId) as { name: string; redirect_uris: string } | undefined;
    return r ? { name: r.name, redirectUris: JSON.parse(r.redirect_uris) as string[] } : undefined;
  }

  /* ---- consent requests ---- */
  beginRequest(r: { clientId: string; redirectUri: string; challenge: string; state?: string }): string {
    const now = Date.now();
    for (const [k, v] of this.requests) if (v.expires <= now) this.requests.delete(k);
    const id = b64url(randomBytes(24));
    this.requests.set(id, { ...r, expires: now + REQUEST_TTL_MS });
    return id;
  }
  peekRequest(id: string) {
    const r = this.requests.get(id);
    return r && r.expires > Date.now() ? r : undefined;
  }

  /** Approve with the owner's code; returns the authorization code, or why not. */
  approve(requestId: string, ownerCode: string, from: "internet" | "tailnet" = "tailnet"): { code: string; redirectUri: string; state?: string } | "bad_request" | "bad_code" | "locked" {
    const r = this.peekRequest(requestId);
    if (!r) return "bad_request";
    if (!this.wrongCodes.peek(from)) return "locked";
    if (!this.consumeApprovalCode(ownerCode)) { this.wrongCodes.allow(from); return "bad_code"; }
    this.requests.delete(requestId);
    const code = b64url(randomBytes(32));
    this.db.prepare("INSERT INTO oauth_auth_codes (code_hash, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(code), r.clientId, r.redirectUri, r.challenge, new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString());
    return { code, redirectUri: r.redirectUri, state: r.state };
  }
  deny(requestId: string): { redirectUri: string; state?: string } | undefined {
    const r = this.peekRequest(requestId);
    if (!r) return undefined;
    this.requests.delete(requestId);
    return { redirectUri: r.redirectUri, state: r.state };
  }

  /* ---- token endpoint ---- */
  exchangeCode(p: { code: string; clientId: string; redirectUri: string; verifier: string }): TokenResult | { error: string } {
    const now = new Date().toISOString();
    const row = this.db.prepare("SELECT * FROM oauth_auth_codes WHERE code_hash = ?").get(sha256(p.code)) as
      { client_id: string; redirect_uri: string; code_challenge: string; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.client_id !== p.clientId || row.expires_at <= now) return { error: "invalid_grant" };
    // Single use, even when the rest of the request is wrong: a code that was presented once is burned.
    if (this.db.prepare("UPDATE oauth_auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(now, sha256(p.code)).changes !== 1) return { error: "invalid_grant" };
    if (row.redirect_uri !== p.redirectUri) return { error: "invalid_grant" };
    const expected = Buffer.from(row.code_challenge);
    const actual = Buffer.from(b64url(createHash("sha256").update(p.verifier).digest()));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { error: "invalid_grant" };
    return this.issue(p.clientId);
  }

  refresh(refreshToken: string, clientId: string): TokenResult | { error: string } {
    const now = new Date().toISOString();
    const hash = sha256(refreshToken);
    const row = this.db.prepare("SELECT client_id FROM oauth_refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?").get(hash, now) as { client_id: string } | undefined;
    if (!row || row.client_id !== clientId) return { error: "invalid_grant" };
    this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?").run(now, hash); // rotation: each refresh token works once
    return this.issue(clientId);
  }

  private issue(clientId: string): TokenResult {
    const name = this.client(clientId)?.name ?? "connector";
    const access = this.tokens.create(`hosted:oauth:${name}`, SCOPE, { ttlMs: ACCESS_TTL_MS, oauthClientId: clientId });
    const refresh = "hxr_" + randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO oauth_refresh_tokens (token_hash, client_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(refresh), clientId, new Date().toISOString(), new Date(Date.now() + REFRESH_TTL_MS).toISOString());
    return { access_token: access.token, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: SCOPE };
  }

  /** Cut every connector off: refresh tokens stop working (access tokens are revoked by the caller via LocalTokenService). */
  revokeAll(): number {
    this.db.prepare("UPDATE oauth_clients SET desktop_allowed = 0").run();
    return this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(new Date().toISOString()).changes;
  }
}

export interface TokenResult {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Where this server is reachable from outside: HELIX_PUBLIC_URL, else what the request says. */
export function baseUrl(req: FastifyRequest, publicUrl?: string): string {
  return publicUrl ?? `https://${req.headers.host ?? "localhost"}`;
}

const registerBody = z.object({
  client_name: z.string().max(100).optional(),
  redirect_uris: z.array(z.string().url().max(500)).min(1).max(10),
}).passthrough();

/** https only, except loopback for local tools. */
const redirectOk = (u: string): boolean => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
};

export function registerOAuth(app: FastifyInstance, oauth: OAuthService, publicUrl?: string): void {
  const ipLimiter: RL = new RateLimiter(10, 60_000);
  const registerLimiter: RL = new RateLimiter(20, 60_000);
  // Behind Tailscale every request comes from loopback, so the address alone would make these limits shared by
  // everyone. Keying by where the request came from keeps internet traffic from using up the tailnet's allowance.
  const from = (req: FastifyRequest) => (isPublicInternet(req) ? "internet" : "tailnet");
  const limitKey = (req: FastifyRequest) => `${from(req)}:${req.ip}`;

  // Discovery, registration and token exchange carry no ambient credentials, so browser-based clients may call them
  // cross-origin. (The consent page and /mcp are deliberately not opened up this way.)
  const CORS_PATHS = /^\/(\.well-known\/|oauth\/(register|token)(\?|$))/;
  app.addHook("onRequest", async (req, reply) => {
    if (!CORS_PATHS.test(req.url)) return;
    reply.header("access-control-allow-origin", "*").header("access-control-expose-headers", "www-authenticate");
    if (req.method === "OPTIONS") {
      return reply.code(204)
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-headers", "content-type, authorization, mcp-protocol-version")
        .header("access-control-max-age", "600").send();
    }
  });

  // Token and consent bodies are form-encoded.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const metadata = (req: FastifyRequest) => {
    const base = baseUrl(req, publicUrl);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
    };
  };
  const resource = (req: FastifyRequest) => {
    const base = baseUrl(req, publicUrl);
    return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ["header"] };
  };
  app.get("/.well-known/oauth-authorization-server", async (req) => metadata(req));
  app.get("/.well-known/oauth-authorization-server/*", async (req) => metadata(req));
  app.get("/.well-known/openid-configuration", async (req) => metadata(req));
  app.get("/.well-known/oauth-protected-resource", async (req) => resource(req));
  app.get("/.well-known/oauth-protected-resource/*", async (req) => resource(req));

  app.post("/oauth/register", async (req, reply) => {
    if (!registerLimiter.allow(limitKey(req))) return reply.code(429).send({ error: "too_many_requests" });
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success || !parsed.data.redirect_uris.every(redirectOk)) {
      return reply.code(400).send({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https (or loopback http)" });
    }
    const name = (parsed.data.client_name ?? "connector").slice(0, 100);
    const { clientId } = oauth.registerClient(name, parsed.data.redirect_uris);
    app.log.info({ client: clientId, name, redirectUris: parsed.data.redirect_uris }, "oauth client registered");
    return reply.code(201).send({
      client_id: clientId, client_name: name, redirect_uris: parsed.data.redirect_uris,
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
  });

  // formTarget: the connector's registered redirect origin. Chrome applies form-action to the redirect that follows a
  // form submit, so with only 'self' the 302 back to the app (e.g. chatgpt.com) was silently blocked after Approve.
  const page = (reply: FastifyReply, status: number, body: string, formTarget?: string) =>
    reply.code(status).headers({
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget ? " " + formTarget : ""}; frame-ancestors 'none'`,
    }).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Helix</title>
<style>body{font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem;background:#14110c;color:#f1e6cc}h1{color:#d9a93f;font-size:1.3rem}
input{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin:.5rem 0 1rem;background:#1f1a12;color:inherit;border:1px solid #6b5522;border-radius:.4rem;letter-spacing:.15em;text-transform:uppercase}
button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#d9a93f;color:#14110c;cursor:pointer;margin-right:.5rem}button.n{background:#3a3222;color:#f1e6cc}
.e{color:#ff8a7a}code{color:#d9a93f}</style>${body}`);

  const consent = (reply: FastifyReply, requestId: string, name: string, redirectUri: string, error?: string) =>
    page(reply, error ? 401 : 200, `<h1>Connect "${esc(name)}" to Helix?</h1>
<p>It will be able to inspect this PC and run small, read-only safe commands. It cannot delete or change anything, and cannot read credentials.</p>
<p>It will return to <code>${esc(new URL(redirectUri).host)}</code>.</p>
${error ? `<p class="e">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="req" value="${esc(requestId)}">
<label>Approval code from your PC (<code>npm run hosted -- code</code>)</label>
<input name="code" autocomplete="off" autofocus placeholder="XXXXXXXX">
<button type="submit" name="decision" value="approve">Approve</button><button class="n" type="submit" name="decision" value="deny">Deny</button></form>`,
    new URL(redirectUri).origin);

  const fail = (reply: FastifyReply, msg: string) => page(reply, 400, `<h1>Cannot connect</h1><p>${esc(msg)}</p>`);

  app.get("/oauth/authorize", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const client = q.client_id ? oauth.client(q.client_id) : undefined;
    // Never redirect to an unregistered address: errors about these fields are shown here, not sent anywhere.
    if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return fail(reply, "Unknown connector or redirect address.");
    if (q.response_type !== "code" || !q.code_challenge || q.code_challenge_method !== "S256") return fail(reply, "This connector must use authorization code with PKCE (S256).");
    const id = oauth.beginRequest({ clientId: q.client_id!, redirectUri: q.redirect_uri, challenge: q.code_challenge, state: q.state });
    return consent(reply, id, client.name, q.redirect_uri);
  });

  app.post("/oauth/authorize", async (req, reply) => {
    if (!ipLimiter.allow(limitKey(req))) return reply.code(429).send({ error: "too_many_requests" });
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const requestId = b.req ?? "";
    const pending = oauth.peekRequest(requestId);
    if (!pending) return fail(reply, "This approval request expired. Start the connection again from the app.");
    const back = (params: Record<string, string>, state?: string) => {
      const u = new URL(pending.redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (state) u.searchParams.set("state", state);
      return reply.redirect(u.toString(), 302);
    };
    if (b.decision === "deny") { oauth.deny(requestId); return back({ error: "access_denied" }, pending.state); }
    const result = oauth.approve(requestId, b.code ?? "", from(req));
    if (result === "locked") {
      return fail(reply, from(req) === "internet"
        ? "Too many wrong codes from the internet. Try again in a few minutes, or approve from a device connected to your Tailscale network."
        : "Too many wrong codes. Try again in a few minutes.");
    }
    if (result === "bad_request") return fail(reply, "This approval request expired. Start the connection again from the app.");
    if (result === "bad_code") return consent(reply, requestId, oauth.client(pending.clientId)?.name ?? "connector", pending.redirectUri, "That code is wrong, expired or already used.");
    // Where the browser is sent next, without the code or state, so a stalled connection can be diagnosed from the log.
    const to = new URL(result.redirectUri);
    app.log.info({ client: pending.clientId, redirectTo: to.origin + to.pathname, hasState: !!result.state }, "oauth approved, redirecting");
    return back({ code: result.code }, result.state);
  });

  app.post("/oauth/token", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!ipLimiter.allow("token:" + limitKey(req))) return reply.code(429).send({ error: "too_many_requests" });
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const clientId = b.client_id ?? "";
    let r: TokenResult | { error: string };
    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.redirect_uri || !b.code_verifier || !clientId) return reply.code(400).send({ error: "invalid_request" });
      r = oauth.exchangeCode({ code: b.code, clientId, redirectUri: b.redirect_uri, verifier: b.code_verifier });
    } else if (b.grant_type === "refresh_token") {
      if (!b.refresh_token || !clientId) return reply.code(400).send({ error: "invalid_request" });
      r = oauth.refresh(b.refresh_token, clientId);
    } else {
      return reply.code(400).send({ error: "unsupported_grant_type" });
    }
    if ("error" in r) {
      app.log.warn({ grant: b.grant_type, error: r.error, client: clientId, has: Object.keys(b).sort() }, "oauth token request refused");
      return reply.code(400).send(r);
    }
    app.log.info({ grant: b.grant_type, client: clientId }, "oauth token issued");
    return r;
  });
}
