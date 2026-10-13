import assert from "node:assert/strict";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway, type Gateway } from "../src/app.js";
import type { AgentEvent, AgentProvider, SendOptions } from "../src/providers/provider.js";
import { openDb } from "../src/storage/sqlite.js";
import type { GatewayEvent } from "../src/types.js";

/** An agent that replies with whatever the script says, streamed in small pieces, optionally using a tool in the middle. */
class Scripted implements AgentProvider {
  readonly name = "claude" as const;
  script: (string | { tool: string })[] = [];
  async createSession() { return { providerSessionId: crypto.randomUUID() }; }
  async *send(o: SendOptions): AsyncGenerator<AgentEvent> {
    let full = "";
    for (const step of this.script) {
      if (typeof step !== "string") { yield { type: "tool", name: step.tool }; continue; }
      for (const piece of step.match(/[\s\S]{1,7}/g) ?? []) {
        if (o.signal.aborted) return;
        full += piece;
        yield { type: "delta", text: piece };
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    yield { type: "final", text: full };
  }
}

describe("spoken replies: speech-ready sentences while the reply streams", () => {
  const agent = new Scripted();
  let gw: Gateway;
  let base: string;
  let token: string;
  let events: GatewayEvent[] = [];

  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const until = async (fn: () => boolean, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
  const turn = async (body: Record<string, unknown>, script: (string | { tool: string })[]) => {
    agent.script = script;
    events = [];
    const s = (await api("POST", "/v1/sessions", { title: "voice", projectPath: os.tmpdir() })).json;
    const r = await api("POST", `/v1/sessions/${s.id}/message`, body);
    await until(() => !gw.manager.isRunning(s.id));
    return { sessionId: s.id, turnId: r.json.turnId as string };
  };
  const speech = () => events.filter((e): e is Extract<GatewayEvent, { type: "agent.speech" }> => e.type === "agent.speech");
  const final = () => events.find((e): e is Extract<GatewayEvent, { type: "agent.output.final" }> => e.type === "agent.output.final");

  before(async () => {
    gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, openDb(":memory:"), { claude: agent });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
    const { code } = gw.auth.createPairingCode();
    token = ((await (await fetch(base + "/v1/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "p" }) })).json()) as any).token;
    gw.manager.bus.subscribe((e) => events.push(e));
  });
  after(async () => { await gw.app.close(); });

  const MESSY = "## Status\nThe run is **healthy** 🎉 and the log is at C:\\runs\\train.log now.\n- Loss is 0.184 at step 84,231\n- See [the dashboard](https://x.test/d)\nAll good, e.g. nothing to fix.";

  it("a voice message streams clean sentences in order, then the whole reply cleaned up", async () => {
    const t = await turn({ text: "status?", voice: true }, [MESSY]);
    const sentences = speech();
    assert.deepEqual(sentences.map((s) => s.seq), sentences.map((_, i) => i), "numbered from 0 within the turn");
    assert.ok(sentences.every((s) => s.sessionId === t.sessionId && s.turnId === t.turnId));
    const joined = sentences.map((s) => s.text).join(" ");
    assert.equal(joined, "Status. The run is healthy and the log is at train.log now. Loss is 0.184 at step 84,231. See the dashboard. All good, e.g. nothing to fix.");
    for (const s of sentences) assert.doesNotMatch(s.text, /[*#`|\[\]]|https?:|C:\\|🎉/, s.text);
    assert.equal(final()!.spoken, joined, "the one-shot version agrees with the sentences");
    assert.match(final()!.text, /\*\*healthy\*\*/, "the written reply keeps its markdown for the chat");
  });

  it("the first sentence is out before the reply has finished streaming", async () => {
    agent.script = ["The run finished cleanly overnight. ", "Loss ended at 0.184. ", "Disk is fine too."];
    events = [];
    const s = (await api("POST", "/v1/sessions", { title: "voice2", projectPath: os.tmpdir() })).json;
    await api("POST", `/v1/sessions/${s.id}/message`, { text: "go", voice: true });
    await until(() => speech().length >= 1);
    assert.ok(gw.manager.isRunning(s.id), "still streaming when the first sentence arrived");
    await until(() => !gw.manager.isRunning(s.id));
    assert.equal(speech().length, 3);
  });

  it("a tool call ends the sentence in progress, so narration is not glued to the next message", async () => {
    await turn({ text: "check", voice: true }, ["Let me check the logs", { tool: "shell" }, "Found it, the run is healthy."]);
    assert.deepEqual(speech().map((s) => s.text), ["Let me check the logs.", "Found it, the run is healthy."]);
  });

  it("code is never read aloud", async () => {
    await turn({ text: "fix", voice: true }, ["Here is the change.\n```ts\nrm -rf /\n```\nThat is all."]);
    assert.deepEqual(speech().map((s) => s.text), ["Here is the change.", "There is some code in the chat.", "That is all."]);
  });

  it("typed (non-voice) messages produce no speech events and no spoken text", async () => {
    await turn({ text: "status?" }, [MESSY]);
    assert.equal(speech().length, 0);
    assert.equal(final()!.spoken, undefined);
  });

  it("an interrupted voice turn speaks nothing more", async () => {
    agent.script = ["First sentence is quite long here. ".repeat(40)];
    events = [];
    const s = (await api("POST", "/v1/sessions", { title: "voice3", projectPath: os.tmpdir() })).json;
    await api("POST", `/v1/sessions/${s.id}/message`, { text: "talk", voice: true });
    await until(() => speech().length >= 1);
    await api("POST", `/v1/sessions/${s.id}/interrupt`);
    await until(() => !gw.manager.isRunning(s.id));
    const n = speech().length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(speech().length, n, "nothing after the interrupt");
    assert.ok(n < 40, "stopped well before the end");
    assert.equal(final(), undefined);
  });

  it("speech events reach the phone over the WebSocket, with the same shape", async () => {
    agent.script = ["Hello from the websocket test. Second sentence is here."];
    const s = (await api("POST", "/v1/sessions", { title: "voice4", projectPath: os.tmpdir() })).json;
    const ws = new WebSocket(base.replace("http", "ws") + "/v1/ws", { headers: { authorization: `Bearer ${token}` } });
    const got: any[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "send", sessionId: s.id, text: "hi", voice: true }));
    await until(() => got.some((m) => m.type === "agent.output.final"));
    const spoken = got.filter((m) => m.type === "agent.speech");
    assert.deepEqual(spoken.map((m) => m.text), ["Hello from the websocket test.", "Second sentence is here."]);
    assert.ok(got.find((m) => m.type === "agent.output.final").spoken);
    ws.close();
  });
});
