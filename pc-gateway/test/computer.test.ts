import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { ComputerController, imagePoint, type Action, type Frame } from "../src/computer/controller.js";
import { computerResult } from "../src/computer/tools.js";
import { loadConfig } from "../src/config.js";
import type { ComputerBridge, NativeResult } from "../src/computer/bridge.js";
import { LocalTokenService } from "../src/auth/local-tokens.js";
import { OAuthService } from "../src/oauth/oauth.js";
import { openDb } from "../src/storage/sqlite.js";
import { buildGateway } from "../src/app.js";
import { FakeProvider } from "../src/providers/fake.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const frame = (overrides: Partial<Frame> = {}): Frame => ({ frameId: randomUUID(), width: 1600, height: 900,
  bounds: { x: -2560, y: -200, width: 2560, height: 1440 }, layout: "two-monitor-layout", capturedAt: new Date().toISOString(), activeWindow: { handle: "123" }, monitorId: "left", ...overrides });

class FakeBridge implements ComputerBridge {
  commands: Record<string, unknown>[] = [];
  active = false; closed = false; captureFails = false; actionFails = false;
  async request(command: Record<string, unknown>): Promise<NativeResult> {
    this.commands.push(command);
    if (command.op === "start") { this.active = true; return { ok: true, monitorId: "left" }; }
    if (command.op === "stop") this.active = false;
    if (command.op === "heartbeat") return { ok: true, active: this.active };
    if (command.op === "capture") {
      if (this.captureFails) return { ok: false, error: "capture unavailable" };
      return { ...frame(command.monitorId === "right" ? { monitorId: "right", bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
        : command.monitorId === "all" ? { monitorId: "all", width: 1600, height: 514, bounds: { x: -2560, y: -200, width: 4480, height: 1440 } } : {}),
        ok: true, image: "aGVsbG8=", mimeType: "image/png" };
    }
    if (command.op === "action") {
      if (this.actionFails) throw new Error("transport failed after input");
      return { ok: true, executed: true, monitorId: command.kind === "drag" && command.x2 !== undefined && Number(command.x2) >= 0 ? "all" : command.x !== undefined && Number(command.x) >= 0 ? "right" : "left" };
    }
    return { ok: true };
  }
  close(): void { this.closed = true; this.active = false; }
}

describe("desktop coordinate contract", () => {
  it("maps resized frames to negative-origin physical coordinates", () => {
    assert.deepEqual(imagePoint(frame(), 0, 0), { x: -2560, y: -200 });
    assert.deepEqual(imagePoint(frame(), 1599, 899), { x: -1, y: 1239 });
    assert.deepEqual(imagePoint(frame({ width: 100, height: 100, bounds: { x: 3500, y: 600, width: 200, height: 200 } }), 50, 50), { x: 3601, y: 701 });
  });
  it("refuses fractional, missing and out-of-image points", () => {
    for (const [x, y] of [[-1, 0], [1600, 0], [0, 900], [0.5, 0], [NaN, 2], [Infinity, 0]]) assert.throws(() => imagePoint(frame(), x, y));
    assert.throws(() => imagePoint(frame(), undefined, 0));
  });
});

describe("desktop controller", () => {
  const setup = () => { const bridge = new FakeBridge(); let grant = true; const controller = new ComputerController(() => grant, () => bridge);
    return { bridge, controller, revoke: () => { grant = false; } }; };
  const click = (start: NativeResult): Action => ({ kind: "click", controlId: String(start.controlId), frameId: String(start.frameId), requestId: randomUUID(), x: 50, y: 50 });
  it("shows the indicator before capturing; excludes another owner", async () => {
    const { bridge, controller } = setup(); try {
      await controller.start("a"); assert.deepEqual(bridge.commands.map(c => c.op), ["start", "capture"]);
      assert.equal(bridge.commands[1]?.monitorId, "left");
      await assert.rejects(controller.start("b"), /active/);
    } finally { controller.close(); assert.equal(bridge.active, false); }
  });
  it("returns an image with each action and deduplicates retries", async () => {
    const { bridge, controller } = setup(); try {
      const start = await controller.start("a"); const a = click(start);
      const r = await controller.act("a", a); assert.equal(r.executed, true); assert.equal(typeof r.image, "string");
      assert.equal(bridge.commands.at(-1)?.monitorId, "left");
      const replay = await controller.act("a", a); assert.equal(replay.replayed, true);
      assert.equal(bridge.commands.filter(c => c.op === "action").length, 1);
      await assert.rejects(controller.act("a", { ...a, x: 12 }), /different input/);
      await assert.rejects(controller.act("a", { ...a, requestId: randomUUID() }), /stale|unknown/);
    } finally { controller.close(); }
  });
  it("does not retry input when the post-action screenshot fails", async () => {
    const { bridge, controller } = setup(); try {
      const start = await controller.start("a"); bridge.captureFails = true;
      const a = click(start); const r = await controller.act("a", a);
      assert.equal(r.executed, true); assert.match(String(r.screenshotError), /capture/);
      await controller.act("a", a); assert.equal(bridge.commands.filter(c => c.op === "action").length, 1);
    } finally { controller.close(); }
  });
  it("records an uncertain outcome before sending input", async () => {
    const { bridge, controller } = setup(); try {
      const start = await controller.start("a"); bridge.actionFails = true; const a = click(start);
      await assert.rejects(controller.act("a", a), /transport/);
      const replay = await controller.act("a", a); assert.equal(replay.executed, "unknown");
      assert.equal(bridge.commands.filter(c => c.op === "action").length, 1);
    } finally { controller.close(); }
  });
  it("maps a drag endpoint from a different monitor frame", async () => {
    const { bridge, controller } = setup(); try {
      const start = await controller.start("a"); const end = await controller.capture("a", String(start.controlId), { monitorId: "right" });
      await controller.act("a", { ...click(start), kind: "drag", endFrameId: String(end.frameId), x2: 1599, y2: 899 });
      const command = bridge.commands.find(c => c.op === "action")!; assert.equal(command.x2, 1919); assert.equal(command.y2, 1079);
      assert.equal(bridge.commands.at(-1)?.monitorId, "all");
    } finally { controller.close(); }
  });
  it("returns to a single monitor after a click from a two-monitor overview", async () => {
    const { bridge, controller } = setup(); try {
      const start = await controller.start("a");
      const overview = await controller.capture("a", String(start.controlId), { monitorId: "all" });
      const shot = await controller.act("a", { ...click(overview), controlId: String(start.controlId), x: 1200, y: 200 });
      assert.equal(bridge.commands.find(c => c.op === "action")?.kind, "click");
      assert.equal(shot.monitorId, "right");
      assert.equal(bridge.commands.at(-1)?.monitorId, "right");
    } finally { controller.close(); }
  });
  it("guards the active window for typing", async () => {
    const { bridge, controller } = setup(); try {
      const start = await controller.start("a"); await controller.act("a", { ...click(start), kind: "type_text", text: "hello" });
      assert.equal(bridge.commands.find(c => c.op === "action")?.expectedWindow, "123");
    } finally { controller.close(); }
  });
  it("refuses revoked credentials and cancelled input", async () => {
    const { bridge, controller, revoke } = setup(); try {
      const start = await controller.start("a"); const cancel = new AbortController(); cancel.abort();
      await assert.rejects(controller.act("a", click(start), cancel.signal), /cancelled/);
      revoke(); await assert.rejects(controller.act("a", click(start)), /disabled|revoked/);
      assert.equal(bridge.commands.filter(c => c.op === "action").length, 0);
    } finally { controller.close(); }
  });
  it("clears the indicator if initial capture fails", async () => {
    const { bridge, controller } = setup(); try {
      bridge.captureFails = true; assert.equal((await controller.start("a")).ok, false); assert.equal(bridge.active, false);
    } finally { controller.close(); }
  });
  it("requires a new session after stop", async () => {
    const { controller } = setup(); try {
      const start = await controller.start("a"); await controller.stop("a", String(start.controlId));
      await assert.rejects(controller.act("a", click(start)), /No matching/);
    } finally { controller.close(); }
  });
  it("rejects a cancelled start without showing an indicator", async () => {
    const { bridge, controller } = setup(); try {
      const abort = new AbortController(); abort.abort();
      await assert.rejects(controller.start("a", false, true, abort.signal), /cancelled/);
      assert.equal(bridge.commands.length, 0);
    } finally { controller.close(); }
  });
  it("a caller that lost its start result can start again (replacing its own session) or stop without a controlId", async () => {
    const { bridge, controller } = setup(); try {
      const lost = await controller.start("a");
      const again = await controller.start("a");
      assert.ok(again.ok && again.controlId !== lost.controlId);
      assert.deepEqual(bridge.commands.map(c => c.op), ["start", "capture", "stop", "start", "capture"], "old aura removed first");
      await assert.rejects(controller.act("a", click(lost)), /No matching/, "the lost session's id is dead");
      await assert.rejects(controller.start("b"), /Another control session/, "other callers are still excluded");
      await assert.rejects(controller.stop("b"), /No control session of yours/);
      assert.equal((await controller.stop("a")).ok, true);
      assert.equal(bridge.active, false);
      assert.equal(controller.isActive("a", String(again.controlId)), false);
    } finally { controller.close(); }
  });
  it("expires the control lease and refuses old coordinates", async () => {
    const bridge = new FakeBridge(); let now = Date.now();
    const controller = new ComputerController(() => true, () => bridge, () => now);
    try {
      const start = await controller.start("a"); now += 121_000;
      await assert.rejects(controller.act("a", click(start)), /expired/);
      assert.equal(bridge.commands.filter(c => c.op === "action").length, 0);
    } finally { controller.close(); }
  });
});

describe("desktop grants and MCP images", () => {
  it("keeps desktop approvals on by default and supports an explicit false test switch", () => {
    assert.equal(loadConfig({}).desktopApprovals, true);
    assert.equal(loadConfig({ HELIX_DESKTOP_APPROVALS: "false" }).desktopApprovals, false);
    assert.equal(loadConfig({ HELIX_DESKTOP_APPROVALS: "true" }).desktopApprovals, true);
  });
  it("skips only desktop approval requests when disabled", async () => {
    const db = openDb(":memory:");
    const gw = await buildGateway({ logLevel: "silent", defaultProjectPath: process.cwd(), desktopApprovals: false }, db, { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    const token = gw.localTokens.create("test", "pc.hosted");
    gw.localTokens.setDesktopAccess(token.id, true);
    const c = new Client({ name: "desktop-approval-test", version: "1" });
    try {
      const port = (gw.app.server.address() as { port: number }).port;
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token.token}` } } }));
      const base = { controlId: randomUUID(), frameId: randomUUID(), requestId: randomUUID(), screenshot: false };
      for (const [name, args] of [
        ["click", { ...base, x: 1, y: 1, requiresApproval: true }],
        ["press_key", { ...base, key: "delete" }],
        ["type_text", { ...base, text: "rm -rf project" }],
      ] as const) {
        const result = await c.callTool({ name, arguments: args });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /No matching active control session/);
        assert.equal(gw.approvals.list().length, 0);
      }
    } finally { await c.close(); await gw.app.close(); db.close(); }
  });
  it("retains the desktop approval gate when enabled", async () => {
    const db = openDb(":memory:");
    const gw = await buildGateway({ logLevel: "silent", defaultProjectPath: process.cwd(), desktopApprovals: true }, db, { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    const token = gw.localTokens.create("test", "pc.hosted");
    gw.localTokens.setDesktopAccess(token.id, true);
    const c = new Client({ name: "desktop-approval-on-test", version: "1" });
    try {
      const port = (gw.app.server.address() as { port: number }).port;
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token.token}` } } }));
      const result = await c.callTool({ name: "click", arguments: { controlId: randomUUID(), frameId: randomUUID(), requestId: randomUUID(), x: 1, y: 1, requiresApproval: true } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Explain the irreversible action in reason/);
    } finally { await c.close(); await gw.app.close(); db.close(); }
  });
  it("returns image content, not a path or JSON-embedded screenshot", () => {
    const r = computerResult({ ok: true, frameId: "f", image: "YWJj", mimeType: "image/png" });
    assert.equal(r.content[1]?.type, "image"); assert.ok(!JSON.stringify(r.content[0]).includes("YWJj"));
  });
  it("grants are opt-in and OAuth refresh inherits its client's grant", () => {
    const db = openDb(":memory:"); try {
      const tokens = new LocalTokenService(db); const oauth = new OAuthService(db, tokens);
      const client = oauth.registerClient("test", ["https://example.com/callback"]).clientId;
      const first = tokens.create("oauth-test", "pc.hosted", { oauthClientId: client });
      assert.equal(tokens.lookup(first.token)?.desktopAllowed, false);
      assert.equal(tokens.setDesktopAccess(first.id, true), true);
      assert.equal(tokens.lookup(first.token)?.desktopAllowed, true);
      const refreshed = tokens.create("oauth-test", "pc.hosted", { oauthClientId: client });
      assert.equal(tokens.lookup(refreshed.token)?.desktopAllowed, true);
      // One connector is one desktop owner: a refresh mid-session must not turn its own lease into "another session"
      assert.equal(tokens.lookup(refreshed.token)?.desktopIdentity, tokens.lookup(first.token)?.desktopIdentity);
      assert.equal(tokens.lookup(refreshed.token)?.desktopIdentity, client);
      assert.equal(tokens.desktopAllowed(client), true);
      tokens.revoke(first.id); assert.equal(tokens.desktopAllowed(client), true, "still holds a live token");
      tokens.setDesktopAccess(client, false); assert.equal(tokens.lookup(refreshed.token)?.desktopAllowed, false);
      const local = tokens.create("local"); tokens.setDesktopAccess(local.id, true); assert.equal(tokens.lookup(local.token)?.desktopAllowed, true);
      tokens.revoke(local.id); assert.equal(tokens.desktopAllowed(local.id), false);
      tokens.setDesktopAccess(client, true); oauth.revokeAll(); assert.equal(tokens.lookup(refreshed.token)?.desktopAllowed, false);
      assert.equal(tokens.desktopAllowed(client), false, "a running lease ends once the connector holds no live token");
    } finally { db.close(); }
  });
  it("exposes desktop tools only to explicitly granted credentials over real MCP HTTP", async () => {
    const db = openDb(":memory:"); const gw = await buildGateway({ logLevel: "silent", defaultProjectPath: process.cwd() }, db, { claude: new FakeProvider() });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    const token = gw.localTokens.create("test", "pc.hosted");
    const c = new Client({ name: "desktop-test", version: "1" });
    try {
      const port = (gw.app.server.address() as { port: number }).port;
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token.token}` } } }));
      assert.ok(!(await c.listTools()).tools.some(t => t.name === "click"));
      gw.localTokens.setDesktopAccess(token.id, true);
      const names = (await c.listTools()).tools.map(t => t.name);
      for (const name of ["start_desktop_control", "take_screenshot", "click", "drag", "stop_desktop_control"]) assert.ok(names.includes(name));
      const invalid = await c.callTool({ name: "click", arguments: { controlId: randomUUID(), frameId: randomUUID(), requestId: randomUUID(), x: 1, y: 1 } });
      assert.equal(invalid.isError, true);
      gw.localTokens.setDesktopAccess(token.id, false);
      assert.ok(!(await c.listTools()).tools.some(t => t.name === "click"));
    } finally { await c.close(); await gw.app.close(); db.close(); }
  });
});
