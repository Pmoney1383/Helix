import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeArgs } from "../src/providers/claude.js";
import type { SendOptions } from "../src/providers/provider.js";

const base = (o: Partial<SendOptions> = {}): SendOptions => ({
  providerSessionId: "11111111-1111-4111-8111-111111111111", text: "hi", resume: false, signal: new AbortController().signal, ...o,
});
const mcp = { url: "http://127.0.0.1:7777/mcp", token: "hxa_x" };
const has = (a: string[], flag: string, value?: string) => {
  const i = a.indexOf(flag);
  return i >= 0 && (value === undefined || a[i + 1] === value);
};

describe("claude command line", () => {
  it("a new session names its id; a continuing one resumes it; a fork branches into a chosen id", () => {
    const a = claudeArgs(base(), { kind: "new" }, "default");
    assert.ok(has(a, "--session-id", "11111111-1111-4111-8111-111111111111") && !has(a, "--resume"));
    const b = claudeArgs(base({ resume: true }), { kind: "resume" }, "default");
    assert.ok(has(b, "--resume", "11111111-1111-4111-8111-111111111111") && !has(b, "--session-id"));
    const f = claudeArgs(base(), { kind: "fork", from: "22222222-2222-4222-8222-222222222222" }, "default");
    assert.ok(has(f, "--resume", "22222222-2222-4222-8222-222222222222") && has(f, "--fork-session") && has(f, "--session-id", "11111111-1111-4111-8111-111111111111"));
  });

  it("a normal agent routes permission prompts to the gateway and keeps its built-in tools", () => {
    const a = claudeArgs(base({ mcp }), { kind: "new" }, "default");
    assert.ok(has(a, "--permission-prompt-tool", "mcp__helix__permission_prompt"));
    assert.ok(has(a, "--mcp-config"));
    assert.ok(!has(a, "--tools") && !has(a, "--strict-mcp-config") && !has(a, "--allowedTools"));
    assert.ok(!has(a, "--append-system-prompt"));
  });

  it("the router has no built-in tools, only Helix's MCP server, a role prompt, and NO permission-prompt tool it cannot call", () => {
    const a = claudeArgs(base({ mcp, routingOnly: true, appendSystemPrompt: "You are the router" }), { kind: "new" }, "default");
    assert.ok(has(a, "--tools", ""), "built-in tools disabled");
    assert.ok(has(a, "--strict-mcp-config"), "nothing but Helix's server");
    assert.ok(has(a, "--append-system-prompt", "You are the router"));
    assert.ok(has(a, "--allowedTools", "mcp__helix"), "its own routing tools are pre-approved");
    assert.ok(!has(a, "--permission-prompt-tool"), "the router scope has no permission_prompt tool: naming it makes Claude refuse to start");
  });

  it("without a gateway connection no MCP flags are passed at all", () => {
    const a = claudeArgs(base(), { kind: "new" }, "acceptEdits");
    assert.ok(!has(a, "--mcp-config") && !has(a, "--permission-prompt-tool"));
    assert.ok(has(a, "--permission-mode", "acceptEdits"));
  });

  it("the MCP config carries the per-turn token as a bearer header", () => {
    const a = claudeArgs(base({ mcp }), { kind: "new" }, "default");
    const cfg = JSON.parse(a[a.indexOf("--mcp-config") + 1]!);
    assert.equal(cfg.mcpServers.helix.url, mcp.url);
    assert.equal(cfg.mcpServers.helix.headers.Authorization, "Bearer hxa_x");
  });
});
