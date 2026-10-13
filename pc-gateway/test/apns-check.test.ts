import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { insideGitRepo, interpretProbe, preflight, type PushSettings } from "../src/notifications/apns-check.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-apns-check-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ecKey = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const keyFile = (name: string, pem: string, dir = tmp) => { const p = path.join(dir, name); fs.writeFileSync(p, pem); return p; };
const good = (over: Partial<PushSettings> = {}): PushSettings => ({ keyPath: keyFile("AuthKey_ABCDE12345.p8", ecKey()), keyId: "ABCDE12345", teamId: "TEAM123456", bundleId: "com.example.helix", ...over });
const byName = (r: { steps: { name: string }[] }, name: string) => r.steps.filter((s) => s.name === name) as any[];

/** A stand-in for Apple that answers every push with a fixed status and reason, and records what it was sent. */
async function fakeApple(status: number, reason?: string) {
  const seen: { path: string; topic: string; type: string; auth: string }[] = [];
  const server = http2.createServer();
  server.on("stream", (s, h) => {
    const stream = s as http2.ServerHttp2Stream;
    stream.resume();
    stream.on("end", () => {
      seen.push({ path: String(h[":path"]), topic: String(h["apns-topic"]), type: String(h["apns-push-type"]), auth: String(h.authorization) });
      stream.respond({ ":status": status, "apns-id": crypto.randomUUID(), "content-type": "application/json" });
      stream.end(reason ? JSON.stringify({ reason }) : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, endpoints: { sandbox: origin, production: origin }, close: () => new Promise<void>((r) => { server.close(() => r()); (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); }) };
}

describe("reading Apple's answer to a fake-token request", () => {
  const r = (status: number, reason?: string) => ({ ok: status === 200, status, reason, invalidToken: false });
  const map: [number, string | undefined, string][] = [
    [400, "BadDeviceToken", "pass"], [410, "Unregistered", "pass"], [400, "DeviceTokenNotForTopic", "pass"],
    [403, "InvalidProviderToken", "fail"], [403, "ExpiredProviderToken", "fail"],
    [400, "TopicDisallowed", "fail"], [400, "BadTopic", "fail"], [400, "MissingTopic", "fail"],
    [429, "TooManyRequests", "warn"], [500, "InternalServerError", "warn"], [0, "ECONNRESET", "fail"],
  ];
  for (const [status, reason, want] of map) {
    it(`${status} ${reason} is a ${want}`, () => assert.equal(interpretProbe("sandbox", "alert", r(status, reason), "com.example.helix").status, want));
  }
  it("a failed token explains the three things that must match; a refused topic names the .voip topic for calls", () => {
    assert.match(interpretProbe("production", "alert", r(403, "InvalidProviderToken"), "com.example.helix").advice!, /Key ID, Team ID and \.p8/);
    assert.match(interpretProbe("sandbox", "voip", r(400, "TopicDisallowed"), "com.example.helix").detail, /com\.example\.helix\.voip/);
  });
});

describe("preflight", () => {
  it("with nothing configured it still checks reachability, and says what is missing", async () => {
    const apple = await fakeApple(400, "BadDeviceToken");
    const res = await preflight({}, { endpoints: apple.endpoints });
    assert.equal(res.ok, false);
    assert.match(byName(res, "settings")[0].detail, /HELIX_APNS_KEY_PATH.*HELIX_APNS_BUNDLE_ID/);
    assert.deepEqual(byName(res, "reach Apple (sandbox)").map((s) => s.status), ["pass"]);
    assert.deepEqual(byName(res, "Apple accepts us").map((s) => s.status), ["skip"]);
    assert.equal(apple.seen.length, 0, "no push is sent without credentials");
    await apple.close();
  });

  it("everything right: key, ids and topics accepted on both environments, for alerts and for calls", async () => {
    const apple = await fakeApple(400, "BadDeviceToken");
    const res = await preflight(good(), { endpoints: apple.endpoints });
    assert.equal(res.ok, true, JSON.stringify(res.steps.filter((s) => s.status !== "pass")));
    assert.deepEqual(res.steps.filter((s) => s.name.startsWith("Apple accepts")).map((s) => s.status), ["pass", "pass", "pass", "pass"]);
    // it asked for the right topics, with a signed token, about a device token that cannot be real
    assert.deepEqual(apple.seen.map((s) => `${s.type}:${s.topic}`).sort(), ["alert:com.example.helix", "alert:com.example.helix", "voip:com.example.helix.voip", "voip:com.example.helix.voip"]);
    assert.ok(apple.seen.every((s) => /^bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(s.auth)));
    assert.ok(apple.seen.every((s) => s.path === `/3/device/${"0".repeat(64)}`));
    await apple.close();
  });

  it("wrong key, team or key id: fails with advice", async () => {
    const apple = await fakeApple(403, "InvalidProviderToken");
    const res = await preflight(good(), { endpoints: apple.endpoints });
    assert.equal(res.ok, false);
    assert.ok(byName(res, "Apple accepts us (sandbox, alert)")[0].advice.includes("belong together"));
    await apple.close();
  });

  it("a bundle id Apple does not allow: fails and says which topic", async () => {
    const apple = await fakeApple(400, "TopicDisallowed");
    const res = await preflight(good(), { endpoints: apple.endpoints });
    assert.equal(res.ok, false);
    assert.match(byName(res, "Apple accepts us (sandbox, voip)")[0].detail, /\.voip/);
    await apple.close();
  });

  it("an unreachable Apple fails each environment with a firewall hint, and skips the credential check", async () => {
    const dead = http2.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((r) => dead.close(() => r()));
    const res = await preflight(good(), { endpoints: { sandbox: origin, production: origin }, timeoutMs: 1500 });
    assert.equal(res.ok, false);
    assert.deepEqual(byName(res, "reach Apple (sandbox)").map((s) => s.status), ["fail"]);
    assert.match(byName(res, "reach Apple (sandbox)")[0].advice, /firewall/i);
    assert.ok(res.steps.filter((s) => s.name.startsWith("Apple accepts us (")).every((s) => s.status === "skip"));
  });

  it("an unreadable, non-key, or wrong-type key file fails before anything is sent", async () => {
    const apple = await fakeApple(400, "BadDeviceToken");
    const missing = await preflight(good({ keyPath: path.join(tmp, "nope.p8") }), { endpoints: apple.endpoints });
    assert.match(byName(missing, "key file")[0].detail, /cannot read/);
    const junk = await preflight(good({ keyPath: keyFile("junk.p8", "not a key at all") }), { endpoints: apple.endpoints });
    assert.match(byName(junk, "key file")[0].detail, /not a usable private key/);
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const wrong = await preflight(good({ keyPath: keyFile("rsa.p8", rsa) }), { endpoints: apple.endpoints });
    assert.match(byName(wrong, "key file")[0].detail, /EC P-256/);
    for (const res of [missing, junk, wrong]) assert.equal(res.ok, false);
    assert.equal(apple.seen.length, 0);
    await apple.close();
  });

  it("flags a key stored inside a git repository, but not one outside", async () => {
    const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, "keys"));
    const inside = keyFile("AuthKey_INSIDE1234.p8", ecKey(), path.join(repo, "keys"));
    assert.equal(insideGitRepo(inside), repo);
    assert.equal(insideGitRepo(keyFile("outside.p8", ecKey())), undefined);
    const apple = await fakeApple(400, "BadDeviceToken");
    const res = await preflight(good({ keyPath: inside }), { endpoints: apple.endpoints });
    assert.equal(byName(res, "key location")[0].status, "warn");
    assert.equal(res.ok, true, "a warning does not fail the check");
    await apple.close();
  });

  it("odd-looking ids are flagged as warnings, not failures", async () => {
    const apple = await fakeApple(400, "BadDeviceToken");
    const res = await preflight(good({ keyId: "short", teamId: "x", bundleId: "nodots" }), { endpoints: apple.endpoints });
    assert.deepEqual(["key id", "team id", "bundle id"].map((n) => byName(res, n)[0].status), ["warn", "warn", "warn"]);
    await apple.close();
  });
});
