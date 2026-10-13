import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RateLimiter, bearerToken } from "../api/auth.js";
import { baseUrl } from "../oauth/oauth.js";
import { createMcpServer, type McpDeps } from "./server.js";
import type { McpContext } from "./scopes.js";

/** Public routes: MCP (including ticketed synthetic viewer diagnostics) and OAuth discovery. */
const PUBLIC_PATHS = /^\/(mcp(\/|\?|$)|oauth\/|\.well-known\/)/;
/** Tailscale Funnel adds this to every request that arrived from the public internet rather than the tailnet. */
const isPublicInternet = (req: FastifyRequest): boolean => req.headers["tailscale-funnel-request"] !== undefined;

/**
 * Stateless Streamable-HTTP MCP endpoint. A fresh server+transport per request keeps this simple;
 * the credential (a per-turn agent token or a long-lived local token) decides the scope and the session.
 *
 * Hosted ChatGPT/Claude reach it from the internet (Tailscale Funnel), so:
 *  - a request that came through the funnel may only touch /mcp, and only with a `pc.hosted` credential;
 *  - `/mcp/t/<token>` is accepted as well as a bearer header, for connectors that only take a URL;
 *  - failed credentials are rate limited per client address.
 */
export function registerMcp(app: FastifyInstance, resolve: (token: string | undefined) => McpContext | undefined, deps: McpDeps): void {
  const failures = new RateLimiter(20, 60_000);

  // Defence in depth: even if the funnel were pointed at the whole gateway, the internet can only ever reach /mcp.
  app.addHook("onRequest", async (req, reply) => {
    if (isPublicInternet(req) && !PUBLIC_PATHS.test(req.url)) return reply.code(404).send({ error: "not found" });
  });

  // An unauthenticated caller must always get "401 + where to sign in", whatever it sent. This runs before the body is
  // parsed on purpose: a connector's first probe often has no content type, and the body parser would answer 415/500
  // before the route could challenge it, so the connector never learns it should start OAuth.
  const MCP_PATH = /^\/mcp(\/t\/([^/?]+))?(\?.*)?$/;
  app.addHook("onRequest", async (req, reply) => {
    const m = MCP_PATH.exec(req.url);
    if (!m) return;
    const ctx = resolve(bearerToken(req) ?? m[2]);
    if (ctx && !(isPublicInternet(req) && ctx.scope !== "pc.hosted")) return;
    if (isPublicInternet(req)) {
      if (!failures.peek(req.ip)) return reply.code(429).send({ error: "too many failed attempts" });
      failures.allow(req.ip);
    }
    reply.header("www-authenticate", `Bearer resource_metadata="${baseUrl(req, deps.publicUrl)}/.well-known/oauth-protected-resource/mcp"`);
    return reply.code(401).send({ error: "unauthorized" });
  });

  // One line per request that came from the internet or touches connector discovery/sign-in: who asked (user agent,
  // origin), for what, and what we answered. Secrets never reach the log: tokens in the URL path and query strings are cut.
  app.addHook("onResponse", async (req, reply) => {
    if (!isPublicInternet(req) && !PUBLIC_PATHS.test(req.url)) return;
    const path = req.url.split("?")[0]!.replace(/(\/mcp\/t\/)[^/]+/, "$1<token>");
    app.log.info({
      public: isPublicInternet(req), method: req.method, path, status: reply.statusCode, host: req.headers.host,
      ua: String(req.headers["user-agent"] ?? "").slice(0, 120), origin: req.headers.origin,
      hasAuth: !!req.headers.authorization, ms: Math.round(reply.elapsedTime),
    }, "connector request");
  });

  const handle = async (req: FastifyRequest, reply: FastifyReply, token: string | undefined) => {
    const ip = req.ip;
    if (isPublicInternet(req) && !failures.peek(ip)) return reply.code(429).send({ error: "too many failed attempts" });
    const ctx = resolve(token);
    if (!ctx || (isPublicInternet(req) && ctx.scope !== "pc.hosted")) {
      if (isPublicInternet(req)) failures.allow(ip);
      // Tells OAuth-capable connectors (ChatGPT, Claude) where to sign in (RFC 9728).
      reply.header("www-authenticate", `Bearer resource_metadata="${baseUrl(req, deps.publicUrl)}/.well-known/oauth-protected-resource/mcp"`);
      return reply.code(401).send({ error: "unauthorized" });
    }

    const server = createMcpServer(ctx, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", (req, reply) => handle(req, reply, bearerToken(req)));
  // Only hosted credentials may be presented in a URL; anything else is refused in `handle` via the funnel check,
  // and locally the path form is simply not offered for other scopes.
  app.post<{ Params: { token: string } }>("/mcp/t/:token", async (req, reply) => {
    const ctx = resolve(req.params.token);
    if (ctx && ctx.scope !== "pc.hosted") return reply.code(401).send({ error: "unauthorized" });
    return handle(req, reply, req.params.token);
  });

  // GET/DELETE are not used (stateless server), but a client that probes with GET must still learn where to sign in:
  // answer 401 + resource_metadata when there is no valid credential, 405 only for a caller that is authenticated.
  const notAllowed = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req) ?? (req.params as { token?: string } | undefined)?.token;
    if (!resolve(token)) {
      reply.header("www-authenticate", `Bearer resource_metadata="${baseUrl(req, deps.publicUrl)}/.well-known/oauth-protected-resource/mcp"`);
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.code(405).send({ error: "method not allowed" });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  app.get("/mcp/t/:token", notAllowed);
  app.delete("/mcp/t/:token", notAllowed);
}
