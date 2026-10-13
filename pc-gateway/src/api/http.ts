import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SessionIndexer } from "../discovery/indexer.js";
import { buildJobWatches } from "../monitoring/presets.js";
import type { WatcherManager } from "../monitoring/watcher-manager.js";
import { WatchInputSchema } from "../monitoring/watch-types.js";
import type { ApprovalService } from "../permissions/approvals.js";
import { getGpuStatus, getPcStatus } from "../mcp/pc-tools.js";
import { adoptSession } from "../sessions/adopt.js";
import type { SessionManager } from "../sessions/manager.js";
import { GatewayError } from "../sessions/manager.js";
import type { CallManager } from "../calls/call-manager.js";
import { MODE_PRESETS, VOICE_SEVERITIES } from "../persona/types.js";
import { PersonaPatchSchema, type PersonaService } from "../persona/service.js";
import type { AgentEvents } from "../discovery/agent-events.js";
import type { ApnsClient } from "../notifications/apns.js";
import { type DeviceTokens, TOKEN_FORMAT } from "../notifications/devices.js";
import type { Notifier } from "../notifications/escalation.js";
import type { LiveDevices } from "../notifications/live-devices.js";
import type { RouterService } from "../router/router.js";
import type { PresenceService } from "../notifications/presence.js";
import type { LocalTokenService } from "../auth/local-tokens.js";
import { type BriefingSources, buildDigest, buildHints } from "../voice/briefing.js";
import type { CallAudio } from "../voice/call-audio.js";
import type { ClipLibrary } from "../voice/clips.js";
import { type TtsManager, TtsUnavailable } from "../voice/tts-manager.js";
import { voiceOptions } from "../voice/voice-opts.js";
import { AuthService, RateLimiter, bearerToken, registerBodyHashing, requireDevice } from "./auth.js";

const pairBody = z.object({
  code: z.string().min(4).max(32),
  deviceName: z.string().min(1).max(80),
  platform: z.string().max(40).optional(),
  /** Optional: enroll the device's signing key in the same call (SPKI DER base64, plus a signature of the enrollment message). */
  publicKey: z.string().min(80).max(200).optional(),
  keyProof: z.string().min(40).max(200).optional(),
});

const keyBody = z.object({ publicKey: z.string().min(80).max(200), keyProof: z.string().min(40).max(200) });

const createSessionBody = z.object({
  provider: z.enum(["claude", "codex"]).default("claude"),
  title: z.string().min(1).max(120),
  projectPath: z.string().min(1).max(1024).optional(),
  providerSessionId: z.string().uuid().optional(),
});

const messageBody = z.object({
  text: z.string().min(1).max(100_000),
  /** The reply will be spoken: apply the user's voice personality (dialled down for serious moments). */
  voice: z.boolean().optional(),
  voiceSeverity: z.enum(VOICE_SEVERITIES as [string, ...string[]]).optional(),
  /** Who does the speaking: the phone (default, Apple's voice) or the PC voice (audio is sent as agent.audio events). */
  engine: z.enum(["apple", "pc"]).optional(),
  /** Continue a very large session even though its cache has expired (otherwise 409 heavy_session). */
  confirmHeavy: z.boolean().optional(),
});
const listQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const approvalListQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const approvalDecisionBody = z.object({ note: z.string().max(500).optional() }).default({});

