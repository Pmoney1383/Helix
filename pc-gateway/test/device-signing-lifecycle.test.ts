import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { buildGateway } from "../src/app.js";
import { AuthService } from "../src/api/auth.js";
import {
  EMPTY_BODY_SHA256, NonceCache, PersistentNonceStore, SKEW_MS, checkSignature,
  enrollmentMessage, signingString,
} from "../src/api/device-signing.js";
import { FakeProvider } from "../src/providers/fake.js";
import { openDb, type Db } from "../src/storage/sqlite.js";

function key() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const signature = (message: string) => sign("sha256", Buffer.from(message), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return { publicB64, signature, proof: signature(enrollmentMessage(publicB64)) };
}

function signedRequest(deviceId: string, k: ReturnType<typeof key>, url = "/v1/sessions", now = Date.now(), nonce = randomBytes(12).toString("base64url")) {
  const timestamp = String(now);
  return {
    method: "GET", url, deviceId, actualBodySha256: EMPTY_BODY_SHA256,
    headers: {
      "x-helix-timestamp": timestamp, "x-helix-nonce": nonce, "x-helix-body-sha256": EMPTY_BODY_SHA256,
      "x-helix-signature": k.signature(signingString({ method: "GET", url, timestamp, nonce, bodySha256: EMPTY_BODY_SHA256, deviceId })),
    },
  };
}

function pair(auth: AuthService, publicKey?: string) {
  const { code } = auth.createPairingCode();
  return auth.completePairing(code, "test phone", "android", publicKey)!;
}

describe("device signing: durable and bounded replay protection", () => {
  it("retains replay markers after closing/reopening the database and through the future timestamp boundary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-signing-restart-"));
    let db: Db | undefined;
    try {
      const file = path.join(tmp, "test.db");
      db = openDb(file);
      let auth = new AuthService(db);
      const k = key(), p = pair(auth, k.publicB64);
      const request = signedRequest(p.deviceId, k, "/v1/sessions", Date.now() + SKEW_MS - 1000);
      assert.equal(auth.verifyRequest(auth.authenticate(p.token)!, request), undefined);
      db.close();
      db = openDb(file);
      auth = new AuthService(db);
      assert.equal(auth.verifyRequest(auth.authenticate(p.token)!, request), "replayed");
      const restarted = new PersistentNonceStore(db);
      assert.equal(checkSignature(request, k.publicB64, restarted, Number(request.headers["x-helix-timestamp"]) + SKEW_MS), "replayed");
      assert.equal(checkSignature(request, k.publicB64, restarted, Number(request.headers["x-helix-timestamp"]) + SKEW_MS + 1), "bad_timestamp");
      assert.equal(auth.verifyRequest(auth.authenticate(p.token)!, signedRequest(p.deviceId, k)), undefined);
    } finally {
      if (db?.open) db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shares nonce uniqueness across independently opened database connections", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helix-signing-shared-"));
    const first = openDb(path.join(tmp, "test.db"));
    let second: Db | undefined;
    try {
      const a = new AuthService(first), k = key(), p = pair(a, k.publicB64);
      second = openDb(path.join(tmp, "test.db"));
      const b = new AuthService(second), request = signedRequest(p.deviceId, k);
      assert.equal(a.verifyRequest(a.authenticate(p.token)!, request), undefined);
      assert.equal(b.verifyRequest(b.authenticate(p.token)!, request), "replayed");
    } finally {
      second?.close(); first.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const kind of ["memory", "persistent"] as const) {
    it(`${kind}: capacity never evicts live nonces, including the oldest duplicate and cross-device pressure`, () => {
      const db = openDb(":memory:");
      try {
        const auth = new AuthService(db), a = pair(auth), b = pair(auth);
        const store = kind === "memory" ? new NonceCache(1000, 2) : new PersistentNonceStore(db, 1000, 2);
        assert.equal(store.use(a.deviceId, "a", 0), true);
        assert.equal(store.use(b.deviceId, "b", 100), true);
        assert.equal(store.use(a.deviceId, "a", 200), false);
        assert.equal(store.use(b.deviceId, "c", 200), "full");
        assert.equal(store.use(b.deviceId, "b", 200), false);
        assert.equal(store.use(a.deviceId, "a", 999), false);
        assert.equal(store.use(b.deviceId, "c", 1000), true, "admit after expiry only");
        assert.equal(store.use(b.deviceId, "b", 1000), false, "another live marker remains protected");
      } finally { db.close(); }
    });
  }

  it("invalid signatures cannot reserve nonces and storage failures fail closed", () => {
    const db = openDb(":memory:");
    try {
      const auth = new AuthService(db), k = key(), p = pair(auth, k.publicB64);
      const device = auth.authenticate(p.token)!, request = signedRequest(p.deviceId, k);
      const invalid = { ...request, headers: { ...request.headers, "x-helix-signature": "invalid" } };
      assert.equal(auth.verifyRequest(device, invalid), "bad_signature");
      assert.equal(auth.verifyRequest(device, request), undefined);
      db.pragma("query_only = ON");
      assert.throws(() => auth.verifyRequest(device, signedRequest(p.deviceId, k)), /readonly/i);
    } finally { db.close(); }
  });
});

