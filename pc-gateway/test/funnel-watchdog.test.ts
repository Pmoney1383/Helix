import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FunnelWatchdog, funnelProblem, type CommandResult, type FunnelDeps } from "../src/monitoring/funnel-watchdog.js";
import type { Notice } from "../src/notifications/escalation.js";

const URL_ = "https://pc.tail.ts.net";
const GOOD = `# Funnel on:\n#     - https://pc.tail.ts.net\n\nhttps://pc.tail.ts.net (Funnel on)\n|-- /            proxy http://127.0.0.1:7777\n|-- /mcp         proxy http://127.0.0.1:7777/mcp\n|-- /oauth       proxy http://127.0.0.1:7777/oauth\n|-- /.well-known proxy http://127.0.0.1:7777/.well-known\n`;
const RUNNING = JSON.stringify({ BackendState: "Running", Self: { Online: true } });
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

function rig(opts: { probes: boolean[]; funnelText?: string; status?: string; repairFails?: boolean }) {
  const notices: Notice[] = [];
  const cmds: string[][] = [];
  let probes = [...opts.probes];
  let funnelText = opts.funnelText ?? GOOD;
  let t = 1_000_000;
  const deps: FunnelDeps = {
    probe: async () => ({ ok: probes.length > 1 ? probes.shift()! : probes[0]!, error: "ETIMEDOUT" }),
    tailscale: async (args) => {
      cmds.push(args);
      if (args[0] === "status") return ok(opts.status ?? RUNNING);
      if (args[0] === "funnel" && args[1] === "status") return ok(funnelText);
      if (args[1] === "--bg") { if (opts.repairFails) return { code: 1, stdout: "", stderr: "denied" }; funnelText = GOOD; return ok(); }
      return ok();
    },
    notify: async (n) => { notices.push(n); },
    now: () => t,
  };
  const w = new FunnelWatchdog(deps, { publicUrl: URL_, port: 7777, failThreshold: 2, repairCooldownMs: 600_000, renotifyMs: 3_600_000 });
  return { w, notices, cmds, advance: (ms: number) => { t += ms; }, setProbes: (p: boolean[]) => { probes = p; }, breakFunnel: () => { funnelText = "No serve config\n"; } };
}

describe("reading `tailscale funnel status`", () => {
  it("accepts the documented layout and names what is wrong otherwise", () => {
    assert.equal(funnelProblem(GOOD, "pc.tail.ts.net"), undefined);
    assert.match(funnelProblem("No serve config\n", "pc.tail.ts.net")!, /not serving/);
    assert.match(funnelProblem(GOOD.replace("(Funnel on)", "(tailnet only)"), "pc.tail.ts.net")!, /switched off/);
    assert.match(funnelProblem(GOOD.replace(/\|-- \/oauth.*\n/, ""), "pc.tail.ts.net")!, /missing \/oauth/);
  });
});

describe("funnel watchdog", () => {
  it("stays quiet while the public address answers", async () => {
    const r = rig({ probes: [true] });
    for (let i = 0; i < 3; i++) await r.w.tick();
    assert.equal(r.notices.length, 0);
    assert.equal(r.cmds.length, 0, "nothing is run while healthy");
    assert.equal(r.w.status().state, "up");
  });

  it("puts missing Funnel paths back by itself and says so quietly", async () => {
    const r = rig({ probes: [false, true], funnelText: GOOD.replace(/\|-- \/mcp .*\n/, "") });
    await r.w.tick();
    const sets = r.cmds.filter((c) => c[1] === "--bg");
    assert.equal(sets.length, 3);
    assert.deepEqual(sets[0], ["funnel", "--bg", "--https=443", "--set-path=/mcp", "http://127.0.0.1:7777/mcp"]);
    assert.equal(r.w.status().state, "up");
    assert.deepEqual(r.notices.map((n) => n.severity), ["info"]);
  });

  it("tells the user once when it cannot be fixed, not on every check, and again when it is back", async () => {
    const r = rig({ probes: [false], status: JSON.stringify({ BackendState: "Stopped" }) });
    await r.w.tick();
    assert.equal(r.notices.length, 0, "one failed check is not an outage yet");
    r.advance(120_000); await r.w.tick();
    assert.equal(r.notices.length, 1);
    assert.equal(r.notices[0]!.severity, "important");
    assert.match(r.notices[0]!.body, /Tailscale is not running \(Stopped\)/);
    assert.equal(r.cmds.filter((c) => c[1] === "--bg").length, 0, "no repair when Tailscale itself is down");
    r.advance(120_000); await r.w.tick(); r.advance(120_000); await r.w.tick();
    assert.equal(r.notices.length, 1, "no repeat spam");
    r.setProbes([true]); r.advance(120_000); await r.w.tick();
    assert.equal(r.notices.length, 2);
    assert.match(r.notices[1]!.title, /again/);
    assert.equal(r.w.status().state, "up");
  });

  it("reminds about an outage that goes on, but only after the re-notify window", async () => {
    const r = rig({ probes: [false], status: JSON.stringify({ BackendState: "Stopped" }) });
    await r.w.tick(); r.advance(60_000); await r.w.tick();
    assert.equal(r.notices.length, 1);
    r.advance(3_700_000); await r.w.tick();
    assert.equal(r.notices.length, 2);
  });

  it("does not hammer repairs: one attempt per cooldown", async () => {
    const r = rig({ probes: [false], funnelText: "No serve config\n", repairFails: true });
    await r.w.tick(); r.advance(60_000); await r.w.tick(); r.advance(60_000); await r.w.tick();
    assert.equal(r.cmds.filter((c) => c[1] === "--bg").length, 1, "the first failing command ends that attempt, and it is not retried within the cooldown");
    assert.equal(r.notices.length, 1);
  });

  it("a probe failure with healthy Tailscale and Funnel is reported as the address not answering", async () => {
    const r = rig({ probes: [false] });
    await r.w.tick(); r.advance(60_000); await r.w.tick();
    assert.match(r.notices[0]!.body, /does not answer \(ETIMEDOUT\)/);
    assert.equal(r.cmds.filter((c) => c[1] === "--bg").length, 0, "nothing to repair");
  });
});
