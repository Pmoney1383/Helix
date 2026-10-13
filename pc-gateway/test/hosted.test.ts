import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGateway, type Gateway } from "../src/app.js";
import { hostedCommandVerdict, isProtectedPath } from "../src/permissions/hosted-safety.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

describe("hosted command safety", () => {
  const safe = [
    "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5",
    "dir C:\\Users\\alice\\Documents",
    "nvidia-smi",
    "git status",
    "git log --oneline -5",
    "Get-Content train.log -Tail 20 2>&1",
    "Get-Service helix-gateway",
    "hostname; whoami",
    "Get-ChildItem . 2>$null",
  ];
  for (const c of safe) it(`allows: ${c}`, () => assert.equal(hostedCommandVerdict(c).allowed, true, hostedCommandVerdict(c).reason ?? ""));

  const refused: [string, RegExp][] = [
    ["Remove-Item C:\\x -Recurse", /safe/],
    ["rm -rf /", /safe/],
    ["del file.txt", /safe/],
    ["git push origin main", /git/],
    ["git commit -am x", /git/],
    ["Set-Content a.txt hi", /writes/],
    ["echo hi > a.txt", /redirects/],
    ["Stop-Process -Id 4", /process/],
    ["Restart-Service helix-gateway", /process/],
    ["curl https://evil.example/x", /network/],
    ["Invoke-WebRequest https://x", /network/],
    ["npm install left-pad", /packages/],
    ["Get-Content .env", /\.env/],
    ["type C:\\Users\\alice\\.ssh\\id_ed25519", /ssh/],
    ["cat AuthKey_ABC.p8", /key file/],
    ["Get-ChildItem env:", /environment/],
    ["echo $env:HELIX_PORT", /secret environment/],
    ["powershell -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAIABOAGUAdAAuAFcAZQBiAEMAbABpAGUAbgB0ACkA", /./],
    ["Get-Process; Stop-Computer", /power/],
    ["python -c \"print(1)\"", /interpreter/],
    ["Get-Process\nGet-Service", /multi-line/],
    ["& $x", /dynamic/],
    ["Start-Process notepad", /starts/],
    ["", /empty/],
  ];
  for (const [c, why] of refused) it(`refuses: ${JSON.stringify(c).slice(0, 50)}`, () => {
    const v = hostedCommandVerdict(c);
    assert.equal(v.allowed, false);
    assert.match(v.reason ?? "", why);
  });

  it("refuses anything that mentions Helix's data folder", () => {
    const dir = path.resolve("some", "data");
    assert.equal(hostedCommandVerdict(`Get-ChildItem ${dir}`, dir).allowed, false);
  });
});

describe("protected paths", () => {
  const dataDir = path.resolve("C:\\gw\\data");
  for (const p of ["C:\\a\\.env", "C:\\a\\.env.local", "D:\\k\\AuthKey_X.p8", "C:\\Users\\u\\.ssh\\id_rsa", "C:\\Users\\u\\.helix\\local.json", "C:\\gw\\data\\helix.db", "C:\\gw\\data\\backups\\x"]) {
    it(`protects ${p}`, () => assert.equal(isProtectedPath(p, dataDir), true));
  }
  for (const p of ["C:\\proj\\src\\index.ts", "C:\\proj\\train.log", "C:\\proj\\environment.md"]) {
    it(`allows ${p}`, () => assert.equal(isProtectedPath(p, dataDir), false));
  }
});

describe("hosted MCP endpoint", () => {
  let gw: Gateway;
  let base: string;
  let hostedToken: string;
  let agentToken: string;
  let tmp: string;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-hosted-"));
    fs.writeFileSync(path.join(tmp, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(tmp, "notes.txt"), "hello hosted");
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", dataDir: path.join(tmp, "data") }, openDb(":memory:"), { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    hostedToken = gw.localTokens.create("hosted:test", "pc.hosted", { ttlDays: 1 }).token;
    agentToken = gw.localTokens.create("terminal-agents").token;
  });
  after(async () => { await gw.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const connect = async (url: string, headers: Record<string, string> = {}) => {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
  };
  const text = (r: any): string => r.content[0].text;

  it("exposes observe tools plus run_safe_command, and nothing that writes or controls", async () => {
    const c = await connect(`${base}/mcp`, { authorization: `Bearer ${hostedToken}` });
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("get_pc_status") && names.includes("run_safe_command") && names.includes("read_file"));
    for (const banned of ["run_command", "write_file", "stop_process", "request_user_approval", "notify_user", "handoff_current_conversation"]) {
      assert.ok(!names.includes(banned), banned);
    }
    await c.close();
  });

  it("works with the token in the URL path", async () => {
    const c = await connect(`${base}/mcp/t/${hostedToken}`);
    const r: any = await c.callTool({ name: "run_safe_command", arguments: { command: "hostname" } });
    assert.ok(!r.isError);
    assert.match(text(r), new RegExp(os.hostname(), "i"));
    await c.close();
  });

  it("runs safe commands and refuses unsafe ones without running them", async () => {
    const c = await connect(`${base}/mcp`, { authorization: `Bearer ${hostedToken}` });
    const victim = path.join(tmp, "notes.txt");
    const bad: any = await c.callTool({ name: "run_safe_command", arguments: { command: `Remove-Item "${victim}"` } });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /Nothing was run/);
    assert.ok(fs.existsSync(victim));
    const written: any = await c.callTool({ name: "run_safe_command", arguments: { command: `Set-Content "${path.join(tmp, "x.txt")}" hi` } });
    assert.equal(written.isError, true);
    assert.ok(!fs.existsSync(path.join(tmp, "x.txt")));
    await c.close();
  });

  it("keeps credentials and Helix state out of the read tools", async () => {
    const c = await connect(`${base}/mcp`, { authorization: `Bearer ${hostedToken}` });
    const env: any = await c.callTool({ name: "read_file", arguments: { path: path.join(tmp, ".env") } });
    assert.equal(env.isError, true);
    const ok: any = await c.callTool({ name: "read_file", arguments: { path: path.join(tmp, "notes.txt") } });
    assert.ok(!ok.isError);
    assert.match(text(ok), /hello hosted/);
    await c.close();
  });

  it("a non-hosted token cannot use the URL form", async () => {
    const r = await fetch(`${base}/mcp/t/${agentToken}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
  });

  it("from the public internet only hosted credentials work, and only /mcp is reachable", async () => {
    const funnel = { "tailscale-funnel-request": "?1" };
    const post = (url: string, token: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...funnel }, body: "{}" });
    assert.equal((await post(`${base}/mcp`, agentToken)).status, 401);
    assert.notEqual((await post(`${base}/mcp`, hostedToken)).status, 401);
    assert.equal((await fetch(`${base}/health`, { headers: funnel })).status, 404);
    assert.equal((await fetch(`${base}/v1/sessions`, { headers: funnel })).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200); // tailnet/local traffic is unaffected
  });

  it("rate limits repeated bad credentials from the public internet", async () => {
    const funnel = { "tailscale-funnel-request": "?1" };
    let last = 0;
    for (let i = 0; i < 30; i++) {
      last = (await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer hxl_wrong", ...funnel }, body: "{}" })).status;
    }
    assert.equal(last, 429);
  });

  it("expired and revoked credentials stop working", async () => {
    const t = gw.localTokens.create("hosted:short", "pc.hosted", { ttlDays: 1 });
    assert.ok(gw.localTokens.lookup(t.token));
    assert.ok(gw.localTokens.revoke(t.id));
    assert.equal(gw.localTokens.lookup(t.token), undefined);
  });
});
