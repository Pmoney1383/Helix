import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { redactUrl } from "../src/api/log-redact.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { packageRoot } from "../src/mcp/desktop.js";
import { PUBLIC_PATHS } from "../src/mcp/http.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const FUNNEL = { "tailscale-funnel-request": "?1" };
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

let gw: Gateway;
before(async () => {
  gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: new FakeProvider() });
  await gw.app.ready();
});
after(async () => { await gw.app.close(); });

/** Every route the gateway serves, as [method, path] pairs, read from Fastify's own route table. */
function allRoutes(): [string, string][] {
  const out: [string, string][] = [];
  const stack: string[] = [];
  for (const line of gw.app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^([│ ]*)[├└]── (\S+) \(([^)]+)\)/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack[depth] = (depth ? stack[depth - 1]! : "") + m[2]!;
    stack.length = depth + 1;
    for (const method of m[3]!.split(", ")) if (method !== "-") out.push([method, stack[depth]!]);
  }
  return out;
}

describe("request log redaction", () => {
  it("cuts the connector token out of /mcp/t/<token> and secret values out of query strings", () => {
    assert.equal(redactUrl("/mcp/t/hxl_secretvalue"), "/mcp/t/[redacted]");
    assert.equal(redactUrl("/mcp/t/hxl_secretvalue?x=1"), "/mcp/t/[redacted]?x=1");
    assert.equal(redactUrl("/mcp/live-desktop/signal?ticket=abc&seat=0&panel=def"), "/mcp/live-desktop/signal?ticket=[redacted]&seat=0&panel=[redacted]");
    assert.equal(redactUrl("/oauth/token?code=abc"), "/oauth/token?code=[redacted]");
  });

  it("leaves ordinary URLs alone, including PKCE fields that only look like a code", () => {
    const u = "/oauth/authorize?response_type=code&client_id=hxc_1&code_challenge=xyz&code_challenge_method=S256";
    assert.equal(redactUrl(u), u);
    assert.equal(redactUrl("/v1/sessions/abc/messages?limit=50"), "/v1/sessions/abc/messages?limit=50");
  });
});

describe("hook and presence endpoints take only the PC's own agent token", () => {
  it("a hosted connector's token is refused; a local agent token works", async () => {
    const hosted = gw.localTokens.create("hosted:test", "pc.hosted").token;
    const agent = gw.localTokens.create("helix-connect", "pc.agent.local").token;
    const post = (url: string, token: string, payload: unknown) =>
      gw.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });

    for (const [url, body] of [
      ["/v1/presence/idle", { idleSec: 9999 }],
      ["/v1/agent-events", { provider: "claude", event: "Stop", payload: {} }],
      ["/v1/agent-events/permission", { provider: "claude", payload: { tool_name: "Bash", tool_input: { command: "echo hi" } } }],
    ] as const) {
      assert.equal((await post(url, hosted, body)).statusCode, 401, `${url} refuses a pc.hosted token`);
    }
    assert.equal((await post("/v1/presence/idle", agent, { idleSec: 5 })).statusCode, 204);
    assert.notEqual((await post("/v1/agent-events", agent, { provider: "claude", event: "Stop", payload: {} })).statusCode, 401);
  });
});

describe("through Tailscale Funnel only the connector paths answer", () => {
  it("every other route the gateway serves is a 404 from the internet, whenever it was registered", async () => {
    const routes = allRoutes();
    assert.ok(routes.length > 50, `read the route table (${routes.length} routes)`);
    const hidden = routes.filter(([, p]) => !PUBLIC_PATHS.test(p));
    assert.ok(hidden.some(([, p]) => p === "/v1/presence/idle") && hidden.some(([, p]) => p === "/health"));
    for (const [method, p] of hidden) {
      const url = p.replace(/:[^/]+/g, "x").replace(/\*$/, "x");
      const r = await gw.app.inject({ method: method as "GET", url, headers: FUNNEL, payload: method === "GET" || method === "HEAD" ? undefined : {} });
      assert.equal(r.statusCode, 404, `${method} ${url} must not be reachable from the internet`);
    }
  });
});