describe("device signing: legacy enrollment requires independent authorization", () => {
  for (const requireSigning of [false, true]) {
    it(`rejects bearer-only enrollment and consumes a local code once (required=${requireSigning})`, () => {
      const db = openDb(":memory:");
      try {
        const auth = new AuthService(db, { requireSigning }), a = pair(auth), b = pair(auth), k = key();
        assert.equal(auth.enrollKey(a.deviceId, k.publicB64, k.proof), "pairing_required");
        assert.equal(auth.enrollKey(a.deviceId, k.publicB64, k.proof, "WRONGCODE"), "invalid_pairing_code");
        assert.equal(auth.keyStatus(a.deviceId).enrolled, false);
        const expired = auth.createPairingCode();
        db.prepare("UPDATE pairing_codes SET expires_at = ? WHERE used_at IS NULL").run(new Date(0).toISOString());
        assert.equal(auth.enrollKey(a.deviceId, k.publicB64, k.proof, expired.code), "invalid_pairing_code");
        const fresh = auth.createPairingCode();
        assert.equal(auth.enrollKey(a.deviceId, k.publicB64, "invalid", fresh.code), "bad_proof");
        assert.equal(auth.enrollKey(a.deviceId, k.publicB64, k.proof, fresh.code), "ok", "bad proof did not consume authorization");
        assert.equal(auth.enrollKey(b.deviceId, k.publicB64, k.proof, fresh.code), "invalid_pairing_code");
        assert.equal(auth.completePairing(fresh.code, "other phone"), undefined, "enrollment authorization cannot also pair a device");
        const other = key(), unused = auth.createPairingCode();
        assert.equal(auth.enrollKey(a.deviceId, other.publicB64, other.proof, unused.code), "already_enrolled");
        assert.equal(auth.enrollKey(b.deviceId, other.publicB64, other.proof, unused.code), "ok", "failed key replacement did not consume code");
      } finally { db.close(); }
    });
  }
});

async function socketRig() {
  const db = openDb(":memory:");
  const gw = await buildGateway({ defaultProjectPath: os.tmpdir(), logLevel: "silent" }, db, { claude: new FakeProvider() });
  await gw.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (gw.app.server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  const connect = async (p: ReturnType<typeof pair>, k?: ReturnType<typeof key>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
      headers: { authorization: `Bearer ${p.token}`, ...(k ? signedRequest(p.deviceId, k, "/v1/ws").headers : {}) },
    });
    sockets.push(ws);
    const events: any[] = [];
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    const hello = once(ws, "message");
    await once(ws, "open");
    await hello;
    return { ws, events };
  };
  return {
    gw, db, port, connect,
    liveCount: async (p: ReturnType<typeof pair>, k?: ReturnType<typeof key>) => {
      const url = "/v1/push/status";
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { headers: {
        authorization: `Bearer ${p.token}`, ...(k ? signedRequest(p.deviceId, k, url).headers : {}),
      } });
      assert.equal(response.status, 200);
      return ((await response.json()) as { androidConnected: number }).androidConnected;
    },
    close: async () => { for (const s of sockets) s.terminate(); await gw.app.close(); db.close(); },
  };
}

