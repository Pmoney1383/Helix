import type { FastifyRequest } from "fastify";

/** Query parameters that carry a credential: live-viewer tickets and panel keys, connector tokens, sign-in codes. */
const SECRET_QUERY = /([?&](?:ticket|panel|token|access_token|code|key)=)[^&#]*/gi;

/** A request URL as it may appear in the log: the connector token in `/mcp/t/<token>` and secret query values are cut. */
export function redactUrl(url: string): string {
  return url.replace(/^(\/mcp\/t\/)[^/?#]+/, "$1[redacted]").replace(SECRET_QUERY, "$1[redacted]");
}

/** Fastify's request log fields, with the URL redacted. */
export function requestLogFields(req: FastifyRequest): Record<string, unknown> {
  return { method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort };
}
