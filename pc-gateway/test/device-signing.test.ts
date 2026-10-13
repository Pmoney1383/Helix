import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import os from "node:os";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway } from "../src/app.js";
import { NonceCache, enrollmentMessage, isP256PublicKey, signingString, verifySignature } from "../src/api/device-signing.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb } from "../src/storage/sqlite.js";

const newKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, publicB64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
};
type Key = ReturnType<typeof newKey>;
const sign = (priv: KeyObject, msg: string, enc: "ieee-p1363" | "der" = "ieee-p1363") => cryptoSign("sha256", Buffer.from(msg), { key: priv, dsaEncoding: enc }).toString("base64");
const proofFor = (k: Key) => sign(k.privateKey, enrollmentMessage(k.publicB64));
const hex = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

async function rig(requireSigning = false) {
  const db = openDb(":memory:");
  const gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent", requireDeviceSigning: requireSigning }, db, { claude: new FakeProvider() });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (gw.app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const pairDevice = async (extra: object = {}) => {
    const { code } = gw.auth.createPairingCode();
    const r = await post("/v1/pair/complete", { code, deviceName: "phone", ...extra });
    return { status: r.status, json: (await r.json()) as any };
  };
  /** A request signed like the app would: deviceId and key from the pairing. */
  const call = async (token: string, deviceId: string, key: Key | undefined, method: string, url: string, body?: unknown, tweak: { ts?: number; nonce?: string; bodyHash?: string; url?: string } = {}) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) {
      const ts = String(tweak.ts ?? Date.now());
      const nonce = tweak.nonce ?? randomBytes(12).toString("base64url");
      const bodyHash = tweak.bodyHash ?? hex(raw);
      headers["x-helix-timestamp"] = ts;
      headers["x-helix-nonce"] = nonce;
      headers["x-helix-body-sha256"] = bodyHash;
      headers["x-helix-signature"] = sign(key.privateKey, signingString({ method, url: tweak.url ?? url, timestamp: ts, nonce, bodySha256: bodyHash, deviceId }));
    }
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : raw });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  return { gw, db, port, base, post, pairDevice, call, close: () => gw.app.close() };
}

describe("device-key signing: the building blocks", () => {
  it("builds the signing string from seven lines", () => {
    assert.equal(
      signingString({ method: "post", url: "/v1/x?a=1", timestamp: "1700000000000", nonce: "n".repeat(16), bodySha256: "ab", deviceId: "dev" }),
      ["HELIX-SIGN-V1", "POST", "/v1/x?a=1", "1700000000000", "n".repeat(16), "ab", "dev"].join("\n")
    );
  });

  it("accepts only P-256 public keys, and checks both signature encodings", () => {
    const k = newKey();
    assert.equal(isP256PublicKey(k.publicB64), true);
    assert.equal(isP256PublicKey("not a key"), false);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    assert.equal(isP256PublicKey(rsa), false);
    assert.equal(verifySignature(k.publicB64, "hello", sign(k.privateKey, "hello", "ieee-p1363")), true);
    assert.equal(verifySignature(k.publicB64, "hello", sign(k.privateKey, "hello", "der")), true);
    assert.equal(verifySignature(k.publicB64, "hello!", sign(k.privateKey, "hello")), false);
    assert.equal(verifySignature(k.publicB64, "hello", "garbage"), false);
  });

  it("remembers a nonce per device until it expires", () => {
    const c = new NonceCache(1000, 100);
    assert.equal(c.use("d1", "a", 0), true);
    assert.equal(c.use("d1", "a", 10), false);
    assert.equal(c.use("d2", "a", 10), true, "another device may use the same nonce");
    assert.equal(c.use("d1", "a", 5000), true, "forgotten after the ttl");
  });
});