describe("device signing: live WebSocket authorization", () => {
  it("revocation immediately detaches every affected socket and leaves other devices connected", async () => {
    const r = await socketRig();
    try {
      const k = key(), a = pair(r.gw.auth, k.publicB64), b = pair(r.gw.auth);
      const one = await r.connect(a, k), two = await r.connect(a, k), other = await r.connect(b);
      const closed = [once(one.ws, "close"), once(two.ws, "close")];
      const before = r.gw.manager.bus.listenerCount("event");
      assert.equal(await r.liveCount(b), 2);
      assert.equal(r.gw.auth.revoke(a.deviceId), true);
      assert.equal(r.gw.manager.bus.listenerCount("event"), before - 2, "unsubscribe before close handshake completes");
      assert.equal(await r.liveCount(b), 1);
      const received = once(other.ws, "message");
      r.gw.manager.bus.publish({ type: "agent.output.delta", sessionId: "test", turnId: "test", text: "test event" });
      const results = await Promise.all(closed);
      assert.ok(results.every(([code]) => code === 1008));
      await received;
      assert.equal(one.events.length, 1, "revoked connection receives only its original hello");
      assert.equal(two.events.length, 1);
      assert.equal(other.events.at(-1).type, "agent.output.delta");
    } finally { await r.close(); }
  });

  it("enrollment ejects old bearer-only sockets and a new signed connection works", async () => {
    const r = await socketRig();
    try {
      const p = pair(r.gw.auth), k = key(), old = await r.connect(p);
      const closed = once(old.ws, "close"), { code } = r.gw.auth.createPairingCode();
      assert.equal(r.gw.auth.enrollKey(p.deviceId, k.publicB64, k.proof, code), "ok");
      assert.equal(await r.liveCount(p, k), 0);
      assert.equal((await closed)[0], 1008);
      const current = await r.connect(p, k), pong = once(current.ws, "message");
      current.ws.send(JSON.stringify({ type: "ping" }));
      assert.equal(JSON.parse(String((await pong)[0])).type, "pong");
    } finally { await r.close(); }
  });

  for (const trigger of ["command", "event"] as const) {
    it(`rechecks database authorization before ${trigger} processing even without an in-process notification`, async () => {
      const r = await socketRig();
      try {
        const p = pair(r.gw.auth), connected = await r.connect(p);
        const closed = once(connected.ws, "close");
        let dispatched = false;
        r.gw.manager.interrupt = () => { dispatched = true; return false; };
        r.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), p.deviceId);
        if (trigger === "command") connected.ws.send(JSON.stringify({ type: "interrupt", sessionId: "test" }));
        else r.gw.manager.bus.publish({ type: "agent.output.delta", sessionId: "test", turnId: "test", text: "test event" });
        assert.equal((await closed)[0], 1008);
        assert.equal(dispatched, false);
        assert.equal(connected.events.length, 1);
      } finally { await r.close(); }
    });
  }

  it("returns retryable capacity errors without forgetting accepted requests", async () => {
    const r = await socketRig();
    try {
      const k = key(), p = pair(r.gw.auth, k.publicB64);
      const insert = r.db.prepare("INSERT INTO device_request_nonces (device_id, nonce, expires_at_ms) VALUES (?, ?, ?)");
      r.db.transaction(() => { for (let i = 0; i < 20_000; i++) insert.run(p.deviceId, `nonce${i}`, Date.now() + 300_000); })();
      const request = signedRequest(p.deviceId, k);
      const response = await fetch(`http://127.0.0.1:${r.port}${request.url}`, { headers: { authorization: `Bearer ${p.token}`, ...request.headers } });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "60");
      assert.deepEqual(await response.json(), { error: "nonce_capacity" });
      assert.equal((r.db.prepare("SELECT COUNT(*) AS n FROM device_request_nonces").get() as { n: number }).n, 20_000);
    } finally { await r.close(); }
  });
});