const jobBody = z.object({
  name: z.string().min(1).max(100),
  profile: z.enum(["generic", "training", "build", "tests", "deploy", "download"]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().max(100).optional(),
  logPath: z.string().max(1024).optional(),
  errorPatterns: z.array(z.string().max(300)).max(20).optional(),
  donePatterns: z.array(z.string().max(300)).max(20).optional(),
  staleAfterMin: z.number().min(0).max(1440).optional(),
  watchGpu: z.boolean().optional(),
  sessionId: z.string().optional(),
  wakeSessionId: z.string().optional(),
  wakeInstruction: z.string().max(2000).optional(),
  intervalSec: z.number().int().min(1).max(3600).optional(),
});
const watchPatchBody = z.object({ enabled: z.boolean() });

export function registerHttp(
  app: FastifyInstance, auth: AuthService, manager: SessionManager, approvals: ApprovalService, watchers: WatcherManager,
  indexer?: SessionIndexer,
  local?: { localTokens: LocalTokenService; agentEvents: AgentEvents; presence: PresenceService },
  router?: RouterService,
  comms?: { devices: DeviceTokens; calls: CallManager; push?: Notifier; apns?: ApnsClient; live?: LiveDevices; persona: PersonaService; tts?: TtsManager; clips?: ClipLibrary; callAudio?: CallAudio }
): void {
  const pairLimiter = new RateLimiter(5, 60_000);
  registerBodyHashing(app);
  const guard = { preHandler: requireDevice(auth) };
  const guardEnroll = { preHandler: requireDevice(auth, { allowUnenrolled: true }) };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GatewayError) return reply.code(err.statusCode).send({ error: err.message, ...err.details });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: err.issues });
    // Client mistakes raised by Fastify itself (415 unsupported media type, 413 too large, ...) are not server errors.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) return reply.code(status).send({ error: err instanceof Error ? err.message : "bad request" });
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({ ok: true, name: "helix-gateway", uptimeSec: Math.round(process.uptime()) }));

  app.post("/v1/pair/complete", async (req, reply) => {
    if (!pairLimiter.allow(req.ip)) return reply.code(429).send({ error: "too many attempts" });
    const body = pairBody.parse(req.body);
    if (body.publicKey) {
      // Checked before the code is used, so a bad key does not burn the pairing code.
      const checked = body.keyProof ? auth.checkNewKey(body.publicKey, body.keyProof) : "bad_proof";
      if (checked !== "ok") return reply.code(400).send({ error: checked });
    } else if (auth.requireSigning) {
      return reply.code(400).send({ error: "key_required" });
    }
    const result = auth.completePairing(body.code, body.deviceName, body.platform, body.publicKey);
    if (!result) return reply.code(401).send({ error: "invalid or expired pairing code" });
    return { ...result, signing: { enrolled: !!body.publicKey, required: auth.requireSigning } };
  });

  // Device-key signing: enroll the public key of the key the phone keeps in its Secure Enclave. Once only; see api/device-signing.ts.
  app.get("/v1/devices/me/key", guardEnroll, async (req) => auth.keyStatus(req.device!.id));
  app.put("/v1/devices/me/key", guardEnroll, async (req, reply) => {
    const body = keyBody.parse(req.body);
    const result = auth.enrollKey(req.device!.id, body.publicKey, body.keyProof);
    if (result === "ok") return { enrolled: true };
    return reply.code(result === "already_enrolled" ? 409 : 400).send({ error: result });
  });

  app.get("/v1/sessions", guard, async () => ({ sessions: manager.registry.list() }));

  app.post("/v1/sessions", guard, async (req, reply) => {
    const body = createSessionBody.parse(req.body);
    const session = await manager.createSession(body);
    auth.audit(req.device?.id, "session.create", { id: session.id, imported: !!body.providerSessionId });
    return reply.code(201).send(session);
  });

  app.get<{ Params: { id: string } }>("/v1/sessions/:id", guard, async (req, reply) => {
    const s = manager.registry.get(req.params.id);
    return s ?? reply.code(404).send({ error: "session not found" });
  });

  // Resume is implicit (a stopped session resumes on the next message); kept so clients have a
  // stable call that confirms the session exists and returns its current state.
  app.post<{ Params: { id: string } }>("/v1/sessions/:id/resume", guard, async (req, reply) => {
    const s = manager.registry.get(req.params.id);
    return s ?? reply.code(404).send({ error: "session not found" });
  });

  app.post<{ Params: { id: string } }>("/v1/sessions/:id/message", guard, async (req, reply) => {
    const body = messageBody.parse(req.body);
    const { text } = body;
    const voice = voiceOptions(comms?.persona, body, "normal", "session"); // a work session never gets the flirty character
    // A session open in a terminal gets the message in its own inbox (no fork, no second process on its transcript).
    const accepted = router ? router.sendMessage(req.params.id, text, voice, body.confirmHeavy === true) : manager.send(req.params.id, text, voice, body.confirmHeavy === true);
    auth.audit(req.device?.id, "session.message", { sessionId: req.params.id, chars: text.length });
    return reply.code(202).send(accepted);
  });

  // Is the next message to this session expensive to start? Lets the app warn before sending (heavy-session guard).
  app.get<{ Params: { id: string } }>("/v1/sessions/:id/cost-check", guard, async (req, reply) => {
    const s = manager.registry.get(req.params.id);
    if (!s) return reply.code(404).send({ error: "session not found" });
    const heavy = manager.heavyCheck(s);
    return { heavy: !!heavy, ...heavy };
  });

  // What the turns Helix ran consumed, by session, biggest cache writes first.
  app.get<{ Querystring: { hours?: string } }>("/v1/usage", guard, async (req) => {
    const hours = Math.min(Math.max(Number(req.query.hours ?? 24) || 24, 1), 24 * 30);
    return { hours, sessions: manager.usageSummary(hours) };
  });

  app.post<{ Params: { id: string } }>("/v1/sessions/:id/interrupt", guard, async (req) => {
    const interrupted = manager.interrupt(req.params.id);
    auth.audit(req.device?.id, "session.interrupt", { sessionId: req.params.id, interrupted });
    return { interrupted };
  });

  app.get("/v1/approvals", guard, async (req) => {
    const q = approvalListQuery.parse(req.query);
    return { approvals: approvals.list(q.status, q.limit) };
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post<{ Params: { id: string } }>(`/v1/approvals/:id/${decision}`, guard, async (req, reply) => {
      const { note } = approvalDecisionBody.parse(req.body ?? {});
      const result = approvals.resolve(req.params.id, decision === "approve", req.device?.id, note);
      if (!result) return reply.code(404).send({ error: "approval not found" });
      auth.audit(req.device?.id, `approval.${decision}`, { approvalId: result.id, finalStatus: result.status });
      // 200 with the settled state even for replays; `status` tells the client what actually happened.
      return result;
    });
  }

  /* ---- voice helpers: what to listen for, and a speakable "what is going on" ---- */
  const briefing = (): BriefingSources => ({
    pendingApprovals: () => approvals.list("pending"),
    workingSessions: () => manager.registry.list().filter((s) => manager.isRunning(s.id)).map((s) => s.title),
    liveSessions: () => (indexer?.list({ live: true, limit: 20 }) ?? []).map((s) => s.title),
    watches: () => watchers.list()
      .filter((w) => w.enabled && (w.lastStatus === "triggered" || w.lastStatus === "error"))
      .map((w) => ({ name: w.name, status: w.lastStatus as "triggered" | "error" })),
    projects: () => (indexer?.projects(30) ?? []).map((p) => p.name),
    aliases: () => router?.listAliases().map((a) => a.name) ?? [],
    recentSessionTitles: () => manager.registry.list().slice(0, 20).map((s) => s.title),
    watchNames: () => watchers.list().filter((w) => w.enabled).map((w) => w.name),
  });
  // Contextual strings for the phone's speech recognizer (project, alias and session names it would otherwise mishear).
  app.get("/v1/voice/hints", guard, async () => buildHints(briefing()));
  // A short spoken summary: approvals waiting, watches firing, what is working or open. No model involved, so it is instant.
  // Said in the user's chosen personality (dialled down by how serious it is); ?plain=true gives the neutral wording.
  app.get("/v1/digest", guard, async (req) => {
    const plain = z.object({ plain: z.enum(["true", "false"]).optional() }).parse(req.query).plain === "true";
    return buildDigest(briefing(), comms && !plain ? (kind) => comms.persona.digestFlavor(kind) : undefined);
  });

  /* ---- every Claude/Codex session on this machine, whether or not Helix started it ---- */
  if (indexer) {
    const listQuery2 = z.object({
      provider: z.enum(["claude", "codex"]).optional(),
      live: z.enum(["true", "false"]).optional(),
      q: z.string().max(200).optional(),
      project: z.string().max(300).optional(),
      minMessages: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    });
    const idParams = z.object({ provider: z.enum(["claude", "codex"]), id: z.string().min(8).max(64) });

    app.get("/v1/agent-sessions", guard, async (req) => {
      const q = listQuery2.parse(req.query);
      return { sessions: indexer.list({ ...q, live: q.live === undefined ? undefined : q.live === "true" }) };
    });

    app.post("/v1/agent-sessions/rescan", guard, async () => indexer.scan());

    app.get<{ Params: { provider: string; id: string } }>("/v1/agent-sessions/:provider/:id", guard, async (req, reply) => {
      const p = idParams.parse(req.params);
      return indexer.get(p.provider, p.id) ?? reply.code(404).send({ error: "session not found" });
    });

    // Continue any session on this machine from the phone. Forks if it is open in a terminal (see sessions/adopt.ts).
    app.post<{ Params: { provider: string; id: string } }>("/v1/agent-sessions/:provider/:id/adopt", guard, async (req, reply) => {
      const p = idParams.parse(req.params);
      const body = z.object({
        mode: z.enum(["auto", "resume", "fork"]).default("auto"),
        title: z.string().min(1).max(120).optional(),
      }).parse(req.body ?? {});
      const result = router ? await router.adopt(p.provider, p.id, body.mode, body.title) : await adoptSession(manager, indexer, p.provider, p.id, body.mode, body.title);
      auth.audit(req.device?.id, "session.adopt", { provider: p.provider, id: p.id, mode: result.mode, sessionId: result.session.id });
      return reply.code(201).send(result);
    });

    app.get<{ Params: { provider: string; id: string } }>("/v1/agent-sessions/:provider/:id/transcript", guard, async (req, reply) => {
      const p = idParams.parse(req.params);
      const q = z.object({
        before: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
      }).parse(req.query);
      const t = indexer.transcript(p.provider, p.id, q);
      return t ?? reply.code(404).send({ error: "transcript not found" });
    });
  }

  /* ---- what hooks in terminal/IDE sessions report ---- */
  if (local) {
    const eventLimiter = new RateLimiter(300, 60_000);
    app.post("/v1/agent-events", async (req, reply) => {
      const ctx = local.localTokens.lookup(bearerToken(req));
      if (!ctx) return reply.code(401).send({ error: "unauthorized" });
      if (!eventLimiter.allow(ctx.tokenId)) return reply.code(429).send({ error: "too many events" });
      const body = z.object({
        provider: z.enum(["claude", "codex"]),
        event: z.string().min(1).max(40),
        payload: z.record(z.string(), z.unknown()).default({}),
      }).parse(req.body);
      return reply.code(202).send(await local.agentEvents.ingest(body));
    });
    // PreToolUse hooks ask here before a possibly destructive command runs. Blocks (long poll) while the user decides.
    app.post("/v1/agent-events/permission", async (req, reply) => {
      const ctx = local.localTokens.lookup(bearerToken(req));
      if (!ctx) return reply.code(401).send({ error: "unauthorized" });
      const body = z.object({ provider: z.enum(["claude", "codex"]), payload: z.record(z.string(), z.unknown()) }).parse(req.body);
      const ac = new AbortController();
      reply.raw.on("close", () => { if (!reply.raw.writableFinished) ac.abort(); }); // the hook was killed (Ctrl-C): withdraw the request
      return local.agentEvents.checkPermission({ ...body, signal: ac.signal });
    });
    app.get("/v1/agent-events", guard, async () => ({ events: local.agentEvents.recent() }));

    /* ---- presence: is the user at the PC? Decides whether phone alerts are sent ---- */
    app.get("/v1/presence", guard, async () => local.presence.status());
    app.put("/v1/presence", guard, async (req) => {
      const { mode } = z.object({ mode: z.enum(["auto", "away", "home"]) }).parse(req.body);
      local.presence.setMode(mode);
      auth.audit(req.device?.id, "presence.set", { mode });
      return local.presence.status();
    });
    // Reported every ~15 s by the helper running in the user's desktop session.
    app.post("/v1/presence/idle", async (req, reply) => {
      if (!local.localTokens.lookup(bearerToken(req))) return reply.code(401).send({ error: "unauthorized" });
      const { idleSec } = z.object({ idleSec: z.number().min(0).max(31_536_000) }).parse(req.body);
      local.presence.reportIdle(idleSec);
      return reply.code(204).send();
    });
  }

  /* ---- push tokens, devices, and phone calls ---- */
  if (comms) {
    const { devices, calls, push, apns, live } = comms;
    const androidLive = () => (live?.count("android") ?? 0) > 0;

    app.put("/v1/devices/me/push-token", guard, async (req) => {
      const b = z.object({
        kind: z.enum(["alert", "voip"]),
        token: z.string().regex(TOKEN_FORMAT, "not an APNs token (expected hex)"),
        environment: z.enum(["sandbox", "production"]),
        bundleId: z.string().max(200).optional(),
      }).parse(req.body);
      devices.register(req.device!.id, b);
      auth.audit(req.device?.id, "push.register", { kind: b.kind, environment: b.environment });
      return { registered: true, tokens: devices.forDevice(req.device!.id) };
    });
    app.delete<{ Params: { kind: string } }>("/v1/devices/me/push-token/:kind", guard, async (req, reply) => {
      const kind = z.enum(["alert", "voip"]).parse(req.params.kind);
      return devices.remove(req.device!.id, kind) ? { removed: true } : reply.code(404).send({ error: "no such token" });
    });
    app.get("/v1/devices", guard, async (req) => ({ currentDeviceId: req.device?.id, devices: devices.listDevices() }));
    app.delete<{ Params: { id: string } }>("/v1/devices/:id", guard, async (req, reply) => {
      const revoked = auth.revoke(req.params.id);
      auth.audit(req.device?.id, "device.revoke", { id: req.params.id, revoked });
      return revoked ? { revoked: true } : reply.code(404).send({ error: "device not found or already revoked" });
    });

    app.get("/v1/push/status", guard, async () => ({
      configured: !!apns, bundleId: apns?.bundleId,
      alertTokens: devices.tokensFor("alert").length, voipTokens: devices.tokensFor("voip").length, callsAvailable: calls.available,
      androidConnected: live?.count("android") ?? 0,
    }));
    // For testing the phone side without waiting for a real event.
    app.post("/v1/push/test", guard, async (req, reply) => {
      const { kind } = z.object({ kind: z.enum(["alert", "voip"]) }).parse(req.body);
      if (!apns && !androidLive()) return reply.code(409).send({ error: "Apple push is not configured on the gateway (HELIX_APNS_*) and no Android phone is connected" });
      try {
        if (kind === "alert") {
          await push!.deliver({ severity: "important", title: "Helix test", body: "If you can read this, push notifications work.", dedupeKey: "test", kind: "event" });
          return { sent: true, kind };
        }
        const call = await calls.ringIncoming({ severity: "important", title: "Helix test call", summary: "A test call from the gateway." });
        return { sent: true, kind, callId: call.id };
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : "failed" });
      }
    });

    // Ring the phone for real with a chosen scenario, so the app's whole call flow (incoming call, spoken explanation,
    // conversation or spoken approval, severity-aware voice) can be rehearsed without waiting for a real event.
    // `approval: true` also creates a genuine pending approval that the call asks about; answering it works exactly as
    // for a real one, but it is labelled as a test and nothing runs whatever the answer.
    const simulateLimiter = new RateLimiter(6, 60_000);
    app.post("/v1/calls/simulate", guard, async (req, reply) => {
      if (!simulateLimiter.allow(req.device!.id)) return reply.code(429).send({ error: "too many test calls; wait a minute" });
      const b = z.object({
        severity: z.enum(["important", "critical"]).default("critical"),
        title: z.string().min(1).max(120).default("Test call from Helix"),
        summary: z.string().max(500).default("This is a test. Nothing is wrong."),
        approval: z.boolean().default(false),
      }).parse(req.body ?? {});
      if (!apns && !androidLive()) return reply.code(409).send({ error: "Apple push is not configured on the gateway (HELIX_APNS_*; run `npm run push -- check`) and no Android phone is connected" });
      let approvalId: string | undefined;
      if (b.approval) {
        const ask = approvals.request({ source: "request", tool: "request_user_approval", summary: `Test only, nothing will run: ${b.summary}`, reasons: ["simulated by the app"] });
        approvalId = ask.approval.id;
        void ask.outcome.catch(() => undefined);
      }
      try {
        const call = await calls.ringIncoming({ severity: b.severity, title: b.title, summary: b.summary, approvalId });
        auth.audit(req.device?.id, "call.simulate", { callId: call.id, severity: b.severity, approval: b.approval });
        return reply.code(201).send({ call, approvalId });
      } catch (err) {
        if (approvalId) approvals.resolve(approvalId, false, req.device?.id, "simulated call could not be delivered"); // leave nothing pending
        return reply.code(502).send({ error: err instanceof Error ? err.message : "failed" });
      }
    });

    // The line to say the instant the user stops talking, while the agent thinks ("Mmm... let me check."). In the user's
    // persona; a serious moment (severity high, critical or approval) always returns the plain professional line.
    app.get("/v1/voice/filler", guard, async (req) => {
      const { severity } = z.object({ severity: z.enum(VOICE_SEVERITIES as [string, ...string[]]).default("normal") }).parse(req.query);
      const text = comms.persona.filler(severity as never);
      // If this exact line was recorded in the PC voice, say where to get the audio: it plays instantly, no GPU needed.
      const clip = comms.clips?.findByText(text);
      return { text, severity, clip: clip ? { id: clip.id, seconds: clip.seconds, url: `/v1/voice/clips/${clip.id}` } : undefined };
    });

    /* ---- pre-recorded clips (canned lines in the PC voice) ---- */
    if (comms.clips) {
      const clips = comms.clips;
      app.get("/v1/voice/clips", guard, async () => ({ clips: clips.list().map(({ file: _file, ...c }) => c) }));
      app.get<{ Params: { id: string } }>("/v1/voice/clips/:id", guard, async (req, reply) => {
        const file = clips.pathOf(req.params.id); // only ids in the manifest resolve; nothing the caller sends becomes a path
        if (!file) return reply.code(404).send({ error: "no such clip" });
        return reply.type("audio/wav").header("cache-control", "private, max-age=3600").send(fs.readFileSync(file));
      });
    }

    /* ---- the PC voice: off by default, started only when needed, stopped when idle ---- */
    if (comms.tts) {
      const tts = comms.tts;
      const speakLimiter = new RateLimiter(60, 60_000);
      app.get("/v1/voice/tts/status", guard, async () => tts.status());
      // Start it in the background when a voice call begins, so the first sentence is not held up by the model loading.
      app.post("/v1/voice/tts/warm", guard, async (req, reply) => {
        try {
          const status = await tts.warm();
          auth.audit(req.device?.id, "tts.warm");
          return reply.code(202).send(status);
        } catch (err) {
          if (err instanceof TtsUnavailable) return reply.code(409).send({ error: err.message, reason: err.reason });
          throw err;
        }
      });
      app.post("/v1/voice/tts/stop", guard, async (req) => {
        await tts.stop("requested by the app");
        auth.audit(req.device?.id, "tts.stop");
        return tts.status();
      });
      // One sentence in, raw PCM out (signed 16-bit little-endian, mono, sample rate in x-sample-rate).
      app.post("/v1/voice/speak", guard, async (req, reply) => {
        if (!speakLimiter.allow(req.device!.id)) return reply.code(429).send({ error: "too many speech requests; wait a moment" });
        const { text, style } = z.object({ text: z.string().min(1).max(600), style: z.enum(["normal", "serious"]).default("normal") }).parse(req.body);
        try {
          const { pcm, sampleRate } = await tts.speak(text, style);
          return reply.type("audio/L16").header("x-sample-rate", String(sampleRate)).send(pcm);
        } catch (err) {
          if (err instanceof TtsUnavailable) return reply.code(503).send({ error: err.message, reason: err.reason });
          throw err;
        }
      });
    }

    /* ---- voice personality ---- */
    const personaView = () => {
      const settings = comms.persona.get();
      return { settings, presets: MODE_PRESETS, effective: comms.persona.allEffective(settings) };
    };
    app.get("/v1/persona", guard, async () => personaView());
    app.put("/v1/persona", guard, async (req) => {
      const patch = PersonaPatchSchema.parse(req.body);
      comms.persona.update(patch);
      auth.audit(req.device?.id, "persona.update", patch);
      return personaView();
    });
    // What a setting WOULD sound like, without saving it: the exact instruction and a sample greeting.
    app.post("/v1/persona/preview", guard, async (req) => {
      const body = PersonaPatchSchema.extend({ severity: z.enum(VOICE_SEVERITIES as [string, ...string[]]).optional() }).parse(req.body ?? {});
      const { severity, ...patch } = body;
      const current = comms.persona.get();
      const hypothetical = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as typeof current;
      const sev = (severity ?? "normal") as never;
      return {
        severity: sev, effective: comms.persona.effective(sev, hypothetical), instruction: comms.persona.voiceStyle(sev, hypothetical),
        greeting: comms.persona.greeting(hypothetical),
      };
    });

    app.get("/v1/calls", guard, async () => ({ calls: calls.list() }));
    app.get<{ Params: { id: string } }>("/v1/calls/:id", guard, async (req) => calls.mustGet(req.params.id));
    // What Helix says when it calls you, recorded in the PC voice while the phone rings: 200 wav when ready, 202 while still recording,
    // 404 when there is none (the PC voice is off or could not speak): then speak the call's `script` with Apple's voice.
    app.get<{ Params: { id: string } }>("/v1/calls/:id/script-audio", guard, async (req, reply) => {
      const entry = comms.callAudio?.get(calls.mustGet(req.params.id).id);
      if (!entry || entry.state === "failed") return reply.code(404).send({ error: "no PC-voice recording of this call", reason: entry?.reason });
      if (entry.state === "rendering") return reply.code(202).send({ state: "rendering" });
      return reply.header("content-type", "audio/wav").header("x-audio-seconds", String(entry.seconds)).send(entry.wav);
    });
    // The user calls Helix ("Call Claude", "Call Astra" = provider codex, or a specific session).
    app.post("/v1/calls/start", guard, async (req, reply) => {
      const b = z.object({ sessionId: z.string().optional(), title: z.string().max(120).optional(), provider: z.enum(["claude", "codex"]).optional() }).parse(req.body ?? {});
      const call = await calls.startOutgoing(b, req.device!.id);
      auth.audit(req.device?.id, "call.start", { callId: call.id, routeId: call.routeId });
      // The greeting is a canned line: when it was recorded in the PC voice, hand the phone the clip so it plays at once (no GPU, no waiting).
      const clip = comms.clips?.findByText(call.script);
      return reply.code(201).send({ ...call, scriptClip: clip ? { id: clip.id, seconds: clip.seconds, url: `/v1/voice/clips/${clip.id}` } : undefined });
    });
    app.post<{ Params: { id: string } }>("/v1/calls/:id/answer", guard, async (req) => {
      const call = await calls.answer(req.params.id, req.device!.id);
      auth.audit(req.device?.id, "call.answer", { callId: call.id });
      return call;
    });
    app.post<{ Params: { id: string } }>("/v1/calls/:id/decline", guard, async (req) => calls.decline(req.params.id, req.device?.id));
    app.post<{ Params: { id: string } }>("/v1/calls/:id/end", guard, async (req) => {
      const { reason } = z.object({ reason: z.string().max(100).optional() }).parse(req.body ?? {});
      return calls.end(req.params.id, reason);
    });
    // A spoken approve/reject on an approval call, interpreted by the phone (keywords), not by a model.
    app.post<{ Params: { id: string } }>("/v1/calls/:id/decision", guard, async (req) => {
      const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
      const r = await calls.decide(req.params.id, approve, req.device!.id);
      auth.audit(req.device?.id, "call.decision", { callId: req.params.id, approve, approvalStatus: r.approvalStatus });
      return r;
    });
  }

  /* ---- the General Claude: one phone conversation that can be handed to any session ---- */
  if (router) {
    const handoffBody = z.object({
      session: z.string().min(1).max(100).optional(), projectPath: z.string().min(1).max(1024).optional(),
      message: z.string().max(100_000).optional(), mode: z.enum(["auto", "resume", "fork"]).optional(), title: z.string().max(120).optional(),
      provider: z.enum(["claude", "codex"]).optional(),
    });
    const aliasBody = z.object({ sessionKey: z.string().min(3).max(100).optional(), projectPath: z.string().min(1).max(1024).optional() });

    app.post("/v1/routes", guard, async (req, reply) => {
      // provider = the front door: "claude" (General Claude, default) or "codex" (Astra). Everything after this is identical.
      const { title, provider } = z.object({ title: z.string().min(1).max(120).optional(), provider: z.enum(["claude", "codex"]).optional() }).parse(req.body ?? {});
      const route = await router.createRoute(title, provider);
      auth.audit(req.device?.id, "route.create", { id: route.id, frontDoor: route.frontDoor });
      return reply.code(201).send(route);
    });
    app.get("/v1/routes", guard, async () => ({ routes: router.list() }));
    app.get<{ Params: { id: string } }>("/v1/routes/:id", guard, async (req) => router.mustGet(req.params.id));
    app.post<{ Params: { id: string } }>("/v1/routes/:id/message", guard, async (req, reply) => {
      const body = messageBody.parse(req.body);
      const { text } = body;
      // A route inherits how serious its call is, unless the app says otherwise.
      const accepted = router.send(req.params.id, text, voiceOptions(comms?.persona, body, router.voiceSeverity(req.params.id)));
      auth.audit(req.device?.id, "route.message", { routeId: req.params.id, sessionId: accepted.sessionId, chars: text.length });
      return reply.code(202).send(accepted);
    });
    app.post<{ Params: { id: string } }>("/v1/routes/:id/interrupt", guard, async (req) => ({ interrupted: router.interrupt(req.params.id) }));
    app.post<{ Params: { id: string } }>("/v1/routes/:id/reset", guard, async (req) => router.reset(req.params.id));
    app.post<{ Params: { id: string } }>("/v1/routes/:id/handoff", guard, async (req) => {
      const r = await router.handoff(req.params.id, handoffBody.parse(req.body ?? {}));
      auth.audit(req.device?.id, "route.handoff", { routeId: req.params.id, toSessionId: r.session.id, mode: r.mode });
      return { route: r.route, session: r.session, mode: r.mode, note: r.note, messageDelivered: r.forwarded, routingMessageDropped: r.droppedRoutingMessage ?? false };
    });
    app.get<{ Params: { id: string } }>("/v1/routes/:id/messages", guard, async (req) => {
      const q = listQuery.parse(req.query);
      return { messages: router.messages(req.params.id, q.after, q.limit) };
    });

    app.get("/v1/search/sessions", guard, async (req) => {
      const q = z.object({
        q: z.string().max(200).optional(), provider: z.enum(["claude", "codex"]).optional(), project: z.string().max(200).optional(),
        live: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(30).default(8),
      }).parse(req.query);
      return router.search(q.q, { provider: q.provider, project: q.project, liveOnly: q.live === "true", limit: q.limit });
    });
    app.get("/v1/projects", guard, async () => ({ projects: router.projects() }));

    app.get("/v1/aliases", guard, async () => ({ aliases: router.listAliases() }));
    app.put<{ Params: { name: string } }>("/v1/aliases/:name", guard, async (req) => {
      router.setAlias(req.params.name, aliasBody.parse(req.body));
      return router.alias(req.params.name);
    });
    app.delete<{ Params: { name: string } }>("/v1/aliases/:name", guard, async (req, reply) =>
      router.deleteAlias(req.params.name) ? { removed: true } : reply.code(404).send({ error: "alias not found" }));
  }

  // The PC's load for the app's status screen: the same two readings the MCP tools give (CPU is sampled for 300 ms).
  app.get("/v1/pc/status", guard, async () => {
    const [pc, gpu] = await Promise.all([getPcStatus(), getGpuStatus()]);
    return { pc, gpu };
  });

  app.get("/v1/watches", guard, async () => ({ watches: watchers.list() }));

  app.post("/v1/watches", guard, async (req, reply) => {
    const w = watchers.create(WatchInputSchema.parse(req.body));
    auth.audit(req.device?.id, "watch.create", { id: w.id, type: w.type, name: w.name });
    return reply.code(201).send(w);
  });

  // Convenience for "watch this job": expands to process + log (+ GPU) watches. Any kind of work, not just training.
  app.post("/v1/watches/job", guard, async (req, reply) => {
    const body = jobBody.parse(req.body);
    let inputs;
    try { inputs = buildJobWatches(body); }
    catch (err) { throw new GatewayError(400, err instanceof Error ? err.message : "invalid job"); }
    const created = inputs.map((i) => watchers.create(i));
    auth.audit(req.device?.id, "watch.create_job", { ids: created.map((w) => w.id) });
    return reply.code(201).send({ watches: created });
  });

  app.patch<{ Params: { id: string } }>("/v1/watches/:id", guard, async (req, reply) => {
    const { enabled } = watchPatchBody.parse(req.body);
    const w = watchers.setEnabled(req.params.id, enabled);
    return w ?? reply.code(404).send({ error: "watch not found" });
  });

  app.delete<{ Params: { id: string } }>("/v1/watches/:id", guard, async (req, reply) => {
    const removed = watchers.remove(req.params.id);
    auth.audit(req.device?.id, "watch.delete", { id: req.params.id, removed });
    return removed ? { removed: true } : reply.code(404).send({ error: "watch not found" });
  });

  app.get<{ Params: { id: string } }>("/v1/watches/:id/events", guard, async (req, reply) => {
    if (!watchers.get(req.params.id)) return reply.code(404).send({ error: "watch not found" });
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
    return { events: watchers.events(req.params.id, q.limit) };
  });

  app.post<{ Params: { id: string } }>("/v1/watches/:id/check", guard, async (req) => watchers.runNow(req.params.id));

  app.get<{ Params: { id: string } }>("/v1/conversations/:id/messages", guard, async (req) => {
    const q = listQuery.parse(req.query);
    return { messages: manager.messages.list(req.params.id, q.after, q.limit) };
  });
}
