import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const REDIRECT = "https://chatgpt.example/callback";
const PUBLIC = "https://helix.example.ts.net:8443";

let gw: Gateway;
let base: string;

before(async () => {
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", publicUrl: PUBLIC }, openDb(":memory:"), { claude: new FakeProvider() });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
});
after(async () => { await gw.app.close(); });

const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(), redirect: "manual" as const });
const register = async (redirect = REDIRECT) =>
  ((await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect] }) })).json()) as any).client_id as string;
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
/** Opens the consent screen and returns the hidden request id. */
async function consent(clientId: string, challenge: string, state = "xyz") {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state });
  const r = await fetch(`${base}/oauth/authorize?${q}`);
  const html = await r.text();
  return { status: r.status, html, req: /name="req" value="([^"]+)"/.exec(html)?.[1] };
}
async function authorize(clientId: string, challenge: string, ownerCode = gw.oauth.createApprovalCode().code) {
  const c = await consent(clientId, challenge);
  const r = await fetch(`${base}/oauth/authorize`, form({ req: c.req!, code: ownerCode, decision: "approve" }));
  return { status: r.status, location: r.headers.get("location") ?? "" };
}

describe("OAuth for hosted connectors", () => {
  it("publishes discovery metadata that points at the public address", async () => {
    const as: any = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, PUBLIC);
    assert.equal(as.token_endpoint, `${PUBLIC}/oauth/token`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    const pr: any = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(pr.resource, `${PUBLIC}/mcp`);
    assert.deepEqual(pr.authorization_servers, [PUBLIC]);
  });

  it("an unauthenticated /mcp call says where to sign in", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/helix\.example\.ts\.net:8443\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  it("registration only accepts https (or loopback) redirects", async () => {
    const bad = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
    assert.equal(bad.status, 400);
    assert.ok(await register());
    assert.ok(await register("http://localhost:3000/cb"));
  });

  it("full flow: consent with the owner's code, PKCE exchange, then the token works on /mcp", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const a = await authorize(clientId, challenge);
    assert.equal(a.status, 302);
    const loc = new URL(a.location);
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get("state"), "xyz");
    const code = loc.searchParams.get("code")!;

    const t = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }));
    assert.equal(t.status, 200);
    const tok: any = await t.json();
    assert.equal(tok.token_type, "Bearer");
    assert.equal(tok.scope, "pc.hosted");
    assert.ok(tok.refresh_token.startsWith("hxr_"));

    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("run_safe_command"));
    assert.ok(!names.includes("run_command"));
    await client.close();

    // refresh rotates: the old refresh token stops working
    const r1 = await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }));
    assert.equal(r1.status, 200);
    const next: any = await r1.json();
    assert.notEqual(next.refresh_token, tok.refresh_token);
    assert.equal((await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }))).status, 400);

    // revoke everything: the refresh token and the access token both die
    gw.oauth.revokeAll();
    assert.equal((await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: clientId }))).status, 400);
  });

  it("a wrong, reused, or missing owner code never yields a token", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const c = await consent(clientId, challenge);
    const wrong = await fetch(`${base}/oauth/authorize`, form({ req: c.req!, code: "AAAAAAAA", decision: "approve" }));
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /wrong, expired or already used/);

    const owner = gw.oauth.createApprovalCode().code;
    assert.equal((await authorize(clientId, challenge, owner)).status, 302);
    assert.equal((await authorize(clientId, challenge, owner)).status, 401); // a code works once
  });

  it("PKCE is enforced and an authorization code works once", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(clientId, challenge)).location).searchParams.get("code")!;
    const bad = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "wrong-verifier" }));
    assert.equal(bad.status, 400);
    // the code was burned by the failed attempt, so even the right verifier is too late
    const late = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }));
    assert.equal(late.status, 400);
  });

  it("refuses unknown clients, unregistered redirects and plain PKCE", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const unknown = await fetch(`${base}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: "hxc_nope", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" }));
    assert.equal(unknown.status, 400);
    const redirect = await fetch(`${base}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" }));
    assert.equal(redirect.status, 400);
    const plain = await fetch(`${base}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "plain" }));
    assert.equal(plain.status, 400);
  });

  it("denying redirects back with access_denied", async () => {
    const clientId = await register();
    const c = await consent(clientId, pkce().challenge);
    const r = await fetch(`${base}/oauth/authorize`, form({ req: c.req!, decision: "deny" }));
    assert.equal(r.status, 302);
    assert.equal(new URL(r.headers.get("location")!).searchParams.get("error"), "access_denied");
  });

  it("escapes the connector name on the consent page", async () => {
    const id = ((await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "<script>alert(1)</script>", redirect_uris: [REDIRECT] }) })).json()) as any).client_id;
    const c = await consent(id, pkce().challenge);
    assert.ok(!c.html.includes("<script>alert"));
    assert.ok(c.html.includes("&lt;script&gt;"));
  });

  it("through the funnel, the OAuth pages are reachable but the rest of the gateway is not", async () => {
    const funnel = { "tailscale-funnel-request": "?1" };
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: funnel })).status, 200);
    assert.equal((await fetch(`${base}/v1/sessions`, { headers: funnel })).status, 404);
    assert.equal((await fetch(`${base}/health`, { headers: funnel })).status, 404);
  });
});

describe("connector discovery probes", () => {
  it("a GET to /mcp without credentials is told where to sign in", async () => {
    const r = await fetch(`${base}/mcp`);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });

  it("answers CORS preflights for discovery, registration and token endpoints", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token"]) {
      const r = await fetch(base + p, { method: "OPTIONS", headers: { origin: "https://chatgpt.com", "access-control-request-method": "POST" } });
      assert.equal(r.status, 204, p);
      assert.equal(r.headers.get("access-control-allow-origin"), "*");
    }
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { origin: "https://chatgpt.com" } });
    assert.equal(meta.headers.get("access-control-allow-origin"), "*");
  });

  it("does not open up the consent page or /mcp to cross-origin callers", async () => {
    const r = await fetch(`${base}/oauth/authorize`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.notEqual(r.headers.get("access-control-allow-origin"), "*");
  });
});

describe("first probes from a connector", () => {
  it("an unauthenticated POST /mcp gets 401 + sign-in pointer whatever content type it sends (no 415/500)", async () => {
    for (const headers of [{} as Record<string, string>, { "content-type": "text/plain" }, { "content-type": "application/octet-stream" }, { "content-type": "application/json; charset=utf-8" }]) {
      const r = await fetch(`${base}/mcp`, { method: "POST", headers, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
      assert.equal(r.status, 401, JSON.stringify(headers));
      assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    }
    const bare = await fetch(`${base}/mcp`, { method: "POST" });
    assert.equal(bare.status, 401);
  });

  it("the same holds through the funnel, and the failure still counts toward the rate limit", async () => {
    const funnel = { "tailscale-funnel-request": "?1" };
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { ...funnel, "content-type": "text/plain" }, body: "x" });
    assert.equal(r.status, 401);
  });

  it("client mistakes elsewhere are 4xx, not 500", async () => {
    const r = await fetch(`${base}/v1/pair/complete`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x" });
    assert.equal(r.status, 415);
  });
});

describe("consent page security policy", () => {
  it("lets the form's redirect reach the connector's own origin (Chrome applies form-action to the redirect after submit)", async () => {
    const clientId = await register();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const csp = (await fetch(`${base}/oauth/authorize?${q}`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /form-action 'self' https:\/\/chatgpt\.example;/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});
