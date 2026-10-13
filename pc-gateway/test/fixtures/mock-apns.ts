import crypto from "node:crypto";
import http2 from "node:http2";

export interface Received {
  path: string;
  token: string;
  headers: http2.IncomingHttpHeaders;
  body: any;
  at: number;
}

/**
 * A stand-in for api.push.apple.com: a real HTTP/2 server (cleartext, so tests need no certificates) that
 * records every request and answers like Apple does, depending on the device token it is sent:
 *
 *   dead-*     410 Unregistered           bad-*      400 BadDeviceToken
 *   flaky-*    503 once, then 200         throttle-* 429 once, then 200
 *   hang-*     never answers              (anything else) 200 with an apns-id
 */
export async function startMockApns() {
  const received: Received[] = [];
  const seen = new Map<string, number>();
  const server = http2.createServer();

  server.on("stream", (stream, headers) => {
    const path = String(headers[":path"]);
    const token = path.replace("/3/device/", "");
    let raw = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => { raw += c; });
    stream.on("end", () => {
      let body: any = raw;
      try { body = JSON.parse(raw); } catch { /* keep text */ }
      received.push({ path, token, headers, body, at: Date.now() });
      const n = (seen.get(token) ?? 0) + 1;
      seen.set(token, n);

      const reply = (status: number, reason?: string) => {
        (stream as http2.ServerHttp2Stream).respond({ ":status": status, "apns-id": crypto.randomUUID(), "content-type": "application/json" });
        stream.end(reason ? JSON.stringify({ reason }) : "");
      };
      // Markers are hex prefixes, because real tokens are hex: c0ff (never answers), dead (410), bad0 (400), f1a4 (503 once), 7407 (429 once)
      if (token.startsWith("c0ff")) return; // never answer
      if (token.startsWith("dead")) return reply(410, "Unregistered");
      if (token.startsWith("bad0")) return reply(400, "BadDeviceToken");
      if (token.startsWith("f1a4") && n === 1) return reply(503, "ServiceUnavailable");
      if (token.startsWith("7407") && n === 1) return reply(429, "TooManyRequests");
      reply(200);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    reset: () => { received.length = 0; seen.clear(); },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); setTimeout(resolve, 200); }),
  };
}

/** A throwaway P-256 key in the same PEM form as an Apple .p8, plus the matching public key for verifying JWTs. */
export function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey };
}

/** Verifies an ES256 JWT the way Apple would, returning its decoded header and claims. */
export function verifyJwt(jwt: string, publicKey: crypto.KeyObject) {
  const [h, c, s] = jwt.split(".") as [string, string, string];
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return { ok, header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(c, "base64url").toString()) };
}

/** A realistic-looking 64-character hex device token that starts with the given marker. */
export const token = (marker: string, n = 1) => (marker + String(n).padStart(2, "0")).padEnd(64, "a").replace(/[^0-9a-f]/gi, (c) => (c.charCodeAt(0) % 10).toString());
