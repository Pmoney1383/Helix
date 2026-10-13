// A preflight for Apple push, runnable before any phone exists. It answers "will Apple accept us?" in plain language:
// is the .p8 usable, is Apple reachable from this PC, and do Apple's servers accept the key, team and bundle id.
//
// The trick for the last part: Apple checks the provider token and the topic BEFORE it looks at the device token. So a
// request with an obviously fake device token comes back "BadDeviceToken" (400) exactly when everything else is right,
// and "InvalidProviderToken" (403) or "TopicDisallowed" (400) when it is not. No real phone is needed to find out.
import fs from "node:fs";
import crypto from "node:crypto";
import http2 from "node:http2";
import path from "node:path";
import { ApnsClient, type ApnsEnvironment, type ApnsResult } from "./apns.js";

export interface PushSettings {
  keyPath?: string;
  keyId?: string;
  teamId?: string;
  bundleId?: string;
}

export type StepStatus = "pass" | "warn" | "fail" | "skip";
export interface Step {
  name: string;
  status: StepStatus;
  detail: string;
  /** What to do about it, when it is not a pass. */
  advice?: string;
}

export interface Preflight {
  ok: boolean;
  steps: Step[];
}

export interface PreflightOptions {
  /** Overridable so tests can point at a local server. */
  endpoints?: Record<ApnsEnvironment, string>;
  /** A device token that is certainly not real. */
  probeToken?: string;
  timeoutMs?: number;
  /** Also try the network step when credentials are incomplete (reachability needs none). Default true. */
  networkAlways?: boolean;
}

const APPLE = { sandbox: "https://api.sandbox.push.apple.com", production: "https://api.push.apple.com" } satisfies Record<ApnsEnvironment, string>;
const FAKE_TOKEN = "0".repeat(64);

const step = (name: string, status: StepStatus, detail: string, advice?: string): Step => ({ name, status, detail, advice });

/** Walks up from a file looking for a git repository, so a key stored inside one can be flagged. */
export function insideGitRepo(file: string): string | undefined {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function checkConfig(c: PushSettings): Step[] {
  const missing = (["keyPath", "keyId", "teamId", "bundleId"] as const).filter((k) => !c[k]);
  const names: Record<string, string> = { keyPath: "HELIX_APNS_KEY_PATH", keyId: "HELIX_APNS_KEY_ID", teamId: "HELIX_APNS_TEAM_ID", bundleId: "HELIX_APNS_BUNDLE_ID" };
  const out: Step[] = [];
  if (missing.length) {
    out.push(step("settings", "fail", `missing in .env: ${missing.map((m) => names[m]).join(", ")}`,
      "All four are needed. Key ID and the .p8 come from developer.apple.com > Keys; Team ID is under Membership; the bundle id is the app's."));
    return out;
  }
  out.push(step("settings", "pass", "all four HELIX_APNS_* values are set"));
  // Apple's ids have a fixed shape; a typo here is the most common first failure.
  if (!/^[A-Z0-9]{10}$/.test(c.keyId!)) out.push(step("key id", "warn", `"${c.keyId}" does not look like a Key ID (10 letters/digits)`, "Copy it from the key's page in the developer portal."));
  if (!/^[A-Z0-9]{10}$/.test(c.teamId!)) out.push(step("team id", "warn", `"${c.teamId}" does not look like a Team ID (10 letters/digits)`, "It is on the Membership page of the developer portal."));
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(c.bundleId!)) out.push(step("bundle id", "warn", `"${c.bundleId}" does not look like a bundle id`, "Something like com.yourname.helix."));
  return out;
}