describe("device-key signing: enrolling", () => {
  it("a device without a key keeps working, can enroll one, and only once", async () => {
    const r = await rig();
    try {
      const p = await r.pairDevice();
      assert.equal(p.json.signing.enrolled, false);
      assert.equal((await r.call(p.json.token, p.json.deviceId, undefined, "GET", "/v1/sessions")).status, 200);
      assert.deepEqual((await r.call(p.json.token, p.json.deviceId, undefined, "GET", "/v1/devices/me/key")).json, { enrolled: false, required: false });

      const k = newKey();
      assert.equal((await r.call(p.json.token, p.json.deviceId, undefined, "PUT", "/v1/devices/me/key", { publicKey: k.publicB64, keyProof: "A".repeat(88) })).json.error, "bad_proof");
      const other = newKey();
      assert.equal((await r.call(p.json.token, p.json.deviceId, undefined, "PUT", "/v1/devices/me/key", { publicKey: k.publicB64, keyProof: proofFor(other) })).json.error, "bad_proof", "proof from a different key");
      assert.equal((await r.call(p.json.token, p.json.deviceId, undefined, "PUT", "/v1/devices/me/key", { publicKey: "A".repeat(120), keyProof: proofFor(k) })).json.error, "bad_key");

      const { code: pairingCode } = r.gw.auth.createPairingCode();
      assert.equal((await r.call(p.json.token, p.json.deviceId, undefined, "PUT", "/v1/devices/me/key", { publicKey: k.publicB64, keyProof: proofFor(k), pairingCode })).status, 200);
      const again = await r.call(p.json.token, p.json.deviceId, k, "PUT", "/v1/devices/me/key", { publicKey: other.publicB64, keyProof: proofFor(other) });
      assert.equal(again.status, 409, "a key cannot be swapped by whoever holds the token");
      const st = await r.call(p.json.token, p.json.deviceId, k, "GET", "/v1/devices/me/key");
      assert.equal(st.json.enrolled, true);
    } finally { await r.close(); }
  });

  it("can enroll while pairing, and a bad key does not use up the pairing code", async () => {
    const r = await rig();
    try {
      const k = newKey();
      const { code } = r.gw.auth.createPairingCode();
      const bad = await r.post("/v1/pair/complete", { code, deviceName: "phone", publicKey: k.publicB64, keyProof: "A".repeat(88) });
      assert.equal(bad.status, 400);
      const good = await r.post("/v1/pair/complete", { code, deviceName: "phone", publicKey: k.publicB64, keyProof: proofFor(k) });
      assert.equal(good.status, 200, "the same code still works");
      const j = (await good.json()) as any;
      assert.equal(j.signing.enrolled, true);
      assert.equal((await r.call(j.token, j.deviceId, undefined, "GET", "/v1/sessions")).json.error, "signature_required");
      assert.equal((await r.call(j.token, j.deviceId, k, "GET", "/v1/sessions")).status, 200);
    } finally { await r.close(); }
  });
});