describe("physical takeover", () => {
  it("the desktop helper re-arms its input hooks while control runs (Windows drops a slow low-level hook silently)", () => {
    const src = fs.readFileSync(path.join(packageRoot(), "hooks", "computer-helper.cs"), "utf8").replace(/\r\n/g, "\n");
    const tick = /void Tick\(\) \{[\s\S]*?\n {4}\}/.exec(src)![0];
    assert.match(tick, /ArmTakeover\(\)/);
    assert.match(tick, /Stop\("takeover detection failed"\)/, "if re-arming fails, control stops");
    assert.match(/string Start\(bool label[\s\S]*?\n {4}\}/.exec(src)![0], /ArmTakeover\(\);\s*active=true/);
  });
});

describe("OAuth sign-in cannot be blocked from the internet", () => {
  const pkce = () => createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  const register = async (headers: Record<string, string> = {}) => (await gw.app.inject({
    method: "POST", url: "/oauth/register", headers, payload: { client_name: "ChatGPT", redirect_uris: [REDIRECT] },
  })).json().client_id as string;
  const consent = async (clientId: string, headers: Record<string, string> = {}) => {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce(), code_challenge_method: "S256" });
    const html = (await gw.app.inject({ url: `/oauth/authorize?${q}`, headers })).body;
    return /name="req" value="([^"]+)"/.exec(html)![1]!;
  };
  const submit = (req: string, code: string, headers: Record<string, string> = {}) => gw.app.inject({
    method: "POST", url: "/oauth/authorize", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ req, code, decision: "approve" }).toString(),
  });

  it("wrong codes from the internet lock the internet out, but the owner can still approve over the tailnet", async () => {
    const clientId = await register(FUNNEL);
    const req = await consent(clientId, FUNNEL);
    const refused = (r: { statusCode: number; body: string }) => r.statusCode === 429 || /Too many wrong codes/.test(r.body);
    let last;
    for (let i = 0; i < 12; i++) last = await submit(req, "WRONGCDE", FUNNEL);
    assert.ok(refused(last!), "the internet runs out of attempts");
    // The owner's real code is refused from the internet now...
    const owner = gw.oauth.createApprovalCode().code;
    assert.ok(refused(await submit(await consent(clientId, FUNNEL), owner, FUNNEL)));
    // ...but from the tailnet it works: neither the wrong-code ceiling nor the rate limit is shared.
    const ok = await submit(await consent(clientId), owner);
    assert.equal(ok.statusCode, 302);
    assert.ok(new URL(ok.headers.location as string).searchParams.get("code"));
  });

  it("registrations that never sign in are capped and expire; connectors in use are kept", () => {
    const db = openDb(":memory:");
    return (async () => {
      const g = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, db, { claude: new FakeProvider() });
      try {
        const used = g.oauth.registerClient("in use", [REDIRECT]).clientId;
        db.prepare("UPDATE oauth_clients SET created_at = ? WHERE client_id = ?").run(new Date(Date.now() - 30 * 86_400_000).toISOString(), used);
        g.localTokens.create("hosted:oauth:in use", "pc.hosted", { ttlMs: 60_000, oauthClientId: used });
        const stale = g.oauth.registerClient("stale", [REDIRECT]).clientId;
        db.prepare("UPDATE oauth_clients SET created_at = ? WHERE client_id = ?").run(new Date(Date.now() - 2 * 86_400_000).toISOString(), stale);

        for (let i = 0; i < 150; i++) g.oauth.registerClient(`flood ${i}`, [REDIRECT]);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as { n: number }).n;
        assert.equal(count, 101, "100 unused registrations plus the connector in use");
        assert.ok(g.oauth.client(used), "a connector that signed in is never pruned");
        assert.equal(g.oauth.client(stale), undefined, "a day-old registration that never signed in is gone");
        assert.ok(g.oauth.client(db.prepare("SELECT client_id FROM oauth_clients ORDER BY created_at DESC LIMIT 1").pluck().get() as string), "the newest stays");
      } finally { await g.app.close(); }
    })();
  });
});