function checkKey(c: PushSettings): { steps: Step[]; pem?: string } {
  if (!c.keyPath) return { steps: [] };
  let pem: string;
  try {
    pem = fs.readFileSync(c.keyPath, "utf8");
  } catch (err) {
    return { steps: [step("key file", "fail", `cannot read ${c.keyPath}: ${err instanceof Error ? err.message : err}`, "Check the path in HELIX_APNS_KEY_PATH, and that the Helix service's user can read it.")] };
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    return { steps: [step("key file", "fail", "the file is not a usable private key", "Use the AuthKey_XXXXXXXXXX.p8 file exactly as downloaded (it begins with -----BEGIN PRIVATE KEY-----).")] };
  }
  const steps: Step[] = [];
  const curve = key.asymmetricKeyType === "ec" ? (key.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve : undefined;
  if (key.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
    return { steps: [step("key file", "fail", `the key is ${key.asymmetricKeyType}${curve ? ` (${curve})` : ""}, Apple needs an EC P-256 key`, "Create an APNs Auth Key (not a certificate) in the developer portal.")] };
  }
  steps.push(step("key file", "pass", "readable, EC P-256 (what Apple signs with)"));
  const repo = insideGitRepo(c.keyPath);
  if (repo) steps.push(step("key location", "warn", `the key sits inside a git repository (${repo})`, "Move it outside the repo so it can never be committed, and update HELIX_APNS_KEY_PATH."));
  else steps.push(step("key location", "pass", "outside any git repository"));
  return { steps, pem };
}

/** Can this PC open an HTTP/2 connection to Apple at all? Needs no credentials. */
function reach(env: ApnsEnvironment, origin: string, timeoutMs: number): Promise<Step> {
  return new Promise((resolve) => {
    const name = `reach Apple (${env})`;
    const t0 = Date.now();
    let settled = false;
    const finish = (s: Step) => { if (settled) return; settled = true; clearTimeout(timer); try { session.destroy(); } catch { /* already gone */ } resolve(s); };
    const session = http2.connect(origin);
    const timer = setTimeout(() => finish(step(name, "fail", `no connection to ${origin} within ${timeoutMs / 1000}s`, "Check the internet connection and that a firewall allows outbound HTTPS (port 443) to Apple. Apple push also works on port 2197 if 443 is blocked.")), timeoutMs);
    timer.unref();
    session.on("connect", () => finish(step(name, "pass", `HTTP/2 connection to ${new URL(origin).host} works (${Date.now() - t0} ms)`)));
    session.on("error", (e) => finish(step(name, "fail", `${e.message}`, "Check the internet connection and any firewall or proxy that might block api.push.apple.com.")));
  });
}

/** What Apple's answer to a fake-token request means for us. */
export function interpretProbe(env: ApnsEnvironment, kind: "alert" | "voip", r: ApnsResult, bundleId: string): Step {
  const topic = kind === "voip" ? `${bundleId}.voip` : bundleId;
  const name = `Apple accepts us (${env}, ${kind})`;
  const reason = r.reason ?? "";
  if (r.status === 0) return step(name, "fail", `no answer from Apple: ${reason || "network error"}`, "See the reachability step above.");
  if (r.ok || r.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") {
    return step(name, "pass", `Apple accepted the key, team and topic "${topic}" (it only rejected the fake device token, as expected)`);
  }
  if (reason === "InvalidProviderToken" || reason === "ExpiredProviderToken" || r.status === 403) {
    return step(name, "fail", `Apple rejected our signed token (${r.status} ${reason})`,
      "The Key ID, Team ID and .p8 file must all belong together: the .p8 you downloaded is AuthKey_<KeyID>.p8, and the Team ID is the one that owns the key. Also check the PC's clock is correct.");
  }
  if (reason === "TopicDisallowed" || reason === "BadTopic" || reason === "MissingTopic") {
    return step(name, "fail", `Apple does not allow topic "${topic}" for this key (${r.status} ${reason})`,
      "The bundle id must match the app's exactly, the app needs the Push Notifications capability, and the key must be enabled for APNs (for sandbox and production). VoIP pushes use the topic <bundle id>.voip.");
  }
  if (r.status === 429 || reason === "TooManyRequests") return step(name, "warn", `Apple is rate limiting us (${r.status} ${reason})`, "Wait a minute and run the check again.");
  return step(name, "warn", `unexpected answer from Apple: ${r.status} ${reason}`, "Run the check again; if it persists, the reason text is Apple's own explanation.");
}

export async function preflight(settings: PushSettings, opts: PreflightOptions = {}): Promise<Preflight> {
  const endpoints = opts.endpoints ?? APPLE;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const steps: Step[] = [...checkConfig(settings)];
  const configured = !steps.some((s) => s.status === "fail");

  let pem: string | undefined;
  if (settings.keyPath) {
    const k = checkKey(settings);
    steps.push(...k.steps);
    pem = k.pem;
  }

  // Reachability needs no credentials, so it runs even before the developer account exists.
  const networkOk: Record<string, boolean> = {};
  if (configured || opts.networkAlways !== false) {
    for (const env of ["sandbox", "production"] as const) {
      const s = await reach(env, endpoints[env], timeoutMs);
      networkOk[env] = s.status === "pass";
      steps.push(s);
    }
  }

  if (!configured || !pem || steps.some((s) => s.name === "key file" && s.status === "fail")) {
    steps.push(step("Apple accepts us", "skip", "needs the four settings and a usable key first"));
    return { ok: !steps.some((s) => s.status === "fail"), steps };
  }

  const client = new ApnsClient({ keyPem: pem, keyId: settings.keyId!, teamId: settings.teamId!, bundleId: settings.bundleId!, endpoints, timeoutMs, retryDelayMs: 100 });
  // The client's connections are deliberately unref'd (they must not keep the gateway alive); a one-shot command
  // has nothing else keeping it running while a request is in flight.
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    for (const env of ["sandbox", "production"] as const) {
      for (const kind of ["alert", "voip"] as const) {
        if (!networkOk[env]) { steps.push(step(`Apple accepts us (${env}, ${kind})`, "skip", "no connection to Apple")); continue; }
        const r = await client.send({
          token: opts.probeToken ?? FAKE_TOKEN, environment: env, kind,
          payload: kind === "voip" ? { callId: "preflight" } : { aps: { alert: "Helix preflight" } },
        });
        steps.push(interpretProbe(env, kind, r, settings.bundleId!));
      }
    }
  } finally {
    clearInterval(keepAlive);
    client.close();
  }
  return { ok: !steps.some((s) => s.status === "fail"), steps };
}