describe("device-key signing: enforcement once a key is enrolled", () => {
  const enrolled = async (requireSigning = false) => {
    const r = await rig(requireSigning);
    const k = newKey();
    const { code } = r.gw.auth.createPairingCode();
    const j = (await (await r.post("/v1/pair/complete", { code, deviceName: "phone", publicKey: k.publicB64, keyProof: proofFor(k) })).json()) as any;
    return { r, k, token: j.token as string, id: j.deviceId as string };
  };

  it("refuses unsigned requests, replays, stale timestamps, tampered bodies and other keys", async () => {
    const { r, k, token, id } = await enrolled();
    try {
      assert.equal((await r.call(token, id, undefined, "GET", "/v1/sessions")).json.error, "signature_required");
      assert.equal((await r.call(token, id, k, "GET", "/v1/sessions")).status, 200);

      const nonce = randomBytes(12).toString("base64url");
      assert.equal((await r.call(token, id, k, "GET", "/v1/sessions", undefined, { nonce })).status, 200);
      assert.equal((await r.call(token, id, k, "GET", "/v1/sessions", undefined, { nonce })).json.error, "replayed");

      assert.equal((await r.call(token, id, k, "GET", "/v1/sessions", undefined, { ts: Date.now() - 10 * 60_000 })).json.error, "bad_timestamp");
      assert.equal((await r.call(token, id, k, "GET", "/v1/sessions", undefined, { nonce: "short" })).json.error, "bad_nonce");

      // The signature covers the URL as sent: signing one URL and requesting another fails.
      assert.equal((await r.call(token, id, k, "GET", "/v1/sessions?x=1", undefined, { url: "/v1/sessions" })).json.error, "bad_signature");

      const stranger = newKey();
      assert.equal((await r.call(token, id, stranger, "GET", "/v1/sessions")).json.error, "bad_signature");
    } finally { await r.close(); }
  });

  it("binds the signature to the exact body", async () => {
    const { r, k, token, id } = await enrolled();
    try {
      const good = await r.call(token, id, k, "POST", "/v1/sessions", { title: "x", provider: "claude", projectPath: os.tmpdir() });
      assert.notEqual(good.status, 401, "a correctly signed POST gets past authentication");
      // Header claims the hash of a different body: refused before the handler runs.
      const forged = await r.call(token, id, k, "POST", "/v1/sessions", { title: "x", provider: "claude", projectPath: os.tmpdir() }, { bodyHash: hex("{}") });
      assert.equal(forged.json.error, "body_mismatch");
    } finally { await r.close(); }
  });

  it("signs the WebSocket upgrade too", async () => {
    const { r, k, token, id } = await enrolled();
    try {
      const open = (signed: boolean) => new Promise<"open" | number>((resolve) => {
        const ts = String(Date.now()), nonce = randomBytes(12).toString("base64url"), bodyHash = hex("");
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        if (signed) Object.assign(headers, { "x-helix-timestamp": ts, "x-helix-nonce": nonce, "x-helix-body-sha256": bodyHash, "x-helix-signature": sign(k.privateKey, signingString({ method: "GET", url: "/v1/ws", timestamp: ts, nonce, bodySha256: bodyHash, deviceId: id })) });
        const ws = new WebSocket(`ws://127.0.0.1:${r.port}/v1/ws`, { headers });
        ws.on("open", () => { ws.close(); resolve("open"); });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => undefined);
      });
      assert.equal(await open(false), 401);
      assert.equal(await open(true), "open");
    } finally { await r.close(); }
  });

  it("another device without a key is unaffected unless signing is required", async () => {
    const { r } = await enrolled();
    try {
      const p = await r.pairDevice();
      assert.equal((await r.call(p.json.token, p.json.deviceId, undefined, "GET", "/v1/sessions")).status, 200);
    } finally { await r.close(); }
    const strict = await enrolled(true);
    try {
      const p = await strict.r.pairDevice();
      assert.equal(p.status, 400);
      assert.equal(p.json.error, "key_required", "new devices must bring a key");
      // Legacy status/enrollment remain reachable, but enrollment needs fresh local authorization.
      const { code } = strict.r.gw.auth.createPairingCode();
      const legacy = strict.r.gw.auth.completePairing(code, "old phone")!;
      assert.equal((await strict.r.call(legacy.token, legacy.deviceId, undefined, "GET", "/v1/sessions")).json.error, "key_required");
      assert.equal((await strict.r.call(legacy.token, legacy.deviceId, undefined, "GET", "/v1/devices/me/key")).status, 200);
      const k2 = newKey();
      assert.equal((await strict.r.call(legacy.token, legacy.deviceId, undefined, "PUT", "/v1/devices/me/key", { publicKey: k2.publicB64, keyProof: proofFor(k2) })).json.error, "pairing_required");
      const { code: pairingCode } = strict.r.gw.auth.createPairingCode();
      assert.equal((await strict.r.call(legacy.token, legacy.deviceId, undefined, "PUT", "/v1/devices/me/key", { publicKey: k2.publicB64, keyProof: proofFor(k2), pairingCode })).status, 200);
      assert.equal((await strict.r.call(legacy.token, legacy.deviceId, k2, "GET", "/v1/sessions")).status, 200);
    } finally { await strict.r.close(); }
  });

  it("records rejected signatures in the audit log", async () => {
    const { r, token, id } = await enrolled();
    try {
      await r.call(token, id, undefined, "GET", "/v1/sessions");
      const row = r.db.prepare("SELECT detail FROM audit_log WHERE action = 'device.signature_rejected' AND device_id = ?").get(id) as { detail: string } | undefined;
      assert.ok(row && JSON.parse(row.detail).reason === "signature_required");
    } finally { await r.close(); }
  });
});
